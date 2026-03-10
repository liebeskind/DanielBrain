# Graphiti Data Model

## Overview

Graphiti's data model consists of four node types and five edge types, organized into three subgraphs (episodic, semantic, community). All nodes and edges are defined as Pydantic models. Custom entity and edge types extend the base models via Pydantic inheritance.

---

## Node Types

### EpisodicNode

Raw data unit. One episode = one message, document paragraph, or JSON event.

| Field | Type | Description |
|-------|------|-------------|
| `uuid` | str | Auto-generated unique identifier |
| `name` | str | Episode identifier/label |
| `group_id` | str | Graph partition/namespace identifier |
| `content` | str | Full raw text content of the episode |
| `source_description` | str | Description of the data source (e.g., "Slack message from #general") |
| `source` | EpisodeType | One of: `message`, `json`, `text` |
| `valid_at` | datetime | When the episode occurred (reference time) |
| `created_at` | datetime | When ingested into the graph |

**Episode types**:
- `EpisodeType.message` -- conversational messages (chat, email)
- `EpisodeType.json` -- structured data (API responses, events)
- `EpisodeType.text` -- unstructured text (documents, transcripts)

### EntityNode

Semantic entity representing a real-world concept. One-to-one with its real-world counterpart.

| Field | Type | Description |
|-------|------|-------------|
| `uuid` | str | Auto-generated unique identifier |
| `name` | str | Canonical entity name |
| `group_id` | str | Graph partition/namespace |
| `labels` | list[str] | Entity type labels (custom types become labels) |
| `summary` | str | LLM-generated summary from linked episodes |
| `created_at` | datetime | When first created |
| `name_embedding` | list[float] | None | Vector embedding of entity name for similarity search |
| `attributes` | dict | Custom attributes from Pydantic entity type definitions |

**Protected fields** (cannot be overridden by custom entity types): `uuid`, `name`, `group_id`, `labels`, `created_at`, `summary`, `attributes`, `name_embedding`.

**Custom entity types** are defined as Pydantic models:
```python
class Person(BaseModel):
    title: str = Field(description="Job title")
    company: str = Field(description="Current employer")

entity_types = {"Person": Person, "Company": Company}
```

### CommunityNode

Higher-level grouping of related entities, generated via label propagation.

| Field | Type | Description |
|-------|------|-------------|
| `uuid` | str | Unique identifier |
| `name` | str | LLM-generated community name with key terms |
| `group_id` | str | Graph partition |
| `summary` | str | LLM-generated summary of member entities and their relationships |
| `name_embedding` | list[float] | None | Embedding of community name for search |
| `created_at` | datetime | Creation timestamp |

### SagaNode

Sequential episode chains representing connected narratives (e.g., a conversation thread, a meeting series).

| Field | Type | Description |
|-------|------|-------------|
| `uuid` | str | Unique identifier |
| `name` | str | Saga identifier |
| `group_id` | str | Graph partition |
| `created_at` | datetime | Creation timestamp |

---

## Edge Types

### EntityEdge (Semantic Subgraph)

The most important edge type. Represents a fact/relationship between two entities with full bi-temporal tracking.

| Field | Type | Description |
|-------|------|-------------|
| `uuid` | str | Unique identifier |
| `group_id` | str | Graph partition |
| `source_node_uuid` | str | Source entity UUID |
| `target_node_uuid` | str | Target entity UUID |
| `name` | str | Relationship type in SCREAMING_SNAKE_CASE (e.g., `WORKS_AT`) |
| `fact` | str | Natural language description of the relationship |
| `fact_embedding` | list[float] | None | Vector embedding of the fact text |
| `episodes` | list[str] | UUIDs of source episodes that produced this edge |
| `created_at` | datetime | Transaction time: when edge was created in graph (T') |
| `expired_at` | datetime | None | Transaction time: when edge was invalidated in graph (T') |
| `valid_at` | datetime | None | Event time: when fact became true in reality (T) |
| `invalid_at` | datetime | None | Event time: when fact stopped being true in reality (T) |
| `attributes` | dict | Custom attributes from Pydantic edge type definitions |

**Temporal semantics**:
- `valid_at` + `invalid_at` = real-world validity window
- `created_at` + `expired_at` = system knowledge window
- An edge with `expired_at` set has been superseded by newer information
- An edge with `invalid_at` set represents a relationship that ended in reality
- Both can be set: "we learned on March 5 that Alice left Acme on March 1"

**Custom edge types**:
```python
class Employment(BaseModel):
    start_date: str = Field(description="Employment start date")
    role: str = Field(description="Job role/title")

edge_types = {"Employment": Employment}
```

### EpisodicEdge (MENTIONS)

Connects episodes to the entities they reference. Created automatically during ingestion.

| Field | Type | Description |
|-------|------|-------------|
| `uuid` | str | Unique identifier |
| `source_node_uuid` | str | EpisodicNode UUID |
| `target_node_uuid` | str | EntityNode UUID |
| `created_at` | datetime | Creation timestamp |

### CommunityEdge (HAS_MEMBER)

Connects community nodes to their member entities.

| Field | Type | Description |
|-------|------|-------------|
| `uuid` | str | Unique identifier |
| `source_node_uuid` | str | CommunityNode UUID |
| `target_node_uuid` | str | EntityNode UUID |
| `created_at` | datetime | Creation timestamp |

### HasEpisodeEdge

Links sagas to their episodes.

### NextEpisodeEdge

Chains episodes sequentially within a saga (ordered by `valid_at` timestamp).

---

## Graph Namespacing

`group_id` is the namespace mechanism. Every node and edge belongs to a group. Searches can be scoped to one or multiple group IDs. This enables multi-tenancy: different users/teams/projects can have isolated graph partitions.

---

## Storage in Neo4j

Entities and episodes are stored as Neo4j nodes with labels. Entity edges become Neo4j relationships. Embeddings are stored as node/relationship properties (float arrays). Full-text indexes support BM25 search. Vector indexes support cosine similarity search.

Key Neo4j indexes:
- Vector index on `EntityNode.name_embedding`
- Vector index on `EntityEdge.fact_embedding`
- Vector index on `CommunityNode.name_embedding`
- Full-text index on `EntityEdge.fact`
- Full-text index on `EntityNode.name`
