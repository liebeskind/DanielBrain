import type pg from 'pg';

interface GetContextInput {
  entities: string[];
  days_back: number;
  include_action_items: boolean;
  max_thoughts: number;
}

interface ResolvedEntity {
  id: string;
  name: string;
  entity_type: string;
}

interface ContextThought {
  id: string;
  content: string;
  summary: string | null;
  thought_type: string | null;
  source: string;
  created_at: Date;
  entity_overlap: number;
  matched_entities: string[];
}

interface EntityEdge {
  source_name: string;
  target_name: string;
  relationship: string;
  description: string | null;
  weight: number;
}

interface GetContextResult {
  resolved_entities: ResolvedEntity[];
  shared_thoughts: ContextThought[];
  entity_relationships: EntityEdge[];
  action_items: string[];
  key_topics: string[];
}

export async function handleGetContext(
  input: GetContextInput,
  pool: pg.Pool,
  visibilityTags?: string[] | null,
): Promise<GetContextResult> {
  // Step 1: Resolve entity names to IDs (batch query)
  const canonicalNames = input.entities.map(name => name.toLowerCase().trim());
  const { rows: entityRows } = await pool.query(
    `SELECT DISTINCT ON (canonical_name) id, name, entity_type, canonical_name
     FROM entities
     WHERE canonical_name = ANY($1) OR aliases && $1
     ORDER BY canonical_name, mention_count DESC`,
    [canonicalNames]
  );

  // Map resolved entities back to requested names
  const resolvedEntities: ResolvedEntity[] = [];
  for (const name of canonicalNames) {
    const match = entityRows.find(
      (e: any) => e.canonical_name === name || (Array.isArray(e.aliases) && e.aliases.includes(name))
    );
    if (match) {
      resolvedEntities.push({ id: match.id, name: match.name, entity_type: match.entity_type });
    }
  }

  if (resolvedEntities.length === 0) {
    return {
      resolved_entities: [],
      shared_thoughts: [],
      entity_relationships: [],
      action_items: [],
      key_topics: [],
    };
  }

  const entityIds = resolvedEntities.map(e => e.id);

  // Step 2: Find thoughts linked to the resolved entities, ranked by overlap then recency
  const thoughtParams: unknown[] = [entityIds, input.days_back, input.max_thoughts];
  let visClause = '';
  if (visibilityTags) {
    thoughtParams.push(visibilityTags);
    visClause = ` AND t.visibility && $${thoughtParams.length}`;
  }
  const { rows: thoughtRows } = await pool.query(
    `SELECT t.id, t.content, t.summary, t.thought_type, t.source, t.created_at,
            t.action_items, t.topics,
            COUNT(DISTINCT te.entity_id) as entity_overlap,
            ARRAY_AGG(DISTINCT e.name) as matched_entities
     FROM thought_entities te
     JOIN thoughts t ON t.id = te.thought_id
     JOIN entities e ON e.id = te.entity_id
     WHERE te.entity_id = ANY($1)
       AND t.created_at >= NOW() - ($2 || ' days')::interval
       AND t.parent_id IS NULL${visClause}
     GROUP BY t.id, t.content, t.summary, t.thought_type, t.source, t.created_at,
              t.action_items, t.topics
     ORDER BY entity_overlap DESC, t.created_at DESC
     LIMIT $3`,
    thoughtParams
  );

  // Step 3: Fetch relationship edges between resolved entities
  let entityEdges: EntityEdge[] = [];
  if (entityIds.length >= 2) {
    const { rows: edgeRows } = await pool.query(
      `SELECT s.name as source_name, t.name as target_name,
              er.relationship, er.description, er.weight
       FROM entity_relationships er
       JOIN entities s ON s.id = er.source_id
       JOIN entities t ON t.id = er.target_id
       WHERE er.source_id = ANY($1) AND er.target_id = ANY($1)
         AND er.invalid_at IS NULL
       ORDER BY er.weight DESC`,
      [entityIds]
    );
    entityEdges = edgeRows.map(r => ({
      source_name: r.source_name,
      target_name: r.target_name,
      relationship: r.relationship,
      description: r.description,
      weight: parseInt(r.weight, 10),
    }));
  }

  // Step 4: Collect action items if requested
  let actionItems: string[] = [];
  if (input.include_action_items) {
    for (const row of thoughtRows) {
      if (row.action_items && row.action_items.length > 0) {
        actionItems = actionItems.concat(row.action_items);
      }
    }
  }

  // Step 5: Collect key topics across all shared thoughts
  const topicCounts = new Map<string, number>();
  for (const row of thoughtRows) {
    if (row.topics) {
      for (const topic of row.topics) {
        topicCounts.set(topic, (topicCounts.get(topic) || 0) + 1);
      }
    }
  }
  const keyTopics = [...topicCounts.entries()]
    .sort((a, b) => b[1] - a[1])
    .slice(0, 10)
    .map(([topic]) => topic);

  return {
    resolved_entities: resolvedEntities,
    entity_relationships: entityEdges,
    shared_thoughts: thoughtRows.map(r => ({
      id: r.id,
      content: r.content,
      summary: r.summary,
      thought_type: r.thought_type,
      source: r.source,
      created_at: r.created_at,
      entity_overlap: parseInt(r.entity_overlap, 10),
      matched_entities: r.matched_entities,
    })),
    action_items: actionItems,
    key_topics: keyTopics,
  };
}
