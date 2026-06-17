// Mail coexistence (dual-delivery) control. Manages a Dolop-owned forwarding
// inbox rule on one side of the migration so mail addressed to a user is
// received in both tenants — during pre-stage, through cutover, and into
// aftercare — until the organisation is comfortable turning the other tenant
// off. Direction is one-way per user at any time, which prevents mail loops.

import { Hono } from 'hono';
import {
  coexistenceSummary,
  getUsersByIds,
  listAllProjectUsers,
  logEvent,
  updateUserCoexistence,
} from '../db';
import {
  applyCoexistenceRule,
  removeCoexistenceRule,
  resolveRoutingAddress,
} from '../engine/coexistence';
import { GraphClient, GraphError } from '../graph/client';
import type {
  CoexistenceDirection,
  CoexistenceForwardMode,
  Env,
  MigrationUser,
} from '../types';
import { ApiError, graphForConnector, loadProject } from './helpers';

export const coexistenceApi = new Hono<{ Bindings: Env }>();

// Bound the number of mailboxes touched per request to stay well inside the
// Worker subrequest budget (each enable is a handful of Graph calls). The
// dashboard batches larger scopes client-side.
const MAX_PER_REQUEST = 100;

const DIRECTIONS: CoexistenceDirection[] = ['src_to_dest', 'dest_to_src'];

interface Sides {
  /** Mailbox that hosts the forwarding rule. */
  forwarder: { client: GraphClient; upn: string };
  /** Mailbox that receives the forwarded copy. */
  counterpart: { client: GraphClient; upn: string };
}

function sidesFor(
  direction: CoexistenceDirection,
  src: GraphClient,
  dst: GraphClient,
  user: MigrationUser
): Sides {
  return direction === 'src_to_dest'
    ? {
        forwarder: { client: src, upn: user.sourceUpn },
        counterpart: { client: dst, upn: user.destUpn },
      }
    : {
        forwarder: { client: dst, upn: user.destUpn },
        counterpart: { client: src, upn: user.sourceUpn },
      };
}

function errMessage(e: unknown): string {
  if (e instanceof GraphError) return `${e.code}: ${e.message}`;
  return e instanceof Error ? e.message : String(e);
}

/** Load source + destination Graph clients for the project (both required). */
async function projectClients(
  env: Env,
  projectId: string
): Promise<{ src: GraphClient; dst: GraphClient }> {
  const project = await loadProject(env, projectId);
  if (!project.sourceConnectorId || !project.destConnectorId) {
    throw new ApiError(400, 'assign source and destination connectors to the project first');
  }
  const [{ client: src }, { client: dst }] = await Promise.all([
    graphForConnector(env, project.sourceConnectorId, 'source'),
    graphForConnector(env, project.destConnectorId, 'destination'),
  ]);
  return { src, dst };
}

/** Resolve the list of users to act on (explicit ids, or all in scope). */
async function targetUsers(
  env: Env,
  projectId: string,
  userIds: string[] | undefined
): Promise<MigrationUser[]> {
  if (userIds?.length) {
    const users = (await getUsersByIds(env.DB, userIds)).filter((u) => u.projectId === projectId);
    return users.slice(0, MAX_PER_REQUEST);
  }
  return (await listAllProjectUsers(env.DB, projectId)).slice(0, MAX_PER_REQUEST);
}

// Current coexistence rollup for the dashboard.
coexistenceApi.get('/:projectId/coexistence', async (c) => {
  const project = await loadProject(c.env, c.req.param('projectId'));
  return c.json({ summary: await coexistenceSummary(c.env.DB, project.id) });
});

// Enable (or update) dual-delivery for the given users in one direction.
coexistenceApi.post('/:projectId/coexistence/enable', async (c) => {
  const projectId = c.req.param('projectId');
  const body = (await c.req.json().catch(() => ({}))) as {
    userIds?: string[];
    direction?: CoexistenceDirection;
    forwardMode?: CoexistenceForwardMode;
  };
  const direction = body.direction ?? 'src_to_dest';
  if (!DIRECTIONS.includes(direction)) {
    throw new ApiError(400, `direction must be one of ${DIRECTIONS.join(', ')}`);
  }
  const forwardMode: CoexistenceForwardMode = body.forwardMode === 'upn' ? 'upn' : 'routing';

  const { src, dst } = await projectClients(c.env, projectId);
  const users = await targetUsers(c.env, projectId, body.userIds);

  const results: {
    userId: string;
    sourceUpn: string;
    status: 'active' | 'failed';
    forwardAddress?: string;
    error?: string;
  }[] = [];

  for (const user of users) {
    try {
      const sides = sidesFor(direction, src, dst, user);
      const forwardAddress =
        forwardMode === 'routing'
          ? (await resolveRoutingAddress(sides.counterpart.client, sides.counterpart.upn)) ??
            sides.counterpart.upn
          : sides.counterpart.upn;

      // Switching direction: tear down any rule still on the previous side so
      // only one direction is ever active (no forwarding loop).
      if (
        user.coexistenceStatus === 'active' &&
        user.coexistenceDirection &&
        user.coexistenceDirection !== direction
      ) {
        const old = sidesFor(user.coexistenceDirection, src, dst, user);
        await removeCoexistenceRule(old.forwarder.client, old.forwarder.upn, user.coexistenceRuleId);
      }

      const ruleId = await applyCoexistenceRule(
        sides.forwarder.client,
        sides.forwarder.upn,
        forwardAddress
      );
      await updateUserCoexistence(c.env.DB, user.id, {
        status: 'active',
        direction,
        ruleId,
        forwardAddress,
        detail: `forwarding ${sides.forwarder.upn} → ${forwardAddress}`,
      });
      results.push({ userId: user.id, sourceUpn: user.sourceUpn, status: 'active', forwardAddress });
    } catch (e) {
      const error = errMessage(e);
      await updateUserCoexistence(c.env.DB, user.id, { status: 'failed', direction, detail: error });
      results.push({ userId: user.id, sourceUpn: user.sourceUpn, status: 'failed', error });
    }
  }

  const enabled = results.filter((r) => r.status === 'active').length;
  await logEvent(c.env.DB, {
    projectId,
    message: `coexistence enabled (${direction}) for ${enabled}/${results.length} user(s)`,
  });
  return c.json({ results, processed: results.length });
});

// Disable dual-delivery: remove the managed rule wherever it currently lives.
coexistenceApi.post('/:projectId/coexistence/disable', async (c) => {
  const projectId = c.req.param('projectId');
  const body = (await c.req.json().catch(() => ({}))) as { userIds?: string[] };

  const { src, dst } = await projectClients(c.env, projectId);
  const users = (await targetUsers(c.env, projectId, body.userIds)).filter(
    (u) => u.coexistenceStatus !== 'off' || u.coexistenceRuleId
  );

  const results: { userId: string; sourceUpn: string; status: 'off' | 'failed'; error?: string }[] = [];
  for (const user of users) {
    try {
      const sides = sidesFor(user.coexistenceDirection ?? 'src_to_dest', src, dst, user);
      await removeCoexistenceRule(sides.forwarder.client, sides.forwarder.upn, user.coexistenceRuleId);
      await updateUserCoexistence(c.env.DB, user.id, {
        status: 'off',
        direction: null,
        ruleId: null,
        forwardAddress: null,
        detail: null,
      });
      results.push({ userId: user.id, sourceUpn: user.sourceUpn, status: 'off' });
    } catch (e) {
      const error = errMessage(e);
      await updateUserCoexistence(c.env.DB, user.id, { status: 'failed', detail: error });
      results.push({ userId: user.id, sourceUpn: user.sourceUpn, status: 'failed', error });
    }
  }

  await logEvent(c.env.DB, {
    projectId,
    message: `coexistence disabled for ${results.filter((r) => r.status === 'off').length} user(s)`,
  });
  return c.json({ results, processed: results.length });
});
