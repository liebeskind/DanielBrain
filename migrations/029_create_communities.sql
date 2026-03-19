-- Communities table for storing detected community clusters
CREATE TABLE communities (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  level INTEGER NOT NULL DEFAULT 0,
  title TEXT,
  summary TEXT,
  full_report TEXT,
  embedding vector(768),
  member_count INTEGER NOT NULL DEFAULT 0,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- Entity-to-community junction table
CREATE TABLE entity_communities (
  entity_id UUID NOT NULL REFERENCES entities(id) ON DELETE CASCADE,
  community_id UUID NOT NULL REFERENCES communities(id) ON DELETE CASCADE,
  level INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (entity_id, community_id)
);

CREATE INDEX idx_communities_level ON communities(level);
CREATE INDEX idx_communities_embedding ON communities
  USING hnsw ((embedding::halfvec(768)) halfvec_cosine_ops);
CREATE INDEX idx_entity_communities_community ON entity_communities(community_id);

-- Trigger for updated_at
CREATE TRIGGER update_communities_updated_at
  BEFORE UPDATE ON communities
  FOR EACH ROW EXECUTE FUNCTION update_updated_at();
