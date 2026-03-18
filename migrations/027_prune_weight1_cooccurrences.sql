-- One-time cleanup: remove weight=1 co-occurrence edges (single co-occurrences are noise)
-- The cap in relationship-builder.ts (MAX_COOCCURRENCE_ENTITIES=20) prevents future explosion.
DELETE FROM entity_relationships
WHERE relationship = 'co_occurs'
  AND is_explicit = FALSE
  AND weight = 1;
