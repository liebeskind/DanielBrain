#!/usr/bin/env npx tsx
/**
 * Backfill atomic facts from existing thoughts (Fathom transcripts, HubSpot notes, etc.).
 * Processes thoughts that don't yet have facts extracted.
 *
 * Usage:
 *   npx tsx scripts/backfill-facts.ts [--dry-run] [--source fathom] [--limit 10] [--debug]
 */

import 'dotenv/config';
import pg from 'pg';
import { extractFactsFromContent, storeFacts } from '../packages/service/src/processor/fact-extractor.js';

const args = process.argv.slice(2);
const dryRun = args.includes('--dry-run');
const debug = args.includes('--debug');
const sourceIdx = args.indexOf('--source');
const sourceFilter = sourceIdx >= 0 ? args[sourceIdx + 1] : null;
const limitIdx = args.indexOf('--limit');
const limit = limitIdx >= 0 ? parseInt(args[limitIdx + 1], 10) : 10;

const config = {
  ollamaBaseUrl: process.env.OLLAMA_BASE_URL || 'http://localhost:11434',
  extractionModel: process.env.EXTRACTION_MODEL || 'llama3.3:70b',
  embeddingModel: process.env.EMBEDDING_MODEL || 'nomic-embed-text',
};

async function main() {
  const pool = new pg.Pool({ connectionString: process.env.DATABASE_URL });

  try {
    // Find thoughts without facts, prioritizing long content
    const conditions = [
      't.parent_id IS NULL',
      'NOT EXISTS (SELECT 1 FROM facts f WHERE f.thought_id = t.id)',
      'length(t.content) > 200',
    ];
    const params: unknown[] = [limit];

    if (sourceFilter) {
      conditions.push(`t.source = $2`);
      params.push(sourceFilter);
    }

    const { rows } = await pool.query(
      `SELECT t.id, t.content, t.summary, t.source, t.visibility, t.people, t.topics,
              t.source_meta->>'object_type' as object_type
       FROM thoughts t
       WHERE ${conditions.join(' AND ')}
       ORDER BY length(t.content) DESC
       LIMIT $1`,
      params,
    );

    console.log(`Found ${rows.length} thoughts without facts${sourceFilter ? ` (source=${sourceFilter})` : ''}`);

    if (rows.length === 0) {
      console.log('Nothing to backfill');
      return;
    }

    if (dryRun) {
      for (const row of rows) {
        console.log(`  [${row.source}/${row.object_type || '-'}] ${row.id} (${row.content.length} chars)`);
        if (debug) {
          console.log(`    Content preview: ${row.content.slice(0, 120)}...`);
        }
      }
      console.log(`\nDry run — would process ${rows.length} thoughts`);
      return;
    }

    let totalFacts = 0;
    let totalContradictions = 0;
    let errors = 0;

    for (let i = 0; i < rows.length; i++) {
      const row = rows[i];
      // Get entity names from thought_entities join (companies, products, projects aren't columns)
      const { rows: linkedEntities } = await pool.query(
        `SELECT e.name, e.entity_type FROM thought_entities te
         JOIN entities e ON e.id = te.entity_id
         WHERE te.thought_id = $1`,
        [row.id],
      );
      const entities = linkedEntities.map((e: any) => ({ name: e.name, entity_type: e.entity_type }));

      try {
        console.log(`[${i + 1}/${rows.length}] Processing ${row.source}/${row.object_type || '-'} ${row.id} (${row.content.length} chars, ${entities.length} entities)...`);

        const facts = await extractFactsFromContent(row.content, entities, config, row.summary);

        if (debug) {
          console.log(`  LLM returned ${facts.length} facts:`);
          for (const f of facts) {
            console.log(`    [${f.fact_type}] ${f.statement.slice(0, 100)}`);
          }
        }

        if (facts.length === 0) {
          console.log(`  → 0 facts extracted`);
          continue;
        }

        const result = await storeFacts(row.id, facts, row.visibility, pool, config);
        totalFacts += result.stored;
        totalContradictions += result.contradictions;
        console.log(`  → ${result.stored} stored, ${result.contradictions} contradictions`);
      } catch (err) {
        errors++;
        console.error(`  ERROR: ${(err as Error).message}`);
        if (debug) {
          console.error(err);
        }
      }
    }

    console.log(`\nDone: ${totalFacts} facts stored, ${totalContradictions} contradictions, ${errors} errors`);
  } finally {
    await pool.end();
  }
}

main().catch((err) => {
  console.error('Backfill failed:', err);
  process.exit(1);
});
