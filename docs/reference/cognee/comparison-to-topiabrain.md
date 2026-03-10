# Comparison to TopiaBrain — Gap Analysis & Opportunities

Baseline: `c9370a8b` (2026-03-08)

## On-Prem / Small Model Viability

### Cognee's Local Stack

Cognee supports fully local deployment:
- **LLM:** Ollama (any model)
- **Embeddings:** Ollama (nomic-embed-text, 768 dims) or Fastembed (all-MiniLM-L6-v2, CPU-only)
- **Graph DB:** Kuzu (embedded, no server)
- **Vector DB:** LanceDB (embedded) or pgvector
- **Relational:** SQLite or PostgreSQL

Zero cloud API calls required. Official tutorials exist for Ollama setup.

### Model Size Reality

Testing by Rost Glukhov (glukhov.org) and community reports reveal severe limitations:

| Model Size | Result |
|-----------|--------|
| **8B** (llama3.1:8b) | Unreliable — frequent malformed JSON, noisy graphs, high hallucination |
| **14B** (qwen3:14b, deepseek-r1:14b) | Failed to produce structured output |
| **20B** (gpt-oss:20b) | Malformed structured output with incorrect character codes |
| **24B** (devstral:24b) | Failed to produce structured output |
| **32B+** (deepseek-r1:32b) | Acceptable quality — **minimum recommendation** |
| **70B+** (llama3.3-70b-instruct) | Good quality but heavy compute |
| **120B** (gpt-oss:120b) | Didn't complete processing after 2+ hours |

### Root Cause

The bottleneck is **format compliance, not intelligence**. Cognee relies on Instructor/BAML for structured JSON schema extraction from LLMs. Smaller models can understand content but fail to maintain valid JSON throughout long extraction processes. One malformed field breaks the entire `KnowledgeGraph` schema validation, which breaks the pipeline.

### Sources
- [Rost Glukhov's LLM comparison](https://www.glukhov.org/post/2025/12/selfhosting-cognee-quickstart-llms-comparison/)
- [Cognee GitHub issue #739](https://github.com/topoteretes/cognee/issues/739)
- [Cognee GitHub issue #1812](https://github.com/topoteretes/cognee/issues/1812)
- [Cognee LLM Providers docs](https://docs.cognee.ai/setup-configuration/llm-providers)
- [Cognee Ollama tutorial](https://docs.cognee.ai/tutorials/setup-ollama)
- [DEV Community: Building 100% local AI memory with cognee](https://dev.to/chinmay_bhosale_9ceed796b/cognee-with-ollama-3pp0)

### Why TopiaBrain Is More Resilient

Our pipeline is designed to work **despite** limited model output:

| Challenge | Cognee's Approach | TopiaBrain's Approach |
|-----------|-------------------|----------------------|
| Entity extraction | LLM → structured JSON → graph | LLM → metadata hints → deterministic matching |
| Malformed output | Pipeline fails | JSON.parse fallback, extraction continues |
| Hallucinated entities | Directly inserted into graph | `isJunkEntity()` filter rejects garbage |
| Uncertain matches | Direct graph insertion | Confidence-gated proposals → human review |
| Name variants | Ontology resolver (requires valid extraction first) | `normalizeName()` + alias accumulation + prefix matching |

**Bottom line:** Cognee assumes the LLM produces correct structured output. We assume it doesn't and compensate at every step.

---

## What to Adopt — High Value

### 1. Pluggable Retrieval Strategies

**Cognee:** 15+ retrievers with a common `BaseRetriever` interface.
**TopiaBrain:** Single semantic search strategy.

**Recommendation:** Implement a retriever interface and add:
- **Graph completion** — follow entity links to expand context (uses our entity-thought links)
- **Temporal** — extract time references, use as search filters (uses our `created_at`)
- **Lexical** — BM25/Jaccard for exact term matching (complements embedding search)
- **Chain-of-thought** — multi-iteration refinement for complex queries (chat feature)

**Relevant files:**
- `packages/service/src/mcp/tools/semantic-search.ts` — current single retriever
- `packages/service/src/mcp/tools/get-context.ts` — entity intersection (closest to graph completion)
- See [retrieval.md](retrieval.md) for full strategy catalog

### 2. Ontology Resolver with Fuzzy Matching

**Cognee:** Abstract resolver with `build_lookup`, `find_closest_match`, `get_subgraph`.
**TopiaBrain:** Normalize → canonical match → alias match → prefix match.

**Recommendation:** Add fuzzy matching (difflib equivalent) as a fourth matching tier:
1. Canonical exact match (current)
2. Alias exact match (current)
3. First-name prefix match (current)
4. **Fuzzy match (new)** — catch misspellings in transcripts (e.g., "Cristopher" → "Christopher")

**Relevant files:**
- `packages/service/src/processor/entity-resolver.ts` — add fuzzy matching tier
- See [entity-extraction.md](entity-extraction.md) for cognee's approach

### 3. Temporal-Aware Retrieval

**Cognee:** Extracts time references from queries, queries temporal graph.
**TopiaBrain:** `days_back` filter on semantic_search, `get_timeline` for chronological view.

**Recommendation:** Enhance search to parse temporal expressions:
- "What happened last week with Project X?" → `days_back: 7` + entity filter
- "Before the Q3 review" → date range from entity timeline
- "Recent conversations with Alice" → last 30 days + entity filter

**Relevant files:**
- `packages/service/src/mcp/tools/semantic-search.ts` — add temporal parsing
- `packages/service/src/mcp/tools/get-timeline.ts` — already has chronological data

### 4. Pipeline Task Abstraction

**Cognee:** `Task` class wrapping any callable, DAG composition, batch parallelism.
**TopiaBrain:** Procedural pipeline (chunk → embed → extract → summarize → resolve).

**Recommendation:** Wrap pipeline steps in a common interface for:
- Recomposition (different pipelines for different source types)
- Individual step testing
- Replay failed steps
- Parallel execution of independent steps

**Relevant files:**
- `packages/service/src/processor/pipeline.ts` — refactor target

### 5. Session Management for Chat

**Cognee:** `SessionManager` with (user_id, session_id, qa_id) hierarchy.
**TopiaBrain:** No session management (MCP is stateless).

**Recommendation:** For the chat feature, implement session tracking:
- Store conversation history in PostgreSQL
- Per-user, per-session scoping
- Use conversation context to improve retrieval (what entities were discussed?)
- Node.js equivalent of ContextVar: `AsyncLocalStorage`

### 6. Incremental Processing

**Cognee:** Skip already-processed items, cache pipeline results per dataset.
**TopiaBrain:** Queue dedup via `source_id`, but no pipeline-level caching.

**Recommendation:** Add pipeline result caching for re-processing scenarios:
- When entity resolution rules change, reprocess only affected thoughts
- When embedding model changes, re-embed without re-extracting

---

## Adopt with Modification

### Multi-Backend Storage Abstraction → Interface Only

Don't add LanceDB/Kuzu support. Do abstract our database access behind interfaces for testability:

```typescript
interface VectorSearch {
  search(query: string, options: SearchOptions): Promise<SearchResult[]>;
  embed(text: string): Promise<number[]>;
}

interface EntityStore {
  findByName(name: string, type?: EntityType): Promise<Entity | null>;
  getConnected(entityId: string): Promise<Entity[]>;
}
```

### Graph Completion Retriever → PostgreSQL-Based

Adapt for our stack:
1. Semantic search finds relevant thoughts
2. Query `thought_entities` for linked entities
3. Query `thought_entities` again for those entities' other thoughts
4. Combine and rank
5. (Phase 10) Also traverse `entity_relationships`

### Chain-of-Thought Retriever → Local Ollama

Use with llama3.1:8b instead of cloud LLMs:
- Fewer iterations (2 instead of 4) due to model limitations
- Simpler refinement prompts optimized for 8B
- Only for "deep search" in chat, not default

---

## Skip — Not Needed

| Feature | Why Skip |
|---------|----------|
| Cloud LLM dependency | Violates data sovereignty |
| Neo4j/Kuzu/LanceDB | Committed to PostgreSQL + pgvector |
| React frontend | We use plain HTML + vanilla JS |
| S3 storage backend | On-prem only |
| Pydantic ORM layer | Direct SQL is fine for our scale |
| Instructor/BAML structured output | Our explicit prompts work better with 8B |
| RDFLib ontology files | Entity type enum is sufficient |
| Multi-backend vector search | pgvector is our only backend |
| Full RBAC | Simpler visibility scoping planned |

---

## TopiaBrain Advantages to Preserve

These are things we do that cognee doesn't. Do not regress on these:

### 1. HITL Approvals Queue
Cognee has nothing comparable. Our confidence-gated proposal system catches errors that their pipeline would silently commit to the graph. This is our biggest architectural advantage for small model operation.

### 2. Data Sovereignty
Fully on-prem by design, not as an afterthought. Cognee supports local deployment but defaults to cloud.

### 3. Source-Specific Integrations
Slack, Telegram, Fathom — each with proper webhook verification and source-aware processing. Cognee has generic data ingestion but no source-specific integrations.

### 4. Confidence-Gated Proposals
Operations below confidence threshold create reviewable proposals. Entity links, enrichments, and merges all go through this system. Cognee inserts directly into the graph with no quality gate.

### 5. Entity Alias Accumulation
First-name prefix matching + alias accumulation over time. "Chris" → "Christopher Lee" with accumulated aliases. Cognee's fuzzy matching is one-shot — no alias building.

### 6. Junk Entity Filtering
`isJunkEntity()` blocks garbage before it enters the database. Cognee relies on the LLM to not hallucinate entities — which fails with small models.

---

## Priority Adoption Roadmap

Based on value and effort, recommended order:

| Priority | Feature | Effort | Value | Relevant Phase |
|----------|---------|--------|-------|----------------|
| 1 | Session management | Medium | High | Chat (new phase) |
| 2 | Graph completion retriever | Medium | High | Phase 10 (entity relationships) |
| 3 | Temporal retrieval enhancement | Low | Medium | Phase 9 (context diff) |
| 4 | Fuzzy matching tier | Low | Medium | Standalone improvement |
| 5 | Lexical retriever (BM25) | Medium | Medium | Search enhancement |
| 6 | Pipeline task abstraction | High | Medium | Refactoring |
| 7 | Retriever auto-selection | Medium | Medium | Chat feature |
| 8 | Chain-of-thought retriever | High | High | Chat "deep search" |
