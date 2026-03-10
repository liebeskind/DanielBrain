# Khoj vs TopiaBrain -- Comparison & Patterns to Adopt

## Architecture Comparison

| Aspect | Khoj | TopiaBrain |
|--------|------|------------|
| **Core** | Django web app + Next.js frontend | MCP server (Express + HTTP/SSE) |
| **Database** | PostgreSQL + pgvector (Django ORM) | PostgreSQL + pgvector (raw SQL + migrations) |
| **LLM** | Multi-provider (OpenAI, Anthropic, Gemini, Ollama) | Ollama only (data sovereignty) |
| **Embedding** | sentence-transformers (MiniLM) | Ollama (nomic-embed-text) |
| **Search** | Bi-encoder + cross-encoder reranking | pgvector similarity only |
| **Chat** | Built-in web UI + multi-client | V1 chat just added |
| **Agents** | Custom agents with personas, tools, knowledge bases | No agent system yet |
| **Entity graph** | None (flat document chunks) | First-class entities with types, relationships, profiles |
| **HITL** | None (no approvals/review system) | Confidence-gated proposals + admin dashboard |
| **Content input** | File upload, Notion, GitHub, Obsidian sync | Slack webhooks, Telegram, Fathom transcripts |
| **Automation** | Scheduled cron-based agent tasks | Queue poller (async processing only) |
| **Frontend** | Next.js SPA + Obsidian/Emacs plugins | Admin dashboard (vanilla HTML/JS) |

## What TopiaBrain Has That Khoj Lacks

1. **Entity knowledge graph**: TopiaBrain's entity resolution, typed entities, mention tracking, and entity profiles are a significant differentiator. Khoj treats everything as flat document chunks.

2. **Human-in-the-loop quality control**: The proposals/approvals queue with confidence gating is ahead of most systems. Khoj has no equivalent.

3. **MCP protocol**: TopiaBrain is designed as a tool server that any AI agent can connect to. Khoj is a self-contained application.

4. **Source-determined visibility**: TopiaBrain's data model supports private/shared/team scoping. Khoj has per-user isolation but no granular sharing.

5. **Entity enrichment**: LinkedIn enricher, Fathom integration, entity profile generation. Khoj doesn't enrich beyond indexing.

## What Khoj Has That TopiaBrain Lacks

1. **Mature chat system**: Full RAG pipeline with intent detection, multi-turn context, streaming, research mode.

2. **Agent system**: Custom agents with personas, dedicated knowledge bases, and tool access.

3. **Two-stage retrieval**: Cross-encoder reranking significantly improves search quality over pure bi-encoder.

4. **Tool orchestration**: LLM-driven tool selection (search, web, code, computer use).

5. **Scheduled automations**: Cron-based recurring agent tasks with email delivery.

6. **Multi-client support**: Web, Obsidian, Emacs, WhatsApp, desktop, mobile.

7. **Query reformulation**: LLM rewrites conversational queries into search-optimized queries.

## Patterns to Adopt

### 1. Chat Context Injection Pipeline (HIGH PRIORITY)

**Khoj's approach:** System prompt + persona + user memory + retrieved context + conversation history + user query, with token-aware truncation that preserves system prompt and drops oldest messages first.

**What to adopt for TopiaBrain:**
- Add context assembly function that merges: entity profiles + relevant thoughts + conversation history
- Implement token budget management (preserve system prompt, truncate history)
- Use entity graph as additional context signal (Khoj doesn't have this -- our advantage)
- Format context with source references so the LLM can cite them

### 2. LLM-Based Intent Detection / Query Routing (HIGH PRIORITY)

**Khoj's approach:** Before retrieving context, ask the LLM: "Given this query, what tools should I use and what should I search for?"

**What to adopt for TopiaBrain:**
- Add an intent detection step before semantic search
- Have the LLM reformulate conversational queries into search queries
- Determine whether to search thoughts, entities, or both
- Decide if web search or code execution would help (future)
- This is one LLM call but dramatically improves retrieval quality

### 3. Two-Stage Retrieval with Cross-Encoder Reranking (MEDIUM PRIORITY)

**Khoj's approach:** Fast bi-encoder retrieval -> precise cross-encoder reranking on top candidates.

**What to adopt for TopiaBrain:**
- Add a cross-encoder reranking step after pgvector similarity search
- Can use sentence-transformers cross-encoder models (run locally)
- Graceful fallback if reranker fails
- Particularly valuable as the thought corpus grows larger
- **Note:** Requires adding sentence-transformers as a dependency (Python) or finding a Node.js equivalent

### 4. Research Mode / Iterative Reasoning (MEDIUM PRIORITY)

**Khoj's approach:** Multi-step research with plan -> iterate -> synthesize pattern.

**What to adopt for TopiaBrain:**
- Not immediate priority, but the pattern is compelling
- Could be implemented as an MCP tool: `deep_research` that does multi-step retrieval
- Each iteration searches thoughts + entities with refined queries
- Produces a comprehensive briefing with citations

### 5. Agent Persona System (MEDIUM PRIORITY)

**Khoj's approach:** Agents = persona text + tool selection + dedicated knowledge base.

**What to adopt for TopiaBrain:**
- When building agent support, use Khoj's simple composition model
- Agent = system prompt (persona) + allowed MCP tools + entity/thought filters
- Per-agent knowledge scoping via entity/thought visibility rules
- Our entity graph gives agents richer context than Khoj's flat chunks

### 6. Conversation Persistence Model (LOW PRIORITY)

**Khoj's approach:** JSON blob per conversation with all turn metadata.

**What to evaluate for TopiaBrain:**
- Khoj's JSON blob approach is simple but doesn't scale for analysis
- Consider a normalized approach: conversations table + messages table
- Store intent detection results, retrieved context, tool results per message
- Enable: "what questions have been asked about entity X?" analytics

### 7. Scheduled Automations (FUTURE)

**Khoj's approach:** LLM converts natural language to cron schedule, executes full chat pipeline.

**What to adopt for TopiaBrain:**
- Future feature: scheduled entity monitoring, staleness alerts, briefing generation
- Pattern: cron scheduler -> MCP tool invocation -> notification delivery
- Our entity graph makes monitoring natural: "alert me when anything changes about Company X"

## Key Architectural Differences to Preserve

### Keep the MCP Architecture
Khoj embeds everything (chat, search, agents) in one Django app. TopiaBrain's MCP approach is more flexible:
- Any AI client (Claude, GPT, custom agents) can access the brain
- The brain doesn't need its own chat UI to be useful
- Multiple agents can share the same knowledge graph simultaneously
- Agents remain stateless; the brain is the persistent substrate

### Keep the Entity Graph
Khoj's flat document chunks lose entity relationships. TopiaBrain's entity graph provides:
- Structured knowledge (person -> company -> project relationships)
- Entity-level semantic search (search for entities, not just text)
- Context injection by entity intersection ("prep me for meeting with Alice about Project X")
- Profile generation and enrichment
- This is a fundamental architectural advantage

### Keep HITL Quality Control
Khoj auto-applies everything with no review mechanism. TopiaBrain's proposals system ensures data quality, especially important for:
- Entity resolution (is "Chris" the same as "Chris Smith"?)
- Entity enrichment (LinkedIn URL accuracy)
- Entity merges (destructive, needs human judgment)

### Keep Data Sovereignty
Khoj supports cloud LLMs as the default path. TopiaBrain's mandatory on-prem constraint ensures no company data leaves the network. This is a hard architectural constraint, not a preference.

## Implementation Roadmap Suggestions

### Phase 1: Chat Context Injection (Current Priority)
- Assemble context from entity profiles + thoughts + conversation history
- Token-aware truncation with priority ordering
- Format context with source references

### Phase 2: Query Routing
- LLM-based intent detection before search
- Query reformulation for better retrieval
- Decide: search thoughts, entities, or both

### Phase 3: Cross-Encoder Reranking
- Add reranking step to semantic search
- Evaluate Node.js cross-encoder options or Python sidecar
- Graceful fallback on failure

### Phase 4: Agent Personas
- Agent model: persona + tool access + knowledge scope
- Per-agent MCP tool filtering
- Entity-aware context injection per agent

### Phase 5: Research Mode
- Multi-step reasoning tool
- Iterative search -> analyze -> refine cycle
- Leverage entity graph for structured research paths
