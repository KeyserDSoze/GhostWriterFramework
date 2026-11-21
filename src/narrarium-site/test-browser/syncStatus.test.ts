import { describe, expect, it } from "vitest";
import { needsAttention, summarizeSyncStatus, type SyncIndicatorState } from "@/account/syncStatus";
import type { LocalReplicaState, LocalSyncConfiguration } from "@/account/types";

const replica = (status: LocalReplicaState["status"], patch: Partial<LocalReplicaState> = {}): LocalReplicaState => ({ enabled: true, status, ...patch });

function configuration(replicas: { google?: LocalReplicaState; microsoft?: LocalReplicaState; github?: LocalReplicaState }): LocalSyncConfiguration {
  return {
    ...(replicas.google ? { google: { backend: "google-drive", method: "google", identity: { provider: "google", providerAccountId: "g", displayName: "G" }, rememberMe: true, replica: replicas.google } } : {}),
    ...(replicas.microsoft ? { microsoft: { backend: "onedrive", method: "microsoft", identity: { provider: "microsoft", providerAccountId: "m", displayName: "M" }, homeAccountId: "m", localAccountId: "m", rememberMe: true, replica: replicas.microsoft } } : {}),
    ...(replicas.github ? { github: { backend: "github", method: "github-pat", credentialKind: "pat", rememberMe: true, accountSyncEnabled: true, repositoryName: "narrarium.settings", replica: replicas.github } } : {}),
  } as LocalSyncConfiguration;
}

const summarize = (replicas: Parameters<typeof configuration>[0], flags: { syncing?: boolean; deviceOffline?: boolean } = {}) =>
  summarizeSyncStatus({ configuration: configuration(replicas), syncing: false, deviceOffline: false, ...flags });

describe("what the sync indicator reports", () => {
  it("is hidden when no service syncs this device and the device is online", () => {
    expect(summarize({})).toMatchObject({ visible: false, backends: [] });
    expect(summarize({ google: replica("disabled", { enabled: false }) })).toMatchObject({ visible: false, backends: [] });
  });

  it("lists the enabled services in a stable order, with their names", () => {
    const summary = summarize({ github: replica("idle"), google: replica("idle"), microsoft: replica("idle", { enabled: false }) });
    expect(summary.backends.map(({ backend, name }) => [backend, name])).toEqual([["google-drive", "Google Drive"], ["github", "GitHub"]]);
  });

  it("is synced, with the newest successful sync, when every service is up to date", () => {
    const summary = summarize({ google: replica("idle", { lastSuccessfulSyncAtUtc: "2026-11-21T21:00:00.000Z" }), microsoft: replica("idle", { lastSuccessfulSyncAtUtc: "2026-11-21T21:28:18.893Z" }), github: replica("idle") });
    expect(summary).toMatchObject({ state: "synced", visible: true, lastSyncAtUtc: "2026-11-21T21:28:18.893Z" });
    expect(summary.focus).toBeUndefined();
  });

  it.each(["dirty", "ahead", "behind", "diverged"] as const)("is pending while a service is %s", (status) => {
    expect(summarize({ google: replica("idle"), microsoft: replica(status) }).state).toBe("pending");
  });

  it.each([
    ["needs-auth", "needs-login"],
    ["error", "failed"],
    ["offline", "remote-offline"],
  ] as const)("reports a service that is %s as %s and names it", (status, state) => {
    const summary = summarize({ google: replica("idle"), microsoft: replica(status) });
    expect(summary.state).toBe(state);
    expect(summary.focus?.backend).toBe("onedrive");
  });

  it("puts a login that has to be renewed before a failure, and a failure before an offline service", () => {
    expect(summarize({ google: replica("offline"), microsoft: replica("error"), github: replica("needs-auth") })).toMatchObject({ state: "needs-login", focus: { backend: "github" } });
    expect(summarize({ google: replica("offline"), microsoft: replica("error") })).toMatchObject({ state: "failed", focus: { backend: "onedrive" } });
    expect(summarize({ google: replica("offline"), microsoft: replica("dirty") })).toMatchObject({ state: "remote-offline", focus: { backend: "google-drive" } });
  });

  it("is syncing while the account sync runs or a service says so, whatever else is wrong", () => {
    expect(summarize({ google: replica("error") }, { syncing: true }).state).toBe("syncing");
    expect(summarize({ google: replica("syncing"), microsoft: replica("error") }).state).toBe("syncing");
  });

  it("puts a device that is offline before everything and shows it even with no service", () => {
    expect(summarize({ google: replica("error") }, { deviceOffline: true }).state).toBe("device-offline");
    expect(summarize({ google: replica("syncing") }, { deviceOffline: true, syncing: true }).state).toBe("device-offline");
    expect(summarize({}, { deviceOffline: true })).toMatchObject({ state: "device-offline", visible: true, backends: [] });
  });

  it("asks for attention only for the states the owner has to act on or be told about", () => {
    const attention: SyncIndicatorState[] = ["needs-login", "failed", "remote-offline", "device-offline"];
    const calm: SyncIndicatorState[] = ["synced", "syncing", "pending"];
    expect(attention.every(needsAttention)).toBe(true);
    expect(calm.some(needsAttention)).toBe(false);
  });
});
