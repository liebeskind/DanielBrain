import type pg from 'pg';

interface ProposeMergeInput {
  winner: string;
  loser: string;
  reason?: string;
}

async function resolveEntity(nameOrId: string, pool: pg.Pool): Promise<{ id: string; name: string } | null> {
  // Try UUID first
  const uuidPattern = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
  if (uuidPattern.test(nameOrId)) {
    const { rows } = await pool.query(
      `SELECT id, name FROM entities WHERE id = $1`,
      [nameOrId]
    );
    if (rows.length > 0) return rows[0];
  }

  // Try canonical name
  const canonical = nameOrId.toLowerCase().trim();
  const { rows } = await pool.query(
    `SELECT id, name FROM entities WHERE canonical_name = $1 LIMIT 1`,
    [canonical]
  );
  if (rows.length > 0) return rows[0];

  // Try alias
  const { rows: aliasRows } = await pool.query(
    `SELECT id, name FROM entities WHERE $1 = ANY(aliases) LIMIT 1`,
    [canonical]
  );
  if (aliasRows.length > 0) return aliasRows[0];

  return null;
}

export async function handleProposeMerge(
  input: ProposeMergeInput,
  pool: pg.Pool,
) {
  const winner = await resolveEntity(input.winner, pool);
  if (!winner) {
    return { error: `Winner entity not found: ${input.winner}` };
  }

  const loser = await resolveEntity(input.loser, pool);
  if (!loser) {
    return { error: `Loser entity not found: ${input.loser}` };
  }

  if (winner.id === loser.id) {
    return { error: `Winner and loser are the same entity: ${winner.name}` };
  }

  const title = `Merge "${loser.name}" into "${winner.name}"`;
  const description = input.reason || `Proposed merge: keep "${winner.name}", remove "${loser.name}"`;

  const { rows } = await pool.query(
    `INSERT INTO proposals (proposal_type, entity_id, title, description, proposed_data, auto_applied, source)
     VALUES ('entity_merge', $1, $2, $3, $4, FALSE, 'mcp')
     RETURNING id`,
    [
      winner.id,
      title,
      description,
      JSON.stringify({
        winner_id: winner.id,
        winner_name: winner.name,
        loser_id: loser.id,
        loser_name: loser.name,
      }),
    ]
  );

  return {
    proposal_id: rows[0].id,
    winner: winner.name,
    loser: loser.name,
    status: 'pending',
  };
}
