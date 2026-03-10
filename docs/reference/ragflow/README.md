# RAGFlow — Reference Documentation

**Date:** 2026-03-09
**Repository:** https://github.com/infiniflow/ragflow
**Website:** https://ragflow.io
**License:** Apache 2.0
**Stars:** ~40k+

## What is RAGFlow?

RAGFlow is an open-source Retrieval-Augmented Generation engine built on **deep document understanding**. Unlike most RAG frameworks that treat documents as flat text, RAGFlow uses computer vision models (OCR, layout recognition, table structure recognition) to parse documents into semantically meaningful chunks that preserve structure. It combines this with hybrid search (vector + full-text + sparse), agentic capabilities, and a human-in-the-loop chunk review UI.

Core flow: **upload** (documents in 23+ formats) -> **parse** (DeepDoc vision pipeline) -> **chunk** (layout-aware, template-based) -> **index** (hybrid vector + full-text) -> **retrieve** (multi-recall + reranking) -> **answer** (grounded with citations)

## Why This Reference Exists

RAGFlow solves a different problem than TopiaBrain's entity-centric knowledge graph. RAGFlow excels at **document understanding** — extracting structured content from PDFs, tables, images, and presentations. The patterns worth studying are:

1. **Layout-aware chunking** — visual models that understand document structure before chunking
2. **Human-in-the-loop chunk review** — users can view, edit, and annotate individual chunks
3. **Hybrid retrieval** — combining vector search, full-text search, and sparse vectors with reranking
4. **Ingestion pipeline orchestration** — visual ETL for unstructured data (v0.21+)

**Key difference from TopiaBrain:** RAGFlow is document-centric (parse files, chunk, retrieve). TopiaBrain is entity-centric (extract people/companies/projects, build a knowledge graph, generate profiles). RAGFlow's document understanding and HITL patterns are adoptable without changing TopiaBrain's core architecture.

## Documentation Index

| Document | Description |
|----------|-------------|
| [Architecture](architecture.md) | System layers, components, async processing, storage tiers |
| [Document Understanding](document-understanding.md) | DeepDoc vision pipeline: OCR, layout recognition, table structure |
| [Chunking Strategies](chunking-strategies.md) | Template-based chunking, ingestion pipeline, RAPTOR |
| [Human Intervention](human-intervention.md) | Chunk review UI, manual editing, keyword/tag annotation |
| [Retrieval](retrieval.md) | Hybrid search, reranking, citation grounding |
| [Storage](storage.md) | Elasticsearch, Infinity, OpenSearch — backend options |
| [On-Prem Deployment](on-prem-deployment.md) | Self-hosting, GPU requirements, Docker, model options |
| [Patterns for TopiaBrain](patterns-for-topiabrain.md) | Adoptable patterns: document understanding, HITL, retrieval |
