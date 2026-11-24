import { beforeEach, describe, expect, it, vi } from "vitest";
import "fake-indexeddb/auto";
import { closeAccountLocalStoreForTests, initializeAccountLocalStore, loadLocalAccountSnapshot, saveLocalAccountClipboard } from "@/account/accountLocalStore";
import { useConnectionStore } from "@/account/connectionStore";
import { classifyAccountSyncError, scheduleAccountSync, syncAllAccountReplicas, syncOneAccountReplica, useAccountSyncStore } from "@/account/accountSync";
import { GitHubAccountRepositoryUnreachableError } from "@/account/sync/githubBackend";
import { ACCOUNT_SYNC_SCHEMA_VERSION, type AccountRemoteSnapshot, type AccountSyncBackendKind } from "@/account/types";
import { DEFAULT_SETTINGS } from "@/types/settings";
import { emptyCostsFile } from "@/costs/model";

const github = vi.hoisted(() => ({ pull: vi.fn(), push: vi.fn(), remove: vi.fn() }));
const microsoftToken = vi.hoisted(() => ({ acquire: vi.fn() }));
const drives = vi.hoisted(() => ({
  google: { pull: vi.fn(), push: vi.fn(), remove: vi.fn() },
  microsoft: { pull: vi.fn(), push: vi.fn(), remove: vi.fn() },
}));
vi.mock("@/account/sync/githubBackend", () => ({
  GitHubAccountRepositoryUnreachableError: class extends Error {
    readonly code = "GITHUB_ACCOUNT_REPOSITORY_UNREACHABLE";
  },
  GitHubAccountSyncBackend: class {
    kind = "github" as const;
    pull = github.pull;
    push = github.push;
    deleteRemoteData = github.remove;
  },
}));
vi.mock("@/account/microsoftConnectionToken", () => ({ acquireMicrosoftConnectionToken: microsoftToken.acquire }));
vi.mock("@/account/sync/driveBackend", () => ({
  DriveAccountSyncBackend: class {
    readonly kind: "google-drive" | "onedrive";
    constructor(private readonly provider: "google" | "microsoft") {
      this.kind = provider === "google" ? "google-drive" : "onedrive";
    }
    pull = (...args: unknown[]) => drives[this.provider].pull(...args);
    push = (...args: unknown[]) => drives[this.provider].push(...args);
    deleteRemoteData = (...args: unknown[]) => drives[this.provider].remove(...args);
  },
}));

describe("account synchronization races", () => {
  beforeEach(async () => {
    closeAccountLocalStoreForTests();
    await new Promise<void>((resolve) => {
      const request = indexedDB.deleteDatabase("narrarium-local-account");
      request.onsuccess = () => resolve();
      request.onerror = () => resolve();
    });
    localStorage.clear();
    useAccountSyncStore.setState({ syncing: false, reconciliation: null });
    useConnectionStore.setState({ hydrated: true, configuration: {} });
    github.pull.mockReset();
    github.push.mockReset();
    github.remove.mockReset();
    microsoftToken.acquire.mockReset().mockResolvedValue("microsoft-token");
    for (const backend of Object.values(drives)) {
      backend.pull.mockReset();
      backend.push.mockReset();
      backend.remove.mockReset();
    }
    await initializeAccountLocalStore({ settings: DEFAULT_SETTINGS, costs: emptyCostsFile(), clipboard: [], chats: [] });
    await saveLocalAccountClipboard([{ id: "base", text: "base", at: "2026-08-31T12:00:00.000Z" }]);
    await useConnectionStore.getState().connectGitHub({ method: "github-pat", credentialKind: "pat", identity: { provider: "github", providerAccountId: "1", displayName: "Writer", username: "writer" }, token: "token", rememberMe: true, accountSyncEnabled: true });
  });

  it("does not mark a newer local snapshot clean after an older remote write completes", async () => {
    github.pull.mockResolvedValue(null);
    let release!: () => void;
    github.push.mockImplementation(() => new Promise<{ revision: string }>((resolve) => { release = () => resolve({ revision: "remote" }); }));
    const sync = syncOneAccountReplica("github");
    await vi.waitFor(() => expect(github.push).toHaveBeenCalledOnce());
    await saveLocalAccountClipboard([{ id: "new", text: "newer", at: "2026-08-31T12:01:00.000Z" }]);
    release();
    await sync;
    const current = await loadLocalAccountSnapshot();
    expect(current?.dirty).toBe(true);
    expect(current?.data.schemaVersion).toBe(ACCOUNT_SYNC_SCHEMA_VERSION);
    expect(current?.data.clipboard[0]?.text).toBe("newer");
    expect(useConnectionStore.getState().configuration.github?.replica.status).toBe("dirty");
  });

  it("reports an explicit single-replica failure to the caller", async () => {
    github.pull.mockRejectedValue(new TypeError("network unavailable"));
    github.push.mockRejectedValue(new TypeError("network unavailable"));
    await expect(syncOneAccountReplica("github")).rejects.toThrow("GitHub sync failed (network): network unavailable");
    expect(useConnectionStore.getState().configuration.github?.replica).toMatchObject({ status: "error", errorKind: "network" });
  });

  it("marks an HTTP authentication failure as needing reauthentication", async () => {
    github.pull.mockRejectedValue(Object.assign(new Error("GitHub account request: 401"), { status: 401 }));

    await expect(syncOneAccountReplica("github")).rejects.toThrow("GitHub sync failed (credential-expired): GitHub account request: 401");
    expect(github.pull).toHaveBeenCalledOnce();
    expect(useConnectionStore.getState().configuration.github?.replica).toMatchObject({ status: "needs-auth", errorKind: "credential-expired" });
  });

  it("does not run another provider from a pending automatic sync after an explicit OneDrive sync", async () => {
    await useConnectionStore.getState().connectGoogle({
      identity: { provider: "google", providerAccountId: "google-1", displayName: "Google Writer" },
      accessToken: "google-token",
      accessTokenExpiry: Date.now() + 60_000,
      rememberMe: true,
    });
    await useConnectionStore.getState().connectMicrosoft({
      identity: { provider: "microsoft", providerAccountId: "microsoft-1", displayName: "Microsoft Writer" },
      accessToken: "microsoft-token",
      accessTokenExpiry: Date.now() + 60_000,
      homeAccountId: "microsoft-1",
      localAccountId: "local-1",
      rememberMe: true,
    });
    drives.microsoft.pull.mockResolvedValue(null);
    drives.microsoft.push.mockResolvedValue({ revision: "onedrive-1" });

    const clearTimeoutSpy = vi.spyOn(globalThis, "clearTimeout");
    try {
      scheduleAccountSync(60_000);
      await syncOneAccountReplica("onedrive");
      expect(clearTimeoutSpy).toHaveBeenCalledOnce();
    } finally {
      clearTimeoutSpy.mockRestore();
    }

    expect(drives.microsoft.pull).toHaveBeenCalledOnce();
    expect(drives.microsoft.push).toHaveBeenCalledOnce();
    expect(drives.google.pull).not.toHaveBeenCalled();
    expect(drives.google.push).not.toHaveBeenCalled();
  });

  it("classifies an HTTP 304 reported in an untyped provider error", () => {
    expect(classifyAccountSyncError(new Error("OneDrive folder lookup: 304"))).toBe("cache-revalidation");
  });
  describe("with every account connected (GitHub, Google Drive and OneDrive)", () => {
    async function connectAll() {
      await useConnectionStore.getState().connectGoogle({ identity: { provider: "google", providerAccountId: "google-1", displayName: "G" }, accessToken: "google-token", accessTokenExpiry: Date.now() + 60_000, rememberMe: true });
      await useConnectionStore.getState().connectMicrosoft({ identity: { provider: "microsoft", providerAccountId: "microsoft-1", displayName: "M" }, accessToken: "microsoft-token", homeAccountId: "microsoft-1", localAccountId: "local-1", rememberMe: true });
    }
    /** What a service holds when this device has changed the data since: an older version of the same account. */
    async function olderCopy(backend: AccountSyncBackendKind): Promise<AccountRemoteSnapshot> {
      const current = (await loadLocalAccountSnapshot())!;
      return { backend, data: current.data, manifest: { ...current.manifest, snapshotId: "older", vectorClock: {}, contentHash: undefined }, revision: `rev-${backend}`, format: "current" };
    }
    const pulls = () => [github.pull, drives.google.pull, drives.microsoft.pull];
    const pushes = () => [github.push, drives.google.push, drives.microsoft.push];
    beforeEach(async () => {
      await connectAll();
      for (const push of pushes()) push.mockResolvedValue({ revision: "new" });
    });

    it("pushes a change to every active service", async () => {
      github.pull.mockResolvedValue(await olderCopy("github"));
      drives.google.pull.mockResolvedValue(await olderCopy("google-drive"));
      drives.microsoft.pull.mockResolvedValue(await olderCopy("onedrive"));

      const result = await syncAllAccountReplicas();

      expect(result.synced.sort()).toEqual(["github", "google-drive", "onedrive"]);
      for (const push of pushes()) expect(push).toHaveBeenCalledOnce();
      expect(github.push.mock.calls[0][1]).toMatchObject({ snapshotId: "older", revision: "rev-github" });
      for (const kind of ["google", "microsoft", "github"] as const) expect(useConnectionStore.getState().configuration[kind]?.replica).toMatchObject({ status: "idle", errorKind: undefined });
    });

    it("creates the copy on a service that has none, and updates the others", async () => {
      github.pull.mockResolvedValue(null);
      drives.google.pull.mockResolvedValue(await olderCopy("google-drive"));
      drives.microsoft.pull.mockResolvedValue(null);

      const result = await syncAllAccountReplicas();

      expect(result.synced.sort()).toEqual(["github", "google-drive", "onedrive"]);
      expect(github.push.mock.calls[0][1]).toEqual({ absent: true });
      expect(drives.microsoft.push.mock.calls[0][1]).toEqual({ absent: true });
      expect(drives.google.push.mock.calls[0][1]).toMatchObject({ snapshotId: "older" });
    });

    it("keeps syncing the other services when one of them fails to be written", async () => {
      github.pull.mockResolvedValue(null);
      drives.google.pull.mockResolvedValue(null);
      drives.microsoft.pull.mockResolvedValue(null);
      github.push.mockRejectedValue(Object.assign(new Error("GitHub is down"), { status: 500 }));

      const result = await syncAllAccountReplicas();

      expect(result.synced.sort()).toEqual(["google-drive", "onedrive"]);
      expect(drives.google.push).toHaveBeenCalledOnce();
      expect(drives.microsoft.push).toHaveBeenCalledOnce();
      const { configuration } = useConnectionStore.getState();
      expect(configuration.github?.replica).toMatchObject({ status: "error" });
      expect(configuration.google?.replica).toMatchObject({ status: "idle", errorKind: undefined });
      expect(configuration.microsoft?.replica).toMatchObject({ status: "idle", errorKind: undefined });
    });

    it("keeps syncing the other services when one of them cannot be read", async () => {
      github.pull.mockRejectedValue(new TypeError("network unavailable"));
      drives.google.pull.mockResolvedValue(await olderCopy("google-drive"));
      drives.microsoft.pull.mockResolvedValue(null);

      const result = await syncAllAccountReplicas();

      expect(result.synced.sort()).toEqual(["google-drive", "onedrive"]);
      expect(github.push).not.toHaveBeenCalled();
      expect(useConnectionStore.getState().configuration.github?.replica).toMatchObject({ status: "error", errorKind: "network" });
    });

    describe("when the GitHub app cannot create or reach narrarium.settings", () => {
      const refused = () => new GitHubAccountRepositoryUnreachableError("create-refused");

      it("is told apart from a permission error, and the other services are not held back", async () => {
        expect(classifyAccountSyncError(refused())).toBe("repository-unreachable");
        github.pull.mockResolvedValue(null);
        drives.google.pull.mockResolvedValue(null);
        drives.microsoft.pull.mockResolvedValue(null);
        github.push.mockRejectedValue(refused());

        const result = await syncAllAccountReplicas();

        expect(result.synced.sort()).toEqual(["google-drive", "onedrive"]);
        expect(useConnectionStore.getState().configuration.github?.replica).toMatchObject({ status: "error", errorKind: "repository-unreachable" });
        expect(useConnectionStore.getState().configuration.google?.replica.status).toBe("idle");
      });

      it("is not tried again by the automatic sync, but «Sync now» tries once more", async () => {
        github.pull.mockRejectedValue(refused());
        drives.google.pull.mockResolvedValue(null);
        drives.microsoft.pull.mockResolvedValue(null);
        await expect(syncOneAccountReplica("github")).rejects.toMatchObject({ kind: "repository-unreachable" });
        expect(github.pull).toHaveBeenCalledTimes(1);

        const { installAccountDirtyPropagation } = await import("@/account/connectionStore");
        installAccountDirtyPropagation();
        window.dispatchEvent(new CustomEvent("narrarium:account-local-changed"));
        scheduleAccountSync(0);
        await vi.waitFor(() => expect(drives.google.push).toHaveBeenCalled());
        scheduleAccountSync(0);
        await vi.waitFor(() => expect(drives.google.pull.mock.calls.length).toBeGreaterThanOrEqual(2));
        expect(github.pull).toHaveBeenCalledTimes(1);
        expect(useConnectionStore.getState().configuration.github?.replica).toMatchObject({ status: "error", errorKind: "repository-unreachable" });

        github.pull.mockResolvedValue(null);
        await syncOneAccountReplica("github");
        expect(github.pull).toHaveBeenCalledTimes(2);
        expect(useConnectionStore.getState().configuration.github?.replica).toMatchObject({ status: "idle", errorKind: undefined });
      });
    });
  });
});
