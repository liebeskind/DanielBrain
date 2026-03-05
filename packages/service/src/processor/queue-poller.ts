import type pg from 'pg';
import { processThought } from './pipeline.js';
import { notifySlack } from './slack-notifier.js';
import { notifyTelegram } from './telegram-notifier.js';

interface QueueConfig {
  ollamaBaseUrl: string;
  embeddingModel: string;
  extractionModel: string;
  batchSize: number;
  maxRetries: number;
  slackBotToken?: string;
  telegramBotToken?: string;
}

export async function pollQueue(pool: pg.Pool, config: QueueConfig): Promise<void> {
  // Claim pending items atomically
  const { rows: items } = await pool.query(
    `SELECT id, content, source, source_id, source_meta, originated_at, attempts
     FROM queue
     WHERE status = 'pending'
     ORDER BY created_at ASC
     LIMIT $1
     FOR UPDATE SKIP LOCKED`,
    [config.batchSize]
  );

  if (items.length === 0) return;

  for (const item of items) {
    // Skip items that have exceeded max retries
    if (item.attempts >= config.maxRetries) {
      await pool.query(
        `UPDATE queue SET status = 'failed', error = $1, processed_at = NOW()
         WHERE id = $2`,
        ['Max retries exceeded', item.id]
      );
      continue;
    }

    // Mark as processing
    await pool.query(
      `UPDATE queue SET status = 'processing', attempts = attempts + 1
       WHERE id = $1`,
      [item.id]
    );

    try {
      const sourceMeta = item.source_meta
        ? (typeof item.source_meta === 'string' ? JSON.parse(item.source_meta) : item.source_meta)
        : null;

      const createdAt = item.originated_at ? new Date(item.originated_at) : null;

      const result = await processThought(
        item.content,
        item.source,
        pool,
        config,
        sourceMeta,
        item.source_id ?? null,
        createdAt
      );

      await pool.query(
        `UPDATE queue SET status = 'completed', thought_id = $1, processed_at = NOW()
         WHERE id = $2`,
        [result.id, item.id]
      );

      // Best-effort notification back to source
      if (item.source === 'telegram' && config.telegramBotToken && sourceMeta) {
        await notifyTelegram({
          chatId: sourceMeta.chat_id,
          replyToMessageId: sourceMeta.message_id,
          metadata: result.metadata,
          botToken: config.telegramBotToken,
        });
      } else if (item.source === 'slack' && config.slackBotToken && sourceMeta) {
        await notifySlack({
          channel: sourceMeta.channel,
          threadTs: sourceMeta.ts,
          metadata: result.metadata,
          slackBotToken: config.slackBotToken,
        });
      }
    } catch (err) {
      const errorMsg = err instanceof Error ? err.message : String(err);
      await pool.query(
        `UPDATE queue SET status = 'failed', error = $1, processed_at = NOW()
         WHERE id = $2`,
        [errorMsg, item.id]
      );
    }
  }
}
