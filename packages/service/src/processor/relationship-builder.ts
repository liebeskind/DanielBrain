import type pg from 'pg';
import { MAX_COOCCURRENCE_ENTITIES } from '@danielbrain/shared';

/**
 * Create co-occurrence edges between all entities mentioned in the same thought.
 * Canonical direction: smaller UUID = source_id to avoid A→B / B→A duplicates.
 */
export async function createCooccurrenceEdges(
  thoughtId: string,
  entityIds: string[],
  pool: pg.Pool,
  skipPairs?: Set<string>,
): Promise<number> {
  if (entityIds.length < 2) return 0;

  // Deduplicate entity IDs
  const unique = [...new Set(entityIds)];
  if (unique.length < 2) return 0;

  // Cap to prevent quadratic explosion on large transcripts
  const capped = unique.length > MAX_COOCCURRENCE_ENTITIES
    ? unique.slice(0, MAX_COOCCURRENCE_ENTITIES)
    : unique;

  let created = 0;

  // All pairwise combinations
  for (let i = 0; i < capped.length; i++) {
    for (let j = i + 1; j < capped.length; j++) {
      // Canonical direction: smaller UUID = source_id
      const [sourceId, targetId] = capped[i] < capped[j]
        ? [capped[i], capped[j]]
        : [capped[j], capped[i]];

      // Skip pairs that already have explicit relationships
      if (skipPairs?.has(`${sourceId}:${targetId}`)) continue;

      await pool.query(
        `INSERT INTO entity_relationships (source_id, target_id, relationship, source_thought_ids)
         VALUES ($1, $2, 'co_occurs', ARRAY[$3::uuid])
         ON CONFLICT (source_id, target_id, relationship) DO UPDATE SET
           weight = entity_relationships.weight + 1,
           last_seen_at = NOW(),
           source_thought_ids = CASE
             WHEN $3::uuid = ANY(entity_relationships.source_thought_ids) THEN entity_relationships.source_thought_ids
             ELSE array_append(entity_relationships.source_thought_ids, $3::uuid)
           END`,
        [sourceId, targetId, thoughtId]
      );
      created++;
    }
  }

  return created;
}
