CREATE TABLE local_imap_accounts (
  id TEXT PRIMARY KEY NOT NULL REFERENCES aliases(id) ON DELETE RESTRICT,
  provider TEXT NOT NULL CHECK (provider IN ('qq', 'netease163', 'gmail_app')),
  credential TEXT NOT NULL,
  uid_validity TEXT,
  last_uid INTEGER NOT NULL DEFAULT 0 CHECK (last_uid >= 0),
  last_sync_at TEXT,
  sync_id TEXT,
  sync_until INTEGER NOT NULL DEFAULT 0
);

INSERT INTO local_imap_accounts SELECT * FROM imap_accounts;
DROP TABLE imap_accounts;
ALTER TABLE local_imap_accounts RENAME TO imap_accounts;
