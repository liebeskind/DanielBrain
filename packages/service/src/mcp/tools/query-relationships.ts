import type pg from 'pg';

interface QueryRelationshipsInput {
  entity_name?: string;
  entity_id?: string;
  min_weight: number;
  limit: number;
}

export async function handleQueryRelationships(
  input: QueryRelationshipsInput,
  pool: pg.Pool,
) {
  // Resolve entity ID
  let entityId = input.entity_id;
  if (!entityId && input.entity_name) {
    const normalized = input.entity_name.toLowerCase().trim();
    const { rows } = await pool.query(
      `SELECT id FROM entities WHERE canonical_name = $1 LIMIT 1`,
      [normalized],
    );
    if (rows.length === 0) {
      return { error: `Entity not found: ${input.entity_name}`, relationships: [] };
    }
    entityId = rows[0].id;
  }

  if (!entityId) {
    return { error: 'Either entity_id or entity_name must be provided', relationships: [] };
  }

  const { rows } = await pool.query(
    `SELECT er.id, er.relationship, er.description, er.weight, er.is_explicit,
            er.valid_at, er.invalid_at,
            s.id as source_entity_id, s.name as source_name, s.entity_type as source_type,
            t.id as target_entity_id, t.name as target_name, t.entity_type as target_type
     FROM entity_relationships er
     JOIN entities s ON s.id = er.source_id
     JOIN entities t ON t.id = er.target_id
     WHERE (er.source_id = $1 OR er.target_id = $1)
       AND er.invalid_at IS NULL
       AND er.weight >= $2
     ORDER BY er.weight DESC
     LIMIT $3`,
    [entityId, input.min_weight, input.limit],
  );

  return {
    entity_id: entityId,
    relationships: rows.map((r) => ({
      id: r.id,
      relationship: r.relationship,
      description: r.description,
      weight: r.weight,
      is_explicit: r.is_explicit,
      connected_entity: r.source_entity_id === entityId
        ? { id: r.target_entity_id, name: r.target_name, type: r.target_type }
        : { id: r.source_entity_id, name: r.source_name, type: r.source_type },
    })),
  };
}
