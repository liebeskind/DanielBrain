#!/usr/bin/env npx tsx
/**
 * Safety-net backfill for tsvector column.
 * Only updates rows where search_vector IS NULL (e.g., if trigger wasn't in place).
 *
 * Usage:
 *   npx tsx scripts/backfill-tsvector.ts [--dry-run]
 */

import 'dotenv/config';
import pg from 'pg';

const dryRun = process.argv.includes('--dry-run');

async function main() {
  const pool = new pg.Pool({ connectionString: process.env.DATABASE_URL });

  try {
    const { rows: [{ count }] } = await pool.query(
      `SELECT count(*) FROM thoughts WHERE search_vector IS NULL`
    );

    console.log(`Found ${count} thoughts with NULL search_vector`);

    if (dryRun) {
      console.log('Dry run — skipping update');
      return;
    }

    if (parseInt(count, 10) === 0) {
      console.log('Nothing to backfill');
      return;
    }

    const result = await pool.query(
      `UPDATE thoughts SET search_vector = to_tsvector('english', coalesce(content, '')) WHERE search_vector IS NULL`
    );

    console.log(`Updated ${result.rowCount} rows`);
  } finally {
    await pool.end();
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
