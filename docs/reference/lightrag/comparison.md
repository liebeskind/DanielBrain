# LightRAG — Comparison to TopiaBrain

## Feature Matrix

| Capability | LightRAG | TopiaBrain | Gap |
|-----------|----------|------------|-----|
| Entity extraction | LLM per chunk + gleaning | LLM per thought (llama3.1:8b) | LightRAG has retry/gleaning mechanism |
| Entity dedup | Fuzzy matching + merge | Normalization + alias + HITL | We're stronger with HITL proposals |
| Relationships | First-class with strength scores | Junction table (thought_entities) | LightRAG treats relations as searchable objects |
| Relationship strength | Summed across observations | mention_count on entities only | We lack per-relationship strength |
| Community detection | None (by design) | None | Neither — but LightRAG's profiling substitutes |
| Theme-level retrieval | High-level keyword → relation profiles | Not yet | Major gap |
| Entity-level retrieval | Low-level keyword → entity nodes | semantic_search + get_entity | Similar capability |
| Hybrid retrieval | mix mode (graph + vector) | Semantic search only | Gap: no graph traversal in search |
| Incremental updates | Union-merge on insert | Entity resolution per thought | Both incremental |
| HITL quality control | None | Confidence-gated proposals | Our advantage |
| Storage | Pluggable (supports pgvector) | PostgreSQL + pgvector | Compatible |
| Model requirements | 32B+ recommended | 8B (llama3.1:8b) | We need patterns that work with 8B |

## Patterns to Adopt

### 1. Dual-Level Keyword Extraction from Queries (HIGH PRIORITY)
Instead of embedding the full query for vector search, use LLM to extract:
- Specific entity names (low-level) → search entities directly
- Themes/topics (high-level) → search relationship profiles

This is cheap (small prompt) and dramatically improves retrieval relevance. Can be added to `semantic_search` MCP tool as a pre-processing step.

### 2. Relationships as First-Class Searchable Objects (HIGH PRIORITY)
Currently our `thought_entities` junction table stores links but relationships aren't independently searchable. LightRAG's approach:
- Each relationship has its own profile text and embedding
- Relationships have cumulative `relationship_strength` scores
- Relationship profiles include theme keywords

Our `entity_relationships` table (migration 009, not yet populated) is the right place for this.

### 3. Relationship Strength Accumulation (MEDIUM)
When the same entity-entity relationship is observed across multiple thoughts, sum a strength score. Currently we only track `mention_count` on entities. Adding per-relationship strength to `entity_relationships` would enable:
- Stronger connections surfaced first
- Weak/incidental connections deprioritized

### 4. Gleaning for Extraction Quality (MEDIUM)
Given 8B model limitations, running a second "did I miss anything?" extraction pass with a more assertive prompt can improve recall without upgrading models. Low cost (one extra LLM call per thought) with meaningful quality improvement.

### 5. Mix-Mode Retrieval (HIGH PRIORITY)
Combining graph-based retrieval (entity lookup + 1-hop traversal) with traditional vector chunk search in parallel. Our `get_context` tool partially does this but doesn't formalize it. The pattern:
1. Extract keywords from query
2. In parallel: graph traversal from matched entities + vector search on chunks
3. Merge and deduplicate results

### 6. Entity/Relation Profiling with Theme Keywords (MEDIUM)
LightRAG generates multiple search keys per relation (including global themes), not just one embedding. This is a lightweight way to get theme-level retrieval without community detection. Our profile generator could generate theme keywords that get separately embedded.

## What NOT to Adopt

- **LightRAG as a dependency**: Python, requires 32B+ for good extraction quality
- **No community detection**: For global "what are the themes?" queries, we'll want GraphRAG-style communities (from GraphRAG research)
- **NetworkX graph storage**: We stay on PostgreSQL

## Implementation Notes

- All patterns are implementable on PostgreSQL + pgvector + Ollama
- Keyword extraction from queries works with 8B models (small, focused prompt)
- Relationship profiling can be done incrementally (same pattern as entity profiles)
- Mix-mode retrieval is essentially what `get_context` should become
