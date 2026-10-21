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

| In the project | What it is |
|---|---|
| [`README.md`](db2-genius-chat/README.md) | How MCP works, connecting, running, design notes, troubleshooting |
| [`examples/call_tool.py`](db2-genius-chat/examples/call_tool.py) | Call one MCP tool from Python |
| [`examples/add_databases.csv`](db2-genius-chat/examples/add_databases.csv) | Bulk-import template for Genius Hub connection profiles |
| [`test_granite.py`](test_granite.py) | Check the Granite LLM endpoint |
