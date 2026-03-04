CREATE TYPE entity_type AS ENUM ('person', 'company', 'topic', 'product', 'project', 'place');

CREATE TABLE entities (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  name            TEXT NOT NULL,
  entity_type     entity_type NOT NULL,
  aliases         TEXT[] NOT NULL DEFAULT '{}',
  canonical_name  TEXT NOT NULL,
  profile_summary TEXT,
  embedding       vector(768),
  metadata        JSONB NOT NULL DEFAULT '{}',
  mention_count   INTEGER NOT NULL DEFAULT 0,
  visibility      TEXT[] NOT NULL DEFAULT '{owner}',
  first_seen_at   TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  last_seen_at    TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at      TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TRIGGER entities_updated_at BEFORE UPDATE ON entities
  FOR EACH ROW EXECUTE FUNCTION update_updated_at();

CREATE UNIQUE INDEX entities_canonical_type_unique ON entities (canonical_name, entity_type);
