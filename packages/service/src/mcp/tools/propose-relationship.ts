import type pg from 'pg';

interface ProposeRelationshipInput {
  source_entity: string;
  target_entity: string;
  description: string;
  relationship_type: string;
}

export async function handleProposeRelationship(
  input: ProposeRelationshipInput,
  pool: pg.Pool,
) {
  // Resolve source entity
  const sourceNorm = input.source_entity.toLowerCase().trim();
  const { rows: sourceRows } = await pool.query(
    `SELECT id, name FROM entities WHERE canonical_name = $1 LIMIT 1`,
    [sourceNorm],
  );
  if (sourceRows.length === 0) {
    return { error: `Source entity not found: ${input.source_entity}` };
  }

  // Resolve target entity
  const targetNorm = input.target_entity.toLowerCase().trim();
  const { rows: targetRows } = await pool.query(
    `SELECT id, name FROM entities WHERE canonical_name = $1 LIMIT 1`,
    [targetNorm],
  );
  if (targetRows.length === 0) {
    return { error: `Target entity not found: ${input.target_entity}` };
  }

  const sourceEntity = sourceRows[0];
  const targetEntity = targetRows[0];

  // Create proposal in approvals queue
  const { rows } = await pool.query(
    `INSERT INTO proposals (proposal_type, entity_id, title, description, proposed_data, auto_applied, source)
     VALUES ('entity_relationship', $1, $2, $3, $4, FALSE, 'mcp')
     RETURNING id`,
    [
      sourceEntity.id,
      `Relationship: ${sourceEntity.name} → ${targetEntity.name} (${input.relationship_type})`,
      input.description,
      JSON.stringify({
        source_entity_id: sourceEntity.id,
        source_entity_name: sourceEntity.name,
        target_entity_id: targetEntity.id,
        target_entity_name: targetEntity.name,
        relationship_type: input.relationship_type,
        description: input.description,
      }),
    ],
  );

  return {
    proposal_id: rows[0].id,
    source_entity: sourceEntity.name,
    target_entity: targetEntity.name,
    relationship_type: input.relationship_type,
    status: 'pending',
  };
}
