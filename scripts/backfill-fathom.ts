import 'dotenv/config';
import pg from 'pg';
import { createContentHash } from '@danielbrain/shared';
import { loadConfig } from '../packages/service/src/config.js';
import { processThought } from '../packages/service/src/processor/pipeline.js';
import { listMeetings, formatMeeting } from '../packages/service/src/fathom/transcript.js';
import { buildStructuredData } from '../packages/service/src/fathom/webhook.js';

const config = loadConfig();

if (!config.fathomApiKey) {
  console.error('FATHOM_API_KEY is required');
  process.exit(1);
}

const pool = new pg.Pool({ connectionString: config.databaseUrl });
const fathomConfig = { fathomApiKey: config.fathomApiKey };

async function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function dropIndexes(): Promise<void> {
  console.log('Dropping HNSW indexes for faster bulk insert...');
  await pool.query('DROP INDEX IF EXISTS thoughts_embedding_idx');
  await pool.query('DROP INDEX IF EXISTS entities_embedding_idx');
  console.log('Indexes dropped.');
}

async function rebuildIndexes(): Promise<void> {
  console.log('Rebuilding HNSW indexes (halfvec, ef_construction=128)...');
  await pool.query('SET maintenance_work_mem = \'1GB\'');
  await pool.query(`
    CREATE INDEX thoughts_embedding_idx ON thoughts
      USING hnsw ((embedding::halfvec(768)) halfvec_cosine_ops)
      WITH (m = 16, ef_construction = 128)
  `);
  await pool.query(`
    CREATE INDEX entities_embedding_idx ON entities
      USING hnsw ((embedding::halfvec(768)) halfvec_cosine_ops)
      WITH (m = 16, ef_construction = 128)
  `);
  console.log('Indexes rebuilt.');
}

async function vacuumAnalyze(): Promise<void> {
  console.log('Running VACUUM ANALYZE...');
  // VACUUM can't run inside a transaction, use a separate non-pooled client
  const client = new pg.Client({ connectionString: config.databaseUrl });
  await client.connect();
  await client.query('VACUUM ANALYZE thoughts');
  await client.query('VACUUM ANALYZE entities');
  await client.query('VACUUM ANALYZE thought_entities');
  await client.end();
  console.log('VACUUM ANALYZE complete.');
}

async function main(): Promise<void> {
  let cursor: string | undefined;
  let totalImported = 0;
  let totalSkipped = 0;
  let totalNoTranscript = 0;

  await dropIndexes();

  console.log('Starting Fathom backfill...');

  do {
    // List with all rich data included
    const page = await listMeetings(fathomConfig, cursor);

    for (const meeting of page.items) {
      const sourceId = `fathom-${meeting.recording_id}`;
      const title = meeting.meeting_title || meeting.title;

      // Skip meetings without transcript
      if (!meeting.transcript || meeting.transcript.length === 0) {
        totalNoTranscript++;
        console.log(`Skipped (no transcript): ${title}`);
        continue;
      }

      // Check if already imported
      const { rows } = await pool.query(
        `SELECT 1 FROM thoughts WHERE source_id = $1 LIMIT 1`,
        [sourceId]
      );
      if (rows.length > 0) {
        totalSkipped++;
        console.log(`Skipped (already imported): ${title}`);
        continue;
      }

      try {
        const content = formatMeeting(meeting);

        const inviteeNames = meeting.calendar_invitees
          .map((inv) => inv.name)
          .filter(Boolean);

        const structured = buildStructuredData(meeting);

        const sourceMeta = {
          recording_id: meeting.recording_id,
          title,
          url: meeting.url,
          share_url: meeting.share_url,
          recorded_by: meeting.recorded_by?.name,
          participants: inviteeNames,
          has_summary: !!meeting.default_summary?.markdown_formatted,
          action_item_count: meeting.action_items?.length ?? 0,
          has_crm_matches: !!(meeting.crm_matches?.contacts?.length || meeting.crm_matches?.companies?.length),
          channel_type: 'meeting' as const,
          structured,
          raw_meeting: meeting,
        };

        // Use the meeting's actual recording start time, not NOW()
        const meetingDate = meeting.recording_start_time
          ? new Date(meeting.recording_start_time)
          : new Date(meeting.created_at);

        await processThought(content, 'fathom', pool, config, sourceMeta, sourceId, meetingDate);
        totalImported++;
        console.log(`Imported: ${title} (${sourceId}) [${meetingDate.toISOString().slice(0, 10)}]`);
      } catch (err) {
        console.error(`Error importing ${meeting.recording_id}:`, err);
      }

      // Rate limit: 60 req/min = 1 req/sec (for Fathom API, not Ollama)
      await sleep(1000);
    }

    cursor = page.next_cursor ?? undefined;
    // Rate limit between pages
    if (cursor) await sleep(1000);
  } while (cursor);

  console.log(`\nBackfill complete: ${totalImported} imported, ${totalSkipped} already existed, ${totalNoTranscript} had no transcript`);

  await rebuildIndexes();
  await vacuumAnalyze();

  console.log('\nPost-backfill TODO:');
  console.log('  1. Review new entities in admin dashboard (/admin)');
  console.log('  2. Run entity dedup scan to merge duplicates');
  console.log('  3. Check proposals queue for prefix-match links');

  await pool.end();
}

main().catch((err) => {
  console.error('Backfill failed:', err);
  process.exit(1);
});
