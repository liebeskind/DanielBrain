import type pg from 'pg';

interface UpdateThoughtInput {
  thought_id: string;
  summary?: string;
  action_items?: string[];
  people?: string[];
  topics?: string[];
  thought_type?: string;
  sentiment?: string;
}

export async function handleUpdateThought(
  input: UpdateThoughtInput,
  pool: pg.Pool,
) {
  const updates: string[] = [];
  const params: (string | string[] | null)[] = [];
  let idx = 1;

  if (input.summary !== undefined) {
    updates.push(`summary = $${idx++}`);
    params.push(input.summary);
  }
  if (input.action_items !== undefined) {
    updates.push(`action_items = $${idx++}`);
    params.push(input.action_items as any);
  }
  if (input.people !== undefined) {
    updates.push(`people = $${idx++}`);
    params.push(input.people as any);
  }
  if (input.topics !== undefined) {
    updates.push(`topics = $${idx++}`);
    params.push(input.topics as any);
  }
  if (input.thought_type !== undefined) {
    updates.push(`thought_type = $${idx++}`);
    params.push(input.thought_type);
  }
  if (input.sentiment !== undefined) {
    updates.push(`sentiment = $${idx++}`);
    params.push(input.sentiment);
  }

  if (updates.length === 0) {
    return { error: 'No fields to update' };
  }

  updates.push('updated_at = NOW()');
  params.push(input.thought_id);

  const { rows } = await pool.query(
    `UPDATE thoughts SET ${updates.join(', ')} WHERE id = $${idx} AND parent_id IS NULL
     RETURNING id, thought_type, summary, people, topics, action_items, sentiment, updated_at`,
    params,
  );

  if (rows.length === 0) {
    return { error: 'Thought not found' };
  }

  return rows[0];
}
