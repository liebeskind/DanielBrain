CREATE TYPE entity_relationship AS ENUM ('mentions', 'about', 'from', 'assigned_to', 'created_by');

CREATE TABLE thought_entities (
  thought_id    UUID NOT NULL REFERENCES thoughts(id) ON DELETE CASCADE,
  entity_id     UUID NOT NULL REFERENCES entities(id) ON DELETE CASCADE,
  relationship  entity_relationship NOT NULL DEFAULT 'mentions',
  confidence    REAL NOT NULL DEFAULT 1.0,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  PRIMARY KEY (thought_id, entity_id, relationship)
);
