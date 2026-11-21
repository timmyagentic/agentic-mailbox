ALTER TABLE emails ADD COLUMN thread_key TEXT NOT NULL DEFAULT '';
ALTER TABLE emails ADD COLUMN folder TEXT NOT NULL DEFAULT 'inbox'
  CHECK (folder IN ('inbox', 'sent', 'archive', 'trash'));
ALTER TABLE emails ADD COLUMN starred INTEGER NOT NULL DEFAULT 0 CHECK (starred IN (0, 1));
ALTER TABLE emails ADD COLUMN outgoing INTEGER NOT NULL DEFAULT 0 CHECK (outgoing IN (0, 1));

WITH old_refs AS (
  SELECT id, COALESCE(
    NULLIF(json_extract(headers_json, '$.references'), ''),
    NULLIF(json_extract(headers_json, '$."in-reply-to"'), ''),
    NULLIF(message_id, ''), ''
  ) AS refs
  FROM emails WHERE json_valid(headers_json)
)
UPDATE emails
SET thread_key = COALESCE(
  (SELECT CASE
    WHEN instr(refs, '<') > 0 AND instr(substr(refs, instr(refs, '<') + 1), '>') > 1
      THEN 'mid:' || substr(refs, instr(refs, '<') + 1, instr(substr(refs, instr(refs, '<') + 1), '>') - 1)
    WHEN refs LIKE '%@%' AND length(refs) <= 498 AND instr(refs, ' ') = 0
      THEN 'mid:' || refs
    ELSE NULL END FROM old_refs WHERE old_refs.id = emails.id),
  'local:' || id
);

DROP INDEX idx_emails_alias_message_id;
CREATE UNIQUE INDEX idx_emails_alias_message_id ON emails(alias_id, message_id)
  WHERE message_id <> '' AND outgoing = 0;

CREATE INDEX idx_emails_thread ON emails(alias_id, thread_key, received_at DESC, id DESC);
CREATE INDEX idx_emails_folder_received ON emails(folder, received_at DESC, id DESC);

CREATE TABLE drafts (
  id TEXT PRIMARY KEY NOT NULL,
  alias_id TEXT NOT NULL REFERENCES aliases(id) ON DELETE RESTRICT,
  mode TEXT NOT NULL CHECK (mode IN ('new', 'reply', 'forward')),
  source_email_id TEXT REFERENCES emails(id) ON DELETE RESTRICT,
  recipients_json TEXT NOT NULL,
  subject TEXT NOT NULL DEFAULT '',
  body_text TEXT NOT NULL DEFAULT '',
  body_html TEXT NOT NULL DEFAULT '',
  include_original_files INTEGER NOT NULL DEFAULT 0 CHECK (include_original_files IN (0, 1)),
  revision INTEGER NOT NULL DEFAULT 1,
  status TEXT NOT NULL DEFAULT 'draft' CHECK (status IN ('draft', 'sending', 'uncertain', 'sent')),
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE INDEX idx_drafts_status_updated ON drafts(status, updated_at DESC);

CREATE TABLE draft_files (
  id TEXT PRIMARY KEY NOT NULL,
  draft_id TEXT NOT NULL REFERENCES drafts(id) ON DELETE CASCADE,
  filename TEXT NOT NULL,
  content_type TEXT NOT NULL,
  size INTEGER NOT NULL CHECK (size > 0),
  r2_key TEXT NOT NULL UNIQUE,
  created_at TEXT NOT NULL
);

CREATE INDEX idx_draft_files_draft ON draft_files(draft_id, created_at, id);
