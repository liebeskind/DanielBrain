# Haystack — Comparison to TopiaBrain

## Feature Matrix

| Aspect | TopiaBrain | Haystack |
|--------|-----------|----------|
| Pipeline | Manual function chain | Directed graph with type validation |
| Chunking | Fixed word-based, ~1000 tokens | Multiple strategies: recursive, semantic, hierarchical |
| Embeddings | Ollama nomic-embed-text | Ollama, HuggingFace, or cloud |
| Storage | Custom PostgreSQL + pgvector | PgvectorDocumentStore (same tech) |
| Retrieval | Embedding-only (`match_thoughts`) | Hybrid (embedding + BM25 + RRF + reranking) |
| Entity resolution | Custom LLM extraction + normalization | Not built-in |
| Source routing | Source-specific code paths | ConditionalRouter, FileTypeRouter |
| Async | Queue-based sequential | AsyncPipeline with concurrency control |
| HITL | Confidence-gated proposals | Not built-in |

## Patterns to Adopt

### 1. Hybrid Retrieval with RRF (HIGH PRIORITY)
The single biggest practical improvement available. Combine:
- pgvector embedding search (what we have)
- PostgreSQL full-text search with `ts_rank_cd` (free — already in PG)
- Reciprocal Rank Fusion to combine results
- Optional cross-encoder reranking

Haystack's DocumentJoiner with `reciprocal_rank_fusion` is the pattern. Implementation in our stack:
1. Add `tsvector` column to thoughts table (GIN indexed — we may already have this)
2. Run both embedding search and full-text search in parallel
3. Combine with RRF: `score = sum(1 / (k + rank_i))` across retrieval methods
4. Return top-N

### 2. Recursive Splitting (MEDIUM)
Replace fixed word-based splitting with hierarchical approach:
1. Try paragraph splits (`\n\n`) first
2. If chunks still too large, split by sentence
3. Then by newline
4. Then by word

More robust for varied content (meeting transcripts vs. Slack messages vs. manual thoughts). Our chunker already does newline-based splitting but could be more sophisticated.

### 3. warm_up() Pattern for Model Loading (LOW — may already have)
Load Ollama models once at startup, not per-request. If we're already doing this via persistent Ollama connections, no change needed.

### 4. Source-Specific Routing Pattern (MEDIUM)
Formalize source-specific processing as explicit routing:
- Slack messages → Slack processor
- Fathom transcripts → Meeting summarizer
- Manual thoughts → Direct pipeline

We already do this informally. Haystack's ConditionalRouter pattern makes it explicit and testable.

### 5. Hierarchical Splitting + Auto-Merge (FUTURE)
For meeting transcripts: split fine-grained for retrieval precision, auto-merge to parent context for LLM generation. Requires parent-child document relationships in storage.

## What NOT to Adopt

- **Haystack as a dependency**: Python library, we're TypeScript
- **Document Store abstraction**: Our custom pgvector queries are more tailored to entity graph
- **YAML pipeline serialization**: Unnecessary for single-deployment system
- **Cloud integrations**: Violates data sovereignty
- **Full component protocol**: Over-engineering for our scale — adopt the concepts (typed interfaces, warm_up) not the framework

## Key Takeaway

Haystack's main contribution to our architecture is **retrieval patterns** — hybrid search with RRF is well-proven and directly implementable on our PostgreSQL stack. The pipeline architecture concepts are informative but we don't need the framework itself.
