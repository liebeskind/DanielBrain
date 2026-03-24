/**
 * Centralized fact query functions.
 * Facts are atomic statements extracted from thoughts with their own embeddings.
 */
import type pg from 'pg';

export interface FactSearchResult {
  id: string;
  statement: string;
  fact_type: string;
  confidence: number;
  similarity: number;
  subject_name: string | null;
  subject_type: string | null;
  object_name: string | null;
  object_type: string | null;
  thought_id: string;
  valid_at: Date | null;
  invalid_at: Date | null;
  created_at: Date;
}

/** Search facts by embedding similarity with optional visibility filtering */
export async function searchFacts(
  pool: pg.Pool,
  queryEmbedding: number[],
  options: { limit?: number; threshold?: number; entityId?: string },
  visibilityTags: string[] | null,
): Promise<FactSearchResult[]> {
  const vectorStr = `[${queryEmbedding.join(',')}]`;
  const limit = options.limit ?? 10;
  const threshold = options.threshold ?? 0.3;

  const conditions = [
    'f.embedding IS NOT NULL',
    'f.invalid_at IS NULL',
    `1 - ((f.embedding::halfvec(768)) <=> ($1::vector::halfvec(768))) >= $2`,
  ];
  const params: unknown[] = [vectorStr, threshold];
  let paramIdx = 3;

  if (options.entityId) {
    conditions.push(`(f.subject_entity_id = $${paramIdx} OR f.object_entity_id = $${paramIdx})`);
    params.push(options.entityId);
    paramIdx++;
  }

  if (visibilityTags && visibilityTags.length > 0) {
    conditions.push(`f.visibility && $${paramIdx}`);
    params.push(visibilityTags);
    paramIdx++;
  }

  params.push(limit);

  const { rows } = await pool.query(
    `SELECT f.id, f.statement, f.fact_type, f.confidence,
            1 - ((f.embedding::halfvec(768)) <=> ($1::vector::halfvec(768))) as similarity,
            s.name as subject_name, s.entity_type as subject_type,
            o.name as object_name, o.entity_type as object_type,
            f.thought_id, f.valid_at, f.invalid_at, f.created_at
     FROM facts f
     LEFT JOIN entities s ON s.id = f.subject_entity_id
     LEFT JOIN entities o ON o.id = f.object_entity_id
     WHERE ${conditions.join(' AND ')}
     ORDER BY f.embedding::halfvec(768) <=> $1::vector::halfvec(768)
     LIMIT $${paramIdx}`,
    params,
  );

  return rows.map((r: any) => ({
    ...r,
    similarity: parseFloat(r.similarity),
    confidence: parseFloat(r.confidence),
  }));
}

/** Get facts linked to a specific entity */
export async function getFactsForEntity(
  pool: pg.Pool,
  entityId: string,
  options?: { limit?: number; includeInvalid?: boolean },
): Promise<FactSearchResult[]> {
  const limit = options?.limit ?? 20;
  const invalidClause = options?.includeInvalid ? '' : 'AND f.invalid_at IS NULL';

  const { rows } = await pool.query(
    `SELECT f.id, f.statement, f.fact_type, f.confidence, 0.0 as similarity,
            s.name as subject_name, s.entity_type as subject_type,
            o.name as object_name, o.entity_type as object_type,
            f.thought_id, f.valid_at, f.invalid_at, f.created_at
     FROM facts f
     LEFT JOIN entities s ON s.id = f.subject_entity_id
     LEFT JOIN entities o ON o.id = f.object_entity_id
     WHERE (f.subject_entity_id = $1 OR f.object_entity_id = $1)
       ${invalidClause}
     ORDER BY f.created_at DESC
     LIMIT $2`,
    [entityId, limit],
  );

  return rows.map((r: any) => ({
    ...r,
    similarity: 0,
    confidence: parseFloat(r.confidence),
  }));
}
