import {
  ACCOUNT_SYNC_APPLICATION,
  ACCOUNT_SYNC_SCHEMA_VERSION,
  type AccountSyncManifest,
  type ReplicaComparison,
  type SyncableAccountData,
} from "@/account/types";

export function mergeVectorClocks(...clocks: Array<Record<string, number>>): Record<string, number> {
  const merged: Record<string, number> = {};
  for (const clock of clocks) {
    for (const [deviceId, rawCounter] of Object.entries(clock)) {
      const counter = Number.isSafeInteger(rawCounter) && rawCounter >= 0 ? rawCounter : 0;
      merged[deviceId] = Math.max(merged[deviceId] ?? 0, counter);
    }
  }
  return Object.fromEntries(Object.entries(merged).sort(([left], [right]) => left.localeCompare(right)));
}

export function compareVectorClocks(left: Record<string, number>, right: Record<string, number>): ReplicaComparison {
  const devices = new Set([...Object.keys(left), ...Object.keys(right)]);
  let leftGreater = false;
  let rightGreater = false;
  for (const deviceId of devices) {
    const leftCounter = left[deviceId] ?? 0;
    const rightCounter = right[deviceId] ?? 0;
    if (leftCounter > rightCounter) leftGreater = true;
    if (rightCounter > leftCounter) rightGreater = true;
  }
  if (!leftGreater && !rightGreater) return "same";
  if (leftGreater && !rightGreater) return "ahead";
  if (!leftGreater && rightGreater) return "behind";
  return "diverged";
}

export function compareAccountManifests(left: AccountSyncManifest, right: AccountSyncManifest): ReplicaComparison {
  const comparison = compareVectorClocks(left.vectorClock, right.vectorClock);
  if (comparison === "same" && left.contentHash && right.contentHash && left.contentHash !== right.contentHash) return "diverged";
  return comparison;
}

export function initialAccountManifest(deviceId: string, now = new Date().toISOString()): AccountSyncManifest {
  return {
    application: ACCOUNT_SYNC_APPLICATION,
    schemaVersion: ACCOUNT_SYNC_SCHEMA_VERSION,
    snapshotId: crypto.randomUUID(),
    modifiedAtUtc: utcIso(now),
    modifiedByDeviceId: deviceId,
    vectorClock: {},
  };
}

export function nextAccountManifest(previous: AccountSyncManifest, deviceId: string, now = new Date().toISOString()): AccountSyncManifest {
  const vectorClock = mergeVectorClocks(previous.vectorClock);
  vectorClock[deviceId] = (vectorClock[deviceId] ?? 0) + 1;
  return {
    application: ACCOUNT_SYNC_APPLICATION,
    schemaVersion: ACCOUNT_SYNC_SCHEMA_VERSION,
    snapshotId: crypto.randomUUID(),
    modifiedAtUtc: utcIso(now),
    modifiedByDeviceId: deviceId,
    vectorClock,
  };
}

export function reconciledAccountManifest(manifests: AccountSyncManifest[], deviceId: string, now = new Date().toISOString()): AccountSyncManifest {
  const base = initialAccountManifest(deviceId, now);
  const vectorClock = mergeVectorClocks(...manifests.map((manifest) => manifest.vectorClock));
  vectorClock[deviceId] = (vectorClock[deviceId] ?? 0) + 1;
  return { ...base, vectorClock };
}

export function validateAccountManifest(value: unknown): AccountSyncManifest {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("Account sync manifest is malformed.");
  const manifest = value as Partial<AccountSyncManifest>;
  if (manifest.application !== ACCOUNT_SYNC_APPLICATION || manifest.schemaVersion !== ACCOUNT_SYNC_SCHEMA_VERSION) throw new Error("Account sync manifest schema is incompatible.");
  if (typeof manifest.snapshotId !== "string" || !manifest.snapshotId.trim()) throw new Error("Account sync snapshot identity is missing.");
  if (typeof manifest.modifiedByDeviceId !== "string" || !manifest.modifiedByDeviceId.trim()) throw new Error("Account sync device identity is missing.");
  if (typeof manifest.modifiedAtUtc !== "string" || !/Z$/.test(manifest.modifiedAtUtc) || !Number.isFinite(Date.parse(manifest.modifiedAtUtc))) throw new Error("Account sync timestamp must be an ISO-8601 UTC value.");
  if (!manifest.vectorClock || typeof manifest.vectorClock !== "object" || Array.isArray(manifest.vectorClock)) throw new Error("Account sync vector clock is malformed.");
  for (const [deviceId, counter] of Object.entries(manifest.vectorClock)) {
    if (!deviceId.trim() || !Number.isSafeInteger(counter) || counter < 0) throw new Error("Account sync vector clock contains an invalid component.");
  }
  if (manifest.contentHash !== undefined && !/^[a-f0-9]{64}$/.test(manifest.contentHash)) throw new Error("Account sync content hash is malformed.");
  return { ...manifest, vectorClock: mergeVectorClocks(manifest.vectorClock) } as AccountSyncManifest;
}

function utcIso(value: string): string {
  const parsed = new Date(value);
  if (!Number.isFinite(parsed.getTime())) throw new Error("Account sync timestamp is invalid.");
  return parsed.toISOString();
}

export function canonicalAccountJson(value: unknown): string {
  return JSON.stringify(canonicalValue(value));
}

function canonicalValue(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonicalValue);
  if (!value || typeof value !== "object") return value;
  return Object.fromEntries(Object.entries(value as Record<string, unknown>)
    .filter(([, entry]) => entry !== undefined)
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([key, entry]) => [key, canonicalValue(entry)]));
}

export async function accountContentHash(data: SyncableAccountData): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(canonicalAccountJson(data)));
  return [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}
