// Device migration, server side: source-tenant device inventory (Entra ID +
// Intune + Autopilot + Windows LAPS), readiness checks, BitLocker recovery-key
// backup, Autopilot removal and source-record cleanup. The on-device part of
// the move is done by the dolop agent (public/agent/dolop-agent.ps1).

import type { DeviceInventoryRow } from '../db';
import { GraphError, type GraphClient } from '../graph/client';
import type { BitLockerKeyRecord, Device, DevicePlan, MigrationUser } from '../types';

/** A device with no sign-in or Intune sync for this long is treated as stale. */
export const STALE_AFTER_DAYS = 45;

/** Graph requires these headers on BitLocker and LAPS reads (they are audited). */
const CLIENT_HEADERS = { 'ocp-client-name': 'dolop', 'ocp-client-version': '1.0' };

const ZERO_GUID = '00000000-0000-0000-0000-000000000000';

// ---------------------------------------------------------------------------
// Entra ID security identifiers

/**
 * The Windows SID of a cloud-only Entra ID user (or group), derived from its
 * object id: the 16 GUID bytes in .NET Guid.ToByteArray() order, read as four
 * little-endian uint32s, under the S-1-12-1 authority. Windows uses this SID
 * for the user's profile on Entra-joined devices, so it is known before the
 * user ever signs in to the device.
 */
export function entraSidFromObjectId(objectId: string): string {
  const hex = objectId.replace(/[{}-]/g, '').toLowerCase();
  if (!/^[0-9a-f]{32}$/.test(hex)) throw new Error(`not a GUID: ${objectId}`);
  const raw = Array.from({ length: 16 }, (_, i) => parseInt(hex.slice(i * 2, i * 2 + 2), 16));
  // Guid.ToByteArray(): Data1 (4 bytes), Data2 and Data3 (2 bytes each) are
  // little-endian; Data4 (8 bytes) is in string order.
  const bytes = [
    raw[3]!, raw[2]!, raw[1]!, raw[0]!,
    raw[5]!, raw[4]!,
    raw[7]!, raw[6]!,
    ...raw.slice(8),
  ];
  const parts: number[] = [];
  for (let i = 0; i < 16; i += 4) {
    parts.push((bytes[i]! | (bytes[i + 1]! << 8) | (bytes[i + 2]! << 16) | (bytes[i + 3]! << 24)) >>> 0);
  }
  return `S-1-12-1-${parts.join('-')}`;
}

/**
 * The SID a user's Windows profile is keyed by on an Entra-joined device:
 * the on-premises SID for users synced from Active Directory, otherwise the
 * SID derived from their Entra object id.
 */
export function userSid(user: { id: string; onPremisesSecurityIdentifier?: string | null }): string {
  return user.onPremisesSecurityIdentifier || entraSidFromObjectId(user.id);
}

/** Look up a user in a tenant and return their object id and profile SID. */
export async function resolveUserSid(
  client: GraphClient,
  upnOrId: string
): Promise<{ id: string; upn: string; sid: string }> {
  const u = await client.get<{ id: string; userPrincipalName: string; onPremisesSecurityIdentifier?: string | null }>(
    `/users/${encodeURIComponent(upnOrId)}?$select=id,userPrincipalName,onPremisesSecurityIdentifier`
  );
  return { id: u.id, upn: u.userPrincipalName, sid: userSid(u) };
}

// ---------------------------------------------------------------------------
// Inventory

interface EntraDevice {
  id: string;
  deviceId?: string;
  displayName?: string;
  operatingSystem?: string;
  operatingSystemVersion?: string;
  trustType?: string | null;
  approximateLastSignInDateTime?: string | null;
  registrationDateTime?: string | null;
  accountEnabled?: boolean;
}

interface ManagedDevice {
  id: string;
  deviceName?: string;
  azureADDeviceId?: string | null;
  userPrincipalName?: string | null;
  operatingSystem?: string;
  osVersion?: string;
  serialNumber?: string | null;
  lastSyncDateTime?: string | null;
  enrolledDateTime?: string | null;
  complianceState?: string;
  managementAgent?: string;
  deviceEnrollmentType?: string;
  managedDeviceOwnerType?: string;
  model?: string | null;
  manufacturer?: string | null;
}

interface AutopilotDevice {
  id: string;
  serialNumber?: string | null;
  azureActiveDirectoryDeviceId?: string | null;
  managedDeviceId?: string | null;
}

interface LapsCredential {
  id: string;
  deviceName?: string;
  lastBackupDateTime?: string | null;
}

async function listPaged<T>(
  client: GraphClient,
  path: string,
  headers?: Record<string, string>,
  maxPages = 20
): Promise<T[]> {
  const out: T[] = [];
  let url: string | undefined = path;
  for (let i = 0; url && i < maxPages; i++) {
    const res: { value?: T[]; '@odata.nextLink'?: string } = await client.get(url, headers);
    out.push(...(res.value ?? []));
    url = res['@odata.nextLink'];
  }
  return out;
}

function graphErrorText(e: unknown): string {
  if (e instanceof GraphError) return `${e.code}: ${e.message}`;
  return e instanceof Error ? e.message : String(e);
}

/** Run an optional inventory source; a failure becomes a warning, not an error. */
async function optional<T>(
  label: string,
  permission: string,
  warnings: string[],
  fn: () => Promise<T>
): Promise<T | null> {
  try {
    return await fn();
  } catch (e) {
    if (e instanceof GraphError && e.status === 403) {
      warnings.push(`${label} skipped: the source connector lacks ${permission} (add it and grant admin consent again).`);
    } else {
      warnings.push(`${label} skipped: ${graphErrorText(e)}`);
    }
    return null;
  }
}

const isGuid = (s: string | null | undefined): s is string =>
  Boolean(s && /^[0-9a-f-]{36}$/i.test(s) && s !== ZERO_GUID);

function latest(...dates: (string | null | undefined)[]): string | undefined {
  const ts = dates.filter((d): d is string => Boolean(d) && !d!.startsWith('0001-')).sort();
  return ts[ts.length - 1];
}

export function isWindows(os: string | undefined): boolean {
  return /windows/i.test(os ?? '');
}

export function isStale(lastActivityAt: string | undefined, now = Date.now()): boolean {
  if (!lastActivityAt) return true;
  return now - Date.parse(lastActivityAt) > STALE_AFTER_DAYS * 86_400_000;
}

/** Default plan for a device, from its inventory facts. */
export function suggestPlan(
  d: Pick<DeviceInventoryRow, 'os' | 'trustType' | 'entraObjectId' | 'lastActivityAt' | 'inventory'>,
  now = Date.now()
): DevicePlan {
  if (!d.entraObjectId) return 'cleanup'; // Intune record with no Entra device behind it
  if (d.inventory.accountEnabled === false) return 'cleanup';
  if (isStale(d.lastActivityAt, now)) return 'cleanup';
  if (isWindows(d.os) && d.trustType === 'AzureAd') return 'migrate';
  return 'manual';
}

/**
 * Read the source tenant's devices. Entra ID is required; Intune, Autopilot,
 * Windows LAPS and registered owners are best-effort (each needs its own
 * permission) and are reported as warnings when unavailable.
 */
export async function discoverDevices(
  client: GraphClient,
  users: MigrationUser[],
  now = Date.now()
): Promise<{ rows: DeviceInventoryRow[]; warnings: string[] }> {
  const warnings: string[] = [];
  const entra = await listPaged<EntraDevice>(
    client,
    '/devices?$select=id,deviceId,displayName,operatingSystem,operatingSystemVersion,trustType,' +
      'approximateLastSignInDateTime,registrationDateTime,accountEnabled&$top=999'
  );
  const intune =
    (await optional('Intune devices', 'DeviceManagementManagedDevices.ReadWrite.All', warnings, () =>
      listPaged<ManagedDevice>(
        client,
        '/deviceManagement/managedDevices?$select=id,deviceName,azureADDeviceId,userPrincipalName,' +
          'operatingSystem,osVersion,serialNumber,lastSyncDateTime,enrolledDateTime,complianceState,' +
          'managementAgent,deviceEnrollmentType,managedDeviceOwnerType,model,manufacturer'
      )
    )) ?? [];
  const autopilot =
    (await optional('Autopilot registrations', 'DeviceManagementServiceConfig.ReadWrite.All', warnings, () =>
      listPaged<AutopilotDevice>(client, '/deviceManagement/windowsAutopilotDeviceIdentities')
    )) ?? null;
  const laps = await optional('Windows LAPS status', 'DeviceLocalCredential.ReadBasic.All', warnings, () =>
    listPaged<LapsCredential>(
      client,
      '/directory/deviceLocalCredentials?$select=id,deviceName,lastBackupDateTime',
      CLIENT_HEADERS
    )
  );
  const lapsIds = laps ? new Set(laps.map((l) => l.id.toLowerCase())) : null;

  const usersByUpn = new Map(users.map((u) => [u.sourceUpn.toLowerCase(), u]));
  const intuneByDeviceId = new Map<string, ManagedDevice>();
  for (const m of intune) if (isGuid(m.azureADDeviceId)) intuneByDeviceId.set(m.azureADDeviceId.toLowerCase(), m);

  const findAutopilot = (deviceId?: string, managedId?: string, serial?: string | null) =>
    autopilot?.find(
      (a) =>
        (deviceId && a.azureActiveDirectoryDeviceId?.toLowerCase() === deviceId) ||
        (managedId && a.managedDeviceId === managedId) ||
        (serial && a.serialNumber && a.serialNumber.toLowerCase() === serial.toLowerCase())
    );

  const rows: DeviceInventoryRow[] = [];
  const usedIntune = new Set<string>();
  let ownerLookups = 0;
  for (const e of entra) {
    const deviceId = e.deviceId?.toLowerCase();
    const m = deviceId ? intuneByDeviceId.get(deviceId) : undefined;
    if (m) usedIntune.add(m.id);
    let ownerUpn = m?.userPrincipalName || undefined;
    // Registered owner for devices Intune doesn't know (personal registrations).
    if (!ownerUpn && ownerLookups < 200) {
      ownerLookups++;
      const owners = await client
        .get<{ value?: { userPrincipalName?: string }[] }>(
          `/devices/${e.id}/registeredOwners?$select=userPrincipalName`
        )
        .catch(() => ({ value: [] }));
      ownerUpn = owners.value?.find((o) => o.userPrincipalName)?.userPrincipalName;
    }
    const serial = m?.serialNumber || undefined;
    const row: DeviceInventoryRow = {
      sourceKey: deviceId ?? `entra:${e.id}`,
      name: e.displayName || m?.deviceName || 'unnamed device',
      entraObjectId: e.id,
      entraDeviceId: deviceId,
      intuneDeviceId: m?.id,
      autopilotId: findAutopilot(deviceId, m?.id, serial)?.id,
      os: e.operatingSystem || m?.operatingSystem,
      osVersion: e.operatingSystemVersion || m?.osVersion,
      trustType: e.trustType ?? undefined,
      serialNumber: serial,
      model: m?.model || undefined,
      ownerUpn: ownerUpn?.toLowerCase(),
      userId: ownerUpn ? usersByUpn.get(ownerUpn.toLowerCase())?.id : undefined,
      lastActivityAt: latest(e.approximateLastSignInDateTime, m?.lastSyncDateTime),
      registeredAt: e.registrationDateTime ?? m?.enrolledDateTime ?? undefined,
      lapsBackedUp: lapsIds && deviceId ? lapsIds.has(deviceId) : undefined,
      inventory: {
        inEntra: true,
        inIntune: Boolean(m),
        accountEnabled: e.accountEnabled,
        complianceState: m?.complianceState,
        managementAgent: m?.managementAgent,
        enrollmentType: m?.deviceEnrollmentType,
        ownerType: m?.managedDeviceOwnerType,
        manufacturer: m?.manufacturer || undefined,
      },
      suggestedPlan: 'manual',
    };
    row.suggestedPlan = suggestPlan(row, now);
    rows.push(row);
  }
  // Intune records with no Entra device behind them (orphans from re-joins).
  for (const m of intune) {
    if (usedIntune.has(m.id)) continue;
    const ownerUpn = m.userPrincipalName?.toLowerCase() || undefined;
    const row: DeviceInventoryRow = {
      sourceKey: `intune:${m.id}`,
      name: m.deviceName || 'unnamed device',
      intuneDeviceId: m.id,
      autopilotId: findAutopilot(undefined, m.id, m.serialNumber)?.id,
      os: m.operatingSystem,
      osVersion: m.osVersion,
      serialNumber: m.serialNumber || undefined,
      model: m.model || undefined,
      ownerUpn,
      userId: ownerUpn ? usersByUpn.get(ownerUpn)?.id : undefined,
      lastActivityAt: latest(m.lastSyncDateTime),
      registeredAt: m.enrolledDateTime ?? undefined,
      inventory: {
        inEntra: false,
        inIntune: true,
        complianceState: m.complianceState,
        managementAgent: m.managementAgent,
        enrollmentType: m.deviceEnrollmentType,
        ownerType: m.managedDeviceOwnerType,
        manufacturer: m.manufacturer || undefined,
      },
      suggestedPlan: 'cleanup',
    };
    row.suggestedPlan = suggestPlan(row, now);
    rows.push(row);
  }
  if (autopilot === null) {
    // Without Autopilot data a stale registration can't be detected; say so.
    warnings.push('Autopilot registrations could not be checked — remove migrated devices from Autopilot by hand.');
  }
  return { rows, warnings };
}

// ---------------------------------------------------------------------------
// Readiness

export type CheckStatus = 'ok' | 'warn' | 'fail' | 'pending';

export interface ReadinessCheck {
  name: string;
  label: string;
  status: CheckStatus;
  detail: string;
}

/**
 * The checks a device must pass before the agent may move it. They are
 * recomputed on every read so they always reflect the current inventory,
 * user mapping, uploaded provisioning package and the agent's last report.
 */
export function deviceReadiness(
  device: Device,
  user: MigrationUser | undefined,
  ctx: { packageAvailable: boolean; now?: number }
): ReadinessCheck[] {
  const checks: ReadinessCheck[] = [];
  const add = (name: string, label: string, status: CheckStatus, detail: string) =>
    checks.push({ name, label, status, detail });

  if (!isWindows(device.os)) {
    add('platform', 'Windows, joined to Entra ID', 'fail', `${device.os ?? 'Unknown OS'}: the agent only moves Windows devices.`);
  } else if (device.trustType === 'ServerAd') {
    add('platform', 'Windows, joined to Entra ID', 'fail', 'Hybrid-joined (on-premises AD) devices are not supported.');
  } else if (device.trustType !== 'AzureAd') {
    add('platform', 'Windows, joined to Entra ID', 'fail',
      device.trustType === 'Workplace'
        ? 'Only registered, not joined: remove the work account on the device and add the new one.'
        : 'Not joined to Entra ID.');
  } else {
    add('platform', 'Windows, joined to Entra ID', 'ok', `${device.os} ${device.osVersion ?? ''}`.trim());
  }

  add('active', 'Recently active',
    isStale(device.lastActivityAt, ctx.now) ? 'warn' : 'ok',
    device.lastActivityAt ? `Last activity ${device.lastActivityAt.slice(0, 10)}` : 'No recorded activity');

  if (!user) {
    add('user', 'Mapped to a migration user', 'fail',
      device.ownerUpn
        ? `${device.ownerUpn} is not in this project's user list — add them on the Users tab.`
        : 'No primary user — assign one.');
  } else {
    add('user', 'Mapped to a migration user', 'ok', `${user.sourceUpn} → ${user.destUpn}`);
    add('dest_account', 'Destination account exists',
      user.destId || device.destSid ? 'ok' : 'warn',
      user.destId || device.destSid
        ? user.destUpn
        : 'Not confirmed yet — it is looked up when the agent command is created (provision the user first).');
  }

  add('autopilot', 'Removed from source Autopilot',
    device.autopilotId ? 'warn' : 'ok',
    device.autopilotId ? 'Still registered in the source Autopilot: remove it, or a future reset rejoins the old tenant.' : 'Not registered');

  add('bitlocker', 'BitLocker recovery keys backed up',
    device.bitlockerCount > 0 ? 'ok' : 'warn',
    device.bitlockerCount > 0
      ? `${device.bitlockerCount} key(s) saved ${device.bitlockerBackedUpAt?.slice(0, 10) ?? ''}`.trim()
      : 'No keys saved in dolop yet.');

  add('local_admin', 'Local administrator available',
    device.lapsBackedUp ? 'ok' : 'warn',
    device.lapsBackedUp
      ? 'A Windows LAPS password is backed up in the source tenant: retrieve it before cutover.'
      : 'No LAPS password found: make sure a local admin account works (the agent checks too).');

  add('package', 'Destination provisioning package uploaded',
    ctx.packageAvailable ? 'ok' : 'fail',
    ctx.packageAvailable ? 'Ready' : 'Upload the .ppkg made in Windows Configuration Designer.');

  const agentChecks = device.agentReport?.checks;
  if (!agentChecks?.length) {
    add('agent_check', 'Agent pre-flight check', 'pending', 'Run the agent in Check mode on the device.');
  } else {
    const failed = agentChecks.filter((c) => c.status === 'fail');
    add('agent_check', 'Agent pre-flight check', failed.length ? 'fail' : 'ok',
      failed.length ? failed.map((c) => `${c.name}: ${c.detail ?? 'failed'}`).join('; ') : 'All checks passed');
  }
  return checks;
}

/** True when nothing blocks issuing a Migrate run. */
export function isReady(checks: ReadinessCheck[]): boolean {
  return checks.every((c) => c.status === 'ok' || c.status === 'warn');
}

// ---------------------------------------------------------------------------
// Actions against the source tenant

/** Read a device's BitLocker recovery keys from Entra ID. */
export async function fetchBitLockerKeys(client: GraphClient, entraDeviceId: string): Promise<BitLockerKeyRecord[]> {
  const list = await listPaged<{ id: string; createdDateTime?: string; volumeType?: string }>(
    client,
    `/informationProtection/bitlocker/recoveryKeys?$filter=${encodeURIComponent(`deviceId eq '${entraDeviceId}'`)}`,
    CLIENT_HEADERS
  );
  const out: BitLockerKeyRecord[] = [];
  for (const k of list) {
    const full = await client.get<{ key?: string }>(
      `/informationProtection/bitlocker/recoveryKeys/${encodeURIComponent(k.id)}?$select=key`,
      CLIENT_HEADERS
    );
    if (full.key) {
      out.push({ id: k.id, key: full.key, volumeType: k.volumeType, createdAt: k.createdDateTime, source: 'entra' });
    }
  }
  return out;
}

/** Merge newly read keys into the stored set (by protector id, newest wins). */
export function mergeBitLockerKeys(existing: BitLockerKeyRecord[], incoming: BitLockerKeyRecord[]): BitLockerKeyRecord[] {
  const byId = new Map(existing.map((k) => [k.id.toLowerCase(), k]));
  for (const k of incoming) byId.set(k.id.toLowerCase(), k);
  return [...byId.values()];
}

const ignoreNotFound = (e: unknown): void => {
  if (e instanceof GraphError && e.status === 404) return;
  throw e;
};

export async function removeFromAutopilot(client: GraphClient, autopilotId: string): Promise<void> {
  await client
    .delete(`/deviceManagement/windowsAutopilotDeviceIdentities/${encodeURIComponent(autopilotId)}`)
    .catch(ignoreNotFound);
}

/** Delete the device's records from the source tenant (Intune record and/or Entra device object). */
export async function deleteSourceRecords(
  client: GraphClient,
  device: Pick<Device, 'intuneDeviceId' | 'entraObjectId'>,
  what: { intune: boolean; entra: boolean }
): Promise<string[]> {
  const done: string[] = [];
  if (what.intune && device.intuneDeviceId) {
    await client
      .delete(`/deviceManagement/managedDevices/${encodeURIComponent(device.intuneDeviceId)}`)
      .catch(ignoreNotFound);
    done.push('Intune record');
  }
  if (what.entra && device.entraObjectId) {
    await client.delete(`/devices/${encodeURIComponent(device.entraObjectId)}`).catch(ignoreNotFound);
    done.push('Entra ID device');
  }
  return done;
}
