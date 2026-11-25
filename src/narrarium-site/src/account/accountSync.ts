import { create } from "zustand";
import { adoptRemoteAccountSnapshot, loadLocalAccountSnapshot, LocalAccountSnapshotChangedError, markLocalAccountReplicaConfirmed, replaceLocalAccountSnapshot, updateLocalAccountManifest } from "@/account/accountLocalStore";
import { AccountCredentialError, useConnectionStore } from "@/account/connectionStore";
import { compareAccountManifests } from "@/account/vectorClock";
import { accountSyncEnvelope } from "@/account/serialization";
import type { AccountRemoteSnapshot, AccountSyncBackend, AccountSyncBackendKind, LocalAccountSnapshot, ReplicaComparison } from "@/account/types";
import type { CostsFile } from "@/costs/model";
import { DriveAccountSyncBackend } from "@/account/sync/driveBackend";
import { useSettingsStore, LOCAL_SETTINGS_SOURCE_SCHEMA_VERSION } from "@/store/settingsStore";
import { useCostsStore } from "@/costs/costsStore";
import { useClipboardStore } from "@/clipboard/clipboardStore";
import { refreshAssistantSessionIndex } from "@/assistant/sessionIndex";
import { localWorkspaceScope } from "@/account/deviceIdentity";
import { mergeLocalDeviceSettings } from "@/account/dataProjection";
import { mergeBranchMemories } from "@/branches/memory";
import { acquireMicrosoftConnectionToken } from "@/account/microsoftConnectionToken";
import { acquireGoogleConnectionToken } from "@/account/googleConnectionToken";
import { acquireGitHubConnectionToken } from "@/account/githubConnectionToken";
import { BrokerError } from "@/account/credentialBroker";
import { requiresSignInRenewal, signInRenewalCode, withoutHelpLinks } from "@/account/signInRenewal";
import { AccountSyncFailure } from "@/account/syncFailure";

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
  // A decision is needed only when copies really conflict: a replica that changed on its own since this device (or since another replica that is
  // newer than this device). Replicas that merely lag behind a newer copy, this device's included, are brought up to date without asking; asking
  // about them put the dialog back after every choice, because the lagging replicas were never written.
  const newer = remotes.filter((remote) => compareAccountManifests(local.manifest, remote.manifest) === "behind");
  const newerConflict = newer.some((left, index) => newer.slice(index + 1).some((right) => compareAccountManifests(left.manifest, right.manifest) === "diverged"));
  if (comparisons.some(({ comparison }) => comparison === "diverged") || newerConflict) return { action: "reconcile", comparisons };
  const newest = newer.find((candidate) => newer.every((other) => other === candidate || compareAccountManifests(candidate.manifest, other.manifest) !== "behind"));
  if (newest) return { action: "pull-remote", comparisons, authoritativeRemote: newest.backend };
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

/**
 * What the automatic sync (a change, going back online, opening the app) runs. A replica whose last failure is one the owner has to fix on GitHub is left
 * out until the owner asks again («Sync now», «Try again», signing in again): asking GitHub the same refused question on every change would only repeat it.
 */
function automaticBackendKinds(): AccountSyncBackendKind[] {
  const github = useConnectionStore.getState().configuration.github?.replica;
  const blocked = github?.status === "error" && github.errorKind === "repository-unreachable";
  return activeBackendKinds().filter((kind) => !(blocked && kind === "github"));
}

async function createBackend(kind: AccountSyncBackendKind): Promise<AccountSyncBackend> {
  const configuration = useConnectionStore.getState().configuration;
  const token = kind === "onedrive" ? await acquireMicrosoftConnectionToken() : kind === "google-drive" ? await acquireGoogleConnectionToken() : await acquireGitHubConnectionToken();
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
  // GitHub's account repository code (and Octokit with it) loads with the first GitHub sync, not with the app shell.
  const { GitHubAccountSyncBackend } = await import("@/account/sync/githubBackend");
  return new GitHubAccountSyncBackend(token, owner, connection.credentialKind);
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

/**
 * The costs to keep when copies meet: whichever copy is kept, the usage ledger is the merge of all of them (by writer: never twice, never lost; see
 * `costs/ledger.ts`), and the legacy totals are made whole again on it. `selected` itself when there is nothing to merge. The merge loads with the
 * first copy that has a ledger.
 */
async function mergedCosts(selected: CostsFile, others: readonly CostsFile[]): Promise<CostsFile> {
  if (!selected.ledger && others.every((other) => !other.ledger)) return selected;
  const { mergeCostsFiles } = await import("@/costs/legacyCosts");
  return mergeCostsFiles(selected, others);
}

const MAX_ERROR_MESSAGE_LENGTH = 300;

function describeAccountSyncError(error: unknown): string | undefined {
  const raw = error instanceof Error ? error.message : typeof error === "string" ? error : "";
  const message = withoutHelpLinks(raw);
  return message ? message.slice(0, MAX_ERROR_MESSAGE_LENGTH) : undefined;
}

/** Records why a replica could not be reached: a lost login needs the owner, anything else is an error or being offline. */
export async function setReplicaFailure(kind: AccountSyncBackendKind, error: unknown): Promise<void> {
  const errorKind = classifyAccountSyncError(error);
  // A renewal that merely timed out while the device has no connection says nothing about the login.
  const renewalTimedOutOffline = navigator.onLine === false && /^(?:timed_out|monitor_window_timeout)$/.test(renewalCodeOf(error) ?? "");
  const patch = !renewalTimedOutOffline && (errorKind === "credential-expired" || errorKind === "credential-missing")
    ? { status: "needs-auth" as const, errorKind }
    : navigator.onLine === false
      ? { status: "offline" as const, errorKind: "offline" as const }
      : { status: "error" as const, errorKind };
  await useConnectionStore.getState().updateReplica(kind, { ...patch, lastErrorMessage: describeAccountSyncError(error), lastAttemptAtUtc: new Date().toISOString() });
}

function renewalCodeOf(error: unknown): string | undefined {
  return error instanceof AccountCredentialError ? error.code : signInRenewalCode(error);
}

const REMOTE_CHANGED_CODE = "GITHUB_ACCOUNT_REPOSITORY_CHANGED";
/** A write that lost the race against another one is repeated from what the service holds now; this many times in a row before it is reported. */
const MAX_LOST_RACES = 3;
const lostRaces = new Map<AccountSyncBackendKind, number>();

function lostRace(error: unknown): boolean {
  return Boolean(error) && typeof error === "object" && (error as { code?: unknown }).code === REMOTE_CHANGED_CODE;
}

export function classifyAccountSyncError(error: unknown) {
  if (error instanceof AccountCredentialError) return error.reason === "expired" ? "credential-expired" as const : "credential-missing" as const;
  // The broker says what it means: only a refused refresh token (or a broker that no longer serves) needs the owner.
  // Everything else is a passing problem and must never be mistaken for a lost login by the heuristics below.
  if (error instanceof BrokerError) return error.code === "rate_limited" ? "rate-limited" as const : error.code === "invalid_grant" || error.code === "not_configured" ? "credential-expired" as const : "network" as const;
  // MSAL (a silent renewal that timed out or needs the owner) and Google's sign-in window say the login has to be renewed.
  if (requiresSignInRenewal(error)) return "credential-expired" as const;
  const value = error && typeof error === "object" ? error as { status?: unknown; code?: unknown; message?: unknown } : {};
  const message = typeof value.message === "string" ? value.message.toLowerCase() : "";
  const statusMatch = message.match(/(?:^|[\s:(])([1-5]\d{2})(?:[\s).]|$)/);
  const status = typeof value.status === "number" ? value.status : statusMatch ? Number(statusMatch[1]) : undefined;
  if (value.code === "GITHUB_ACCOUNT_REPOSITORY_PUBLIC") return "remote-public" as const;
  if (value.code === "GITHUB_ACCOUNT_REPOSITORY_UNREACHABLE") return "repository-unreachable" as const;
  if (value.code === REMOTE_CHANGED_CODE) return "remote-changed" as const;
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

interface AccountSyncResult {
  synced: AccountSyncBackendKind[];
  reconciliation: boolean;
  failures: Map<AccountSyncBackendKind, unknown>;
}

export async function syncAllAccountReplicas(options: { automatic?: boolean } = {}): Promise<{ synced: AccountSyncBackendKind[]; reconciliation: boolean }> {
  const { synced, reconciliation } = await withAccountSyncLock(() => syncAccountReplicas(options.automatic ? automaticBackendKinds() : activeBackendKinds()));
  return { synced, reconciliation };
}

async function syncAccountReplicas(activeKinds: AccountSyncBackendKind[]): Promise<AccountSyncResult> {
  if (useAccountSyncStore.getState().syncing) {
    syncRequestedWhileBusy = true;
    return { synced: [], reconciliation: Boolean(useAccountSyncStore.getState().reconciliation), failures: new Map() };
  }
  useAccountSyncStore.setState({ syncing: true });
  const synced: AccountSyncBackendKind[] = [];
  const failures = new Map<AccountSyncBackendKind, unknown>();
  try {
    let local = await localSnapshotWithHash();
    const backends = new Map<AccountSyncBackendKind, AccountSyncBackend>();
    const remotes: AccountRemoteSnapshot[] = [];
    const missing: AccountSyncBackendKind[] = [];

    await Promise.all(activeKinds.map(async (kind) => {
      try {
        await useConnectionStore.getState().updateReplica(kind, { status: "syncing", lastAttemptAtUtc: new Date().toISOString(), errorKind: undefined, lastErrorMessage: undefined });
        const backend = await createBackend(kind);
        const remote = await backend.pull();
        backends.set(kind, backend);
        if (remote) remotes.push(remote);
        else missing.push(kind);
      } catch (error) {
        failures.set(kind, error);
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
      return { synced, reconciliation: true, failures };
    }

    const newer = plan.action === "pull-remote" ? remotes.find((remote) => remote.backend === plan.authoritativeRemote) : undefined;
    if (newer) {
      // The newer copy is taken; the usage this device recorded is merged into it, and when that adds something the result is a new version of this
      // device (pushed below), so a copy that lost a device's usage (an older client chose another copy whole) gets it back.
      const costs = await mergedCosts(newer.data.costs, [local.data.costs]);
      const data = { ...newer.data, costs, settings: mergeLocalDeviceSettings(local.data.settings, newer.data.settings) };
      local = costs === newer.data.costs
        ? await adoptRemoteAccountSnapshot(data, newer.manifest, `Pulled account data from ${backendLabel(newer.backend)}`, local.manifest.snapshotId)
        : await replaceLocalAccountSnapshot(data, [local.manifest, newer.manifest], `Pulled account data from ${backendLabel(newer.backend)} and kept the usage of this device`, local.manifest.snapshotId);
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
          lastErrorMessage: undefined,
        });
        lostRaces.delete(kind);
        await markLocalAccountReplicaConfirmed(local.manifest.snapshotId);
        useCostsStore.getState().markSynced(useCostsStore.getState().revision);
        useClipboardStore.getState().markSynced(useClipboardStore.getState().revision);
        synced.push(kind);
      } catch (error) {
        if (lostRace(error) && (lostRaces.get(kind) ?? 0) < MAX_LOST_RACES) {
          // Nothing is wrong: someone else wrote first. The next round reads what is there now and decides again (pull, reconcile or push).
          lostRaces.set(kind, (lostRaces.get(kind) ?? 0) + 1);
          syncRequestedWhileBusy = true;
          await useConnectionStore.getState().updateReplica(kind, { status: "dirty", errorKind: undefined, lastErrorMessage: undefined });
          continue;
        }
        failures.set(kind, error);
        await setReplicaFailure(kind, error);
      }
    }
    useAccountSyncStore.getState().setReconciliation(null);
    return { synced, reconciliation: false, failures };
  } catch (error) {
    if (error instanceof LocalAccountSnapshotChangedError) {
      syncRequestedWhileBusy = true;
      return { synced, reconciliation: false, failures };
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

/**
 * The data a resolved divergence keeps: the copy the person chose, with this device's own fields put back, and for each book the memory of its branches
 * that changed last among all the copies (last write wins per book: a branch chosen on one device is not lost because another copy was preferred).
 */
export function reconciledAccountData(request: Pick<AccountReconciliationRequest, "local" | "remotes">, authoritative: "local" | AccountSyncBackendKind): LocalAccountSnapshot["data"] {
  const selected = authoritative === "local" ? request.local : request.remotes.find((remote) => remote.backend === authoritative);
  if (!selected) throw new Error("The selected account replica is unavailable.");
  const settings = authoritative === "local" ? selected.data.settings : mergeLocalDeviceSettings(request.local.data.settings, selected.data.settings);
  const branchMemory = mergeBranchMemories(selected.data.settings.branchMemory, request.local.data.settings.branchMemory, ...request.remotes.map((remote) => remote.data.settings.branchMemory));
  return { ...selected.data, settings: branchMemory ? { ...settings, branchMemory } : settings };
}

export async function resolveAccountReconciliation(authoritative: "local" | AccountSyncBackendKind): Promise<void> {
  const request = useAccountSyncStore.getState().reconciliation;
  if (!request) return;
  const allManifests = [request.local.manifest, ...request.remotes.map((remote) => remote.manifest)];
  const chosen = reconciledAccountData(request, authoritative);
  // The person chooses which copy to keep; what every copy recorded of the usage is kept whatever the choice.
  const selected = authoritative === "local" ? request.local : request.remotes.find((remote) => remote.backend === authoritative);
  const copies = [request.local, ...request.remotes].filter((copy) => copy !== selected).map((copy) => copy.data.costs);
  const data = { ...chosen, costs: await mergedCosts(chosen.costs, copies) };
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
  const failure = result.failures.get(kind);
  if (failure) {
    const detail = withoutHelpLinks(failure instanceof Error ? failure.message : String(failure));
    throw new AccountSyncFailure(kind, classifyAccountSyncError(failure), `${backendLabel(kind)} sync failed (${classifyAccountSyncError(failure)}): ${detail}`);
  }
  const configuration = useConnectionStore.getState().configuration;
  const replica = kind === "google-drive" ? configuration.google?.replica : kind === "onedrive" ? configuration.microsoft?.replica : configuration.github?.replica;
  if (replica?.status === "error" || replica?.status === "offline" || replica?.status === "needs-auth") {
    throw new AccountSyncFailure(kind, replica.errorKind ?? "unknown", `${backendLabel(kind)} sync failed (${replica.errorKind ?? replica.status}).`);
  }
}

async function withAccountSyncLock<T>(run: () => Promise<T>): Promise<T> {
  if (typeof navigator !== "undefined" && navigator.locks) return navigator.locks.request("narrarium-account-sync", { mode: "exclusive" }, run);
  return run();
}

export async function deleteRemoteAccountData(kind: AccountSyncBackendKind): Promise<void> {
  const backend = await createBackend(kind);
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
    if (navigator.onLine !== false) void syncAllAccountReplicas({ automatic: true }).catch(() => undefined);
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
    for (const kind of activeBackendKinds()) void state.updateReplica(kind, { status: "offline", errorKind: "offline", lastErrorMessage: undefined, lastAttemptAtUtc: new Date().toISOString() });
  });
  window.addEventListener("online", () => scheduleAccountSync(500));
}
