import type pg from 'pg';
import { embed } from './embedder.js';
import {
  ENTITY_STALE_MENTIONS,
  ENTITY_STALE_DAYS,
  PROFILE_REFRESH_BATCH_SIZE,
  OLLAMA_LLM_TIMEOUT_MS,
} from '@danielbrain/shared';

interface ProfileConfig {
  ollamaBaseUrl: string;
  embeddingModel: string;
  extractionModel: string;
}

export const PROFILE_SYSTEM_PROMPT = `You are writing a profile for a knowledge graph entity. This profile will be used by AI agents to quickly understand who or what this entity is.

STRUCTURE:
- Sentence 1: Who or what this is — role, title, or category.
- Sentences 2-3: Key themes and context from recent interactions.
- Sentences 4-5 (if relevant): Notable relationships, projects, or decisions.

RULES:
- Write in third person. Example: "Daniel Liebeskind is the CEO of Topia." not "You are the CEO."
- Be factual, not speculative. Only state what is supported by the provided context.
- If the context is thin (few interactions), write 2-3 sentences. Do not pad with generic filler.
- Do not add parenthetical annotations to names.
- Do not start with "Based on the provided context" or similar meta-phrases.

EXAMPLE:
Context about "Rob Fisher" (person):
1. [about] (telegram) Rob Fisher presented provocative.earth's carbon offset marketplace concept.
2. [mentions] (telegram) Discussion about integrating spatial platforms with carbon trading.
3. [mentions] (slack) Rob shared early mockups of the marketplace UI.

Profile: Rob Fisher is the founder of provocative.earth, a carbon offset marketplace platform. He has been actively discussing integration possibilities with spatial platforms and has shared early UI mockups. His focus areas include carbon trading infrastructure and marketplace design.`;

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

  const prompt = `Write a profile for "${entity.name}" (${entity.entity_type}) based on these interactions:\n\n${thoughtSummaries}`;

  const response = await fetch(`${config.ollamaBaseUrl}/api/chat`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      model: config.extractionModel,
      stream: false,
      messages: [
        {
          role: 'system',
          content: PROFILE_SYSTEM_PROMPT,
        },
        { role: 'user', content: prompt },
      ],
    }),
    signal: AbortSignal.timeout(OLLAMA_LLM_TIMEOUT_MS),
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
  // Find entities that need profile refresh.
  // Note: mention_count-based staleness is checked on-demand in get_entity,
  // but excluded from the background poller to avoid infinite refresh loops
  // (entities that hit the threshold stay there, causing re-refresh every cycle).
  const { rows } = await pool.query(
    `SELECT id, profile_summary, mention_count, updated_at
     FROM entities
     WHERE mention_count > 0
       AND (profile_summary IS NULL
            OR updated_at < NOW() - ($1 || ' days')::interval)
     ORDER BY mention_count DESC
     LIMIT $2`,
    [ENTITY_STALE_DAYS, PROFILE_REFRESH_BATCH_SIZE]
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
