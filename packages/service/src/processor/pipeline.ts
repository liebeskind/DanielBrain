import type pg from 'pg';
import type { ThoughtMetadata } from '@danielbrain/shared';
import { embed } from './embedder.js';
import { extractMetadata } from './extractor.js';
import { chunkText, needsChunking } from './chunker.js';
import { summarize } from './summarizer.js';
import { resolveEntities } from './entity-resolver.js';

interface PipelineConfig {
  ollamaBaseUrl: string;
  embeddingModel: string;
  extractionModel: string;
}

interface ProcessResult {
  id: string;
  metadata: ThoughtMetadata;
  chunks?: number;
}

export async function processThought(
  content: string,
  source: string,
  pool: pg.Pool,
  config: PipelineConfig,
  sourceMeta?: Record<string, unknown> | null,
  sourceId?: string | null
): Promise<ProcessResult> {
  if (!needsChunking(content)) {
    return processShort(content, source, pool, config, sourceMeta, sourceId);
  } else {
    return processLong(content, source, pool, config, sourceMeta, sourceId);
  }
}

async function processShort(
  content: string,
  source: string,
  pool: pg.Pool,
  config: PipelineConfig,
  sourceMeta?: Record<string, unknown> | null,
  sourceId?: string | null
): Promise<ProcessResult> {
  // Parallel: embed + extract metadata
  const [embedding, metadata] = await Promise.all([
    embed(content, config),
    extractMetadata(content, config),
  ]);

  const vectorStr = `[${embedding.join(',')}]`;

  const { rows } = await pool.query(
    `INSERT INTO thoughts (content, embedding, thought_type, people, topics, action_items,
      dates_mentioned, sentiment, summary, source, source_id, source_meta, visibility, processed_at)
     VALUES ($1, $2::vector, $3, $4, $5, $6, $7::date[], $8, $9, $10, $11, $12, $13, NOW())
     RETURNING id`,
    [
      content,
      vectorStr,
      metadata.thought_type,
      metadata.people,
      metadata.topics,
      metadata.action_items,
      metadata.dates_mentioned.length > 0 ? metadata.dates_mentioned : null,
      metadata.sentiment,
      metadata.summary,
      source,
      sourceId ?? null,
      sourceMeta ? JSON.stringify(sourceMeta) : null,
      ['owner'],
    ]
  );

  // Non-blocking entity resolution
  try {
    await resolveEntities(rows[0].id, metadata, content, pool, config, sourceMeta);
  } catch (err) {
    console.error('Entity resolution failed (non-fatal):', err);
  }

  return { id: rows[0].id, metadata };
}

async function processLong(
  content: string,
  source: string,
  pool: pg.Pool,
  config: PipelineConfig,
  sourceMeta?: Record<string, unknown> | null,
  sourceId?: string | null
): Promise<ProcessResult> {
  // Step 1: Insert parent thought (raw text, no embedding yet)
  const { rows: parentRows } = await pool.query(
    `INSERT INTO thoughts (content, source, source_id, source_meta, visibility)
     VALUES ($1, $2, $3, $4, $5)
     RETURNING id`,
    [content, source, sourceId ?? null, sourceMeta ? JSON.stringify(sourceMeta) : null, ['owner']]
  );
  const parentId = parentRows[0].id;

  // Step 2: Summarize + extract metadata (parallel)
  const [summaryText, metadata] = await Promise.all([
    summarize(content, config),
    extractMetadata(content, config),
  ]);

  // Step 3: Embed summary and store on parent
  const summaryEmbedding = await embed(summaryText, config);
  const summaryVectorStr = `[${summaryEmbedding.join(',')}]`;

  await pool.query(
    `UPDATE thoughts SET embedding = $1::vector, thought_type = $2, people = $3, topics = $4,
     action_items = $5, dates_mentioned = $6::date[], sentiment = $7, summary = $8, processed_at = NOW()
     WHERE id = $9`,
    [
      summaryVectorStr,
      metadata.thought_type,
      metadata.people,
      metadata.topics,
      metadata.action_items,
      metadata.dates_mentioned.length > 0 ? metadata.dates_mentioned : null,
      metadata.sentiment,
      summaryText,
      parentId,
    ]
  );

  // Step 4: Chunk and embed each chunk
  const chunks = chunkText(content);
  await Promise.all(
    chunks.map(async (chunk, index) => {
      const chunkEmbedding = await embed(chunk, config);
      const chunkVectorStr = `[${chunkEmbedding.join(',')}]`;

      await pool.query(
        `INSERT INTO thoughts (content, embedding, parent_id, chunk_index, source, visibility, processed_at)
         VALUES ($1, $2::vector, $3, $4, $5, $6, NOW())`,
        [chunk, chunkVectorStr, parentId, index, source, ['owner']]
      );
    })
  );

  // Non-blocking entity resolution
  try {
    await resolveEntities(parentId, metadata, content, pool, config, sourceMeta);
  } catch (err) {
    console.error('Entity resolution failed (non-fatal):', err);
  }

  return { id: parentId, metadata, chunks: chunks.length };
}
