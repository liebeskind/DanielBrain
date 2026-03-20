-- Phase 9d: Audit trail for selective sharing (promoting visibility)
CREATE TABLE thought_shares (
  id                UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  thought_id        UUID NOT NULL REFERENCES thoughts(id),
  shared_by         UUID NOT NULL REFERENCES users(id),
  visibility_added  TEXT NOT NULL,
  created_at        TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX idx_thought_shares_thought ON thought_shares(thought_id);
