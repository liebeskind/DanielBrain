/**
 * Centralized thought query functions with mandatory visibility filtering.
 * Every function that reads thoughts requires visibilityTags explicitly —
 * there's no way to "forget" it.
 *
 * null visibilityTags = no filtering (owner role).
 * string[] = filter by visibility && tags.
 */
import type pg from 'pg';

/** Reusable visibility clause builder */
function visibilityClause(
  visibilityTags: string[] | null,
  paramIdx: number,
): { clause: string; params: unknown[] } {
  if (!visibilityTags || visibilityTags.length === 0) {
    return { clause: '', params: [] };
  }
  return {
    clause: ` AND t.visibility && $${paramIdx}`,
    params: [visibilityTags],
  };
}

// --- Parent context fetch (used by semantic-search for chunk→parent resolution) ---

export interface ParentContext {
  id: string;
  summary: string | null;
  thought_type: string | null;
  people: string[];
  topics: string[];
}

/**
 * Fetch parent thoughts by IDs with visibility filtering.
 * Fixes the unfiltered parent fetch bug in semantic-search.
 */
export async function fetchParentContext(
  pool: pg.Pool,
  parentIds: string[],
  visibilityTags: string[] | null,
): Promise<Map<string, ParentContext>> {
  const map = new Map<string, ParentContext>();
  if (parentIds.length === 0) return map;

  const vis = visibilityClause(visibilityTags, 2);
  const { rows } = await pool.query(
    `SELECT t.id, t.summary, t.thought_type, t.people, t.topics
     FROM thoughts t
     WHERE t.id = ANY($1)${vis.clause}`,
    [parentIds, ...vis.params],
  );

  for (const p of rows) {
    map.set(p.id, {
      id: p.id,
      summary: p.summary,
      thought_type: p.thought_type,
      people: p.people,
      topics: p.topics,
    });
  }
  return map;
}

// --- List recent thoughts ---

export interface RecentThought {
  id: string;
  content: string;
  thought_type: string | null;
  summary: string | null;
  people: string[];
  topics: string[];
  source: string;
  created_at: Date;
}

export async function listRecentThoughts(
  pool: pg.Pool,
  input: { days: number; limit: number; thought_type?: string; source?: string },
  visibilityTags: string[] | null,
): Promise<RecentThought[]> {
  const params: (number | string | string[])[] = [input.days, input.limit];
  let filterClauses = '';

  if (input.thought_type) {
    params.push(input.thought_type);
    filterClauses += ` AND thought_type = $${params.length}`;
  }
  if (input.source) {
    params.push(input.source);
    filterClauses += ` AND source = $${params.length}`;
  }
  if (visibilityTags) {
    params.push(visibilityTags);
    filterClauses += ` AND visibility && $${params.length}`;
  }

  const { rows } = await pool.query(
    `SELECT id, content, thought_type, summary, people, topics, source, created_at
     FROM thoughts
     WHERE parent_id IS NULL
       AND created_at >= NOW() - ($1 || ' days')::interval
       ${filterClauses}
     ORDER BY created_at DESC
     LIMIT $2`,
    params,
  );

  return rows;
}

// --- Fetch thoughts linked to entities (used by get-entity, get-context, get-timeline) ---

export interface LinkedThought {
  id: string;
  content: string;
  summary: string | null;
  thought_type: string | null;
  relationship: string;
  source: string;
  created_at: Date;
}

/**
 * Fetch thoughts linked to a single entity by entity_id.
 * Used by get-entity.
 */
export async function fetchThoughtsForEntity(
  pool: pg.Pool,
  entityId: string,
  options: { limit?: number },
  visibilityTags: string[] | null,
): Promise<LinkedThought[]> {
  const params: unknown[] = [entityId];
  let visClause = '';
  if (visibilityTags) {
    params.push(visibilityTags);
    visClause = ` AND t.visibility && $${params.length}`;
  }

  const limit = options.limit ?? 20;
  params.push(limit);

  const { rows } = await pool.query(
    `SELECT t.id, t.content, t.summary, t.thought_type, te.relationship, t.source, t.created_at
     FROM thought_entities te
     JOIN thoughts t ON t.id = te.thought_id
     WHERE te.entity_id = $1${visClause}
     ORDER BY t.created_at DESC
     LIMIT $${params.length}`,
    params,
  );

  return rows;
}

/**
 * Fetch thoughts linked to multiple entities with overlap counting.
 * Used by get-context.
 */
export async function fetchThoughtsForEntities(
  pool: pg.Pool,
  entityIds: string[],
  options: { daysBack: number; maxThoughts: number },
  visibilityTags: string[] | null,
): Promise<any[]> {
  const params: unknown[] = [entityIds, options.daysBack, options.maxThoughts];
  let visClause = '';
  if (visibilityTags) {
    params.push(visibilityTags);
    visClause = ` AND t.visibility && $${params.length}`;
  }

  const { rows } = await pool.query(
    `SELECT t.id, t.content, t.summary, t.thought_type, t.source, t.created_at,
            t.action_items, t.topics,
            COUNT(DISTINCT te.entity_id) as entity_overlap,
            ARRAY_AGG(DISTINCT e.name) as matched_entities
     FROM thought_entities te
     JOIN thoughts t ON t.id = te.thought_id
     JOIN entities e ON e.id = te.entity_id
     WHERE te.entity_id = ANY($1)
       AND t.created_at >= NOW() - ($2 || ' days')::interval
       AND t.parent_id IS NULL${visClause}
     GROUP BY t.id, t.content, t.summary, t.thought_type, t.source, t.created_at,
              t.action_items, t.topics
     ORDER BY entity_overlap DESC, t.created_at DESC
     LIMIT $3`,
    params,
  );

  return rows;
}

/**
 * Fetch timeline entries for an entity.
 * Used by get-timeline.
 */
export async function fetchTimelineForEntity(
  pool: pg.Pool,
  entityId: string,
  options: { daysBack: number; limit: number; sources?: string[] },
  visibilityTags: string[] | null,
): Promise<LinkedThought[]> {
  const conditions = [
    'te.entity_id = $1',
    `t.created_at >= NOW() - ($2 || ' days')::interval`,
    't.parent_id IS NULL',
  ];
  const params: unknown[] = [entityId, options.daysBack];
  let paramIdx = 3;

  if (options.sources && options.sources.length > 0) {
    conditions.push(`t.source = ANY($${paramIdx})`);
    params.push(options.sources);
    paramIdx++;
  }
  if (visibilityTags) {
    conditions.push(`t.visibility && $${paramIdx}`);
    params.push(visibilityTags);
    paramIdx++;
  }

  params.push(options.limit);

  const { rows } = await pool.query(
    `SELECT t.id, t.content, t.summary, t.thought_type, te.relationship, t.source, t.created_at
     FROM thought_entities te
     JOIN thoughts t ON t.id = te.thought_id
     WHERE ${conditions.join(' AND ')}
     ORDER BY t.created_at DESC
     LIMIT $${paramIdx}`,
    params,
  );

  return rows;
}
