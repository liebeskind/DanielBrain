CREATE TABLE entity_relationships (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  source_id       UUID NOT NULL REFERENCES entities(id) ON DELETE CASCADE,
  target_id       UUID NOT NULL REFERENCES entities(id) ON DELETE CASCADE,
  relationship    TEXT NOT NULL,
  metadata        JSONB NOT NULL DEFAULT '{}',
  visibility      TEXT[] NOT NULL DEFAULT '{owner}',
  first_seen_at   TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  last_seen_at    TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (source_id, target_id, relationship)
);

CREATE TRIGGER entity_relationships_updated_at BEFORE UPDATE ON entity_relationships
  FOR EACH ROW EXECUTE FUNCTION update_updated_at();
