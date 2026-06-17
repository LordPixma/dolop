// Mail coexistence engine: manages a single Dolop-owned inbox rule per mailbox
// that forwards a copy of incoming mail to the user's counterpart mailbox in
// the other tenant (dual-delivery). All operations are app-only Microsoft Graph
// against `/users/{upn}/mailFolders/inbox/messageRules`, so they need only the
// MailboxSettings.ReadWrite permission Dolop already holds.

import type { GraphClient } from '../graph/client';
import type { GraphUser, MessageRule } from '../graph/types';
import { COEXISTENCE_RULE_NAME, buildCoexistenceRule } from './transform';

/** Graph addressing path for a mailbox identified by UPN (or id). */
export function mailboxPath(upnOrId: string): string {
  return `/users/${encodeURIComponent(upnOrId)}`;
}

/**
 * Resolve the address other tenants can reliably deliver to. Before a domain
 * cutover the vanity domain (e.g. user@new.com) is not yet verified in the
 * target tenant, but the `<user>@<tenant>.onmicrosoft.com` routing address
 * always exists and routes — so we prefer it. Falls back to the mailbox's
 * primary SMTP / UPN. Returns null only if the mailbox cannot be read.
 */
export async function resolveRoutingAddress(
  client: GraphClient,
  upnOrId: string
): Promise<string | null> {
  const user = await client.get<GraphUser>(
    `${mailboxPath(upnOrId)}?$select=userPrincipalName,mail,proxyAddresses`
  );
  if (!user) return null;
  const proxies = (user.proxyAddresses ?? [])
    .map((p) => p.replace(/^smtp:/i, '').trim())
    .filter(Boolean);
  const onmicrosoft = proxies.filter((p) => /\.onmicrosoft\.com$/i.test(p));
  // Prefer the plain routing domain over the *.mail.onmicrosoft.com variant.
  const routing =
    onmicrosoft.find((p) => !/\.mail\.onmicrosoft\.com$/i.test(p)) ?? onmicrosoft[0];
  return routing ?? user.mail ?? user.userPrincipalName ?? null;
}

/** Find the managed coexistence rule in a mailbox's inbox, if present. */
export async function findCoexistenceRule(
  client: GraphClient,
  upnOrId: string
): Promise<MessageRule | null> {
  const rules = await client.listAll<MessageRule>(
    `${mailboxPath(upnOrId)}/mailFolders/inbox/messageRules`
  );
  return rules.find((r) => r.displayName === COEXISTENCE_RULE_NAME) ?? null;
}

/**
 * Ensure the managed forwarding rule exists in `upnOrId`'s inbox and points at
 * `forwardAddress`. Updates the rule in place if it already exists (idempotent),
 * otherwise creates it. Returns the rule id.
 */
export async function applyCoexistenceRule(
  client: GraphClient,
  upnOrId: string,
  forwardAddress: string
): Promise<string> {
  const payload = buildCoexistenceRule(forwardAddress);
  const existing = await findCoexistenceRule(client, upnOrId);
  if (existing) {
    await client.patch(
      `${mailboxPath(upnOrId)}/mailFolders/inbox/messageRules/${existing.id}`,
      payload
    );
    return existing.id;
  }
  const created = await client.post<MessageRule>(
    `${mailboxPath(upnOrId)}/mailFolders/inbox/messageRules`,
    payload
  );
  return created.id;
}

/**
 * Remove the managed forwarding rule from `upnOrId`'s inbox. Tries the known
 * rule id first, then falls back to a name lookup. A missing rule is treated as
 * success (already gone). Returns false only if a delete actually failed.
 */
export async function removeCoexistenceRule(
  client: GraphClient,
  upnOrId: string,
  ruleId?: string
): Promise<boolean> {
  let id = ruleId;
  if (!id) {
    const found = await findCoexistenceRule(client, upnOrId);
    if (!found) return true;
    id = found.id;
  }
  try {
    await client.delete(`${mailboxPath(upnOrId)}/mailFolders/inbox/messageRules/${id}`);
    return true;
  } catch (e) {
    // A 404 means the rule is already gone — that is the desired end state.
    if (e && typeof e === 'object' && 'status' in e && (e as { status: number }).status === 404) {
      return true;
    }
    throw e;
  }
}
