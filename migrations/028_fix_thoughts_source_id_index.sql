-- Fix thoughts_source_id_unique to be a partial index.
-- The existing index includes NULL source_id values, which:
-- 1. Prevents multiple NULL source_ids (wrong — most thoughts have no source_id)
-- 2. Doesn't match the ON CONFLICT (source_id) WHERE source_id IS NOT NULL clause in pipeline.ts
-- This mismatch causes "duplicate key" errors instead of upserts.
DROP INDEX IF EXISTS thoughts_source_id_unique;
CREATE UNIQUE INDEX thoughts_source_id_unique ON thoughts (source_id) WHERE source_id IS NOT NULL;
