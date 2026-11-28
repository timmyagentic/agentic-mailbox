ALTER TABLE mailbox_relay ADD COLUMN listener_epoch INTEGER NOT NULL DEFAULT -1;
ALTER TABLE mailbox_relay ADD COLUMN listener_token TEXT;
ALTER TABLE mailbox_relay ADD COLUMN listener_until INTEGER NOT NULL DEFAULT 0;
ALTER TABLE mailbox_relay ADD COLUMN listener_mode TEXT;
