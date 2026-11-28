CREATE TABLE mailbox_relay (
  slot TEXT PRIMARY KEY CHECK (slot IN ('pending', 'active')),
  generation TEXT NOT NULL,
  source_key TEXT NOT NULL,
  profile TEXT NOT NULL,
  credential TEXT NOT NULL,
  uid_validity TEXT NOT NULL,
  last_uid INTEGER NOT NULL,
  confirmation TEXT,
  expires_at INTEGER,
  lock_id TEXT,
  lock_until INTEGER NOT NULL DEFAULT 0,
  in_flight INTEGER,
  problem TEXT,
  checked_at INTEGER,
  sent_at INTEGER
);
