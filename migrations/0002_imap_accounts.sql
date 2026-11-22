-- The address row lets connected inboxes share the existing mail and attachment
-- storage. routing_mode = 'external' keeps them outside Email Routing.
CREATE TABLE imap_accounts (
  id TEXT PRIMARY KEY NOT NULL REFERENCES aliases(id) ON DELETE RESTRICT,
  provider TEXT NOT NULL CHECK (provider IN ('qq', 'netease163')),
  credential TEXT NOT NULL,
  uid_validity TEXT,
  last_uid INTEGER NOT NULL DEFAULT 0 CHECK (last_uid >= 0),
  last_sync_at TEXT,
  sync_id TEXT,
  sync_until INTEGER NOT NULL DEFAULT 0
);

ALTER TABLE emails ADD COLUMN imap_identity TEXT;
CREATE UNIQUE INDEX idx_emails_imap_identity ON emails(alias_id, imap_identity)
  WHERE imap_identity IS NOT NULL;
