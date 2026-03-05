import type pg from 'pg';
import { createContentHash } from '@danielbrain/shared';
import type { ChannelType, ParticipantIdentity } from '@danielbrain/shared';

interface TelegramUpdate {
  update_id: number;
  message?: {
    message_id: number;
    chat: { id: number; type?: string };
    from?: { id: number; username?: string; first_name?: string; last_name?: string };
    text?: string;
    date: number;
  };
}

function inferChannelType(chatType?: string): ChannelType {
  if (chatType === 'private') return 'dm';
  if (chatType === 'group' || chatType === 'supergroup') return 'group_dm';
  if (chatType === 'channel') return 'public';
  return 'dm';
}

async function sendTelegramReply(botToken: string, chatId: number, text: string): Promise<void> {
  const url = `https://api.telegram.org/bot${botToken}/sendMessage`;
  await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ chat_id: chatId, text }),
  });
}

export async function handleTelegramUpdate(
  update: TelegramUpdate,
  pool: pg.Pool,
  botToken?: string
): Promise<Record<string, unknown>> {
  if (!update.message) {
    return { ok: true, skipped: true };
  }

  const { message } = update;

  if (!message.text) {
    return { ok: true, skipped: true };
  }

  // Ignore bot commands
  if (message.text.startsWith('/')) {
    return { ok: true, skipped: true };
  }

  const participants: ParticipantIdentity[] = [];
  if (message.from) {
    const nameParts = [message.from.first_name, message.from.last_name].filter(Boolean);
    const name = nameParts.length > 0 ? nameParts.join(' ') : (message.from.username ?? String(message.from.id));
    participants.push({
      name,
      platform_id: String(message.from.id),
      role: 'author',
    });
  }

  const sourceMeta: Record<string, unknown> = {
    chat_id: message.chat.id,
    message_id: message.message_id,
    from_id: message.from?.id,
    from_username: message.from?.username,
    channel_type: inferChannelType(message.chat.type),
    structured: {
      participants,
    },
  };

  const sourceId = `telegram-${message.chat.id}-${message.message_id}`;
  const originatedAt = new Date(message.date * 1000);
  const contentHash = createContentHash(message.text);

  await pool.query(
    `INSERT INTO queue (content, source, source_id, source_meta, originated_at, content_hash)
     VALUES ($1, $2, $3, $4, $5, $6)
     ON CONFLICT (source_id) WHERE source_id IS NOT NULL DO NOTHING`,
    [message.text, 'telegram', sourceId, JSON.stringify(sourceMeta), originatedAt, contentHash]
  );

  if (botToken) {
    await sendTelegramReply(botToken, message.chat.id, 'Thought saved.');
  }

  return { ok: true };
}
