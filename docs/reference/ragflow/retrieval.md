# RAGFlow Retrieval

## Overview

RAGFlow uses **hybrid search** as its core retrieval strategy — combining multiple recall methods with fused reranking. This is more sophisticated than pure vector search and addresses the known weaknesses of embedding-only retrieval.

## Retrieval Pipeline

1. **Query processing** — user query is embedded (dense vector) and tokenized (for full-text)
2. **Multi-recall** — multiple retrieval strategies run in parallel:
   - Dense vector search (semantic similarity)
   - Full-text search (BM25/keyword matching)
   - Sparse vector search (learned sparse representations, when supported by backend)
3. **Fusion** — results from all recall strategies are merged
4. **Reranking** — a reranking model re-scores the merged results for final ordering
5. **Citation** — top results are passed to the LLM with source references for grounded answers

## Hybrid Search Deep Dive

RAGFlow's position (from their blog): **"Blended RAG" — combining full-text, dense vector, and sparse vector searches — outperforms both pure vector and two-way hybrid approaches.** Adding ColBERT as a reranker on top of three-way hybrid yields further improvement.

### Dense Vector Search
- Standard embedding-based similarity (cosine/dot product)
- Supported embedding models: Qwen3-Embedding-0.6B (default), BAAI/bge-m3, BAAI/bge-small-en-v1.5
- Also supports external embedding services (OpenAI, etc.)

### Full-Text Search
- BM25-style keyword matching via Elasticsearch/Infinity/OpenSearch
- Phrase search support (important for exact matches RAGFlow emphasizes)
- This catches queries where the exact terminology matters more than semantic similarity

### Sparse Vector Search
- Learned sparse representations (available in Infinity backend)
- Bridges the gap between dense embeddings and keyword search
- Not available in all backend configurations

## Reranking

RAGFlow supports multiple reranking approaches:

- **Built-in rerankers**: BCE (Bilingual Conversational Embeddings), BGE reranker, Jina reranker
- **Tensor reranking**: available via Infinity backend — uses ColBERT-style late interaction for high-quality reranking
- **External reranker services**: configurable

The full Docker image (~9 GB) includes built-in BGE/BCE embedding and reranking models. The slim image (~1 GB) requires external model services.

## Citation and Grounding

RAGFlow emphasizes **traceable citations**:
- Each answer includes references to specific chunks
- Users can click through to see the source chunk and its position in the original document
- This provides "quick view of the key references and traceable citations to support grounded answers"

## Infinity vs. Elasticsearch for Retrieval

| Feature | Elasticsearch | Infinity |
|---------|--------------|----------|
| Dense vector search | Yes | Yes |
| Full-text search | Yes (mature) | Yes |
| Sparse vector search | Limited | Yes (native) |
| Tensor reranking | No | Yes (ColBERT-style) |
| Three-way hybrid | Partial | Full |
| Phrase search | Yes | Yes |

RAGFlow's team built Infinity specifically for RAG retrieval, and it is becoming the preferred backend.

## RAPTOR-Enhanced Retrieval

When RAPTOR is enabled, retrieval can match at multiple levels of abstraction:
- **Leaf level**: specific details from original chunks
- **Intermediate level**: cluster summaries combining related chunks
- **Root level**: high-level document/topic summaries

This means a broad query ("what is the company strategy?") matches root-level summaries, while a specific query ("what was Q3 revenue?") matches leaf chunks.

## GraphRAG Retrieval

When Knowledge Graph chunking is used:
- Entities, relationships, and communities are indexed alongside text chunks
- Full-text and vector search span both text chunks and graph-derived chunks
- Graph structure enables "explain the relationship between X and Y" queries

## Key Insight for TopiaBrain

TopiaBrain currently uses pure vector search (pgvector HNSW). Patterns to consider:

1. **Hybrid search** — adding full-text search (PostgreSQL `tsvector` / `ts_rank`) alongside vector search would catch queries where exact entity names or keywords matter. This is the single biggest retrieval improvement available.

2. **Reranking** — a lightweight reranking step after initial recall could improve result ordering. Even a simple cross-encoder on top 20 results would help.

3. **Citation grounding** — TopiaBrain's MCP tools already return source thoughts, but a more explicit citation format (linking specific claims to specific thoughts) would increase trust.
