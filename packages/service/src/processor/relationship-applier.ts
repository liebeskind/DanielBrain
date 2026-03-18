import type pg from 'pg';
import type { ExtractedRelationship } from './relationship-extractor.js';

/**
 * Normalize entity name for matching (lowercase, trim).
 */
function normalizeForMatch(name: string): string {
  return name.toLowerCase().trim();
}

/**
 * Apply explicitly extracted relationships to the entity_relationships table.
 * Returns a set of "sourceUuid:targetUuid" canonical pairs that got explicit relationships.
 */
export async function applyExtractedRelationships(
  relationships: ExtractedRelationship[],
  thoughtId: string,
  pool: pg.Pool,
): Promise<Set<string>> {
  const appliedPairs = new Set<string>();

  for (const rel of relationships) {
    try {
      // Resolve entity names to IDs
      const sourceNorm = normalizeForMatch(rel.source);
      const targetNorm = normalizeForMatch(rel.target);

      const { rows: sourceRows } = await pool.query(
        `SELECT id FROM entities WHERE canonical_name = $1 LIMIT 1`,
        [sourceNorm],
      );
      const { rows: targetRows } = await pool.query(
        `SELECT id FROM entities WHERE canonical_name = $1 LIMIT 1`,
        [targetNorm],
      );

      if (sourceRows.length === 0 || targetRows.length === 0) continue;

      const sourceUuid = sourceRows[0].id;
      const targetUuid = targetRows[0].id;

      // Canonical direction: smaller UUID = source_id
      const [canonSource, canonTarget] = sourceUuid < targetUuid
        ? [sourceUuid, targetUuid]
        : [targetUuid, sourceUuid];

      const pairKey = `${canonSource}:${canonTarget}`;
      appliedPairs.add(pairKey);

      await pool.query(
        `INSERT INTO entity_relationships (source_id, target_id, relationship, description, is_explicit, weight, source_thought_ids)
         VALUES ($1, $2, $3, $4, TRUE, 2, ARRAY[$5::uuid])
         ON CONFLICT (source_id, target_id, relationship) DO UPDATE SET
           description = COALESCE($4, entity_relationships.description),
           is_explicit = TRUE,
           weight = entity_relationships.weight + 2,
           last_seen_at = NOW(),
           source_thought_ids = CASE
             WHEN $5::uuid = ANY(entity_relationships.source_thought_ids) THEN entity_relationships.source_thought_ids
             ELSE array_append(entity_relationships.source_thought_ids, $5::uuid)
           END`,
        [canonSource, canonTarget, rel.relationship, rel.description, thoughtId],
      );
    } catch (err) {
      console.error(`Failed to apply relationship ${rel.source} → ${rel.target}:`, err);
    }
  }

  return appliedPairs;
}
