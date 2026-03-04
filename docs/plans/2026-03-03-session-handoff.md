# Session Handoff — 2026-03-03

## What was done this session

### Entity Knowledge Graph (Phase 4c) — COMPLETE
- 5 migrations (007-011): entities, thought_entities, entity_relationships, indexes, find_entity_function
- Entity resolver: normalizeName, findOrCreateEntity, inferRelationship, resolveEntities
- Profile generator: isProfileStale, generateProfile, refreshStaleProfiles (background poller every 5 min)
- 4 new MCP tools: get_entity, list_entities, get_context, get_timeline
- Extended metadata extraction: companies, products, projects added to extractor
- Pipeline wired: non-blocking entity resolution after every thought INSERT
- 164 tests passing across 26 files
- All committed and pushed to origin/main

### Vision Docs Created
- `docs/vision/use-cases-by-department.md` — use cases by layer + by department
- `docs/vision/context-graph-vision.md` — full architecture vision

### CLAUDE.md Rewritten
- Comprehensive project state, all 8 MCP tools documented, build phases extended through Phase 12

## In-progress: Brainstorming

We're in the middle of a brainstorm about evolving the context graph. Key decisions made so far:

1. **Agent model**: Shared memory layer — brain is the substrate, agents are stateless workers
2. **Agent types**: Ingestion + conversational first, automation agents are the real power
3. **Scale**: Personal prototype → company-wide context graph → agent automation platform
4. **First workflow**: Meeting prep autopilot
5. **Multi-tenancy**: Hybrid — shared entity graph + privately-scoped thoughts
6. **Visibility**: Source-determined defaults (public channel → company, DM → participants, personal → owner)
7. **Selective sharing**: Thoughts can be promoted from private to team/company
8. **Slack bot selective capture**: @mention bot to choose what enters the shared graph

### Brainstorm sections completed:
- Section 1: Use Cases & Capability Stack (4 layers: capture, entity intelligence, proactive context, autonomous action)
- Section 2: Department Use Cases (Sales, Product, CEO, Marketing, CS, Engineering, HR)

### Brainstorm sections remaining:
- Section 3: Architecture gaps, edge cases, evolution plan
- Section 4: Approach proposals (2-3 options with trade-offs)
- Final design doc + implementation plan

## Next immediate steps

1. **Test entity graph with real Telegram messages** — service is running on Spark
   - Send messages mentioning people, companies, projects, action items
   - Query DB to verify entities created and linked correctly
   - Check: entity dedup, relationship inference, profile generation
2. **Continue brainstorm** — architecture evolution design (Section 3+)
3. **Write design doc** → `docs/plans/2026-03-03-context-graph-evolution-design.md`

## Test messages to send via Telegram

1. "Had a call with Sarah from Acme Corp today about their Q3 roadmap"
2. "Bob needs to send the API proposal by Friday"
3. "Met with Alice and Carlos to discuss Project Atlas. We're evaluating Stripe vs Square for payments"
4. "Thinking about restructuring the onboarding flow — it's too many steps"

## DB verification queries (run after messages process)

```sql
-- Check entities were created
SELECT id, name, entity_type, canonical_name, mention_count, created_at FROM entities ORDER BY created_at;

-- Check thought-entity links
SELECT e.name, e.entity_type, te.relationship, te.confidence, t.content
FROM thought_entities te
JOIN entities e ON e.id = te.entity_id
JOIN thoughts t ON t.id = te.thought_id
ORDER BY t.created_at;

-- Check connected entities (share thoughts)
SELECT e1.name, e2.name, COUNT(*) as shared
FROM thought_entities te1
JOIN thought_entities te2 ON te1.thought_id = te2.thought_id AND te1.entity_id != te2.entity_id
JOIN entities e1 ON e1.id = te1.entity_id
JOIN entities e2 ON e2.id = te2.entity_id
GROUP BY e1.name, e2.name
ORDER BY shared DESC;
```
