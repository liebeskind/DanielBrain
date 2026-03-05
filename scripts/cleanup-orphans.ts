import 'dotenv/config';
import pg from 'pg';

const pool = new pg.Pool({ connectionString: process.env.DATABASE_URL });

async function main(): Promise<void> {
  // Find orphaned Fathom parents (inserted by processLong before embedding failed)
  const { rows: orphans } = await pool.query(
    `SELECT id, source_id, LEFT(content, 80) as preview FROM thoughts WHERE source = 'fathom' AND embedding IS NULL`
  );
  console.log(`Found ${orphans.length} orphaned Fathom thoughts:`);
  for (const r of orphans) console.log(`  ${r.source_id}: ${r.preview}`);

  if (orphans.length === 0) {
    await pool.end();
    return;
  }

  // Delete orphaned chunks (children of orphaned parents)
  const ids = orphans.map((r) => r.id);
  const { rowCount: chunksDeleted } = await pool.query(
    `DELETE FROM thoughts WHERE parent_id = ANY($1)`,
    [ids]
  );
  console.log(`Deleted ${chunksDeleted} orphaned chunks`);

  // Delete thought_entities links
  const { rowCount: linksDeleted } = await pool.query(
    `DELETE FROM thought_entities WHERE thought_id = ANY($1)`,
    [ids]
  );
  console.log(`Deleted ${linksDeleted} entity links`);

  // Delete the orphaned parents
  const { rowCount: parentsDeleted } = await pool.query(
    `DELETE FROM thoughts WHERE id = ANY($1)`,
    [ids]
  );
  console.log(`Deleted ${parentsDeleted} orphaned parents`);

  await pool.end();
}

main().catch((err) => {
  console.error('Cleanup failed:', err);
  process.exit(1);
});
