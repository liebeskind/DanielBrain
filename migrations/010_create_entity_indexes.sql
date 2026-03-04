-- Entity lookup indexes
CREATE INDEX entities_canonical_name_idx ON entities (canonical_name);
CREATE INDEX entities_type_idx ON entities (entity_type);
CREATE INDEX entities_aliases_idx ON entities USING gin (aliases);

-- HNSW index for entity-level semantic search
CREATE INDEX entities_embedding_idx ON entities
  USING hnsw (embedding vector_cosine_ops)
  WITH (m = 16, ef_construction = 64);

-- Thought-entity junction indexes
CREATE INDEX thought_entities_entity_id_idx ON thought_entities (entity_id);
CREATE INDEX thought_entities_thought_id_idx ON thought_entities (thought_id);

-- Entity relationship indexes
CREATE INDEX entity_relationships_source_idx ON entity_relationships (source_id);
CREATE INDEX entity_relationships_target_idx ON entity_relationships (target_id);

-- Entity ordering indexes
CREATE INDEX entities_last_seen_idx ON entities (last_seen_at DESC);
CREATE INDEX entities_mention_count_idx ON entities (mention_count DESC);
