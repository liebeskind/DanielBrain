# DanielBrain

A database-backed, AI-accessible personal knowledge system evolving into a company-wide context graph. One brain that every AI tool can plug into via MCP — the shared memory layer for an intelligent operating system.

## Vision

DanielBrain is a **shared memory layer for AI agents**. Agents are stateless workers; the brain is the persistent substrate. Any authorized agent (Claude, GPT, custom automation) plugs in via MCP to read, query, and eventually write to a unified context graph.

**Evolution path**: Personal prototype → company-wide context graph → agent automation platform.

**Data model**: Hybrid shared/private. Entities (people, companies, projects) are shared canonical nodes. Thoughts are privately scoped with source-determined default visibility. Selective sharing allows promotion from private to team/company.

See `docs/vision/` for detailed use cases and architecture vision.

## Architecture

- **PostgreSQL + pgvector** on DGX Spark for storage and vector search
- **Ollama** on DGX Spark for embeddings (nomic-embed-text) and metadata extraction (llama3.1:8b)
- **MCP server** (HTTP/SSE transport) with 8 tools (4 thought tools + 4 entity tools)
- **Entity knowledge graph**: first-class entities (person, company, topic, product, project, place) linked to thoughts with relationship types
- **Profile generation**: LLM-generated entity profiles with vector embeddings for entity-level semantic search
- **Slack webhook** capture through Cloudflare Tunnel
- **Telegram webhook** as second input channel (opt-in via config)
- **Cloudflare Tunnel + Zero Trust** for remote access (no open ports)

## Project Structure

```
packages/shared/         # Types, Zod schemas, DB client, constants
packages/service/        # MCP server, processing pipeline, Slack + Telegram integration
  src/processor/         # chunker, embedder, extractor, summarizer, pipeline,
                         # entity-resolver, profile-generator, queue-poller,
                         # slack-notifier, telegram-notifier
  src/mcp/               # MCP server + 8 tool handlers
    tools/               # semantic-search, list-recent, stats, save-thought,
                         # get-entity, list-entities, get-context, get-timeline
  src/slack/             # Webhook handler + signature verification
  src/telegram/          # Webhook handler + secret token verification
  src/auth.ts            # API key verification (timing-safe)
  src/config.ts          # Zod-validated config from env vars
  src/index.ts           # Entry: Express + MCP SSE + webhooks + queue poller + profile refresher
migrations/              # 11 SQL migration files
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
scripts/migrate.ts       # Migration runner
docker/                  # docker-compose.yml (prod) + docker-compose.test.yml (test)
docs/
  reference/             # Original Open Brain video transcript
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
- Run: `npx vitest run` (164 tests across 26 files)

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

### Profile Generation
- LLM generates 3-5 sentence profile from recent linked thoughts
- Profile embedded via nomic-embed-text for entity-level semantic search
- Staleness: refresh after 10 new mentions OR 7 days
- Refreshed on-demand (get_entity) + background poller (every 5 min, batch of 5)

## Key Design Decisions

- **Embedding prefixes**: nomic-embed-text requires `search_document: ` for storage, `search_query: ` for search
- **Chunking threshold**: 6000 tokens (~4500 words). Chunks are ~2000 tokens with 200-token overlap
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

## Environment Variables

See `.env.example` for all required/optional vars. Key ones:
- `DATABASE_URL` — PostgreSQL connection string
- `BRAIN_ACCESS_KEY` — 64-char hex API key
- `SLACK_BOT_TOKEN` / `SLACK_SIGNING_SECRET` — Slack app credentials
- `TELEGRAM_BOT_TOKEN` / `TELEGRAM_WEBHOOK_SECRET` — Telegram bot credentials (optional)
- `OLLAMA_BASE_URL` — defaults to http://localhost:11434

## Build Phases

- [x] Phase 1: Foundation (git, workspaces, TypeScript, Vitest, Docker, shared package, migrations)
- [x] Phase 2: Processing Pipeline (chunker, embedder, extractor, summarizer, pipeline, config)
- [x] Phase 3: MCP Server (4 tools, auth, HTTP/SSE transport)
- [x] Phase 4: Queue Processor + Slack Webhook
- [x] Phase 4b: Telegram Webhook Integration
- [x] Phase 4c: Entity Knowledge Graph (entities, resolver, profiles, 4 MCP tools)
- [ ] Phase 5: Cloudflare Tunnel + Zero Trust (infrastructure setup)
- [ ] Phase 6: Polish (retry backoff, health checks, structured logging, backup)
- [ ] Phase 7: Permissions enforcement (visibility scoping, access_keys, selective sharing)
- [ ] Phase 8: Slack bot selective capture (@mention to choose what enters shared graph)
- [ ] Phase 9: Context diff + staleness monitoring ("what changed this week?")
- [ ] Phase 10: Entity-to-entity relationships (populate entity_relationships table)
- [ ] Phase 11: Meeting prep autopilot (calendar integration, proactive briefings)
- [ ] Phase 12: Action item lifecycle (open/closed/stale tracking with assignees)

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
