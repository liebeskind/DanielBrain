#!/usr/bin/env npx tsx
import 'dotenv/config';
import pg from 'pg';

const args = process.argv.slice(2);
const dryRun = args.includes('--dry-run');

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

async function findEntity(
  client: pg.PoolClient,
  canonicalName: string,
  entityType: string
): Promise<{ id: string; name: string; mention_count: number } | null> {
  const { rows } = await client.query(
    `SELECT id, name, mention_count FROM entities
     WHERE canonical_name = $1 AND entity_type = $2`,
    [canonicalName.toLowerCase(), entityType]
  );
  return rows[0] ?? null;
}

async function findEntityByNameLike(
  client: pg.PoolClient,
  namePattern: string,
  entityType: string
): Promise<{ id: string; name: string; mention_count: number } | null> {
  const { rows } = await client.query(
    `SELECT id, name, mention_count FROM entities
     WHERE name LIKE $1 AND entity_type = $2
     ORDER BY mention_count DESC LIMIT 1`,
    [namePattern, entityType]
  );
  return rows[0] ?? null;
}

async function mergeEntity(
  client: pg.PoolClient,
  winnerId: string,
  loserId: string,
  label: string
): Promise<void> {
  console.log(`  MERGE: ${label} — winner=${winnerId}, loser=${loserId}`);

  // Reassign thought_entities from loser to winner (skip duplicates)
  const te = await client.query(
    `UPDATE thought_entities SET entity_id = $1
     WHERE entity_id = $2
     AND NOT EXISTS (
       SELECT 1 FROM thought_entities te2
       WHERE te2.entity_id = $1 AND te2.thought_id = thought_entities.thought_id AND te2.relationship = thought_entities.relationship
     )`,
    [winnerId, loserId]
  );
  console.log(`    Reassigned ${te.rowCount} thought_entities links`);

  // Delete remaining duplicate links
  const teDel = await client.query(
    `DELETE FROM thought_entities WHERE entity_id = $1`,
    [loserId]
  );
  if (teDel.rowCount && teDel.rowCount > 0) {
    console.log(`    Deleted ${teDel.rowCount} duplicate thought_entities links`);
  }

  // Merge aliases + sum mention_count
  await client.query(
    `UPDATE entities SET
       aliases = (SELECT array_agg(DISTINCT a) FROM unnest(e1.aliases || e2.aliases || ARRAY[e2.canonical_name]) AS a),
       mention_count = e1.mention_count + e2.mention_count,
       updated_at = NOW()
     FROM entities e1, entities e2
     WHERE entities.id = $1 AND e1.id = $1 AND e2.id = $2`,
    [winnerId, loserId]
  );

  // Reassign entity_relationships source_id
  await client.query(
    `UPDATE entity_relationships SET source_id = $1
     WHERE source_id = $2
     AND NOT EXISTS (
       SELECT 1 FROM entity_relationships er2
       WHERE er2.source_id = $1 AND er2.target_id = entity_relationships.target_id AND er2.relationship = entity_relationships.relationship
     )`,
    [winnerId, loserId]
  );

  // Reassign entity_relationships target_id
  await client.query(
    `UPDATE entity_relationships SET target_id = $1
     WHERE target_id = $2
     AND NOT EXISTS (
       SELECT 1 FROM entity_relationships er2
       WHERE er2.source_id = entity_relationships.source_id AND er2.target_id = $1 AND er2.relationship = entity_relationships.relationship
     )`,
    [winnerId, loserId]
  );

  // Delete any remaining relationship edges referencing loser
  await client.query(
    `DELETE FROM entity_relationships WHERE source_id = $1 OR target_id = $1`,
    [loserId]
  );

  // Delete loser entity
  await client.query(`DELETE FROM entities WHERE id = $1`, [loserId]);
  console.log(`    Deleted loser entity ${loserId}`);
}

async function deleteEntity(
  client: pg.PoolClient,
  entityId: string,
  label: string
): Promise<void> {
  console.log(`  DELETE: ${label} — id=${entityId}`);

  // Remove thought links
  const te = await client.query(
    `DELETE FROM thought_entities WHERE entity_id = $1`,
    [entityId]
  );
  console.log(`    Removed ${te.rowCount} thought_entities links`);

  // Remove relationship edges
  await client.query(
    `DELETE FROM entity_relationships WHERE source_id = $1 OR target_id = $1`,
    [entityId]
  );

  // Delete proposals referencing this entity
  await client.query(
    `DELETE FROM proposals WHERE entity_id = $1`,
    [entityId]
  );

  // Delete entity
  await client.query(`DELETE FROM entities WHERE id = $1`, [entityId]);
}

async function renameEntity(
  client: pg.PoolClient,
  entityId: string,
  newName: string,
  oldName: string
): Promise<void> {
  console.log(`  RENAME: "${oldName}" -> "${newName}" — id=${entityId}`);
  await client.query(
    `UPDATE entities SET
       name = $1,
       canonical_name = $2,
       aliases = array_append(aliases, $3),
       updated_at = NOW()
     WHERE id = $4`,
    [newName, newName.toLowerCase(), oldName.toLowerCase(), entityId]
  );
}

// ---------------------------------------------------------------------------
// Operations
// ---------------------------------------------------------------------------

async function mergeCrossTypeDuplicates(client: pg.PoolClient): Promise<void> {
  console.log('\n=== 1. Merge cross-type duplicates ===');

  const crossTypeMerges: Array<{
    name: string;
    winnerType: string;
    loserTypes: string[];
  }> = [
    { name: 'topia', winnerType: 'company', loserTypes: ['product', 'project'] },
    { name: 'stride', winnerType: 'company', loserTypes: ['product', 'project'] },
    { name: 'schoolspace', winnerType: 'company', loserTypes: ['product', 'project'] },
    { name: 'canvas', winnerType: 'product', loserTypes: ['company'] },
    { name: 'fathom', winnerType: 'company', loserTypes: ['product', 'project'] },
    { name: 'aws', winnerType: 'company', loserTypes: ['product'] },
    { name: 'slack', winnerType: 'product', loserTypes: ['company'] },
    // K12 Zone handled in step 3 (merges with Project Atlas)
    { name: 'zoom', winnerType: 'product', loserTypes: ['company'] },
    { name: 'gaggle', winnerType: 'product', loserTypes: ['company'] },
    { name: 'bryan franklin', winnerType: 'person', loserTypes: ['company'] },
  ];

  for (const { name, winnerType, loserTypes } of crossTypeMerges) {
    const winner = await findEntity(client, name, winnerType);
    if (!winner) {
      console.log(`  SKIP: "${name}" (${winnerType}) not found`);
      continue;
    }

    for (const loserType of loserTypes) {
      const loser = await findEntity(client, name, loserType);
      if (!loser) {
        console.log(`  SKIP: "${name}" (${loserType}) not found — already merged or missing`);
        continue;
      }
      await mergeEntity(client, winner.id, loser.id, `"${name}" ${winnerType} absorbs ${loserType}`);
    }
  }
}

async function mergePersonDuplicates(client: pg.PoolClient): Promise<void> {
  console.log('\n=== 2. Merge person duplicates ===');

  // Chris Psiaki — find the canonical person entity
  const chrisPsiaki = await findEntity(client, 'chris psiaki', 'person');
  if (chrisPsiaki) {
    // Absorb email variant (canonical_name includes angle brackets)
    const chrisEmail = await findEntityByNameLike(client, 'Chris Psiaki <%', 'person');
    if (chrisEmail && chrisEmail.id !== chrisPsiaki.id) {
      await mergeEntity(client, chrisPsiaki.id, chrisEmail.id, '"Chris Psiaki" absorbs email variant');
    }

    // Absorb first-name variant
    const chris = await findEntity(client, 'chris', 'person');
    if (chris && chris.id !== chrisPsiaki.id) {
      await mergeEntity(client, chrisPsiaki.id, chris.id, '"Chris Psiaki" absorbs "Chris"');
    }

    // Absorb company misclassification ("presumably Chris Psiaki's company")
    const chrisCompany = await findEntityByNameLike(client, 'Chris Psiaki%', 'company');
    if (chrisCompany) {
      await mergeEntity(client, chrisPsiaki.id, chrisCompany.id, '"Chris Psiaki" absorbs company misclassification');
    }
  } else {
    console.log('  SKIP: "Chris Psiaki" not found');
  }

  // Rob Fisher — canonical_name is "rob fisher" but display name has parenthetical
  const robFisher = await findEntity(client, 'rob fisher', 'person');
  if (robFisher && robFisher.name.includes('(')) {
    await renameEntity(client, robFisher.id, 'Rob Fisher', robFisher.name);
  } else if (robFisher) {
    console.log('  SKIP: "Rob Fisher" already has clean name');
  } else {
    console.log('  SKIP: "Rob Fisher" not found');
  }

  // Gordon Smith absorbs email variant
  const gordonSmith = await findEntity(client, 'gordon smith', 'person');
  const gordonEmail = await findEntityByNameLike(client, 'gordon.smith@%', 'person');
  if (gordonSmith && gordonEmail && gordonSmith.id !== gordonEmail.id) {
    await mergeEntity(client, gordonSmith.id, gordonEmail.id, '"Gordon Smith" absorbs email variant');
  } else if (!gordonSmith && gordonEmail) {
    await renameEntity(client, gordonEmail.id, 'Gordon Smith', gordonEmail.name);
    console.log('  Renamed email variant to "Gordon Smith"');
  } else {
    console.log(`  SKIP: Gordon Smith merge — smith=${!!gordonSmith}, email=${!!gordonEmail}`);
  }
}

async function mergeProjectAtlasIntoK12Zone(client: pg.PoolClient): Promise<void> {
  console.log('\n=== 3. Rename "Project Atlas" to "K12 Zone" and merge ===');

  const atlas = await findEntity(client, 'project atlas', 'project');

  // Find or create K12 Zone project as the winner
  let k12Project = await findEntity(client, 'k12 zone', 'project');

  if (atlas && k12Project) {
    // Merge atlas into k12 zone project
    await mergeEntity(client, k12Project.id, atlas.id, '"K12 Zone" (project) absorbs "Project Atlas"');
  } else if (atlas && !k12Project) {
    // Rename atlas to K12 Zone
    await renameEntity(client, atlas.id, 'K12 Zone', atlas.name);
    k12Project = { id: atlas.id, name: 'K12 Zone', mention_count: atlas.mention_count };
    // Update entity_type to project (atlas is already project type)
  } else {
    console.log(`  SKIP: Project Atlas not found (atlas=${!!atlas}, k12Project=${!!k12Project})`);
  }

  // Now merge any K12 Zone product and company variants into the winner
  const winner = k12Project ?? await findEntity(client, 'k12 zone', 'project');
  if (winner) {
    for (const loserType of ['product', 'company'] as const) {
      const loser = await findEntity(client, 'k12 zone', loserType);
      if (loser) {
        await mergeEntity(client, winner.id, loser.id, `"K12 Zone" (project) absorbs (${loserType})`);
      }
    }
  } else {
    console.log('  SKIP: No K12 Zone project winner found');
  }
}

async function deleteJunkProjects(client: pg.PoolClient): Promise<void> {
  console.log('\n=== 4. Delete junk project entities ===');

  const junkNames = [
    'phase 4',
    'ai operating system',
    'carbon capture',
    'unified solution',
    'infrastructure stack',
    'bare-metal experiment',
    'multi-cluster problem',
    'ai inference at the edge',
    'carbon capture system',
  ];

  for (const name of junkNames) {
    const entity = await findEntity(client, name, 'project');
    if (entity) {
      await deleteEntity(client, entity.id, `"${entity.name}" (project)`);
    } else {
      console.log(`  SKIP: "${name}" (project) not found`);
    }
  }
}

async function deleteEmailPersonEntities(client: pg.PoolClient): Promise<void> {
  console.log('\n=== 5. Delete email-as-person entities ===');

  // canonical_name has domain suffixes stripped (.io, .com, etc.), so match on
  // the raw name instead, or match canonical_name containing @ with no spaces
  const { rows } = await client.query(
    `SELECT id, name, canonical_name, mention_count FROM entities
     WHERE entity_type = 'person'
       AND (name ~ '^[^\\s]+@[^\\s]+\\.[^\\s]+$'
            OR (canonical_name LIKE '%@%' AND canonical_name NOT LIKE '% %'))
     ORDER BY canonical_name`
  );

  if (rows.length === 0) {
    console.log('  No email-as-person entities found');
    return;
  }

  console.log(`  Found ${rows.length} email-as-person entities`);
  for (const row of rows) {
    await deleteEntity(client, row.id, `"${row.name}" (${row.mention_count} mentions)`);
  }
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

async function main() {
  console.log(`Entity cleanup script ${dryRun ? '(DRY RUN)' : '(LIVE)'}`);

  const pool = new pg.Pool({ connectionString: process.env.DATABASE_URL });
  const client = await pool.connect();

  try {
    await client.query('BEGIN');

    await mergeCrossTypeDuplicates(client);
    await mergePersonDuplicates(client);
    await mergeProjectAtlasIntoK12Zone(client);
    await deleteJunkProjects(client);
    await deleteEmailPersonEntities(client);

    if (dryRun) {
      await client.query('ROLLBACK');
      console.log('\nDry run — no changes committed.');
    } else {
      await client.query('COMMIT');
      console.log('\nAll changes committed.');
    }
  } catch (err) {
    await client.query('ROLLBACK');
    console.error('\nError — rolled back all changes:', err);
    throw err;
  } finally {
    client.release();
    await pool.end();
  }
}

main();
