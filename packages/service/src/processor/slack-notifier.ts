import type { ThoughtMetadata } from '@danielbrain/shared';
import { createChildLogger } from '../logger.js';

const log = createChildLogger('slack-notifier');

interface NotifyParams {
  channel: string;
  threadTs: string;
  metadata: ThoughtMetadata;
  slackBotToken: string;
}

export async function notifySlack(params: NotifyParams): Promise<void> {
  const { channel, threadTs, metadata, slackBotToken } = params;

  const parts: string[] = ['Captured and processed.'];
  if (metadata.thought_type) parts.push(`Type: ${metadata.thought_type}`);
  if (metadata.people.length > 0) parts.push(`People: ${metadata.people.join(', ')}`);
  if (metadata.topics.length > 0) parts.push(`Topics: ${metadata.topics.join(', ')}`);
  if (metadata.action_items.length > 0) parts.push(`Action items: ${metadata.action_items.length}`);
  if (metadata.summary) parts.push(`Summary: ${metadata.summary}`);

  try {
    await fetch('https://slack.com/api/chat.postMessage', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${slackBotToken}`,
      },
      body: JSON.stringify({
        channel,
        thread_ts: threadTs,
        text: parts.join('\n'),
      }),
    });
  } catch {
    // Notification is best-effort — don't throw
    log.error('Failed to send Slack notification');
  }
}
