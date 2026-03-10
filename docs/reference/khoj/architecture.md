# Khoj Architecture

## Technology Stack

- **Backend:** Python 3.10+, Django 4.x (with Django REST framework)
- **Frontend:** Next.js with static site generation (recently migrated)
- **Database:** PostgreSQL with pgvector extension
- **Task runner:** Gunicorn + Uvicorn workers (ASGI for async/streaming)
- **Embedding models:** sentence-transformers (bi-encoder + cross-encoder), runs locally
- **LLM providers:** OpenAI, Anthropic, Google Gemini, Ollama (any OpenAI-compatible API)
- **Search service:** SearxNG (self-hosted meta-search engine)
- **Code sandbox:** Terrarium (Pyodide-based Python sandbox in Docker)
- **Computer automation:** Optional VNC-accessible desktop container

## Docker Compose Service Topology

Khoj deploys as 5 Docker services (defined in `docker-compose.yml`):

```
┌─────────────────────────────────────────────────┐
│                   khoj_default network           │
│                                                  │
│  ┌──────────┐    ┌──────────┐    ┌───────────┐  │
│  │  server   │───>│ database │    │  sandbox  │  │
│  │ :42110    │    │ postgres │    │ terrarium │  │
│  │ Django +  │    │ +pgvector│    │ :8080     │  │
│  │ Gunicorn  │    │ :5432    │    └───────────┘  │
│  └─────┬─────┘    └──────────┘                   │
│        │                                         │
│        │          ┌──────────┐    ┌───────────┐  │
│        └────────> │  search  │    │ computer  │  │
│                   │ searxng  │    │ VNC :5900 │  │
│                   │ :8000    │    │ (optional)│  │
│                   └──────────┘    └───────────┘  │
└─────────────────────────────────────────────────┘
```

### Service Details

1. **server** (port 42110): Main Django application. Runs Gunicorn with Uvicorn workers for async SSE streaming. Exposes all API endpoints, serves the Next.js frontend, handles content indexing, chat, search, and agent orchestration. Depends on database with health check.

2. **database** (port 5432): PostgreSQL with pgvector extension. Uses `pg_isready` health checks (30s interval, 10s timeout, 5 retries). Stores all data: entries, embeddings, conversations, users, agents, file objects.

3. **sandbox** (port 8080): Terrarium -- Pyodide-based Python execution sandbox. Containerized for security. Used by code execution tool. Alternative: E2B cloud sandbox.

4. **search** (port 8000): SearxNG meta-search engine. Provides web search results when Khoj determines it needs internet information. Self-hosted, no external API keys needed.

5. **computer** (port 5900, optional): VNC-accessible desktop environment for computer automation. Enabled via `KHOJ_OPERATOR_ENABLED` env var. Allows agents to interact with desktop applications.

## Request Flow: Chat Message

```
User message (browser/Obsidian/Emacs/WhatsApp)
    │
    ▼
api_chat.py  (Django router endpoint)
    │
    ▼
helpers.py  (orchestration layer)
    │
    ├── 1. Intent detection (LLM call)
    │     Determines: data sources, output mode, tools needed
    │
    ├── 2. Tool execution (parallel where possible)
    │     ├── Knowledge base search (text_search.py)
    │     ├── Online search (online_search.py → SearxNG)
    │     ├── Code execution (run_code.py → Terrarium)
    │     └── Computer use (operator.py → VNC, optional)
    │
    ├── 3. Context assembly
    │     Combine: search results + tool outputs + conversation history + user memory
    │
    ├── 4. Prompt construction (prompts.py templates)
    │     System prompt + persona + context + chat history + user query
    │
    ├── 5. LLM generation (provider-specific: openai/anthropic/gemini/offline)
    │     Streaming response via SSE
    │
    └── 6. Persistence (save_to_conversation_log)
          Store query, response, references, tool results, intent metadata
```

## Request Flow: Content Indexing

```
File upload / Notion sync / GitHub sync
    │
    ▼
api_content.py  (content sync endpoint)
    │
    ▼
Content type detection (magika library)
    │
    ▼
Type-specific processor (TextToEntries subclass)
    ├── MarkdownToEntries
    ├── PdfToEntries
    ├── OrgToEntries
    ├── NotionToEntries
    ├── GithubToEntries
    ├── DocxToEntries
    └── PlaintextToEntries
    │
    ▼
Chunking (RecursiveCharacterTextSplitter for oversized entries)
    │
    ▼
Embedding generation (bi-encoder model, batched)
    │
    ▼
Database storage (Entry model with pgvector embeddings)
    │
    ▼
FileObject creation (raw file content tracking)
```

## Key Environment Variables

| Variable | Purpose |
|----------|---------|
| `KHOJ_ADMIN_PASSWORD` | Django admin panel password |
| `KHOJ_DJANGO_SECRET_KEY` | Django secret key |
| `KHOJ_ADMIN_EMAIL` | Admin email (optional) |
| `OPENAI_BASE_URL` | Override for Ollama/local LLM (e.g., `http://host.docker.internal:11434/v1/`) |
| `KHOJ_OPERATOR_ENABLED` | Enable computer automation service |

## Admin Panel

Django admin at `/server/admin/` provides configuration for:
- Chat models (add/configure LLM providers)
- Search model config (bi-encoder, cross-encoder, embedding endpoint)
- Agent creation and management
- User management and subscriptions
- Content source configuration

## Frontend Architecture

Recently migrated to Next.js with static site generation. The frontend provides:
- Chat interface with streaming responses
- Agent selection and creation
- File upload and content management
- Search interface
- Automation scheduling

Multiple client interfaces exist:
- **Web app** (Next.js) -- primary interface
- **Obsidian plugin** -- search and chat within Obsidian
- **Emacs client** (khoj.el) -- Emacs integration
- **Desktop/mobile apps** -- via web wrapper
- **WhatsApp** -- via Flint (separate project by khoj-ai)
