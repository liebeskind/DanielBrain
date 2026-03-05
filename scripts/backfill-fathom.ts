import 'dotenv/config';
import pg from 'pg';
import { loadConfig } from '../packages/service/src/config.js';
import { processThought } from '../packages/service/src/processor/pipeline.js';
import { listMeetings, formatMeeting } from '../packages/service/src/fathom/transcript.js';

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

async function main(): Promise<void> {
  let cursor: string | undefined;
  let totalImported = 0;
  let totalSkipped = 0;
  let totalNoTranscript = 0;

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
        };

        await processThought(content, 'fathom', pool, config, sourceMeta, sourceId);
        totalImported++;
        console.log(`Imported: ${title} (${sourceId})`);
      } catch (err) {
        console.error(`Error importing ${meeting.recording_id}:`, err);
      }

      // Rate limit: 60 req/min = 1 req/sec
      await sleep(1000);
    }

    cursor = page.next_cursor ?? undefined;
    // Rate limit between pages
    if (cursor) await sleep(1000);
  } while (cursor);

  console.log(`\nBackfill complete: ${totalImported} imported, ${totalSkipped} already existed, ${totalNoTranscript} had no transcript`);
  await pool.end();
}

main().catch((err) => {
  console.error('Backfill failed:', err);
  process.exit(1);
});
