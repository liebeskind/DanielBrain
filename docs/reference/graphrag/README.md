# Microsoft GraphRAG — Reference

**Repository**: [microsoft/graphrag](https://github.com/microsoft/graphrag) (~30.5k stars)
**Paper**: [From Local to Global: A Graph RAG Approach to Query-Focused Summarization](https://arxiv.org/abs/2404.16130)
**License**: MIT
**Category**: Tier 1 — Deep Dive

## What It Is

Graph-based RAG system that transforms raw documents into a structured knowledge graph with hierarchical community detection. Enables both entity-specific queries (local search) and broad thematic queries (global search via map-reduce over community summaries).

**Two-pipeline design**:
- **Indexing Pipeline** (offline, expensive): documents → chunks → entity/relationship extraction → community detection → community summarization → embeddings
- **Query Pipeline** (online): three search modes — Local, Global, DRIFT

**Key innovation**: Hierarchical Leiden community detection + LLM-generated community reports enable answering "what are the main themes across all data?" — something pure vector RAG cannot do. 70-80% win rate vs naive RAG on global queries.

**Cost tradeoff**: Expensive indexing (~$33K for very large datasets), but high quality. LazyGraphRAG variant achieves comparable quality at 0.1% indexing cost using NLP extraction instead of LLM.

## Doc Index

| File | Focus |
|------|-------|
| [README.md](README.md) | This file — overview and doc index |
| [architecture.md](architecture.md) | Two-pipeline design, config system, code organization |
| [data-model.md](data-model.md) | Entities, relationships, communities, reports, text units, covariates |
| [community-detection.md](community-detection.md) | Hierarchical Leiden, community reports, why they enable global search |
| [retrieval.md](retrieval.md) | Local search, Global search (map-reduce), DRIFT search |
| [pipeline.md](pipeline.md) | Indexing workflow, LLM calls per step, cost considerations |
| [storage-layer.md](storage-layer.md) | Parquet files, LanceDB, PostgreSQL integration options |
| [comparison.md](comparison.md) | Gap analysis, "GraphRAG Lite" implementation plan for TopiaBrain |

## Sources

- [GraphRAG Documentation](https://microsoft.github.io/graphrag/)
- [Original Paper (arXiv 2404.16130)](https://arxiv.org/abs/2404.16130)
- [LazyGraphRAG Blog](https://www.microsoft.com/en-us/research/blog/lazygraphrag-setting-a-new-standard-for-quality-and-cost/)
- [DRIFT Search Blog](https://www.microsoft.com/en-us/research/blog/introducing-drift-search-combining-global-and-local-search-methods-to-improve-quality-and-efficiency/)
- [graphology-communities-louvain](https://graphology.github.io/standard-library/communities-louvain.html) (JS implementation)
- [postgres-graph-rag](https://github.com/h4gen/postgres-graph-rag) (PostgreSQL community project)
