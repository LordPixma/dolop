-- Admin-consent connector mode: connectors can either hold per-tenant app
-- credentials ('secret') or bind a tenant to the deployment's own multi-tenant
-- app via the Entra admin consent flow ('consent').

ALTER TABLE connectors ADD COLUMN auth_mode TEXT NOT NULL DEFAULT 'secret';
