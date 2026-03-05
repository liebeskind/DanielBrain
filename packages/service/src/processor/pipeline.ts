import type pg from 'pg';
import type { ThoughtMetadata, StructuredData, ChannelType } from '@danielbrain/shared';
import { embed, embedBatch } from './embedder.js';
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

interface ParsedEnvelope {
  structured: StructuredData;
  channelType: ChannelType;
}

export function parseEnvelope(sourceMeta?: Record<string, unknown> | null): ParsedEnvelope {
  if (!sourceMeta) {
    return { structured: {}, channelType: 'manual' };
  }
  const structured = (sourceMeta.structured as StructuredData) ?? {};
  const channelType = (sourceMeta.channel_type as ChannelType) ?? 'manual';
  return { structured, channelType };
}

function mergeActionItems(
  llmItems: string[],
  structuredItems: NonNullable<StructuredData['action_items']>,
): string[] {
  const merged = [...llmItems];
  for (const si of structuredItems) {
    const prefix = si.description.slice(0, 30).toLowerCase();
    const alreadyPresent = merged.some((item) => item.slice(0, 30).toLowerCase() === prefix);
    if (!alreadyPresent) {
      const assignee = si.assignee_name ? ` (${si.assignee_name})` : '';
      merged.push(`${si.description}${assignee}`);
    }
  }
  return merged;
}

export async function processThought(
  content: string,
  source: string,
  pool: pg.Pool,
  config: PipelineConfig,
  sourceMeta?: Record<string, unknown> | null,
  sourceId?: string | null,
  createdAt?: Date | null
): Promise<ProcessResult> {
  if (!needsChunking(content)) {
    return processShort(content, source, pool, config, sourceMeta, sourceId, createdAt);
  } else {
    return processLong(content, source, pool, config, sourceMeta, sourceId, createdAt);
  }
}

async function processShort(
  content: string,
  source: string,
  pool: pg.Pool,
  config: PipelineConfig,
  sourceMeta?: Record<string, unknown> | null,
  sourceId?: string | null,
  createdAt?: Date | null
): Promise<ProcessResult> {
  const { structured } = parseEnvelope(sourceMeta);

  // Parallel: embed + extract metadata
  const [embedding, metadata] = await Promise.all([
    embed(content, config),
    extractMetadata(content, config),
  ]);

  // Merge structured action items
  if (structured.action_items?.length) {
    metadata.action_items = mergeActionItems(metadata.action_items, structured.action_items);
  }

  const vectorStr = `[${embedding.join(',')}]`;

  const { rows } = await pool.query(
    `INSERT INTO thoughts (content, embedding, thought_type, people, topics, action_items,
      dates_mentioned, sentiment, summary, source, source_id, source_meta, visibility, created_at, processed_at)
     VALUES ($1, $2::vector, $3, $4, $5, $6, $7::date[], $8, $9, $10, $11, $12, $13, $14, NOW())
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
      createdAt ?? new Date(),
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
  sourceId?: string | null,
  createdAt?: Date | null
): Promise<ProcessResult> {
  const ts = createdAt ?? new Date();
  const { structured } = parseEnvelope(sourceMeta);

  // Step 1: Insert parent thought (raw text, no embedding yet)
  const { rows: parentRows } = await pool.query(
    `INSERT INTO thoughts (content, source, source_id, source_meta, visibility, created_at)
     VALUES ($1, $2, $3, $4, $5, $6)
     RETURNING id`,
    [content, source, sourceId ?? null, sourceMeta ? JSON.stringify(sourceMeta) : null, ['owner'], ts]
  );
  const parentId = parentRows[0].id;

  // Step 2: Summarize + extract metadata (parallel)
  // Skip LLM summarization when structured summary is available
  const hasSummary = !!structured.summary;
  const [summaryText, metadata] = await Promise.all([
    hasSummary ? Promise.resolve(structured.summary!) : summarize(content, config),
    extractMetadata(content, config),
  ]);

  // Merge structured action items
  if (structured.action_items?.length) {
    metadata.action_items = mergeActionItems(metadata.action_items, structured.action_items);
  }

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

  // Step 4: Chunk and batch-embed all chunks in a single Ollama call
  const chunks = chunkText(content);
  const chunkEmbeddings = await embedBatch(chunks, config);

  await Promise.all(
    chunks.map(async (chunk, index) => {
      const chunkVectorStr = `[${chunkEmbeddings[index].join(',')}]`;

      await pool.query(
        `INSERT INTO thoughts (content, embedding, parent_id, chunk_index, source, visibility, created_at, processed_at)
         VALUES ($1, $2::vector, $3, $4, $5, $6, $7, NOW())`,
        [chunk, chunkVectorStr, parentId, index, source, ['owner'], ts]
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
