CREATE TABLE oauth_accounts (
  id TEXT PRIMARY KEY NOT NULL REFERENCES aliases(id) ON DELETE RESTRICT,
  provider TEXT NOT NULL CHECK (provider IN ('gmail', 'outlook')),
  subject TEXT NOT NULL,
  credential TEXT NOT NULL,
  cursor TEXT,
  last_sync_at TEXT,
  sync_id TEXT,
  sync_until INTEGER NOT NULL DEFAULT 0,
  UNIQUE (provider, subject)
);

CREATE TABLE oauth_flows (
  state TEXT PRIMARY KEY NOT NULL,
  provider TEXT NOT NULL,
  session_hash TEXT NOT NULL,
  verifier TEXT NOT NULL,
  account_id TEXT REFERENCES oauth_accounts(id),
  expires_at INTEGER NOT NULL
);

ALTER TABLE emails ADD COLUMN remote_thread_id TEXT;
