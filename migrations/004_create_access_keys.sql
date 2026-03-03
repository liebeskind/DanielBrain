CREATE TABLE access_keys (
  id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  name        TEXT NOT NULL,
  key_hash    TEXT NOT NULL UNIQUE,
  scopes      TEXT[] NOT NULL DEFAULT '{owner}',
  active      BOOLEAN NOT NULL DEFAULT true,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  last_used   TIMESTAMPTZ,
  expires_at  TIMESTAMPTZ
);
