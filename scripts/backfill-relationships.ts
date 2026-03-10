#!/usr/bin/env npx tsx
/**
 * Backfill co-occurrence edges for existing thoughts.
 *
 * Usage:
 *   npx tsx scripts/backfill-relationships.ts [--dry-run] [--batch-size=100] [--delay-ms=50] [--describe]
 *
 * Flags:
 *   --dry-run      Show what would happen without writing
 *   --batch-size   Number of thoughts to process per batch (default: 100)
 *   --delay-ms     Delay between batches in ms (default: 50)
 *   --describe     After backfill, run LLM description for edges with weight >= 2
 */

import 'dotenv/config';
import pg from 'pg';
import { createCooccurrenceEdges } from '../packages/service/src/processor/relationship-builder.js';
import { describeUndescribedRelationships } from '../packages/service/src/processor/relationship-describer.js';

const args = process.argv.slice(2);
const dryRun = args.includes('--dry-run');
const describe = args.includes('--describe');
const batchSize = parseInt(args.find(a => a.startsWith('--batch-size='))?.split('=')[1] || '100', 10);
const delayMs = parseInt(args.find(a => a.startsWith('--delay-ms='))?.split('=')[1] || '50', 10);

async function main() {
  const pool = new pg.Pool({ connectionString: process.env.DATABASE_URL });

  try {
    // Count thoughts with 2+ entity links
    const { rows: [{ count: totalCount }] } = await pool.query(
      `SELECT COUNT(DISTINCT thought_id) as count
       FROM thought_entities
       WHERE thought_id IN (
         SELECT thought_id FROM thought_entities GROUP BY thought_id HAVING COUNT(DISTINCT entity_id) >= 2
       )`
    );

    console.log(`Found ${totalCount} thoughts with 2+ entity links`);

    if (dryRun) {
      // Show summary without writing
      const { rows: [{ edge_count }] } = await pool.query(
        `SELECT COUNT(*) as edge_count FROM entity_relationships WHERE relationship = 'co_occurs'`
      );
      console.log(`Existing co_occurs edges: ${edge_count}`);
      console.log('Dry run — no changes made.');
      return;
    }

    let offset = 0;
    let totalEdges = 0;

    while (true) {
      const { rows: thoughts } = await pool.query(
        `SELECT te.thought_id, ARRAY_AGG(DISTINCT te.entity_id) as entity_ids
         FROM thought_entities te
         GROUP BY te.thought_id
         HAVING COUNT(DISTINCT te.entity_id) >= 2
         ORDER BY te.thought_id
         LIMIT $1 OFFSET $2`,
        [batchSize, offset]
      );

      if (thoughts.length === 0) break;

      for (const row of thoughts) {
        const edges = await createCooccurrenceEdges(row.thought_id, row.entity_ids, pool);
        totalEdges += edges;
      }

      offset += thoughts.length;
      console.log(`Processed ${offset} thoughts, created/updated ${totalEdges} edges`);

      if (delayMs > 0) {
        await new Promise(resolve => setTimeout(resolve, delayMs));
      }
    }

    console.log(`\nBackfill complete: ${totalEdges} edges created/updated from ${offset} thoughts`);

    // Show weight distribution
    const { rows: distribution } = await pool.query(
      `SELECT weight, COUNT(*) as count
       FROM entity_relationships
       WHERE relationship = 'co_occurs'
       GROUP BY weight
       ORDER BY weight DESC
       LIMIT 10`
    );
    console.log('\nWeight distribution (top 10):');
    for (const row of distribution) {
      console.log(`  weight ${row.weight}: ${row.count} edges`);
    }

    // Optional: describe edges with weight >= 2
    if (describe) {
      const ollamaBaseUrl = process.env.OLLAMA_BASE_URL || 'http://localhost:11434';
      const relationshipModel = process.env.RELATIONSHIP_MODEL;

      if (!relationshipModel) {
        console.log('\nSkipping description — RELATIONSHIP_MODEL not set');
        return;
      }

      console.log(`\nDescribing relationships (model: ${relationshipModel})...`);
      let totalDescribed = 0;

      while (true) {
        const count = await describeUndescribedRelationships(pool, {
          ollamaBaseUrl,
          relationshipModel,
        });

        if (count === 0) break;
        totalDescribed += count;
        console.log(`  Described ${totalDescribed} edges so far...`);

        if (delayMs > 0) {
          await new Promise(resolve => setTimeout(resolve, delayMs));
        }
      }

      console.log(`Description complete: ${totalDescribed} edges described`);
    }
  } finally {
    await pool.end();
  }
}

main().catch((err) => {
  console.error('Backfill failed:', err);
  process.exit(1);
});
