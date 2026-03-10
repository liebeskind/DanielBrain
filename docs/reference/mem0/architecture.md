# Mem0 Architecture

> Universal memory layer for AI agents. Apache 2.0 licensed.
> GitHub: https://github.com/mem0ai/mem0 (~49k stars)
> Paper: https://arxiv.org/abs/2504.19413

## High-Level Design

Mem0 is a **dual-storage memory system** combining vector-based semantic search with optional graph-based entity/relationship tracking. It provides persistent, cross-session memory for AI agents scoped by user, agent, and run.

### Core Principle

Instead of storing full conversation transcripts, Mem0 **extracts salient facts** from conversations using an LLM, then stores those facts as individual memory objects. On retrieval, only relevant memories are returned (not entire histories), reducing token usage by ~90%.

## System Components

```
Input (messages)
    |
    v
[Fact Extraction]  ── LLM call #1: extract facts from conversation
    |
    v
[Embedding]  ── embed each extracted fact
    |
    v
[Similarity Search]  ── find top-s similar existing memories (s=10)
    |
    v
[Update Decision]  ── LLM call #2: classify ADD/UPDATE/DELETE/NOOP per fact
    |                   (receives new facts + similar existing memories)
    v
[Storage]  ── vector store + optional graph store (parallel)
    |
    v
[History]  ── SQLite tracks all changes (prev_value, new_value, event)
```

### Parallel Graph Pipeline (when enabled)

When graph memory is enabled, a parallel pipeline runs concurrently:

```
Input (messages)
    |
    v
[Entity Extraction]  ── LLM tool call: identify entities + types
    |
    v
[Relationship Extraction]  ── LLM tool call: extract (source, relationship, destination) triplets
    |
    v
[Node Dedup]  ── embed entities, search graph for similar nodes (threshold)
    |
    v
[Conflict Detection]  ── LLM decides which relationships to add/update/delete
    |
    v
[Graph Storage]  ── Neo4j/Memgraph/Neptune/Kuzu
```

## LLM Calls Per `add()` Operation

Each `add()` call makes **2-4 LLM calls** depending on configuration:

| Call | Purpose | When |
|------|---------|------|
| Fact extraction | Extract salient facts from messages | Always (unless `infer=False`) |
| Update decision | Classify ADD/UPDATE/DELETE/NOOP for each fact | Always (unless `infer=False`) |
| Entity extraction | Identify entities and types from text | Only with graph memory enabled |
| Relationship extraction | Extract (source, rel, destination) triplets | Only with graph memory enabled |

Plus embedding calls (one per extracted fact for vector search, one per entity for graph dedup).

Default LLM: `gpt-4.1-nano-2025-04-14` (previously `gpt-4o-mini`). Can be swapped for Ollama.

## Project Structure (Python Package)

```
mem0/
  memory/
    main.py              # Memory + AsyncMemory classes (core entry point)
    graph_memory.py      # MemoryGraph class for graph operations
    utils.py             # parse_messages, format_entities, extract_json
  configs/
    prompts.py           # All LLM prompt templates
  graphs/
    tools.py             # Tool schemas for graph LLM calls
    utils.py             # EXTRACT_RELATIONS_PROMPT, get_delete_messages
    configs.py           # Neo4jConfig, MemgraphConfig, KuzuConfig, etc.
    neptune/             # Neptune-specific implementation
  vector_stores/
    base.py              # VectorStoreBase abstract interface
    pgvector.py          # PostgreSQL + pgvector
    qdrant.py            # Qdrant
    chroma.py            # ChromaDB
    faiss.py             # FAISS (local)
    milvus.py            # Milvus
    pinecone.py          # Pinecone
    redis.py             # Redis
    elasticsearch.py     # Elasticsearch
    weaviate.py          # Weaviate
    mongodb.py           # MongoDB Atlas
    ... (26 implementations total)
  llms/
    base.py              # LLM base class
    openai.py            # OpenAI (default)
    ollama.py            # Ollama (local)
    anthropic.py         # Claude
    groq.py              # Groq
    ... (20 providers total)
  embeddings/
    base.py              # Embedding base class
    openai.py            # text-embedding-3-small (default)
    ollama.py            # nomic-embed-text (local)
    huggingface.py       # HuggingFace
    ... (15 providers total)
  reranker/              # Optional reranking
  client/                # Platform client SDK
  proxy/                 # Proxy utilities
  utils/
    factory.py           # EmbedderFactory, LlmFactory
  exceptions.py          # Mem0ValidationError
server/
  main.py               # FastAPI REST server (11 endpoints)
  docker-compose.yaml   # mem0 + PostgreSQL/pgvector + Neo4j
openmemory/
  api/
    app/
      mcp_server.py     # OpenMemory MCP server (5 tools)
      models.py         # SQLAlchemy ORM models
      schemas.py        # Pydantic request/response schemas
      config.py         # Configuration
      database.py       # DB connection
      routers/          # REST route handlers
    main.py             # FastAPI entry point
  ui/                   # React dashboard
  compose/              # Docker Compose configs
```

## Deployment Models

### 1. Library Mode (pip install mem0ai)
Direct Python import. You manage your own vector store + optional graph store.

### 2. Self-Hosted REST Server
Three Docker containers:
- **mem0**: FastAPI server on port 8888 (uvicorn with hot-reload)
- **PostgreSQL + pgvector**: Port 8432, persistent volume
- **Neo4j 5.26.4**: Ports 7474 (HTTP) + 7687 (Bolt), APOC plugin enabled

### 3. OpenMemory MCP Server
Local-first MCP server on port 8765. Uses FastMCP with SSE transport. Built-in React dashboard for memory management.

### 4. Managed Platform (mem0.ai)
Hosted SaaS with SDKs for Python and TypeScript.

## Performance Benchmarks (from paper)

| Metric | Mem0 (vector) | Mem0^g (graph) | Full Context |
|--------|--------------|----------------|--------------|
| Single-hop accuracy | 67.13 | 65.71 | varies |
| Multi-hop accuracy | 51.15 | 47.19 | varies |
| Temporal reasoning | 55.51 | **58.13** | varies |
| Open-domain | 72.93 | **75.71** | varies |
| p50 search latency | 0.148s | - | 9.870s |
| p95 total latency | 1.440s | - | 17.117s |
| Tokens per conversation | ~7k | ~14k | ~26k |

Key findings:
- 26% higher accuracy over OpenAI Memory on multi-hop reasoning
- 91% lower p95 latency vs full-context approaches
- 90%+ token cost savings
- Graph memory adds ~2% overall score improvement, excels at temporal reasoning
