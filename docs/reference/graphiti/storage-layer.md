# Graphiti Storage Layer

## Supported Backends

### Neo4j (Primary)
- Version: 5.26+
- Most mature implementation
- Native vector indexes for cosine similarity
- Native full-text indexes for BM25
- Cypher query language
- Docker Compose setup provided

### FalkorDB
- Version: 1.1.2+
- Redis-based graph database
- Lightweight alternative to Neo4j
- Docker Compose setup provided

### Kuzu
- Version: 0.11.2+
- Embedded graph database (in-process, no server needed)
- Good for development/testing
- Some edge cases with datetime format handling

### Amazon Neptune
- Managed graph database on AWS
- Requires OpenSearch Serverless for full-text search
- Most complex setup (separate search backend needed)

---

## Driver Architecture

### GraphDriver ABC

Every backend implements the `GraphDriver` abstract base class:

```python
class GraphDriver(ABC):
    async def execute_query(self, query, params) -> list[Record]
    async def session(self) -> AsyncSession
    async def close()
    async def build_indices_and_constraints()
    async def delete_all_indexes()
```

### GraphProvider Enum

```python
class GraphProvider(Enum):
    NEO4J = "neo4j"
    FALKORDB = "falkordb"
    KUZU = "kuzu"
    NEPTUNE = "neptune"
```

Query builders in `graphiti_core/models/nodes/node_db_queries.py` and `graphiti_core/models/edges/edge_db_queries.py` use `match/case` on `GraphProvider` to generate dialect-specific queries.

### 11 Operation ABCs

Organized in `graphiti_core/driver/operations/`:

**Node operations**:
- `EntityNodeOperations`
- `EpisodeNodeOperations`
- `CommunityNodeOperations`
- `SagaNodeOperations`

**Edge operations**:
- `EntityEdgeOperations`
- `EpisodicEdgeOperations`
- `CommunityEdgeOperations`
- `HasEpisodeEdgeOperations`
- `NextEpisodeEdgeOperations`

**Query operations**:
- `SearchOperations`
- `GraphMaintenanceOperations`

Operations receive a `QueryExecutor` (protocol-based) enabling driver-agnostic, testable implementations.

---

## Embedding Storage

Embeddings are stored directly as properties on nodes and relationships in the graph database:

| Object | Embedding Field | What's Embedded |
|--------|----------------|-----------------|
| EntityNode | `name_embedding` | Entity name text |
| EntityEdge | `fact_embedding` | Fact/relationship description |
| CommunityNode | `name_embedding` | Community name with key terms |

Embedding generation is async via `EmbedderClient` abstraction. Default: OpenAI embeddings.

Vector indexes are created during `build_indices_and_constraints()` for each backend:
- Neo4j: Native vector indexes
- FalkorDB: Vector similarity search
- Neptune: OpenSearch Serverless vector indexes

---

## Index Types

### Vector Indexes (Cosine Similarity)
- Entity node name embeddings
- Entity edge fact embeddings
- Community node name embeddings

### Full-Text Indexes (BM25)
- Entity edge facts
- Entity node names
- Episode content

### Structural Indexes
- UUID lookups
- group_id filtering
- Temporal field indexes (created_at, expired_at, valid_at, invalid_at)

---

## Adding a New Backend

To add PostgreSQL or any other backend:

1. Add enum value to `GraphProvider`
2. Create directory structure: `graphiti_core/driver/{backend}_driver.py` + `{backend}/operations/`
3. Implement `GraphDriver` subclass with:
   - `execute_query()` -- run queries
   - `session()` -- transaction management
   - `close()` -- cleanup
   - `build_indices_and_constraints()` -- create indexes
   - `delete_all_indexes()` -- remove indexes
4. Implement all 11 operation ABCs for the backend
5. Add dialect-specific query strings to query builders using `match/case`

---

## PostgreSQL + pgvector Feasibility

### What PostgreSQL Can Do
- **Vector storage + cosine similarity**: pgvector provides this natively (HNSW indexes)
- **Full-text search / BM25**: PostgreSQL has built-in `tsvector`/`tsquery` with ranking. Alternatively, pg_bm25 extensions exist.
- **JSON storage**: JSONB columns for flexible attributes
- **Temporal queries**: Standard SQL date/time operations
- **Unique constraints**: For deduplication

### What PostgreSQL Lacks (vs Graph DB)
- **Native graph traversal**: No Cypher-like path queries. BFS would need recursive CTEs (`WITH RECURSIVE`) which are less efficient than native graph traversal.
- **Relationship-first model**: Graph DBs store relationships as first-class objects; in PostgreSQL, edges are junction tables with foreign keys. Performance differs for multi-hop traversals.
- **Label propagation**: Would need custom implementation. No native graph algorithm support (though Apache AGE extension adds some graph capabilities).

### Implementation Strategy for PostgreSQL

**Tables needed**:
```sql
-- Nodes
episodes (uuid, name, group_id, content, source_type, source_description, valid_at, created_at)
entities (uuid, name, group_id, labels, summary, name_embedding vector(1536), attributes jsonb, created_at)
communities (uuid, name, group_id, summary, name_embedding vector(1536), created_at)

-- Edges
entity_edges (uuid, group_id, source_node_uuid, target_node_uuid, name, fact, fact_embedding vector(1536), episodes text[], created_at, expired_at, valid_at, invalid_at, attributes jsonb)
episodic_edges (uuid, episode_uuid, entity_uuid, created_at)  -- MENTIONS
community_edges (uuid, community_uuid, entity_uuid, created_at)  -- HAS_MEMBER

-- Indexes
CREATE INDEX ON entities USING hnsw (name_embedding vector_cosine_ops);
CREATE INDEX ON entity_edges USING hnsw (fact_embedding vector_cosine_ops);
CREATE INDEX ON communities USING hnsw (name_embedding vector_cosine_ops);
CREATE INDEX ON entity_edges USING gin (to_tsvector('english', fact));
```

**BFS alternative**: Use recursive CTEs for graph traversal:
```sql
WITH RECURSIVE traversal AS (
    SELECT target_node_uuid, 1 as depth
    FROM entity_edges WHERE source_node_uuid = $origin AND expired_at IS NULL
    UNION
    SELECT e.target_node_uuid, t.depth + 1
    FROM entity_edges e JOIN traversal t ON e.source_node_uuid = t.target_node_uuid
    WHERE t.depth < $max_depth AND e.expired_at IS NULL
)
SELECT * FROM traversal;
```

**Trade-offs**:
- Pro: No additional database dependency (if already running PostgreSQL)
- Pro: Simpler deployment, familiar SQL tooling
- Con: BFS via recursive CTEs is slower than native graph traversal for deep queries
- Con: More complex query generation for graph patterns
- Con: Label propagation must be implemented in application code
