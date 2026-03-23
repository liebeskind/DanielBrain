-- Functional indexes for multi-signal entity resolution (LinkedIn URL + email matching)

-- LinkedIn URL index — most stable person identifier
CREATE INDEX IF NOT EXISTS entities_linkedin_idx
  ON entities ((metadata->>'linkedin_url'))
  WHERE metadata->>'linkedin_url' IS NOT NULL;

-- Email array index — supports both legacy single-email and new array format
-- Uses GIN for the jsonb array containment operator (?)
CREATE INDEX IF NOT EXISTS entities_emails_gin_idx
  ON entities USING GIN ((metadata->'emails'))
  WHERE metadata->'emails' IS NOT NULL;

-- Legacy single-email index for backward compatibility during migration
CREATE INDEX IF NOT EXISTS entities_email_idx
  ON entities ((metadata->>'email'))
  WHERE metadata->>'email' IS NOT NULL;
