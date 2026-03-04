import type pg from 'pg';
import { embed } from './embedder.js';
import {
  ENTITY_STALE_MENTIONS,
  ENTITY_STALE_DAYS,
  PROFILE_REFRESH_BATCH_SIZE,
} from '@danielbrain/shared';

interface ProfileConfig {
  ollamaBaseUrl: string;
  embeddingModel: string;
  extractionModel: string;
}

export function isProfileStale(
  entity: { profile_summary: string | null; mention_count: number; updated_at: Date },
): boolean {
  if (!entity.profile_summary) return true;

  const daysSinceUpdate = (Date.now() - new Date(entity.updated_at).getTime()) / (1000 * 60 * 60 * 24);
  if (daysSinceUpdate >= ENTITY_STALE_DAYS) return true;
  if (entity.mention_count >= ENTITY_STALE_MENTIONS) return true;

  return false;
}

export async function generateProfile(
  entityId: string,
  pool: pg.Pool,
  config: ProfileConfig,
): Promise<string> {
  // Fetch entity info
  const { rows: entityRows } = await pool.query(
    `SELECT id, name, entity_type, metadata FROM entities WHERE id = $1`,
    [entityId]
  );

  if (entityRows.length === 0) {
    throw new Error(`Entity not found: ${entityId}`);
  }

  const entity = entityRows[0];

  // Fetch recent linked thoughts for context
  const { rows: thoughts } = await pool.query(
    `SELECT t.content, t.summary, t.thought_type, te.relationship, t.source
     FROM thought_entities te
     JOIN thoughts t ON t.id = te.thought_id
     WHERE te.entity_id = $1
     ORDER BY t.created_at DESC
     LIMIT 20`,
    [entityId]
  );

  if (thoughts.length === 0) {
    return `${entity.name} is a known ${entity.entity_type} with no detailed context yet.`;
  }

  // Build context for LLM
  const thoughtSummaries = thoughts.map((t, i) => {
    const text = t.summary || t.content.slice(0, 200);
    return `${i + 1}. [${t.relationship}] (${t.source}) ${text}`;
  }).join('\n');

  const prompt = `Based on the following context about "${entity.name}" (${entity.entity_type}), write a concise 3-5 sentence profile summary. Focus on who/what this is, their role or significance, and key themes from recent interactions.\n\nContext:\n${thoughtSummaries}`;

  const response = await fetch(`${config.ollamaBaseUrl}/api/chat`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      model: config.extractionModel,
      stream: false,
      messages: [
        {
          role: 'system',
          content: 'You are a concise profile writer. Write a brief, informative profile summary based on the provided context. Keep it to 3-5 sentences.',
        },
        { role: 'user', content: prompt },
      ],
    }),
  });

  if (!response.ok) {
    const errorText = await response.text();
    throw new Error(`Ollama profile generation failed (${response.status}): ${errorText}`);
  }

  const data = await response.json() as { message: { content: string } };
  const profileSummary = data.message.content.trim();

  // Generate embedding for the profile
  const profileEmbedding = await embed(profileSummary, config);
  const vectorStr = `[${profileEmbedding.join(',')}]`;

  // Update entity with profile and embedding
  await pool.query(
    `UPDATE entities SET profile_summary = $1, embedding = $2::vector, updated_at = NOW()
     WHERE id = $3`,
    [profileSummary, vectorStr, entityId]
  );

  return profileSummary;
}

export async function refreshStaleProfiles(
  pool: pg.Pool,
  config: ProfileConfig,
): Promise<number> {
  // Find entities that need profile refresh
  const { rows } = await pool.query(
    `SELECT id, profile_summary, mention_count, updated_at
     FROM entities
     WHERE profile_summary IS NULL
        OR updated_at < NOW() - ($1 || ' days')::interval
        OR mention_count >= $2
     ORDER BY mention_count DESC
     LIMIT $3`,
    [ENTITY_STALE_DAYS, ENTITY_STALE_MENTIONS, PROFILE_REFRESH_BATCH_SIZE]
  );

  let refreshed = 0;
  for (const entity of rows) {
    try {
      await generateProfile(entity.id, pool, config);
      refreshed++;
    } catch (err) {
      console.error(`Profile refresh failed for entity ${entity.id}:`, err);
    }
  }

  return refreshed;
}
