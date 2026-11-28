-- Provisioned by the operator after authorizing the sending domain at the mail provider.
-- The stable inbound relay is independent of this outbound address.
ALTER TABLE forwarding_settings ADD COLUMN sender_address TEXT;
