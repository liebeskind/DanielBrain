# DanielBrain

A database-backed, AI-accessible personal knowledge system. Single brain that every AI tool can plug into via MCP.

## Architecture

- **PostgreSQL + pgvector** on DGX Spark for storage and vector search
- **Ollama** on DGX Spark for embeddings (nomic-embed-text) and metadata extraction (llama3.1:8b)
- **MCP server** (HTTP/SSE transport) with 4 tools: semantic_search, list_recent, stats, save_thought
- **Slack webhook** capture through Cloudflare Tunnel
- **Cloudflare Tunnel + Zero Trust** for remote access (no open ports)

## Project Structure

```
packages/shared/     # Types, Zod schemas, DB client, constants
packages/service/    # MCP server, processing pipeline, Slack integration
  src/processor/     # chunker, embedder, extractor, summarizer, pipeline, queue-poller, slack-notifier
  src/mcp/           # MCP server + 4 tool handlers
  src/slack/          # Webhook handler + signature verification
  src/auth.ts        # API key verification (timing-safe)
  src/config.ts      # Zod-validated config from env vars
  src/index.ts       # Entry point: Express + MCP SSE + Slack webhook + queue poller
migrations/          # 6 SQL migration files (pgvector, thoughts, queue, access_keys, indexes, match_thoughts)
scripts/migrate.ts   # Migration runner
docker/              # docker-compose.yml (prod) + docker-compose.test.yml (test)
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
- Run: `npx vitest run` (82 tests across 17 files)

## Key Design Decisions

- **Embedding prefixes**: nomic-embed-text requires `search_document: ` for storage, `search_query: ` for search
- **Chunking threshold**: 6000 tokens (~4500 words). Chunks are ~2000 tokens with 200-token overlap
- **Long content**: parent thought gets summary embedding; child chunks get individual embeddings
- **Queue**: Slack messages go to queue table, processed async by poller (FOR UPDATE SKIP LOCKED)
- **Auth**: `x-brain-key` header with 64-char hex key, timing-safe comparison
- **Slack verification**: HMAC-SHA256 signature + 5-minute timestamp expiry

## Environment Variables

See `.env.example` for all required/optional vars. Key ones:
- `DATABASE_URL` — PostgreSQL connection string
- `BRAIN_ACCESS_KEY` — 64-char hex API key
- `SLACK_BOT_TOKEN` / `SLACK_SIGNING_SECRET` — Slack app credentials
- `OLLAMA_BASE_URL` — defaults to http://localhost:11434

## Build Phases

- [x] Phase 1: Foundation (git, workspaces, TypeScript, Vitest, Docker, shared package, migrations)
- [x] Phase 2: Processing Pipeline (chunker, embedder, extractor, summarizer, pipeline, config)
- [x] Phase 3: MCP Server (4 tools, auth, HTTP/SSE transport)
- [x] Phase 4: Queue Processor + Slack Webhook
- [ ] Phase 5: Cloudflare Tunnel + Zero Trust (infrastructure setup)
- [ ] Phase 6: Polish (retry backoff, health checks, structured logging, backup)
- [ ] Phase 7: Permissions enforcement (access_keys scoping)
