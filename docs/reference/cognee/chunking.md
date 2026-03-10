# Chunking Strategies

Baseline: `c9370a8b` (2026-03-08)

## Overview

**Directory:** `cognee/tasks/chunks/`

Cognee implements hierarchical, composable chunking: word → sentence → paragraph. Each level builds on the previous, enabling fine-grained control over chunk boundaries.

## Chunking Hierarchy

```
Raw text
  │
  ▼
chunk_by_word     → (word, classification) tuples
  │
  ▼
chunk_by_sentence → sentence strings respecting max_size
  │
  ▼
chunk_by_paragraph → metadata-rich chunk dicts with UUIDs
```

## Strategies

### 1. `chunk_by_word`

The lowest-level chunker. Tokenizes text into individual words and classifies each:

- **Input:** raw text string
- **Output:** generator of `(word, classification)` tuples
- **Classification:** identifies word boundaries, sentence endings, paragraph breaks
- Used as input to higher-level chunkers

### 2. `chunk_by_sentence`

Clusters words into sentences:

- **Input:** word tuples from `chunk_by_word`
- **Output:** sentence strings
- **Respects `max_size`** — splits overly long sentences
- Sentence boundaries detected via word classification (periods, question marks, etc.)

### 3. `chunk_by_paragraph`

The primary chunking strategy. Yields metadata-rich chunk dictionaries:

- **Input:** sentence stream from `chunk_by_sentence`
- **Output:** chunk dicts with full metadata

```python
{
    "text": str,           # chunk content
    "chunk_size": int,     # size in tokens/words
    "chunk_id": UUID5,     # deterministic from content hash
    "paragraph_ids": list, # parent paragraph references
    "chunk_index": int,    # position in document
    "cut_type": str,       # paragraph_end, sentence_end, word_end, etc.
}
```

Key properties:
- **UUID5 chunk IDs** — deterministic from content, enabling dedup across ingestions
- **cut_type** tracking — records why a chunk boundary was placed (natural paragraph break vs forced split)
- **paragraph_ids** — maintains document structure hierarchy

### 4. `chunk_by_row`

Delimiter-based splitting for structured data:

- **Input:** text with known delimiters (CSV rows, log lines, etc.)
- **Output:** individual rows/lines as chunks
- Simpler than paragraph chunking — no hierarchical composition

## Chunk Associations

After chunking, cognee creates **chunk associations** — semantic links between chunks:

- Chunks from the same document are linked
- Adjacent chunks get stronger association scores
- Enables graph-based traversal between related chunks during retrieval

This is stored as edges in the graph database, making chunks first-class graph citizens alongside entities.

## Contrast with TopiaBrain

| Aspect | Cognee | TopiaBrain |
|--------|--------|------------|
| Strategy | Hierarchical word→sentence→paragraph | Single-pass by estimated tokens |
| Chunk IDs | UUID5 from content (deterministic) | Database-generated IDs |
| Metadata | Rich (cut_type, paragraph_ids, chunk_index) | Minimal (parent thought reference) |
| Overlap | Not explicit in chunking (handled via associations) | 100-token overlap between chunks |
| Threshold | Configurable max_size per level | 2000 estimated tokens, ~1000 per chunk |
| Associations | Graph edges between related chunks | Parent-child thought relationship only |

### What's Worth Considering

**Chunk associations** — Our chunks are linked to their parent thought but not to each other. Adding associations (especially for adjacent chunks) could improve retrieval when a query spans chunk boundaries.

**Hierarchical chunking** — Our single-pass chunker works but loses document structure. The word→sentence→paragraph approach preserves natural boundaries. However, our current approach is simpler and adequate for our input types (Slack messages, meeting transcripts, manual thoughts).

**Deterministic chunk IDs** — UUID5 from content enables dedup across re-ingestion. Our queue source_id provides dedup at the thought level, but not at the chunk level.
