# Graphiti Architecture

> Reference snapshot from getzep/graphiti (GitHub). Graphiti is the open-source temporal knowledge graph engine powering Zep's commercial agent memory platform.

## Core Design Philosophy

Graphiti is built around three principles that distinguish it from batch-oriented GraphRAG:

1. **Incremental, real-time updates**: New episodes (messages, events, documents) are processed immediately without recomputing the entire graph. This is the fundamental departure from Microsoft's GraphRAG, which requires batch reprocessing.

2. **Non-lossy temporal tracking**: Nothing is deleted. When facts change, old edges are invalidated (timestamped as expired) rather than removed, preserving complete history for point-in-time queries.

3. **LLM-free retrieval**: All retrieval is done via hybrid search (cosine similarity + BM25 + BFS graph traversal) with no LLM calls at query time. LLMs are only used during ingestion. This gives sub-second retrieval latency vs. GraphRAG's seconds-to-tens-of-seconds.

## Multi-Subgraph Architecture

Graphiti maintains three distinct but interconnected subgraphs:

### 1. Episodic Subgraph
Raw data preservation layer. Episodes (messages, documents, JSON events) are stored as `EpisodicNode` objects with their full content. Episodic edges (`MENTIONS`) connect episodes to the entities they reference. Episodes are also chained via `NEXT_EPISODE` edges for sequential traversal. This subgraph is the "ground truth" -- all semantic artifacts can be traced back to their source episodes for citation.

### 2. Semantic Subgraph
The knowledge layer. Entity nodes represent real-world concepts (people, companies, etc.). Entity edges represent facts/relationships between entities, each carrying temporal validity metadata. This is where the bi-temporal model lives. New episodes create or update entities and edges in this subgraph.

### 3. Community Subgraph
Higher-level groupings. Related entities are clustered via label propagation into community nodes, which contain LLM-generated summaries. Community edges (`HAS_MEMBER`) connect communities to their member entities. Used for hierarchical reasoning and broad-scope queries.

## Bi-Temporal Model

Every entity edge tracks four timestamps across two temporal dimensions:

**Event Time (T)** -- when things happened in the real world:
- `valid_at`: When the fact became true (e.g., "Alice joined Acme" -> the hire date)
- `invalid_at`: When the fact stopped being true (e.g., "Alice left Acme" -> the departure date)

**Transaction Time (T')** -- when the system learned about it:
- `created_at`: When the edge was created in the graph
- `expired_at`: When the edge was invalidated/superseded by new information

This enables:
- Point-in-time queries ("What was true on March 1?")
- Retroactive corrections (backdate facts without losing the record of when we learned them)
- Audit trails (trace what the system knew at any given moment)

## Data Flow: Episode to Graph

```
Episode arrives (message/event/document)
  |
  v
[1] Create EpisodicNode (store raw content)
  |
  v
[2] Retrieve historical context (prior episodes for NER disambiguation)
  |
  v
[3] LLM: Extract entity nodes from episode text
  |
  v
[4] Resolve extracted nodes against existing graph (similarity + LLM dedup)
  |
  v
[5] LLM: Extract edges/relationships with temporal metadata
  |
  v
[6] Resolve edges: dedup + contradiction detection + temporal invalidation
  |
  v
[7] Extract custom attributes from nodes using edge context
  |
  v
[8] Persist: save nodes, edges, episodic connections to graph DB
  |
  v
[9] (Optional) Update communities via label propagation + LLM summaries
```

## Technology Stack

**Graph Databases Supported**:
- Neo4j 5.26+ (primary, most mature)
- FalkorDB 1.1.2+
- Kuzu 0.11.2+
- Amazon Neptune with OpenSearch Serverless

**LLM Providers**: OpenAI (default), Anthropic, Groq, Google Gemini. Requires structured output support.

**Embedding Providers**: OpenAI (default), pluggable via `EmbedderClient` abstraction.

**Architecture Pattern**: Pluggable driver system via `GraphDriver` ABC with `GraphProvider` enum. 11 operation ABCs (4 node types + 5 edge types + search + maintenance) enable backend-agnostic operation.

## Key Source Files

```
graphiti_core/
  graphiti.py              # Main client: add_episode(), search(), add_episode_bulk()
  nodes.py                 # EntityNode, EpisodicNode, CommunityNode, SagaNode
  edges.py                 # EntityEdge, EpisodicEdge, CommunityEdge, etc.
  graphiti_types.py        # Type definitions
  search/
    search.py              # Hybrid search orchestration
    search_config.py       # SearchConfig, reranker enums, filter types
  prompts/
    extract_nodes.py       # Entity extraction prompts (message/json/text variants)
    extract_edges.py       # Relationship extraction + temporal resolution prompts
    dedupe_nodes.py        # Entity deduplication prompt
    dedupe_edges.py        # Edge dedup + contradiction/invalidation prompt
    summarize_nodes.py     # Community/entity summary generation
  driver/
    driver.py              # GraphDriver ABC, GraphProvider enum
    operations/            # 11 operation ABCs
    neo4j_driver.py        # Neo4j implementation
    falkordb_driver.py     # FalkorDB implementation
    kuzu_driver.py         # Kuzu implementation
    neptune_driver.py      # Neptune implementation
  utils/maintenance/
    node_operations.py     # Node resolution pipeline
    edge_operations.py     # Edge resolution + temporal invalidation
    graph_data_operations.py  # Data clearing, episode retrieval
  embedder/                # Embedding provider abstraction
  llm_client/              # LLM provider abstraction
  cross_encoder/           # Cross-encoder reranking
  models/                  # DB query builders per provider
  mcp_server/              # MCP server for Claude/Cursor integration
  server/                  # FastAPI REST service
```

## Performance

- **Retrieval latency**: P95 of 300ms (sub-second), no LLM calls during search
- **DMR benchmark**: 94.8% accuracy (vs MemGPT's 93.4%)
- **LongMemEval**: Up to 18.5% accuracy improvement over baselines, 90% latency reduction
- **Token efficiency**: 1.6k tokens per response vs 115k for full-context approaches
- **Concurrency**: Configurable via `SEMAPHORE_LIMIT` (default 10) to manage LLM rate limits
