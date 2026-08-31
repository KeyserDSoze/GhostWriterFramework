import { create } from "zustand";
import { adoptRemoteAccountSnapshot, loadLocalAccountSnapshot, LocalAccountSnapshotChangedError, markLocalAccountReplicaConfirmed, replaceLocalAccountSnapshot, updateLocalAccountManifest } from "@/account/accountLocalStore";
import { accountBackendToken, AccountCredentialError, useConnectionStore } from "@/account/connectionStore";
import { compareAccountManifests } from "@/account/vectorClock";
import { accountSyncEnvelope } from "@/account/serialization";
import type { AccountRemoteSnapshot, AccountSyncBackend, AccountSyncBackendKind, LocalAccountSnapshot, ReplicaComparison } from "@/account/types";
import { DriveAccountSyncBackend } from "@/account/sync/driveBackend";
import { GitHubAccountSyncBackend } from "@/account/sync/githubBackend";
import { useSettingsStore, LOCAL_SETTINGS_SOURCE_SCHEMA_VERSION } from "@/store/settingsStore";
import { useCostsStore } from "@/costs/costsStore";
import { useClipboardStore } from "@/clipboard/clipboardStore";
import { refreshAssistantSessionIndex } from "@/assistant/sessionIndex";
import { localWorkspaceScope } from "@/account/deviceIdentity";
import { mergeLocalDeviceSettings } from "@/account/dataProjection";

export interface ReplicaCandidate {
  id: "local" | AccountSyncBackendKind;
  label: string;
  comparison: ReplicaComparison;
  snapshot: LocalAccountSnapshot | AccountRemoteSnapshot;
}

export interface AccountReconciliationRequest {
  local: LocalAccountSnapshot;
  remotes: AccountRemoteSnapshot[];
  candidates: ReplicaCandidate[];
}

interface AccountSyncState {
  syncing: boolean;
  reconciliation: AccountReconciliationRequest | null;
  setReconciliation: (request: AccountReconciliationRequest | null) => void;
}

export const useAccountSyncStore = create<AccountSyncState>((set) => ({
  syncing: false,
  reconciliation: null,
  setReconciliation: (reconciliation) => set({ reconciliation }),
}));

export interface AccountSyncPlan {
  action: "noop" | "push-local" | "pull-remote" | "reconcile";
  comparisons: Array<{ backend: AccountSyncBackendKind; comparison: ReplicaComparison }>;
  authoritativeRemote?: AccountSyncBackendKind;
}

export function planAccountSync(local: LocalAccountSnapshot, remotes: AccountRemoteSnapshot[], missingCount = 0): AccountSyncPlan {
  const comparisons = remotes.map((remote) => ({ backend: remote.backend, comparison: compareAccountManifests(local.manifest, remote.manifest) }));
  const distinct = new Set(remotes.map((remote) => `${JSON.stringify(Object.entries(remote.manifest.vectorClock).sort(([left], [right]) => left.localeCompare(right)))}:${remote.manifest.contentHash ?? remote.manifest.snapshotId}`));
  if (comparisons.some(({ comparison }) => comparison === "diverged") || distinct.size > 1) return { action: "reconcile", comparisons };
  const newer = comparisons.find(({ comparison }) => comparison === "behind");
  if (newer) return { action: "pull-remote", comparisons, authoritativeRemote: newer.backend };
  if (missingCount > 0 || comparisons.some(({ comparison }) => comparison === "ahead")) return { action: "push-local", comparisons };
  return { action: "noop", comparisons };
}

function backendLabel(kind: AccountSyncBackendKind): string {
  return kind === "google-drive" ? "Google Drive" : kind === "onedrive" ? "OneDrive" : "GitHub";
}

function activeBackendKinds(): AccountSyncBackendKind[] {
  const configuration = useConnectionStore.getState().configuration;
  return [
    ...(configuration.google?.replica.enabled ? ["google-drive" as const] : []),
    ...(configuration.microsoft?.replica.enabled ? ["onedrive" as const] : []),
    ...(configuration.github?.replica.enabled && configuration.github.accountSyncEnabled ? ["github" as const] : []),
  ];
}

function createBackend(kind: AccountSyncBackendKind): AccountSyncBackend {
  const configuration = useConnectionStore.getState().configuration;
  const token = accountBackendToken(kind);
  if (kind === "google-drive") {
    const connection = configuration.google;
    if (!connection) throw new AccountCredentialError(kind, "missing");
    return new DriveAccountSyncBackend("google", token, connection.identity.providerAccountId);
  }
  if (kind === "onedrive") {
    const connection = configuration.microsoft;
    if (!connection) throw new AccountCredentialError(kind, "missing");
    return new DriveAccountSyncBackend("microsoft", token, connection.identity.providerAccountId);
  }
  const connection = configuration.github;
  const owner = connection?.identity?.username ?? connection?.repositoryOwner;
  if (!connection || !owner) throw new AccountCredentialError(kind, "missing");
  return new GitHubAccountSyncBackend(token, owner);
}

async function localSnapshotWithHash(): Promise<LocalAccountSnapshot> {
  for (;;) {
    const snapshot = await loadLocalAccountSnapshot();
    if (!snapshot) throw new Error("Local account data has not been initialized.");
    const contentHash = (await accountSyncEnvelope(snapshot)).manifest.contentHash!;
    if (snapshot.manifest.contentHash === contentHash) return snapshot;
    const manifest = { ...snapshot.manifest, contentHash };
    if (await updateLocalAccountManifest(manifest, snapshot.dirty, snapshot.manifest.snapshotId)) return { ...snapshot, manifest };
  }
}

async function applyLocalSnapshot(snapshot: LocalAccountSnapshot): Promise<void> {
  const settingsState = useSettingsStore.getState();
  settingsState.replaceSettingsFromTrustedLoad(snapshot.data.settings, {
    accountGeneration: settingsState.accountGeneration,
    accountIdentity: localWorkspaceScope(),
    source: { kind: "local", schemaVersion: LOCAL_SETTINGS_SOURCE_SCHEMA_VERSION },
  });
  useCostsStore.getState().hydrate(snapshot.data.costs);
  useClipboardStore.getState().hydrate(snapshot.data.clipboard);
  await refreshAssistantSessionIndex();
}

async function setReplicaFailure(kind: AccountSyncBackendKind, error: unknown): Promise<void> {
  const patch = error instanceof AccountCredentialError
    ? { status: "needs-auth" as const, errorKind: error.reason === "expired" ? "credential-expired" as const : "credential-missing" as const }
    : navigator.onLine === false
      ? { status: "offline" as const, errorKind: "offline" as const }
      : { status: "error" as const, errorKind: classifyAccountSyncError(error) };
  await useConnectionStore.getState().updateReplica(kind, { ...patch, lastAttemptAtUtc: new Date().toISOString() });
}

export function classifyAccountSyncError(error: unknown) {
  if (error instanceof AccountCredentialError) return error.reason === "expired" ? "credential-expired" as const : "credential-missing" as const;
  const value = error && typeof error === "object" ? error as { status?: unknown; code?: unknown; message?: unknown } : {};
  const message = typeof value.message === "string" ? value.message.toLowerCase() : "";
  const statusMatch = message.match(/(?:^|[\s:(])([1-5]\d{2})(?:[\s).]|$)/);
  const status = typeof value.status === "number" ? value.status : statusMatch ? Number(statusMatch[1]) : undefined;
  if (value.code === "GITHUB_ACCOUNT_REPOSITORY_PUBLIC") return "remote-public" as const;
  if (status === 401 || /expired/.test(message)) return "credential-expired" as const;
  if (status === 403 || /permission|forbidden/.test(message)) return "permission-denied" as const;
  if (status === 404) return "remote-not-found" as const;
  if (status === 429 || /rate.?limit/.test(message)) return "rate-limited" as const;
  if (status === 304) return "cache-revalidation" as const;
  if (/hash/.test(message)) return "hash-mismatch" as const;
  if (/schema/.test(message)) return "schema-incompatible" as const;
  if (/corrupt|malformed|incomplete/.test(message)) return "remote-corrupt" as const;
  if (error instanceof TypeError || /network|fetch/.test(message)) return "network" as const;
  return "unknown" as const;
}

export async function syncAllAccountReplicas(): Promise<{ synced: AccountSyncBackendKind[]; reconciliation: boolean }> {
  return withAccountSyncLock(() => syncAccountReplicas(activeBackendKinds()));
}

async function syncAccountReplicas(activeKinds: AccountSyncBackendKind[]): Promise<{ synced: AccountSyncBackendKind[]; reconciliation: boolean }> {
  if (useAccountSyncStore.getState().syncing) {
    syncRequestedWhileBusy = true;
    return { synced: [], reconciliation: Boolean(useAccountSyncStore.getState().reconciliation) };
  }
  useAccountSyncStore.setState({ syncing: true });
  const synced: AccountSyncBackendKind[] = [];
  try {
    let local = await localSnapshotWithHash();
    const backends = new Map<AccountSyncBackendKind, AccountSyncBackend>();
    const remotes: AccountRemoteSnapshot[] = [];
    const missing: AccountSyncBackendKind[] = [];

    await Promise.all(activeKinds.map(async (kind) => {
      try {
        await useConnectionStore.getState().updateReplica(kind, { status: "syncing", lastAttemptAtUtc: new Date().toISOString(), errorKind: undefined });
        const backend = createBackend(kind);
        backends.set(kind, backend);
        const remote = await backend.pull();
        if (remote) remotes.push(remote);
        else missing.push(kind);
      } catch (error) {
        await setReplicaFailure(kind, error);
      }
    }));

    const plan = planAccountSync(local, remotes, missing.length);
    const comparisons = remotes.map((remote) => ({ remote, comparison: compareAccountManifests(local.manifest, remote.manifest) }));
    if (plan.action === "reconcile") {
      const candidates: ReplicaCandidate[] = [
        { id: "local", label: "Local device", comparison: "same", snapshot: local },
        ...comparisons.map(({ remote, comparison }) => ({ id: remote.backend, label: backendLabel(remote.backend), comparison, snapshot: remote })),
      ];
      useAccountSyncStore.getState().setReconciliation({ local, remotes, candidates });
      for (const { remote, comparison } of comparisons) await useConnectionStore.getState().updateReplica(remote.backend, { status: comparison === "same" ? "idle" : comparison });
      return { synced, reconciliation: true };
    }

    const newer = comparisons.find(({ comparison }) => comparison === "behind")?.remote;
    if (newer) {
      const data = { ...newer.data, settings: mergeLocalDeviceSettings(local.data.settings, newer.data.settings) };
      local = await adoptRemoteAccountSnapshot(data, newer.manifest, `Pulled account data from ${backendLabel(newer.backend)}`, local.manifest.snapshotId);
      await applyLocalSnapshot(local);
    }

    for (const kind of activeKinds) {
      const backend = backends.get(kind);
      if (!backend) continue;
      const remote = remotes.find((entry) => entry.backend === kind);
      const comparison = remote ? compareAccountManifests(local.manifest, remote.manifest) : null;
      try {
        if (!remote || comparison === "ahead" || remote.format === "legacy" || remote.format === "repair") await backend.push(local, remote ? { snapshotId: remote.manifest.snapshotId, contentHash: remote.manifest.contentHash, revision: remote.revision, format: remote.format ?? "current" } : { absent: true });
        else if (comparison === "diverged") continue;
        const currentAfterRemoteWrite = await loadLocalAccountSnapshot();
        if (!currentAfterRemoteWrite || currentAfterRemoteWrite.manifest.snapshotId !== local.manifest.snapshotId) {
          syncRequestedWhileBusy = true;
          await useConnectionStore.getState().updateReplica(kind, { status: "dirty" });
          break;
        }
        await useConnectionStore.getState().updateReplica(kind, {
          status: "idle",
          lastSuccessfulSyncAtUtc: new Date().toISOString(),
          lastKnownRemoteSnapshotId: local.manifest.snapshotId,
          errorKind: undefined,
        });
        await markLocalAccountReplicaConfirmed(local.manifest.snapshotId);
        useCostsStore.getState().markSynced(useCostsStore.getState().revision);
        useClipboardStore.getState().markSynced(useClipboardStore.getState().revision);
        synced.push(kind);
      } catch (error) {
        await setReplicaFailure(kind, error);
      }
    }
    useAccountSyncStore.getState().setReconciliation(null);
    return { synced, reconciliation: false };
  } catch (error) {
    if (error instanceof LocalAccountSnapshotChangedError) {
      syncRequestedWhileBusy = true;
      return { synced, reconciliation: false };
    }
    throw error;
  } finally {
    useAccountSyncStore.setState({ syncing: false });
    if (syncRequestedWhileBusy) {
      syncRequestedWhileBusy = false;
      scheduleAccountSync(250);
    }
  }
}

export async function resolveAccountReconciliation(authoritative: "local" | AccountSyncBackendKind): Promise<void> {
  const request = useAccountSyncStore.getState().reconciliation;
  if (!request) return;
  const selected = authoritative === "local" ? request.local : request.remotes.find((remote) => remote.backend === authoritative);
  if (!selected) throw new Error("The selected account replica is unavailable.");
  const allManifests = [request.local.manifest, ...request.remotes.map((remote) => remote.manifest)];
  const data = authoritative === "local" ? selected.data : { ...selected.data, settings: mergeLocalDeviceSettings(request.local.data.settings, selected.data.settings) };
  const reconciled = await replaceLocalAccountSnapshot(data, allManifests, `Resolved account divergence using ${authoritative}`, request.local.manifest.snapshotId);
  await applyLocalSnapshot(reconciled);
  useAccountSyncStore.getState().setReconciliation(null);
  await syncAllAccountReplicas();
}

export async function syncOneAccountReplica(kind: AccountSyncBackendKind): Promise<void> {
  const currentKinds = activeBackendKinds();
  if (!currentKinds.includes(kind)) throw new Error(`${backendLabel(kind)} sync is disabled on this device.`);
  cancelScheduledAccountSync();
  const result = await withAccountSyncLock(() => syncAccountReplicas([kind]));
  if (result.synced.includes(kind) || result.reconciliation) return;
  const configuration = useConnectionStore.getState().configuration;
  const replica = kind === "google-drive" ? configuration.google?.replica : kind === "onedrive" ? configuration.microsoft?.replica : configuration.github?.replica;
  if (replica?.status === "error" || replica?.status === "offline" || replica?.status === "needs-auth") {
    throw new Error(`${backendLabel(kind)} sync failed (${replica.errorKind ?? replica.status}).`);
  }
}

async function withAccountSyncLock<T>(run: () => Promise<T>): Promise<T> {
  if (typeof navigator !== "undefined" && navigator.locks) return navigator.locks.request("narrarium-account-sync", { mode: "exclusive" }, run);
  return run();
}

export async function deleteRemoteAccountData(kind: AccountSyncBackendKind): Promise<void> {
  const backend = createBackend(kind);
  await backend.deleteRemoteData();
  await useConnectionStore.getState().updateReplica(kind, { status: "disabled", enabled: false, lastKnownRemoteSnapshotId: undefined });
}

let syncTimer: ReturnType<typeof setTimeout> | null = null;
let automaticSyncInstalled = false;
let syncRequestedWhileBusy = false;

function cancelScheduledAccountSync(): void {
  if (!syncTimer) return;
  clearTimeout(syncTimer);
  syncTimer = null;
}

export function scheduleAccountSync(delayMs = 2_000): void {
  if (useAccountSyncStore.getState().syncing) syncRequestedWhileBusy = true;
  cancelScheduledAccountSync();
  syncTimer = setTimeout(() => {
    syncTimer = null;
    if (navigator.onLine !== false) void syncAllAccountReplicas().catch(() => undefined);
  }, delayMs);
}

export function installAutomaticAccountSync(): void {
  if (automaticSyncInstalled || typeof window === "undefined") return;
  automaticSyncInstalled = true;
  window.addEventListener("narrarium:account-local-changed", (event) => {
    if (event instanceof CustomEvent && event.detail?.logical === false) return;
    scheduleAccountSync();
  });
  window.addEventListener("offline", () => {
    const state = useConnectionStore.getState();
    for (const kind of activeBackendKinds()) void state.updateReplica(kind, { status: "offline", errorKind: "offline", lastAttemptAtUtc: new Date().toISOString() });
  });
  window.addEventListener("online", () => scheduleAccountSync(500));
}
