# Cognee Architecture

Baseline: `c9370a8b` (2026-03-08)

## Module Organization

Cognee uses a modular structure with two main directories:

### Core Modules (`cognee/modules/` — 21 modules)

| Module | Purpose |
|--------|---------|
| `cognify` | Core processing orchestration |
| `ingestion` | Data intake, classification, discovery |
| `chunking` | Multiple strategies (paragraph, sentence, word, row) |
| `graph` | Knowledge graph operations (Node/Edge models, extraction) |
| `storage` | Multi-backend persistence abstraction |
| `pipelines` | Workflow composition and execution |
| `retrieval` | 15+ retrieval strategies |
| `search` | Query types, logging, result management |
| `ontology` | Schema validation, resolver strategies |
| `memify` | Memory pipeline specialization |
| `engine` | Core processing operations |
| `data` | Data handling, transformation, deletion |
| `settings` | Configuration management |
| `users` | Multi-tenant user management |
| `visualization` | Graph rendering and UI |
| `metrics` | Performance metrics |
| `observability` | Logging and tracing |
| `sync` | Synchronization |
| `cloud` | Cloud backend integration |
| `notebooks` | Jupyter notebook support |

### Task Modules (`cognee/tasks/` — 16 modules)

| Module | Purpose |
|--------|---------|
| `chunks` | 4 chunking strategies + chunk association creation |
| `graph` | Entity extraction (v1 + v2), code analysis |
| `schema` | Schema validation |
| (+ others for specific pipeline steps) |

## Three-Tier Database Abstraction

Cognee separates storage into three distinct interfaces:

```
┌─────────────────────────────────────────────┐
│              Application Layer              │
│   (Tasks, Pipeline, Retrieval Strategies)   │
├──────────┬──────────────┬───────────────────┤
│  Graph   │    Vector    │    Relational     │
│  (Kuzu)  │  (LanceDB)  │    (SQLite)       │
├──────────┴──────────────┴───────────────────┤
│  PostgreSQL + pgvector (production option)  │
└─────────────────────────────────────────────┘
```

- **Graph**: Kuzu (default), Neo4j, NetworkX, FalkorDB — stores entities and relationships
- **Vector**: LanceDB (default), pgvector, Qdrant, Weaviate — stores embeddings for similarity search
- **Relational**: SQLite (default), PostgreSQL — stores raw data, metadata, user/tenant info

Each tier has an abstract interface allowing backend swaps without changing application code. See [storage-layer.md](storage-layer.md) for details.

## Pipeline-as-DAG Execution Model

The core processing model is a directed acyclic graph of tasks:

```
add()           cognify()                              search()
  │                │                                      │
  ▼                ▼                                      ▼
Ingest ──► [chunk → extract → filter → resolve → integrate → persist]  ──► Retrieve
```

Key properties:
- **Tasks are polymorphic** — any callable (sync/async, function/generator) wrapped in a `Task` class
- **Batch parallelism** — items processed concurrently via `asyncio.gather`
- **Incremental** — already-processed items are skipped
- **Cacheable** — pipeline results cached per dataset
- **Dataset-scoped** — each dataset processed independently

See [pipeline-and-tasks.md](pipeline-and-tasks.md) for the execution stack.

## Data Flow: add → cognify → search

### 1. Add (Ingestion)
- Accept raw text, files, or URLs
- Classify data type, assign to dataset
- Store raw data in relational DB

### 2. Cognify (Processing)
- Chunk text using configured strategy (paragraph by default)
- Extract entities and relationships via LLM (Instructor for structured output)
- Filter edges, resolve against ontology
- Integrate into knowledge graph
- Embed chunks and entities into vector store

### 3. Search (Retrieval)
- Accept natural language query
- Select retriever (auto or explicit) from 15+ strategies
- Combine vector similarity, graph traversal, and/or lexical matching
- Return ranked results with optional LLM completion

## Key Dependencies

| Dependency | Purpose | Version |
|-----------|---------|---------|
| SQLAlchemy | Relational DB abstraction (async) | Core |
| LanceDB | Default vector store | Default |
| Kuzu | Default graph database | Default |
| FastAPI | REST API server | Core |
| Instructor | Structured LLM output (JSON schema) | Core — **critical dependency** |
| LiteLLM | LLM provider abstraction | Core |
| Pydantic | Data validation and models | Core |
| RDFLib | Ontology file parsing | Optional |
| BAML | Alternative structured output | Optional |

### LLM Provider Support

Configured via environment variables:

```
LLM_PROVIDER=ollama          # or openai, anyscale, lm_studio
LLM_MODEL=llama3.1:8b
LLM_ENDPOINT=http://localhost:11434

EMBEDDING_PROVIDER=ollama
EMBEDDING_MODEL=nomic-embed-text
EMBEDDING_DIMENSIONS=768
```

Supported: OpenAI, Ollama, LM Studio, Anyscale, and any OpenAI-compatible endpoint.

LLM abstraction layer at `cognee/infrastructure/llm/`.

## Python Version

Requires Python 3.10–3.13.

## Contrast with TopiaBrain

| Aspect | Cognee | TopiaBrain |
|--------|--------|------------|
| Database tiers | 3 separate (graph + vector + relational) | 1 unified (PostgreSQL + pgvector) |
| LLM dependency | Heavy (structured output pipeline) | Light (metadata extraction + deterministic matching) |
| Default graph DB | Kuzu | PostgreSQL tables |
| Default vector DB | LanceDB | pgvector |
| Pipeline model | DAG with Task abstraction | Procedural pipeline |
| Structured output | Instructor/BAML | Explicit prompts + JSON parsing |
| Min model size | 32B+ for reliable operation | 8B (resilient by design) |
