#!/usr/bin/env npx tsx
/**
 * Backfill extracted_urls on existing HubSpot note thoughts.
 * Reads the raw HTML from thought content, extracts and classifies URLs,
 * and updates source_meta.extracted_urls.
 *
 * Usage:
 *   npx tsx scripts/backfill-url-inventory.ts [--dry-run]
 */

import 'dotenv/config';
import pg from 'pg';
import { extractUrls } from '../packages/service/src/hubspot/format.js';

const dryRun = process.argv.includes('--dry-run');

async function main() {
  const pool = new pg.Pool({ connectionString: process.env.DATABASE_URL });

  try {
    // Find HubSpot note thoughts without extracted_urls
    const { rows } = await pool.query(
      `SELECT t.id, t.content, t.source_meta
       FROM thoughts t
       WHERE t.source = 'hubspot'
         AND t.source_meta->>'object_type' = 'note'
         AND t.parent_id IS NULL
         AND (t.source_meta->'extracted_urls' IS NULL
              OR jsonb_array_length(t.source_meta->'extracted_urls') = 0)`
    );

    console.log(`Found ${rows.length} HubSpot notes without extracted_urls`);

    if (dryRun) {
      // Show a preview of what URLs would be found
      let totalUrls = 0;
      const typeCounts: Record<string, number> = {};
      for (const row of rows) {
        const urls = extractUrls(row.content);
        totalUrls += urls.length;
        for (const u of urls) {
          typeCounts[u.type] = (typeCounts[u.type] || 0) + 1;
        }
      }
      console.log(`Would extract ${totalUrls} URLs total`);
      console.log('By type:', typeCounts);
      console.log('Dry run — no changes made');
      return;
    }

    if (rows.length === 0) {
      console.log('Nothing to backfill');
      return;
    }

    let updated = 0;
    let urlsFound = 0;
    const typeCounts: Record<string, number> = {};

    for (const row of rows) {
      const urls = extractUrls(row.content);
      if (urls.length === 0) continue;

      urlsFound += urls.length;
      for (const u of urls) {
        typeCounts[u.type] = (typeCounts[u.type] || 0) + 1;
      }

      const sourceMeta = row.source_meta || {};
      sourceMeta.extracted_urls = urls;

      await pool.query(
        `UPDATE thoughts SET source_meta = $1, updated_at = NOW() WHERE id = $2`,
        [JSON.stringify(sourceMeta), row.id],
      );
      updated++;
    }

    console.log(`Updated ${updated} notes with ${urlsFound} URLs`);
    console.log('By type:', typeCounts);
  } finally {
    await pool.end();
  }
}

main().catch((err) => {
  console.error('Backfill failed:', err);
  process.exit(1);
});
