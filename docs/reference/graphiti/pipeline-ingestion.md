# Graphiti Pipeline & Ingestion

## Episode Processing Flow

### Single Episode: `add_episode()`

The primary ingestion method. Processes one episode with full extraction, deduplication, and temporal invalidation.

**Method signature**:
```python
async def add_episode(
    self,
    name: str,                           # Episode identifier
    episode_body: str,                   # Raw content (text, JSON string, message)
    source_description: str,             # e.g., "Slack message from #general"
    reference_time: datetime,            # When the episode occurred
    source: EpisodeType = EpisodeType.message,  # message | json | text
    group_id: str | None = None,         # Namespace
    uuid: str | None = None,             # Optional pre-assigned UUID
    update_communities: bool = False,    # Trigger community updates?
    entity_types: dict[str, type[BaseModel]] | None = None,  # Custom entity schemas
    excluded_entity_types: list[str] | None = None,
    previous_episode_uuids: list[str] | None = None,
    edge_types: dict[str, type[BaseModel]] | None = None,    # Custom edge schemas
    edge_type_map: dict[tuple[str, str], list[str]] | None = None,
    custom_extraction_instructions: str | None = None,
    saga: str | SagaNode | None = None,  # Link to saga chain
    saga_previous_episode_uuid: str | None = None,
) -> AddEpisodeResults
```

**Returns**: `AddEpisodeResults` containing: episode, edges, nodes, and community data.

### Step-by-Step Pipeline

#### Step 1: Initialization
- Validate configuration parameters
- Establish temporal context from `reference_time`
- Determine `group_id` (use default if not specified)

#### Step 2: Historical Context Retrieval
- Fetch prior episodes (up to `RELEVANT_SCHEMA_LIMIT`) from the same group
- These provide context for entity extraction (pronoun resolution, disambiguation)
- If `previous_episode_uuids` provided, use those; otherwise query by recency

#### Step 3: Episode Creation
- Create `EpisodicNode` with content, source type, timestamps
- Or retrieve existing episode if UUID is provided (idempotent re-processing)
- Store in graph database

#### Step 4: Entity Extraction (LLM Call)
- Call `extract_nodes()` with episode content + historical context
- LLM extracts entities using structured output
- Prompt varies by episode type (message/json/text)
- Each entity gets: name, type, initial attributes

#### Step 5: Entity Resolution
- Call `resolve_extracted_nodes()` to merge with existing graph entities
- Phase 1: Similarity search + deterministic matching (no LLM)
- Phase 2: LLM confirmation for ambiguous cases
- Output: map of extracted UUIDs -> resolved UUIDs (existing or new)

#### Step 6: Edge Extraction & Resolution
- Call `extract_edges()` -- LLM extracts relationships between resolved entities
- Call `resolve_extracted_edges()`:
  - In-batch deduplication
  - Parallel search for existing related edges
  - Fast-path verbatim matching
  - LLM dedup + contradiction detection
  - Temporal invalidation of contradicted edges

#### Step 7: Attribute Enhancement
- Call `extract_attributes_from_nodes()` using only new edges
- Enriches entity nodes with attributes derived from relationship context
- Avoids duplicating existing facts

#### Step 8: Database Persistence
- Call `add_nodes_and_edges_bulk()` to save:
  - New/updated entity nodes
  - New entity edges
  - Episodic edges (MENTIONS connections between episode and entities)
  - Updated (invalidated) existing edges

#### Step 9: Saga Association (Optional)
- If saga specified, create `HAS_EPISODE` and `NEXT_EPISODE` edges
- Links episode into sequential saga chain

#### Step 10: Community Updates (Optional)
- If `update_communities=True`, call `update_community()` for affected nodes
- Label propagation assigns nodes to communities
- LLM generates/updates community summaries

---

### Bulk Processing: `add_episode_bulk()`

Optimized for batch ingestion. Trades temporal features for throughput.

**Key differences from single-episode**:
- Skips edge invalidation (no contradiction detection)
- Skips temporal extraction (no `valid_at`/`invalid_at` resolution)
- Processes all episodes as a batch with in-memory deduplication
- Significantly fewer LLM calls per episode

**Pipeline**:
1. Create all `EpisodicNode` instances
2. Batch store all episodes
3. Retrieve historical context for each episode
4. Batch extract nodes and edges across all episodes
5. In-memory deduplication (`dedupe_nodes_bulk()`) -- consolidate duplicates within batch
6. Generate episodic edges (MENTIONS links)
7. Edge deduplication (`dedupe_edges_bulk()`)
8. Graph resolution against existing entities (`_resolve_nodes_and_edges_bulk()`)
9. Reconcile edge source/target references (`resolve_edge_pointers()`)
10. Bulk persistence
11. Saga chaining (if applicable), ordered by `valid_at`

---

## Context Window Usage

The LLM sees:
- **Current message/episode content** -- the primary text being processed
- **Last N previous episodes** -- provides conversational context for disambiguation
- **Existing entity types** -- schema definitions for classification
- **Custom extraction instructions** -- domain-specific guidance

The `RELEVANT_SCHEMA_LIMIT` controls how many prior episodes are included. This is critical for:
- Pronoun resolution ("he" -> "Alan Turing")
- Relative temporal expressions ("two weeks ago" -> absolute date from reference_time)
- Entity disambiguation (same first name, different people)

---

## Async Processing Patterns

Graphiti is fully async (Python `asyncio`):

- **Semaphore-controlled concurrency**: `SEMAPHORE_LIMIT` (default 10) prevents overwhelming LLM APIs with concurrent requests
- **Parallel operations**: Entity resolution, edge search, and embedding generation run concurrently via `semaphore_gather()`
- **Non-blocking persistence**: Node and edge saves happen concurrently where possible
- **Rate limit safety**: Semaphore prevents 429 errors from LLM providers

---

## Community Detection

### Algorithm: Label Propagation

Chosen over Leiden algorithm because it supports dynamic extension -- new nodes can be assigned to communities incrementally without full recomputation.

**Process**:
1. New node is added to the graph
2. Examine neighbors' community labels
3. Assign new node to the community held by the plurality of its neighbors
4. Update community summary and graph accordingly

**Periodic refresh**: Dynamic updating causes communities to gradually diverge from what a complete label propagation run would produce. Periodic full refreshes are needed, but the dynamic strategy significantly reduces latency and LLM inference costs between refreshes.

### Community Summary Generation

Uses iterative map-reduce-style summarization:
1. Collect member nodes of the community
2. LLM generates summary from member entities and their relationships
3. LLM generates community name containing key terms and relevant subjects
4. Name is embedded for cosine similarity search

Community summaries enable "global" queries that span many entities (e.g., "What are the main projects our team is working on?").
