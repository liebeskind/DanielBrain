-- Correction examples: store past corrections for few-shot prompt injection
CREATE TABLE correction_examples (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  category        TEXT NOT NULL,
  input_context   JSONB NOT NULL,
  actual_output   JSONB,
  expected_output JSONB NOT NULL,
  explanation     TEXT,
  entity_id       UUID REFERENCES entities(id) ON DELETE SET NULL,
  proposal_id     UUID REFERENCES proposals(id) ON DELETE SET NULL,
  tags            TEXT[] NOT NULL DEFAULT '{}',
  created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at      TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX idx_correction_examples_category ON correction_examples(category);
CREATE INDEX idx_correction_examples_entity_id ON correction_examples(entity_id);
CREATE INDEX idx_correction_examples_tags ON correction_examples USING GIN(tags);
CREATE INDEX idx_correction_examples_created_at ON correction_examples(created_at DESC);

-- Reuse existing update_updated_at trigger function
CREATE TRIGGER update_correction_examples_updated_at
  BEFORE UPDATE ON correction_examples
  FOR EACH ROW
  EXECUTE FUNCTION update_updated_at();
