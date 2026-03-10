# GraphRAG — Community Detection

## Hierarchical Leiden Algorithm

GraphRAG uses Hierarchical Leiden from [graspologic](https://github.com/graspologic-org/graspologic).

### How It Works

1. Start with the full entity-relationship graph
2. Apply Leiden algorithm at base resolution → Level 0 communities
3. Any community exceeding `max_cluster_size` is extracted as a subgraph
4. Leiden recursively applied to each oversized subgraph
5. Sub-communities mapped back into original community map
6. Higher levels created by aggregating Level 0 communities and re-running Leiden
7. Typical datasets produce 3-5 hierarchical levels

### Key Parameters

- `max_cluster_size` (default: 10) — threshold for recursive subdivision
- `resolution` — controls partition coarseness (higher = more clusters)
- `seed` — for reproducibility
- `use_lcc` — whether to use largest connected component only

### Properties

- Every node belongs to exactly one community at each level (mutually exclusive, exhaustive)
- No node is left unassigned
- Level 0 = finest (most communities), higher levels = coarser (fewer, larger)

## Community Report Generation

For each community at each level, the LLM generates a report.

**Input**: All entity descriptions + relationship descriptions + claims within the community.

**Output**:
```json
{
  "title": "Community Title",
  "summary": "Executive overview...",
  "rating": 7.5,
  "rating_explanation": "Why this community is significant...",
  "findings": [
    {
      "summary": "Key insight 1",
      "explanation": "Detailed explanation... [Data: Entities (1, 2); Relationships (3, 4)]"
    }
  ]
}
```

## Why Communities Enable Global Search

Without communities, answering "what are the main themes?" requires scanning every document. Communities pre-organize the graph into coherent topic clusters with LLM-written summaries. Global search then only needs to map-reduce over these summaries, not raw text.

## For TopiaBrain: Louvain Instead of Leiden

**Use Louvain, not Leiden** — JavaScript implementations exist ([graphology-communities-louvain](https://graphology.github.io/standard-library/communities-louvain.html)), while Leiden requires Python/graspologic. Louvain is sufficient at our scale.

Multi-resolution hierarchy:
- Resolution 1.0 = fine-grained (Level 0)
- Resolution 0.5 = coarser (Level 1)
- Resolution 0.2 = very broad (Level 2)

Run as scheduled job (hourly/daily), not per-thought. Mark communities stale when member entities change.
