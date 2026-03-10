# Haystack by deepset — Reference

**Repository**: [deepset-ai/haystack](https://github.com/deepset-ai/haystack) (~21.5k stars)
**Docs**: [docs.haystack.deepset.ai](https://docs.haystack.deepset.ai)
**License**: Apache 2.0
**Category**: Tier 2 — Focused Study

## What It Is

Pipeline-based RAG orchestration framework. Open source, Python, production-oriented. The core abstraction is a **pipeline** — a directed multigraph of components where data flows through typed connections. Version 2.x is a major rewrite.

## Core Concepts

- **Components**: Building blocks with typed inputs/outputs and a `run()` method
- **Pipelines**: Directed graphs connecting components via typed edges
- **Document Stores**: Storage backends with standard protocol (write, read, filter, delete)
- **Integrations**: 100+ third-party integrations

## Pipeline Architecture

Pipelines are directed multigraphs — components are nodes, connections are typed edges:

```python
pipe = Pipeline()
pipe.add_component("embedder", SentenceTransformersTextEmbedder())
pipe.add_component("retriever", PgvectorEmbeddingRetriever(document_store=store))
pipe.connect("embedder.embedding", "retriever.query_embedding")
```

**Key features**:
- Explicit typed connections validated at construction time
- **Branching**: ConditionalRouter (Jinja2 conditions), FileTypeRouter (MIME types), MetadataRouter
- **Loops**: Output of later component fed back to earlier — enables self-correction and agent tool-use loops
- **AsyncPipeline**: Concurrent component execution, `concurrency_limit` (default 4)
- **Serialization**: Pipelines serialize to YAML for version control and deployment
- **SuperComponents**: Wrap entire pipeline as single reusable component with input/output mapping

## Component Protocol

```python
@component
class MyComponent:
    def warm_up(self):       # Load models once, before first run()
        self.model = load_model(self.model_name)

    @component.output_types(result=str, score=float)
    def run(self, text: str) -> dict:
        return {"result": "processed", "score": 0.95}
```

The `warm_up()` pattern is key — load heavy resources (models, connections) once, not per-request.

## Document Processing & Chunking

Four splitting strategies:

| Strategy | How It Works |
|----------|-------------|
| **DocumentSplitter** | Fixed split by word/sentence/passage/page with overlap + threshold |
| **RecursiveDocumentSplitter** | Hierarchical separators: paragraphs → sentences → newlines → spaces |
| **HierarchicalDocumentSplitter** | Parent-child tree structure with auto-merging retriever |
| **EmbeddingBasedDocumentSplitter** | Semantic breakpoints via embedding cosine distance (experimental) |

RecursiveDocumentSplitter is the most robust — tries paragraph splits first, falls back to sentences, then words.

## Retrieval Patterns

### Hybrid Retrieval (Gold Standard)

```
Query → TextEmbedder → EmbeddingRetriever ──┐
     └→ (passthrough) → BM25Retriever ──────┤→ DocumentJoiner → Ranker
```

**DocumentJoiner** merge strategies:
- `concatenate`: Simple concatenation
- `merge`: Merge scores of duplicate documents
- **`reciprocal_rank_fusion`**: Combines based on rank positions — docs in multiple lists score higher
- `distribution_based_rank_fusion`: Normalizes score distributions for balanced fusion

**Reranking**: Cross-encoder model (TransformersSimilarityRanker) scores each (query, document) pair. Retrieve top-100, rerank to top-10.

**Production recommendation**: Always use hybrid retrieval (embedding + keyword) with reranking.

## Document Stores

| Backend | Embedding | Keyword | Notes |
|---------|-----------|---------|-------|
| **pgvector** | HNSW + exact | ts_rank_cd | Good for existing PG deployments |
| Qdrant | Yes | Yes | Purpose-built vector DB |
| Elasticsearch | Yes | BM25 | Full-text + vectors |
| Chroma | Yes | No | Lightweight embedded |
| Neo4j | Yes | Yes | Graph + vectors |

**PgvectorDocumentStore**: HNSW or exact search, cosine/inner-product/L2, half-precision vectors, metadata filtering.

## On-Prem Viability

Full Ollama integration — 4 components: OllamaGenerator, OllamaChatGenerator, OllamaTextEmbedder, OllamaDocumentEmbedder. Default embedding model: nomic-embed-text.

HuggingFace local models for embedding and reranking. Fully air-gapped deployment possible.

## Sources

- [Haystack Docs — Pipelines](https://docs.haystack.deepset.ai/docs/pipelines)
- [Haystack Docs — Components](https://docs.haystack.deepset.ai/docs/components)
- [Haystack Docs — DocumentSplitter](https://docs.haystack.deepset.ai/docs/documentsplitter)
- [Haystack Docs — DocumentJoiner](https://docs.haystack.deepset.ai/docs/documentjoiner)
- [Haystack Docs — PgvectorDocumentStore](https://docs.haystack.deepset.ai/docs/pgvectordocumentstore)
- [Haystack Tutorial — Hybrid Retrieval](https://haystack.deepset.ai/tutorials/33_hybrid_retrieval)
- [Haystack Integration — Ollama](https://haystack.deepset.ai/integrations/ollama)

## Doc Index

- [README.md](README.md) — This file
- [comparison.md](comparison.md) — Gap analysis and patterns to adopt
