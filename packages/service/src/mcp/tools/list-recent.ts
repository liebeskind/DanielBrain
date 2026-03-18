import type pg from 'pg';

interface ListRecentInput {
  days: number;
  limit: number;
  thought_type?: string;
  source?: string;
}

export async function handleListRecent(
  input: ListRecentInput,
  pool: pg.Pool
) {
  const params: (number | string)[] = [input.days, input.limit];
  let filterClauses = '';

  if (input.thought_type) {
    params.push(input.thought_type);
    filterClauses += ` AND thought_type = $${params.length}`;
  }
  if (input.source) {
    params.push(input.source);
    filterClauses += ` AND source = $${params.length}`;
  }

  const { rows } = await pool.query(
    `SELECT id, content, thought_type, summary, people, topics, source, created_at
     FROM thoughts
     WHERE parent_id IS NULL
       AND created_at >= NOW() - ($1 || ' days')::interval
       ${filterClauses}
     ORDER BY created_at DESC
     LIMIT $2`,
    params
  );

  return rows;
}
