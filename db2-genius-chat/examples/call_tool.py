#!/usr/bin/env python3
"""
Call one Db2 Genius Hub MCP tool from Python, with no MCP SDK (only `httpx`).

    pip install httpx

Log in with a user + password (a fresh token is requested):
    export GH_USER=admin GH_PASSWORD='...'
    python3 call_tool.py

...or with a token you already have:
    export GH_TOKEN='eyJ...'
    python3 call_tool.py

Optional: GH_HOST (db2server), GH_PORT (11100), GH_PROTOCOL (http),
          MCP_URL (https://<GH_HOST>:8000/mcp), PROFILE (db2server-sample)
"""
import json
import os
import sys

import httpx

HOST = os.environ.get("GH_HOST", "db2server")
PORT = os.environ.get("GH_PORT", "11100")
PROTO = os.environ.get("GH_PROTOCOL", "http")
MCP_URL = os.environ.get("MCP_URL", f"https://{HOST}:8000/mcp")
PROFILE = os.environ.get("PROFILE", "db2server-sample")


def get_token() -> str:
    """Option A: use GH_TOKEN. Option B: exchange user + password for a token."""
    if os.environ.get("GH_TOKEN"):
        return os.environ["GH_TOKEN"]
    user, pw = os.environ.get("GH_USER"), os.environ.get("GH_PASSWORD")
    if not (user and pw):
        sys.exit("Set GH_TOKEN, or GH_USER and GH_PASSWORD")
    r = httpx.post(f"{PROTO}://{HOST}:{PORT}/dbapi/v4/auth/tokens",
                   json={"userid": user, "password": pw}, timeout=15)
    r.raise_for_status()
    return r.json()["token"]          # a JWT, valid for about 8 hours


class Mcp:
    """Minimal MCP client over 'streamable HTTP': JSON-RPC 2.0 messages sent with POST."""

    def __init__(self, token: str):
        # verify=False because the MCP server ships with a self-signed certificate.
        # With a CA-signed certificate, remove it (or pass verify="/path/ca.pem").
        self.http = httpx.Client(verify=False, timeout=60)
        self.headers = {
            "Content-Type": "application/json",
            "Accept": "application/json, text/event-stream",
            # These four headers tell the MCP server which Genius Hub to talk to.
            "X-Genius-Hub-Hostname": HOST,
            "X-Genius-Hub-Port": PORT,
            "X-Genius-Hub-Protocol": PROTO,
            "X-Genius-Hub-Token": token,
        }
        self.n = 0

    def _post(self, body: dict):
        r = self.http.post(MCP_URL, headers=self.headers, json=body)
        r.raise_for_status()
        # The server assigns a session id on the first reply; send it on every later call.
        if "mcp-session-id" in r.headers:
            self.headers["mcp-session-id"] = r.headers["mcp-session-id"]
        if not r.text.strip():
            return None
        if "text/event-stream" in r.headers.get("content-type", ""):
            # Server-sent events: each message is a "data: {json}" line. There can be
            # several (progress/log notifications); ours is the one with our request id.
            messages = [json.loads(l[5:]) for l in r.text.splitlines() if l.startswith("data:")]
            for m in messages:
                if m.get("id") == body.get("id"):
                    return m
            return messages[-1] if messages else None
        return r.json()

    def request(self, method: str, params=None):
        self.n += 1
        reply = self._post({"jsonrpc": "2.0", "id": self.n, "method": method, "params": params or {}})
        if reply and "error" in reply:
            raise RuntimeError(reply["error"])
        return reply["result"]

    def initialize(self):
        self.request("initialize", {
            "protocolVersion": "2025-03-26",
            "capabilities": {},
            "clientInfo": {"name": "python-example", "version": "1.0"},
        })
        self._post({"jsonrpc": "2.0", "method": "notifications/initialized"})

    def call_tool(self, name: str, arguments: dict):
        result = self.request("tools/call", {"name": name, "arguments": arguments})
        # Tool output arrives as a list of content blocks; the text block holds JSON.
        text = "".join(c.get("text", "") for c in result.get("content", []))
        try:
            return json.loads(text)
        except ValueError:
            return text

    def close(self):
        # Ends the session on the server (HTTP DELETE is the MCP way to close it).
        if "mcp-session-id" in self.headers:
            self.http.delete(MCP_URL, headers=self.headers)
        self.http.close()


if __name__ == "__main__":
    mcp = Mcp(get_token())
    try:
        mcp.initialize()

        tools = mcp.request("tools/list")["tools"]
        print(f"{len(tools)} tools available, e.g. {[t['name'] for t in tools[:5]]}\n")

        # Most tools take their arguments inside a "params" object.
        print(f"Selecting profile {PROFILE} ...")
        mcp.call_tool("connect_to_profile", {"profile_name": PROFILE})

        print("Calling get_tablespace ...")
        data = mcp.call_tool("get_tablespace", {"params": {}})
        print(json.dumps(data, indent=2)[:1500])
    finally:
        mcp.close()
