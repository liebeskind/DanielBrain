# RAGFlow Human Intervention & Quality Control

## Overview

RAGFlow's HITL approach focuses on **post-processing review** — after documents are parsed and chunked, users can visually inspect results and make corrections. This is fundamentally different from TopiaBrain's **pre-approval gating** (confidence-based proposals held for review before applying).

## Chunk Review UI

After parsing a document, users can click on the parsed file to view chunking results. The UI shows:

- **All chunks** from the document, displayed individually
- **Source highlighting** — each chunk is linked to its position in the original document (page number, rectangular coordinates for PDFs)
- **Chunk content** — the extracted text, table, or figure for each chunk

### Manual Editing

Users can **double-click any chunk** to:
1. **Edit content** — fix OCR errors, correct table extraction mistakes, rewrite unclear text
2. **Add keywords** — increase ranking for queries containing those keywords
3. **Add questions** — associate questions that this chunk should answer
4. **Add tags** — categorize chunks against user-defined tag sets
5. **Modify metadata** — adjust any chunk-level metadata

Changes are saved directly to the knowledge base and immediately affect retrieval.

### Quality Signals

- **Keyword boosting**: manually added keywords increase a chunk's ranking for matching queries — a simple but effective way to fix retrieval gaps
- **Question association**: if users know what questions a chunk should answer, they can add them explicitly, improving recall for those query patterns

## Knowledge Graph Visualization

When using Knowledge Graph chunking:
- Nodes (entities) and edges (relationships) are displayed as an interactive graph or mind map
- Users can inspect node names, descriptions, and community assignments
- Visualization helps debug "why did the system think X is related to Y?"

## Comparison to TopiaBrain's Approvals Queue

| Aspect | RAGFlow | TopiaBrain |
|--------|---------|------------|
| **When** | Post-processing (review after indexing) | Pre-apply gating (review before applying, for high-risk ops) |
| **What** | Chunk content, keywords, tags | Entity links, enrichment data, entity merges |
| **Who decides** | User reviewing their own documents | Admin reviewing system proposals |
| **Granularity** | Per-chunk editing | Per-proposal approve/reject |
| **Automation** | No confidence scoring — all chunks available for review | Confidence-gated: low-confidence held, high-confidence auto-applied |
| **Undo** | Edit/delete chunks directly | Reject proposal = revert applied changes |

## What RAGFlow Gets Right

1. **Visual chunk review** — seeing chunks alongside the source document makes errors obvious. TopiaBrain's admin dashboard shows proposals in isolation; showing the source thought context alongside would help.

2. **Keyword boosting** — a lightweight way for users to improve retrieval without re-indexing. TopiaBrain could allow users to add keywords to entities or thoughts.

3. **Low friction** — double-click to edit, save to apply. No approval workflow because the user is both author and reviewer. This works for document-centric use cases.

## What RAGFlow Misses (Where TopiaBrain is Ahead)

1. **No confidence gating** — every chunk is treated equally. There is no system that flags "this extraction looks uncertain, please review." TopiaBrain's proposal system with confidence scores is more sophisticated for automated pipelines.

2. **No entity-level review** — RAGFlow reviews chunks, not entities. If an entity is extracted incorrectly in a knowledge graph, you would need to find and fix the source chunks. TopiaBrain's entity-centric proposals (merge, link, enrich) are more targeted.

3. **No automated flagging** — users must proactively review chunks. There is no queue of "items needing attention." TopiaBrain's pending proposals queue surfaces exactly what needs human judgment.
