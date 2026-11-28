-- Existing aliases, account identities, messages and attachments remain intact.
CREATE TABLE forwarding_settings (
  owner TEXT PRIMARY KEY NOT NULL,
  relay TEXT NOT NULL UNIQUE COLLATE NOCASE,
  destination TEXT,
  pending TEXT,
  pending_id TEXT,
  code_hash TEXT,
  code_sent_at INTEGER
);
