CREATE TABLE queue (
  id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  content       TEXT NOT NULL,
  source        TEXT NOT NULL DEFAULT 'slack',
  source_meta   JSONB,
  status        TEXT NOT NULL DEFAULT 'pending',
  error         TEXT,
  attempts      INTEGER NOT NULL DEFAULT 0,
  thought_id    UUID REFERENCES thoughts(id),
  created_at    TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  processed_at  TIMESTAMPTZ
);
