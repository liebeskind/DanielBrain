-- Phase 9a: Link access keys, thoughts, conversations, and projects to users
ALTER TABLE access_keys ADD COLUMN IF NOT EXISTS user_id UUID REFERENCES users(id);
ALTER TABLE thoughts ADD COLUMN IF NOT EXISTS owner_id UUID REFERENCES users(id);
ALTER TABLE conversations ADD COLUMN IF NOT EXISTS user_id UUID REFERENCES users(id);
ALTER TABLE projects ADD COLUMN IF NOT EXISTS user_id UUID REFERENCES users(id);

CREATE INDEX IF NOT EXISTS idx_access_keys_user ON access_keys(user_id) WHERE active = true;
CREATE INDEX IF NOT EXISTS idx_thoughts_owner ON thoughts(owner_id);
CREATE INDEX IF NOT EXISTS idx_conversations_user ON conversations(user_id, is_deleted, updated_at DESC);
CREATE INDEX IF NOT EXISTS idx_projects_user ON projects(user_id, is_deleted);
