-- Add tsvector column for full-text search (BM25-style ranking)
ALTER TABLE thoughts ADD COLUMN IF NOT EXISTS search_vector tsvector;

-- Trigger to auto-compute search_vector on INSERT or UPDATE of content
CREATE OR REPLACE FUNCTION thoughts_search_vector_update()
RETURNS trigger AS $$
BEGIN
  NEW.search_vector := to_tsvector('english', coalesce(NEW.content, ''));
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER thoughts_search_vector_trigger
  BEFORE INSERT OR UPDATE OF content ON thoughts
  FOR EACH ROW
  EXECUTE FUNCTION thoughts_search_vector_update();

-- GIN index for fast full-text queries
CREATE INDEX IF NOT EXISTS thoughts_search_vector_idx ON thoughts USING GIN (search_vector);

-- Backfill existing rows
UPDATE thoughts SET search_vector = to_tsvector('english', coalesce(content, ''));
