#!/usr/bin/env npx tsx
/**
 * Re-extract metadata for existing thoughts using the improved prompt + gleaning.
 *
 * Usage:
 *   npx tsx scripts/re-extract.ts [--source=fathom] [--batch-size=10] [--delay-ms=500] [--dry-run] [--skip-entities]
 *
 * Flags:
 *   --source       Filter by source (fathom, telegram, or all). Default: all
 *   --batch-size   Thoughts per batch (default: 10, keep low — each thought = 2 LLM calls)
 *   --delay-ms     Delay between batches in ms (default: 500)
 *   --dry-run      Show what would happen without writing
 *   --skip-entities  Re-extract metadata but skip entity re-resolution
 *   --offset       Start from this thought index (for resuming)
 *   --min-length   Skip thoughts shorter than this (default: 0)
 */

import 'dotenv/config';
import pg from 'pg';
import { extractMetadata } from '../packages/service/src/processor/extractor.js';
import { resolveEntities } from '../packages/service/src/processor/entity-resolver.js';

const args = process.argv.slice(2);
const dryRun = args.includes('--dry-run');
const skipEntities = args.includes('--skip-entities');
const source = args.find(a => a.startsWith('--source='))?.split('=')[1] || 'all';
const batchSize = parseInt(args.find(a => a.startsWith('--batch-size='))?.split('=')[1] || '10', 10);
const delayMs = parseInt(args.find(a => a.startsWith('--delay-ms='))?.split('=')[1] || '500', 10);
const startOffset = parseInt(args.find(a => a.startsWith('--offset='))?.split('=')[1] || '0', 10);
const minLength = parseInt(args.find(a => a.startsWith('--min-length='))?.split('=')[1] || '0', 10);

const config = {
  ollamaBaseUrl: process.env.OLLAMA_BASE_URL || 'http://localhost:11434',
  extractionModel: process.env.EXTRACTION_MODEL || 'llama3.1:8b',
  embeddingModel: process.env.EMBEDDING_MODEL || 'nomic-embed-text',
  enableGleaning: true,
};

interface ThoughtRow {
  id: string;
  content: string;
  source: string;
  source_meta: Record<string, unknown> | null;
  thought_type: string;
  people: string[];
  summary: string;
}

async function main() {
  const pool = new pg.Pool({ connectionString: process.env.DATABASE_URL });

  try {
    // Count target thoughts
    const sourceFilter = source === 'all' ? '' : `AND source = '${source}'`;
    const lengthFilter = minLength > 0 ? `AND LENGTH(content) >= ${minLength}` : '';
    const { rows: [{ count: totalCount }] } = await pool.query(
      `SELECT COUNT(*) as count FROM thoughts WHERE parent_id IS NULL ${sourceFilter} ${lengthFilter}`
    );

    console.log(`\nRe-extraction target: ${totalCount} parent thoughts${source !== 'all' ? ` (source: ${source})` : ''}`);
    console.log(`Config: batch_size=${batchSize}, delay=${delayMs}ms, gleaning=ON`);
    console.log(`Model: ${config.extractionModel} @ ${config.ollamaBaseUrl}`);
    if (dryRun) console.log('DRY RUN — no changes will be written\n');
    if (skipEntities) console.log('Entity resolution SKIPPED\n');
    if (startOffset > 0) console.log(`Resuming from offset ${startOffset}\n`);

    let offset = startOffset;
    let processed = 0;
    let errors = 0;
    const startTime = Date.now();

    while (true) {
      const { rows: thoughts } = await pool.query<ThoughtRow>(
        `SELECT id, content, source, source_meta, thought_type, people, summary
         FROM thoughts
         WHERE parent_id IS NULL ${sourceFilter} ${lengthFilter}
         ORDER BY created_at ASC
         LIMIT $1 OFFSET $2`,
        [batchSize, offset]
      );

      if (thoughts.length === 0) break;

      for (const thought of thoughts) {
        const idx = offset + thoughts.indexOf(thought) + 1;
        try {
          if (dryRun) {
            console.log(`[${idx}/${totalCount}] Would re-extract: ${thought.id} (${thought.source}) — "${thought.summary?.slice(0, 80) || thought.content.slice(0, 80)}..."`);
            continue;
          }

          // Re-extract metadata with improved prompt + gleaning
          const metadata = await extractMetadata(thought.content, config);

          // Update thought metadata columns
          await pool.query(
            `UPDATE thoughts SET
               thought_type = $1, people = $2, topics = $3, action_items = $4,
               dates_mentioned = $5::date[], sentiment = $6, summary = $7,
               updated_at = NOW()
             WHERE id = $8`,
            [
              metadata.thought_type,
              metadata.people,
              metadata.topics,
              metadata.action_items,
              metadata.dates_mentioned.length > 0 ? metadata.dates_mentioned : null,
              metadata.sentiment,
              metadata.summary,
              thought.id,
            ]
          );

          if (!skipEntities) {
            // Delete old entity links for this thought
            await pool.query(
              `DELETE FROM thought_entities WHERE thought_id = $1`,
              [thought.id]
            );

            // Re-resolve entities with new metadata
            try {
              await resolveEntities(
                thought.id,
                metadata,
                thought.content,
                pool,
                config,
                thought.source_meta,
              );
            } catch (err) {
              console.error(`  Entity resolution failed for ${thought.id} (non-fatal):`, err);
            }
          }

          processed++;
          const elapsed = ((Date.now() - startTime) / 1000).toFixed(0);
          const rate = (processed / (Date.now() - startTime) * 1000).toFixed(1);
          const eta = processed > 0 ? (((parseInt(totalCount) - startOffset - processed) / parseFloat(rate)) / 60).toFixed(1) : '?';
          console.log(`[${idx}/${totalCount}] ✓ ${thought.id} (${thought.source}) — ${metadata.people.length}p ${metadata.companies.length}c ${metadata.products.length}pr — ${rate}/s, ETA ${eta}m`);
        } catch (err) {
          errors++;
          console.error(`[${idx}/${totalCount}] ✗ ${thought.id}: ${err}`);
        }
      }

      offset += thoughts.length;

      if (delayMs > 0 && !dryRun) {
        await new Promise(resolve => setTimeout(resolve, delayMs));
      }
    }

    const totalTime = ((Date.now() - startTime) / 1000 / 60).toFixed(1);
    console.log(`\n--- Re-extraction complete ---`);
    console.log(`Processed: ${processed}, Errors: ${errors}, Time: ${totalTime}m`);

    if (!dryRun && !skipEntities) {
      // Recalculate mention_count from actual links
      console.log('\nRecalculating entity mention counts...');
      await pool.query(
        `UPDATE entities SET mention_count = sub.cnt
         FROM (
           SELECT entity_id, COUNT(*) as cnt
           FROM thought_entities
           GROUP BY entity_id
         ) sub
         WHERE entities.id = sub.entity_id`
      );

      // Zero out entities with no links
      await pool.query(
        `UPDATE entities SET mention_count = 0
         WHERE id NOT IN (SELECT DISTINCT entity_id FROM thought_entities)`
      );

      // Report orphaned entities
      const { rows: [{ orphan_count }] } = await pool.query(
        `SELECT COUNT(*) as orphan_count FROM entities WHERE mention_count = 0`
      );
      console.log(`Entities with 0 mentions (orphaned): ${orphan_count}`);

      // Report entity stats
      const { rows: entityStats } = await pool.query(
        `SELECT entity_type, COUNT(*) as count FROM entities WHERE mention_count > 0 GROUP BY entity_type ORDER BY count DESC`
      );
      console.log('\nActive entity distribution:');
      for (const row of entityStats) {
        console.log(`  ${row.entity_type}: ${row.count}`);
      }
    }
  } finally {
    await pool.end();
  }
}

main().catch((err) => {
  console.error('Re-extraction failed:', err);
  process.exit(1);
});
