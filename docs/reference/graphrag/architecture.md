# GraphRAG — Architecture

## Two-Pipeline Design

**Indexing Pipeline** (offline, expensive): Transforms raw documents into a structured knowledge model.
- Input: raw text documents (CSV, TXT, JSON)
- Output: Parquet tables + vector embeddings
- Involves 4+ LLM calls per text chunk
- Run once per corpus update

**Query Pipeline** (online, per-request): Uses the indexed knowledge model to answer questions.
- Three search modes: Local, Global, DRIFT
- Assembles context windows from indexed artifacts
- Single LLM call (or map-reduce for Global)

## Code Organization

```
graphrag/
  api/              # Library API definitions
  cache/            # LLM call caching (file, blob, CosmosDB)
  config/           # YAML config validation
  index/            # Indexing engine
    graph/          # Graph extraction logic
    operations/     # Individual pipeline operations
  model/            # Knowledge model data classes
  prompt_tune/      # Auto prompt tuning for new domains
  prompts/          # All system prompts
    index/          # entity_extraction.py, community_report.py, etc.
  query/            # Query engine (local, global, drift)
  storage/          # Storage adapters (file, blob, CosmosDB)
  vector_stores/    # Vector store adapters (lancedb, Azure AI Search)
```

## Configuration System

YAML-based with environment variable interpolation (`${VAR_NAME}`). Key sections:

```yaml
completion_models:
  default_completion_model:
    model_provider: openai     # or ollama-compatible endpoint
    model: gpt-4.1
    retry:
      type: exponential_backoff
      max_retries: 7

chunking:
  type: tokens               # tokens | sentence
  size: 300                   # tokens per chunk
  overlap: 20
  prepend_metadata: [source, date]

extract_graph:
  entity_types: [PERSON, ORGANIZATION, LOCATION]
  max_gleanings: 2            # re-extraction passes

cluster_graph:
  max_cluster_size: 10        # communities larger than this get subdivided
  seed: 42

community_reports:
  max_length: 2000
  max_input_length: 8000
```

## Design Patterns

**Factory pattern**: Every subsystem uses factory-based registration for extensibility — language models, input readers, cache providers, storage adapters, vector stores.

**LLM call caching**: Wraps all completion requests. If same prompt + parameters seen again, cached result returned. Survives pipeline restarts.

**Prompt auto-tuning**: `graphrag prompt-tune` generates domain-specific prompts from sample documents, improving extraction quality for specialized corpora.
