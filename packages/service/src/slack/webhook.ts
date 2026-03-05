import type pg from 'pg';
import { createContentHash } from '@danielbrain/shared';
import type { ChannelType, ParticipantIdentity } from '@danielbrain/shared';

interface SlackEvent {
  type: string;
  challenge?: string;
  event?: {
    type: string;
    text?: string;
    user?: string;
    bot_id?: string;
    subtype?: string;
    channel?: string;
    channel_type?: string;
    ts?: string;
    thread_ts?: string;
  };
}

function inferChannelType(event: NonNullable<SlackEvent['event']>): ChannelType {
  if (event.channel_type === 'im') return 'dm';
  if (event.channel_type === 'mpim') return 'group_dm';
  // Channel IDs: C = public, G = private/group
  if (event.channel?.startsWith('C')) return 'public';
  if (event.channel?.startsWith('G')) return 'private';
  return 'public';
}

export async function handleSlackEvent(
  payload: SlackEvent,
  pool: pg.Pool
): Promise<Record<string, unknown>> {
  // URL verification challenge
  if (payload.type === 'url_verification') {
    return { challenge: payload.challenge };
  }

  if (payload.type !== 'event_callback' || !payload.event) {
    return { ok: true, skipped: true };
  }

  const event = payload.event;

  // Only handle plain messages (no subtypes, no bots)
  if (event.type !== 'message' || event.bot_id || event.subtype) {
    return { ok: true, skipped: true };
  }

  if (!event.text) {
    return { ok: true, skipped: true };
  }

  const participants: ParticipantIdentity[] = [];
  if (event.user) {
    participants.push({ name: event.user, platform_id: event.user, role: 'author' });
  }

  const sourceMeta: Record<string, unknown> = {
    channel: event.channel,
    user: event.user,
    ts: event.ts,
    thread_ts: event.thread_ts,
    channel_type: inferChannelType(event),
    structured: {
      participants,
    },
  };

  // Use slack ts as source_id for dedup
  const sourceId = event.ts ? `slack-${event.channel}-${event.ts}` : null;
  const originatedAt = event.ts ? new Date(parseFloat(event.ts) * 1000) : null;
  const contentHash = createContentHash(event.text);

  await pool.query(
    `INSERT INTO queue (content, source, source_id, source_meta, originated_at, content_hash)
     VALUES ($1, $2, $3, $4, $5, $6)
     ON CONFLICT (source_id) WHERE source_id IS NOT NULL DO NOTHING`,
    [event.text, 'slack', sourceId, JSON.stringify(sourceMeta), originatedAt, contentHash]
  );

  return { ok: true };
}
