-- HNSW index for fast cosine similarity search
CREATE INDEX thoughts_embedding_idx ON thoughts
  USING hnsw (embedding vector_cosine_ops)
  WITH (m = 16, ef_construction = 64);

-- GIN indexes for array containment queries
CREATE INDEX thoughts_people_idx ON thoughts USING gin (people);
CREATE INDEX thoughts_topics_idx ON thoughts USING gin (topics);
CREATE INDEX thoughts_visibility_idx ON thoughts USING gin (visibility);

-- B-tree indexes for filtering and ordering
CREATE INDEX thoughts_type_idx ON thoughts (thought_type);
CREATE INDEX thoughts_created_at_idx ON thoughts (created_at DESC);

-- Partial index for queue processing (only care about active items)
CREATE INDEX queue_status_idx ON queue (status)
  WHERE status IN ('pending', 'processing');

-- Unique partial index for dedup on source_id
CREATE UNIQUE INDEX thoughts_source_id_unique ON thoughts (source_id)
  WHERE source_id IS NOT NULL;
