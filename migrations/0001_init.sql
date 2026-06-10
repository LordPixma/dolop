-- Dolop initial schema.

CREATE TABLE connectors (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  tenant_id TEXT NOT NULL,
  client_id TEXT NOT NULL,
  client_secret_enc TEXT NOT NULL,
  verify_status TEXT NOT NULL DEFAULT 'unverified',
  verify_detail TEXT,
  last_verified_at TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE TABLE projects (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  description TEXT,
  source_connector_id TEXT REFERENCES connectors(id),
  dest_connector_id TEXT REFERENCES connectors(id),
  settings TEXT NOT NULL DEFAULT '{}',
  status TEXT NOT NULL DEFAULT 'active',
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE TABLE migration_users (
  id TEXT PRIMARY KEY,
  project_id TEXT NOT NULL REFERENCES projects(id),
  source_upn TEXT NOT NULL,
  dest_upn TEXT NOT NULL,
  source_id TEXT,
  dest_id TEXT,
  display_name TEXT,
  status TEXT NOT NULL DEFAULT 'pending',
  pass_type TEXT,
  pass_config TEXT,
  stats TEXT NOT NULL DEFAULT '{}',
  error TEXT,
  heartbeat_at TEXT,
  started_at TEXT,
  completed_at TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  UNIQUE (project_id, source_upn)
);
CREATE INDEX idx_users_project ON migration_users(project_id, status);

CREATE TABLE item_errors (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  project_id TEXT NOT NULL,
  user_id TEXT NOT NULL,
  workload TEXT NOT NULL,
  item_type TEXT,
  item_id TEXT,
  item_name TEXT,
  code TEXT,
  message TEXT,
  created_at TEXT NOT NULL
);
CREATE INDEX idx_errors_project ON item_errors(project_id, id);
CREATE INDEX idx_errors_user ON item_errors(user_id, id);

CREATE TABLE events (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  project_id TEXT,
  user_id TEXT,
  level TEXT NOT NULL DEFAULT 'info',
  message TEXT NOT NULL,
  data TEXT,
  created_at TEXT NOT NULL
);
CREATE INDEX idx_events_project ON events(project_id, id);
