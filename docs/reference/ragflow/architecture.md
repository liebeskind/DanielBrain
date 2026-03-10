# RAGFlow Architecture

## System Overview

RAGFlow follows a layered microservices architecture with five distinct layers:

1. **Client Interface** — Web UI (React-based) for document management, chat, knowledge base configuration, and chunk review
2. **API Gateway** — RESTful HTTP API + Python SDK for programmatic access
3. **Service Layer** — Business logic: knowledge base management, chat/conversation, agent orchestration
4. **Worker Layer** — Async task processing: document parsing, chunking, embedding generation, indexing
5. **Storage Layer** — Pluggable document engines (Elasticsearch/Infinity/OpenSearch) + relational DB (MySQL/PostgreSQL) for metadata

## Key Architectural Decisions

### Async Document Processing

Document ingestion is asynchronous. When a user uploads a file:
1. File is stored and a processing task is queued
2. Worker picks up the task (FOR UPDATE SKIP LOCKED pattern, similar to TopiaBrain)
3. DeepDoc vision pipeline runs (OCR, layout recognition, table structure recognition)
4. Chunking template is applied based on document type
5. Embeddings are generated
6. Chunks are indexed in the document engine (Elasticsearch/Infinity)

This decouples upload from processing, allowing heavy GPU-bound parsing to happen in background workers.

### Document Engine Abstraction

The `DOC_ENGINE` environment variable controls which backend is used:
- **Elasticsearch** (default) — mature, widely deployed, good hybrid search
- **Infinity** (preferred direction) — purpose-built for RAG by the same team (InfiniFlow), supports dense vectors + sparse vectors + full-text + tensor reranking natively
- **OpenSearch** — AWS-compatible alternative to Elasticsearch

Only one engine runs at a time via Docker Compose profiles. The abstraction layer means RAGFlow code is not tightly coupled to any single backend.

### Ingestion Pipeline (v0.21+)

Starting with v0.21, RAGFlow introduced an orchestratable **Ingestion Pipeline** — a visual ETL process for unstructured data. It restructures the ingestion workflow into three phases:

1. **Parser** — converts files into structured text while preserving layout, tables, headers. Supports 8 categories and 23+ formats (PDF, Image, Audio, Video, Email, Spreadsheet, Word, PPT, HTML, Markdown)
2. **Transformer** — applies chunking, summarization, keyword extraction, Q&A generation, metadata enrichment via LLM
3. **Indexer** — generates embeddings and writes to the document engine

Users can orchestrate custom pipelines using the Agent Canvas (visual drag-and-drop), mixing and matching parser/transformer/indexer components.

### Agent Framework

RAGFlow includes a built-in agent framework with pre-built templates. Agents can:
- Retrieve from knowledge bases
- Invoke external tools/APIs
- Chain multiple retrieval and reasoning steps
- The ingestion pipeline itself is built on the agent framework

### Multi-Tenancy

RAGFlow supports multi-user operation with per-user knowledge bases (called "datasets"). Each user manages their own documents, chunking configurations, and chat assistants.

## Component Map

```
ragflow/
  api/            # REST API endpoints
  rag/            # Core RAG logic (chunking, retrieval, ranking)
  deepdoc/        # Document understanding (vision + parser)
    vision/       # OCR, layout recognition, table structure recognition
    parser/       # PDF, DOCX, Excel, PPT, HTML parsers
  agent/          # Agent framework + canvas
  graphrag/       # Knowledge graph construction + GraphRAG
  conf/           # Configuration
  docker/         # Docker Compose files (with profiles for ES/Infinity/OpenSearch)
```
