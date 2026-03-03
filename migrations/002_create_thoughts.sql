CREATE TABLE thoughts (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  content         TEXT NOT NULL,
  embedding       vector(768),

  -- Extracted metadata
  thought_type    TEXT,
  people          TEXT[],
  topics          TEXT[],
  action_items    TEXT[],
  dates_mentioned DATE[],
  sentiment       TEXT,
  summary         TEXT,

  -- Chunking support
  parent_id       UUID REFERENCES thoughts(id),
  chunk_index     INTEGER,

  -- Source tracking
  source          TEXT NOT NULL DEFAULT 'manual',
  source_id       TEXT,
  source_meta     JSONB,

  -- Permissions (Phase 2 — column present from day 1, defaults to full access)
  visibility      TEXT[] NOT NULL DEFAULT '{owner}',

  created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  processed_at    TIMESTAMPTZ,
  updated_at      TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE OR REPLACE FUNCTION update_updated_at()
RETURNS TRIGGER AS $$ BEGIN NEW.updated_at = NOW(); RETURN NEW; END; $$ LANGUAGE plpgsql;

CREATE TRIGGER thoughts_updated_at BEFORE UPDATE ON thoughts
  FOR EACH ROW EXECUTE FUNCTION update_updated_at();
