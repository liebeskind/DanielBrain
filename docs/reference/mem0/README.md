# Mem0 — Reference

**Repository**: [mem0ai/mem0](https://github.com/mem0ai/mem0) (~48k stars)
**Paper**: [arXiv 2504.19413](https://arxiv.org/abs/2504.19413)
**License**: Apache 2.0
**Category**: Tier 1 — Deep Dive

## What It Is

Memory layer for AI applications with LLM-driven memory lifecycle management. Core innovation: every new piece of information triggers a decision chain — ADD new memory, UPDATE existing memory, DELETE contradicted memory, or NOOP (already known). This gives agents self-maintaining, non-redundant memory.

**Dual storage**: vector store (26 backend options) + optional graph memory (Neo4j/Memgraph/Kuzu) for entity relationships.

**LLM call chain**: Each `add()` call makes 2-4 LLM calls — fact extraction, similarity search, update decision (ADD/UPDATE/DELETE/NOOP), and optional graph extraction.

**OpenMemory MCP**: 5 tools (add_memories, search_memory, list_memories, delete_memories, delete_all_memories) via FastMCP SSE transport.

## Critical Finding: 8B Model Limitation

The update decision prompt requires nuanced semantic comparison (e.g., "I live in SF" vs "I moved to NYC" → UPDATE). 8B models struggle with this. Our proposals queue mitigates: route uncertain decisions to human review instead of auto-applying.

## Doc Index

| File | Focus |
|------|-------|
| [README.md](README.md) | This file — overview and doc index |
| [architecture.md](architecture.md) | Dual storage design, LLM call chain, project structure |
| [data-model.md](data-model.md) | MemoryItem fields, scoping, metadata, graph structures |
| [memory-lifecycle.md](memory-lifecycle.md) | ADD/UPDATE/DELETE/NOOP pipeline, conflict resolution |
| [graph-memory.md](graph-memory.md) | Entity extraction, relationship building, dedup, Neo4j patterns |
| [mcp-and-api.md](mcp-and-api.md) | OpenMemory MCP server, REST API, Docker stack |
| [retrieval.md](retrieval.md) | Vector search, graph retrieval, BM25 reranking, filters |
| [storage-layer.md](storage-layer.md) | 26 vector stores, 5 graph stores, multi-tenancy |
| [comparison-to-topiabrain.md](comparison-to-topiabrain.md) | Gap analysis, patterns to adopt, on-prem viability |

## Top Patterns to Adopt (Priority Order)

1. **Memory dedup/conflict resolution** — LLM-driven ADD/UPDATE/DELETE/NOOP lifecycle, routed through our proposals queue
2. **Atomic fact extraction** — extract individual facts from thoughts for independent search/update
3. **Memory history/audit trail** — track changes to entities and facts over time
4. **Customizable LLM prompts** — templated prompts for different operations

## Sources

- [Mem0 GitHub](https://github.com/mem0ai/mem0)
- [Mem0 Docs](https://docs.mem0.ai/)
- [Mem0 Academic Paper](https://arxiv.org/abs/2504.19413)
- [OpenMemory MCP Docs](https://docs.mem0.ai/openmemory/overview)
- [Mem0 Graph Memory Docs](https://docs.mem0.ai/open-source/features/graph-memory)
