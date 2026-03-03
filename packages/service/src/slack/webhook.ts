import type pg from 'pg';

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
    ts?: string;
    thread_ts?: string;
  };
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

  const sourceMeta = {
    channel: event.channel,
    user: event.user,
    ts: event.ts,
    thread_ts: event.thread_ts,
  };

  // Use slack ts as source_id for dedup
  const sourceId = event.ts ? `slack-${event.channel}-${event.ts}` : null;

  await pool.query(
    `INSERT INTO queue (content, source, source_meta)
     VALUES ($1, $2, $3)
     ON CONFLICT DO NOTHING`,
    [event.text, 'slack', JSON.stringify(sourceMeta)]
  );

  return { ok: true };
}
