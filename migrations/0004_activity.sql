-- Live activity (current workload + phase) per migration user, written with
-- every stats flush so dashboards can show what each mailbox is doing.

ALTER TABLE migration_users ADD COLUMN activity TEXT;
