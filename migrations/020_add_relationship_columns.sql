-- Add columns to entity_relationships for weight tracking, descriptions, and temporal edges
ALTER TABLE entity_relationships ADD COLUMN IF NOT EXISTS weight INTEGER NOT NULL DEFAULT 1;
ALTER TABLE entity_relationships ADD COLUMN IF NOT EXISTS description TEXT;
ALTER TABLE entity_relationships ADD COLUMN IF NOT EXISTS valid_at TIMESTAMPTZ;
ALTER TABLE entity_relationships ADD COLUMN IF NOT EXISTS invalid_at TIMESTAMPTZ;
ALTER TABLE entity_relationships ADD COLUMN IF NOT EXISTS source_thought_ids UUID[] NOT NULL DEFAULT '{}';

-- Index for finding undescribed edges to process
CREATE INDEX IF NOT EXISTS idx_entity_relationships_undescribed
  ON entity_relationships (weight DESC)
  WHERE description IS NULL AND invalid_at IS NULL;

-- Index for finding active (non-invalidated) relationships
CREATE INDEX IF NOT EXISTS idx_entity_relationships_active
  ON entity_relationships (source_id, target_id)
  WHERE invalid_at IS NULL;
