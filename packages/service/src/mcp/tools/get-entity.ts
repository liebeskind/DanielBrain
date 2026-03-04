import type pg from 'pg';
import type { Entity } from '@danielbrain/shared';
import { ENTITY_STALE_MENTIONS, ENTITY_STALE_DAYS } from '@danielbrain/shared';

interface GetEntityInput {
  entity_id?: string;
  name?: string;
  entity_type?: string;
}

interface PipelineConfig {
  ollamaBaseUrl: string;
  embeddingModel: string;
  extractionModel: string;
}

interface LinkedThought {
  id: string;
  content: string;
  summary: string | null;
  thought_type: string | null;
  relationship: string;
  source: string;
  created_at: Date;
}

interface ConnectedEntity {
  id: string;
  name: string;
  entity_type: string;
  shared_thought_count: number;
}

interface GetEntityResult {
  entity: Entity;
  recent_thoughts: LinkedThought[];
  connected_entities: ConnectedEntity[];
  needs_profile_refresh: boolean;
}

export async function handleGetEntity(
  input: GetEntityInput,
  pool: pg.Pool,
  _config: PipelineConfig,
): Promise<GetEntityResult> {
  let entity: Entity;

  if (input.entity_id) {
    const { rows } = await pool.query(
      `SELECT * FROM entities WHERE id = $1`,
      [input.entity_id]
    );
    if (rows.length === 0) {
      throw new Error(`Entity not found: ${input.entity_id}`);
    }
    entity = rows[0];
  } else {
    const canonical = input.name!.toLowerCase().trim();
    const typeFilter = input.entity_type ? 'AND entity_type = $2' : '';
    const params = input.entity_type ? [canonical, input.entity_type] : [canonical];

    // Try canonical name first
    const { rows } = await pool.query(
      `SELECT * FROM entities WHERE canonical_name = $1 ${typeFilter} LIMIT 1`,
      params
    );

    if (rows.length > 0) {
      entity = rows[0];
    } else {
      // Try alias match
      const { rows: aliasRows } = await pool.query(
        `SELECT * FROM entities WHERE $1 = ANY(aliases) ${typeFilter} LIMIT 1`,
        params
      );
      if (aliasRows.length === 0) {
        throw new Error(`Entity not found: ${input.name}`);
      }
      entity = aliasRows[0];
    }
  }

  // Fetch recent linked thoughts
  const { rows: thoughts } = await pool.query(
    `SELECT t.id, t.content, t.summary, t.thought_type, te.relationship, t.source, t.created_at
     FROM thought_entities te
     JOIN thoughts t ON t.id = te.thought_id
     WHERE te.entity_id = $1
     ORDER BY t.created_at DESC
     LIMIT 20`,
    [entity.id]
  );

  // Fetch connected entities (entities sharing thoughts with this one)
  const { rows: connected } = await pool.query(
    `SELECT e.id, e.name, e.entity_type, COUNT(*) as shared_thought_count
     FROM thought_entities te1
     JOIN thought_entities te2 ON te1.thought_id = te2.thought_id AND te1.entity_id != te2.entity_id
     JOIN entities e ON e.id = te2.entity_id
     WHERE te1.entity_id = $1
     GROUP BY e.id, e.name, e.entity_type
     ORDER BY shared_thought_count DESC
     LIMIT 10`,
    [entity.id]
  );

  // Check staleness for profile refresh
  const mentionsSinceRefresh = entity.mention_count; // Simplified: full count
  const daysSinceUpdate = (Date.now() - new Date(entity.updated_at).getTime()) / (1000 * 60 * 60 * 24);
  const needsRefresh = !entity.profile_summary
    || mentionsSinceRefresh >= ENTITY_STALE_MENTIONS
    || daysSinceUpdate >= ENTITY_STALE_DAYS;

  return {
    entity,
    recent_thoughts: thoughts,
    connected_entities: connected.map(r => ({
      ...r,
      shared_thought_count: parseInt(r.shared_thought_count, 10),
    })),
    needs_profile_refresh: needsRefresh,
  };
}
