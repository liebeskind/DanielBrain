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

const PERIOD_INTERVALS: Record<string, string> = {
  week: '7 days',
  month: '30 days',
  quarter: '90 days',
  year: '365 days',
};

export async function handleStats(
  input: StatsInput,
  pool: pg.Pool
): Promise<StatsResult> {
  const dateFilter = input.period === 'all'
    ? ''
    : `AND created_at >= NOW() - '${PERIOD_INTERVALS[input.period]}'::interval`;
  const parentFilter = 'AND parent_id IS NULL';

  // Total count
  const { rows: totalRows } = await pool.query(
    `SELECT COUNT(*) as count FROM thoughts WHERE 1=1 ${parentFilter} ${dateFilter}`
  );

  // Type breakdown
  const { rows: typeRows } = await pool.query(
    `SELECT thought_type, COUNT(*) as count FROM thoughts WHERE 1=1 ${parentFilter} ${dateFilter} GROUP BY thought_type ORDER BY count DESC`
  );

  // Top people
  const { rows: peopleRows } = await pool.query(
    `SELECT unnest(people) as person, COUNT(*) as count FROM thoughts WHERE 1=1 ${parentFilter} ${dateFilter} GROUP BY person ORDER BY count DESC LIMIT 10`
  );

  // Top topics
  const { rows: topicRows } = await pool.query(
    `SELECT unnest(topics) as topic, COUNT(*) as count FROM thoughts WHERE 1=1 ${parentFilter} ${dateFilter} GROUP BY topic ORDER BY count DESC LIMIT 10`
  );

  // Unresolved action items
  const { rows: actionRows } = await pool.query(
    `SELECT COUNT(*) as count FROM thoughts WHERE array_length(action_items, 1) > 0 ${parentFilter} ${dateFilter}`
  );

  return {
    total: parseInt(totalRows[0].count, 10),
    by_type: typeRows.map(r => ({ thought_type: r.thought_type, count: parseInt(r.count, 10) })),
    top_people: peopleRows.map(r => ({ person: r.person, count: parseInt(r.count, 10) })),
    top_topics: topicRows.map(r => ({ topic: r.topic, count: parseInt(r.count, 10) })),
    action_items_count: parseInt(actionRows[0].count, 10),
  };
}
