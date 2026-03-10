# Architecture Research Synthesis — Designing the Agentic Memory Layer

**Date**: 2026-03-09
**Projects studied**: Graphiti (Zep), Microsoft GraphRAG, Khoj, Mem0, LightRAG, Haystack, RAGFlow, cognee, Apache AGE, dedupe

This document synthesizes findings from 10 projects into concrete architecture recommendations for TopiaBrain v2.

---

## 1. Cross-Project Comparison by Capability

### Retrieval

| Project | Approach | Strength | 8B Viable? |
|---------|----------|----------|------------|
| **Graphiti** | Cosine + BM25 + BFS graph traversal, combined via RRF | Best hybrid approach — zero LLM calls at query time, sub-second latency | Yes (retrieval is LLM-free) |
| **GraphRAG** | Local (entity vector match + graph context) + Global (map-reduce over community reports) + DRIFT (hybrid) | Only system with true "global search" over themes | Partially (global search needs many LLM calls) |
| **LightRAG** | Dual-level keywords (entity + theme) matched against graph profiles | Cheaper global search — no communities needed, just relationship profiles | Yes (keyword extraction is small prompt) |
| **Haystack** | Embedding + BM25 + RRF + cross-encoder reranking | Gold standard pipeline — well-proven production pattern | Yes |
| **RAGFlow** | Dense + sparse + full-text, three-way hybrid + reranking | Strong document retrieval with citation grounding | Yes |
| **Khoj** | Bi-encoder + cross-encoder reranking + LLM query reformulation | Intent-aware retrieval with research mode iteration | Yes |
| **Mem0** | Vector search + parallel graph traversal + BM25 reranking | Dual-path (vector + graph) retrieval | Yes |
| **cognee** | 15 strategies including graph completion, insights, summaries | Most diverse but requires 32B+ models | No |
| **TopiaBrain** | pgvector cosine similarity only | Simple, fast, but misses keyword matches and graph context | Yes |

**Verdict**: Every project uses hybrid retrieval (vector + keyword + graph). We are the only one still doing vector-only search. **Hybrid retrieval with RRF is the single highest-priority improvement.**

### Entity Resolution

| Project | Approach | Strength |
|---------|----------|----------|
| **TopiaBrain** | Normalize + canonical match + alias + first-name prefix + HITL proposals | Best HITL quality control, good for 8B models |
| **Graphiti** | Similarity search + LLM confirmation + temporal edge tracking | Best temporal model — fact invalidation on contradiction |
| **Mem0** | Vector similarity + LLM ADD/UPDATE/DELETE/NOOP lifecycle | Best conflict resolution — atomic fact dedup |
| **LightRAG** | Fuzzy matching + merge, relationship strength accumulation | Good incremental merge with strength scoring |
| **GraphRAG** | Simple name+type dedup, LLM description summarization | Basic but functional |
| **cognee** | Ontology resolver with LLM-based grouping | Sophisticated but requires 32B+ |

**Verdict**: Our entity resolution is strong. Adopt temporal invalidation from Graphiti and conflict detection from Mem0, both routed through our proposals queue.

### Community Detection

| Project | Algorithm | LLM for Summaries? | 8B Viable? |
|---------|-----------|--------------------|-----------:|
| **GraphRAG** | Hierarchical Leiden (graspologic, Python) | Yes — full community reports | Partially |
| **Graphiti** | Label propagation (dynamic, extensible) | Yes — community descriptions | Yes (small prompts) |
| **LightRAG** | None (profiles substitute) | No — relation theme keys instead | Yes |
| **cognee** | NetworkX community detection | Yes | No (32B+) |
| **TopiaBrain** | None | N/A | N/A |

**Verdict**: Use Louvain (JS via graphology) — simpler than Leiden, sufficient at our scale. Generate community summaries with llama3.1:8b using well-structured prompts. Simplified global search (vector match on community embeddings) instead of full map-reduce.

### Agent Interface

| Project | Interface | Tools | Agent Model |
|---------|-----------|-------|-------------|
| **TopiaBrain** | MCP server (8 tools) | semantic_search, list_recent, stats, save_thought, get_entity, list_entities, get_context, get_timeline | External agents connect via MCP |
| **Mem0** | MCP (5 tools) + REST | add, search, list, delete, delete_all | Memory service for external agents |
| **Khoj** | Web app + plugins | search, web, code, computer use | Built-in agents with personas |
| **cognee** | MCP (5 tools) + REST | search, add, check, graph_completion, get_graph_url | Memory service |
| **Graphiti** | Python library | add_episode, search, get_episodes | Library, not a server |

**Verdict**: Our MCP server is well-positioned. Add write-side tools (update_entity, propose_merge, resolve_conflict) and query-routing tools (deep_research). Khoj's agent persona model (agent = persona + tools + knowledge scope) is the right simplicity level.

### Knowledge Quality — Fact Evolution & Staleness

| Project | Fact Evolution | Staleness Tracking |
|---------|---------------|-------------------|
| **Graphiti** | Bi-temporal edges: valid_at, invalid_at, created_at, expired_at | Built into data model |
| **Mem0** | LLM-driven UPDATE/DELETE on contradiction | Memory history audit trail |
| **GraphRAG** | None — batch reindexing | None |
| **TopiaBrain** | None — thoughts accumulate without invalidation | Entity staleness (10 mentions or 7 days) |

**Verdict**: This is our biggest knowledge quality gap. Adopt Graphiti's temporal model for entity relationships and Mem0's conflict detection for facts, both gated by our proposals queue.

### Pipeline Architecture

| Project | Pattern | Key Concept |
|---------|---------|-------------|
| **Haystack** | Directed graph of typed components | Pipeline serialization, routing, async concurrency |
| **GraphRAG** | Sequential indexing + parallel query | Factory pattern, LLM caching |
| **Graphiti** | Real-time per-episode + background community refresh | Incremental updates |
| **RAGFlow** | Visual ETL with source-specific templates | Layout-aware chunking |
| **TopiaBrain** | Queue-based sequential processing | Source-aware pipeline |

**Verdict**: Our queue-based incremental approach aligns with Graphiti (the closest architectural match). Adopt source-specific processing templates from RAGFlow and recursive splitting from Haystack.

### HITL Quality Control

| Project | Approach |
|---------|----------|
| **TopiaBrain** | Confidence-gated proposals with approve/reject/needs-changes lifecycle |
| **RAGFlow** | Post-processing chunk review UI (edit, add keywords) |
| **Everyone else** | None |

**Verdict**: **This is our biggest competitive advantage.** No major GraphRAG/memory project has HITL. Extend proposals to cover: community assignments, relationship validation, fact contradiction resolution.

### On-Prem Viability (8B Model Compatibility)

| Project | 8B Works? | Minimum Recommended |
|---------|-----------|-------------------|
| **Graphiti** | No | 70B+ |
| **GraphRAG** | Partially (noisy) | GPT-4 class (or FastGraphRAG for NLP extraction) |
| **Khoj** | Yes (Ollama supported) | Any Ollama model |
| **Mem0** | Partially (update decisions degrade) | GPT-4o-mini |
| **LightRAG** | Partially (extraction degrades) | 32B+ |
| **RAGFlow** | Yes (DeepDoc is CPU, LLM optional) | Any |
| **cognee** | No | 32B+ |
| **TopiaBrain** | Yes (designed for it) | llama3.1:8b |

**Verdict**: We're one of only two projects (with RAGFlow) that truly work with 8B models. Our approach — LLM hints + deterministic matching + HITL correction — is more resilient than structured-output-dependent systems. This is a strength to preserve.

---

## 2. Architecture Recommendations for TopiaBrain v2

### What to Keep

1. **PostgreSQL + pgvector as single store** — no separate graph DB. Every project that uses Neo4j adds operational complexity. Apache AGE or recursive CTEs can handle graph queries.
2. **Ollama on DGX Spark** — data sovereignty is non-negotiable. Our 8B-tuned prompts are a feature.
3. **Queue-based incremental processing** — matches Graphiti's real-time episode model. GraphRAG's batch reindexing is a non-starter.
4. **HITL proposals queue** — extend it, don't replace it. Route more operations through it.
5. **Entity resolution with normalization + aliases** — proven at our scale. Add temporal tracking, don't rebuild.
6. **MCP server as primary interface** — agents connect to the brain, not the other way around.
7. **Source-aware processing** — Slack/Telegram/Fathom each get appropriate handling.
8. **Chat v1** — working foundation to build on.

### What to Rebuild

1. **Retrieval system** — from vector-only to hybrid (vector + BM25 + graph traversal + RRF). This is the single biggest quality improvement available. Every project studied uses hybrid retrieval.
2. **Entity relationships** — from unpopulated junction table to first-class fact-level edges with temporal validity, descriptions, and strength scores. Foundation for community detection and graph traversal.

### What to Add

1. **BM25 full-text search** — PostgreSQL `tsvector` + `ts_rank_cd` alongside pgvector. Free (already in PG), immediate retrieval improvement.
2. **Reciprocal Rank Fusion** — combine vector + BM25 + graph results. Simple formula: `score = Σ(1 / (k + rank_i))`.
3. **Community detection** — Louvain via graphology (JavaScript). Scheduled job, not per-thought.
4. **Community summaries** — LLM-generated, embedded for vector search. Enables global/thematic queries.
5. **Temporal edge tracking** — `valid_at`/`invalid_at` on entity relationships for fact evolution.
6. **Fact contradiction detection** — Mem0-style comparison when new info overlaps existing, routed through proposals queue.
7. **Query routing** — LLM-based intent detection before search (from Khoj). One call to determine: search thoughts, entities, or both? Reformulate query for better retrieval.
8. **Relationship strength accumulation** — from LightRAG. When same entity pair co-occurs across thoughts, increment weight.
9. **Graph traversal in search** — BFS/recursive CTE from matched entities to connected entities + their thoughts.
10. **Dual-level keyword extraction** — from LightRAG. Extract entity names (low-level) and themes (high-level) from queries for targeted search.

### Priority Order

| Priority | Change | Source | Effort | Impact |
|----------|--------|--------|--------|--------|
| 1 | Hybrid retrieval (BM25 + RRF) | Graphiti, Haystack, all | Low-Med | **Highest** |
| 2 | Entity-to-entity relationships (populated) | GraphRAG, Graphiti | Medium | High |
| 3 | Community detection + summaries | GraphRAG, Graphiti | Medium | High |
| 4 | Temporal edge tracking | Graphiti | Medium | High |
| 5 | Query routing / intent detection | Khoj | Low | Medium |
| 6 | Fact contradiction detection | Mem0 | Medium | Medium |
| 7 | Graph traversal in search | Graphiti | Medium | Medium |
| 8 | Relationship strength + dual-level keywords | LightRAG | Low | Medium |
| 9 | Cross-encoder reranking | Khoj, Haystack | Medium | Medium |
| 10 | Source-specific chunking templates | RAGFlow | Low-Med | Medium |

---

## 3. Revised Roadmap for TopiaBrain

Phases reframed around "agentic operating system" priorities: knowledge quality → retrieval power → agent interface → everything else.

### Phase 5: Hybrid Retrieval (NEW — highest priority)
- Add `tsvector` column + GIN index on thoughts
- Implement BM25 full-text search alongside pgvector
- Reciprocal Rank Fusion to combine results
- LLM-based query routing (intent detection, query reformulation)
- Update `semantic_search` MCP tool to use hybrid retrieval
- **Note**: Chat v1 exists; this improves its context quality immediately

### Phase 6: Entity Relationships + Fact Evolution
- Populate `entity_relationships` during entity resolution (co-occurrence creates/updates edges)
- Add `weight`, `description`, `valid_at`, `invalid_at` columns
- Relationship strength accumulation (increment weight on repeated co-occurrence)
- Temporal invalidation: new contradicting info sets `invalid_at` on old edge
- Contradiction detection via LLM, routed through proposals queue
- Graph traversal in search (recursive CTE from matched entities)

### Phase 7: Community Detection + Global Search
- Louvain community detection via graphology (JavaScript)
- New tables: `communities`, `entity_communities`
- LLM-generated community summaries with vector embeddings
- Simplified global search: vector match on community embeddings + single LLM call
- Scheduled community refresh (hourly/daily), mark stale when members change
- Community assignments reviewable via proposals queue

### Phase 8: Agent Interface Enhancement
- New MCP tools: `update_entity`, `propose_merge`, `deep_research`
- Query routing: automatic tool selection based on query intent
- Agent persona model (persona + tool access + knowledge scope)
- Dual-level keyword extraction for targeted search
- Research mode: iterative multi-step retrieval for comprehensive briefings

### Phase 9: Permissions + Multi-User
- Visibility scoping (public/private/team) on thoughts
- access_keys with scopes per user/agent
- Selective sharing (promote private → shared)
- Per-agent knowledge scoping

### Phase 10: Infrastructure + Polish
- Cloudflare Tunnel + Zero Trust
- Cross-encoder reranking (evaluate Node.js options or Python sidecar)
- Source-specific chunking templates (meeting transcripts, Slack threads)
- Retry backoff, health checks, structured logging, backup
- Memory history / audit trail (per-entity change tracking)

### Phase 11: Advanced Knowledge Quality
- Fact-level memory dedup (Mem0-style ADD/UPDATE/DELETE lifecycle via proposals)
- Atomic fact extraction from thoughts
- Entity-to-entity relationship population from existing data (backfill)
- Recursive/hierarchical splitting for long documents

### Phase 12: Automation + Calendar
- Scheduled entity monitoring ("alert when anything changes about Company X")
- Calendar integration for proactive briefings
- Meeting prep autopilot
- Action item lifecycle (open/closed/stale)

---

## 4. Project-by-Project Summary

| Project | Stars | Key Pattern Adopted | Key Pattern Rejected |
|---------|-------|--------------------|--------------------|
| **Graphiti** | ~20k | Hybrid retrieval + RRF, temporal edges, bi-temporal model | Neo4j (stay on PG), cloud LLMs, 70B requirement |
| **GraphRAG** | ~30.5k | Community detection, hierarchical summaries, global search | Batch reindexing, Leiden (use Louvain), Parquet storage, map-reduce global (use vector match) |
| **Khoj** | ~33k | Chat context injection, intent detection, query routing, agent personas | Django monolith, built-in chat UI as primary interface |
| **Mem0** | ~48k | Memory lifecycle (ADD/UPDATE/DELETE), fact contradiction detection, audit trail | 26 backend abstractions, cloud LLM default, no HITL |
| **LightRAG** | ~27k | Dual-level keywords, relationship strength, mix-mode retrieval | Full framework (Python, 32B+ needed), no community detection |
| **Haystack** | ~21.5k | Hybrid retrieval + RRF pattern, recursive splitting, warm_up pattern | Framework dependency (Python), YAML pipelines, doc store abstraction |
| **RAGFlow** | ~74k | Source-specific chunking, chunk review UI, RAPTOR hierarchical summaries | Elasticsearch backend, visual pipeline builder, DeepDoc vision |
| **cognee** | ~17k | 15 retrieval strategies (reference), session management | 32B+ requirement, Instructor/BAML structured output dependency |
| **Apache AGE** | ~3k | Cypher queries on PostgreSQL (no new DB) | N/A — utility, not a framework |
| **dedupe** | ~4.5k | ML entity resolution patterns (blocking, clustering) | Python dependency — adopt the patterns for our resolver |

---

## 5. Key Architectural Principles (Confirmed by Research)

1. **Hybrid retrieval is table stakes** — every serious project combines vector + keyword + graph signals
2. **Communities enable global reasoning** — without them, you can't answer "what are the themes?"
3. **Temporal tracking enables fact evolution** — without it, contradictions accumulate silently
4. **HITL is our moat** — no major project has it; LLM errors compound in knowledge graphs
5. **8B viability requires resilient pipelines** — LLM hints + deterministic matching + correction beats structured output dependency
6. **Incremental > batch** — real-time processing with background enrichment beats full reindexing
7. **PostgreSQL can do it all** — pgvector for embeddings, tsvector for BM25, recursive CTEs for graph traversal, regular tables for everything else. No Neo4j needed.
8. **MCP is the right interface** — agents connect to the brain as a service. The brain doesn't embed agent logic.
