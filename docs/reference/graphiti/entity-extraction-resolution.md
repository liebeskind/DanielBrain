# Graphiti Entity Extraction & Resolution

## Entity Extraction

### Process

Entity extraction is the first phase of episode processing. The system uses LLM structured output to extract entities from episode text.

**Inputs to the LLM**:
1. Current episode content (the message/text being processed)
2. Previous N episodes (configurable via `RELEVANT_SCHEMA_LIMIT`) for context/disambiguation
3. List of valid entity types (custom Pydantic models if provided)
4. Custom extraction instructions (optional domain-specific guidance)

**Three extraction prompt variants** based on episode type:
- **Message extraction**: Extracts speaker as first entity, disambiguates pronouns, classifies entities by type
- **JSON extraction**: Extracts entities from structured data fields and properties
- **Text extraction**: Extracts explicit and implicit entities from unstructured text

### Extraction Rules (from prompts)
- Always extract the speaker as the first entity (for messages)
- Disambiguate pronoun references to actual entity names
- Do NOT extract entities representing relationships or actions
- Do NOT extract dates, times, or other temporal information
- Use full names, avoid abbreviations
- Classify using provided entity types
- Exclude entities only mentioned in previous context (not current episode)

### Output Format
Each extracted entity has: `name`, `entity_type` (matching a defined type or generic), and any custom attributes from the Pydantic model.

---

## Entity Resolution (Deduplication)

Entity resolution determines whether newly extracted entities match existing entities in the graph. It uses a two-phase approach: fast similarity matching, then LLM confirmation.

### Phase 1: Similarity-Based Matching

1. For each extracted entity, search the graph for candidate matches using hybrid search (cosine similarity on `name_embedding` + BM25 on `name`)
2. Results are ranked via Reciprocal Rank Fusion (RRF)
3. Build a candidate index mapping extracted entities to potential existing matches
4. Attempt deterministic matching through similarity comparison

This handles straightforward cases (exact name matches, close variations) without LLM overhead.

### Phase 2: LLM-Powered Confirmation

For entities that similarity matching cannot resolve:

1. Send to LLM with:
   - Extracted node details (name, entity type, labels)
   - Existing candidate nodes (full attribute context)
   - Episode context (current + historical content)

2. LLM returns `NodeResolutions` containing `NodeDuplicate` objects:
   ```json
   {
     "id": 1,
     "name": "Alice Johnson",
     "duplicate_name": "alice_johnson"  // existing entity name, or "" if new
   }
   ```

3. Deduplication criteria (from prompt):
   - Entities are duplicates only if they "refer to the same real-world object or concept"
   - Semantic equivalence: descriptive labels that clearly reference a named entity = duplicate
   - Related but distinct entities are NOT duplicates
   - Similar names/purposes but separate instances are NOT duplicates

### Resolution Outcomes

**New entity**: `duplicate_name` is empty string -> create a new `EntityNode` with generated UUID and metadata.

**Merge with existing**: `duplicate_name` references an existing node -> map extracted node UUID to existing node UUID, record the duplicate pair relationship. The existing node is preserved and the extracted node is absorbed.

### Defensive Guardrails
- Ignores malformed LLM responses
- Validates ID ranges from LLM output
- Treats invalid duplicate references as new entities rather than failing
- Never fabricates entity names -- only uses names appearing in existing entities

---

## Edge Building and Relationship Extraction

### Edge Extraction

After entity extraction and resolution, the LLM extracts relationships between entities.

**Inputs**:
1. Current episode content
2. Previous messages context
3. Valid entity names from extraction phase
4. Reference time (ISO 8601 UTC) for temporal resolution
5. Optional predefined relationship/fact types
6. Custom extraction instructions

**Extraction rules**:
- Entity names must match exactly from the provided ENTITIES list
- Source and target must be distinct entities
- No duplicates or hallucinations
- Facts should paraphrase rather than quote source text
- Relation type in SCREAMING_SNAKE_CASE (e.g., `WORKS_AT`, `MANAGES`)

**Temporal resolution rules** (from prompt):
- Present tense relationships -> `valid_at` = reference time
- Terminated relationships -> `invalid_at` = relevant timestamp
- No explicit timing -> both fields remain null
- Date-only mentions -> assume 00:00:00 UTC
- Year-only mentions -> assume January 1st at 00:00:00 UTC
- Format: ISO 8601 with "Z" suffix (e.g., "2025-04-30T00:00:00Z")

**Output per edge**: `source_entity_name`, `target_entity_name`, `relation_type`, `fact` (natural language), `valid_at`, `invalid_at`.

---

## Edge Resolution and Temporal Invalidation

### Edge Deduplication

The edge resolution pipeline (`resolve_extracted_edges`) processes edges through these steps:

**Step 1: In-batch dedup** -- Remove exact duplicates within extracted edges using (source UUID, target UUID, normalized fact) as composite key.

**Step 2: Parallel search** -- For each extracted edge, concurrently:
- Fetch existing edges between the same node pair (related edges)
- Search for semantically similar edges across the graph using hybrid search + RRF

**Step 3: Fast-path matching** -- Compare extracted edge's fact text and node endpoints against existing edges. If verbatim match found after normalization, reuse the existing edge (replace UUID).

**Step 4: LLM dedup + contradiction** -- When fast path fails, LLM evaluates:
- `duplicate_facts`: indices of existing edges that represent identical factual information
- `contradicted_facts`: indices of edges that are contradicted by the new fact

Key LLM rule: A fact can be BOTH a duplicate AND contradicted -- "semantically the same but the new fact updates/supersedes it." Numeric value variations prevent duplicate classification.

### Temporal Invalidation Logic

When contradicted edges are found, the `resolve_edge_contradictions` function applies temporal logic:

```python
# Pseudocode for temporal invalidation
for each contradicted edge:
    if edge.invalid_at <= new_edge.valid_at:
        continue  # Already expired before new fact was valid

    if new_edge.invalid_at <= edge.valid_at:
        continue  # New fact expired before old fact was valid

    if edge.valid_at < new_edge.valid_at:
        edge.invalid_at = new_edge.valid_at  # Old fact ends when new fact begins
        edge.expired_at = utc_now()           # Mark as expired in system time
```

**Critical behavior**: Contradicted edges are never deleted. They get `expired_at` set to current time and `invalid_at` set to the new edge's `valid_at`. This preserves complete history.

### Resolution Output

Three lists returned:
1. **Resolved edges**: All edges after dedup (some with existing UUIDs, some new)
2. **Invalidated edges**: Existing edges marked with `expired_at`
3. **New edges**: Genuinely new edges added to the graph (UUID matches original extraction)

All resolved and invalidated edges get embeddings generated asynchronously.

---

## LLM Calls Per Episode

A single `add_episode()` call makes approximately:

| Step | LLM Calls | Purpose |
|------|-----------|---------|
| Entity extraction | 1 | Extract entities from episode text |
| Entity summary generation | 1 per new entity | Generate/update entity summaries |
| Entity deduplication | 1 per batch of unresolved entities | Confirm similarity matches |
| Edge extraction | 1 | Extract relationships between entities |
| Edge dedup + invalidation | 1 per extracted edge | Compare against existing edges |
| Community summary | 1 per affected community (if enabled) | Update community summaries |

**Typical total**: 5-15+ LLM calls per episode, depending on number of entities and edges extracted. This is the main cost driver -- Graphiti's approach front-loads computation during ingestion to enable LLM-free retrieval.

**Bulk processing** (`add_episode_bulk`) skips edge invalidation and temporal extraction, reducing LLM calls but losing temporal tracking.
