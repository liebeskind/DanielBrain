# GraphRAG — Indexing Pipeline

## Full Pipeline Steps

```
LoadDocuments
  → ChunkDocuments (TextUnits)
    → [Parallel]
       → ExtractGraph (entities + relationships per chunk)   [LLM Call 1]
       → ExtractClaims (covariates, optional)                [LLM Call, optional]
       → EmbedChunks (text unit embeddings)                  [Embedding Call]
    → MergeEntities (dedup by name+type, accumulate descriptions)
    → SummarizeDescriptions (entity + relationship summaries) [LLM Call 2]
    → EmbedEntities (entity description embeddings)           [Embedding Call]
    → DetectCommunities (Hierarchical Leiden)                 [No LLM — algorithmic]
    → GenerateCommunityReports                                [LLM Call 3]
    → SummarizeCommunityReports                               [LLM Call 4]
    → EmbedCommunityReports                                   [Embedding Call]
```

## LLM Calls Per Step

| Step | LLM Calls | Notes |
|------|-----------|-------|
| Entity/Relationship Extraction | 1 per chunk + max_gleanings re-passes | ~75% of total cost |
| Claims Extraction | 1 per chunk (if enabled) | Optional, disabled by default |
| Description Summarization | 1 per unique entity + 1 per unique relationship | After merge |
| Community Report Generation | 1 per community at each level | Scales with community count |
| Community Report Summarization | 1 per community | Shorthand summaries |

## Entity Extraction Prompt (core structure)

```
-Goal-
Given a text document and a list of entity types, identify all entities
of those types and all relationships among them.

-Steps-
1. Identify all entities. For each:
   - entity_name: capitalized name
   - entity_type: one of [PERSON, ORGANIZATION, LOCATION, ...]
   - entity_description: comprehensive description

   Format: ("entity"{tuple_delimiter}<name>{tuple_delimiter}<type>{tuple_delimiter}<description>)

2. Identify all (source_entity, target_entity) pairs that are clearly related:
   - relationship_description
   - relationship_strength: integer 1-10

   Format: ("relationship"{tuple_delimiter}<source>{tuple_delimiter}<target>{tuple_delimiter}<description>{tuple_delimiter}<strength>)
```

**Gleanings**: after initial extraction, model prompted again with "MANY entities were missed" to catch stragglers. `max_gleanings: 2` = up to 2 additional passes.

## Cost Considerations

- Graph extraction is ~75% of total indexing cost
- Original paper: costs scale significantly with corpus size
- `--estimate-cost` CLI flag previews token counts before indexing

## FastGraphRAG Alternative

```bash
graphrag index --method fast
```

- Replaces LLM entity extraction with NLP (NLTK + spaCy noun phrase extraction)
- Relationships defined by co-occurrence, no descriptions
- No summarization step
- Community reports use actual text content rather than entity descriptions
- ~75% cost reduction but "noisier" graphs

## LazyGraphRAG

Achieves comparable quality to full GraphRAG Global Search at **0.1% of indexing cost**.

- Indexing: NLP noun phrase extraction (no LLM calls) for concepts and co-occurrence
- Community detection: lightweight graph statistics, not LLM-summarized
- No pre-summarization or embedding during indexing
- All "smart" work deferred to query time
- Trade-off: higher query-time cost but far lower than Global Search's map-reduce
