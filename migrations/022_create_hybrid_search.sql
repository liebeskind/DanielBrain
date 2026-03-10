-- Replace match_thoughts() with hybrid_search() combining vector + BM25 via RRF
CREATE OR REPLACE FUNCTION hybrid_search(
  query_embedding vector(768),
  query_text text,
  match_threshold float DEFAULT 0.5,
  match_count int DEFAULT 10,
  filter_type text DEFAULT NULL,
  filter_person text DEFAULT NULL,
  filter_topic text DEFAULT NULL,
  filter_days_back int DEFAULT NULL,
  rrf_k int DEFAULT 60,
  vector_weight float DEFAULT 1.0,
  bm25_weight float DEFAULT 1.0
)
RETURNS TABLE (
  id uuid, content text, thought_type text, people text[], topics text[],
  action_items text[], dates_mentioned date[], summary text,
  similarity float, parent_id uuid, chunk_index integer,
  source text, created_at timestamptz
)
LANGUAGE plpgsql AS $$
DECLARE
  oversample int := match_count * 3;
  ts_query tsquery;
BEGIN
  -- Parse query text safely; returns NULL for empty/stop-word-only input
  ts_query := plainto_tsquery('english', coalesce(query_text, ''));

  RETURN QUERY
  WITH vector_results AS (
    SELECT
      t.id AS thought_id,
      ROW_NUMBER() OVER (ORDER BY t.embedding::halfvec(768) <=> query_embedding::halfvec(768)) AS rank
    FROM thoughts t
    WHERE t.embedding IS NOT NULL
      AND (1 - (t.embedding::halfvec(768) <=> query_embedding::halfvec(768))) >= match_threshold
      AND (filter_type IS NULL OR t.thought_type = filter_type)
      AND (filter_person IS NULL OR filter_person = ANY(t.people))
      AND (filter_topic IS NULL OR filter_topic = ANY(t.topics))
      AND (filter_days_back IS NULL OR t.created_at >= NOW() - (filter_days_back || ' days')::interval)
    ORDER BY t.embedding::halfvec(768) <=> query_embedding::halfvec(768)
    LIMIT oversample
  ),
  bm25_results AS (
    SELECT
      t.id AS thought_id,
      ROW_NUMBER() OVER (ORDER BY ts_rank_cd(t.search_vector, ts_query) DESC) AS rank
    FROM thoughts t
    WHERE ts_query IS NOT NULL
      AND ts_query != ''::tsquery
      AND t.search_vector @@ ts_query
      AND (filter_type IS NULL OR t.thought_type = filter_type)
      AND (filter_person IS NULL OR filter_person = ANY(t.people))
      AND (filter_topic IS NULL OR filter_topic = ANY(t.topics))
      AND (filter_days_back IS NULL OR t.created_at >= NOW() - (filter_days_back || ' days')::interval)
    ORDER BY ts_rank_cd(t.search_vector, ts_query) DESC
    LIMIT oversample
  ),
  rrf_scores AS (
    SELECT
      COALESCE(v.thought_id, b.thought_id) AS thought_id,
      COALESCE(vector_weight / (rrf_k + v.rank), 0) +
      COALESCE(bm25_weight / (rrf_k + b.rank), 0) AS score
    FROM vector_results v
    FULL OUTER JOIN bm25_results b ON v.thought_id = b.thought_id
  )
  SELECT
    t.id, t.content, t.thought_type, t.people, t.topics,
    t.action_items, t.dates_mentioned, t.summary,
    r.score::float AS similarity,
    t.parent_id, t.chunk_index, t.source, t.created_at
  FROM rrf_scores r
  JOIN thoughts t ON t.id = r.thought_id
  ORDER BY r.score DESC
  LIMIT match_count;
END;
$$;
