ALTER TABLE queue ADD COLUMN originated_at TIMESTAMPTZ;
ALTER TABLE queue ADD COLUMN content_hash TEXT;
CREATE INDEX queue_content_hash_idx ON queue (content_hash) WHERE content_hash IS NOT NULL;
