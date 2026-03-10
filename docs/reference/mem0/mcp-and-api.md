# Mem0 MCP Server & REST API

## OpenMemory MCP Server

### Overview

The OpenMemory MCP Server is a local-first memory server that runs entirely on the user's machine. Launched May 2025. Uses FastMCP with SSE transport.

Source: `openmemory/api/app/mcp_server.py`

### MCP Tools (5 total)

| Tool | Parameters | Description |
|------|-----------|-------------|
| `add_memories` | `text: str` | Store new memory (preferences, facts, notable details) |
| `search_memory` | `query: str` | Semantic search over stored memories |
| `list_memories` | (none) | List all accessible memories for the user |
| `delete_memories` | `memory_ids: list[str]` | Delete specific memories by ID |
| `delete_all_memories` | (none) | Bulk delete all accessible memories |

### MCP Server Architecture

```
Client connects via SSE: /{client_name}/sse/{user_id}
    |
    v
FastMCP("mem0-mcp-server") with SSE transport at /mcp/messages/
    |
    v
Context variables set: user_id, client_name
    |
    v
Tool handler executes with ACL filtering
    |
    v
Audit log (MemoryAccessLog + MemoryStatusHistory)
```

**Key features:**
- Lazy initialization: Memory client loads only when needed
- ACL enforcement: `check_memory_access_permissions()` on all operations
- Audit logging: Every operation creates access log entries
- App-based scoping: Each MCP client (Cursor, Claude, etc.) is registered as an App
- Graceful degradation: Returns friendly error if memory system unavailable

### Compatible MCP Clients

Cursor, VS Code, JetBrains, Claude Desktop, Windsurf, Cline, OpenAI, LangGraph, LlamaIndex, and any MCP-compatible tool.

### OpenMemory Dashboard

Built-in React UI for centralized memory management:
- Add, browse, delete memories
- Control memory access per client
- View audit logs
- Runs alongside the API server

## REST API Server

### Overview

FastAPI server exposing all memory operations over HTTP. Default port: 8888. No built-in auth (add your own before exposing).

Source: `server/main.py`

### Endpoints (11 total)

| Method | Path | Purpose |
|--------|------|---------|
| `GET` | `/` | Redirect to OpenAPI docs |
| `POST` | `/configure` | Configure Mem0 (LLM, embedder, vector store) |
| `POST` | `/memories` | Create memories |
| `GET` | `/memories` | List all memories (filterable) |
| `GET` | `/memories/{memory_id}` | Get a specific memory |
| `POST` | `/search` | Search memories by semantic query |
| `PUT` | `/memories/{memory_id}` | Update a memory |
| `GET` | `/memories/{memory_id}/history` | Get memory change history |
| `DELETE` | `/memories/{memory_id}` | Delete a specific memory |
| `DELETE` | `/memories` | Delete all memories (filterable) |
| `POST` | `/reset` | Reset all memories (nuclear option) |

### Request/Response Models

**Create Memory (POST /memories):**
```json
{
    "messages": [
        {"role": "user", "content": "I prefer dark mode"},
        {"role": "assistant", "content": "Noted, I'll remember that."}
    ],
    "user_id": "alice",
    "agent_id": "support-bot",
    "run_id": "session-123",
    "metadata": {"source": "chat"}
}
```

**Search (POST /search):**
```json
{
    "query": "What are Alice's preferences?",
    "user_id": "alice",
    "agent_id": "support-bot",
    "filters": {"category": {"eq": "preferences"}}
}
```

**Memory Response:**
```json
{
    "id": "uuid",
    "memory": "Prefers dark mode",
    "hash": "md5-hex",
    "created_at": "2024-01-15T10:30:00Z",
    "updated_at": null,
    "user_id": "alice",
    "agent_id": "support-bot",
    "score": 0.92
}
```

### Docker Compose Stack

```yaml
services:
  mem0:
    # FastAPI server with uvicorn, hot-reload
    ports: ["8888:8888"]
    depends_on: [postgres, neo4j]

  postgres:
    image: pgvector/pgvector:...
    ports: ["8432:5432"]
    # Healthcheck via pg_isready
    # 128MB shared memory
    # Persistent volume

  neo4j:
    image: neo4j:5.26.4
    ports: ["7474:7474", "7687:7687"]
    # APOC plugin enabled
    # Auth: neo4j/mem0graph
    # Persistent volume
```

All services on bridge network `mem0_network`.

### Interactive API Explorer

OpenAPI docs at `http://localhost:8888/docs` for interactive testing and schema reference.

## Comparison: MCP Tools vs REST API vs Python Library

| Feature | MCP (OpenMemory) | REST API | Python Library |
|---------|-----------------|----------|---------------|
| Tools/Endpoints | 5 tools | 11 endpoints | Full API |
| Transport | SSE (MCP protocol) | HTTP/JSON | Direct import |
| Auth | ACL-based per app | None (add your own) | None |
| Graph memory | Via config | Via config | Via config |
| Audit trail | Built-in | Via history endpoint | Via history() |
| Dashboard | React UI | OpenAPI explorer | None |
| Multi-user | Per user_id + client_name | Per user_id | Per user_id |
| Use case | AI tool integration | Microservices | Direct embedding |
