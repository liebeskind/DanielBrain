# Patterns from RAGFlow Adoptable by TopiaBrain

## Priority 1: Hybrid Retrieval

**What RAGFlow does**: Combines dense vector search + BM25 full-text search + sparse vectors, with reranking on merged results.

**What TopiaBrain should adopt**: Add PostgreSQL full-text search (`tsvector` + `ts_rank`) alongside existing pgvector search. Run both in parallel, merge results, deduplicate.

**Why**: Pure vector search misses exact keyword matches. When someone asks "what did Chris say about the Topia rebrand?", BM25 catches "Topia rebrand" as an exact phrase while vector search finds semantically similar content. Combined, recall improves significantly.

**Effort**: Low-medium. PostgreSQL already supports `tsvector`. Add a GIN index on thought content, run parallel queries in `match_thoughts()`, merge by score.

## Priority 2: Source-Specific Chunking Templates

**What RAGFlow does**: Different chunking templates for different document types (book, paper, laws, presentation, email, etc.). Each template understands the structure of its source type.

**What TopiaBrain should adopt**: Source-specific chunking for the three current input types:
- **Slack messages**: chunk by thread/conversation, not by token count
- **Fathom transcripts**: chunk by speaker turn or topic segment, preserving meeting context
- **Manual thoughts** (save_thought): keep as-is (already atomic)

**Why**: A Fathom transcript chunked by token count splits mid-sentence and loses speaker attribution. Chunking by speaker turn preserves "who said what" — critical for meeting prep.

**Effort**: Medium. The topiabrain-summarizer plan already envisions source-specific processing. Extending the chunker with source-aware templates is a natural next step.

## Priority 3: Chunk-Level Review UI

**What RAGFlow does**: Users can click on any parsed document to see its chunks, double-click to edit content, add keywords, add questions.

**What TopiaBrain should adopt**: Extend the admin dashboard with a thought/chunk review view:
- Show individual chunks for long thoughts (Fathom transcripts)
- Allow editing chunk content (fix transcription errors)
- Allow adding keywords to boost retrieval
- Show the source thought alongside its chunks

**Why**: Fathom transcripts have OCR/transcription errors. Entity extraction sometimes misidentifies people. A review UI lets admins fix these without SQL.

**Effort**: Medium. Admin dashboard already exists. Adding a thought detail view with editable chunks is incremental.

## Priority 4: RAPTOR-Style Hierarchical Summarization

**What RAGFlow does**: After chunking, clusters chunks by semantic similarity, summarizes clusters, recursively builds a tree of summaries.

**What TopiaBrain should adopt**: This aligns with the community detection plan (Phase 5 of TopiaBrain plan). Instead of just entity communities, apply to thoughts:
1. Cluster related thoughts (by entity overlap + embedding similarity)
2. Generate cluster summaries
3. Index summaries as searchable higher-level context
4. Queries can match specific thoughts or broad themes

**Why**: A query like "what is our product strategy?" should match a synthesized summary, not force the LLM to piece together 50 individual thoughts.

**Effort**: High. Requires clustering infrastructure, LLM summarization, new indexing. But the plan already exists — RAPTOR validates the approach.

## Priority 5: Reranking

**What RAGFlow does**: After multi-recall, a reranking model (BCE/BGE/Jina or ColBERT tensor reranking) re-scores results.

**What TopiaBrain should adopt**: Add a lightweight reranking step after `match_thoughts()`. Options:
- **Cross-encoder reranking** via Ollama (run top-N results through a small model)
- **Reciprocal Rank Fusion** (simpler: merge vector + full-text results by rank position)

**Why**: Initial recall (top 50) is broad; reranking narrows to the most relevant top 10. Especially valuable when combining vector + full-text results.

**Effort**: Low for RRF (pure algorithm, no model). Medium for cross-encoder (needs model serving).

## Not Adopting (and Why)

### DeepDoc Vision Pipeline
RAGFlow's OCR/layout/TSR models are designed for parsing uploaded documents (PDFs, scanned images). TopiaBrain's inputs are already text (Slack messages, Fathom transcripts, manual thoughts). No need for document vision unless TopiaBrain starts ingesting PDFs or images.

### Elasticsearch/Infinity Backend
RAGFlow needs a separate search engine because it pushes beyond what PostgreSQL offers (sparse vectors, tensor reranking, phrase scoring). TopiaBrain's scale and query patterns are well-served by PostgreSQL + pgvector + tsvector. Adding Elasticsearch would increase operational complexity without proportional benefit at current scale.

### Visual Ingestion Pipeline (Agent Canvas)
RAGFlow's drag-and-drop pipeline builder is powerful for users with diverse document types. TopiaBrain has a fixed set of input sources (Slack, Fathom, manual) with deterministic processing. A visual pipeline builder adds complexity without benefit — code-defined pipelines are more maintainable for this use case.

## Summary: Adoption Roadmap

| Priority | Pattern | Effort | Impact |
|----------|---------|--------|--------|
| 1 | Hybrid retrieval (vector + full-text) | Low-Med | High |
| 2 | Source-specific chunking templates | Medium | High |
| 3 | Chunk-level review UI | Medium | Medium |
| 4 | RAPTOR-style hierarchical summaries | High | High |
| 5 | Reranking (RRF or cross-encoder) | Low-Med | Medium |
