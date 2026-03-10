# GraphRAG — Retrieval / Query System

## Local Search (entity-centric)

Best for: specific questions about particular entities, events, or facts.

1. **Entity matching**: embed query, find top-K entities by cosine similarity on entity description embeddings
2. **Graph traversal**: for each matched entity, pull connected entities, relationship descriptions, community reports, covariates, text units
3. **Context assembly**: rank and filter all candidate data to fit within `max_context_tokens` (default: 12,000)
4. **LLM call**: single call with assembled context + query

```yaml
local_search:
  top_k_entities: 10
  top_k_relationships: 10
  max_context_tokens: 12000
```

## Global Search (map-reduce over communities)

Best for: broad thematic questions, dataset-wide summaries, "what are the main themes?"

1. **Select community level**: lower = more detail but more tokens
2. **Map phase**: for each community report chunk, LLM generates key points with importance scores (0-100)
3. **Reduce phase**: collect all points, rank by importance, filter top-N, LLM generates final response

**Cost**: expensive at query time — every community report gets an LLM call in map step. Lower levels = more reports = higher cost.

```yaml
global_search:
  dynamic_search_threshold: 5
  allow_general_knowledge: false  # true increases hallucination risk
```

## DRIFT Search (Dynamic Reasoning and Inference with Flexible Traversal)

Best for: questions needing both breadth and depth. Hybrid of local and global.

**Three phases**:
1. **Primer**: compare query against top-K semantically relevant community reports. Generate initial answer + follow-up questions.
2. **Follow-Up**: use follow-up questions to drive local search iterations. Each iteration refines the answer. Repeat for `n_depth` iterations.
3. **Output Hierarchy**: rank all intermediate results by relevance, combine global insights with local refinements.

```yaml
drift_search:
  n_depth: 3
  drift_k_followups: 10
```

**Key innovation**: starts with community context (global breadth) then drills into entity-level detail (local depth). More diverse facts than pure local, cheaper than pure global.

## Context Window Assembly (all modes)

All search modes follow the same pattern:
1. Gather candidate data sources (entities, relationships, communities, text units, covariates)
2. Rank by relevance to query
3. Greedily pack into context window up to token budget
4. Higher-priority sources included first; lower-priority truncated or dropped

## For TopiaBrain: Simplified Global Search

Instead of full map-reduce (many LLM calls), do vector search over community summary embeddings, pull top-K communities, use those as context for a single LLM call. Much cheaper and works with 8B models.
