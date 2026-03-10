# GraphRAG — Storage Layer

## Default: Parquet Files

Output tables written as Parquet files in `./output/`:
- `final_entities.parquet`
- `final_relationships.parquet`
- `final_communities.parquet`
- `final_community_reports.parquet`
- `final_text_units.parquet`
- `final_covariates.parquet` (if claims enabled)
- `final_documents.parquet`

## Vector Store Options

```yaml
vector_store:
  type: lancedb          # default
  # alternatives: azure_ai_search, cosmosdb
  db_uri: ./output/lancedb
```

Supported: **LanceDB** (default, file-based, zero-config), Azure AI Search, CosmosDB.

## Storage Adapters

```yaml
output:
  type: file   # file | memory | blob | cosmosdb
cache:
  type: json   # json | memory | none
```

## PostgreSQL + pgvector Integration

**Not natively supported**, but feasible:

1. **Storage adapter**: Write custom adapter that writes Parquet-equivalent tables to PostgreSQL. Factory pattern makes this straightforward.
2. **Vector store adapter**: Use pgvector instead of LanceDB. Community projects:
   - [postgres-graph-rag](https://github.com/h4gen/postgres-graph-rag) — Python library for GraphRAG on PostgreSQL
   - [graphrag-psql](https://github.com/jimysancho/graphrag-psql) — PostgreSQL connector
   - [Azure samples](https://github.com/Azure-Samples/graphrag-legalcases-postgres) — Legal research copilot on PostgreSQL
3. **Graph queries**: Apache AGE extension adds Cypher query support to PostgreSQL
4. **Community detection**: Run Louvain in JavaScript, store results in PostgreSQL

Microsoft's own PostgreSQL integration documented in their [tech community blog](https://techcommunity.microsoft.com/blog/azure-ai-foundry-blog/graphrag-and-postgresql-integration-in-docker-with-cypher-query-and-ai-agents/4420623).

## On-Prem Minimum Requirements

| Component | Requirement |
|-----------|-------------|
| GPU | 12-24GB VRAM (RTX 3060/4090 or DGX) |
| LLM | llama3.1:8b via Ollama (32K context capable) |
| Embeddings | nomic-embed-text via Ollama |
| Storage | SSD (40% speed improvement over HDD) |
| Ollama config | `num_ctx: 12000` minimum |

### 8B Model Viability

**What works**: Basic entity extraction, simple relationship identification, embeddings, community detection (algorithmic).

**What struggles**: Complex structured output (tuple format), nuanced relationship descriptions, high-quality community reports (needs to synthesize many entities), multi-step reasoning. Context length: Ollama defaults to 2048; GraphRAG needs 12K+.

**Practical guidance**: 8B produces a *functional* graph with noisier entities and weaker summaries. Consider FastGraphRAG (NLP extraction) to eliminate entity extraction quality problem. For community reports, carefully tune prompts for 8B.
