# Khoj Chat System

## Chat Architecture Overview

Khoj's chat system implements a multi-stage pipeline that handles intent detection, context retrieval, tool orchestration, and LLM response generation. The system supports multiple LLM providers through a unified interface and streams responses via Server-Sent Events (SSE).

### Key Source Files

- `src/khoj/routers/api_chat.py` -- API endpoints for chat
- `src/khoj/routers/helpers.py` -- Core orchestration logic (the "brain" of chat)
- `src/khoj/processor/conversation/prompts.py` -- All prompt templates
- `src/khoj/processor/conversation/utils.py` -- Chat history construction, token management
- `src/khoj/processor/conversation/openai/gpt.py` -- OpenAI provider (`converse_openai`)
- `src/khoj/processor/conversation/anthropic/anthropic_chat.py` -- Anthropic provider
- `src/khoj/processor/conversation/google/gemini_chat.py` -- Google provider
- `src/khoj/processor/conversation/offline/chat.py` -- Local/Ollama provider

## Chat Pipeline Stages

### 1. Intent Detection

When a user sends a message, Khoj first uses the configured chat model to determine intent:
- **What data sources to query** (personal knowledge base, web, none)
- **What output mode** (text, image, diagram, code)
- **What tools to invoke** (search, online search, code execution, computer use)
- **Inferred search queries** -- the LLM reformulates the user's message into optimal search queries

This is an LLM call specifically for routing/planning, separate from the final response generation. The intent detection prompt asks the model to classify the query and extract structured output indicating which tools and data sources are needed.

### 2. Context Retrieval

Based on intent detection results, Khoj retrieves context from multiple sources:

**Knowledge Base Search:**
- User's query (and LLM-inferred queries) are used to search the personal document index
- Uses the two-stage retrieval pipeline (bi-encoder + cross-encoder reranking)
- Returns ranked document chunks with source metadata

**Online Search:**
- When the intent detector determines fresh information is needed
- Queries SearxNG (self-hosted search) or configured search provider
- Results are scraped and summarized

**Code Execution:**
- When computational tasks are detected
- Generates Python code, runs in Terrarium sandbox
- Returns execution results (text, plots, data)

**Conversation History:**
- Recent messages from the current conversation
- Managed by `construct_chat_history()` in `utils.py`

**User Memory:**
- Long-term user preferences and facts (stored in `UserMemory` model)
- Injected into system prompt context

### 3. Context Assembly & Prompt Construction

The `generate_chatml_messages_with_context()` function (in `utils.py`) assembles the final prompt:

```
System message:
  - Base system prompt (from prompts.py)
  - Agent persona (if using custom agent)
  - Personality context (agent's configured personality)
  - User memory notes

Context section:
  - Retrieved document chunks (formatted with source references)
  - Online search results
  - Code execution results
  - Operator/computer results

Conversation history:
  - Recent messages (truncated to fit token budget)

Current user message:
  - The actual query + any attached images/files
```

**Token Budget Management:**
- Each LLM model has a mapped max prompt size (in `model_to_prompt_size` dict in `utils.py`)
- The system prompt is always preserved (never truncated)
- Older conversation messages are dropped first when exceeding limits
- If still over budget, the current message is truncated
- This ensures the system prompt and persona guidance always reach the model

### 4. LLM Generation

Provider-specific `converse_*` functions handle the actual LLM call:
- `converse_openai()` -- OpenAI and any OpenAI-compatible API (including Ollama)
- `converse_anthropic()` -- Anthropic Claude models
- `converse_gemini()` -- Google Gemini models
- Each handles streaming, error recovery, and provider-specific quirks

All providers produce a streaming response sent to the client via SSE with structured `ChatEvent` objects.

### 5. Response Persistence

`save_to_conversation_log()` stores the complete turn:
- User query and Khoj response text
- Compiled references (document chunks used)
- Online search results
- Code execution results
- Operator results
- Inferred queries (from intent detection)
- Intent type classification
- Generated images/diagrams
- Research iterations (for research mode)
- "Train of thought" (intermediate reasoning steps)

## Conversation Modes

### Default Mode
Standard RAG chat. Single-pass: intent detection -> retrieval -> response.

### Research Mode (`/research`)
Iterative multi-step reasoning. The agent:
1. Formulates an initial research plan
2. Executes multiple retrieval cycles (web search + knowledge base)
3. Synthesizes findings across iterations
4. Produces a comprehensive answer with citations

Performance: Research mode achieved 63.5% on FRAMES benchmark (vs 42% for default mode) -- a 51.2% improvement. Effectively upgrades small models to match larger model performance.

Research iterations are tracked via `ResearchIteration` objects that capture each step's queries, results, and reasoning.

### Slash Commands
- `/research` -- Research mode
- `/general` -- General chat (no personal knowledge base context)
- `/notes` -- Search only personal knowledge base
- `/default` -- Standard RAG mode
- `/online` -- Search only the web
- `/image` -- Generate an image
- `/help` -- List available commands

## Multi-Turn Conversation Handling

- Conversations are stored as `Conversation` model instances in PostgreSQL
- Each conversation has an ordered list of message turns
- `construct_chat_history()` builds the message list for the LLM
- History is truncated from oldest messages to fit within model context window
- Each turn stores: user message, Khoj response, intent metadata, tool results, references
- Conversations are scoped per user and optionally per agent

## Streaming Architecture

- Chat responses stream via SSE (Server-Sent Events)
- Django runs under Gunicorn with Uvicorn workers (ASGI) for async support
- `ChatEvent` objects structure the stream: status updates, partial text, references, images
- The frontend receives progressive updates: thinking indicators, partial responses, final references

## Key Design Patterns

1. **LLM-as-router**: Uses the chat model itself for intent detection/routing, not a separate classifier
2. **Provider abstraction**: Unified `converse_*` interface across all LLM providers
3. **Token-aware truncation**: Systematic priority (system prompt > context > history > query)
4. **Structured persistence**: Every aspect of a turn is saved for later retrieval/analysis
5. **Mode-based behavior**: Slash commands switch between fundamentally different processing pipelines
6. **Tool results as context**: Tool outputs are injected as additional context, not separate messages
