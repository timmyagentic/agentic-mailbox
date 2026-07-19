PRAGMA foreign_keys = ON;

CREATE TABLE aliases (
  id TEXT PRIMARY KEY,
  local_part TEXT NOT NULL,
  domain TEXT NOT NULL,
  address TEXT NOT NULL COLLATE NOCASE UNIQUE,
  label TEXT NOT NULL DEFAULT '',
  status TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'disabled')),
  routing_mode TEXT NOT NULL DEFAULT 'managed' CHECK (routing_mode IN ('managed', 'external')),
  note TEXT NOT NULL DEFAULT '',
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  last_received_at TEXT,
  message_count INTEGER NOT NULL DEFAULT 0 CHECK (message_count >= 0)
);

CREATE INDEX idx_aliases_status_created ON aliases(status, created_at DESC);
CREATE INDEX idx_aliases_last_received ON aliases(last_received_at DESC);

CREATE TABLE emails (
  id TEXT PRIMARY KEY,
  alias_id TEXT NOT NULL REFERENCES aliases(id) ON DELETE RESTRICT,
  message_id TEXT NOT NULL DEFAULT '',
  from_address TEXT NOT NULL,
  from_name TEXT NOT NULL DEFAULT '',
  to_address TEXT NOT NULL,
  subject TEXT NOT NULL DEFAULT '(无主题)',
  preview TEXT NOT NULL DEFAULT '',
  body_text TEXT NOT NULL DEFAULT '',
  body_html TEXT NOT NULL DEFAULT '',
  received_at TEXT NOT NULL,
  sent_at TEXT,
  raw_size INTEGER NOT NULL DEFAULT 0 CHECK (raw_size >= 0),
  read_at TEXT,
  attachment_count INTEGER NOT NULL DEFAULT 0 CHECK (attachment_count >= 0),
  headers_json TEXT NOT NULL DEFAULT '{}'
);

CREATE UNIQUE INDEX idx_emails_alias_message_id
  ON emails(alias_id, message_id)
  WHERE message_id <> '';
CREATE INDEX idx_emails_received ON emails(received_at DESC, id DESC);
CREATE INDEX idx_emails_alias_received ON emails(alias_id, received_at DESC);
CREATE INDEX idx_emails_unread_received ON emails(read_at, received_at DESC);

CREATE TABLE attachments (
  id TEXT PRIMARY KEY,
  email_id TEXT NOT NULL REFERENCES emails(id) ON DELETE CASCADE,
  alias_id TEXT NOT NULL REFERENCES aliases(id) ON DELETE RESTRICT,
  filename TEXT NOT NULL,
  content_type TEXT NOT NULL DEFAULT 'application/octet-stream',
  size INTEGER NOT NULL CHECK (size >= 0),
  content_id TEXT NOT NULL DEFAULT '',
  disposition TEXT NOT NULL DEFAULT 'attachment',
  r2_key TEXT NOT NULL UNIQUE,
  created_at TEXT NOT NULL
);

CREATE INDEX idx_attachments_email ON attachments(email_id);
CREATE INDEX idx_attachments_created ON attachments(created_at DESC, id DESC);
CREATE INDEX idx_attachments_alias ON attachments(alias_id, created_at DESC);
