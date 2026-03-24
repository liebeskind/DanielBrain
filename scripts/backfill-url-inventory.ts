#!/usr/bin/env npx tsx
/**
 * Backfill extracted_urls on existing HubSpot note thoughts.
 * Extracts URLs from thought content AND merges in any existing otter_url
 * from source_meta (which was captured by the sync but not in extracted_urls format).
 *
 * Usage:
 *   npx tsx scripts/backfill-url-inventory.ts [--dry-run]
 */

import 'dotenv/config';
import pg from 'pg';
import { extractUrls } from '../packages/service/src/hubspot/format.js';
import type { UrlInventoryItem } from '../packages/service/src/hubspot/format.js';

const dryRun = process.argv.includes('--dry-run');

async function main() {
  const pool = new pg.Pool({ connectionString: process.env.DATABASE_URL });

  try {
    // Find HubSpot note thoughts that need URL extraction:
    // - No extracted_urls yet, OR
    // - Has otter_url in source_meta but not in extracted_urls
    const { rows } = await pool.query(
      `SELECT t.id, t.content, t.source_meta
       FROM thoughts t
       WHERE t.source = 'hubspot'
         AND t.source_meta->>'object_type' = 'note'
         AND t.parent_id IS NULL
         AND (
           t.source_meta->'extracted_urls' IS NULL
           OR jsonb_array_length(t.source_meta->'extracted_urls') = 0
           OR (t.source_meta->>'otter_url' IS NOT NULL
               AND NOT EXISTS (
                 SELECT 1 FROM jsonb_array_elements(t.source_meta->'extracted_urls') u
                 WHERE u->>'type' = 'otter'
               ))
         )`
    );

    console.log(`Found ${rows.length} HubSpot notes to process`);

    let totalUrls = 0;
    let otterMerged = 0;
    const typeCounts: Record<string, number> = {};

    if (dryRun) {
      for (const row of rows) {
        const urls = buildUrlList(row.content, row.source_meta);
        totalUrls += urls.length;
        for (const u of urls) {
          typeCounts[u.type] = (typeCounts[u.type] || 0) + 1;
        }
        if (row.source_meta?.otter_url) otterMerged++;
      }
      console.log(`Would extract ${totalUrls} URLs total (${otterMerged} with otter_url merge)`);
      console.log('By type:', typeCounts);
      console.log('Dry run — no changes made');
      return;
    }

    if (rows.length === 0) {
      console.log('Nothing to backfill');
      return;
    }

    let updated = 0;

    for (const row of rows) {
      const urls = buildUrlList(row.content, row.source_meta);
      if (urls.length === 0) continue;

      totalUrls += urls.length;
      for (const u of urls) {
        typeCounts[u.type] = (typeCounts[u.type] || 0) + 1;
      }
      if (row.source_meta?.otter_url) otterMerged++;

      const sourceMeta = row.source_meta || {};
      sourceMeta.extracted_urls = urls;

      await pool.query(
        `UPDATE thoughts SET source_meta = $1, updated_at = NOW() WHERE id = $2`,
        [JSON.stringify(sourceMeta), row.id],
      );
      updated++;
    }

    console.log(`Updated ${updated} notes with ${totalUrls} URLs (${otterMerged} otter_url merges)`);
    console.log('By type:', typeCounts);
  } finally {
    await pool.end();
  }
}

/** Build URL list from content extraction + any existing otter_url in source_meta */
function buildUrlList(content: string, sourceMeta: Record<string, unknown> | null): UrlInventoryItem[] {
  const urls = extractUrls(content);
  const seen = new Set(urls.map((u) => u.url));

  // Merge otter_url from source_meta if not already captured
  const otterUrl = sourceMeta?.otter_url as string | undefined;
  if (otterUrl && !seen.has(otterUrl)) {
    urls.push({
      url: otterUrl,
      type: 'otter',
      fetchable: true,
    });
  }

  return urls;
}

main().catch((err) => {
  console.error('Backfill failed:', err);
  process.exit(1);
});
