# GraphRAG — Comparison to TopiaBrain

## Feature Matrix

| Capability | TopiaBrain | GraphRAG |
|-----------|------------|----------|
| Entity extraction | LLM-based (llama3.1:8b) | LLM-based (GPT-4 class) or NLP |
| Entity types | person, company, topic, product, project, place | Configurable (default: PERSON, ORG, LOCATION, EVENT) |
| Entity resolution | Normalize + canonical match + alias + first-name prefix | Simple dedup by name+type |
| Relationship types | mentions, about, from, assigned_to, created_by | Descriptive (free text) with strength score |
| Entity profiles | LLM-generated, embedded, staleness-aware | Entity descriptions (summarized from extraction) |
| Vector search | pgvector (HNSW) | LanceDB / Azure AI Search |
| Storage | PostgreSQL | Parquet files |
| HITL/Approvals | Confidence-gated proposals, admin dashboard | **None** |
| Community detection | **None** | Hierarchical Leiden |
| Community summaries | **None** | LLM-generated reports at each level |
| Global search | **None** | Map-reduce over community reports |
| Entity-to-entity relationships | Schema exists, not populated | Core feature (descriptions + strength) |

## What TopiaBrain Is Missing

1. **Community detection** — no way to group related entities into coherent topics/clusters
2. **Hierarchical summaries** — no multi-level summarization for navigating the knowledge graph
3. **Global search** — can answer "what do we know about X?" but not "what are the main themes across all data?"
4. **Rich relationship descriptions** — typed relationships but no free-text descriptions or strength scores
5. **Entity-to-entity relationships populated** — junction table exists but isn't used

## What TopiaBrain Has That GraphRAG Doesn't

1. **HITL approvals queue** — zero human-in-the-loop quality control in GraphRAG
2. **Confidence-gated proposals** — prefix matches, enrichment, merges go through review
3. **Incremental updates** — thoughts processed one at a time; GraphRAG requires full re-indexing
4. **Entity staleness tracking** — refresh profiles after 10 new mentions or 7 days
5. **Source-aware processing** — different handling for Slack, Telegram, Fathom
6. **Admin dashboard** — visual review UI
7. **MCP integration** — ready for AI agent access

## "GraphRAG Lite" Implementation Plan

Practical plan using PostgreSQL + pgvector + Ollama (llama3.1:8b):

### Phase 1: Entity-to-Entity Relationships (Foundation)

Populate existing `entity_relationships` table during entity resolution:
- When two entities appear in the same thought, create/update a relationship
- Store: `source_entity_id`, `target_entity_id`, `relationship_type`, `weight` (increment on co-occurrence), `description`

```sql
ALTER TABLE entity_relationships ADD COLUMN IF NOT EXISTS weight INTEGER DEFAULT 1;
ALTER TABLE entity_relationships ADD COLUMN IF NOT EXISTS description TEXT;
```

### Phase 2: Community Detection

Use **Louvain** via [graphology-communities-louvain](https://graphology.github.io/standard-library/communities-louvain.html) (JavaScript):

```typescript
import { louvain } from 'graphology-communities-louvain';

const graph = new Graph();
for (const entity of entities) graph.addNode(entity.id);
for (const rel of relationships) graph.addEdge(rel.source_id, rel.target_id, { weight: rel.weight });

const communities = louvain(graph, { resolution: 1.0 });
```

New tables:
```sql
CREATE TABLE communities (
  id SERIAL PRIMARY KEY,
  level INTEGER NOT NULL DEFAULT 0,
  title TEXT,
  summary TEXT,
  full_report TEXT,
  embedding vector(768),
  member_count INTEGER,
  created_at TIMESTAMPTZ DEFAULT now(),
  updated_at TIMESTAMPTZ DEFAULT now()
);

CREATE TABLE entity_communities (
  entity_id INTEGER REFERENCES entities(id),
  community_id INTEGER REFERENCES communities(id),
  level INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (entity_id, community_id)
);
```

### Phase 3: Community Summarization

For each community, LLM generates summary from member entity profiles + recent thought excerpts. Embed summary for vector search. Same pattern as existing profile generation but at group level.

### Phase 4: Global Search

**Simplified version** (not full map-reduce): vector search over community summary embeddings, pull top-K communities, use as context for single LLM call. Much cheaper and works with 8B models.

### Phase 5: Hierarchical Communities (Optional)

Run Louvain at multiple resolution values:
- Resolution 1.0 = fine-grained (Level 0)
- Resolution 0.5 = coarser (Level 1)
- Resolution 0.2 = very broad (Level 2)

## Key Architectural Decisions

1. **Louvain, not Leiden** — JS implementations exist; Leiden requires Python
2. **Incremental community updates** — scheduled job (hourly/daily), not per-thought. Mark stale when members change.
3. **Simplified global search** — vector search over community embeddings + single LLM call, not map-reduce
4. **Keep HITL** — our proposals system is a genuine advantage. Community summaries could also go through review.
5. **Build on existing profiles** — community summaries are natural extensions of entity profiles
6. **PostgreSQL-native** — no Parquet, no separate graph DB. Community detection in-memory on app side, results in SQL.
