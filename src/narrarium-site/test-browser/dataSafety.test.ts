import { beforeEach, describe, expect, it } from "vitest";
import "fake-indexeddb/auto";
import { initializeAccountLocalStore, saveLocalAccountSettings } from "@/account/accountLocalStore";
import { getAccountSafetyReport, getBookSafetyReport } from "@/account/dataSafety";
import { useConnectionStore } from "@/account/connectionStore";
import { DEFAULT_SETTINGS } from "@/types/settings";
import { emptyCostsFile } from "@/costs/model";
import { useAuthStore } from "@/store/authStore";
import { createLocalOnlyBookRepository } from "@/repository/repositoryService";
import type { BookEntry } from "@/types/settings";
import { useSettingsStore } from "@/store/settingsStore";
import { localWorkspaceScope } from "@/account/deviceIdentity";

describe("account data safety", () => {
  beforeEach(() => {
    localStorage.clear();
    useConnectionStore.setState({ hydrated: true, configuration: {} });
  });

  it("does not equate a connected replica with a confirmed current copy", async () => {
    const initial = await initializeAccountLocalStore({ settings: DEFAULT_SETTINGS, costs: emptyCostsFile(), clipboard: [], chats: [] });
    await useConnectionStore.getState().connectGitHub({ method: "github-pat", credentialKind: "pat", token: "token", rememberMe: false, accountSyncEnabled: true, repositoryOwner: "writer", replica: { enabled: true, status: "idle", lastKnownRemoteSnapshotId: initial.manifest.snapshotId, lastSuccessfulSyncAtUtc: new Date().toISOString() } });
    expect((await getAccountSafetyReport()).remotelyProtected).toBe(true);
    await saveLocalAccountSettings({ ...DEFAULT_SETTINGS, costCurrency: "EUR" });
    const report = await getAccountSafetyReport();
    expect(report.remotelyProtected).toBe(false);
    expect(report.dirty).toBe(true);
  });

  it("keeps the local account snapshot when a provider session logs out", async () => {
    await initializeAccountLocalStore({ settings: { ...DEFAULT_SETTINGS, costCurrency: "EUR" }, costs: emptyCostsFile(), clipboard: [], chats: [] });
    useAuthStore.setState({ user: { provider: "google", providerAccountId: "sub", name: "Writer", email: "writer@example.test", picture: "" }, accessToken: "token", accessTokenExpiry: Date.now() + 60_000 });
    useAuthStore.getState().clearAuth();
    const report = await getAccountSafetyReport();
    expect(report.snapshotId).toBeTruthy();
    expect(useAuthStore.getState().user).toBeNull();
  });

  it("reports a local-only book as unprotected before destructive actions", async () => {
    const localRepositoryId = crypto.randomUUID();
    const book: BookEntry = { id: crypto.randomUUID(), storageMode: "local-only", localRepositoryId, owner: "", repo: "", name: "Only here", tokenIndex: null, activeBranch: `local:${localRepositoryId}`, addedAt: new Date().toISOString() };
    useSettingsStore.setState({ settings: { ...DEFAULT_SETTINGS, books: [book] }, accountIdentity: localWorkspaceScope() });
    await createLocalOnlyBookRepository({ book });
    await expect(getBookSafetyReport(book.id)).resolves.toMatchObject({ state: "local-only", remotelyProtected: false });
  });
});
