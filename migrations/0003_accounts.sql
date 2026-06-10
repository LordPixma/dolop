-- Operator accounts and server-side sessions for username/password login.

CREATE TABLE accounts (
  id TEXT PRIMARY KEY,
  username TEXT NOT NULL UNIQUE COLLATE NOCASE,
  display_name TEXT,
  password_hash TEXT NOT NULL,
  role TEXT NOT NULL DEFAULT 'admin',
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  last_login_at TEXT
);

-- sessions.id holds the SHA-256 of the cookie token, never the token itself.
CREATE TABLE sessions (
  id TEXT PRIMARY KEY,
  account_id TEXT NOT NULL REFERENCES accounts(id),
  created_at TEXT NOT NULL,
  expires_at TEXT NOT NULL,
  user_agent TEXT
);
CREATE INDEX idx_sessions_account ON sessions(account_id);
CREATE INDEX idx_sessions_expiry ON sessions(expires_at);
