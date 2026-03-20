-- Phase 8.5: Fix missing indexes and add ON DELETE CASCADE for parent_id

-- M12: Index on thoughts.parent_id for chunk lookups
CREATE INDEX IF NOT EXISTS idx_thoughts_parent_id ON thoughts(parent_id) WHERE parent_id IS NOT NULL;

-- M13: Index on queue.thought_id for queue-to-thought joins
CREATE INDEX IF NOT EXISTS idx_queue_thought_id ON queue(thought_id) WHERE thought_id IS NOT NULL;

-- M9: Add ON DELETE CASCADE on thoughts.parent_id
-- When a parent thought is deleted, child chunks should be deleted too
ALTER TABLE thoughts DROP CONSTRAINT IF EXISTS thoughts_parent_id_fkey;
ALTER TABLE thoughts ADD CONSTRAINT thoughts_parent_id_fkey
  FOREIGN KEY (parent_id) REFERENCES thoughts(id) ON DELETE CASCADE;
