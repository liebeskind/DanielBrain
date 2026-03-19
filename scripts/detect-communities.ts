#!/usr/bin/env npx tsx
/**
 * Detect communities and optionally summarize them.
 *
 * Usage:
 *   npx tsx scripts/detect-communities.ts [--summarize]
 *
 * Flags:
 *   --summarize  After detection, run LLM summarization for all unsummarized communities
 */

import 'dotenv/config';
import pg from 'pg';
import { detectCommunities } from '../packages/service/src/processor/community-detector.js';
import { summarizeUnsummarizedCommunities } from '../packages/service/src/processor/community-summarizer.js';

const args = process.argv.slice(2);
const shouldSummarize = args.includes('--summarize');

async function main() {
  const pool = new pg.Pool({ connectionString: process.env.DATABASE_URL });

  try {
    console.log('Running community detection...');
    const result = await detectCommunities(pool);
    console.log(`Detected ${result.communities} communities (changed: ${result.changed})`);

    if (!result.changed && !shouldSummarize) {
      console.log('No changes detected. Use --summarize to force summarization of unsummarized communities.');
    }

    // Show community stats
    const { rows: communities } = await pool.query(
      `SELECT c.id, c.title, c.member_count, c.summary IS NOT NULL as has_summary
       FROM communities c
       WHERE c.level = 0
       ORDER BY c.member_count DESC`
    );

    console.log(`\nCommunities (level 0):`);
    for (const c of communities) {
      const status = c.has_summary ? 'summarized' : 'pending';
      console.log(`  [${status}] ${c.title || '(untitled)'} — ${c.member_count} members`);
    }

    if (shouldSummarize) {
      const ollamaBaseUrl = process.env.OLLAMA_BASE_URL || 'http://localhost:11434';
      const extractionModel = process.env.EXTRACTION_MODEL || 'llama3.3:70b';
      const embeddingModel = process.env.EMBEDDING_MODEL || 'nomic-embed-text';

      console.log(`\nSummarizing communities (model: ${extractionModel})...`);
      let totalSummarized = 0;

      while (true) {
        const count = await summarizeUnsummarizedCommunities(pool, {
          ollamaBaseUrl,
          extractionModel,
          embeddingModel,
        });

        if (count === 0) break;
        totalSummarized += count;
        console.log(`  Summarized ${totalSummarized} communities so far...`);
      }

      console.log(`\nSummarization complete: ${totalSummarized} communities summarized`);
    }
  } finally {
    await pool.end();
  }
}

main().catch((err) => {
  console.error('Community detection failed:', err);
  process.exit(1);
});
