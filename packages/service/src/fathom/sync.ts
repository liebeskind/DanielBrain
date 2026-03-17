import type pg from 'pg';
import { createContentHash } from '@danielbrain/shared';
import { listMeetings, formatMeeting } from './transcript.js';
import { buildStructuredData } from './webhook.js';
import type { FathomMeeting } from './transcript.js';

function buildSourceMeta(meeting: FathomMeeting) {
  const inviteeNames = meeting.calendar_invitees
    .map((inv) => inv.name)
    .filter(Boolean);

  const structured = buildStructuredData(meeting);

  return {
    recording_id: meeting.recording_id,
    title: meeting.meeting_title || meeting.title,
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
}

export async function syncFathomMeetings(
  pool: pg.Pool,
  config: { fathomApiKey: string },
): Promise<{ queued: number; skipped: number; errors: number }> {
  let queued = 0;
  let skipped = 0;
  let errors = 0;
  let cursor: string | undefined;

  do {
    let page;
    try {
      page = await listMeetings(config, cursor);
    } catch (err) {
      console.error('Fathom API error during sync:', err);
      errors++;
      break;
    }

    for (const meeting of page.items) {
      const sourceId = `fathom-${meeting.recording_id}`;

      try {
        // Check if already imported
        const { rows } = await pool.query(
          `SELECT 1 FROM thoughts WHERE source = 'fathom' AND source_meta->>'recording_id' = $1 AND parent_id IS NULL
           UNION ALL
           SELECT 1 FROM queue WHERE source_id = $1`,
          [sourceId],
        );

        if (rows.length > 0) {
          skipped++;
          continue;
        }

        const content = formatMeeting(meeting);
        const sourceMeta = buildSourceMeta(meeting);
        const originatedAt = meeting.recording_start_time
          ? new Date(meeting.recording_start_time)
          : new Date(meeting.created_at);
        const contentHash = createContentHash(content);

        await pool.query(
          `INSERT INTO queue (content, source, source_id, source_meta, originated_at, content_hash)
           VALUES ($1, $2, $3, $4, $5, $6)
           ON CONFLICT (source_id) WHERE source_id IS NOT NULL DO NOTHING`,
          [content, 'fathom', sourceId, JSON.stringify(sourceMeta), originatedAt, contentHash],
        );

        queued++;
      } catch (err) {
        console.error(`Fathom sync error for meeting ${meeting.recording_id}:`, err);
        errors++;
      }
    }

    cursor = page.next_cursor ?? undefined;

    // Rate limit: wait 1s between pages
    if (cursor) {
      await new Promise((resolve) => setTimeout(resolve, 1000));
    }
  } while (cursor);

  return { queued, skipped, errors };
}
