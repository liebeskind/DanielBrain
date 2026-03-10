# Mem0 Data Model

## Memory Object

A memory in Mem0 is a single extracted fact stored as a vector embedding with metadata.

### Core Fields (MemoryItem Pydantic Model)

```python
class MemoryItem:
    id: str           # UUID
    memory: str       # The fact text (e.g., "User likes hiking")
    hash: str         # MD5 hex digest of content
    created_at: str   # ISO timestamp
    updated_at: str   # ISO timestamp (optional)
    score: float      # Similarity score (search results only)
```

### Metadata Schema (stored alongside vector embedding)

```python
{
    "user_id": str,       # User scope
    "agent_id": str,      # Agent scope
    "run_id": str,        # Run/session scope
    "actor_id": str,      # Who created the message
    "role": str,          # "user" or "assistant"
    "data": str,          # Content text
    "hash": str,          # MD5 of content
    "created_at": str,    # ISO timestamp
    "updated_at": str,    # ISO timestamp
    "memory_type": str,   # "procedural_memory" or standard
    # ... custom metadata fields
}
```

### Key Design Choice

Memories are **atomic facts**, not full messages. The LLM extracts facts like:
- "Name is John"
- "Is a software engineer"
- "Favourite movies are Inception and Interstellar"

Each fact gets its own embedding vector and can be independently updated or deleted.

## Scoping: user_id, agent_id, run_id

Every memory operation requires **at least one** scope identifier:

| Scope | Purpose | Example |
|-------|---------|---------|
| `user_id` | Individual user's memories | "alice" |
| `agent_id` | Agent-specific learned behaviors | "support-bot-v2" |
| `run_id` | Single execution/session context | "run-2024-01-15-abc" |

Scopes are **additive filters**. Providing `user_id="alice"` and `agent_id="support-bot"` creates memories only visible when both are specified.

## Memory Types

### Standard Memory (default)
Facts extracted from user messages. 7 extraction categories:
1. Personal preferences
2. Personal details (name, age, etc.)
3. Plans and intentions
4. Activity/service preferences
5. Health/wellness preferences
6. Professional details
7. Miscellaneous

### Agent Memory
When `agent_id` is present and assistant messages exist, extraction focuses on assistant characteristics:
- Assistant preferences and capabilities
- Hypothetical plans
- Personality traits
- Task approach
- Knowledge areas

### Procedural Memory
When `memory_type="procedural_memory"` with `agent_id`:
- Records interaction history and execution patterns
- Uses PROCEDURAL_MEMORY_SYSTEM_PROMPT
- Stores task objectives, progress, sequential actions
- Output is plain text summary (not fact list)

## Vector Storage Format

Each memory is stored in the vector store as:
```
{
    id: UUID,
    vector: float[],          # embedding of the fact text
    payload: {                # metadata dictionary
        user_id, agent_id, run_id,
        data, hash, created_at, updated_at,
        actor_id, role,
        ... custom metadata
    }
}
```

## Graph Memory Objects (when enabled)

### Nodes
```
{
    name: str,                # Entity name (lowercase, underscores)
    entity_type: str,         # Person, Location, Event, etc.
    embedding: float[],       # Vector for similarity matching
    created_at: timestamp,
    mentions: int             # Frequency counter
}
```

### Edges (Relationships)
```
{
    source: str,              # Source entity name
    relationship: str,        # Semantic label (e.g., "works_at")
    destination: str,         # Target entity name
}
```

Graph relationships are stored as Neo4j/Memgraph directed labeled edges: `(source)-[relationship]->(destination)`.

### Relations Array in Search Results

When graph memory is enabled, search results include a `relations` array alongside vector results:
```json
{
    "results": [...],         // vector search results
    "relations": [            // graph context (parallel, not reordered)
        {
            "source": "alice",
            "source_id": "neo4j_id",
            "relationship": "met_at",
            "relation_id": "neo4j_id",
            "destination": "graphconf",
            "destination_id": "neo4j_id",
            "similarity": 0.85
        }
    ]
}
```

## OpenMemory Data Model (MCP Server)

The OpenMemory MCP server adds a richer relational model on top:

### Users Table
| Column | Type | Notes |
|--------|------|-------|
| id | UUID | Primary key |
| user_id | String | Unique |
| name | String | |
| email | String | Unique |
| metadata | JSON | |
| created_at | Timestamp | |

### Apps Table
| Column | Type | Notes |
|--------|------|-------|
| id | UUID | Primary key |
| owner_id | FK(users) | |
| name | String | Unique per owner |
| description | String | |
| is_active | Boolean | |
| metadata | JSON | |

### Memories Table
| Column | Type | Notes |
|--------|------|-------|
| id | UUID | Primary key |
| user_id | FK(users) | |
| app_id | FK(apps) | |
| content | String | Memory text |
| vector | - | Embedding |
| metadata | JSON | |
| state | Enum | active/paused/archived/deleted |
| created_at | Timestamp | |
| archived_at | Timestamp | |
| deleted_at | Timestamp | Soft delete |

### Categories (many-to-many via junction)
| Column | Type |
|--------|------|
| id | UUID |
| name | String (unique) |
| description | String |

### Audit Tables
- **MemoryStatusHistory**: old_state, new_state, changed_by, changed_at
- **MemoryAccessLog**: memory_id, app_id, accessed_at, access_type, metadata
- **AccessControl**: subject_type/id, object_type/id, effect (generic permissions)
- **ArchivePolicy**: criteria, days_to_archive (automatic archival rules)

## Metadata Filtering

### Simple Filters
```python
memory.search("query", user_id="alice", filters={"category": "work"})
```

### Advanced Operators
```python
filters = {
    "age": {"gt": 25},           # Greater than
    "name": {"contains": "john"}, # Substring match
    "OR": [                       # Logical OR
        {"city": "SF"},
        {"city": "NYC"}
    ]
}
```

Supported operators: `eq`, `ne`, `gt`, `gte`, `lt`, `lte`, `in`, `nin`, `contains`, `icontains`, `AND`, `OR`, `NOT`.

## History Tracking

All memory changes are tracked in SQLite:

```python
{
    "memory_id": UUID,
    "prev_value": str,      # Previous content (null for ADD)
    "new_value": str,       # New content (null for DELETE)
    "event": str,           # "ADD", "UPDATE", "DELETE"
    "timestamp": datetime,
    "actor_id": str,
    "role": str,
    "is_deleted": int       # 1 for DELETE events
}
```

Accessible via `memory.history(memory_id)` to see full audit trail.
