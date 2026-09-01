import { beforeEach, describe, expect, it, vi } from "vitest";
import "fake-indexeddb/auto";
import { closeAccountLocalStoreForTests, initializeAccountLocalStore, loadLocalAccountSnapshot, saveLocalAccountClipboard } from "@/account/accountLocalStore";
import { useConnectionStore } from "@/account/connectionStore";
import { classifyAccountSyncError, scheduleAccountSync, syncOneAccountReplica, useAccountSyncStore } from "@/account/accountSync";
import { ACCOUNT_SYNC_SCHEMA_VERSION } from "@/account/types";
import { DEFAULT_SETTINGS } from "@/types/settings";
import { emptyCostsFile } from "@/costs/model";

const github = vi.hoisted(() => ({ pull: vi.fn(), push: vi.fn(), remove: vi.fn() }));
const microsoftToken = vi.hoisted(() => ({ acquire: vi.fn() }));
const drives = vi.hoisted(() => ({
  google: { pull: vi.fn(), push: vi.fn(), remove: vi.fn() },
  microsoft: { pull: vi.fn(), push: vi.fn(), remove: vi.fn() },
}));
vi.mock("@/account/sync/githubBackend", () => ({
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
});
