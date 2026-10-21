# Db2 Genius Hub MCP demo

Ask questions about your Db2 environment in plain English. The demo app is an MCP client that lets an LLM
call the tools published by the **Db2 Genius Hub MCP server**, so every answer comes from live data.

**The project lives in [`db2-genius-chat/`](db2-genius-chat/). Start with its [README](db2-genius-chat/README.md).**

```bash
cd db2-genius-chat
npm install
cp .env.example .env      # then edit the values
npm start                 # http://127.0.0.1:3000
```

| File | What it is |
|---|---|
| [`README.md`](db2-genius-chat/README.md) | How MCP works, connecting, running, design notes, troubleshooting |
| [`examples/call_tool.py`](db2-genius-chat/examples/call_tool.py) | Call one MCP tool from Python |
| [`examples/add_databases.csv`](db2-genius-chat/examples/add_databases.csv) | Bulk-import template for Genius Hub connection profiles |
| [`test_granite.py`](test_granite.py) | Check the Granite LLM endpoint |

<img width="1536" height="1024" alt="image" src="https://github.com/user-attachments/assets/b0275012-d045-4b3f-9046-a05f15de85b3" />



Background for Genius Hub MCP and Air-gap:

Details on the MCP
	https://community.ibm.com/community/user/blogs/krishna-guntuka/2026/06/30/give-your-ai-assistant-a-direct-line-to-ibm-db2

Air-gapped
https://community.ibm.com/community/user/blogs/merlin-moncy/2026/05/26/air-gapped-ai-inferencing-db2-genius-hub

Check the connection to the MCP server:

		nc -zv db2server 8000                       # is the port open?
		curl -k -i https://db2server:8000/mcp       # 400 or 406 = alive; "connection refused" = not running

Can it work without internet access?
	
	Yes, with a caveat. The MCP server and Genius Hub run on your own host and talk to your Db2 over your network. 
	Internet access is only needed if the assistant's model is IBM's cloud one. 
	The "bring your own AI stack" option can be deployed without internet. 

Is the MCP read-only, and does it log who asked what?
		
		It blocks INSERT, UPDATE, DELETE, DDL, GRANT and FOR UPDATE.
		It allows only approved built-in functions.
		It caps results by default at 25 rows.
		It tags each statement /* safe_db2 */ so you can find it in Db2 monitoring.
		Other tools: autoconfigure runs with APPLY NONE, so it only recommends.
		Write actions: the Genius Hub assistant has write actions (update db cfg, force application, reorg), but only after a human approves them. 
		
		Genius Hub audit logging records logins and logoffs, admin activity, console setting changes and privilege changes. 
		It is stored in the AUDIT_LOG table or in files, and is switched on through an admin API.
		
		The MCP server has structured logs with correlation IDs.
		For a full "who asked what" trail, plan to log it in the client or app.

Does Genius Hub need its own Db2 user? What permissions does that user need?
		There are three credential types on each connection:
		
		Credential	Used for								Privileges
		Monitoring	Telemetry collection				SQLADM and WLMADM on the database, plus SYSMAINT_GROUP membership
		Jobs		Backups and scheduled scripts			Only what those jobs need
		Personal	SQL Workbench and the AI Assistants		Least privilege chosen by the DBA


