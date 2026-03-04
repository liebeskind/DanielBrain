CREATE OR REPLACE FUNCTION find_entity_by_name(
  p_name TEXT,
  p_type entity_type DEFAULT NULL
)
RETURNS TABLE (
  id UUID,
  name TEXT,
  entity_type entity_type,
  match_type TEXT
) AS $$
BEGIN
  -- Try exact canonical match first
  RETURN QUERY
    SELECT e.id, e.name, e.entity_type, 'canonical'::TEXT AS match_type
    FROM entities e
    WHERE e.canonical_name = lower(trim(p_name))
      AND (p_type IS NULL OR e.entity_type = p_type)
    LIMIT 1;

  IF FOUND THEN RETURN; END IF;

  -- Try alias match
  RETURN QUERY
    SELECT e.id, e.name, e.entity_type, 'alias'::TEXT AS match_type
    FROM entities e
    WHERE lower(trim(p_name)) = ANY(e.aliases)
      AND (p_type IS NULL OR e.entity_type = p_type)
    LIMIT 1;
END;
$$ LANGUAGE plpgsql;
