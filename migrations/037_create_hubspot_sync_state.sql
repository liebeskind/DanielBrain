-- HubSpot sync state tracking (singleton row)
CREATE TABLE IF NOT EXISTS hubspot_sync_state (
  id              INTEGER PRIMARY KEY DEFAULT 1 CHECK (id = 1),
  last_synced_at  TIMESTAMPTZ,
  contacts_after  TEXT,    -- cursor for contacts pagination
  companies_after TEXT,
  deals_after     TEXT,
  updated_at      TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
