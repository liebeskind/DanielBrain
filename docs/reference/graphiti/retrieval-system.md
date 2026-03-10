# Graphiti Retrieval System

## Design Principle: Zero LLM Calls at Query Time

Graphiti's retrieval is entirely LLM-free. All intelligence is front-loaded during ingestion. At query time, the system uses only: vector search, keyword search, graph traversal, and mathematical reranking. This yields sub-second P95 latency (~300ms) compared to GraphRAG's seconds-to-tens-of-seconds (which requires LLM calls for community-level summarization during retrieval).

---

## Search Methods

### 1. Cosine Similarity (Semantic Search)

Vector-based search using pre-computed embeddings stored on nodes and edges.

- **Entity nodes**: Searched via `name_embedding` (embedding of the entity name)
- **Entity edges**: Searched via `fact_embedding` (embedding of the fact text)
- **Community nodes**: Searched via `name_embedding`

The query is embedded at search time, then compared against stored embeddings using cosine similarity (KNN search via graph database vector indexes).

### 2. BM25 (Full-Text Search)

Keyword-based retrieval using TF-IDF / modified BM25 scoring.

- **Entity edges**: Full-text search on `fact` field
- **Entity nodes**: Full-text search on `name` field
- **Episodes**: BM25 search on `content` field (BM25 is the only search method for episodes)

Implemented via graph database full-text indexes (e.g., Neo4j full-text indexes).

### 3. BFS (Breadth-First Search / Graph Traversal)

Graph-walk discovery starting from specified origin nodes.

- Takes `bfs_origin_node_uuids` as starting points
- Traverses edges up to configurable `bfs_max_depth`
- Discovers entities and edges connected to the origin nodes
- Only available for entity edges and nodes (not episodes or communities)

Useful for: "Give me everything connected to entity X within 2 hops."

---

## Search Scopes

Graphiti searches across four scopes in parallel using `semaphore_gather()`:

| Scope | Available Methods | Description |
|-------|-------------------|-------------|
| **Edges** | Cosine + BM25 + BFS | Fact-level relationships between entities |
| **Nodes** | Cosine + BM25 + BFS | Entity-level search |
| **Episodes** | BM25 only | Raw source data search |
| **Communities** | Cosine + BM25 | Higher-level topic groupings |

Each scope has its own configuration via `SearchConfig`:

```python
SearchConfig(
    edge_config=EdgeSearchConfig(
        search_methods=[EdgeSearchMethod.cosine, EdgeSearchMethod.bm25, EdgeSearchMethod.bfs],
        reranker=EdgeReranker.reciprocal_rank_fusion,
        sim_min_score=DEFAULT_MIN_SCORE,
        bfs_max_depth=2,
    ),
    node_config=NodeSearchConfig(...),
    episode_config=EpisodeSearchConfig(...),
    community_config=CommunitySearchConfig(...),
    limit=10,
    reranker_min_score=0,
)
```

---

## Reranking Strategies

After parallel search methods return their results, results are combined and reranked.

### Reciprocal Rank Fusion (RRF)

Default reranker. Combines rankings from multiple search methods.

**Formula**:
```
RRF_score(d) = SUM over all rankers r of: 1 / (k + rank_r(d))
```

Where `k` is a constant (typically 60) that balances high vs low-ranked results, and `rank_r(d)` is the rank position of document `d` in ranker `r`'s results.

Each search method (cosine, BM25, BFS) produces a ranked list. RRF converts each position to a reciprocal score and sums across all methods. Documents appearing in multiple result sets get boosted.

### Node Distance Reranking

Reranks results based on graph proximity to a specified center node.

- Requires `center_node_uuid` parameter
- Measures hop distance from center node to each result
- Weights facts by closeness to the focal entity
- Useful for entity-specific queries ("Tell me about Alice" -> prioritize facts close to Alice's node)

### Episode Mentions

Prioritizes results by how frequently they appear across episodes. Edges referenced by more episodes are ranked higher.

### Maximal Marginal Relevance (MMR)

Balances relevance and diversity. Controlled by `mmr_lambda` parameter:
- `lambda = 1.0`: Pure relevance (no diversity)
- `lambda = 0.0`: Maximum diversity
- Default: `DEFAULT_MMR_LAMBDA`

Prevents results from being too similar to each other.

### Cross-Encoder

Neural reranking using a cross-encoder model. Most accurate but slowest. Takes query + each result as input pairs, produces relevance scores. Available for edges, episodes, and communities.

### Reranker Availability by Scope

| Reranker | Edges | Nodes | Episodes | Communities |
|----------|-------|-------|----------|-------------|
| RRF | Yes | Yes | Yes | Yes |
| Node Distance | Yes | Yes | No | No |
| Episode Mentions | Yes | No | No | No |
| MMR | Yes | Yes | No | Yes |
| Cross-Encoder | Yes | No | Yes | Yes |

---

## Search API

### Basic Search
```python
results: list[EntityEdge] = await graphiti.search(
    query="What does Alice work on?",
    center_node_uuid="alice-uuid",  # optional: bias toward Alice
    group_ids=["team-alpha"],       # optional: namespace filter
    num_results=10,
    search_filter=SearchFilters(...),
)
```

Returns entity edges ranked by relevance.

### Advanced Search
```python
results: SearchResults = await graphiti.search_(
    query="What does Alice work on?",
    config=COMBINED_HYBRID_SEARCH_CROSS_ENCODER,  # predefined config
    group_ids=["team-alpha"],
    center_node_uuid="alice-uuid",
    bfs_origin_node_uuids=["alice-uuid"],
    search_filter=SearchFilters(...),
)
# results.edges, results.nodes, results.episodes, results.communities
```

Returns comprehensive `SearchResults` with nodes, edges, episodes, and communities, each with reranker scores.

### Episode-Based Retrieval
```python
results: SearchResults = await graphiti.get_nodes_and_edges_by_episode(
    episode_uuids=["ep-uuid-1", "ep-uuid-2"]
)
```

---

## Search Pipeline Flow

1. Generate query embedding (if semantic search is enabled)
2. Execute configured search methods in parallel per scope
3. Collect result UUIDs from each method
4. Apply selected reranker per scope
5. Filter by `reranker_min_score` threshold
6. Return top-K results per scope

---

## Performance Characteristics

| Metric | Value |
|--------|-------|
| P95 retrieval latency | ~300ms |
| LLM calls during retrieval | 0 |
| Token usage per query | ~1.6k (vs 115k for full-context) |
| DMR benchmark accuracy | 94.8% |
| LongMemEval improvement | Up to 18.5% over baselines |
