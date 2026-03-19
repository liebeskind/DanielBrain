import type pg from 'pg';

interface UpdateEntityInput {
  entity_id?: string;
  name?: string;
  new_name?: string;
  add_aliases?: string[];
  remove_aliases?: string[];
  metadata?: Record<string, unknown>;
  entity_type?: string;
}

export async function handleUpdateEntity(
  input: UpdateEntityInput,
  pool: pg.Pool,
) {
  // Resolve entity by ID or name
  let entity: { id: string; name: string; canonical_name: string; entity_type: string; aliases: string[]; metadata: Record<string, unknown> };

  if (input.entity_id) {
    const { rows } = await pool.query(
      `SELECT id, name, canonical_name, entity_type, aliases, metadata FROM entities WHERE id = $1`,
      [input.entity_id]
    );
    if (rows.length === 0) {
      return { error: `Entity not found: ${input.entity_id}` };
    }
    entity = rows[0];
  } else if (input.name) {
    const canonical = input.name.toLowerCase().trim();
    const { rows } = await pool.query(
      `SELECT id, name, canonical_name, entity_type, aliases, metadata FROM entities WHERE canonical_name = $1 LIMIT 1`,
      [canonical]
    );
    if (rows.length > 0) {
      entity = rows[0];
    } else {
      const { rows: aliasRows } = await pool.query(
        `SELECT id, name, canonical_name, entity_type, aliases, metadata FROM entities WHERE $1 = ANY(aliases) LIMIT 1`,
        [canonical]
      );
      if (aliasRows.length === 0) {
        return { error: `Entity not found: ${input.name}` };
      }
      entity = aliasRows[0];
    }
  } else {
    return { error: 'Either entity_id or name must be provided' };
  }

  // Build the diff for the proposal
  const proposedChanges: Record<string, unknown> = {};
  const currentState: Record<string, unknown> = {};

  if (input.new_name) {
    // Check for name collision
    const newCanonical = input.new_name.toLowerCase().trim();
    const { rows: collision } = await pool.query(
      `SELECT id FROM entities WHERE canonical_name = $1 AND id != $2 LIMIT 1`,
      [newCanonical, entity.id]
    );
    if (collision.length > 0) {
      return { error: `Name collision: an entity with name "${input.new_name}" already exists` };
    }
    proposedChanges.new_name = input.new_name;
    currentState.name = entity.name;
  }

  if (input.add_aliases) {
    proposedChanges.add_aliases = input.add_aliases;
    currentState.aliases = entity.aliases;
  }

  if (input.remove_aliases) {
    proposedChanges.remove_aliases = input.remove_aliases;
    currentState.aliases = entity.aliases;
  }

  if (input.metadata) {
    proposedChanges.metadata = input.metadata;
    currentState.metadata = entity.metadata;
  }

  if (input.entity_type) {
    proposedChanges.entity_type = input.entity_type;
    currentState.entity_type = entity.entity_type;
  }

  if (Object.keys(proposedChanges).length === 0) {
    return { error: 'No changes specified' };
  }

  // Create proposal (entity_update: 'always' — never auto-applied)
  const title = input.new_name
    ? `Rename "${entity.name}" → "${input.new_name}"`
    : `Update entity "${entity.name}"`;

  const description = Object.keys(proposedChanges).join(', ');

  const { rows } = await pool.query(
    `INSERT INTO proposals (proposal_type, entity_id, title, description, proposed_data, current_data, auto_applied, source)
     VALUES ('entity_update', $1, $2, $3, $4, $5, FALSE, 'mcp')
     RETURNING id`,
    [
      entity.id,
      title,
      `Changes: ${description}`,
      JSON.stringify(proposedChanges),
      JSON.stringify(currentState),
    ]
  );

  return {
    proposal_id: rows[0].id,
    entity_id: entity.id,
    entity_name: entity.name,
    changes: proposedChanges,
    status: 'pending',
  };
}
