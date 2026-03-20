-- Phase 9b: GIN index on visibility for efficient array overlap filtering
CREATE INDEX IF NOT EXISTS idx_thoughts_visibility ON thoughts USING GIN (visibility);
