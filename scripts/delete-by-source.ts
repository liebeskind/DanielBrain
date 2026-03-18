#!/usr/bin/env npx tsx
/**
 * Delete all thoughts from a specific source.
 *
 * Usage:
 *   npx tsx scripts/delete-by-source.ts --source=telegram [--dry-run]
 */

import 'dotenv/config';
import pg from 'pg';

const args = process.argv.slice(2);
const dryRun = args.includes('--dry-run');
const source = args.find(a => a.startsWith('--source='))?.split('=')[1];

if (!source) {
  console.error('Usage: npx tsx scripts/delete-by-source.ts --source=<source> [--dry-run]');
  process.exit(1);
}

async function main() {
  const pool = new pg.Pool({ connectionString: process.env.DATABASE_URL });

  try {
    // Count target thoughts
    const { rows: [{ count }] } = await pool.query(
      `SELECT COUNT(*) as count FROM thoughts WHERE source = $1 AND parent_id IS NULL`,
      [source],
    );
    const { rows: [{ count: childCount }] } = await pool.query(
      `SELECT COUNT(*) as count FROM thoughts WHERE parent_id IN (SELECT id FROM thoughts WHERE source = $1 AND parent_id IS NULL)`,
      [source],
    );

    console.log(`\nSource: ${source}`);
    console.log(`Parent thoughts: ${count}`);
    console.log(`Child chunks: ${childCount}`);

    if (dryRun) {
      console.log('\nDRY RUN — no changes will be made');
      await pool.end();
      return;
    }

    if (parseInt(count) === 0) {
      console.log('Nothing to delete.');
      await pool.end();
      return;
    }

    console.log('\nDeleting...');

    // Get parent IDs for this source
    const { rows: parentRows } = await pool.query(
      `SELECT id FROM thoughts WHERE source = $1 AND parent_id IS NULL`,
      [source],
    );
    const parentIds = parentRows.map(r => r.id);

    // Process in batches of 100
    const batchSize = 100;
    let deleted = 0;

    for (let i = 0; i < parentIds.length; i += batchSize) {
      const batch = parentIds.slice(i, i + batchSize);

      // Delete queue entries referencing these thoughts or their children
      await pool.query(
        `DELETE FROM queue WHERE thought_id = ANY($1)
         OR thought_id IN (SELECT id FROM thoughts WHERE parent_id = ANY($1))`,
        [batch],
      );

      // Delete child chunks
      await pool.query(
        `DELETE FROM thoughts WHERE parent_id = ANY($1)`,
        [batch],
      );

      // Delete thought_entities links
      await pool.query(
        `DELETE FROM thought_entities WHERE thought_id = ANY($1)`,
        [batch],
      );

      // Delete parent thoughts
      const { rowCount } = await pool.query(
        `DELETE FROM thoughts WHERE id = ANY($1)`,
        [batch],
      );

      deleted += rowCount ?? 0;
      console.log(`  Deleted batch ${Math.floor(i / batchSize) + 1}: ${rowCount} thoughts`);
    }

    console.log(`\nTotal deleted: ${deleted} parent thoughts`);

    // Recalculate entity mention counts
    console.log('\nRecalculating entity mention counts...');
    await pool.query(
      `UPDATE entities SET mention_count = COALESCE(sub.cnt, 0)
       FROM (
         SELECT entity_id, COUNT(*) as cnt
         FROM thought_entities
         GROUP BY entity_id
       ) sub
       WHERE entities.id = sub.entity_id`,
    );

    // Zero out entities with no remaining links
    await pool.query(
      `UPDATE entities SET mention_count = 0
       WHERE id NOT IN (SELECT DISTINCT entity_id FROM thought_entities)`,
    );

    // Clean stale source_thought_ids from entity_relationships
    console.log('Cleaning stale source_thought_ids from relationships...');
    await pool.query(
      `UPDATE entity_relationships
       SET source_thought_ids = (
         SELECT ARRAY(
           SELECT unnest(source_thought_ids)
           EXCEPT
           SELECT unnest($1::uuid[])
         )
       )
       WHERE source_thought_ids && $1::uuid[]`,
      [parentIds],
    );

    // Report orphaned entities
    const { rows: [{ orphan_count }] } = await pool.query(
      `SELECT COUNT(*) as orphan_count FROM entities WHERE mention_count = 0`,
    );
    console.log(`\nEntities with 0 mentions (orphaned): ${orphan_count}`);

  } finally {
    await pool.end();
  }
}

main().catch((err) => {
  console.error('Delete failed:', err);
  process.exit(1);
});
