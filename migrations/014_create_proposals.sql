-- Create proposals table for human-in-the-loop quality layer
CREATE TYPE proposal_status AS ENUM ('pending', 'approved', 'rejected', 'needs_changes', 'applied', 'failed');

CREATE TABLE proposals (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  proposal_type   TEXT NOT NULL,
  status          proposal_status NOT NULL DEFAULT 'pending',
  entity_id       UUID REFERENCES entities(id) ON DELETE SET NULL,
  title           TEXT NOT NULL,
  description     TEXT,
  proposed_data   JSONB NOT NULL,
  current_data    JSONB,
  auto_applied    BOOLEAN NOT NULL DEFAULT FALSE,
  reviewer_notes  TEXT,
  source          TEXT NOT NULL DEFAULT 'system',
  applied_at      TIMESTAMPTZ,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at      TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- Reuse existing update_updated_at trigger
CREATE TRIGGER proposals_updated_at
  BEFORE UPDATE ON proposals
  FOR EACH ROW
  EXECUTE FUNCTION update_updated_at();

-- Indexes for common queries
CREATE INDEX idx_proposals_status ON proposals (status);
CREATE INDEX idx_proposals_entity_id ON proposals (entity_id);
CREATE INDEX idx_proposals_type ON proposals (proposal_type);
CREATE INDEX idx_proposals_created_at ON proposals (created_at DESC);
