-- Mail coexistence (dual-delivery via managed forwarding rules). Each in-scope
-- mailbox can have a single Dolop-managed inbox rule that forwards a copy of
-- incoming mail to the user's counterpart mailbox in the other tenant, so mail
-- addressed to one tenant is received in both during and after the migration.
--
-- Direction is one-way per user at any time ('src_to_dest' before cutover,
-- 'dest_to_src' after) which structurally prevents forwarding loops. The rule
-- id is stored so the rule can be torn down cleanly on switch/disable.

ALTER TABLE migration_users ADD COLUMN coexistence_status TEXT NOT NULL DEFAULT 'off';
ALTER TABLE migration_users ADD COLUMN coexistence_direction TEXT;
ALTER TABLE migration_users ADD COLUMN coexistence_rule_id TEXT;
ALTER TABLE migration_users ADD COLUMN coexistence_forward_address TEXT;
ALTER TABLE migration_users ADD COLUMN coexistence_detail TEXT;
ALTER TABLE migration_users ADD COLUMN coexistence_updated_at TEXT;
