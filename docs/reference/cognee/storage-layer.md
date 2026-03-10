# Storage Layer

Baseline: `c9370a8b` (2026-03-08)

## Overview

Cognee abstracts storage into three independent tiers, each with a formal interface and multiple backend implementations. This allows swapping databases without changing application logic.

## GraphDBInterface

**File:** `cognee/infrastructure/databases/graph/graph_db_interface.py`

24 abstract methods organized by operation type:

### Node Operations
| Method | Purpose |
|--------|---------|
| `add_node()` | Insert single node |
| `add_nodes()` | Batch insert nodes |
| `delete_node()` | Remove node by ID |
| `get_node()` | Retrieve single node |
| `get_nodes()` | Retrieve multiple nodes (filtered) |

### Edge Operations
| Method | Purpose |
|--------|---------|
| `add_edge()` | Insert single edge |
| `add_edges()` | Batch insert edges |
| `has_edge()` | Check edge existence |
| `get_edges()` | Retrieve edges (filtered) |

### Analysis & Traversal
| Method | Purpose |
|--------|---------|
| `get_neighbors()` | Adjacent nodes |
| `get_connections()` | Connected subgraph |
| `get_nodeset_subgraph()` | Subgraph from node set |
| `get_filtered_graph_data()` | Filtered graph extraction |

### Raw Queries
| Method | Purpose |
|--------|---------|
| `query()` | Database-specific query language (Cypher for Neo4j, etc.) |

### Backends

| Backend | Status | Notes |
|---------|--------|-------|
| **Kuzu** | Default | Embedded graph DB, no server needed |
| Neo4j | Supported | Full-featured, requires server |
| NetworkX | Supported | In-memory, good for testing |
| FalkorDB | Supported | Redis-based graph DB |

Config: `cognee/infrastructure/databases/graph/config.py`

## VectorDBInterface

**File:** `cognee/infrastructure/databases/vector/vector_db_interface.py`

Protocol class with ~20 methods:

### Collection Management
| Method | Purpose |
|--------|---------|
| `has_collection()` | Check if collection exists |
| `create_collection()` | Create new collection with schema |

### Data Operations
| Method | Purpose |
|--------|---------|
| `create_data_points()` | Insert embeddings with metadata |
| `retrieve()` | Fetch by ID |
| `delete_data_points()` | Remove embeddings |

### Search
| Method | Purpose |
|--------|---------|
| `search()` | Single query similarity search |
| `batch_search()` | Multiple queries in parallel |

### Utilities
| Method | Purpose |
|--------|---------|
| `embed_data()` | Generate embeddings for data |
| `prune()` | Clean up / reset collection |
| `create_vector_index()` | Build search index |
| `index_data_points()` | Index existing data for search |

### Backends

| Backend | Status | Notes |
|---------|--------|-------|
| **LanceDB** | Default | Embedded, no server needed |
| pgvector | Supported | PostgreSQL extension |
| Qdrant | Supported | Dedicated vector DB |
| Weaviate | Supported | Full-featured vector DB |

Config: `cognee/infrastructure/databases/vector/config.py`

## SqlAlchemyAdapter

**File:** `cognee/infrastructure/databases/relational/sqlalchemy/SqlAlchemyAdapter.py`

Wraps SQLAlchemy async engine for relational operations:

### Core Operations
| Method | Purpose |
|--------|---------|
| `create_table()` | DDL from SQLAlchemy models |
| `insert_data()` | Insert rows |
| `delete_entity_by_id()` | Delete by primary key |
| `get_table()` | Query with filters |
| `get_all_data_from_table()` | Full table scan |

### Schema & Metadata
| Method | Purpose |
|--------|---------|
| `extract_schema()` | Introspect table definitions |

### Cloud Integration
| Method | Purpose |
|--------|---------|
| `push_to_s3()` | Upload database to S3 |
| `pull_from_s3()` | Download database from S3 |

### Backends

| Backend | Status | Notes |
|---------|--------|-------|
| **SQLite** | Default | File-based, zero config |
| PostgreSQL | Supported | Production-grade |

## Collection-Based Partitioning

Different entity types are stored in separate vector collections:

```
Vector Store
├── DocumentChunk_text    ← chunk embeddings (ChunksRetriever targets this)
├── Triplet_text          ← relationship triple embeddings (TripletRetriever)
├── Entity_description    ← entity description embeddings
└── ...                   ← extensible per DataPoint subclass
```

Collection names derive from the `DataPoint` subclass and the indexed field name (e.g., `DocumentChunk_text` = class `DocumentChunk`, field `text`).

## Metadata-Driven Indexing

The `index_fields` metadata on `DataPoint` subclasses declares which fields should be indexed:

```python
class DocumentChunk(DataPoint):
    text: str

    class Meta:
        index_fields = ["text"]  # This field gets embedded and indexed
```

The storage layer reads `index_fields` to:
1. Create the appropriate vector collection
2. Embed the field value
3. Index it for similarity search

## Contrast with TopiaBrain

| Aspect | Cognee | TopiaBrain |
|--------|--------|------------|
| Database count | 3 separate (graph + vector + relational) | 1 (PostgreSQL + pgvector) |
| Abstraction | Formal interfaces per tier | Direct SQL queries |
| Graph backend | Kuzu (embedded) | PostgreSQL tables |
| Vector backend | LanceDB (embedded) | pgvector extension |
| Relational backend | SQLite/PostgreSQL | PostgreSQL |
| ORM | SQLAlchemy (async) | Direct pg queries via node-postgres |
| Collection partitioning | Per entity type | Single thoughts table |
| S3 support | Built-in | None (on-prem only) |

### What's Worth Considering

**Interface abstraction** — We don't need multiple backends, but abstracting our database access behind an interface would improve testability. Currently tests mock individual query functions; an interface would provide a cleaner seam.

**Collection partitioning** — Storing entity embeddings separately from thought embeddings could improve search precision. Currently all embeddings are in the thoughts table; entity profiles have their own embeddings but share the same vector index.

### What to Skip

**Multi-backend support** — We're committed to PostgreSQL + pgvector. Supporting LanceDB/Kuzu/Neo4j would add complexity without benefit.

**SQLAlchemy** — Our direct SQL approach is simpler and sufficient for our scale. An ORM would add a layer of indirection we don't need.

**S3 storage** — Violates our on-prem data sovereignty requirement.
