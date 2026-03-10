# Mem0 vs TopiaBrain Comparison

## Architecture Comparison

| Aspect | Mem0 | TopiaBrain |
|--------|------|------------|
| **Storage** | Pluggable vector store (26 options) + optional graph (Neo4j/etc.) + SQLite history | PostgreSQL + pgvector (single DB) |
| **Graph** | Optional Neo4j/Memgraph/Kuzu for entity relationships | Entity table in PostgreSQL with junction tables |
| **LLM** | Default: OpenAI (gpt-4.1-nano). Swappable to Ollama | Ollama only (llama3.1:8b). Hard constraint: no cloud LLM |
| **Embeddings** | Default: text-embedding-3-small. Swappable to Ollama | nomic-embed-text via Ollama only |
| **Transport** | Python library / REST API / MCP (5 tools) | MCP server only (8 tools) |
| **HITL** | None. Fully automated memory lifecycle | Confidence-gated approvals queue with admin dashboard |
| **Data unit** | Atomic fact ("Name is John") | Thought (message, summary, action item, etc.) |
| **Scoping** | user_id / agent_id / run_id | Visibility: public/private/team (planned) |
| **Entity model** | Graph nodes with types + edges | First-class entity table with types, profiles, aliases |
| **Input sources** | Programmatic (add() calls) | Slack, Telegram, Fathom webhooks, MCP save_thought |

## What Mem0 Does Better

### 1. Memory Deduplication & Conflict Resolution
Mem0's LLM-driven ADD/UPDATE/DELETE/NOOP lifecycle is its core innovation. When you add "I moved to NYC," it automatically finds and updates/deletes the old "I live in SF" memory. TopiaBrain stores every thought as-is with no dedup or contradiction resolution.

**Pattern to adopt:** LLM-based fact comparison for dedup. When a new thought contradicts an existing one, flag it (via our proposals queue) or auto-update.

### 2. Atomic Fact Extraction
Mem0 extracts individual facts from conversations, making each independently searchable and updatable. TopiaBrain stores whole messages/summaries as thoughts, which can dilute search relevance.

**Pattern to adopt:** Extract atomic facts as a post-processing step (like our entity extraction but for facts). Store as linked metadata or child records.

### 3. Pluggable Backend Architecture
26 vector stores, 20 LLM providers, 15 embedding providers. Clean abstract interfaces (VectorStoreBase, LLM base class). We have a single-stack approach.

**Not needed:** Our single-stack (Postgres + Ollama) is a feature, not a limitation. Simpler deployment, no dependency sprawl.

### 4. Memory History / Audit Trail
Every memory change tracked: previous value, new value, event type, actor. Enables undo and compliance auditing.

**Pattern to adopt:** We have proposals history but not per-thought change tracking. Worth adding for the entity graph especially.

## What TopiaBrain Does Better

### 1. Human-in-the-Loop Quality Control
Our confidence-gated proposals queue has no equivalent in Mem0. Mem0 trusts the LLM completely for ADD/UPDATE/DELETE decisions. For an 8B model, this is risky -- our approach of auto-apply + reviewable proposal for low-confidence operations is superior.

### 2. Rich Entity Profiles
Our entities have LLM-generated profiles, vector embeddings for entity-level search, staleness tracking, alias management, and mention counts. Mem0's graph nodes are bare (name + type + embedding + mentions counter).

### 3. Multi-Source Ingestion
Slack webhooks, Telegram webhooks, Fathom meeting transcripts, MCP tool -- we have real data pipelines. Mem0 is purely programmatic (call add() from your code).

### 4. MCP Tool Richness
8 tools covering search, browse, stats, save, entity lookup, context intersection, and timeline. Mem0's MCP has 5 simpler tools (add, search, list, delete, delete_all).

### 5. On-Prem by Design
Data sovereignty is our hard constraint. Mem0 defaults to cloud (OpenAI) and treats local as an alternative. Our system was built local-first.

### 6. Structured Thought Types
We distinguish thought types (message, summary, action_item, meeting_note, etc.) with source metadata. Mem0 has undifferentiated memory facts.

## On-Prem Viability of Mem0

### Can It Work with Ollama?

**Yes**, with caveats:

```python
config = {
    "llm": {
        "provider": "ollama",
        "config": {
            "model": "llama3.1:latest",
            "ollama_base_url": "http://localhost:11434",
            "temperature": 0,
            "max_tokens": 2000
        }
    },
    "embedder": {
        "provider": "ollama",
        "config": {
            "model": "nomic-embed-text:latest",
            "ollama_base_url": "http://localhost:11434"
        }
    },
    "vector_store": {
        "provider": "qdrant",
        "config": {
            "host": "localhost",
            "port": 6333,
            "embedding_model_dims": 768
        }
    }
}
```

### LLM Call Requirements

Every `add()` requires **2-4 LLM calls** (fact extraction + update decision + optional graph calls). With llama3.1:8b:

- **Fact extraction**: Needs to output valid JSON. 8B models can do this but are less reliable than GPT-4 class models
- **Update decision**: Complex reasoning comparing multiple memories. This is where 8B models will struggle most -- the prompt requires nuanced semantic comparison
- **Graph entity extraction**: Tool-calling format. Works with Ollama structured output support
- **Graph relationship extraction**: Requires understanding context to generate meaningful triplets

**Key risk:** The UPDATE decision prompt is complex (distinguish between "same meaning different words" vs "contradictory information" vs "complementary information"). An 8B model will make more errors here than GPT-4o-mini.

**Mitigation:** Our proposals queue. Run Mem0-style dedup with auto-apply + reviewable proposal for borderline cases.

## Patterns to Adopt from Mem0

### Priority 1: Fact-Level Memory Dedup
- Extract atomic facts from thoughts (we already extract entities, extend to facts)
- Compare new facts against existing using vector similarity
- Use LLM to classify: new, update, contradiction, duplicate
- Route through proposals queue instead of auto-applying (our HITL advantage)

### Priority 2: Memory Update Lifecycle
- Track "previous value" for entity profile changes
- Enable explicit contradiction detection for the entity graph
- Add change history per entity (not just per proposal)

### Priority 3: Customizable Prompts
- Mem0 allows `custom_fact_extraction_prompt` and `custom_update_memory_prompt`
- We should make our extraction and summarization prompts configurable per source

### Lower Priority
- BM25 reranking of graph results (useful when we add entity-to-entity relationships)
- Procedural memory type (tracking agent execution patterns)
- Agent-scoped memory (when we have multiple AI agents)

## What NOT to Adopt

- **Pluggable backend abstraction**: We don't need 26 vector stores. Our single Postgres + pgvector stack is simpler and sufficient
- **Cloud LLM default**: Violates our data sovereignty constraint
- **No HITL**: Their fully-automated approach doesn't work for our quality bar
- **Separate graph database**: Neo4j adds operational complexity. Our in-Postgres entity graph is adequate and simpler
- **SQLite for history**: We should keep everything in Postgres
- **Bare graph nodes**: Our rich entity profiles are far more useful than Mem0's name+type+embedding nodes
