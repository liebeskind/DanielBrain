import type pg from 'pg';
import type { FathomMeeting } from './transcript.js';
import { formatMeeting } from './transcript.js';

/**
 * Handle a Fathom webhook delivery.
 * The webhook payload IS the Meeting object — every delivery is a "new meeting content ready" event.
 */
export async function handleFathomEvent(
  meeting: FathomMeeting,
  pool: pg.Pool,
): Promise<{ ok: boolean; queued: boolean }> {
  const sourceId = `fathom-${meeting.recording_id}`;
  const content = formatMeeting(meeting);

  const inviteeNames = meeting.calendar_invitees
    .map((inv) => inv.name)
    .filter(Boolean);

  const sourceMeta = {
    recording_id: meeting.recording_id,
    title: meeting.meeting_title || meeting.title,
    url: meeting.url,
    share_url: meeting.share_url,
    recorded_by: meeting.recorded_by?.name,
    participants: inviteeNames,
    has_summary: !!meeting.default_summary?.markdown_formatted,
    action_item_count: meeting.action_items?.length ?? 0,
    has_crm_matches: !!(meeting.crm_matches?.contacts?.length || meeting.crm_matches?.companies?.length),
  };

  // Insert into queue with source_id for dedup (ON CONFLICT = already queued)
  const { rowCount } = await pool.query(
    `INSERT INTO queue (content, source, source_id, source_meta)
     VALUES ($1, $2, $3, $4)
     ON CONFLICT (source_id) WHERE source_id IS NOT NULL DO NOTHING`,
    [content, 'fathom', sourceId, JSON.stringify(sourceMeta)]
  );

  return { ok: true, queued: (rowCount ?? 0) > 0 };
}
