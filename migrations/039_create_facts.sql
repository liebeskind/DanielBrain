-- Atomic facts extracted from thoughts, entity-linked with temporal validity
-- Enables fact-level retrieval (Dense X: 17-25% improvement over passage-level)
-- and contradiction detection (Graphiti pattern: temporal invalidation, never delete)

CREATE TABLE facts (
  id                UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  thought_id        UUID NOT NULL REFERENCES thoughts(id) ON DELETE CASCADE,
  statement         TEXT NOT NULL,
  fact_type         TEXT NOT NULL DEFAULT 'claim',  -- claim, decision, constraint, event, capability, preference
  confidence        REAL NOT NULL DEFAULT 0.8,
  embedding         vector(768),
  subject_entity_id UUID REFERENCES entities(id) ON DELETE SET NULL,
  object_entity_id  UUID REFERENCES entities(id) ON DELETE SET NULL,
  valid_at          TIMESTAMPTZ,    -- when fact became true (event time)
  invalid_at        TIMESTAMPTZ,    -- when fact was superseded (set by contradiction detection)
  invalidated_by    UUID REFERENCES facts(id),  -- the fact that contradicted this one
  visibility        TEXT[] NOT NULL DEFAULT '{owner}',
  created_at        TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- HNSW index for fact-level semantic search
CREATE INDEX facts_embedding_idx ON facts
  USING hnsw ((embedding::halfvec(768)) halfvec_cosine_ops)
  WITH (m = 16, ef_construction = 64);

-- Lookup facts by thought
CREATE INDEX facts_thought_id_idx ON facts (thought_id);

-- Lookup facts by entity (subject or object)
CREATE INDEX facts_subject_entity_idx ON facts (subject_entity_id) WHERE subject_entity_id IS NOT NULL;
CREATE INDEX facts_object_entity_idx ON facts (object_entity_id) WHERE object_entity_id IS NOT NULL;

-- GIN index for visibility filtering (same pattern as thoughts)
CREATE INDEX facts_visibility_idx ON facts USING gin (visibility);

-- Full-text search on fact statements
ALTER TABLE facts ADD COLUMN search_vector tsvector
  GENERATED ALWAYS AS (to_tsvector('english', statement)) STORED;
CREATE INDEX facts_search_vector_idx ON facts USING gin (search_vector);
