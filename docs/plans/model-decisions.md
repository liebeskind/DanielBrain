# Model Decisions

## Current Models

### Extraction/Pipeline: llama3.3:70b (dense)
- **Last evaluated**: 2026-03-09
- **Why chosen**: Dense 70B gives strong reasoning for extraction, structured output, summarization. Proven reliable with project's LLM Prompting Standard. All 70B params active per token.
- **VRAM**: ~42.5GB
- **Used by**: extractor, fact-extractor, summarizer, intent-detector, entity-resolver, relationship-describer, community-summarizer, deep-research

### Chat: qwen3:14b (dense)
- **Last evaluated**: 2026-03-29
- **Why chosen**: RAG chat doesn't need 70B reasoning — context quality does the heavy lifting. Qwen3-14B matches Qwen2.5-32B on QA benchmarks while generating tokens 2-3x faster. Frees 70B for pipeline work.
- **VRAM**: ~10GB (with 8K context)
- **Used by**: conversation-routes (streamChat)
- **Config**: `think: false` (top-level, not in options — Ollama bug), `num_ctx: 8192`, `temperature: 0.3`, `top_p: 0.9`, `top_k: 20`, `presence_penalty: 1.5`
- **Safety**: `<think>` tags stripped from response as defense-in-depth

### Embeddings: nomic-embed-text
- **VRAM**: ~0.3GB
- **Used by**: embedder (storage + queries), requires `search_document:` / `search_query:` prefixes

**Total VRAM**: ~53GB on DGX Spark 128GB. `OLLAMA_MAX_LOADED_MODELS=3` in systemd override.

## Alternatives Considered

| Model | Type | Active Params | Status | Reason |
|-------|------|---------------|--------|--------|
| Qwen3-Next-80B-A3B | MoE | 3B | Rejected | Only 3B active params per token despite 80B name. Per-token reasoning closer to a small model. |
| llama4:scout | MoE | -- | Replaced | Was used briefly for relationship descriptions. Consolidated to llama3.3:70b for 2-model simplicity. |
| Smaller models (14B, 32B) | Dense | 14-32B | Rejected for extraction | Insufficient structured output reliability per Graphiti research. |
| qwen3:32b | Dense | 32B | Rejected for chat | Only 2-3% better than 14B on QA benchmarks, 2x slower, 2x VRAM. Not worth it when context quality is high. |
| llama3.1:8b | Dense | 8B | Rejected for chat | Significantly worse than qwen3:14b for instruction following and RAG QA. |

## Upgrade Candidates

| Model | Type | Active Params | Hardware | Notes |
|-------|------|---------------|----------|-------|
| Qwen3-80B | Dense | 80B | Single Spark | ~45 tok/s, significant upgrade from 70B |
| Qwen3-235B (NVFP4) | MoE | 22B | Single Spark (tight) | Demonstrated by NVIDIA with speculative decoding |
| Qwen3-235B | MoE | 22B | 2x Spark | Confirmed running at 23K tok/s |
| Qwen3.5-397B-A17B | MoE | 17B | 2x Spark | Latest Qwen flagship (2026) |
| DeepSeek V3.2 / R1 | MoE | -- | 8x H100 or Bedrock | 671B total |
| Kimi K2.5 | MoE | 32B active | Bedrock or 4-8x H100 | 1T total, MIT license |

## Decision Triggers

Re-evaluate when:
1. A new dense model >70B fits on single Spark
2. A new MoE with >20B active params fits on single Spark
3. Bedrock data sovereignty is approved for the org
4. Chat quality traces show qwen3:14b is insufficient (check `/admin/chat-traces`)

## Model-Dependent Architecture Decisions

These decisions are optimized for llama3.3:70b + qwen3:14b on DGX Spark. Revisit each time the primary model is upgraded.

| Decision | Current Choice | Revisit When | Alternative |
|----------|---------------|--------------|-------------|
| Pre-compute community summaries | Yes -- 70B benefits from pre-digested context | Model upgrade or Bedrock | LazyGraphRAG query-time exploration |
| Louvain community detection | Yes -- milliseconds on 500 nodes | 5K+ entities | Leiden algorithm |
| No LLM in query-time retrieval | Yes -- single GPU can't do 100+ calls/query | Bedrock adoption | Query-time relevance tests |
| Background summarization via poller | Yes -- amortizes GPU during idle time | Bedrock adoption | Shift to Bedrock |
| Single resolution (level 0) | Yes -- sufficient for ~500 entities | 1K+ entities | Hierarchical levels |
| Community summary embedding | Yes -- enables vector search | Never | N/A |
| Separate chat model (14B) | Yes -- frees 70B for pipeline, faster UX | 14B quality insufficient per traces | Upgrade to 32B or use 70B |
