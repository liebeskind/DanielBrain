# Mem0 Graph Memory

## Overview

Graph memory is an **optional, parallel layer** on top of vector memory. It persists nodes (entities) and edges (relationships) in a graph database, enriching retrieval with structured relational data. Vector search provides the primary ranking; graph context adds related entities in a `relations` array without reordering vector hits.

## Enabling Graph Memory

```python
from mem0 import Memory

config = {
    "graph_store": {
        "provider": "neo4j",
        "config": {
            "url": "neo4j+s://your-instance.databases.neo4j.io",
            "username": "neo4j",
            "password": "your-password",
        }
    }
}

memory = Memory.from_config(config)
memory.add([{"role": "user", "content": "Alice met Bob at GraphConf"}], user_id="demo")
results = memory.search("Who did Alice meet?", user_id="demo")
```

Can be toggled per-request: `enable_graph=False` for vector-only.

## Supported Graph Backends

| Provider | Type | Notes |
|----------|------|-------|
| Neo4j Aura | Managed cloud | Free tier, requires Bolt URI |
| Neo4j (self-hosted) | Docker | Used in docker-compose stack (port 7687) |
| Memgraph | Docker/local | Requires `--schema-info-enabled=True` |
| Neptune Analytics | AWS managed | Match vector dimensions, enable public connectivity |
| Neptune DB | AWS cluster | Cluster-based with external vectors |
| Kuzu | Embedded/in-process | Path or `:memory:` option, simplest setup |

## Entity Extraction Pipeline

### Step 1: Extract Entities (LLM tool call)

Source: `mem0/memory/graph_memory.py` -> `_retrieve_nodes_from_data()`

The LLM identifies entities and their types from input text using the EXTRACT_ENTITIES_TOOL schema:

```python
# Tool schema for entity extraction
{
    "name": "extract_entities",
    "description": "Identifies entities and classifies them by type",
    "parameters": {
        "entities": [{"name": str, "type": str}]
    }
}
```

Rules:
- Replace self-references (I, me, my) with the user_id
- Normalize to lowercase with underscores replacing spaces
- Classify entity types (Person, Location, Event, etc.)

### Step 2: Extract Relationships (LLM tool call)

Source: `mem0/memory/graph_memory.py` -> `_establish_nodes_relations_from_data()`

Uses EXTRACT_RELATIONS_PROMPT + RELATIONS_TOOL:

```python
# Tool schema for relationship extraction
{
    "name": "establish_relationships",
    "parameters": {
        "source": str,
        "relationship": str,       # Concise, timeless label
        "destination": str
    }
}
```

EXTRACT_RELATIONS_PROMPT key principles:
- Extract only explicitly stated information
- Use user_id for self-references
- Employ consistent, timeless relationship types
- Maintain entity naming consistency

### Step 3: Node Deduplication

Source: `mem0/memory/graph_memory.py` -> `_add_entities()`

For each (source, relationship, destination) triplet:

1. **Embed source entity** using embedding model
2. **Search graph** for existing nodes with cosine similarity >= threshold (default 0.7)
3. **Embed destination entity** and search similarly
4. **Four dedup paths:**

```
Case 1: Both nodes found    -> Create edge only, increment mentions
Case 2: Source found only    -> Create destination node, create edge
Case 3: Destination found    -> Create source node, create edge
Case 4: Neither found        -> Create both nodes and edge
```

The similarity threshold is configurable:
- 0.5-0.7: loose matching for entities with similar embeddings
- 0.9+: strict matching for precise dedup

### Step 4: Conflict Resolution for Edges

Uses DELETE_RELATIONS_SYSTEM_PROMPT to determine which edges to remove:

- Delete only when information is **outdated, inaccurate, or contradictory**
- Preserve relationships that can coexist:
  - "alice -- loves_to_eat -- pizza" should NOT be deleted when "alice -- loves_to_eat -- burger" arrives
- Mark contradicted relationships as invalid rather than physically removing (temporal preservation)

## Graph Querying (Search)

Source: `mem0/memory/graph_memory.py` -> `search()` and `_search_graph_db()`

### Dual Retrieval Strategy

**1. Entity-centric retrieval:**
- Identify key entities in query
- Locate corresponding nodes via semantic similarity (embedding search)
- Explore incoming AND outgoing relationships from anchor nodes
- Construct comprehensive subgraph

**2. Semantic triplet retrieval:**
- Encode entire query as dense embedding
- Match against textual encodings of each relationship triplet
- Rank by similarity threshold

### Neo4j Cypher Query Pattern

```cypher
MATCH (n)
WHERE n.embedding IS NOT NULL
WITH n, vector.similarity.cosine(n.embedding, $query_embedding) AS similarity
WHERE similarity >= $threshold
MATCH (n)-[r]->(m)  // outgoing
UNION
MATCH (n)<-[r]-(m)  // incoming
RETURN source, relationship, destination, similarity
```

### BM25 Reranking

After vector similarity search, results are reranked using BM25Okapi for better lexical matching:

```python
from rank_bm25 import BM25Okapi
# Tokenize relationship descriptions
# Rerank by BM25 scores
```

## Graph Memory Data Structures

### Search Result Format

```python
{
    "source": "alice",
    "source_id": "neo4j_element_id",
    "relationship": "met_at",
    "relation_id": "neo4j_element_id",
    "destination": "graphconf",
    "destination_id": "neo4j_element_id",
    "similarity": 0.85
}
```

### Entity-Type Map

```python
entity_type_map = {
    "alice": "Person",
    "graphconf": "Event",
    "acme_corp": "Organization"
}
```

## Graph vs Vector: When Each Excels

| Scenario | Vector Memory | Graph Memory |
|----------|--------------|--------------|
| Simple fact recall | Better (67.13 accuracy) | Good (65.71) |
| Multi-hop reasoning | Better (51.15) | Lower (47.19) |
| Temporal reasoning | Good (55.51) | **Better (58.13)** |
| Open-domain QA | Good (72.93) | **Better (75.71)** |
| Multiple actors/objects | Blurs together | **Excels** (structured) |
| Token efficiency | ~7k per conversation | ~14k per conversation |

Graph memory adds ~2% overall improvement but significantly helps when "conversation history mixes multiple actors and objects that vectors alone blur together."

## Operational Considerations

- **Graph growth**: Prune dormant nodes older than 90 days
- **Fallback**: Catch provider errors and retry with vector-only search
- **Custom prompts**: Guide which relationships become nodes via `custom_prompt` config
- **Confidence thresholds**: Set `threshold=0.75` to exclude noisy edges
- **Compliance**: Tracks "who said what and when" for auditing
