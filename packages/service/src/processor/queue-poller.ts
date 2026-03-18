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

// Backoff schedule: 30s, 2min, 10min (with ±20% jitter)
const BACKOFF_SECONDS = [30, 120, 600];

export function calculateRetryAfter(attempt: number): Date {
  const baseSeconds = BACKOFF_SECONDS[Math.min(attempt - 1, BACKOFF_SECONDS.length - 1)];
  const jitter = 1 + (Math.random() * 0.4 - 0.2); // ±20%
  const delayMs = baseSeconds * jitter * 1000;
  return new Date(Date.now() + delayMs);
}

export async function pollQueue(pool: pg.Pool, config: QueueConfig): Promise<void> {
  // Claim pending items atomically — skip items in backoff
  const { rows: items } = await pool.query(
    `SELECT id, content, source, source_id, source_meta, originated_at, attempts
     FROM queue
     WHERE status = 'pending'
       AND (retry_after IS NULL OR retry_after <= NOW())
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
        `UPDATE queue SET status = 'failed', error = $1, processed_at = NOW(), retry_after = NULL
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
        `UPDATE queue SET status = 'completed', thought_id = $1, processed_at = NOW(), retry_after = NULL
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
      const newAttempts = item.attempts + 1; // attempts was incremented in the processing UPDATE

      if (newAttempts < config.maxRetries) {
        // Retry with backoff — set back to pending with retry_after
        const retryAfter = calculateRetryAfter(newAttempts);
        await pool.query(
          `UPDATE queue SET status = 'pending', error = $1, retry_after = $2
           WHERE id = $3`,
          [errorMsg, retryAfter, item.id]
        );
      } else {
        // Max retries exceeded — mark permanently failed
        await pool.query(
          `UPDATE queue SET status = 'failed', error = $1, processed_at = NOW(), retry_after = NULL
           WHERE id = $2`,
          [errorMsg, item.id]
        );
      }
    }
  }
}
