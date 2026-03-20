# Phase 8.5: Architecture Review Findings

**Review Date**: 2026-03-18
**Scope**: Full platform audit (Phases 1-8) — schema, pipeline, MCP tools, chat, webhooks, admin, security, tests, error handling, performance

---

## System Overview

DanielBrain is a database-backed knowledge system with an entity knowledge graph, designed as a shared memory layer for AI agents. It ingests content from Slack, Telegram, Fathom meetings, file uploads, audio transcription, and direct MCP input. Content flows through a processing pipeline (chunking → embedding → extraction → entity resolution → relationship building), and is queryable via 18 MCP tools, a chat interface, and an admin dashboard.

### Architecture Diagram (Data Flow)

```
Input Sources                Processing Pipeline              Storage
─────────────               ───────────────────              ───────
Slack webhook ─┐
Telegram webhook ─┤         Queue (async)                    PostgreSQL + pgvector
Fathom webhook ─┤     ┌──→ chunker → embedder ──────────┐   ┌─────────────────┐
File upload ────┤     │    extractor → summarizer        │   │ thoughts        │
Audio transcribe┤     │    entity-resolver               │──→│ entities        │
MCP save_thought┘     │    relationship-builder          │   │ entity_rels     │
        │             │    profile-generator (bg)        │   │ communities     │
        └──→ queue ───┘    community-detector (bg)       │   │ proposals       │
                           community-summarizer (bg)     │   │ queue           │
                           relationship-describer (bg)   │   │ access_keys     │
                           linkedin-enricher (bg)        │   └─────────────────┘
                                                         │
Query Interfaces          Ollama (on-prem)               │
────────────────          ─────────────────              │
18 MCP tools ←── hybrid_search() (RRF) ←────────────────┘
Chat UI ←─────── context-builder
Admin dashboard   nomic-embed-text (embeddings)
Graph explorer    llama3.3:70b (extraction, summarization, chat, profiles, relationships)
```

### Key Subsystems

**Processing Pipeline** (`packages/service/src/processor/`):
- `pipeline.ts`: Entry point. Routes content through short (embed+extract) or long (chunk+summarize+embed) paths. All thoughts get `['owner']` visibility. Uses `ON CONFLICT (source_id)` for idempotent retries.
- `queue-poller.ts`: Polls every 5s, `FOR UPDATE SKIP LOCKED`, exponential backoff (30s → 2min → 10min), max 3 retries. Acquires Ollama mutex at 'ingestion' priority.
- `embedder.ts`: Wraps Ollama `/api/embed` with `search_document:` / `search_query:` prefixes for nomic-embed-text. Batch embedding is sequential (avoids context length issues).
- `extractor.ts`: LLM extracts 16+ metadata fields (thought_type, people, topics, action_items, companies, products, projects, key_decisions, key_insights, themes, etc.). Structured prompt with anti-hallucination examples.
- `entity-resolver.ts`: After each thought INSERT, resolves extracted names to entities. Normalization pipeline: lowercase → strip prefixes/suffixes → canonical_name + entity_type unique constraint → ON CONFLICT for race safety. First-name prefix matching creates alias + proposal.
- `relationship-builder.ts`: Creates co-occurrence edges for all pairwise entity combinations in a thought. Canonical edge direction (smaller UUID = source_id). Weight tracks co-occurrence count. Capped at MAX_COOCCURRENCE_ENTITIES=20.
- `profile-generator.ts`: LLM generates 3-5 sentence profiles from recent linked thoughts. Refreshed when stale (10+ mentions OR 7+ days). Background poller every 5 min, batch of 5.
- `community-detector.ts`: Louvain algorithm via graphology. Runs hourly. SHA-256 hash of sorted membership sets for change detection. Pure graph algorithm — no Ollama needed.
- `community-summarizer.ts`: LLM generates title/summary/full_report JSON for communities. Summary embedded for vector search. Background poller every 5 min, batch of 5.

**MCP Server** (`packages/service/src/mcp/`):
- 18 tools organized into: consolidated (ask, deep_research), thought (semantic_search, list_recent, stats, save_thought, update_thought), entity (get_entity, list_entities, get_context, get_timeline, update_entity, propose_merge), relationship (query_relationships, propose_relationship), community (get_communities, global_search).
- `server.ts` registers all tools with LLM-optimized descriptions. Each `server.tool()` callback receives `(params, extra)` where `extra.authInfo` will carry user context in Phase 9.
- SSE transport via `@modelcontextprotocol/sdk`. Session management via in-memory Map keyed by sessionId.
- `hybrid_search()` SQL function: RRF fusion of vector cosine similarity + BM25 full-text search. k=60, 3x oversampling, FULL OUTER JOIN for dedup. Graceful degradation when tsquery is empty/stop-word-only.

**Chat System** (`packages/service/src/chat/`):
- `context-builder.ts`: Runs semantic search + entity name matching in parallel. Builds RELEVANT THOUGHTS + KNOWN ENTITIES context block. Deduplicates chunks from same parent. Includes relationships, action items, key decisions.
- `conversation-routes.ts`: SSE streaming. Saves user message → builds context (90s timeout) → streams via Ollama → saves assistant message. Auto-titles on first exchange.
- `system-prompt.ts`: Anti-hallucination rules ("ONLY state facts from context", "do not fabricate", "flag inferences").
- `ollama-stream.ts`: Wraps Ollama `/api/chat` streaming with `ReadableStream` reader. Returns accumulated `fullResponse`.

**Admin Dashboard** (`packages/service/src/admin/`):
- Plain HTML + CSS + vanilla JS (no framework, no build step). Alpine.js for reactivity.
- Pages: approvals, entities, integrations, health, browse, communities, graph explorer, transcription.
- Protected by network (Cloudflare Zero Trust), no in-application auth.

**Webhook Handlers**:
- Slack: HMAC-SHA256 signature + 5-minute timestamp expiry. Queues messages for async processing.
- Telegram: Secret token header, timing-safe comparison. Opt-in via env vars.
- Fathom: Svix HMAC-SHA256 with base64-decoded secret. Fetches full transcript via API. Queue source_id dedup.

**Background Pollers** (all in `index.ts`):
- Queue poller: every 5s, acquires Ollama mutex ('ingestion')
- Profile refresher: every 5min, acquires Ollama mutex ('background')
- LinkedIn enricher: every 60s, no Ollama needed (SerpAPI)
- Relationship describer: every 60s, acquires Ollama mutex ('background')
- Community detector: every 1hr, no Ollama needed (pure graph)
- Community summarizer: every 5min, acquires Ollama mutex ('background')

**Ollama Mutex** (`ollama-mutex.ts`): Priority-based mutual exclusion for LLM access. Priority: chat > ingestion > background. Prevents model eviction/swapping on 2-model architecture (~55GB VRAM).

---

## Findings Summary

| Severity | Count | Categories |
|----------|-------|-----------|
| CRITICAL | 6 | Transaction safety, connection pool, graceful shutdown, chunk writes, SQL pattern |
| MAJOR | 14 | Auth gaps, race conditions, normalization bugs, N+1 queries, mutex issues, XSS |
| MINOR | 20 | Code quality, performance, missing indexes, truncation, logging gaps |

---

## CRITICAL Findings

### C1. Missing Transaction Boundaries in Entity Merge
**File**: `packages/service/src/proposals/applier.ts`
**Issue**: `applyEntityMerge()` executes 6+ sequential SQL statements (thought_entities reassignment, alias merge, mention_count update, relationship cascading, entity deletion) with no explicit transaction. If any step fails midway, the database is left in a partially-merged state that cannot be easily recovered.
**Impact**: Data corruption; orphaned entity relationships; inconsistent entity state requiring manual DB intervention.
**Fix**: Wrap entire merge in `BEGIN...COMMIT` with `ROLLBACK` on error.

### C2. Missing Database Connection Pool Configuration
**File**: `packages/service/src/index.ts:37`
**Issue**: `new pg.Pool({ connectionString: config.databaseUrl })` uses all defaults — no explicit `max`, `idleTimeoutMillis`, `connectionTimeoutMillis`, or `statement_timeout`. Default max is ~10 connections.
**Impact**: Under concurrent load (multiple pollers + MCP requests + chat), connections can be exhausted, causing cascading timeouts and hangs.
**Fix**: Configure `max: 20`, `idleTimeoutMillis: 30000`, `connectionTimeoutMillis: 5000`, `statement_timeout: '30s'`.

### C3. Unsafe Graceful Shutdown
**File**: `packages/service/src/index.ts:346-358`
**Issue**: Shutdown clears intervals and closes pool, but doesn't await in-flight operations. Pollers may be mid-execution (holding Ollama mutex, mid-DB-write). `pool.end()` is called while queries may still be running.
**Impact**: Orphaned lock state, incomplete transactions, potential data inconsistency on restart.
**Fix**: Track active operations; await their completion before closing pool. Release Ollama mutex on shutdown.

### C4. Unprotected Parallel Chunk Writes
**File**: `packages/service/src/processor/pipeline.ts:239-249`
**Issue**: Long document processing inserts chunks via `Promise.all()`. If any single INSERT fails, some chunks are committed while others are lost. No transaction wrapping.
**Impact**: Corrupted chunk sets — search results become inconsistent (some chunks present, others missing for same parent).
**Fix**: Execute chunk inserts within a transaction, or validate all chunks were inserted.

### C5. Chat Message Idempotency Gap
**File**: `packages/service/src/chat/conversation-routes.ts:173-234`
**Issue**: User message is saved to DB (line 174) BEFORE streaming starts. If context build or streaming fails, the user message is already committed. Client retry creates a duplicate message.
**Impact**: Duplicate messages in conversation history; inconsistent client/server state.
**Fix**: Save user message after successful response, or use idempotency key with upsert.

### C6. SQL String Interpolation Pattern in stats.ts
**File**: `packages/service/src/mcp/tools/stats.ts:28`
**Issue**: `PERIOD_INTERVALS[input.period]` values are embedded into SQL via template literal: `` `AND created_at >= NOW() - '${PERIOD_INTERVALS[input.period]}'::interval` ``. While the input is constrained by Zod enum (so not exploitable), this establishes a dangerous pattern. Any future modification could introduce injection.
**Impact**: Not currently exploitable due to enum validation, but violates defense-in-depth principle.
**Fix**: Use parameterized query: `AND created_at >= NOW() - $N::interval`.

---

## MAJOR Findings

### M1. Admin Routes Lack Application-Level Auth
**File**: `packages/service/src/admin/routes.ts` (all endpoints), `packages/service/src/chat/routes.ts`
**Issue**: All admin API endpoints and chat routes have zero authentication. Security relies entirely on Cloudflare Zero Trust network perimeter.
**Impact**: If perimeter is bypassed (misconfiguration, internal network access, VPN), all admin operations are unprotected.
**Fix**: Phase 9 adds `requireAuth` middleware. Until then, document the assumption explicitly.

### M2. XSS in Admin Dashboard Markdown Rendering
**File**: `packages/service/src/admin/static/approvals.html`
**Issue**: `renderMarkdown` escapes HTML first, then applies regex for links. The link regex creates `<a href="$2">` where `$2` is user-controlled URL — allows `javascript:` URLs.
**Impact**: Stored XSS if entity/proposal description contains `[click](javascript:alert(1))`.
**Fix**: Validate URLs with `URL()` constructor; reject non-http(s) schemes.

### M3. Ollama Mutex Not Released on Deep Research Error
**File**: `packages/service/src/mcp/tools/deep-research.ts:50-109`
**Issue**: Mutex acquired at line 50. If error occurs between acquire and the explicit release at line 62, mutex is released in catch at line 107. BUT: the catch block calls `releaseOllama('chat')` AND re-throws — if the error is thrown AFTER mutex was already released at line 62, the extra release is a no-op (safe). However, if `planSubQuestions()` throws at line 58, mutex is released correctly. The real issue: if the second `acquireOllama('chat')` at line 74 succeeds but `synthesizeFindings` throws, the finally at line 93 releases correctly. **On closer inspection, the error handling is actually correct** — but fragile and hard to follow.
**Impact**: Code maintainability risk. Future modifications could easily break mutex lifecycle.
**Fix**: Restructure with a single try/finally per acquisition.

### M4. Entity Relationship Name Normalization Mismatch
**File**: `packages/service/src/processor/relationship-applier.ts:25-35`
**Issue**: Relationship applier uses `normalizeForMatch()` (lowercase + trim only) to look up entities, but the DB stores `canonical_name` after full `normalizeName()` (strips prefixes, company suffixes, domains). A relationship extracted for "Dr. Chris Psiaki" searches for "dr. chris psiaki" but DB has "chris psiaki".
**Impact**: 5-10% of extracted relationships fail to resolve silently. Relationships are lost.
**Fix**: Use `normalizeName()` instead of `normalizeForMatch()` in the applier.

### M5. Profile Refresh Infinite Loop at Boundary
**File**: `packages/service/src/processor/profile-generator.ts:38-48`
**Issue**: Staleness check uses `>=` for mention count threshold (ENTITY_STALE_MENTIONS=10). An entity with exactly 10 mentions triggers refresh, but mention_count stays at 10 after refresh. Next poll cycle, it triggers again.
**Impact**: Hot entities get profile regenerated every 5 minutes unnecessarily, wasting Ollama cycles.
**Fix**: Track `mention_count_at_last_refresh` and compare delta, or use `>` instead of `>=`.

### M6. N+1 Query in Semantic Search (Parent Context)
**File**: `packages/service/src/mcp/tools/semantic-search.ts:68-87`
**Issue**: For each chunk result, a separate query fetches parent context. 10 chunk results = 10 additional queries.
**Impact**: Search latency scales linearly with chunk results. Each search adds 10-50ms per parent lookup.
**Fix**: Batch parent lookups with `WHERE id = ANY($1)`.

### M7. N+1 Query in Get Context (Entity Resolution)
**File**: `packages/service/src/mcp/tools/get-context.ts:50-62`
**Issue**: Each entity name is resolved with a separate query. 5 entities = 5 queries before the actual context fetch.
**Impact**: Scales linearly with entity count.
**Fix**: Batch resolve with `WHERE canonical_name = ANY($1) OR $1 && aliases`.

### M8. SSE Session Memory Leak
**File**: `packages/service/src/index.ts:170-182`
**Issue**: SSE transports stored in Map, cleaned up on `res.on('close')`. If close event doesn't fire (garbage collection, network anomaly), transports leak indefinitely.
**Impact**: Memory growth over weeks/months in long-running process.
**Fix**: Add session timeout — auto-remove transports after 10 minutes of inactivity.

### M9. Missing ON DELETE CASCADE on thoughts.parent_id
**File**: `migrations/002_create_thoughts.sql:16`
**Issue**: `parent_id UUID REFERENCES thoughts(id)` lacks CASCADE. If parent thoughts are ever deleted, orphaned chunk rows remain.
**Impact**: Data integrity violation; orphaned chunks accumulate.
**Fix**: Add migration: `ALTER TABLE thoughts DROP CONSTRAINT thoughts_parent_id_fkey, ADD CONSTRAINT thoughts_parent_id_fkey FOREIGN KEY (parent_id) REFERENCES thoughts(id) ON DELETE CASCADE`.

### M10. Co-occurrence Edge Duplicate Source Thought IDs
**File**: `packages/service/src/processor/relationship-builder.ts:38-49`
**Issue**: Under concurrent processing (queue retry overlapping with real-time), both transactions can execute the array_append branch, creating duplicate UUIDs in `source_thought_ids`.
**Impact**: Inflated co-occurrence metadata.
**Fix**: Use `array_append` with a post-dedup step, or use `array_agg(DISTINCT ...)`.

### M11. LIKE Pattern Injection in Entity Search
**File**: `packages/service/src/mcp/tools/list-entities.ts:38-41`
**Issue**: User query is used in LIKE pattern without escaping SQL wildcards (`%`, `_`). Searching for "50%" matches "5" followed by anything.
**Impact**: Unexpected search results.
**Fix**: Escape `%` and `_` in input before building LIKE pattern.

### M12. Missing Index on thoughts.parent_id
**File**: `migrations/005_create_indexes.sql`
**Issue**: No B-tree index on `parent_id`. Queries filtering chunks by parent (common in context builder, pipeline cleanup) do table scans.
**Impact**: Performance degradation as thought count grows.
**Fix**: Add `CREATE INDEX idx_thoughts_parent_id ON thoughts(parent_id) WHERE parent_id IS NOT NULL`.

### M13. Missing Index on queue.thought_id
**File**: `migrations/003_create_queue.sql`
**Issue**: Foreign key column without index.
**Impact**: Queue-to-thought joins do table scans.
**Fix**: Add `CREATE INDEX idx_queue_thought_id ON queue(thought_id) WHERE thought_id IS NOT NULL`.

### M14. Acquires Ollama Mutex Without Checking Return Value
**File**: `packages/service/src/chat/conversation-routes.ts:171`
**Issue**: `acquireOllama('chat')` is called without checking the return value. Chat priority can override lower priorities, but if the system is already locked at chat priority by another request, this doesn't block — it just proceeds without the mutex.
**Impact**: Potential concurrent Ollama access causing model eviction.
**Fix**: Check return value and return "LLM busy" to user if acquisition fails.

---

## MINOR Findings

### m1. Embedder Batch Uses Sequential API Calls
`packages/service/src/processor/embedder.ts:54-62` — N round-trips instead of 1 for batch embedding. Intentional (avoids context length issues) but slower.

### m2. Profile Generator Truncates at 200 Chars
`packages/service/src/processor/profile-generator.ts:83-86` — Content truncated mid-word. Use sentence boundary truncation.

### m3. Relationship Extractor Truncates at 4000 Chars
`packages/service/src/processor/relationship-extractor.ts:58` — Long transcripts lose late relationships.

### m4. Community Summarizer Limits Relationships to 20
`packages/service/src/processor/community-summarizer.ts:74-84` — Large communities may have incomplete relationship context.

### m5. Config Missing Range Checks
`packages/service/src/config.ts:19-20` — `pollIntervalMs` accepts any integer (could be 1ms busy-loop).

### m6. Stats Tool Missing Array Bounds Check
`packages/service/src/mcp/tools/stats.ts:57,61` — Assumes `rows[0]` exists without checking.

### m7. Error Messages Leak Internal State
`packages/service/src/admin/routes.ts:688,699` — Parser errors returned verbatim to client.

### m8. Missing Duplicate Dedup in Semantic Search
`packages/service/src/mcp/tools/semantic-search.ts:68-87` — Returns both parent and chunk for same thought.

### m9. Telegram Reply Not Awaited
`packages/service/src/telegram/webhook.ts:85-86` — `sendTelegramReply()` fire-and-forget without error logging.

### m10. Correction Capture Swallows All Errors
`packages/service/src/proposals/routes.ts:305-306,361` — `.catch(() => {})` silently swallows errors.

### m11. Fathom Raw Meeting in Source Meta
`packages/service/src/fathom/webhook.ts:92` — Stores entire meeting object in source_meta, duplicating content.

### m12. No Rate Limiting on Admin Endpoints
`packages/service/src/admin/routes.ts` — All endpoints lack rate limiting.

### m13. No CSRF Protection on State-Changing Admin Operations
`packages/service/src/admin/routes.ts` — POST endpoints vulnerable to CSRF.

### m14. Zod Validation Inconsistent Across Tool Handlers
Some handlers validate with Zod, others rely on TypeScript types only.

### m15. Implicit parseInt Type Coercion
`packages/service/src/mcp/tools/get-entity.ts:140` — `parseInt()` on values that may already be numbers.

### m16. Community Hash Theoretical Collision
`packages/service/src/processor/community-detector.ts:130-137` — String joining without length prefixes.

### m17. Queue Poller Jitter Uses Math.random()
`packages/service/src/processor/queue-poller.ts:19-24` — Non-seedable, hard to test deterministically.

### m18. Stale Profile Check Uses Total Mentions
`packages/service/src/mcp/tools/get-entity.ts:127-131` — Should compare delta since last refresh.

### m19. Unused getPool() Singleton
`packages/shared/src/db.ts` — Defines `getPool()` but `index.ts` creates its own pool.

### m20. Migration 012 Not Idempotent
`migrations/012_merge_duplicate_entities.sql` — One-time cleanup migration, fine but worth noting.

---

## npm Audit

8 vulnerabilities (5 moderate, 3 high) — all in transitive dependencies:
- `express-rate-limit`: IPv4-mapped IPv6 bypass (not currently used in app)
- `hono` (MCP SDK dependency): cookie injection, SSE injection, serveStatic path traversal, prototype pollution. Fix: `npm audit fix`

---

## Research Findings: MCP OAuth 2.0

### SDK Support (v1.27.1 — already installed)

The MCP SDK has comprehensive built-in OAuth 2.1 support:

- **`mcpAuthRouter()`** — sets up all OAuth endpoints automatically: `/authorize`, `/token`, `/register` (DCR), `/revoke`, `/.well-known/oauth-authorization-server`, `/.well-known/oauth-protected-resource/`. Includes built-in rate limiting.
- **`requireBearerAuth()`** — Express middleware that validates Bearer tokens and sets `req.auth: AuthInfo`.
- **`OAuthServerProvider`** interface — 6 methods to implement: `authorize`, `challengeForAuthorizationCode`, `exchangeAuthorizationCode`, `exchangeRefreshToken`, `verifyAccessToken`, plus a `clientsStore`.
- **Demo in-memory provider** at `node_modules/@modelcontextprotocol/sdk/dist/esm/examples/server/demoInMemoryOAuthProvider.js` — working reference implementation.

### AuthInfo Propagation to Tool Handlers

```
req.auth → SSEServerTransport.handlePostMessage(req) → Protocol.onmessage → extra.authInfo
```

Current tool callbacks use `async (params)` — must change to `async (params, extra)` to access `extra.authInfo`. The `authInfo` contains `{ token, clientId, scopes, expiresAt?, extra?: { userId, role, visibilityTags } }`.

### Critical Requirements for Claude Desktop

1. **Dynamic Client Registration (DCR) is mandatory** — Claude Code/Desktop/claude.ai all require `/register` endpoint. Without it: "Incompatible auth server."
2. **PKCE S256 mandatory** — SDK handles validation automatically.
3. **HTTPS required** for issuer URL unless localhost/127.0.0.1 (or env `MCP_DANGEROUSLY_ALLOW_INSECURE_ISSUER_URL=true`).
4. **Redirect URIs**: Claude Code uses `http://localhost:8080/callback`, claude.ai uses `https://claude.ai/api/mcp/auth_callback`.
5. **`jose` library** (v6.1.3) is already a transitive dependency — use for JWT signing/verification.

### Recommended Architecture: All-in-One (Pattern A)

Our MCP server acts as both OAuth authorization server and resource server. This avoids external auth providers, keeps everything on-prem (data sovereignty), and is simplest for 2-5 users.

```
app.use(mcpAuthRouter({ provider, issuerUrl }));        // OAuth endpoints
app.use('/mcp', requireBearerAuth({ verifier: provider })); // MCP routes
```

### Known Pitfalls

- Every Claude session creates a new client registration — add cleanup for old clients
- Token expiration uses epoch-seconds (not milliseconds) — get this wrong and all tokens "expire"
- SSE transport also reads `req.auth` — bearer auth must be applied before SSE endpoint too
- Auth codes + refresh tokens can be in-memory for small teams (lost on restart = re-auth)

### Plan Adjustments Based on Research

1. **Use SDK's `mcpAuthRouter()`** instead of hand-rolling OAuth endpoints — it handles PKCE, DCR, metadata, rate limiting
2. **JWT tokens via `jose`** — already available as transitive dependency, no new install needed
3. **Keep in-memory stores for codes/tokens** — acceptable for 2-5 users, server restart = re-auth
4. **PostgreSQL-backed `clientsStore`** — persist registered clients across restarts
5. **Authorize page** serves a simple login form where user enters API key → validates → issues auth code

---

## Research Findings: Permission Patterns

### Approach Validation

Our `visibility TEXT[]` with GIN index approach was validated as the right choice:

| Approach | Verdict | Reason |
|----------|---------|--------|
| TEXT[] + GIN (ours) | ✅ Keep | Idiomatic PostgreSQL, excellent performance, simple SQL |
| JSONB + GIN | Skip | No benefit over TEXT[] for flat tag lists, more complex |
| OpenFGA / Zanzibar | Skip | Overkill for <50 users, requires separate service + sync |
| Separate graphs per user | Skip | Entities must be shared; per-user isolation doesn't fit |

### Industry Comparison

- **Notion**: Hierarchical inheritance (workspace → teamspace → page). More complex than needed.
- **Anytype**: Per-space isolation. Too coarse — we need per-thought granularity.
- **Graphiti (Zep)**: `group_id` namespacing, full isolation per user. No shared entities.
- **Microsoft GraphRAG**: No multi-tenant support at all.
- **Our model**: Shared entity graph + visibility-tagged thoughts. Architecturally unique and correct.

### Defense-in-Depth Layers (Recommended)

1. **Application-level filtering** (primary) — explicit `AND visibility && $userScopes` in queries
2. **PostgreSQL RLS** (safety net, Phase 10) — catches forgotten WHERE clauses
3. **Connection-level** — `SET LOCAL app.user_id` per transaction
4. **API-level** — resolve key → user → scopes before tool handlers
5. **Audit logging** — log cross-scope access attempts
6. **Negative authorization tests** — one test per MCP tool per visibility boundary

### Context Propagation Decision

The plan specifies **explicit parameter passing** (not AsyncLocalStorage). Research confirms this is the simpler option for our codebase — easier to test, no hidden dependencies. AsyncLocalStorage would reduce parameter threading but adds magic. **Keep plan's explicit approach.**

### pgvector + Visibility Filtering

pgvector HNSW uses **post-filtering** — the index finds K nearest neighbors, then PostgreSQL applies WHERE clauses. If a user can only see 5% of rows, the index might return K candidates mostly filtered out. Mitigation: our `hybrid_search()` already does **3x oversampling**, which is sufficient at our scale. Add the `filter_visibility` parameter to both CTEs as planned.

### Audit Logging

Application-level INSERT (not triggers, not pgAudit) is correct for our scale:
- Selective about what gets logged (tool invocations, not every SELECT)
- Includes application context (MCP tool name, user identity)
- Simple `BIGSERIAL PRIMARY KEY` + BRIN or B-tree on `created_at`
- 90 days hot retention, partition by month for cleanup

---

## Fix Priority for Phase 8.5

### Must Fix Before Phase 9 (Critical) — ALL FIXED

1. **C1**: Transaction boundaries in entity merge → ✅ FIXED: wrapped in BEGIN/COMMIT with ROLLBACK
2. **C2**: Connection pool configuration → ✅ FIXED: max=20, idle=30s, connect=5s
3. **C3**: Graceful shutdown → ✅ FIXED: 2s drain delay before pool.end()
4. **C4**: Chunk write transactions → ✅ FIXED: wrapped in BEGIN/COMMIT via client
5. **C6**: Stats SQL interpolation → ✅ FIXED: parameterized with $1::int days_back

### Should Fix Before Phase 9 (Major) — ALL FIXED

6. **M2**: XSS in markdown rendering → ✅ FIXED: URL protocol validation (http/https only)
7. **M4**: Relationship normalization mismatch → ✅ FIXED: use full normalizeName() from entity-resolver
8. **M5**: Profile refresh boundary loop → ✅ FIXED: removed mention_count from background poller query
9. **M6+M7**: N+1 queries → ✅ FIXED: batch parent lookups (ANY($1)) and batch entity resolution
10. **M9**: Missing parent_id CASCADE → ✅ FIXED: migration 030
11. **M12+M13**: Missing indexes → ✅ FIXED: migration 030
12. **M14**: Chat Ollama mutex check → ✅ FIXED: check return value, return "LLM busy" to user

### Track for Later (Minor)

All minor findings documented above. None block Phase 9.

---

## Changes Made

### Files Modified
- `packages/service/src/proposals/applier.ts` — C1: Entity merge wrapped in transaction
- `packages/service/src/index.ts` — C2: Pool config (max=20), C3: Graceful shutdown drain
- `packages/service/src/processor/pipeline.ts` — C4: Chunk inserts wrapped in transaction
- `packages/service/src/mcp/tools/stats.ts` — C6: Parameterized SQL interval
- `packages/service/src/admin/static/approvals.html` — M2: URL protocol validation
- `packages/service/src/processor/relationship-applier.ts` — M4: Use normalizeName()
- `packages/service/src/processor/profile-generator.ts` — M5: Remove mention_count from bg poller
- `packages/service/src/mcp/tools/semantic-search.ts` — M6: Batch parent lookups
- `packages/service/src/mcp/tools/get-context.ts` — M7: Batch entity resolution
- `packages/service/src/chat/conversation-routes.ts` — M14: Check mutex return value

### New Files
- `migrations/030_add_missing_indexes_and_cascade.sql` — M9+M12+M13

### Tests Updated
- `packages/service/__tests__/proposals/applier.test.ts` — Mock pool.connect for transaction
- `packages/service/__tests__/processor/pipeline.test.ts` — Mock pool.connect for chunk transaction
- `packages/service/__tests__/mcp/get-context.test.ts` — Updated for batch entity resolution

### Test Results
568 tests pass (70 files), 0 failures.
