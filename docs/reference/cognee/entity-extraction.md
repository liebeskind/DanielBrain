# Entity Extraction & Ontology

Baseline: `c9370a8b` (2026-03-08)

## Extraction Pipeline

The entity extraction pipeline runs as part of `cognify()`:

```
chunk_text
  → extract_entities (parallel, LLM-powered)
  → filter_edges
  → resolve_ontology
  → integrate_knowledge_graph
  → persist
```

### Step-by-Step

1. **Extract** — LLM extracts entities and relationships from each chunk, returning a `KnowledgeGraph` (List[Node] + List[Edge])
2. **Filter edges** — Remove low-quality or redundant edges
3. **Ontology resolve** — Match extracted entities against known ontology terms
4. **Integrate** — Merge into the existing knowledge graph (dedup, merge)
5. **Persist** — Write to graph DB and embed in vector store

Extraction runs in parallel across chunks for throughput.

## Two Extraction Versions

**Directory:** `cognee/tasks/graph/`

Cognee maintains two coexisting extraction implementations:

- **v1** — Original extraction pipeline
- **v2** — Newer extraction with improved prompting and schema

Both produce `KnowledgeGraph` output. The version is configurable. This suggests the extraction pipeline is still actively evolving, and backward compatibility is maintained during transition.

## Structured Output Dependency

Entity extraction depends on **Instructor** (and optionally **BAML**) for structured LLM output:

```python
# Conceptual — Instructor enforces KnowledgeGraph schema on LLM response
response = instructor.patch(llm).create(
    response_model=KnowledgeGraph,
    messages=[{"role": "user", "content": chunk_text}]
)
# response.nodes: List[Node]
# response.edges: List[Edge]
```

**This is the critical bottleneck for small models.** Instructor validates LLM output against Pydantic schemas. When the model produces malformed JSON (common with 8B models), the entire extraction fails. See [comparison-to-topiabrain.md](comparison-to-topiabrain.md) for on-prem viability details.

## Ontology Resolver

**Directory:** `cognee/modules/ontology/`

### Abstract Base

The ontology resolver defines three core methods:

| Method | Purpose |
|--------|---------|
| `build_lookup()` | Create an index/lookup table from known ontology terms |
| `find_closest_match()` | Match an extracted entity to the closest known term |
| `get_subgraph()` | Retrieve the ontology subgraph around a matched term |

### FuzzyMatchingStrategy

**Default matching implementation:**

- Uses Python's `difflib.SequenceMatcher` for string similarity
- **Cutoff: 0.8** (80% similarity required for a match)
- Matches extracted entity names against ontology terms
- If no match above cutoff, the entity is treated as new

### RDFLib Ontology Files

- Ontology defined in RDF/OWL files
- Files specified via configuration (comma-separated list)
- Parsed using RDFLib
- Provides the vocabulary of known entity types and relationship types

### Resolution Flow

```
Extracted entity: "Alice Johnson"
         │
         ▼
  build_lookup() → index of known entities
         │
         ▼
  find_closest_match("alice johnson") → {match: "Alice M. Johnson", score: 0.92}
         │
         ▼
  score >= 0.8? → merge with existing entity
  score <  0.8? → create new entity
```

## Code Analysis

Beyond text extraction, `cognee/tasks/graph/` includes code-specific extraction:
- Code analysis tasks for extracting entities from source code
- Function/class/module relationships
- Import graphs

## Contrast with TopiaBrain

| Aspect | Cognee | TopiaBrain |
|--------|--------|------------|
| Extraction method | LLM structured output (Instructor) | LLM JSON extraction + explicit prompts |
| Schema enforcement | Pydantic model validation | Manual JSON.parse + fallback handling |
| Entity matching | FuzzyMatchingStrategy (difflib, 0.8) | normalizeName() + alias lookup + prefix matching |
| Ontology | RDFLib ontology files | No formal ontology (entity_type enum) |
| Failure handling | Extraction fails if JSON malformed | Junk filter catches hallucinations, pipeline continues |
| Confidence gating | None | Confidence-gated proposals for uncertain matches |
| Human review | None | Approvals queue for low-confidence operations |

### What's Worth Adopting

**Ontology resolver pattern** — Even without RDFLib, the abstract interface (build_lookup, find_closest_match, get_subgraph) is a clean pattern. We could implement it on top of our existing entity table:
- `build_lookup()` → query entities table for canonical + alias names
- `find_closest_match()` → our existing normalizeName + prefix match, but with configurable fuzzy fallback
- `get_subgraph()` → query entity_relationships for connected entities

**Fuzzy matching as a fallback** — We currently do exact canonical match → alias match → prefix match. Adding fuzzy matching (difflib or similar) as a fourth tier could catch more matches, especially for misspellings in meeting transcripts.

### What to Skip

**Instructor/BAML** — Our explicit prompts with few-shot examples work better with llama3.1:8b than schema-enforced structured output. The 8B model can follow format instructions but fails schema validation.

**RDFLib ontology** — Overkill for our use case. Our entity_type enum provides sufficient categorization.
