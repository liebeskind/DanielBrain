# DanielBrain

A database-backed, AI-accessible personal knowledge system evolving into a company-wide context graph. One brain that every AI tool can plug into via MCP — the shared memory layer for an intelligent operating system.

## Vision

DanielBrain is a **shared memory layer for AI agents**. Agents are stateless workers; the brain is the persistent substrate. Any authorized agent (Claude, GPT, custom automation) plugs in via MCP to read, query, and eventually write to a unified context graph.

**Evolution path**: Personal prototype → company-wide context graph → agent automation platform.

**Data model**: Hybrid shared/private. Entities (people, companies, projects) are shared canonical nodes. Thoughts are privately scoped with source-determined default visibility. Selective sharing allows promotion from private to team/company.

See `docs/vision/` for detailed use cases and architecture vision.

## Data Sovereignty — MANDATORY

**All inference, storage, and retrieval MUST remain on-prem (DGX Spark).** No company vault data — thoughts, transcripts, entities, embeddings, or any brain contents — may ever be sent to external AI APIs (Claude API, OpenAI, etc.). Claude Code may read source code and assist with development, but must never be given access to production data. Any new feature (chat, search, summarization) must use local Ollama models, not cloud LLMs. This is a hard architectural constraint, not a preference.

## Architecture

- **PostgreSQL + pgvector** on DGX Spark for storage and vector search
- **Ollama** on DGX Spark for embeddings (nomic-embed-text), metadata extraction (llama3.1:8b), and relationship description (llama3.1:70b-q4_K_M)
- **MCP server** (HTTP/SSE transport) with 8 tools (4 thought tools + 4 entity tools)
- **Entity knowledge graph**: first-class entities linked to thoughts + entity-to-entity relationship edges with temporal tracking
- **Profile generation**: LLM-generated entity profiles with vector embeddings for entity-level semantic search
- **Approvals queue**: confidence-gated proposal system for human-in-the-loop quality control
- **Admin dashboard**: web UI at `/admin` for reviewing proposals, entity overview, and stats
- **LinkedIn enricher**: background poller using SerpAPI (optional, 33/day on Starter plan)
- **Fathom webhook**: meeting transcript ingestion from Fathom (opt-in via config)
- **Slack webhook** capture through Cloudflare Tunnel
- **Telegram webhook** as second input channel (opt-in via config)
- **Cloudflare Tunnel + Zero Trust** for remote access (no open ports)

## Project Structure

```
packages/shared/         # Types, Zod schemas, DB client, constants
packages/service/        # MCP server, processing pipeline, Slack + Telegram integration
  src/processor/         # chunker, embedder, extractor, summarizer, pipeline,
                         # entity-resolver, profile-generator, queue-poller,
                         # relationship-builder, relationship-describer,
                         # slack-notifier, telegram-notifier
  src/mcp/               # MCP server + 8 tool handlers
    tools/               # semantic-search, list-recent, stats, save-thought,
                         # get-entity, list-entities, get-context, get-timeline
  src/slack/             # Webhook handler + signature verification
  src/telegram/          # Webhook handler + secret token verification
  src/fathom/            # Webhook handler + svix signature verification + transcript fetcher
  src/proposals/          # Approvals queue: applier, reverter, helpers, REST routes
  src/enrichers/          # Background enrichment pollers (LinkedIn via Google CSE)
  src/admin/              # Admin dashboard routes + static HTML/CSS/JS
  src/auth.ts            # API key verification (timing-safe)
  src/config.ts          # Zod-validated config from env vars
  src/index.ts           # Entry: Express + MCP SSE + webhooks + queue poller + profile refresher + enricher
migrations/              # 15 SQL migration files
  001 pgvector           # Enable extensions
  002 thoughts           # Thoughts table + update_updated_at trigger
  003 queue              # Async processing queue
  004 access_keys        # API key management with scopes
  005 indexes            # HNSW, GIN, B-tree indexes for thoughts
  006 match_function     # match_thoughts() for semantic search
  007 entities           # Entity table with entity_type enum
  008 thought_entities   # Junction table with relationship types
  009 entity_relationships # Entity-to-entity relationships (schema ready, not populated)
  010 entity_indexes     # HNSW, GIN, B-tree indexes for entities
  011 find_entity_function # find_entity_by_name() SQL function
  012 merge_duplicates   # Junk cleanup + duplicate entity merge
  013 update_find_entity # Align SQL normalization with app code
  014 create_proposals   # Proposals table for approvals queue
  015 add_queue_source_id # Add source_id to queue for dedup (Fathom etc.)
  ...
  020 add_relationship_columns # weight, description, valid_at/invalid_at, source_thought_ids
scripts/migrate.ts       # Migration runner
docker/                  # docker-compose.yml (prod) + docker-compose.test.yml (test)
docs/
  reference/             # Original Open Brain video transcript
  reference/graphiti/    # Graphiti (Zep) — temporal KG for agent memory (9 docs)
  reference/graphrag/    # Microsoft GraphRAG — community detection + global search (8 docs)
  reference/khoj/        # Khoj — self-hosted AI brain with agents (9 docs)
  reference/mem0/        # Mem0 — memory lifecycle management (9 docs)
  reference/lightrag/    # LightRAG — dual-level retrieval (2 docs)
  reference/haystack/    # Haystack — pipeline architecture (2 docs)
  reference/ragflow/     # RAGFlow — document understanding + HITL (8 docs)
  reference/cognee/      # cognee — KG memory framework (11 docs)
  reference/synthesis.md # Cross-project comparison + architecture recommendations
  vision/                # Use cases by department, context graph vision
  plans/                 # Implementation plans (design docs)
```

## Development

```bash
npm install                    # Install all workspace dependencies
npm test                       # Run all unit tests (vitest)
npm run dev                    # Start service (requires .env + Postgres + Ollama)
npm run migrate                # Run SQL migrations against DATABASE_URL
```

## Testing

- Full TDD: every module has tests written before implementation
- Unit tests mock Ollama calls (fast, no GPU needed)
- Integration tests use real Postgres via docker-compose.test.yml (port 5433)
- Run: `npx vitest run` (330 tests across 44 files)

## MCP Tools

### Thought Tools (original 4)
- **semantic_search**: Search by meaning with optional filters (thought_type, person, topic, days_back)
- **list_recent**: Browse recent thoughts by date
- **stats**: Counts, breakdowns by type, top people/topics, action item counts
- **save_thought**: Write a thought directly via MCP (triggers full pipeline)

### Entity Tools (4 new)
- **get_entity**: Full profile by ID or name — linked thoughts, connected entities, staleness flag
- **list_entities**: Browse/search by type, name prefix, sort by mentions/recency/name
- **get_context**: Briefing from entity intersection — "prep me for meeting with Alice about Project X"
- **get_timeline**: Chronological view for an entity, grouped by date, filterable by source

## Entity Graph

### Entity Types
`person`, `company`, `topic`, `product`, `project`, `place`

### Relationship Types (thought ↔ entity)
`mentions`, `about`, `from`, `assigned_to`, `created_by`

### Entity Resolution Pipeline
After every thought INSERT, the pipeline runs entity resolution (non-blocking):
1. Extract people, companies, products, projects from LLM metadata
2. Normalize name: lowercase, trim, strip prefixes (Mr./Dr.) and suffixes (Inc./LLC)
3. Find or create: canonical match → alias match → ON CONFLICT create (race-safe)
4. Infer relationship: author → `from`, action item → `assigned_to`, summary → `about`, default → `mentions`
5. Link entity to thought, bump mention_count and last_seen_at

### Entity-to-Entity Relationships
- Co-occurrence edges created automatically when 2+ entities appear in the same thought
- Canonical edge direction: smaller UUID = source_id (avoids A→B / B→A duplicates)
- Weight tracks co-occurrence count; source_thought_ids provides traceability
- LLM description (70B) generated for edges with weight >= 2 (background poller)
- Temporal edges: `valid_at`/`invalid_at` track fact evolution (contradictions create new edge)
- Low-confidence contradictions → proposals queue for human review

### Profile Generation
- LLM generates 3-5 sentence profile from recent linked thoughts
- Profile embedded via nomic-embed-text for entity-level semantic search
- Staleness: refresh after 10 new mentions OR 7 days
- Refreshed on-demand (get_entity) + background poller (every 5 min, batch of 5)

## Approvals Queue

General-purpose, confidence-gated proposal system. Any operation where confidence is below a threshold creates a proposal for human review via the admin dashboard.

### Confidence Thresholds
- `entity_link: 0.8` — prefix matches (confidence 0.7) auto-apply + create reviewable proposal
- `entity_enrichment: 'always'` — LinkedIn URLs always held for review
- `entity_merge: 'always'` — destructive, always held for review

### Apply Strategy
| Operation | Risk | Behavior |
|-----------|------|----------|
| Entity link (prefix match) | Low | Auto-apply + review after. Reject = undo link + alias |
| LinkedIn URL enrichment | Medium | Hold until approved. Approve = write to entity metadata |
| Entity merge | High | Hold until approved. Approve = reassign links, merge aliases, delete loser |

### Status Lifecycle
`pending` → `approved` → `applied` (or `rejected` / `needs_changes` / `failed`)

### Admin Dashboard
- URL: `http://localhost:3000/admin`
- Approvals page: card-per-proposal with approve/reject/needs-changes actions
- Entities page: type counts, top by mentions, recently active, proposal status
- Plain HTML + CSS + vanilla JS, no framework, no build step

## Key Design Decisions

- **Embedding prefixes**: nomic-embed-text requires `search_document: ` for storage, `search_query: ` for search
- **Chunking threshold**: 2000 estimated tokens. Chunks are ~1000 estimated tokens with 100-token overlap. Lower than nomic-embed-text's 8192 limit because word-based estimation undercounts actual tokens
- **Long content**: parent thought gets summary embedding; child chunks get individual embeddings
- **Queue**: Slack/Telegram messages go to queue table, processed async by poller (FOR UPDATE SKIP LOCKED)
- **Auth**: `x-brain-key` header with 64-char hex key, timing-safe comparison
- **Slack verification**: HMAC-SHA256 signature + 5-minute timestamp expiry
- **Telegram verification**: `X-Telegram-Bot-Api-Secret-Token` header, timing-safe string comparison
- **Telegram is opt-in**: route only registered when `TELEGRAM_BOT_TOKEN` + `TELEGRAM_WEBHOOK_SECRET` are set
- **Entity resolution non-blocking**: failure never prevents thought storage
- **Entity dedup**: canonical_name + entity_type unique constraint, ON CONFLICT for race safety
- **Relationship inference**: deterministic rules based on source_meta, action items, summary
- **Hybrid data model**: shared entity graph + privately-scoped thoughts + selective sharing
- **Source-determined visibility**: public channels → company, DMs → participants, personal → owner
- **LLM Prompting Standard**: All prompts sent to local Ollama models (llama3.1:8b) must be explicit, structured prompts with examples. Claude writes these prompts, optimized for the smaller model's capabilities. Every prompt must include: (1) clear role and context about the system, (2) explicit DO/DON'T rules per field, (3) at least one concrete few-shot example, (4) negative examples showing common mistakes, (5) exact format constraints. Applies to extraction, summarization, profile generation, and any future LLM calls.
- **Entity normalization**: `normalizeName()` strips parentheticals, domain suffixes (.io/.com/.earth), pronouns, name prefixes, and company suffixes. `isJunkEntity()` rejects blocklisted words, non-alphabetic strings, and CLI commands before any DB interaction.
- **First-name prefix matching**: Single-token person names (e.g., "Chris") match existing entities where `canonical_name LIKE 'chris %'`, auto-adding the first name as an alias
- **Confidence-gated proposals**: operations below threshold auto-apply + create reviewable proposal; high-risk ops hold until approved
- **Proposal type is TEXT**: no migration needed for new operation types; status is ENUM (fixed lifecycle)
- **LinkedIn enricher opt-in**: only starts when `SERPAPI_KEY` is set; in-memory daily counter (33/day) resets at midnight UTC
- **Admin dashboard no-auth**: protected by network (Cloudflare Zero Trust), no API key required for `/admin` routes
- **Fathom opt-in**: route only registered when `FATHOM_API_KEY` + `FATHOM_WEBHOOK_SECRET` are set
- **Fathom signature verification**: svix HMAC-SHA256 with base64-decoded secret, timing-safe comparison
- **Queue source_id dedup**: partial unique index on `source_id WHERE source_id IS NOT NULL` prevents duplicate processing
- **Approvals context**: proposals list includes entity profile + recent thought excerpts for informed review
- **Canonical edge direction**: smaller UUID = source_id to deterministically avoid A→B / B→A duplicates
- **`co_occurs` as base relationship**: LLM description enriches via `description` field; free-text avoids premature taxonomy
- **weight >= 2 threshold for LLM description**: avoids wasting 70B time on single-co-occurrence noise
- **source_thought_ids array**: traceability without a separate junction table
- **Contradiction detection → proposals queue**: uncertain contradictions get human review (HITL moat)
- **Entity merge cascading**: `applyEntityMerge` updates both `thought_entities` and `entity_relationships`
- **Dual-model architecture**: 8B for extraction/chat, 70B for relationship description/contradiction (opt-in via RELATIONSHIP_MODEL)

## Environment Variables

See `.env.example` for all required/optional vars. Key ones:
- `DATABASE_URL` — PostgreSQL connection string
- `BRAIN_ACCESS_KEY` — 64-char hex API key
- `SLACK_BOT_TOKEN` / `SLACK_SIGNING_SECRET` — Slack app credentials
- `TELEGRAM_BOT_TOKEN` / `TELEGRAM_WEBHOOK_SECRET` — Telegram bot credentials (optional)
- `OLLAMA_BASE_URL` — defaults to http://localhost:11434
- `SERPAPI_KEY` — SerpAPI key for LinkedIn enrichment (optional)
- `FATHOM_API_KEY` / `FATHOM_WEBHOOK_SECRET` — Fathom meeting transcript integration (optional)
- `RELATIONSHIP_MODEL` — Ollama model for relationship description/contradiction (optional, e.g. `llama3.1:70b-q4_K_M`)

## Build Phases

- [x] Phase 1: Foundation (git, workspaces, TypeScript, Vitest, Docker, shared package, migrations)
- [x] Phase 2: Processing Pipeline (chunker, embedder, extractor, summarizer, pipeline, config)
- [x] Phase 3: MCP Server (4 tools, auth, HTTP/SSE transport)
- [x] Phase 4: Queue Processor + Slack Webhook
- [x] Phase 4b: Telegram Webhook Integration
- [x] Phase 4c: Entity Knowledge Graph (entities, resolver, profiles, 4 MCP tools)
- [x] Phase 4d: Approvals Queue + Admin Dashboard + LinkedIn Enrichment
- [x] Phase 4e: Fathom Meeting Transcript Integration
- [x] Phase 4f: Chat v1 + Correction Examples
- [x] Phase 5: Entity Relationships + Temporal Edges (co-occurrence edges, 70B descriptions, contradiction detection, proposals)
- [ ] Phase 6: Hybrid Retrieval (BM25 + tsvector + RRF, query routing, intent detection)
- [ ] Phase 7: Community Detection + Global Search (Louvain via graphology, community summaries, simplified global search)
- [ ] Phase 8: Agent Interface Enhancement (new MCP tools, agent personas, research mode, dual-level keywords)
- [ ] Phase 9: Permissions + Multi-User (visibility scoping, access_keys, selective sharing)
- [ ] Phase 10: Infrastructure + Polish (Cloudflare Tunnel, cross-encoder reranking, source-specific chunking, logging, backup)
- [ ] Phase 11: Advanced Knowledge Quality (fact-level dedup, atomic fact extraction, recursive splitting)
- [ ] Phase 12: Automation + Calendar (scheduled monitoring, meeting prep autopilot, action item lifecycle)

## Git History

```
1f95187 Initial implementation of DanielBrain (Phases 1-4)
f9836e9 Add Telegram as second input channel
91e9ba2 Update CLAUDE.md with Telegram integration details
f977c8b Wire Slack and Telegram notifiers into queue poller
2ae680f Make Slack config optional like Telegram
304b9b0 Add Telegram env vars to .env.example and Slack app manifest
------- Phase 4c: Entity Knowledge Graph (uncommitted)
```
