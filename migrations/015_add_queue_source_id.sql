-- Add source_id to queue table for deduplication (e.g., fathom-{recording_id})
ALTER TABLE queue ADD COLUMN source_id TEXT;
CREATE UNIQUE INDEX queue_source_id_unique ON queue (source_id) WHERE source_id IS NOT NULL;
