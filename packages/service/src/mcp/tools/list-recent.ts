import type pg from 'pg';

interface ListRecentInput {
  days: number;
  limit: number;
  thought_type?: string;
}

export async function handleListRecent(
  input: ListRecentInput,
  pool: pg.Pool
) {
  const { rows } = await pool.query(
    `SELECT id, content, thought_type, summary, people, topics, source, created_at
     FROM thoughts
     WHERE parent_id IS NULL
       AND created_at >= NOW() - ($1 || ' days')::interval
       ${input.thought_type ? 'AND thought_type = $3' : ''}
     ORDER BY created_at DESC
     LIMIT $2`,
    input.thought_type
      ? [input.days, input.limit, input.thought_type]
      : [input.days, input.limit]
  );

  return rows;
}
