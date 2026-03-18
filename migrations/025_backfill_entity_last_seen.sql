UPDATE entities SET last_seen_at = sub.max_date
FROM (
  SELECT te.entity_id, MAX(t.created_at) as max_date
  FROM thought_entities te
  JOIN thoughts t ON t.id = te.thought_id
  GROUP BY te.entity_id
) sub
WHERE entities.id = sub.entity_id;
