import type pg from 'pg';
import type { CorrectionExample, CorrectionCategory } from '@danielbrain/shared';

export interface CreateCorrectionInput {
  category: CorrectionCategory;
  input_context: Record<string, unknown>;
  actual_output?: Record<string, unknown> | null;
  expected_output: Record<string, unknown>;
  explanation?: string | null;
  entity_id?: string | null;
  proposal_id?: string | null;
  tags?: string[];
}

export interface ListCorrectionFilters {
  category?: CorrectionCategory;
  entity_id?: string;
  tags?: string[];
  limit?: number;
  offset?: number;
}

export async function createCorrectionExample(
  input: CreateCorrectionInput,
  pool: pg.Pool,
): Promise<string> {
  const { rows } = await pool.query(
    `INSERT INTO correction_examples
       (category, input_context, actual_output, expected_output, explanation, entity_id, proposal_id, tags)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
     RETURNING id`,
    [
      input.category,
      JSON.stringify(input.input_context),
      input.actual_output ? JSON.stringify(input.actual_output) : null,
      JSON.stringify(input.expected_output),
      input.explanation || null,
      input.entity_id || null,
      input.proposal_id || null,
      input.tags || [],
    ]
  );
  return rows[0].id;
}

export async function listCorrectionExamples(
  filters: ListCorrectionFilters,
  pool: pg.Pool,
): Promise<{ examples: CorrectionExample[]; total: number }> {
  const conditions: string[] = [];
  const params: unknown[] = [];
  let paramIdx = 1;

  if (filters.category) {
    conditions.push(`category = $${paramIdx++}`);
    params.push(filters.category);
  }
  if (filters.entity_id) {
    conditions.push(`entity_id = $${paramIdx++}`);
    params.push(filters.entity_id);
  }
  if (filters.tags && filters.tags.length > 0) {
    conditions.push(`tags @> $${paramIdx++}`);
    params.push(filters.tags);
  }

  const where = conditions.length > 0 ? `WHERE ${conditions.join(' AND ')}` : '';
  const limit = filters.limit ?? 50;
  const offset = filters.offset ?? 0;

  const { rows } = await pool.query(
    `SELECT * FROM correction_examples ${where}
     ORDER BY created_at DESC
     LIMIT $${paramIdx++} OFFSET $${paramIdx++}`,
    [...params, limit, offset]
  );

  const { rows: countRows } = await pool.query(
    `SELECT COUNT(*) as total FROM correction_examples ${where}`,
    params
  );

  return {
    examples: rows as CorrectionExample[],
    total: parseInt(countRows[0].total, 10),
  };
}

export async function deleteCorrectionExample(
  id: string,
  pool: pg.Pool,
): Promise<boolean> {
  const { rowCount } = await pool.query(
    `DELETE FROM correction_examples WHERE id = $1`,
    [id]
  );
  return (rowCount ?? 0) > 0;
}

export async function getExamplesByCategory(
  category: CorrectionCategory,
  pool: pg.Pool,
  limit = 10,
): Promise<CorrectionExample[]> {
  const { rows } = await pool.query(
    `SELECT * FROM correction_examples
     WHERE category = $1
     ORDER BY created_at DESC
     LIMIT $2`,
    [category, limit]
  );
  return rows as CorrectionExample[];
}
