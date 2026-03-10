# Khoj -- Reference Documentation Baseline

**Baseline date:** 2026-03-09
**Repository:** https://github.com/khoj-ai/khoj
**Version:** ~2.0.0-beta (active development)
**License:** AGPL-3.0
**Stars:** ~25k+ | **Language:** Python (Django backend) + Next.js (frontend)

## What is Khoj?

Khoj is an open-source, self-hostable AI "second brain" that turns any local or cloud LLM into a personal autonomous AI assistant. It indexes your documents (PDF, Markdown, Org-mode, Word, Notion, GitHub), provides semantic search with cross-encoder reranking, and offers multi-turn chat with RAG context injection. Users can create custom agents with tunable personas, tool access, and dedicated knowledge bases. It supports scheduled automations and a research mode for iterative multi-step reasoning.

Core flow: **Index** (sync documents) -> **Search** (bi-encoder + cross-encoder reranking) -> **Chat** (RAG context injection + tool use) -> **Agent** (persona + tools + knowledge base)

## Why This Baseline Exists

TopiaBrain is building chat and agent capabilities. Khoj is the most mature open-source project solving the same "AI second brain" problem with a comparable stack (PostgreSQL + pgvector + local LLMs). This documentation captures Khoj's architecture as reference for patterns worth adopting -- particularly chat context injection, agent/tool orchestration, query routing, and the two-stage retrieval pipeline.

**Key similarities:** Both use PostgreSQL + pgvector, support Ollama for local inference, and aim to be self-hosted knowledge systems.

**Key differences:** Khoj is a full Django web app with Next.js frontend; TopiaBrain is an MCP server designed as a shared memory layer for external AI agents. Khoj embeds the chat UI; TopiaBrain exposes tools for any AI client to consume.

## Documentation Index

| Document | Description |
|----------|-------------|
| [Architecture](architecture.md) | Django stack, service topology, data flow, deployment model |
| [Chat System](chat-system.md) | Chat pipeline, context injection, multi-turn handling, conversation modes |
| [Agent System](agent-system.md) | Agent model, tool orchestration, custom agents, automations |
| [Retrieval & Search](retrieval-and-search.md) | Two-stage retrieval, bi-encoder, cross-encoder reranking, query routing |
| [Connectors & Content Sources](connectors.md) | Supported sources, TextToEntries pipeline, chunking, incremental indexing |
| [Storage Layer](storage-layer.md) | Django ORM models, pgvector embeddings, conversation persistence |
| [On-Prem Viability](on-prem-viability.md) | Self-hosting, Ollama integration, offline operation, resource requirements |
| [Comparison to TopiaBrain](comparison-to-topiabrain.md) | Side-by-side analysis, patterns to adopt, architectural gaps |

## Key Source Paths

```
src/khoj/
  routers/
    helpers.py              # Chat request orchestration, intent routing, tool dispatch
    api_chat.py             # Chat API endpoints (SSE streaming)
    api_content.py          # Content sync/indexing API
  processor/
    conversation/
      prompts.py            # All prompt templates (system, persona, context injection)
      utils.py              # Chat history construction, message formatting, token management
      openai/gpt.py         # OpenAI provider (converse_openai, openai_send_message_to_model)
      anthropic/anthropic_chat.py  # Anthropic provider
      google/gemini_chat.py # Google provider
      offline/chat.py       # Local/Ollama provider
    tools/
      online_search.py      # Web search tool (SearxNG integration)
      run_code.py           # Python code execution (Terrarium sandbox)
      operator.py           # Computer automation (VNC-based)
    content/
      text_to_entries.py    # Base class for all content processors
      markdown_to_entries.py
      pdf_to_entries.py
      org_to_entries.py
      notion_to_entries.py
      github_to_entries.py
      docx_to_entries.py
      plaintext_to_entries.py
  search_type/
    text_search.py          # Bi-encoder search + cross-encoder reranking
  database/
    models.py               # Django ORM: Entry, Conversation, Agent, KhojUser, etc.
    adapters.py             # Database query helpers (CRUD for all models)
src/interface/
  web/                      # Next.js frontend application
  emacs/khoj.el             # Emacs client
  obsidian/                 # Obsidian plugin
docker-compose.yml          # 5 services: server, database, sandbox, search, computer
```
