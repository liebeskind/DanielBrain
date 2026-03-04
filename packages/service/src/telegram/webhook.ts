import type pg from 'pg';

interface TelegramUpdate {
  update_id: number;
  message?: {
    message_id: number;
    chat: { id: number };
    from?: { id: number; username?: string };
    text?: string;
    date: number;
  };
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

  const sourceMeta = {
    chat_id: message.chat.id,
    message_id: message.message_id,
    from_id: message.from?.id,
    from_username: message.from?.username,
  };

  await pool.query(
    `INSERT INTO queue (content, source, source_meta)
     VALUES ($1, $2, $3)
     ON CONFLICT DO NOTHING`,
    [message.text, 'telegram', JSON.stringify(sourceMeta)]
  );

  if (botToken) {
    await sendTelegramReply(botToken, message.chat.id, 'Thought saved.');
  }

  return { ok: true };
}
