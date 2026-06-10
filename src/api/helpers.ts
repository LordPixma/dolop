// Shared helpers for API routes.

import { decryptSecret } from '../crypto';
import { getConnector, getProject } from '../db';
import { GraphClient } from '../graph/client';
import type { Connector, Env, Project } from '../types';

export class ApiError extends Error {
  constructor(public status: 400 | 404 | 409 | 422, message: string) {
    super(message);
    this.name = 'ApiError';
  }
}

export async function loadProject(env: Env, projectId: string): Promise<Project> {
  const project = await getProject(env.DB, projectId);
  if (!project) throw new ApiError(404, 'project not found');
  return project;
}

export async function graphForConnector(
  env: Env,
  connectorId: string | undefined,
  role: 'source' | 'destination'
): Promise<{ client: GraphClient; connector: Connector & { clientSecretEnc: string } }> {
  if (!connectorId) throw new ApiError(400, `project has no ${role} connector configured`);
  const connector = await getConnector(env.DB, connectorId);
  if (!connector) throw new ApiError(404, `${role} connector not found`);
  const clientSecret = await decryptSecret(connector.clientSecretEnc, env.ENCRYPTION_KEY);
  return {
    client: new GraphClient(
      { tenantId: connector.tenantId, clientId: connector.clientId, clientSecret },
      env.KV
    ),
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
