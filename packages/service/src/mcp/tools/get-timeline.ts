import type pg from 'pg';

interface GetTimelineInput {
  entity_id?: string;
  entity_name?: string;
  days_back: number;
  limit: number;
  sources?: string[];
}

interface TimelineEntry {
  id: string;
  content: string;
  summary: string | null;
  thought_type: string | null;
  relationship: string;
  source: string;
  created_at: Date;
}

interface TimelineGroup {
  date: string;
  entries: TimelineEntry[];
}

interface GetTimelineResult {
  entity_id: string;
  entity_name: string;
  timeline: TimelineGroup[];
  total_entries: number;
}

export async function handleGetTimeline(
  input: GetTimelineInput,
  pool: pg.Pool,
): Promise<GetTimelineResult> {
  // Resolve entity
  let entityId: string;
  let entityName: string;

  if (input.entity_id) {
    const { rows } = await pool.query(
      `SELECT id, name FROM entities WHERE id = $1`,
      [input.entity_id]
    );
    if (rows.length === 0) {
      throw new Error(`Entity not found: ${input.entity_id}`);
    }
    entityId = rows[0].id;
    entityName = rows[0].name;
  } else {
    const canonical = input.entity_name!.toLowerCase().trim();
    const { rows } = await pool.query(
      `SELECT id, name FROM entities
       WHERE canonical_name = $1 OR $1 = ANY(aliases)
       LIMIT 1`,
      [canonical]
    );
    if (rows.length === 0) {
      throw new Error(`Entity not found: ${input.entity_name}`);
    }
    entityId = rows[0].id;
    entityName = rows[0].name;
  }

  // Fetch timeline entries
  const conditions = [
    'te.entity_id = $1',
    `t.created_at >= NOW() - ($2 || ' days')::interval`,
    't.parent_id IS NULL',
  ];
  const params: unknown[] = [entityId, input.days_back];
  let paramIdx = 3;

  if (input.sources && input.sources.length > 0) {
    conditions.push(`t.source = ANY($${paramIdx})`);
    params.push(input.sources);
    paramIdx++;
  }

  params.push(input.limit);

  const { rows } = await pool.query(
    `SELECT t.id, t.content, t.summary, t.thought_type, te.relationship, t.source, t.created_at
     FROM thought_entities te
     JOIN thoughts t ON t.id = te.thought_id
     WHERE ${conditions.join(' AND ')}
     ORDER BY t.created_at DESC
     LIMIT $${paramIdx}`,
    params
  );

  // Group by date
  const groupMap = new Map<string, TimelineEntry[]>();
  for (const row of rows) {
    const dateStr = new Date(row.created_at).toISOString().split('T')[0];
    if (!groupMap.has(dateStr)) {
      groupMap.set(dateStr, []);
    }
    groupMap.get(dateStr)!.push(row);
  }

  const timeline: TimelineGroup[] = [...groupMap.entries()]
    .sort((a, b) => b[0].localeCompare(a[0])) // newest date first
    .map(([date, entries]) => ({ date, entries }));

  return {
    entity_id: entityId,
    entity_name: entityName,
    timeline,
    total_entries: rows.length,
  };
}
