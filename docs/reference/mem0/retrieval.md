# Mem0 Retrieval

## search() Method

```python
results = memory.search(
    query="What does Alice like?",
    user_id="alice",
    filters={"category": "preferences"},
    limit=10
)
```

## Vector Search Pipeline

### Step 1: Filter Construction

Session identifiers (user_id, agent_id, run_id) become mandatory filters. Custom metadata filters are layered on top.

### Step 2: Query Embedding

The query string is embedded using the configured embedding model (default: text-embedding-3-small, or nomic-embed-text for Ollama).

### Step 3: Vector Similarity Search

The embedded query is searched against the vector store with:
- Cosine similarity metric
- Configurable limit (default varies by context: 5 for update comparison, user-specified for search)
- Threshold filtering (minimum similarity score)
- Metadata filtering applied at the store level

### Step 4: Optional Reranking

If a reranker is configured:
```python
reranked = reranker.rerank(query, memories, limit)
```
Failures are logged but do not break search (graceful degradation).

### Step 5: Result Formatting

Metadata keys are promoted to top level:
```python
{
    "id": "uuid",
    "memory": "Prefers dark mode",
    "score": 0.92,
    "user_id": "alice",        # promoted from metadata
    "agent_id": "bot-v2",      # promoted from metadata
    "actor_id": "user",        # promoted
    "role": "user",            # promoted
    "metadata": {...}          # remaining custom metadata
}
```

## Graph Retrieval (Parallel)

When graph memory is enabled, graph retrieval runs **in parallel** with vector search. Results are added to the response as a `relations` array -- they do NOT reorder vector hits.

### Entity-Centric Retrieval

1. Identify key entities in the query
2. Embed entity names
3. Find matching nodes via cosine similarity (threshold default: 0.7)
4. For each anchor node, traverse:
   - Outgoing: `(node)-[r]->(target)`
   - Incoming: `(source)-[r]->(node)`
5. Collect all connected relationships into subgraph

### Semantic Triplet Retrieval

1. Encode entire query as dense embedding
2. Match against textual encodings of stored relationship triplets
   - Triplet text format: `"source -- relationship -- destination"`
3. Rank by cosine similarity
4. Filter by threshold

### BM25 Reranking of Graph Results

Graph search results are reranked using BM25Okapi (from rank_bm25 library):
- Tokenize relationship descriptions
- Score against query tokens
- Reorder by BM25 score

This provides lexical matching as a complement to semantic similarity.

## Advanced Metadata Filtering

### Simple Filters
```python
memory.search("query", user_id="alice", filters={"key": "value"})
# Translates to: exact match on metadata
```

### Advanced Operators
```python
# Comparison operators
{"age": {"gt": 25}}        # Greater than
{"age": {"gte": 25}}       # Greater than or equal
{"age": {"lt": 50}}        # Less than
{"age": {"lte": 50}}       # Less than or equal
{"status": {"ne": "archived"}}  # Not equal

# Collection operators
{"tag": {"in": ["work", "personal"]}}     # In list
{"tag": {"nin": ["spam", "deleted"]}}     # Not in list

# String operators
{"name": {"contains": "john"}}     # Case-sensitive substring
{"name": {"icontains": "john"}}    # Case-insensitive substring

# Logical operators
{"AND": [filter1, filter2]}        # All must match
{"OR": [filter1, filter2]}         # Any must match
{"NOT": filter}                    # Negation
```

### Filter Processing

Platform syntax is converted to vector store format:
- `AND` -> `$and`
- `OR` -> `$or`
- `NOT` -> `$not`

Each vector store implementation handles its own filter translation.

## Combined Results Format

```json
{
    "results": [
        {
            "id": "uuid-1",
            "memory": "Alice prefers dark mode",
            "score": 0.95,
            "user_id": "alice"
        },
        {
            "id": "uuid-2",
            "memory": "Alice works at Acme Corp",
            "score": 0.87,
            "user_id": "alice"
        }
    ],
    "relations": [
        {
            "source": "alice",
            "relationship": "works_at",
            "destination": "acme_corp",
            "similarity": 0.89
        },
        {
            "source": "alice",
            "relationship": "prefers",
            "destination": "dark_mode",
            "similarity": 0.82
        }
    ]
}
```

Vector results are ordered by similarity score. Graph relations are a supplementary array (not merged or reranked with vector results).

## Performance

- p50 search latency: 0.148s (vector only)
- p95 total latency: 1.440s (including all processing)
- Compared to full-context retrieval: 91% lower p95 latency
