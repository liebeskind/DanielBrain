# Graphiti (Zep) — Reference

**Repository**: [getzep/graphiti](https://github.com/getzep/graphiti) (~20k stars)
**Paper**: [arXiv 2501.13956](https://arxiv.org/abs/2501.13956)
**License**: Apache 2.0
**Category**: Tier 1 — Deep Dive (highest priority project)

## What It Is

Temporal knowledge graph engine built explicitly as "memory for AI agents." Powers Zep's commercial agent memory platform. The closest existing project to TopiaBrain's vision.

**Key innovations**:
- **Bi-temporal model**: every edge tracks four timestamps — when the fact was true (`t_valid`/`t_invalid`) and when the system learned it (`t'_created`/`t'_expired`)
- **Incremental real-time updates**: episodes processed immediately without recomputing the entire graph (unlike GraphRAG's batch reindexing)
- **LLM-free retrieval**: hybrid search (cosine + BM25 + BFS graph traversal) with Reciprocal Rank Fusion — no LLM calls at query time
- **Temporal invalidation**: new info invalidates old edges (fact evolution), preserving complete history
- **94.8% accuracy** on Deep Memory Retrieval benchmark, 300ms P95 latency

**Three-subgraph architecture**: Episodic (raw data) → Semantic (entities + edges) → Community (topic clusters via label propagation)

## Critical Finding: 8B Models Are Insufficient

Graphiti team recommends **70B minimum** for structured output quality. Entity extraction requires 5-15+ LLM calls per episode with JSON structured output. This means we adopt Graphiti's *patterns* (temporal model, hybrid retrieval, RRF), not its framework.

## Doc Index

| File | Focus |
|------|-------|
| [README.md](README.md) | This file — overview and doc index |
| [architecture.md](architecture.md) | Core design, temporal model, three-subgraph architecture |
| [data-model.md](data-model.md) | Episodes, entities, edges, temporal fields, custom types |
| [entity-extraction-resolution.md](entity-extraction-resolution.md) | Entity extraction, dedup, edge building, temporal invalidation |
| [retrieval-system.md](retrieval-system.md) | Hybrid retrieval, BM25, BFS, RRF, reranking strategies |
| [pipeline-ingestion.md](pipeline-ingestion.md) | Episode processing, add_episode flow, community detection |
| [storage-layer.md](storage-layer.md) | Neo4j, FalkorDB, Kuzu, PostgreSQL feasibility |
| [on-prem-viability.md](on-prem-viability.md) | LLM requirements, 8B assessment, what needs to change |
| [comparison-to-topiabrain.md](comparison-to-topiabrain.md) | Gap analysis, adoption roadmap, what to keep vs rebuild |

## Top Patterns to Adopt (Priority Order)

1. **Hybrid retrieval with RRF** — add BM25 full-text to existing cosine, combine with Reciprocal Rank Fusion (1-2 days effort)
2. **Temporal edge tracking** — `valid_at`/`invalid_at` on entity relationships for fact evolution
3. **Fact-level edges** — relationships between entities (not just entity-to-thought links)
4. **Community detection** — label propagation for topic clustering

## Sources

- [Graphiti GitHub](https://github.com/getzep/graphiti)
- [arXiv Paper](https://arxiv.org/html/2501.13956v1)
- [Neo4j Blog](https://neo4j.com/blog/developer/graphiti-knowledge-graph-memory/)
- [Zep Blog: How Do You Search a Knowledge Graph?](https://blog.getzep.com/how-do-you-search-a-knowledge-graph/)
- [Zep Docs: Searching](https://help.getzep.com/graphiti/working-with-data/searching)
