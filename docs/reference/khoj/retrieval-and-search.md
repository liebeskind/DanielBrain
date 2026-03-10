# Khoj Retrieval & Search

## Two-Stage Retrieval Pipeline

Khoj uses a classic two-stage retrieval architecture:

1. **Stage 1: Bi-encoder retrieval** -- fast candidate selection via vector similarity
2. **Stage 2: Cross-encoder reranking** -- precise relevance scoring on top candidates

This is the same pattern used by production search systems (Google, Bing) and is considered state-of-the-art for RAG applications.

### Source File
`src/khoj/search_type/text_search.py`

## Stage 1: Bi-Encoder Retrieval

### How It Works
- Documents are chunked and embedded at index time using a bi-encoder model
- Embeddings are stored in PostgreSQL using pgvector
- At query time, the user's query is embedded using the same bi-encoder
- pgvector performs approximate nearest neighbor search (HNSW index)
- Returns top-K candidates (typically 10-50)

### Default Model
- `paraphrase-multilingual-MiniLM-L12-v2` -- supports 50+ languages
- From the sentence-transformers library
- Runs locally (no API calls needed)
- Decent quality/speed tradeoff for consumer hardware

### Configurable Models
Via the admin panel (`SearchModelConfig`), you can configure:
- **Bi-encoder model name** -- any sentence-transformers compatible model
- **Embeddings inference endpoint** -- use OpenAI, Azure, or any compatible API
- **Embeddings inference endpoint type** -- API provider type
- **API key** -- for remote embedding APIs

### Vector Storage
- pgvector `VectorField` on the `Entry` model
- HNSW index for fast approximate nearest neighbor search
- Cosine similarity (or L2 distance) for scoring

## Stage 2: Cross-Encoder Reranking

### How It Works
- Takes the top-K candidates from bi-encoder retrieval
- Passes each (query, document) pair through a cross-encoder model
- Cross-encoder produces a single relevance score per pair
- Results are re-sorted by cross-encoder score

### Why Cross-Encoder?
- Bi-encoders encode query and document independently -- fast but less accurate
- Cross-encoders process query and document together -- slower but much more accurate
- The two-stage approach gets the best of both: speed from bi-encoder, accuracy from cross-encoder

### Graceful Degradation
- Cross-encoder reranking is conditionally applied based on result count and model availability
- If cross-encoder fails, system falls back to bi-encoder results with logging
- Ensures the search pipeline never breaks even if the reranker has issues

## Query Routing

### LLM-Based Intent Detection
Khoj uses the configured chat model to determine search strategy:

1. Should we search the personal knowledge base?
2. Should we search the web?
3. What are the optimal search queries? (query reformulation)
4. Is this a question that needs retrieval at all?

The LLM reformulates the user's conversational query into one or more optimized search queries. This is critical because conversational queries ("what did we discuss about the budget last week?") are poor search queries, but "budget discussion Q1 2026" works much better.

### Query Types
- **Notes search**: Search only personal knowledge base
- **Online search**: Search only the web
- **Hybrid**: Search both knowledge base and web
- **No search**: Direct LLM response (general knowledge questions)

## Embedding Pipeline

### At Index Time
```
Document → Content Processor → Chunks → Bi-encoder → Embeddings → pgvector
```

1. Raw document parsed by type-specific processor (PDF, Markdown, etc.)
2. Large entries split via `RecursiveCharacterTextSplitter` (from LangChain)
3. Each chunk embedded using the configured bi-encoder model
4. Embeddings stored in `Entry.embeddings` (pgvector VectorField)
5. Only new/modified entries are re-embedded (incremental updates)

### At Query Time
```
User Query → LLM Query Reformulation → Bi-encoder → pgvector ANN → Cross-encoder Rerank → Top Results
```

## Search Filters

Text search supports filtering by:
- **Content type** (markdown, pdf, org, etc.)
- **File source** (which connected source)
- **User** (multi-user isolation)
- **Date** (extracted dates from content)
- **Agent knowledge base** (scope to agent-specific docs)

## Context Assembly for Chat

After search results are obtained, they are formatted and assembled into the chat context:

1. Top reranked results are formatted with source metadata
2. Each reference includes: content excerpt, source file/URL, relevance indicators
3. References are injected into the prompt template's context section
4. The LLM receives: system prompt + persona + context references + conversation history + query
5. The LLM is instructed to cite references when using information from them

## Key Design Patterns

1. **Two-stage retrieval**: Industry-standard approach that balances speed and accuracy
2. **LLM query reformulation**: Converts conversational queries into search-optimized queries
3. **Local embedding models**: No API calls needed for search; runs on CPU
4. **Graceful fallback**: Cross-encoder failure degrades to bi-encoder results, not errors
5. **Incremental indexing**: Only re-embeds changed content, not the entire corpus
6. **Multi-user isolation**: Search results are always scoped to the requesting user
