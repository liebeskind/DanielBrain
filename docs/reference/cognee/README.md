# Cognee — Reference Documentation Baseline

**Baseline commit:** `c9370a8b` (2026-03-08)
**Repository:** https://github.com/topoteretes/cognee
**Version:** v0.5.4.dev1 (dev), v0.5.3 (stable, Feb 27 2026)
**License:** Apache 2.0
**Stars:** ~13.1k | **Releases:** 84 | **Commits:** 5,900+

## What is Cognee?

Cognee is an open-source framework for building knowledge graphs from unstructured data using LLMs. It provides a pipeline-based system that ingests text, extracts entities and relationships via structured LLM output, stores them in a graph database, and supports multiple retrieval strategies for RAG applications.

Core flow: **add** (ingest data) → **cognify** (extract entities, build graph) → **search** (retrieve via 15+ strategies)

## Why This Baseline Exists

TopiaBrain and cognee solve overlapping problems (knowledge graphs, entity extraction, semantic search) with fundamentally different approaches. This documentation captures cognee's architecture as a reference for patterns worth adopting — not as a dependency to integrate.

**Key difference:** Cognee assumes capable LLMs (32B+ for reliable structured output). TopiaBrain is designed to work despite limited models (8B) via deterministic matching, junk filtering, and confidence-gated human review.

## Documentation Index

| Document | Description |
|----------|-------------|
| [Architecture](architecture.md) | Module organization, database tiers, pipeline-as-DAG model |
| [Pipeline & Tasks](pipeline-and-tasks.md) | Task abstraction, execution stack, batch parallelism |
| [Data Model](data-model.md) | Node/Edge/KnowledgeGraph models, DataPoint base class, chunk schema |
| [Entity Extraction](entity-extraction.md) | Extraction pipeline, ontology resolver, fuzzy matching |
| [Chunking](chunking.md) | Hierarchical chunking strategies (word → sentence → paragraph) |
| [Storage Layer](storage-layer.md) | Graph, vector, and relational database abstractions |
| [Retrieval](retrieval.md) | 15+ retrieval strategies including graph completion and temporal |
| [MCP & API](mcp-and-api.md) | 7 MCP tools, CogneeClient, FastAPI REST endpoints |
| [Multi-tenancy](multi-tenancy.md) | JWT auth, ContextVar isolation, session management |
| [Comparison to TopiaBrain](comparison-to-topiabrain.md) | Gap analysis, what to adopt vs skip, on-prem viability |

## Future Diff Tracking

To see what changed in cognee since this baseline:

```bash
# Via GitHub API
gh api repos/topoteretes/cognee/compare/c9370a8b...main --jq '.files[] | .filename'

# Clone and diff locally
git clone https://github.com/topoteretes/cognee.git
cd cognee
git diff c9370a8b..HEAD --stat
```

## Key Takeaways

1. **Composable retrieval strategies** — cognee's retriever pattern (15+ strategies with a common interface) is the highest-value pattern to adopt
2. **Pipeline task abstraction** — their Task class wrapping any callable into a DAG-composable unit is elegant
3. **Temporal retrieval** — we have timestamps but don't leverage them in search; cognee shows how
4. **Session management** — directly useful for our upcoming chat feature
5. **On-prem is possible but model-limited** — 8B models produce garbage; 32B+ minimum for their pipeline
6. **Our HITL approach is superior for small models** — cognee has no equivalent to our approvals queue
