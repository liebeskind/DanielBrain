import type pg from 'pg';
import type { ThoughtMetadata, StructuredData, ChannelType } from '@danielbrain/shared';
import { embed, embedBatch } from './embedder.js';
import { extractMetadata } from './extractor.js';
import { chunkText, needsChunking } from './chunker.js';
import type { SourceHint } from './chunker.js';
import { summarize } from './summarizer.js';
import { resolveEntities } from './entity-resolver.js';
import { extractAndStoreFacts } from './fact-extractor.js';
import { computeSourceVisibility } from '../visibility.js';
import { createChildLogger } from '../logger.js';

const log = createChildLogger('pipeline');

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

interface StructuredActionItem {
  action: string;
  assignee: string | null;
  deadline: string | null;
  status: 'open' | 'done' | null;
}

function mergeActionItems(
  llmItems: string[],
  llmStructured: StructuredActionItem[],
  structuredItems: NonNullable<StructuredData['action_items']>,
): { items: string[]; structured: StructuredActionItem[] } {
  const merged = [...llmItems];
  const mergedStructured = [...llmStructured];

  for (const si of structuredItems) {
    const prefix = si.description.slice(0, 30).toLowerCase();
    const alreadyPresent = merged.some((item) => item.slice(0, 30).toLowerCase() === prefix);
    if (!alreadyPresent) {
      const assignee = si.assignee_name ? ` (${si.assignee_name})` : '';
      merged.push(`${si.description}${assignee}`);
      mergedStructured.push({
        action: si.description,
        assignee: si.assignee_name || null,
        deadline: null,
        status: si.completed ? 'done' : 'open',
      });
    }
  }
  return { items: merged, structured: mergedStructured };
}

/** Build ThoughtMetadata from pre-extracted directMetadata (structured CRM sources) */
function buildMetadataFromDirect(direct: {
  people?: string[];
  companies?: string[];
  topics?: string[];
  thought_type?: string;
  summary?: string;
}): ThoughtMetadata {
  return {
    thought_type: direct.thought_type ?? null,
    people: direct.people ?? [],
    topics: direct.topics ?? [],
    action_items: [],
    dates_mentioned: [],
    sentiment: null,
    summary: direct.summary ?? null,
    companies: direct.companies ?? [],
    products: [],
    projects: [],
    department: null,
    confidentiality: null,
    themes: [],
    key_decisions: [],
    key_insights: [],
    meeting_participants: [],
    action_items_structured: [],
  };
}

export async function processThought(
  content: string,
  source: string,
  pool: pg.Pool,
  config: PipelineConfig,
  sourceMeta?: Record<string, unknown> | null,
  sourceId?: string | null,
  createdAt?: Date | null,
  ownerId?: string | null,
): Promise<ProcessResult> {
  if (!needsChunking(content)) {
    return processShort(content, source, pool, config, sourceMeta, sourceId, createdAt, ownerId);
  } else {
    return processLong(content, source, pool, config, sourceMeta, sourceId, createdAt, ownerId);
  }
}

async function processShort(
  content: string,
  source: string,
  pool: pg.Pool,
  config: PipelineConfig,
  sourceMeta?: Record<string, unknown> | null,
  sourceId?: string | null,
  createdAt?: Date | null,
  ownerId?: string | null,
): Promise<ProcessResult> {
  const { structured } = parseEnvelope(sourceMeta);
  const visibility = computeSourceVisibility(source, sourceMeta, ownerId);
  const direct = (sourceMeta?.directMetadata as { people?: string[]; companies?: string[]; topics?: string[]; thought_type?: string; summary?: string } | undefined);

  // Parallel: embed + extract metadata (skip extraction if directMetadata provided)
  const [embedding, metadata] = await Promise.all([
    embed(content, config),
    direct?.thought_type
      ? Promise.resolve(buildMetadataFromDirect(direct))
      : extractMetadata(content, config),
  ]);

  // Override LLM-extracted people/companies with known HubSpot associations (hybrid extraction)
  const hubspotAssoc = sourceMeta?.hubspotAssociations as { people?: string[]; companies?: string[] } | undefined;
  if (hubspotAssoc) {
    if (hubspotAssoc.people?.length) metadata.people = hubspotAssoc.people;
    if (hubspotAssoc.companies?.length) metadata.companies = hubspotAssoc.companies;
  }

  // Merge structured action items
  if (structured.action_items?.length) {
    const merged = mergeActionItems(metadata.action_items, metadata.action_items_structured, structured.action_items);
    metadata.action_items = merged.items;
    metadata.action_items_structured = merged.structured;
  }

  const vectorStr = `[${embedding.join(',')}]`;

  const { rows } = await pool.query(
    `INSERT INTO thoughts (content, embedding, thought_type, people, topics, action_items,
      dates_mentioned, sentiment, summary, source, source_id, source_meta, visibility,
      key_decisions, key_insights, themes, department, confidentiality,
      meeting_participants, action_items_structured,
      created_at, processed_at)
     VALUES ($1, $2::vector, $3, $4, $5, $6, $7::date[], $8, $9, $10, $11, $12, $13,
       $14, $15, $16, $17, $18, $19, $20::jsonb, $21, NOW())
     ON CONFLICT (source_id) WHERE source_id IS NOT NULL
     DO UPDATE SET content = EXCLUDED.content, embedding = EXCLUDED.embedding,
       thought_type = EXCLUDED.thought_type, people = EXCLUDED.people, topics = EXCLUDED.topics,
       action_items = EXCLUDED.action_items, dates_mentioned = EXCLUDED.dates_mentioned,
       sentiment = EXCLUDED.sentiment, summary = EXCLUDED.summary,
       source_meta = EXCLUDED.source_meta,
       key_decisions = EXCLUDED.key_decisions, key_insights = EXCLUDED.key_insights,
       themes = EXCLUDED.themes, department = EXCLUDED.department,
       confidentiality = EXCLUDED.confidentiality,
       meeting_participants = EXCLUDED.meeting_participants,
       action_items_structured = EXCLUDED.action_items_structured,
       processed_at = NOW(), updated_at = NOW()
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
      visibility,
      metadata.key_decisions,
      metadata.key_insights,
      metadata.themes,
      metadata.department,
      metadata.confidentiality,
      metadata.meeting_participants,
      JSON.stringify(metadata.action_items_structured),
      createdAt ?? new Date(),
    ]
  );

  // Non-blocking entity resolution
  try {
    await resolveEntities(rows[0].id, metadata, content, pool, config, sourceMeta, createdAt ?? undefined);
  } catch (err) {
    log.error({ err }, 'Entity resolution failed (non-fatal)');
  }

  // Fire-and-forget fact extraction (non-blocking — runs after entity resolution)
  extractAndStoreFacts(rows[0].id, content, metadata, visibility, pool, config)
    .catch((err) => log.error({ err }, 'Fact extraction failed (non-fatal)'));

  return { id: rows[0].id, metadata };
}

async function processLong(
  content: string,
  source: string,
  pool: pg.Pool,
  config: PipelineConfig,
  sourceMeta?: Record<string, unknown> | null,
  sourceId?: string | null,
  createdAt?: Date | null,
  ownerId?: string | null,
): Promise<ProcessResult> {
  const ts = createdAt ?? new Date();
  const { structured, channelType } = parseEnvelope(sourceMeta);
  const sourceHint: SourceHint = channelType === 'meeting' ? 'meeting' : 'general';
  const visibility = computeSourceVisibility(source, sourceMeta, ownerId);

  // Step 1: Insert parent thought (raw text, no embedding yet) — upsert for retry idempotency
  const { rows: parentRows } = await pool.query(
    `INSERT INTO thoughts (content, source, source_id, source_meta, visibility, created_at)
     VALUES ($1, $2, $3, $4, $5, $6)
     ON CONFLICT (source_id) WHERE source_id IS NOT NULL
     DO UPDATE SET content = EXCLUDED.content, source_meta = EXCLUDED.source_meta, updated_at = NOW()
     RETURNING id`,
    [content, source, sourceId ?? null, sourceMeta ? JSON.stringify(sourceMeta) : null, visibility, ts]
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
    const merged = mergeActionItems(metadata.action_items, metadata.action_items_structured, structured.action_items);
    metadata.action_items = merged.items;
    metadata.action_items_structured = merged.structured;
  }

  // Step 3: Embed summary and store on parent
  const summaryEmbedding = await embed(summaryText, config);
  const summaryVectorStr = `[${summaryEmbedding.join(',')}]`;

  await pool.query(
    `UPDATE thoughts SET embedding = $1::vector, thought_type = $2, people = $3, topics = $4,
     action_items = $5, dates_mentioned = $6::date[], sentiment = $7, summary = $8,
     key_decisions = $9, key_insights = $10, themes = $11, department = $12,
     confidentiality = $13, meeting_participants = $14, action_items_structured = $15::jsonb,
     processed_at = NOW()
     WHERE id = $16`,
    [
      summaryVectorStr,
      metadata.thought_type,
      metadata.people,
      metadata.topics,
      metadata.action_items,
      metadata.dates_mentioned.length > 0 ? metadata.dates_mentioned : null,
      metadata.sentiment,
      summaryText,
      metadata.key_decisions,
      metadata.key_insights,
      metadata.themes,
      metadata.department,
      metadata.confidentiality,
      metadata.meeting_participants,
      JSON.stringify(metadata.action_items_structured),
      parentId,
    ]
  );

  // Step 4: Clean up old chunks (idempotent retry) then chunk + batch-embed
  const chunks = chunkText(content, undefined, undefined, sourceHint);
  const chunkEmbeddings = await embedBatch(chunks, config);

  // Write all chunks in a transaction to prevent partial state
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    await client.query(`DELETE FROM thoughts WHERE parent_id = $1`, [parentId]);

    for (let index = 0; index < chunks.length; index++) {
      const chunkVectorStr = `[${chunkEmbeddings[index].join(',')}]`;
      await client.query(
        `INSERT INTO thoughts (content, embedding, parent_id, chunk_index, source, visibility, created_at, processed_at)
         VALUES ($1, $2::vector, $3, $4, $5, $6, $7, NOW())`,
        [chunks[index], chunkVectorStr, parentId, index, source, visibility, ts]
      );
    }

    await client.query('COMMIT');
  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  } finally {
    client.release();
  }

  // Non-blocking entity resolution
  try {
    await resolveEntities(parentId, metadata, content, pool, config, sourceMeta, createdAt ?? undefined);
  } catch (err) {
    log.error({ err }, 'Entity resolution failed (non-fatal)');
  }

  // Fire-and-forget fact extraction (non-blocking)
  extractAndStoreFacts(parentId, content, metadata, visibility, pool, config)
    .catch((err) => log.error({ err }, 'Fact extraction failed (non-fatal)'));

  return { id: parentId, metadata, chunks: chunks.length };
}
