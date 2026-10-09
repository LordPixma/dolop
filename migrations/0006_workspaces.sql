-- Workspaces: isolated tenancy so new users can register and run their own
-- migrations. Every operator account, connector and project belongs to exactly
-- one workspace, and operators only ever see their own workspace's data.
-- Migration users, item errors and events are scoped through their project.

CREATE TABLE workspaces (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

-- Nullable on purpose: a row that somehow lacks a workspace matches no
-- workspace-scoped query (fail closed) instead of defaulting into one.
ALTER TABLE accounts ADD COLUMN workspace_id TEXT REFERENCES workspaces(id);
ALTER TABLE connectors ADD COLUMN workspace_id TEXT REFERENCES workspaces(id);
ALTER TABLE projects ADD COLUMN workspace_id TEXT REFERENCES workspaces(id);
CREATE INDEX idx_accounts_workspace ON accounts(workspace_id);
CREATE INDEX idx_connectors_workspace ON connectors(workspace_id);
CREATE INDEX idx_projects_workspace ON projects(workspace_id);
CREATE INDEX idx_connectors_tenant ON connectors(tenant_id);

-- Existing deployments: everything created before workspaces existed belongs
-- to the deployment's original team, so it all moves into one default
-- workspace. Fresh installs get their first workspace at first-run setup.
INSERT INTO workspaces (id, name, created_at, updated_at)
SELECT 'ws_default', 'Default workspace',
       strftime('%Y-%m-%dT%H:%M:%fZ', 'now'), strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
WHERE EXISTS (SELECT 1 FROM accounts)
   OR EXISTS (SELECT 1 FROM connectors)
   OR EXISTS (SELECT 1 FROM projects);

UPDATE accounts SET workspace_id = 'ws_default' WHERE workspace_id IS NULL;
UPDATE connectors SET workspace_id = 'ws_default' WHERE workspace_id IS NULL;
UPDATE projects SET workspace_id = 'ws_default' WHERE workspace_id IS NULL;

-- Team invites: single-use, expiring links that let a new operator register
-- straight into an existing workspace. id holds the SHA-256 of the token,
-- never the token itself.
CREATE TABLE invites (
  id TEXT PRIMARY KEY,
  workspace_id TEXT NOT NULL REFERENCES workspaces(id),
  created_by TEXT,
  note TEXT,
  created_at TEXT NOT NULL,
  expires_at TEXT NOT NULL,
  used_at TEXT,
  used_by TEXT
);
CREATE INDEX idx_invites_workspace ON invites(workspace_id);
