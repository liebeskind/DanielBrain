# LightRAG Reference

**Repository**: [HKUDS/LightRAG](https://github.com/HKUDS/LightRAG) (~27k stars)
**Paper**: [arXiv 2410.05779](https://arxiv.org/html/2410.05779v1) (EMNLP 2025)
**Category**: Tier 2 — Focused Study

## What It Is

Graph-enhanced RAG system from HKU Data Science Lab. Builds a lightweight knowledge graph from documents and uses dual-level retrieval (entity + theme) to answer queries. Key innovation: **eliminates community detection entirely**, replacing GraphRAG's expensive Leiden clustering + community summarization with direct entity/relationship profiling and vector similarity on keywords.

## Core Pipeline

1. Chunk documents (1200 tokens default, 100 overlap)
2. LLM extracts entities + relationships from each chunk (with "gleaning" retries)
3. Deduplicate and merge identical entities/relations across chunks
4. Generate text key-value profiles for each entity and relation
5. Embed profile keys into vector DB for retrieval
6. At query time: extract keywords from query, match against entity/relation vectors, traverse 1-hop neighbors

## Dual-Level Retrieval

LLM extracts **two types of keywords** from each query:

- **Low-level (local)**: Specific entity names — matched against entity nodes via vector similarity. Retrieved entities bring profiles, linked relationships, 1-hop neighbors.
- **High-level (global)**: Themes and topics — matched against relationship/edge profiles which include global theme keys derived from connected entities. Captures cross-entity patterns without community summaries.

**Query modes**: `local`, `global`, `hybrid`, `naive` (vector chunks only), `mix` (graph + vector in parallel, recommended), `bypass` (direct LLM).

The `mix` mode runs `get_kg_context()` (structured graph retrieval) and `get_vector_context()` (traditional vector chunk search) in parallel.

## Cost Efficiency (vs GraphRAG)

The "6000x cheaper" claim is about **query-phase token usage**:
- LightRAG query: ~100 tokens + single API call
- GraphRAG query: ~610,000 tokens across many API calls (map-reduce over community summaries)

Indexing cost is comparable. But LightRAG supports **incremental insert** — new chunks processed and merged into existing graph — while GraphRAG requires rebuilding the entire index.

Real-world example: ~$4 with GraphRAG vs ~$0.10-0.15 with LightRAG per dataset.

## Graph Construction

**Extraction**: LLM prompted with configurable entity types and few-shot examples. Each entity gets name, type, description. Each relationship gets source, target, description, `relationship_strength` (numeric score).

**Gleaning**: Configurable retry (`entity_extract_max_gleaning`, default 1) — LLM re-prompted with more aggressive prompt to find missed entities/relations.

**Dedup & Merge**: `D()` function merges identical entities/relations across chunks. Same relationship appearing multiple times gets `relationship_strength` scores **summed** (reinforcing frequently-observed connections). Uses fuzzy matching (fuzzywuzzy) before merge.

**Profiling**: `P()` function generates text key-value pairs per entity and relation. Relation keys include global themes derived from connected entities — this is how high-level retrieval works without community detection.

## Storage Backends

Pluggable architecture with 4 storage types:

| Type | Default | Production Options |
|------|---------|-------------------|
| Graph | NetworkX (in-memory) | Neo4j, PostgreSQL+AGE |
| Vector | NanoVectorDB | **pgvector**, Milvus, Chroma, Faiss, Qdrant |
| Key-Value | JSON files | PostgreSQL, Redis, MongoDB |
| Doc Status | JSON files | PostgreSQL, MongoDB |

All-PostgreSQL stack possible: PGVectorStorage + PGKVStorage + PGGraphStorage + PGDocStatusStorage (though Neo4j recommended over AGE for graph performance).

## On-Prem Viability

**Official recommendation: 32B+ parameter LLM with 32K-64K context window.**

- Entity extraction quality degrades with smaller models (experiment with 2B model: 197 entities but only 19 relations vs much higher with larger models)
- Query-time keyword extraction is less demanding than extraction
- Ollama directly supported with built-in integration
- nomic-embed-text is compatible (they recommend BAAI/bge-m3)

**Bottom line**: Extraction is the bottleneck for 8B models. Retrieval patterns are adoptable regardless of model size.

## Sources

- [LightRAG Paper](https://arxiv.org/html/2410.05779v1)
- [LearnOpenCV Tutorial](https://learnopencv.com/lightrag/)
- [Neo4j: Under the Covers — Extraction](https://neo4j.com/blog/developer/under-the-covers-with-lightrag-extraction/)
- [Neo4j: Under the Covers — Retrieval](https://neo4j.com/blog/developer/under-the-covers-with-lightrag-retrieval/)
- [Prompt Engineering Guide](https://promptengineering.org/lightrag-graph-enhanced-text-indexing-and-dual-level-retrieval/)

## Doc Index

- [README.md](README.md) — This file
- [comparison.md](comparison.md) — Gap analysis and patterns to adopt
