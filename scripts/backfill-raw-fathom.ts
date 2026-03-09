import 'dotenv/config';
import pg from 'pg';
import { loadConfig } from '../packages/service/src/config.js';
import { listMeetings } from '../packages/service/src/fathom/transcript.js';
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

async function main(): Promise<void> {
  // Get all fathom thoughts that are missing raw_meeting data
  const { rows: existing } = await pool.query(
    `SELECT id, source_id, source_meta FROM thoughts
     WHERE source = 'fathom' AND source_id IS NOT NULL AND parent_id IS NULL
     ORDER BY created_at DESC`
  );

  const needsRaw = existing.filter((row) => {
    const meta = typeof row.source_meta === 'string' ? JSON.parse(row.source_meta) : row.source_meta;
    return !meta?.raw_meeting;
  });

  console.log(`Found ${existing.length} fathom thoughts, ${needsRaw.length} missing raw_meeting data`);

  if (needsRaw.length === 0) {
    console.log('Nothing to do!');
    await pool.end();
    return;
  }

  // Build a map of source_id -> thought row for quick lookup
  const thoughtMap = new Map<string, typeof existing[0]>();
  for (const row of needsRaw) {
    thoughtMap.set(row.source_id, row);
  }

  let cursor: string | undefined;
  let totalPatched = 0;
  let totalSkipped = 0;
  let totalPages = 0;

  console.log('Fetching meetings from Fathom API...');

  do {
    const page = await listMeetings(fathomConfig, cursor);
    totalPages++;

    for (const meeting of page.items) {
      const sourceId = `fathom-${meeting.recording_id}`;
      const thought = thoughtMap.get(sourceId);

      if (!thought) {
        totalSkipped++;
        continue;
      }

      const title = meeting.meeting_title || meeting.title;
      const meta = typeof thought.source_meta === 'string'
        ? JSON.parse(thought.source_meta)
        : thought.source_meta;

      // Rebuild structured data and add raw_meeting
      const structured = buildStructuredData(meeting);
      const inviteeNames = meeting.calendar_invitees
        .map((inv) => inv.name)
        .filter(Boolean);

      const updatedMeta = {
        ...meta,
        participants: inviteeNames,
        structured,
        raw_meeting: meeting,
      };

      await pool.query(
        `UPDATE thoughts SET source_meta = $1 WHERE id = $2`,
        [JSON.stringify(updatedMeta), thought.id]
      );

      totalPatched++;
      // Remove from map so we know when we're done
      thoughtMap.delete(sourceId);
      console.log(`Patched: ${title} (${sourceId})`);

      // Stop early if we've patched everything
      if (thoughtMap.size === 0) {
        console.log('All thoughts patched!');
        break;
      }
    }

    if (thoughtMap.size === 0) break;

    cursor = page.next_cursor ?? undefined;
    if (cursor) await sleep(1000);
  } while (cursor);

  const remaining = thoughtMap.size;
  console.log(`\nDone: ${totalPatched} patched, ${totalSkipped} skipped (not in DB), ${remaining} not found in Fathom API`);
  if (remaining > 0) {
    console.log('Thoughts not found in Fathom (may have been deleted):');
    for (const [sourceId] of thoughtMap) {
      console.log(`  - ${sourceId}`);
    }
  }

  await pool.end();
}

main().catch((err) => {
  console.error('Backfill raw data failed:', err);
  process.exit(1);
});
