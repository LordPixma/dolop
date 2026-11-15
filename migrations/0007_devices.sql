-- Device migration: inventory of the source tenant's devices per project,
-- each paired with the migration user who owns it, plus the state of the
-- on-device agent that moves a Windows device to the destination tenant
-- without wiping it.
--
-- source_key identifies a device across re-discoveries: the Entra device id
-- when there is one, otherwise "intune:<managed device id>" for Intune records
-- that have no Entra object.

CREATE TABLE devices (
  id TEXT PRIMARY KEY,
  project_id TEXT NOT NULL REFERENCES projects(id),
  source_key TEXT NOT NULL,
  name TEXT NOT NULL,
  entra_object_id TEXT,
  entra_device_id TEXT,
  intune_device_id TEXT,
  autopilot_id TEXT,
  os TEXT,
  os_version TEXT,
  trust_type TEXT,
  serial_number TEXT,
  model TEXT,
  owner_upn TEXT,
  -- migration_users.id of the device's user (no FK: removing a user from
  -- scope must not be blocked by a device row).
  user_id TEXT,
  last_activity_at TEXT,
  registered_at TEXT,
  -- 1 = a Windows LAPS password is backed up, 0 = none, NULL = unknown.
  laps_backed_up INTEGER,
  inventory TEXT NOT NULL DEFAULT '{}',
  plan TEXT NOT NULL DEFAULT 'migrate',
  plan_overridden INTEGER NOT NULL DEFAULT 0,
  status TEXT NOT NULL DEFAULT 'discovered',
  step TEXT,
  detail TEXT,
  -- SHA-256 of the per-device agent token (the token itself is never stored).
  agent_token_hash TEXT,
  agent_token_expires_at TEXT,
  agent_last_seen_at TEXT,
  agent_report TEXT,
  source_sid TEXT,
  dest_sid TEXT,
  -- AES-256-GCM encrypted JSON array of BitLocker recovery keys.
  bitlocker_enc TEXT,
  bitlocker_count INTEGER NOT NULL DEFAULT 0,
  bitlocker_backed_up_at TEXT,
  missing_since TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  UNIQUE (project_id, source_key)
);
CREATE INDEX idx_devices_project ON devices(project_id);
CREATE UNIQUE INDEX idx_devices_agent_token ON devices(agent_token_hash);

ALTER TABLE events ADD COLUMN device_id TEXT;
CREATE INDEX idx_events_device ON events(device_id, id);
