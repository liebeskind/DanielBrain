-- Optimize HNSW indexes: halfvec for 50% storage savings + ef_construction=128 for better recall

-- Recreate thoughts embedding index with halfvec and higher ef_construction
DROP INDEX IF EXISTS thoughts_embedding_idx;
CREATE INDEX thoughts_embedding_idx ON thoughts
  USING hnsw ((embedding::halfvec(768)) halfvec_cosine_ops)
  WITH (m = 16, ef_construction = 128);

-- Recreate entities embedding index with halfvec and higher ef_construction
DROP INDEX IF EXISTS entities_embedding_idx;
CREATE INDEX entities_embedding_idx ON entities
  USING hnsw ((embedding::halfvec(768)) halfvec_cosine_ops)
  WITH (m = 16, ef_construction = 128);
