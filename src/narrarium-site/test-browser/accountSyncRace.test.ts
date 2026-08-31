import { beforeEach, describe, expect, it, vi } from "vitest";
import "fake-indexeddb/auto";
import { closeAccountLocalStoreForTests, initializeAccountLocalStore, loadLocalAccountSnapshot, saveLocalAccountClipboard } from "@/account/accountLocalStore";
import { useConnectionStore } from "@/account/connectionStore";
import { syncOneAccountReplica, useAccountSyncStore } from "@/account/accountSync";
import { ACCOUNT_SYNC_SCHEMA_VERSION } from "@/account/types";
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
});
