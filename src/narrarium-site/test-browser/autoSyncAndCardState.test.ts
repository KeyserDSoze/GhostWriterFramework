import { describe, expect, it } from "vitest";
import { autoSyncAll, effectiveAutoSync, migrateAutoModes, replicaAutoMode, withAutoMode, withAutoSyncAll } from "@/account/autoSync";
import { canCheckNow, primarySyncAction, syncCardState, type SyncCardInput } from "@/account/syncCardState";
import type { LocalGoogleConnection, LocalGitHubConnection, LocalMicrosoftConnection, LocalSyncConfiguration, LocalReplicaState } from "@/account/types";

const base: SyncCardInput = { connected: true, enabled: true, status: "idle", localDirty: false, lastCheck: "2026-11-27T09:30:00.000Z" };

describe("what a card says about its sync", () => {
  it("is «all synced» only when nothing waits, with the time of the last check, and offers no primary action", () => {
    const state = syncCardState(base);
    expect(state).toEqual({ kind: "all-synced", lastCheck: base.lastCheck });
    expect(primarySyncAction(state)).toBeNull();
    expect(canCheckNow(state)).toBe(true);
  });

  it.each([
    ["changes of this device not sent", { localDirty: true }, "local-changes"],
    ["a replica marked dirty", { status: "dirty" }, "local-changes"],
    ["a replica ahead", { status: "ahead" }, "local-changes"],
    ["newer data on the service", { status: "behind" }, "remote-newer"],
    ["different copies", { status: "diverged" }, "different-copies"],
    ["never synced", { lastCheck: undefined }, "never-synced"],
  ] as const)("makes «Sync» the primary action for %s", (_name, change, reason) => {
    const state = syncCardState({ ...base, ...change });
    expect(state).toEqual({ kind: "pending", reason });
    expect(primarySyncAction(state)).toBe("sync");
  });

  it("makes «Try again» the primary action after an error, and none while the sign-in or a sync is first", () => {
    expect(primarySyncAction(syncCardState({ ...base, status: "error", errorKind: "network" }))).toBe("try-again");
    expect(syncCardState({ ...base, status: "needs-auth", errorKind: "credential-missing" })).toEqual({ kind: "sign-in" });
    expect(primarySyncAction({ kind: "sign-in" })).toBeNull();
    expect(syncCardState({ ...base, status: "syncing" })).toEqual({ kind: "syncing" });
    expect(canCheckNow({ kind: "syncing" })).toBe(false);
    expect(syncCardState({ ...base, status: "offline" })).toEqual({ kind: "offline" });
  });

  it("is off or not connected without any action", () => {
    expect(syncCardState({ ...base, enabled: false, status: "disabled" })).toEqual({ kind: "off" });
    expect(syncCardState({ ...base, connected: false })).toEqual({ kind: "not-connected" });
    expect(canCheckNow({ kind: "off" })).toBe(false);
  });
});

const replica = (enabled: boolean, autoMode?: LocalReplicaState["autoMode"]): LocalReplicaState => ({ enabled, status: enabled ? "idle" : "disabled", ...(autoMode ? { autoMode } : {}) });
const google = (r: LocalReplicaState): LocalGoogleConnection => ({ backend: "google-drive", method: "google", identity: { provider: "google", providerAccountId: "g", displayName: "G" }, rememberMe: false, replica: r });
const microsoft = (r: LocalReplicaState): LocalMicrosoftConnection => ({ backend: "onedrive", method: "microsoft", identity: { provider: "microsoft", providerAccountId: "m", displayName: "M" }, homeAccountId: "m", localAccountId: "m", rememberMe: false, replica: r });
const github = (r: LocalReplicaState): LocalGitHubConnection => ({ backend: "github", method: "github-pat", credentialKind: "pat", identity: { provider: "github", providerAccountId: "1", displayName: "W", username: "w" }, rememberMe: false, accountSyncEnabled: r.enabled, repositoryOwner: "w", repositoryName: "narrarium.settings", replica: r } as LocalGitHubConnection);

describe("the automatic sync of all the services and of each one", () => {
  it("is on unless the person turned it off, and a service that is set by itself overrides it", () => {
    expect(autoSyncAll({})).toBe(true);
    expect(autoSyncAll({ autoSyncAll: false })).toBe(false);
    expect(effectiveAutoSync("inherit", false)).toBe(false);
    expect(effectiveAutoSync("on", false)).toBe(true);
    expect(effectiveAutoSync("off", true)).toBe(false);
  });

  it("keeps today's value of a connection that has no mode as its own setting (the migration)", () => {
    const configuration: LocalSyncConfiguration = { google: google(replica(true)), microsoft: microsoft(replica(false)), github: github(replica(true, "inherit")) };
    const migrated = migrateAutoModes(configuration);
    expect(migrated.google?.replica).toMatchObject({ enabled: true, autoMode: "on" });
    expect(migrated.microsoft?.replica).toMatchObject({ enabled: false, autoMode: "off" });
    expect(migrated.github?.replica.autoMode).toBe("inherit");
    // Turning the general setting off changes nothing for the ones that kept their value; a second migration changes nothing.
    const off = withAutoSyncAll(migrated, false);
    expect(off.google?.replica.enabled).toBe(true);
    expect(off.microsoft?.replica.enabled).toBe(false);
    expect(off.github?.replica.enabled).toBe(false);
    expect(migrateAutoModes(migrated)).toBe(migrated);
    expect(replicaAutoMode(replica(true))).toBe("on");
  });

  it("lets the general setting move the services that follow it, and only them", () => {
    const configuration: LocalSyncConfiguration = { google: google(replica(true, "inherit")), microsoft: microsoft(replica(true, "on")), github: github(replica(false, "off")) };
    const off = withAutoSyncAll(configuration, false);
    expect(off.autoSyncAll).toBe(false);
    expect(off.google?.replica).toMatchObject({ enabled: false, status: "disabled", autoMode: "inherit" });
    expect(off.microsoft?.replica.enabled).toBe(true);
    expect(off.github?.replica.enabled).toBe(false);
    const on = withAutoSyncAll(off, true);
    expect(on.google?.replica).toMatchObject({ enabled: true, status: "dirty" });
    expect(on.github?.replica.enabled).toBe(false);
  });

  it("sets one service by itself, or back to follow the general setting, and keeps the flag of GitHub in step", () => {
    const configuration: LocalSyncConfiguration = { autoSyncAll: false, google: google(replica(false, "inherit")), github: github(replica(false, "inherit")) };
    const own = withAutoMode(configuration, "google-drive", "on");
    expect(own.google?.replica).toMatchObject({ enabled: true, autoMode: "on" });
    expect(withAutoMode(own, "google-drive", "inherit").google?.replica).toMatchObject({ enabled: false, autoMode: "inherit" });
    const gh = withAutoMode(configuration, "github", "on");
    expect(gh.github).toMatchObject({ accountSyncEnabled: true, replica: { enabled: true } });
    expect(withAutoMode(configuration, "onedrive", "on")).toBe(configuration);
  });
});
