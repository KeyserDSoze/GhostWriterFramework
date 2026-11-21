import { beforeEach, describe, expect, it, vi } from "vitest";
import "fake-indexeddb/auto";
import { closeAccountLocalStoreForTests, initializeAccountLocalStore } from "@/account/accountLocalStore";
import { AccountCredentialError, useConnectionStore } from "@/account/connectionStore";
import { installAutomaticAccountSync, syncOneAccountReplica, useAccountSyncStore } from "@/account/accountSync";
import { DEFAULT_SETTINGS } from "@/types/settings";
import { emptyCostsFile } from "@/costs/model";

const github = vi.hoisted(() => ({ pull: vi.fn(), push: vi.fn(), remove: vi.fn() }));
vi.mock("@/account/sync/githubBackend", () => ({
  GitHubAccountSyncBackend: class {
    kind = "github" as const;
    pull = github.pull;
    push = github.push;
    deleteRemoteData = github.remove;
  },
}));

const replica = () => useConnectionStore.getState().configuration.github?.replica;

describe("the message of the last account sync failure", () => {
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
    await initializeAccountLocalStore({ settings: DEFAULT_SETTINGS, costs: emptyCostsFile(), clipboard: [], chats: [] });
    await useConnectionStore.getState().connectGitHub({ method: "github-pat", credentialKind: "pat", identity: { provider: "github", providerAccountId: "1", displayName: "Writer", username: "writer" }, token: "token", rememberMe: true, accountSyncEnabled: true });
  });

  it("is kept with the error kind, so the owner can read what actually went wrong", async () => {
    github.pull.mockRejectedValue(new Error("GitHub account request: 500"));
    await expect(syncOneAccountReplica("github")).rejects.toThrow("GitHub sync failed (unknown)");
    expect(replica()).toMatchObject({ status: "error", errorKind: "unknown", lastErrorMessage: "GitHub account request: 500" });
  });

  it("is kept for a login that has to be renewed", async () => {
    github.pull.mockRejectedValue(new AccountCredentialError("github", "expired"));
    await expect(syncOneAccountReplica("github")).rejects.toThrow();
    expect(replica()).toMatchObject({ status: "needs-auth", errorKind: "credential-expired", lastErrorMessage: "github credential is expired." });
  });

  it("is cut to a bounded length and on one line", async () => {
    github.pull.mockRejectedValue(new Error(`first line\nsecond line ${"x".repeat(2_000)}`));
    await expect(syncOneAccountReplica("github")).rejects.toThrow();
    expect(replica()?.lastErrorMessage).toHaveLength(300);
    expect(replica()?.lastErrorMessage).toMatch(/^first line second line x+$/);
  });

  it("is cleared by the next successful sync", async () => {
    github.pull.mockRejectedValueOnce(new Error("temporary failure"));
    await expect(syncOneAccountReplica("github")).rejects.toThrow();
    expect(replica()?.lastErrorMessage).toBe("temporary failure");

    github.pull.mockResolvedValue(null);
    github.push.mockResolvedValue({ revision: "commit" });
    await syncOneAccountReplica("github");
    expect(replica()).toMatchObject({ status: "idle" });
    expect(replica()?.errorKind).toBeUndefined();
    expect(replica()?.lastErrorMessage).toBeUndefined();
  });

  it("is cleared when the device goes offline, because the old message no longer explains the state", async () => {
    github.pull.mockRejectedValue(new Error("temporary failure"));
    await expect(syncOneAccountReplica("github")).rejects.toThrow();
    installAutomaticAccountSync();
    window.dispatchEvent(new Event("offline"));
    await vi.waitFor(() => expect(replica()).toMatchObject({ status: "offline", errorKind: "offline" }));
    expect(replica()?.lastErrorMessage).toBeUndefined();
  });
});
