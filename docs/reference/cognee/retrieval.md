# Retrieval System

Baseline: `c9370a8b` (2026-03-08)

## Overview

Cognee implements 15+ retrieval strategies, all following a common `BaseRetriever` pattern. This is the highest-value area of cognee's architecture for TopiaBrain to study — their retriever diversity far exceeds our current semantic search.

## BaseRetriever Pattern

**Directory:** `cognee/modules/retrieval/`

Every retriever implements three steps:

```
Query → get_retrieved_objects() → get_context_from_objects() → get_completion_from_context() → Answer
```

| Step | Purpose |
|------|---------|
| `get_retrieved_objects()` | Find relevant data (vector search, graph traversal, etc.) |
| `get_context_from_objects()` | Format retrieved objects into context string |
| `get_completion_from_context()` | Generate LLM answer from context (optional) |

This separation enables mixing and matching — different retrieval methods can share context formatting and completion logic.

## Retrieval Strategies

### 1. ChunksRetriever

**Simplest strategy.** Vector similarity search on `DocumentChunk_text` collection.

- Query embedding compared against chunk embeddings
- Returns top-k most similar chunks
- Equivalent to our current `semantic_search` MCP tool

### 2. TripletRetriever

Vector similarity on `Triplet_text` collection (RDF-like triples).

- Triplets: (subject, predicate, object) stored as text and embedded
- Query matches against relationship descriptions, not just chunk content
- Captures relational knowledge that chunk-level search misses

### 3. GraphCompletionRetriever

**Hybrid strategy** combining brute-force triplet matching with vector index:

1. Embed query
2. Search vector index for relevant triplets
3. Traverse graph from matched triplets to expand context
4. Combine graph context with vector results
5. Generate completion from combined context

This is the default production retriever — it balances precision (vector) with breadth (graph traversal).

### 4. GraphCompletionCotRetriever

**Chain-of-thought refinement** — the most sophisticated retriever:

1. Initial retrieval (like GraphCompletionRetriever)
2. LLM evaluates retrieved context
3. LLM generates refined sub-queries
4. Re-retrieve with refined queries
5. Repeat for **4 iterations**
6. Final completion from accumulated context

Each iteration narrows the search, finding increasingly relevant context. Expensive (4 LLM calls per query) but highest quality for complex questions.

### 5. NaturalLanguageRetriever

**Natural language to graph query translation:**

1. LLM translates natural language query to Cypher (graph query language)
2. Execute Cypher against graph DB
3. If query fails, LLM retries with error context
4. **3 retry loops** for query correction
5. Return graph query results as context

Best for structured questions ("Who works at Acme?" → `MATCH (p:Person)-[:works_at]->(c:Company {name: 'Acme'}) RETURN p`)

### 6. TemporalRetriever

**Time-aware retrieval:**

1. Extract temporal references from query ("last week", "in January", "before the merger")
2. Query temporal graph for time-bounded data
3. If temporal graph empty, **fall back to TripletRetriever**
4. Combine temporal context with standard retrieval

This is directly relevant to TopiaBrain — we have timestamps on every thought but don't leverage them in search beyond the `days_back` filter.

### 7. LexicalRetriever

**Keyword-based matching** (no embeddings):

- Tokenizes query and documents
- Matching algorithms: **Jaccard similarity** or **BM25** scoring
- Fast, no embedding computation needed
- Useful as a complement to semantic search for exact term matching

### 8. SummariesRetriever

Searches against document summaries rather than chunks:

- Matches query against pre-generated summaries
- Returns broader context (document-level) vs chunk-level detail
- Useful for "big picture" questions

### 9. CodeRetriever

Specialized for code search:

- Searches code-specific graph nodes (functions, classes, modules)
- Understands import relationships and call graphs

## Search Type Enum

```python
class SearchType:
    GRAPH_COMPLETION = "GRAPH_COMPLETION"      # GraphCompletionRetriever
    RAG_COMPLETION = "RAG_COMPLETION"          # GraphCompletionRetriever (alias)
    CHUNKS = "CHUNKS"                          # ChunksRetriever
    SUMMARIES = "SUMMARIES"                    # SummariesRetriever
    CODE = "CODE"                              # CodeRetriever
    CYPHER = "CYPHER"                          # NaturalLanguageRetriever
    FEELING_LUCKY = "FEELING_LUCKY"            # LLM auto-selects
```

Default: `RAG_COMPLETION` — uses GraphCompletionRetriever.

## Search Type Auto-Selection

When `FEELING_LUCKY` is specified (or by default in some contexts):

1. LLM analyzes the query
2. Classifies it into the most appropriate search type
3. Dispatches to the corresponding retriever

This enables the MCP `search()` tool to handle diverse queries without the caller needing to choose a strategy.

## Session Caching

- Repeat queries within a session return cached results
- Session identified by `(user_id, session_id)` tuple
- Cache key is the query text
- Avoids redundant embedding computation and DB queries

## Batch Query Support

Graph retrievers support multiple queries in parallel:

```python
# Conceptual
results = await vector_db.batch_search([
    {"query": "budget discussion", "collection": "Triplet_text"},
    {"query": "Alice's projects", "collection": "Triplet_text"},
])
```

Used by multiquery strategies that decompose a complex query into sub-queries.

## Search Filters

Supported filter dimensions:
- **Tags** — filter by entity tags or categories
- **Date range** — filter by temporal bounds
- **Dataset** — scope to specific dataset
- **Collection** — target specific vector collection

## Relevance to TopiaBrain

### Currently Implemented (TopiaBrain)
- **Semantic search** — equivalent to ChunksRetriever (vector similarity on thoughts)
- **Temporal filter** — `days_back` parameter on semantic_search
- **Entity search** — entity profile embeddings for entity-level semantic search

### High-Value Additions

**Graph completion retriever** — Our `entity_relationships` table (Phase 10) + entity-thought links could power a graph completion strategy:
1. Vector search finds relevant thoughts
2. Follow entity links to find connected entities
3. Follow entity-thought links to find related thoughts
4. Combine for richer context

**Temporal retriever** — We have `created_at` on every thought. Extracting time references from queries ("what happened last week with Project X?") and using them as filters would improve our `get_timeline` tool.

**Lexical retriever** — BM25/Jaccard as a complement to semantic search. Useful when queries contain specific names or terms that embeddings might not capture well.

**Chain-of-thought retriever** — Expensive but high quality. Could be used for the chat feature's "deep research" mode. Requires multiple Ollama calls per query.

**Retriever auto-selection** — As we add more retrieval strategies, having the LLM choose the best one (like cognee's FEELING_LUCKY) would improve the chat experience.

### Not Worth Adopting
- **NaturalLanguageRetriever** (Cypher) — requires a graph database with query language
- **CodeRetriever** — not relevant to our knowledge graph use case
- **SummariesRetriever** — our thoughts already include summaries in the same embedding space
