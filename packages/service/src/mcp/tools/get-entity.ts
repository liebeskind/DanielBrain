import type pg from 'pg';
import type { Entity } from '@danielbrain/shared';
import { ENTITY_STALE_MENTIONS, ENTITY_STALE_DAYS } from '@danielbrain/shared';
import { getFactsForEntity } from '../../db/fact-queries.js';

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
  relationship_description?: string | null;
  relationship_weight?: number;
  relationship_type?: string;
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
  visibilityTags?: string[] | null,
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

  // Fetch recent linked thoughts (filtered by visibility)
  const thoughtParams: unknown[] = [entity.id];
  let visClause = '';
  if (visibilityTags) {
    thoughtParams.push(visibilityTags);
    visClause = ` AND t.visibility && $${thoughtParams.length}`;
  }
  const { rows: thoughts } = await pool.query(
    `SELECT t.id, t.content, t.summary, t.thought_type, te.relationship, t.source, t.created_at
     FROM thought_entities te
     JOIN thoughts t ON t.id = te.thought_id
     WHERE te.entity_id = $1${visClause}
     ORDER BY t.created_at DESC
     LIMIT 20`,
    thoughtParams
  );

  // Fetch connected entities (entities sharing thoughts + explicit relationship edges)
  const { rows: connected } = await pool.query(
    `SELECT e.id, e.name, e.entity_type,
            COALESCE(co.shared_thought_count, 0) as shared_thought_count,
            er.description as relationship_description,
            er.weight as relationship_weight,
            er.relationship as relationship_type
     FROM (
       -- Co-occurrence via shared thoughts
       SELECT te2.entity_id, COUNT(*) as shared_thought_count
       FROM thought_entities te1
       JOIN thought_entities te2 ON te1.thought_id = te2.thought_id AND te1.entity_id != te2.entity_id
       WHERE te1.entity_id = $1
       GROUP BY te2.entity_id
     ) co
     FULL OUTER JOIN (
       -- Explicit relationship edges (active only)
       SELECT
         CASE WHEN source_id = $1 THEN target_id ELSE source_id END as entity_id,
         description, weight, relationship
       FROM entity_relationships
       WHERE (source_id = $1 OR target_id = $1) AND invalid_at IS NULL
     ) er ON co.entity_id = er.entity_id
     JOIN entities e ON e.id = COALESCE(co.entity_id, er.entity_id)
     ORDER BY COALESCE(er.weight, 0) + COALESCE(co.shared_thought_count, 0) DESC
     LIMIT 10`,
    [entity.id]
  );

  // Check staleness for profile refresh
  const mentionsSinceRefresh = entity.mention_count; // Simplified: full count
  const daysSinceUpdate = (Date.now() - new Date(entity.updated_at).getTime()) / (1000 * 60 * 60 * 24);
  const needsRefresh = !entity.profile_summary
    || mentionsSinceRefresh >= ENTITY_STALE_MENTIONS
    || daysSinceUpdate >= ENTITY_STALE_DAYS;

  // Fetch known facts about this entity
  const facts = await getFactsForEntity(pool, entity.id, { limit: 10 });

  return {
    entity,
    recent_thoughts: thoughts,
    connected_entities: connected.map(r => ({
      id: r.id,
      name: r.name,
      entity_type: r.entity_type,
      shared_thought_count: parseInt(r.shared_thought_count, 10),
      relationship_description: r.relationship_description || null,
      relationship_weight: r.relationship_weight ? parseInt(r.relationship_weight, 10) : undefined,
      relationship_type: r.relationship_type || undefined,
    })),
    known_facts: facts.map(f => ({
      statement: f.statement,
      fact_type: f.fact_type,
      confidence: f.confidence,
    })),
    needs_profile_refresh: needsRefresh,
  };
}
