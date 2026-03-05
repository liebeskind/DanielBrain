-- Migration 012: Merge duplicate entities after normalization improvements
-- PREREQUISITE: pg_dump backup before running
-- Run AFTER deploying the updated entity-resolver.ts with improved normalization

BEGIN;

-- Step 1: Delete known junk entities
DELETE FROM thought_entities WHERE entity_id IN (
  SELECT id FROM entities WHERE
    -- Blocklist matches
    lower(trim(name)) IN (
      'you', 'me', 'we', 'they', 'i', 'he', 'she', 'it',
      'someone', 'everyone', 'anyone', 'nobody',
      'the speaker', 'not specified', 'unknown', 'n/a', 'none',
      'null', 'undefined', 'your_name', 'the team', 'attendees',
      'the audience', 'participants', 'the user', 'the host'
    )
    -- No alphabetic chars
    OR lower(trim(name)) !~ '[a-zA-Z]'
    -- Single character
    OR length(trim(name)) < 2
    -- Starts with article
    OR lower(trim(name)) ~ '^(a|an|the)\s+'
);

DELETE FROM entity_relationships WHERE source_id IN (
  SELECT id FROM entities WHERE
    lower(trim(name)) IN (
      'you', 'me', 'we', 'they', 'i', 'he', 'she', 'it',
      'someone', 'everyone', 'anyone', 'nobody',
      'the speaker', 'not specified', 'unknown', 'n/a', 'none',
      'null', 'undefined', 'your_name', 'the team', 'attendees',
      'the audience', 'participants', 'the user', 'the host'
    )
    OR lower(trim(name)) !~ '[a-zA-Z]'
    OR length(trim(name)) < 2
    OR lower(trim(name)) ~ '^(a|an|the)\s+'
) OR target_id IN (
  SELECT id FROM entities WHERE
    lower(trim(name)) IN (
      'you', 'me', 'we', 'they', 'i', 'he', 'she', 'it',
      'someone', 'everyone', 'anyone', 'nobody',
      'the speaker', 'not specified', 'unknown', 'n/a', 'none',
      'null', 'undefined', 'your_name', 'the team', 'attendees',
      'the audience', 'participants', 'the user', 'the host'
    )
    OR lower(trim(name)) !~ '[a-zA-Z]'
    OR length(trim(name)) < 2
    OR lower(trim(name)) ~ '^(a|an|the)\s+'
);

DELETE FROM entities WHERE
  lower(trim(name)) IN (
    'you', 'me', 'we', 'they', 'i', 'he', 'she', 'it',
    'someone', 'everyone', 'anyone', 'nobody',
    'the speaker', 'not specified', 'unknown', 'n/a', 'none',
    'null', 'undefined', 'your_name', 'the team', 'attendees',
    'the audience', 'participants', 'the user', 'the host'
  )
  OR lower(trim(name)) !~ '[a-zA-Z]'
  OR length(trim(name)) < 2
  OR lower(trim(name)) ~ '^(a|an|the)\s+';

-- Step 2a: Temporarily drop unique index so re-normalization doesn't fail on convergent names
DROP INDEX IF EXISTS entities_canonical_type_unique;

-- Step 2: Re-normalize all canonical_name values using the same transforms as updated normalizeName()
UPDATE entities SET canonical_name =
  trim(
    regexp_replace(
      regexp_replace(
        regexp_replace(
          regexp_replace(
            regexp_replace(
              regexp_replace(
                lower(trim(name)),
                '\s*\([^)]*\)\s*', ' ', 'g'   -- strip parentheticals
              ),
              '\s+', ' ', 'g'                   -- collapse spaces
            ),
            '^(mr\.?|mrs\.?|ms\.?|dr\.?|prof\.?)\s+', '', 'i'  -- strip name prefixes
          ),
          '\s+(inc\.?|llc\.?|ltd\.?|co\.?|corp\.?|gmbh|plc|s\.?a\.?)$', '', 'i'  -- strip company suffixes
        ),
        '\.(io|com|org|net|co|earth|ai|dev|app|xyz|tech)$', '', 'i'  -- strip domain suffixes
      ),
      '\s+(he/him(/his)?|she/her(/hers)?|they/them(/theirs)?|ze/hir|xe/xem)$', '', 'i'  -- strip pronoun suffixes
    )
  );

-- Step 3: Merge duplicates — for each group of same canonical_name + entity_type,
-- keep the one with highest mention_count, reassign links, merge aliases, delete others

-- Create temp table of survivors
CREATE TEMP TABLE entity_survivors AS
SELECT DISTINCT ON (canonical_name, entity_type)
  id AS survivor_id,
  canonical_name,
  entity_type
FROM entities
ORDER BY canonical_name, entity_type, mention_count DESC, created_at ASC;

-- Create temp table of losers (entities that will be merged into survivors)
CREATE TEMP TABLE entity_losers AS
SELECT e.id AS loser_id, s.survivor_id
FROM entities e
JOIN entity_survivors s ON e.canonical_name = s.canonical_name AND e.entity_type = s.entity_type
WHERE e.id != s.survivor_id;

-- Reassign thought_entities from losers to survivors
UPDATE thought_entities te
SET entity_id = el.survivor_id
FROM entity_losers el
WHERE te.entity_id = el.loser_id
  AND NOT EXISTS (
    SELECT 1 FROM thought_entities te2
    WHERE te2.thought_id = te.thought_id
      AND te2.entity_id = el.survivor_id
      AND te2.relationship = te.relationship
  );

-- Delete duplicate thought_entities that couldn't be reassigned (constraint conflicts)
DELETE FROM thought_entities te
USING entity_losers el
WHERE te.entity_id = el.loser_id;

-- Reassign entity_relationships
UPDATE entity_relationships er
SET source_id = el.survivor_id
FROM entity_losers el
WHERE er.source_id = el.loser_id;

UPDATE entity_relationships er
SET target_id = el.survivor_id
FROM entity_losers el
WHERE er.target_id = el.loser_id;

-- Merge aliases from losers into survivors
UPDATE entities survivor SET
  aliases = (
    SELECT array_agg(DISTINCT alias)
    FROM (
      SELECT unnest(survivor.aliases) AS alias
      UNION
      SELECT unnest(loser.aliases) AS alias
      FROM entities loser
      JOIN entity_losers el ON loser.id = el.loser_id
      WHERE el.survivor_id = survivor.id
    ) combined
  ),
  mention_count = survivor.mention_count + COALESCE((
    SELECT sum(loser.mention_count)
    FROM entities loser
    JOIN entity_losers el ON loser.id = el.loser_id
    WHERE el.survivor_id = survivor.id
  ), 0)
WHERE survivor.id IN (SELECT survivor_id FROM entity_losers);

-- Delete loser entities
DELETE FROM entities WHERE id IN (SELECT loser_id FROM entity_losers);

-- Step 4: Manual merges for known cases
-- Merge "damenlopez" into "damen lopez" (if both exist)
DO $$
DECLARE
  v_target_id UUID;
  v_source_id UUID;
BEGIN
  SELECT id INTO v_target_id FROM entities WHERE canonical_name = 'damen lopez' AND entity_type = 'person' LIMIT 1;
  SELECT id INTO v_source_id FROM entities WHERE canonical_name = 'damenlopez' AND entity_type = 'person' LIMIT 1;
  IF v_target_id IS NOT NULL AND v_source_id IS NOT NULL AND v_target_id != v_source_id THEN
    UPDATE thought_entities SET entity_id = v_target_id WHERE entity_id = v_source_id
      AND NOT EXISTS (SELECT 1 FROM thought_entities te2 WHERE te2.thought_id = thought_entities.thought_id AND te2.entity_id = v_target_id AND te2.relationship = thought_entities.relationship);
    DELETE FROM thought_entities WHERE entity_id = v_source_id;
    UPDATE entity_relationships SET source_id = v_target_id WHERE source_id = v_source_id;
    UPDATE entity_relationships SET target_id = v_target_id WHERE target_id = v_source_id;
    UPDATE entities SET
      mention_count = mention_count + (SELECT mention_count FROM entities WHERE id = v_source_id),
      aliases = array_append(aliases, 'damenlopez')
    WHERE id = v_target_id;
    DELETE FROM entities WHERE id = v_source_id;
  END IF;
END $$;

-- Step 4b: Re-add unique index after merging
CREATE UNIQUE INDEX entities_canonical_type_unique ON entities (canonical_name, entity_type);

-- Step 5: Invalidate all profiles so they regenerate with merged data
UPDATE entities SET profile_summary = NULL, embedding = NULL;

-- Cleanup temp tables
DROP TABLE IF EXISTS entity_losers;
DROP TABLE IF EXISTS entity_survivors;

COMMIT;
