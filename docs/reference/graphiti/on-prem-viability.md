# Graphiti On-Prem Viability

## LLM Requirements

### What LLM Calls Are Made

Per episode ingestion:
1. **Entity extraction** (1 call): Structured output, moderate complexity
2. **Entity summary generation** (1 per new/updated entity): Short summary from context
3. **Entity deduplication** (1 per batch of candidates): Compare entities, return JSON
4. **Edge extraction** (1 call): Extract relationships with temporal metadata, structured output
5. **Edge deduplication + invalidation** (1 per extracted edge): Compare facts, detect contradictions
6. **Community summary** (1 per affected community, if enabled): Map-reduce summarization

**Total per episode**: Typically 5-15+ LLM calls, heavily dependent on entity/edge count.

### Structured Output Requirement

Graphiti requires LLM services that support **structured output** (JSON mode with schema enforcement). This is critical -- the system parses LLM responses as structured JSON objects (Pydantic models). Without reliable structured output, ingestion fails with parsing errors.

Models that support structured output:
- OpenAI GPT-4o, GPT-4o-mini (native structured output)
- Anthropic Claude 3.5+ (tool use for structured output)
- Google Gemini (structured output mode)
- Groq (structured output for larger models)

### Embedding Requirements

- Default: OpenAI embeddings
- Pluggable via `EmbedderClient` abstraction
- Ollama provides OpenAI-compatible API for local embeddings (nomic-embed-text, etc.)

---

## Can It Work With llama3.1:8b?

### Official Guidance

From the Graphiti documentation:

> "Using smaller models may result in incorrect output schemas and ingestion failures."

> "When using Groq, avoid smaller models as they may not accurately extract data or output the correct JSON structures required by Graphiti. Use larger, more capable models like Llama 3.1 70B for best results."

> "When using Ollama, avoid smaller local models as they may not accurately extract data or output the correct JSON structures required by Graphiti."

### Specific Challenges with 8B Models

1. **Structured output reliability**: 8B models frequently produce malformed JSON, missing fields, or incorrect schema adherence. Graphiti's Pydantic validation will reject these, causing silent data loss or ingestion failures.

2. **Entity extraction quality**: Smaller models miss entities, hallucinate entities, fail to disambiguate pronouns, or incorrectly classify entity types.

3. **Edge extraction complexity**: The edge extraction prompt requires understanding temporal expressions, generating SCREAMING_SNAKE_CASE relation types, and correctly pairing source/target entities. 8B models struggle with multi-step reasoning.

4. **Contradiction detection**: The dedup+invalidation prompt requires nuanced comparison of fact semantics. 8B models often fail to detect contradictions or falsely flag non-contradictions.

5. **Temporal reasoning**: Resolving relative timestamps ("two weeks ago") requires arithmetic that 8B models handle unreliably.

### Recommended Minimum for On-Prem

Based on the documentation and community experience:

| Model Size | Viability | Notes |
|------------|-----------|-------|
| 8B (llama3.1:8b) | Poor | Frequent JSON errors, missed entities, bad temporal reasoning |
| 14B (qwen2.5:14b) | Marginal | Better structure adherence, still misses nuance |
| 32B (qwen2.5:32b) | Usable | Reasonable structured output, acceptable extraction quality |
| 70B (llama3.1:70b) | Good | Recommended minimum by Graphiti team |
| 70B+ quantized | Good | Q4/Q5 quantization acceptable with minor quality loss |

**For DGX Spark (128GB unified memory)**: A 70B model at Q4 quantization (~40GB VRAM) is feasible and would be the recommended choice. A 32B model is the absolute minimum for any reliability.

---

## What Would Need to Change for On-Prem

### 1. LLM Client Configuration

Graphiti supports Ollama via its OpenAI-compatible API:

```python
from graphiti_core.llm_client import OpenAIGenericClient

llm_client = OpenAIGenericClient(
    base_url="http://localhost:11434/v1",
    model="llama3.1:70b",
    api_key="ollama",  # Ollama doesn't need a real key
)
```

### 2. Embedding Client Configuration

Ollama provides OpenAI-compatible embedding endpoint:

```python
embedder = OpenAIEmbedder(
    base_url="http://localhost:11434/v1",
    model="nomic-embed-text",
    api_key="ollama",
)
```

### 3. Prompt Optimization

The default prompts are written for GPT-4-class models. For smaller on-prem models:
- Simplify prompt structure
- Add more explicit JSON examples
- Reduce multi-step reasoning requirements
- Add stronger format constraints
- Consider breaking complex prompts into simpler sequential calls

### 4. Error Handling / Retry Logic

Smaller models produce more malformed output. Need:
- Robust JSON parsing with fallbacks
- Retry on parse failure (possibly with simplified prompt)
- Graceful degradation (skip entity if extraction fails, rather than failing entire episode)
- Logging of LLM failures for monitoring quality

### 5. Graph Database

Neo4j is self-hostable. Docker Compose included in repo:
```yaml
services:
  neo4j:
    image: neo4j:5.26
    ports: ["7474:7474", "7687:7687"]
    environment:
      NEO4J_AUTH: neo4j/password
```

FalkorDB and Kuzu are also self-hostable alternatives. Kuzu is embedded (no server).

### 6. Concurrency Tuning

On-prem Ollama handles fewer concurrent requests than cloud APIs:
- Reduce `SEMAPHORE_LIMIT` from 10 to 2-3
- Accept higher ingestion latency
- Consider batching requests

---

## Cost-Benefit: Graphiti vs. TopiaBrain's Approach

| Aspect | Graphiti On-Prem | TopiaBrain Current |
|--------|-----------------|-------------------|
| LLM requirement | 70B minimum | Works with 8B (simpler prompts) |
| LLM calls per message | 5-15+ | 1-2 (extract + summarize) |
| Temporal tracking | Full bi-temporal | Timestamps on thoughts only |
| Graph traversal | Native (Neo4j) | N/A (relational links) |
| Hybrid retrieval | Cosine + BM25 + BFS + RRF | Cosine only |
| Conflict resolution | Automatic (LLM-based) | Manual (proposals queue) |
| Infrastructure | PostgreSQL + Neo4j + Ollama | PostgreSQL + Ollama |
| HITL quality control | None | Proposals/approvals queue |

The key trade-off: Graphiti is more sophisticated but requires a much larger LLM and more compute per message. TopiaBrain's simpler extraction works with 8B models because it doesn't attempt structured output with complex schemas -- it uses explicit DO/DON'T prompts tuned for small models.
