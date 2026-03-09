import 'dotenv/config';
import pg from 'pg';

async function main() {
  const pool = new pg.Pool({ connectionString: process.env.DATABASE_URL });

  const { rows: countRows } = await pool.query(
    "SELECT count(*) as orphans FROM thoughts WHERE source = 'fathom' AND embedding IS NULL AND processed_at IS NULL"
  );
  console.log('Orphan parent thoughts:', countRows[0].orphans);

  const { rowCount: childCount } = await pool.query(
    "DELETE FROM thoughts WHERE parent_id IN (SELECT id FROM thoughts WHERE source = 'fathom' AND embedding IS NULL AND processed_at IS NULL)"
  );
  console.log('Deleted child chunks:', childCount);

  const { rowCount: linkCount } = await pool.query(
    "DELETE FROM thought_entities WHERE thought_id IN (SELECT id FROM thoughts WHERE source = 'fathom' AND embedding IS NULL AND processed_at IS NULL)"
  );
  console.log('Deleted entity links:', linkCount);

  const { rowCount: parentCount } = await pool.query(
    "DELETE FROM thoughts WHERE source = 'fathom' AND embedding IS NULL AND processed_at IS NULL"
  );
  console.log('Deleted orphan parents:', parentCount);

  await pool.end();
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
