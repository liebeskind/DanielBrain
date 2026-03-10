# Graphiti vs. TopiaBrain Comparison

## System Overview

| Aspect | Graphiti | TopiaBrain |
|--------|----------|------------|
| **Type** | Temporal knowledge graph framework | Database-backed personal knowledge system |
| **Storage** | Neo4j (or FalkorDB/Kuzu/Neptune) | PostgreSQL + pgvector |
| **LLM** | Cloud APIs (OpenAI/Anthropic) or 70B+ local | Ollama llama3.1:8b (on-prem mandatory) |
| **Embeddings** | OpenAI (default) or pluggable | nomic-embed-text via Ollama |
| **Language** | Python (async) | TypeScript (Node.js) |
| **Graph model** | Native graph DB with Cypher | Relational with junction tables |

---

## What TopiaBrain Has That Graphiti Doesn't

### 1. Human-in-the-Loop (HITL) Quality Control
TopiaBrain's proposals/approvals queue is a significant differentiator. Graphiti has zero HITL -- every LLM decision is auto-applied. TopiaBrain's confidence-gated system:
- Auto-applies high-confidence operations + creates reviewable proposals
- Holds high-risk operations (entity merge, LinkedIn enrichment) for human approval
- Supports reject/needs-changes workflows with reviewer hints
- Admin dashboard for review

This matters because LLM extraction errors compound in a knowledge graph. Graphiti relies entirely on LLM quality; TopiaBrain provides a correction mechanism.

### 2. Data Sovereignty (Mandatory On-Prem)
TopiaBrain enforces all inference on-prem on DGX Spark. Graphiti defaults to cloud APIs and explicitly warns against small models. TopiaBrain's prompts are tuned for 8B models.

### 3. Multi-Source Ingestion Channels
- Slack webhook with signature verification
- Telegram webhook
- Fathom meeting transcript integration
- MCP save_thought tool

Graphiti provides generic `add_episode()` API but no built-in webhooks for specific services.

### 4. Entity Enrichment Pipeline
- LinkedIn enricher via SerpAPI (background poller)
- Entity profiles with LLM-generated summaries + vector embeddings
- Staleness tracking (refresh after N mentions or N days)

Graphiti has entity summaries but no external enrichment pipeline.

### 5. Thought-Centric Model
TopiaBrain's "thoughts" are richer than Graphiti's episodes:
- `thought_type` classification (note, meeting, action_item, decision, etc.)
- `source_meta` with structured data (speaker, channel, raw meeting data)
- Summary generation for long content
- Child chunks with individual embeddings for long documents

---

## What Graphiti Has That TopiaBrain Lacks

### 1. Temporal Edge Invalidation (Critical Gap)
Graphiti's biggest advantage. When new information contradicts old information:
- Old edges get `expired_at` + `invalid_at` set (not deleted)
- Full history preserved for point-in-time queries
- LLM-based contradiction detection

**TopiaBrain gap**: No mechanism to mark old information as superseded. If "Alice works at Acme" is followed by "Alice joined Beta Corp", both remain as separate thoughts with no invalidation link.

**Adoption path**: Add `valid_at`, `invalid_at`, `expired_at` fields to thought_entities junction table. Implement contradiction detection in the processing pipeline (could use LLM or simpler heuristics).

### 2. Hybrid Retrieval with RRF (Critical Gap)
Graphiti combines three search signals:
- Cosine similarity (semantic)
- BM25 (keyword/full-text)
- BFS graph traversal

Combined via Reciprocal Rank Fusion. TopiaBrain uses cosine similarity only.

**Adoption path**:
- Add PostgreSQL full-text search (tsvector/tsquery) alongside pgvector -- relatively easy
- Implement RRF to combine cosine + BM25 scores -- straightforward math
- Graph traversal via recursive CTEs on thought_entities -- moderate effort
- This is the highest-value improvement for retrieval quality

### 3. Bi-Temporal Data Model
Four timestamps per relationship vs. TopiaBrain's simple `created_at` on thoughts.

**Adoption path**: Add `valid_at`, `invalid_at` to thought_entities table. `created_at` already exists. Add `expired_at` for system-level invalidation.

### 4. Community Detection
Label propagation clustering + LLM-generated community summaries for hierarchical reasoning.

**TopiaBrain gap**: No community/topic clustering. Entity types exist but no automatic grouping.

**Adoption path**: Implement label propagation on the entity relationship graph. Generate community summaries. This enables "broad" queries ("What's happening in sales?") that span many entities.

### 5. Formal Edge/Relationship Types
Graphiti extracts typed relationships (WORKS_AT, MANAGES, FOUNDED) with LLM-generated fact descriptions. Each edge is a first-class semantic object with its own embedding.

**TopiaBrain**: Has relationship types on thought_entities (mentions, about, from, assigned_to, created_by) but these are coarser. No per-relationship fact text or embedding.

**Adoption path**: Add `fact` text field and `fact_embedding` vector to thought_entities. Extract relationship descriptions during processing.

### 6. Custom Entity/Edge Type Schemas
Graphiti supports developer-defined Pydantic models for entity and edge types, with custom attributes extracted from text.

**TopiaBrain**: Fixed entity_type enum (person, company, topic, product, project, place). No custom attributes per type.

### 7. Saga/Narrative Chaining
Graphiti links episodes into sequential chains (sagas) for tracking conversation threads or meeting series.

**TopiaBrain**: No explicit saga concept, though thoughts have `source_meta` that could group by conversation.

---

## Adoption Roadmap: What To Take From Graphiti

### Priority 1: Hybrid Retrieval (High value, moderate effort)
1. Add PostgreSQL full-text search indexes on thoughts.content and thoughts.summary
2. Implement BM25 scoring via `ts_rank()` or `ts_rank_cd()`
3. Implement RRF to combine cosine similarity + BM25 results
4. Estimated effort: 1-2 days

### Priority 2: Temporal Edge Tracking (High value, moderate effort)
1. Add `valid_at`, `invalid_at`, `expired_at` to thought_entities
2. Add simple contradiction detection during entity resolution (same entity pair, same relationship type, new fact)
3. Estimated effort: 2-3 days (migration + pipeline changes)

### Priority 3: Fact-Level Edges (Medium value, moderate effort)
1. Add `fact` text and `fact_embedding` vector to thought_entities
2. Extract relationship descriptions during pipeline processing
3. Enable search over relationships (not just thoughts)
4. Estimated effort: 2-3 days

### Priority 4: Community Detection (Medium value, higher effort)
1. Implement label propagation on entity graph
2. Store community assignments and summaries
3. Enable hierarchical retrieval
4. Estimated effort: 3-5 days

### Do NOT Adopt
- **Neo4j dependency**: PostgreSQL + pgvector is sufficient for our scale. Adding Neo4j doubles infrastructure complexity.
- **Cloud LLM requirement**: Graphiti's prompt complexity requires 70B+ models. Keep TopiaBrain's 8B-optimized prompts.
- **Full Graphiti framework**: Too tightly coupled to its graph DB assumptions. Better to adopt patterns selectively.

---

## Key Insight

Graphiti and TopiaBrain solve the same problem (persistent memory for AI agents) from different starting points:

- **Graphiti**: Sophisticated graph algorithms, assumes powerful LLMs, no HITL
- **TopiaBrain**: Pragmatic extraction, works with small models, HITL quality control

The best system combines both: TopiaBrain's HITL proposals queue + pragmatic on-prem extraction, enhanced with Graphiti's hybrid retrieval (RRF), temporal invalidation, and community detection patterns. The proposals queue actually becomes MORE valuable as we add more sophisticated features, because each new LLM-driven operation is another place where quality control matters.
