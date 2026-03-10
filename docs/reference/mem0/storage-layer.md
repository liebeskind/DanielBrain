# Mem0 Storage Layer

## Vector Store Interface

Source: `mem0/vector_stores/base.py`

All 26 vector store implementations share this abstract interface:

```python
class VectorStoreBase(ABC):
    # Collection management
    create_col(name, vector_size, distance)
    list_cols()
    delete_col()
    col_info()

    # Vector CRUD
    insert(vectors, payloads=None, ids=None)
    search(query, vectors, limit=5, filters=None)
    get(vector_id)
    update(vector_id, vector=None, payload=None)
    delete(vector_id)

    # Data access
    list(filters=None, limit=None)

    # Maintenance
    reset()   # Delete collection and recreate
```

## Supported Vector Stores (26)

### Self-Hostable / Local
| Provider | File | Notes |
|----------|------|-------|
| **pgvector** | `pgvector.py` | PostgreSQL extension. Supports psycopg2 + psycopg3 with connection pooling |
| **Qdrant** | `qdrant.py` | Most documented local option. Docker: port 6333 |
| **ChromaDB** | `chroma.py` | Embedded or client-server mode |
| **FAISS** | `faiss.py` | Facebook's in-memory vector search |
| **Milvus** | `milvus.py` | Distributed vector DB |
| **Redis** | `redis.py` | Redis with vector search module |
| **Valkey** | `valkey.py` | Redis fork (AWS ElastiCache compatible) |
| **Elasticsearch** | `elasticsearch.py` | ES with dense vector support |
| **OpenSearch** | `opensearch.py` | AWS OpenSearch |
| **MongoDB** | `mongodb.py` | Atlas Vector Search |
| **Cassandra** | `cassandra.py` | DataStax vector search |
| **Weaviate** | `weaviate.py` | Vector-native database |
| **LangChain** | `langchain.py` | LangChain vector store wrapper |

### Cloud-Only
| Provider | File | Notes |
|----------|------|-------|
| **Pinecone** | `pinecone.py` | Managed vector DB |
| **Supabase** | `supabase.py` | Supabase pgvector |
| **Upstash Vector** | `upstash_vector.py` | Serverless vector DB |
| **S3 Vectors** | `s3_vectors.py` | AWS S3-based vectors |
| **Azure AI Search** | `azure_ai_search.py` | Azure Cognitive Search |
| **Azure MySQL** | `azure_mysql.py` | Azure MySQL with vectors |
| **Vertex AI** | `vertex_ai_vector_search.py` | Google Vertex AI |
| **Neptune Analytics** | `neptune_analytics.py` | AWS Neptune |
| **Databricks** | `databricks.py` | Databricks vector search |
| **Baidu** | `baidu.py` | Baidu vector service |

## pgvector Implementation Details

Source: `mem0/vector_stores/pgvector.py`

- Supports both psycopg2 and psycopg3 drivers
- Connection pooling via `_get_cursor()` context manager
- Search: lines 202-244 (cosine similarity with metadata filtering)
- Index creation: lines 147-182 (IVFFlat or HNSW)
- Connection pool: lines 56-108

Configuration:
```python
config = {
    "vector_store": {
        "provider": "pgvector",
        "config": {
            "dbname": "mem0",
            "collection_name": "memories",
            "embedding_model_dims": 768,
            "user": "postgres",
            "password": "postgres",
            "host": "localhost",
            "port": 5432
        }
    }
}
```

## Graph Store Options

Source: `mem0/graphs/configs.py`

| Provider | Config Class | Key Params |
|----------|-------------|------------|
| **Neo4j** | `Neo4jConfig` | url, username, password, database, base_label |
| **Memgraph** | `MemgraphConfig` | url, username, password |
| **Neptune Analytics** | `NeptuneConfig` | endpoint, app_id, base_label, collection_name |
| **Neptune DB** | `NeptuneConfig` | endpoint (neptune-db:// format) |
| **Kuzu** | `KuzuConfig` | db_path (or `:memory:`) |

### GraphStoreConfig

```python
class GraphStoreConfig:
    provider: str              # "neo4j", "memgraph", "neptune", "kuzu"
    config: Union[Neo4jConfig, MemgraphConfig, NeptuneConfig, KuzuConfig]
    llm: Optional[LLMConfig]   # Separate LLM for graph operations
    custom_prompt: Optional[str]  # Custom entity extraction guidance
    threshold: float = 0.7     # Embedding similarity threshold (0.0-1.0)
```

Threshold guidance:
- 0.5-0.7: Loose matching for distinct entities with similar embeddings
- 0.9+: Strict matching for precise dedup

## Multi-Tenancy Model

### Scoping via Metadata

Mem0 achieves multi-tenancy through metadata filtering, not separate databases/collections:

```python
# All memories in same collection, filtered by scope
memory.add(messages, user_id="alice")      # Scoped to alice
memory.add(messages, user_id="bob")        # Scoped to bob
memory.search("query", user_id="alice")    # Only returns alice's memories
```

### Scope Hierarchy

```
user_id   -> Individual user (most common)
agent_id  -> AI agent (cross-user agent behaviors)
run_id    -> Single session/execution
```

Multiple scopes can be combined:
```python
memory.add(messages, user_id="alice", agent_id="support-bot")
# Only visible when BOTH user_id="alice" AND agent_id="support-bot" are specified
```

### OpenMemory Multi-Tenancy

The MCP server adds app-level scoping:
- Each MCP client (Cursor, Claude, etc.) registered as an App
- Memories scoped to (user_id, app_id)
- ACL system controls cross-app memory access
- Access logs track which app accessed which memories

## History Storage

SQLite database tracks all memory changes:
- Separate from vector store
- Records: memory_id, prev_value, new_value, event, timestamp, actor_id, role
- Enables full audit trail and undo capabilities

## Self-Hosted Docker Stack

The default self-hosted deployment uses:
```
mem0 server (FastAPI/uvicorn) -> port 8888
PostgreSQL + pgvector         -> port 8432
Neo4j 5.26.4                  -> ports 7474 (HTTP), 7687 (Bolt)
```

All on a bridge network (`mem0_network`) with persistent volumes and health checks.
