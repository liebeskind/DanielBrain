# MCP Server & API

Baseline: `c9370a8b` (2026-03-08)

## MCP Server

**File:** `cognee-mcp/src/server.py`

Built with FastMCP. 7 tools exposed:

### Tools

| Tool | Parameters | Purpose |
|------|-----------|---------|
| `cognify()` | data, graph_model_file?, graph_model_name?, custom_prompt? | Ingest text and build knowledge graph |
| `search()` | search_query, search_type, top_k=10 | Query knowledge graph (7 search types) |
| `save_interaction()` | data | Log user-agent interactions and Q&A pairs |
| `list_data()` | dataset_id? | Enumerate datasets and data items |
| `delete()` | data_id, dataset_id, mode="soft" | Remove data items (soft/hard) |
| `prune()` | (none) | Reset entire knowledge graph |
| `cognify_status()` | (none) | Check pipeline processing status |

### Implementation Details

- All tools return `list[types.TextContent]` for MCP protocol compatibility
- Long-running operations (`cognify`, `save_interaction`) launched via `asyncio.create_task()` — returns immediately with acknowledgment
- Stdout redirected to stderr to preserve MCP protocol (MCP communicates over stdout)
- `cognify()` chains `add()` + `cognify()` — first ingests, then processes
- `save_interaction()` chains `add()` + `cognify()` + `add_rule_associations()`

### save_interaction

Notable tool — designed for agent self-logging:
- Agent calls `save_interaction()` with the conversation/Q&A data
- Data is ingested and cognified (entities extracted, graph built)
- Rule associations added (links to relevant ontology rules)
- Enables the knowledge graph to learn from agent interactions

## CogneeClient

**File:** `cognee-mcp/src/cognee_client.py`

Dual-mode client that abstracts whether cognee runs as a local library or remote API:

### HTTP API Mode
```python
client = CogneeClient(api_url="http://localhost:8000")
await client.add(data)       # POST /api/v1/add
await client.cognify()       # POST /api/v1/cognify
await client.search(query)   # GET /api/v1/search
```

### Direct Function Mode
```python
client = CogneeClient()  # No API URL → direct function calls
await client.add(data)       # cognee.add(data)
await client.cognify()       # cognee.cognify()
await client.search(query)   # cognee.search(query)
```

The MCP server uses CogneeClient, so it works in both modes without code changes.

## FastAPI REST API

**File:** `cognee/api/` (multiple files)

Full REST API alongside the MCP server:

### Endpoints

| Route | Method | Purpose |
|-------|--------|---------|
| `/api/v1/auth/login` | POST | JWT authentication |
| `/api/v1/auth/register` | POST | User registration |
| `/api/v1/add` | POST | Ingest data |
| `/api/v1/cognify` | POST | Trigger processing pipeline |
| `/api/v1/search` | GET | Search knowledge graph |
| `/api/v1/datasets` | GET | List datasets |
| `/api/v1/datasets/{id}` | DELETE | Delete dataset |
| `/api/v1/users` | GET | List users |
| `/api/v1/permissions` | GET/POST | Manage permissions |
| `/api/v1/ontologies` | GET/POST | Manage ontology files |
| `/api/v1/visualize` | GET | Graph visualization data |

### Authentication

- **Bearer token** — JWT in Authorization header
- **Cookie auth** — session cookies for browser-based access
- Configurable JWT secret and expiry
- CORS configuration for cross-origin requests

## Contrast with TopiaBrain

| Aspect | Cognee | TopiaBrain |
|--------|--------|------------|
| MCP tools | 7 (cognify, search, save_interaction, list, delete, prune, status) | 8 (4 thought + 4 entity tools) |
| MCP transport | FastMCP | Custom SSE transport |
| REST API | Full FastAPI with auth | Express routes (admin + proposals) |
| Auth | JWT + cookies | API key (x-brain-key header) |
| Client abstraction | CogneeClient (HTTP or direct) | Direct MCP tool calls |
| Long-running ops | asyncio.create_task + status polling | Queue-based async processing |

### What's Worth Considering

**save_interaction tool** — A tool for agents to log their own interactions back into the knowledge graph. Our `save_thought` tool serves a similar purpose, but an explicit "log this conversation" tool could be useful for the chat feature.

**Pipeline status** — `cognify_status()` provides processing progress. Our queue system processes items silently; exposing status would improve UX, especially in the chat UI.

**Dual-mode client** — Clean pattern. If we ever separate the MCP server from the service, a similar client abstraction would ease the transition.

### What to Skip

**FastAPI** — We use Express, and there's no reason to switch.

**JWT auth** — Our API key approach is simpler and sufficient. JWT becomes relevant if we add proper multi-user auth (Phase 7).
