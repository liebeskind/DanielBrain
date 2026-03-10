# Data Model & Graph

Baseline: `c9370a8b` (2026-03-08)

## Core Models

### Node

**File:** `cognee/shared/data_models.py`

```python
class Node:
    id: str
    name: str
    type: str
    description: str
    label: str  # optional, used for Gemini compatibility
```

Extended properties in graph storage:
- `slug` — URL-friendly identifier
- `user_id` — owner for multi-tenant scoping
- `dataset_id` — dataset membership
- `indexed_fields` — fields that should be indexed for search
- `attributes` — arbitrary key-value metadata

### Edge

```python
class Edge:
    source_node_id: str
    destination_node_id: str
    relationship_name: str
    attributes: dict        # arbitrary metadata
    data_id: str           # reference to source data
    dataset_id: str        # dataset scoping
```

### KnowledgeGraph

```python
class KnowledgeGraph:
    nodes: List[Node]
    edges: List[Edge]
```

This is the output type from entity extraction — the LLM returns a `KnowledgeGraph` containing all extracted entities (nodes) and relationships (edges). Instructor/BAML enforces this schema on LLM output.

## DataPoint Base Class

`DataPoint` is the base class for any object that can be stored in the graph. It provides:

- `index_fields` metadata — declares which fields should be automatically indexed
- Automatic graph integration — DataPoints are converted to graph nodes when persisted
- Type information for collection-based partitioning in the vector store

This enables a pattern where domain-specific models (e.g., `DocumentChunk`, `Triplet`, `Entity`) inherit from `DataPoint` and automatically participate in graph and vector operations.

## Chunk Schema

Chunks are represented as dictionaries with the following schema:

```python
{
    "text": str,           # chunk content
    "chunk_size": int,     # size in tokens/words
    "chunk_id": UUID5,     # deterministic ID from content
    "paragraph_ids": list, # parent paragraph references
    "chunk_index": int,    # position in document
    "cut_type": str,       # how the chunk was split (paragraph_end, sentence_end, etc.)
}
```

Key design choices:
- **UUID5** for chunk IDs — deterministic from content, enabling dedup
- **paragraph_ids** — maintains hierarchy from source document structure
- **cut_type** — records the chunking decision for debugging and analysis

## Collection-Based Partitioning

Different entity types are stored in separate vector collections:
- `DocumentChunk_text` — chunk embeddings for semantic search
- `Triplet_text` — relationship triple embeddings
- Entity-type-specific collections

This allows retrievers to target specific collections (e.g., `ChunksRetriever` queries `DocumentChunk_text`, `TripletRetriever` queries `Triplet_text`).

## Graph Structure

The knowledge graph stores:

1. **Document nodes** — source documents
2. **Chunk nodes** — text chunks linked to documents
3. **Entity nodes** — extracted people, organizations, concepts, etc.
4. **Relationship edges** — typed connections between entities
5. **Chunk associations** — semantic links between related chunks

### Example Graph Fragment

```
[Document: "meeting-notes.txt"]
    │ contains
    ▼
[Chunk: "Alice discussed the Q4 budget..."]
    │ mentions        │ mentions
    ▼                 ▼
[Entity: Alice]  [Entity: Q4 Budget]
    │ works_at
    ▼
[Entity: Acme Corp]
```

## Metadata-Driven Indexing

The `index_fields` mechanism on `DataPoint` allows models to declare which fields should be:
- Embedded in the vector store
- Indexed in the graph database
- Available for retrieval

This is a form of declarative indexing — the model defines *what* to index, and the storage layer handles *how*.

## Contrast with TopiaBrain

| Aspect | Cognee | TopiaBrain |
|--------|--------|------------|
| Entity model | Node class + graph DB | `entities` table in PostgreSQL |
| Relationship model | Edge class + graph DB | `thought_entities` junction table |
| Chunk model | Dict with UUID5 | `thoughts` table (child rows for chunks) |
| Graph storage | Kuzu/Neo4j | PostgreSQL tables + `entity_relationships` |
| Schema enforcement | Instructor/BAML structured output | Explicit prompts + JSON.parse |
| Collection partitioning | Multiple vector collections | Single `thoughts` table with type column |
| Entity-to-entity links | First-class edges in graph DB | `entity_relationships` table (schema ready, not populated) |

**Notable:** Cognee's `entity_relationships` equivalent is a core feature powered by LLM extraction. TopiaBrain has the table (`entity_relationships`) but hasn't populated it yet (Phase 10). This is an area where cognee's patterns could inform our implementation.
