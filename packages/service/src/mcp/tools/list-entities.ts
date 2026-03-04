import type pg from 'pg';

interface ListEntitiesInput {
  entity_type?: string;
  query?: string;
  sort_by: 'mention_count' | 'last_seen_at' | 'name';
  limit: number;
}

interface EntityListItem {
  id: string;
  name: string;
  entity_type: string;
  mention_count: number;
  last_seen_at: Date;
  profile_summary: string | null;
}

const SORT_COLUMNS: Record<string, string> = {
  mention_count: 'mention_count DESC',
  last_seen_at: 'last_seen_at DESC',
  name: 'name ASC',
};

export async function handleListEntities(
  input: ListEntitiesInput,
  pool: pg.Pool,
): Promise<EntityListItem[]> {
  const conditions: string[] = [];
  const params: unknown[] = [];
  let paramIdx = 1;

  if (input.entity_type) {
    conditions.push(`entity_type = $${paramIdx++}`);
    params.push(input.entity_type);
  }

  if (input.query) {
    conditions.push(`(canonical_name LIKE $${paramIdx} OR name ILIKE $${paramIdx})`);
    params.push(`${input.query.toLowerCase()}%`);
    paramIdx++;
  }

  const whereClause = conditions.length > 0
    ? `WHERE ${conditions.join(' AND ')}`
    : '';

  const orderBy = SORT_COLUMNS[input.sort_by] || 'mention_count DESC';

  params.push(input.limit);

  const { rows } = await pool.query(
    `SELECT id, name, entity_type, mention_count, last_seen_at, profile_summary
     FROM entities
     ${whereClause}
     ORDER BY ${orderBy}
     LIMIT $${paramIdx}`,
    params
  );

  return rows.map(r => ({
    ...r,
    mention_count: parseInt(r.mention_count, 10),
  }));
}
