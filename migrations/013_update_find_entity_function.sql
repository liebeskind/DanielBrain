-- Migration 013: Update find_entity_by_name() to use improved normalization
-- Aligns SQL function normalization with app code in entity-resolver.ts

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
DECLARE
  v_normalized TEXT;
BEGIN
  -- Normalize using same transforms as app code normalizeName()
  v_normalized := trim(
    regexp_replace(
      regexp_replace(
        regexp_replace(
          regexp_replace(
            regexp_replace(
              regexp_replace(
                lower(trim(p_name)),
                '\s*\([^)]*\)\s*', ' ', 'g'
              ),
              '\s+', ' ', 'g'
            ),
            '^(mr\.?|mrs\.?|ms\.?|dr\.?|prof\.?)\s+', '', 'i'
          ),
          '\s+(inc\.?|llc\.?|ltd\.?|co\.?|corp\.?|gmbh|plc|s\.?a\.?)$', '', 'i'
        ),
        '\.(io|com|org|net|co|earth|ai|dev|app|xyz|tech)$', '', 'i'
      ),
      '\s+(he/him(/his)?|she/her(/hers)?|they/them(/theirs)?|ze/hir|xe/xem)$', '', 'i'
    )
  );

  -- Try exact canonical match first
  RETURN QUERY
    SELECT e.id, e.name, e.entity_type, 'canonical'::TEXT AS match_type
    FROM entities e
    WHERE e.canonical_name = v_normalized
      AND (p_type IS NULL OR e.entity_type = p_type)
    LIMIT 1;

  IF FOUND THEN RETURN; END IF;

  -- Try alias match
  RETURN QUERY
    SELECT e.id, e.name, e.entity_type, 'alias'::TEXT AS match_type
    FROM entities e
    WHERE v_normalized = ANY(e.aliases)
      AND (p_type IS NULL OR e.entity_type = p_type)
    LIMIT 1;

  IF FOUND THEN RETURN; END IF;

  -- Try first-name prefix match (person type only, single word)
  IF v_normalized !~ '\s' AND (p_type IS NULL OR p_type = 'person') THEN
    RETURN QUERY
      SELECT e.id, e.name, e.entity_type, 'prefix'::TEXT AS match_type
      FROM entities e
      WHERE e.canonical_name LIKE v_normalized || ' %'
        AND e.entity_type = 'person'
      ORDER BY e.mention_count DESC
      LIMIT 1;
  END IF;
END;
$$ LANGUAGE plpgsql;
