// Shared helpers for API routes. Every lookup of a client-supplied project or
// connector id goes through loadProject/loadConnector, which enforce that the
// object belongs to the caller's workspace (a miss is a 404, so ids from other
// workspaces are indistinguishable from ids that don't exist).

import { decryptSecret } from '../crypto';
import { getConnector, getProject } from '../db';
import { GraphClient, type GraphCredentials } from '../graph/client';
import type { Connector, Env, Project, ProjectSettings, Workload } from '../types';
import { ALL_WORKLOADS } from '../types';
import { clamp } from '../util';

export class ApiError extends Error {
  constructor(public status: 400 | 401 | 403 | 404 | 409 | 422 | 429, message: string) {
    super(message);
    this.name = 'ApiError';
  }
}

export async function loadProject(env: Env, workspaceId: string, projectId: string): Promise<Project> {
  const project = await getProject(env.DB, projectId);
  if (!project || project.workspaceId !== workspaceId) throw new ApiError(404, 'project not found');
  return project;
}

export async function loadConnector(
  env: Env,
  workspaceId: string,
  connectorId: string
): Promise<Connector & { clientSecretEnc: string }> {
  const connector = await getConnector(env.DB, connectorId);
  if (!connector || connector.workspaceId !== workspaceId) throw new ApiError(404, 'connector not found');
  return connector;
}

/**
 * Validate project settings from a request body: drop unknown keys and clamp
 * numbers, so one workspace cannot e.g. claim thousands of concurrent slots.
 */
export function sanitizeSettings(input: unknown): Partial<ProjectSettings> {
  if (!input || typeof input !== 'object') return {};
  const raw = input as Record<string, unknown>;
  const out: Partial<ProjectSettings> = {};
  if (typeof raw.maxConcurrentUsers === 'number' && Number.isFinite(raw.maxConcurrentUsers)) {
    out.maxConcurrentUsers = clamp(Math.floor(raw.maxConcurrentUsers), 1, 100);
  }
  if (Array.isArray(raw.defaultWorkloads)) {
    out.defaultWorkloads = raw.defaultWorkloads.filter((w): w is Workload =>
      (ALL_WORKLOADS as unknown[]).includes(w)
    );
  }
  if (typeof raw.autoDeltaEnabled === 'boolean') out.autoDeltaEnabled = raw.autoDeltaEnabled;
  if (typeof raw.autoDeltaIntervalMinutes === 'number' && Number.isFinite(raw.autoDeltaIntervalMinutes)) {
    out.autoDeltaIntervalMinutes = clamp(Math.floor(raw.autoDeltaIntervalMinutes), 30, 60 * 24 * 30);
  }
  if (typeof raw.notes === 'string') out.notes = raw.notes.slice(0, 4000);
  return out;
}

/** Resolve Graph credentials for a connector based on its auth mode. */
export async function credsForConnector(
  env: Env,
  connector: Connector & { clientSecretEnc: string }
): Promise<GraphCredentials> {
  if (connector.authMode === 'consent') {
    if (!env.MT_CLIENT_ID || !env.MT_CLIENT_SECRET) {
      throw new ApiError(
        422,
        'consent-mode connector but MT_CLIENT_ID/MT_CLIENT_SECRET secrets are not configured'
      );
    }
    if (!connector.tenantId) {
      throw new ApiError(422, 'tenant has not granted consent yet — send the admin consent link first');
    }
    return {
      tenantId: connector.tenantId,
      clientId: env.MT_CLIENT_ID,
      clientSecret: env.MT_CLIENT_SECRET,
    };
  }
  try {
    return {
      tenantId: connector.tenantId,
      clientId: connector.clientId,
      clientSecret: await decryptSecret(connector.clientSecretEnc, env.ENCRYPTION_KEY),
    };
  } catch {
    throw new ApiError(
      422,
      `could not decrypt the stored client secret for connector "${connector.name}" — the ` +
        'ENCRYPTION_KEY secret has changed since it was saved (e.g. a CI deploy synced a ' +
        'different DOLOP_ENCRYPTION_KEY). Re-enter the client secret (Connectors → Rotate ' +
        'secret), then Verify.'
    );
  }
}

export async function graphForConnector(
  env: Env,
  project: Project,
  role: 'source' | 'destination'
): Promise<{ client: GraphClient; connector: Connector & { clientSecretEnc: string } }> {
  const connectorId = role === 'source' ? project.sourceConnectorId : project.destConnectorId;
  if (!connectorId) throw new ApiError(400, `project has no ${role} connector configured`);
  const connector = await getConnector(env.DB, connectorId);
  if (!connector || connector.workspaceId !== project.workspaceId) {
    throw new ApiError(404, `${role} connector not found`);
  }
  return {
    client: new GraphClient(await credsForConnector(env, connector), env.KV),
    connector,
  };
}

/** Generate a strong temporary password for provisioned users. */
export function generatePassword(): string {
  const lower = 'abcdefghjkmnpqrstuvwxyz';
  const upper = 'ABCDEFGHJKMNPQRSTUVWXYZ';
  const digits = '23456789';
  const symbols = '!@#$%^&*-_+=';
  const all = lower + upper + digits + symbols;
  const pick = (set: string) => {
    const idx = new Uint8Array(1);
    crypto.getRandomValues(idx);
    return set[(idx[0] ?? 0) % set.length] ?? set[0]!;
  };
  let pw = pick(lower) + pick(upper) + pick(digits) + pick(symbols);
  for (let i = 0; i < 12; i++) pw += pick(all);
  return pw;
}
