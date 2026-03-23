import type { ThoughtMetadata } from '@danielbrain/shared';
import { createChildLogger } from '../logger.js';

const log = createChildLogger('telegram-notifier');

interface NotifyParams {
  chatId: number;
  replyToMessageId: number;
  metadata: ThoughtMetadata;
  botToken: string;
}

export async function notifyTelegram(params: NotifyParams): Promise<void> {
  const { chatId, replyToMessageId, metadata, botToken } = params;

  const parts: string[] = ['Captured and processed.'];
  if (metadata.thought_type) parts.push(`Type: ${metadata.thought_type}`);
  if (metadata.people.length > 0) parts.push(`People: ${metadata.people.join(', ')}`);
  if (metadata.topics.length > 0) parts.push(`Topics: ${metadata.topics.join(', ')}`);
  if (metadata.action_items.length > 0) parts.push(`Action items: ${metadata.action_items.length}`);
  if (metadata.summary) parts.push(`Summary: ${metadata.summary}`);

  try {
    await fetch(`https://api.telegram.org/bot${botToken}/sendMessage`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        chat_id: chatId,
        reply_to_message_id: replyToMessageId,
        text: parts.join('\n'),
      }),
    });
  } catch {
    // Notification is best-effort — don't throw
    log.error('Failed to send Telegram notification');
  }
}
