# Phase 7b: Relationship Explorer

Interactive graph visualization of the entity knowledge graph, built on Cytoscape.js. Depends on Phase 7 (community detection) for cluster data.

## Goals

- Visually explore entity relationships — who connects to whom, through what, and how strongly
- Surface community structure from Phase 7 (Louvain clusters)
- Provide drill-down from graph → entity detail → source thoughts
- No build step — vanilla HTML/CSS/JS, consistent with existing admin dashboard

## Library Choice: Cytoscape.js

Selected over D3 (too low-level), vis.js (less active), Sigma.js (overkill for <500 nodes), and force-graph (no graph algorithms).

**Why Cytoscape.js:**
- Purpose-built for graph visualization and analysis
- Built-in layouts: cose (force-directed), concentric, breadthfirst, circle
- Built-in graph algorithms: centrality, connected components, PageRank
- Rich interactivity out of the box (pan, zoom, click, hover, selection)
- Works from CDN with vanilla JS — no build step
- Handles 100-500 nodes smoothly (our expected scale)
- CDN: `https://unpkg.com/cytoscape/dist/cytoscape.min.js`

## Graph Data Model

### Nodes (entities)
- `id`: entity UUID
- `name`: display name
- `entity_type`: person | company | topic | product | project | place
- `mention_count`: controls node size
- `community_id`: from Phase 7 Louvain detection — controls cluster color
- `profile_summary`: shown in detail panel
- `last_seen_at`: staleness indicator (dim old nodes)

### Edges (entity_relationships)
- `source` / `target`: entity UUIDs
- `weight`: co-occurrence count — controls edge width
- `description`: LLM-generated relationship summary (hover/click label)
- `relationship`: type string (e.g., "co_occurs")
- `valid_at` / `invalid_at`: temporal validity

## New API Endpoint

```
GET /admin/api/graph
Query params:
  - min_weight (default 1): filter weak edges
  - entity_types (comma-separated): filter by type
  - community_id: filter to single community
  - days_back: only entities seen within N days
  - include_inactive (default false): include invalidated temporal edges

Response:
{
  nodes: [{
    id, name, entity_type, mention_count, community_id,
    profile_summary, last_seen_at, aliases
  }],
  edges: [{
    id, source, target, weight, description,
    relationship, valid_at, invalid_at, source_thought_ids
  }],
  communities: [{
    id, name, summary, member_count
  }]
}
```

Single endpoint returns the full graph payload. Filtering happens server-side to keep the client simple.

## UI Layout

```
┌─────────────────────────────────────────────────────────┐
│  Relationship Explorer                    [Layout ▼]    │
├────────┬────────────────────────────────────────────────┤
│ FILTERS│                                                │
│        │                                                │
│ Types  │         Cytoscape.js Canvas                    │
│ ☑ person│        (force-directed graph)                 │
│ ☑ company│                                              │
│ ☑ topic │                                               │
│ ☐ place │                                               │
│        │                                                │
│ Weight │                                                │
│ [==2==]│                                                │
│        │                                                │
│ Time   │                                                │
│ [All ▼]│                                                │
│        │                                                │
│ Search │                                                │
│ [____] │                                                │
│        ├────────────────────────────────────────────────┤
│Community│  DETAIL PANEL (click node or edge)            │
│ All    │  Entity: Chris Psiaki (person)                 │
│ Topia  │  Profile: CTO at Topia, leads engineering...   │
│ K12    │  Mentions: 47 | Last seen: 2d ago              │
│        │  Community: Topia Leadership                   │
│        │  Connected: 12 entities                        │
│        │  Top connections:                               │
│        │    Rob Fisher (weight 15) — co-founders...     │
│        │    Topia (weight 23) — CTO of...               │
│        │  Recent thoughts: [3 excerpts]                 │
└────────┴────────────────────────────────────────────────┘
```

## Visual Encoding

| Property | Visual | Example |
|----------|--------|---------|
| Entity type | Node color | person=blue, company=green, topic=purple, project=orange, product=red, place=teal |
| Community | Node border color or background tint | Louvain cluster ID → color palette |
| Mention count | Node size | More mentions → larger node |
| Staleness | Node opacity | Dim entities not seen in 30+ days |
| Edge weight | Edge width | Higher co-occurrence → thicker line |
| Edge description | Edge tooltip/label on hover | LLM-generated text |
| Temporal invalidity | Edge style | Dashed line for invalidated edges |

## Interactions

### Node interactions
- **Hover**: Tooltip with name, type, mention count
- **Click**: Open detail panel with profile, connections, recent thoughts
- **Double-click**: Focus mode — highlight only this node's neighborhood (dim others)
- **Right-click or button**: "Open in Entities page" link

### Edge interactions
- **Hover**: Show LLM description tooltip
- **Click**: Detail panel shows description, weight, source thoughts (via source_thought_ids)

### Global controls
- **Layout switcher**: cose (force-directed), concentric (by type or community), circle
- **Zoom to fit**: reset view
- **Export**: PNG screenshot of current view
- **Legend**: color key for entity types

## Implementation Steps

1. **API endpoint** (`/admin/api/graph`): Single SQL query joining entities + entity_relationships + community data from Phase 7. Server-side filtering.
2. **Admin page** (`/admin/relationships.html`): HTML shell with Cytoscape container, filter sidebar, detail panel.
3. **Graph initialization** (`relationships.js`): Fetch `/admin/api/graph`, build Cytoscape elements, apply stylesheet, bind events.
4. **Filtering**: Client-side show/hide via Cytoscape selectors (fast for <500 nodes). Re-fetch only when server-side params change (days_back).
5. **Detail panel**: On node click, fetch full entity data from existing `/admin/api/entities/stats` or add a lightweight `/admin/api/entities/:id` endpoint.
6. **Community integration**: Color nodes by `community_id`, add community filter in sidebar, optionally show community boundaries via Cytoscape compound nodes.

## Dependencies

- **Phase 7 (Community Detection)**: Louvain clusters, community summaries. Without this, the explorer still works but lacks cluster coloring/filtering.
- **Existing**: entity_relationships table (Phase 5), admin dashboard (Phase 4d), entity profiles (Phase 4c)

## Future Enhancements (not in scope for 7b)

- Centrality metrics displayed on nodes (betweenness, PageRank)
- Time slider to animate relationship evolution (using valid_at/invalid_at)
- Thought-level graph (show thoughts as small nodes between entities)
- 3D mode via 3d-force-graph if scale demands it
- Path finding: "how is entity A connected to entity B?"
