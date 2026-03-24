# DanielBrain

A shared memory layer for AI agents — the persistent substrate for stateless workers. Any authorized agent plugs in via MCP to read, query, and write to a unified context graph.

**Evolution**: Personal prototype → company-wide context graph → agent automation platform.
**Data model**: Hybrid shared/private. Entities are shared canonical nodes. Thoughts are privately scoped with source-determined visibility. See `docs/vision/` for details.

## Data Sovereignty — MANDATORY

**All inference, storage, and retrieval MUST remain on-prem (DGX Spark).** No brain contents may ever be sent to external AI APIs (Claude API, OpenAI, etc.). Claude Code may read source code but must never access production data. New features must use local Ollama models, not cloud LLMs. This is a hard architectural constraint, not a preference.

## Architecture

- **PostgreSQL + pgvector** on DGX Spark — storage, vector search, hybrid retrieval (RRF)
- **Ollama** on DGX Spark — nomic-embed-text (embeddings) + llama3.3:70b (all LLM tasks). 2 models kept resident in VRAM (~55GB). Preloaded at startup. Zero model swapping.
- **MCP server** (Streamable HTTP) — 18 tools across thoughts, entities, relationships, communities
- **Express** with pino JSON logging, per-tier rate limiting, Cloudflare Tunnel + Zero Trust
- **Entity knowledge graph** — entities → thoughts, entity → entity edges (co-occurrence, temporal)
- **Community detection** — Louvain algorithm (graphology), LLM-generated community summaries
- **Approvals queue** — confidence-gated proposals for human review at `/admin`
- **Integrations**: Slack, Telegram (opt-in), Fathom transcripts (opt-in), HubSpot CRM (opt-in), LinkedIn enrichment (opt-in via SerpAPI)

## Project Structure

```
packages/shared/         # Types, Zod schemas, DB client, constants
packages/service/        # Main service
  src/processor/         # Pipeline: chunker, embedder, extractor, summarizer,
                         # entity-resolver, profile-generator, queue-poller,
                         # relationship-builder/describer, community-detector/summarizer
  src/mcp/tools/         # 18 MCP tool handlers (semantic-search, list-recent, stats,
                         # save-thought, get-entity, list-entities, get-context,
                         # get-timeline, get-communities, global-search, ask,
                         # deep-research, update-entity, propose-merge)
  src/db/                # Centralized query modules (thought-queries.ts enforces visibility)
  src/chat/              # Chat: context builder, streaming, conversations, projects
  src/admin/             # Admin dashboard (HTML/CSS/JS, no framework)
  src/proposals/         # Approvals queue: applier, reverter, routes
  src/slack/             # Slack webhook + signature verification
  src/telegram/          # Telegram webhook (opt-in)
  src/fathom/            # Fathom transcript ingestion (opt-in)
  src/hubspot/           # HubSpot CRM sync: client, sync, format, webhook
  src/enrichers/         # LinkedIn enrichment (SerpAPI, opt-in)
  src/auth.ts            # API key + multi-user auth (UserContext)
  src/config.ts          # Zod-validated env config
  src/index.ts           # Entry: Express + MCP + webhooks + pollers
migrations/              # SQL migrations (001-038)
scripts/                 # migrate.ts, backup.sh, cleanup-entities.ts, etc.
docs/reference/          # Architecture research (synthesis.md = cross-project comparison)
docs/plans/              # Design docs and implementation plans
```

## Development

```bash
npm install                    # Install all workspace dependencies
npm test                       # Run all unit tests (vitest, ~1000 tests, ~2s)
npm run test:integration       # Integration tests (requires test DB, ~135 tests, ~2s)
npm run dev                    # Start service (requires .env + Postgres + Ollama)
npm run migrate                # Run SQL migrations against DATABASE_URL
```

### Integration test setup
```bash
docker compose -f docker/docker-compose.test.yml up -d
DATABASE_URL="postgresql://danielbrain_test:test_password@localhost:5433/danielbrain_test" npm run migrate
npm run test:integration
```

## Entity Graph

**Entity types**: `person`, `company`, `topic`, `product`, `project`, `place`
**Thought-entity relationships**: `mentions`, `about`, `from`, `assigned_to`, `created_by`
**Entity-entity edges**: co-occurrence (auto), temporal tracking (`valid_at`/`invalid_at`), LLM descriptions for weight >= 2

### Entity Resolution (runs after every thought INSERT, non-blocking)
1. Extract entities from LLM metadata
2. Normalize: `normalizeName()` strips parentheticals, domains, prefixes, suffixes. `isJunkEntity()` rejects emails, phase names, CLI commands
3. Find or create: canonical → alias → first-name prefix match → ON CONFLICT create (race-safe)
4. Infer relationship type from source_meta + content
5. Link + bump mention_count and last_seen_at

### Profiles
LLM-generated (3-5 sentences), embedded for entity-level semantic search. Refresh: 10 new mentions OR 7 days stale.

## Key Design Constraints

These are non-obvious rules that apply to new code. Implementation details are visible in the code itself.

### LLM Prompting Standard
All prompts to local Ollama models must include: (1) clear role/context, (2) explicit DO/DON'T rules per field, (3) concrete few-shot example, (4) negative examples of common mistakes, (5) exact format constraints.

### Embedding Prefixes
nomic-embed-text requires `search_document: ` prefix for storage, `search_query: ` for queries.

### Visibility Model
Source-determined: public channels → `['company']`, DMs → `['user:U1', 'user:U2']`, personal → `['owner']`. Filtered via `TEXT[] && GIN` in `hybrid_search()`. Entities globally visible. Team-scoped visibility deferred.

### Hybrid Retrieval
`hybrid_search()` SQL function: vector cosine + BM25 via Reciprocal Rank Fusion (k=60). 3x oversampling, FULL OUTER JOIN dedup. Stop-words degrade gracefully to vector-only.

### Semantic Chunking
Structural hierarchy (LangChain RecursiveCharacterTextSplitter pattern): code blocks (atomic) → speaker turns (meeting source) → headings → paragraphs → list blocks → sentences. 500 token target, 50 overlap. `SourceHint` from `channel_type`: Fathom meetings get speaker-turn splitting. Parent gets summary embedding; child chunks get individual embeddings.

### Intent-Aware Retrieval
Khoj-inspired two-layer hybrid: Layer 1 (heuristic fast-path) detects temporal keywords ("last week" → days_back=7) and action keywords ("action items" → thought_type filter). Layer 2 (LLM via llama3.3:70b) classifies ambiguous queries with structured JSON output + optional query reformulation. Wired into `handleAsk` (MCP) and `buildContext` (chat). User-provided params always override intent adjustments.

### Atomic Fact Extraction
Graphiti-inspired: each thought produces atomic facts via dedicated LLM extraction. Facts stored in `facts` table with own embeddings (HNSW), entity links (subject/object), temporal validity (`valid_at`/`invalid_at`), and confidence scores. Contradiction detection via embedding similarity: >0.95 = duplicate (skip), 0.85-0.95 = superseded (temporal invalidation, never delete). Fire-and-forget in pipeline (non-blocking). Migration 039.

### HubSpot Direct Metadata Bypass
Structured CRM records (contacts, companies, deals) skip LLM extraction via `directMetadata` in `source_meta`. Notes use full pipeline. Per-object visibility branches on `source_meta.object_type`.

### Queue Processing
Async via `FOR UPDATE SKIP LOCKED`. Exponential backoff (30s→10min, max 3 retries). `source_id` partial unique index for dedup.

### Confidence-Gated Proposals
Low confidence → auto-apply + reviewable proposal. High-risk ops (merge, enrichment) → hold until approved. Admin dashboard at `/admin` for review.

### Cross-Encoder Re-Ranking
Optional post-retrieval reranking via `RERANKER_MODEL` env var (e.g. `Xenova/ms-marco-MiniLM-L-6-v2`). Uses `@huggingface/transformers` ONNX runtime (CPU, on-prem). Applied after `hybrid_search()` in `handleSemanticSearch`, benefiting all search paths (MCP tools, chat, deep research). Model lazy-loaded on first query, cached thereafter. Graceful degradation if unavailable.

### Fathom Cross-Reference
HubSpot sync cross-references Fathom-link notes with existing Fathom thoughts. When a HubSpot note contains a `fathom.video/calls/{id}` URL, the sync resolves HubSpot associations (contacts, companies) and merges them into the Fathom thought's `source_meta.hubspot_crm`.

### Planning Process
Before building new features, research how comparable platforms handle the problem. Check `docs/reference/` first, then industry-standard tools.

## Environment Variables

See `.env.example` for full list. Critical: `DATABASE_URL`, `BRAIN_ACCESS_KEY`, `OLLAMA_BASE_URL`.
Optional integrations enabled by their tokens: `SLACK_BOT_TOKEN`/`SLACK_SIGNING_SECRET`, `TELEGRAM_BOT_TOKEN`/`TELEGRAM_WEBHOOK_SECRET`, `FATHOM_API_KEY`/`FATHOM_WEBHOOK_SECRET`, `HUBSPOT_ACCESS_TOKEN`/`HUBSPOT_WEBHOOK_SECRET`, `SERPAPI_KEY`, `JWT_SECRET`.
Models: `EXTRACTION_MODEL`, `CHAT_MODEL`, `RELATIONSHIP_MODEL` (all default `llama3.3:70b`).
Config: `LOG_LEVEL` (default: `info`), `HUBSPOT_POLL_INTERVAL_MS` (default: 300000), `RERANKER_MODEL` (optional, e.g. `Xenova/ms-marco-MiniLM-L-6-v2`).
