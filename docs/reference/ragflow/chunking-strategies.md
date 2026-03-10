# RAGFlow Chunking Strategies

## Overview

RAGFlow provides template-based chunking — predefined strategies optimized for specific document types. Since v0.17.0, chunking is decoupled from parsing: you choose a parser (how to extract data) and independently choose a chunking method (how to split it).

## Built-in Chunking Templates

| Template | ID | Description |
|----------|----|-------------|
| **General** | `naive` | Default. Token-based splitting with configurable chunk size and overlap. Works for any document type. |
| **Q&A** | `qa` | Extracts question-answer pairs from content. Useful for FAQ documents. |
| **Book** | `book` | Respects chapter/section structure. Chunks align with book hierarchy. |
| **Paper** | `paper` | Academic paper layout: abstract, sections, references treated as distinct regions. |
| **Laws** | `laws` | Legal document structure: articles, clauses, subsections. |
| **Presentation** | `presentation` | Slide-by-slide chunking, preserving slide boundaries. |
| **Table** | `table` | Spreadsheet/table content, output as HTML preserving structure. |
| **Picture** | `picture` | Image-based content, OCR + caption extraction. |
| **One** | `one` | Entire document as a single chunk. |
| **Email** | `email` | Email structure: headers, body, attachments handled separately. |
| **Manual** | `manual` | User-defined chunk boundaries. |
| **Knowledge Graph** | `knowledge_graph` | Generates entity-relationship triples from chunks. Adds KG-derived chunks on top of base chunking. |
| **Tag** | `tag` | Auto-tags chunks against user-defined tag sets based on similarity. |

## Naive (General) Chunking Configuration

The `naive` template is the most commonly used and supports these parameters:
- **Chunk size** — target token count per chunk
- **Overlap** — token overlap between consecutive chunks
- **Delimiter** — custom split points (newlines, periods, etc.)

When used with DeepDoc parser, it is layout-aware: chunks respect paragraph, table, and figure boundaries identified by the vision pipeline. Without DeepDoc (plain text), it falls back to simple token splitting.

## RAPTOR — Hierarchical Summarization

RAGFlow implements RAPTOR (Recursive Abstractive Processing for Tree Organized Retrieval), available as an enhancement to most chunking templates (`naive`, `qa`, `paper`, `book`, `laws`, `presentation`).

RAPTOR works after initial chunking:
1. Clusters chunks by **semantic similarity** (not document order)
2. Summarizes each cluster into a higher-level chunk using the configured chat LLM
3. Recursively repeats: clusters of summaries get further summarized
4. Result: a hierarchical tree from leaf chunks up to high-level summaries

**Retrieval benefit**: queries can match at any level of abstraction — specific detail (leaf) or broad theme (root summary).

## Knowledge Graph Chunking

When "Knowledge Graph" is selected as the chunking method:
1. Documents are first chunked using a base method
2. An additional KG construction step extracts named entities and relationships
3. Entity nodes, descriptions, and "communities" are created
4. These become additional searchable chunks alongside the original text chunks
5. Visualization: knowledge graph displayed as node graph or mind map in the UI

This is RAGFlow's GraphRAG implementation — entity extraction + community detection + graph-based retrieval.

## Ingestion Pipeline (v0.21+) — Custom Chunking

The ingestion pipeline allows users to build custom chunking workflows using a visual canvas:

**Transformer components** (run between parsing and indexing):
- **Chunker** — configurable token-based splitting
- **LLM Summarizer** — generates summaries per chunk
- **Keyword Extractor** — extracts keywords per chunk
- **Question Generator** — generates questions that each chunk answers
- **Metadata Enricher** — adds LLM-generated metadata

Users can chain these in any order, creating pipelines like:
`Parse PDF -> Chunk by 500 tokens -> Generate keywords -> Generate questions -> Summarize -> Index`

This is the "Lego building blocks" approach — modular, visual, user-orchestrated.

## Key Insight for TopiaBrain

Two patterns worth adopting:

1. **Template-based chunking**: Different source types (Slack messages, Fathom transcripts, future documents) could benefit from source-specific chunking templates rather than one-size-fits-all token splitting.

2. **RAPTOR-style hierarchical summarization**: TopiaBrain already generates thought summaries. A recursive clustering step (group related thoughts, summarize clusters) would create higher-level context chunks — essentially the "community detection" in the TopiaBrain plan.
