CREATE OR REPLACE FUNCTION match_thoughts(
  query_embedding vector(768),
  match_threshold float DEFAULT 0.5,
  match_count int DEFAULT 10,
  filter_type text DEFAULT NULL,
  filter_person text DEFAULT NULL,
  filter_topic text DEFAULT NULL,
  filter_days_back int DEFAULT NULL
)
RETURNS TABLE (
  id uuid, content text, thought_type text, people text[], topics text[],
  action_items text[], dates_mentioned date[], summary text,
  similarity float, parent_id uuid, chunk_index integer,
  source text, created_at timestamptz
)
LANGUAGE plpgsql AS $$
BEGIN
  RETURN QUERY
  SELECT
    t.id, t.content, t.thought_type, t.people, t.topics,
    t.action_items, t.dates_mentioned, t.summary,
    (1 - (t.embedding <=> query_embedding))::float AS similarity,
    t.parent_id, t.chunk_index, t.source, t.created_at
  FROM thoughts t
  WHERE t.embedding IS NOT NULL
    AND (1 - (t.embedding <=> query_embedding)) >= match_threshold
    AND (filter_type IS NULL OR t.thought_type = filter_type)
    AND (filter_person IS NULL OR filter_person = ANY(t.people))
    AND (filter_topic IS NULL OR filter_topic = ANY(t.topics))
    AND (filter_days_back IS NULL OR t.created_at >= NOW() - (filter_days_back || ' days')::interval)
  ORDER BY t.embedding <=> query_embedding
  LIMIT match_count;
END;
$$;
