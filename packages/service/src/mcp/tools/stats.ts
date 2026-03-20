import type pg from 'pg';

interface StatsInput {
  period: 'week' | 'month' | 'quarter' | 'year' | 'all';
}

interface StatsResult {
  total: number;
  by_type: Array<{ thought_type: string | null; count: number }>;
  top_people: Array<{ person: string; count: number }>;
  top_topics: Array<{ topic: string; count: number }>;
  action_items_count: number;
}

const PERIOD_DAYS: Record<string, number> = {
  week: 7,
  month: 30,
  quarter: 90,
  year: 365,
};

export async function handleStats(
  input: StatsInput,
  pool: pg.Pool,
  visibilityTags?: string[] | null,
): Promise<StatsResult> {
  const isAll = input.period === 'all';
  const daysBack = isAll ? null : PERIOD_DAYS[input.period];

  // $1 = days_back (int, NULL = all), $2 = visibility tags (text[], NULL = no filter)
  const dateClause = 'AND ($1::int IS NULL OR created_at >= NOW() - ($1 || \' days\')::interval)';
  const visClause = 'AND ($2::text[] IS NULL OR visibility && $2)';
  const baseWhere = `WHERE parent_id IS NULL ${dateClause} ${visClause}`;
  const params = [daysBack, visibilityTags ?? null];

  // Total count
  const { rows: totalRows } = await pool.query(
    `SELECT COUNT(*) as count FROM thoughts ${baseWhere}`,
    params,
  );

  // Type breakdown
  const { rows: typeRows } = await pool.query(
    `SELECT thought_type, COUNT(*) as count FROM thoughts ${baseWhere} GROUP BY thought_type ORDER BY count DESC`,
    params,
  );

  // Top people
  const { rows: peopleRows } = await pool.query(
    `SELECT unnest(people) as person, COUNT(*) as count FROM thoughts ${baseWhere} GROUP BY person ORDER BY count DESC LIMIT 10`,
    params,
  );

  // Top topics
  const { rows: topicRows } = await pool.query(
    `SELECT unnest(topics) as topic, COUNT(*) as count FROM thoughts ${baseWhere} GROUP BY topic ORDER BY count DESC LIMIT 10`,
    params,
  );

  // Unresolved action items
  const { rows: actionRows } = await pool.query(
    `SELECT COUNT(*) as count FROM thoughts WHERE parent_id IS NULL AND array_length(action_items, 1) > 0 ${dateClause} ${visClause}`,
    params,
  );

  return {
    total: parseInt(totalRows[0]?.count ?? '0', 10),
    by_type: typeRows.map(r => ({ thought_type: r.thought_type, count: parseInt(r.count, 10) })),
    top_people: peopleRows.map(r => ({ person: r.person, count: parseInt(r.count, 10) })),
    top_topics: topicRows.map(r => ({ topic: r.topic, count: parseInt(r.count, 10) })),
    action_items_count: parseInt(actionRows[0]?.count ?? '0', 10),
  };
}
