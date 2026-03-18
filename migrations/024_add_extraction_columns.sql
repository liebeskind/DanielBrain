-- New extraction metadata columns
ALTER TABLE thoughts ADD COLUMN IF NOT EXISTS key_decisions TEXT[] NOT NULL DEFAULT '{}';
ALTER TABLE thoughts ADD COLUMN IF NOT EXISTS key_insights TEXT[] NOT NULL DEFAULT '{}';
ALTER TABLE thoughts ADD COLUMN IF NOT EXISTS themes TEXT[] NOT NULL DEFAULT '{}';
ALTER TABLE thoughts ADD COLUMN IF NOT EXISTS department TEXT;
ALTER TABLE thoughts ADD COLUMN IF NOT EXISTS confidentiality TEXT;
ALTER TABLE thoughts ADD COLUMN IF NOT EXISTS meeting_participants TEXT[] NOT NULL DEFAULT '{}';
ALTER TABLE thoughts ADD COLUMN IF NOT EXISTS action_items_structured JSONB NOT NULL DEFAULT '[]';

-- Flag for explicit (LLM-extracted) vs co-occurrence relationships
ALTER TABLE entity_relationships ADD COLUMN IF NOT EXISTS is_explicit BOOLEAN NOT NULL DEFAULT FALSE;

CREATE INDEX IF NOT EXISTS idx_entity_relationships_explicit
  ON entity_relationships (source_id, target_id) WHERE is_explicit = TRUE AND invalid_at IS NULL;
