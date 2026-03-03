import type pg from 'pg';
import { processThought } from './pipeline.js';

interface QueueConfig {
  ollamaBaseUrl: string;
  embeddingModel: string;
  extractionModel: string;
  batchSize: number;
  maxRetries: number;
}

export async function pollQueue(pool: pg.Pool, config: QueueConfig): Promise<void> {
  // Claim pending items atomically
  const { rows: items } = await pool.query(
    `SELECT id, content, source, source_meta, attempts
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

      const result = await processThought(
        item.content,
        item.source,
        pool,
        config,
        sourceMeta
      );

      await pool.query(
        `UPDATE queue SET status = 'completed', thought_id = $1, processed_at = NOW()
         WHERE id = $2`,
        [result.id, item.id]
      );
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
