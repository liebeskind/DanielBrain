# RAGFlow Storage

## Overview

RAGFlow uses a two-tier storage architecture:
1. **Document engine** — stores chunks, embeddings, and full-text indexes (Elasticsearch, Infinity, or OpenSearch)
2. **Relational database** — stores metadata: users, knowledge bases, conversations, tasks, configurations (MySQL or PostgreSQL)

## Document Engine Options

The `DOC_ENGINE` environment variable in `docker/.env` controls which backend is active. Only one runs at a time via Docker Compose profiles.

### Elasticsearch (Default)

- Mature, widely deployed, large ecosystem
- Supports dense vector search (kNN) + BM25 full-text search
- Limited sparse vector support
- No native tensor reranking
- Resource-heavy: requires significant memory (default `vm.max_map_count=262144`)
- RAGFlow has used Elasticsearch since inception

### Infinity (Preferred Direction)

- Built by the same team (InfiniFlow) specifically for RAG workloads
- Native support for: dense vectors, sparse vectors, full-text search, tensor reranking
- All search types integrated in a single engine — no external reranker needed
- Graph entities and communities included in search scope
- Designed to replace Elasticsearch as RAGFlow's primary backend
- Lighter resource footprint than Elasticsearch

### OpenSearch (Alternative)

- AWS-compatible fork of Elasticsearch
- Functionally similar to Elasticsearch for RAGFlow's purposes
- Option for AWS-native deployments

## Embedding Storage

Embeddings are stored directly in the document engine alongside the chunk text:
- Dense vectors (float arrays from embedding models)
- Sparse vectors (when using models that produce them, e.g., SPLADE)
- Full-text index (inverted index for BM25)

This co-location means a single query can fan out to all three retrieval methods without cross-service calls.

## Supported Embedding Models

| Model | Type | Notes |
|-------|------|-------|
| Qwen/Qwen3-Embedding-0.6B | Dense | Default built-in model |
| BAAI/bge-m3 | Dense + Sparse | Multilingual, supports sparse output |
| BAAI/bge-small-en-v1.5 | Dense | Lightweight English model |
| External services | Dense | OpenAI, Ollama, Xinference, vLLM, etc. |

Built-in models are included in the "full" Docker image (~9 GB). The "slim" image (~1 GB) requires external embedding services.

## Relational Database

- MySQL (default) or PostgreSQL for metadata
- Stores: users, knowledge bases (datasets), documents, parsing tasks, conversations, agent configurations
- Does NOT store chunk content or embeddings — those live in the document engine

## Comparison to TopiaBrain Storage

| Aspect | RAGFlow | TopiaBrain |
|--------|---------|------------|
| Vector storage | Elasticsearch/Infinity | PostgreSQL + pgvector |
| Full-text search | Elasticsearch BM25 | Not yet (PostgreSQL tsvector available) |
| Sparse vectors | Infinity only | Not supported |
| Metadata DB | MySQL/PostgreSQL | PostgreSQL (same DB) |
| Embedding model | BGE/Qwen (built-in or external) | nomic-embed-text (Ollama) |
| Reranking | Built-in BCE/BGE/Jina | Not yet |

**Key tradeoff**: RAGFlow uses separate systems for vectors (Elasticsearch) and metadata (MySQL), adding operational complexity but gaining specialized search features. TopiaBrain uses a single PostgreSQL instance for everything, which is simpler but lacks advanced full-text ranking and sparse vector support.
