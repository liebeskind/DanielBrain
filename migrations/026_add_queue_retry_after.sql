-- Add retry_after column for exponential backoff on transient failures
ALTER TABLE queue ADD COLUMN retry_after TIMESTAMPTZ;

-- Partial index for efficient polling: pending items that are in backoff
CREATE INDEX idx_queue_retry_after ON queue (retry_after)
  WHERE status = 'pending' AND retry_after IS NOT NULL;
