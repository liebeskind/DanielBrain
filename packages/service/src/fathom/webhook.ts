import type pg from 'pg';
import { createContentHash } from '@danielbrain/shared';
import type { StructuredData, ParticipantIdentity } from '@danielbrain/shared';
import type { FathomMeeting } from './transcript.js';
import { formatMeeting } from './transcript.js';

function buildStructuredData(meeting: FathomMeeting): StructuredData {
  const structured: StructuredData = {};

  // Summary
  if (meeting.default_summary?.markdown_formatted) {
    structured.summary = meeting.default_summary.markdown_formatted;
  }

  // Action items
  if (meeting.action_items && meeting.action_items.length > 0) {
    structured.action_items = meeting.action_items.map((item) => ({
      description: item.description,
      assignee_name: item.assignee?.name ?? null,
      assignee_email: item.assignee?.email ?? null,
      completed: item.completed,
    }));
  }

  // Participants from calendar invitees
  const participants: ParticipantIdentity[] = [];

  // Add recorder first
  if (meeting.recorded_by) {
    participants.push({
      name: meeting.recorded_by.name,
      email: meeting.recorded_by.email,
      role: 'recorder',
    });
  }

  for (const inv of meeting.calendar_invitees) {
    if (!inv.name) continue;
    // Skip if already added as recorder
    if (meeting.recorded_by && inv.email === meeting.recorded_by.email) continue;
    participants.push({
      name: inv.name,
      email: inv.email ?? undefined,
      role: 'participant',
    });
  }

  if (participants.length > 0) {
    structured.participants = participants;
  }

  // Companies from CRM matches
  if (meeting.crm_matches?.companies?.length) {
    structured.companies = meeting.crm_matches.companies.map((c) => ({
      name: c.name,
      record_url: c.record_url,
    }));
  }

  return structured;
}

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

  const structured = buildStructuredData(meeting);

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
    channel_type: 'meeting' as const,
    structured,
  };

  const originatedAt = meeting.recording_start_time
    ? new Date(meeting.recording_start_time)
    : new Date(meeting.created_at);
  const contentHash = createContentHash(content);

  // Insert into queue with source_id for dedup (ON CONFLICT = already queued)
  const { rowCount } = await pool.query(
    `INSERT INTO queue (content, source, source_id, source_meta, originated_at, content_hash)
     VALUES ($1, $2, $3, $4, $5, $6)
     ON CONFLICT (source_id) WHERE source_id IS NOT NULL DO NOTHING`,
    [content, 'fathom', sourceId, JSON.stringify(sourceMeta), originatedAt, contentHash]
  );

  return { ok: true, queued: (rowCount ?? 0) > 0 };
}

export { buildStructuredData };
