import { beforeEach, describe, expect, it } from "vitest";
import "fake-indexeddb/auto";
import { closeAccountLocalStoreForTests, initializeAccountLocalStore, loadLocalSyncConfiguration } from "@/account/accountLocalStore";
import { useConnectionStore } from "@/account/connectionStore";
import { DEFAULT_SETTINGS } from "@/types/settings";
import { emptyCostsFile } from "@/costs/model";

describe("device-local account connections", () => {
  beforeEach(async () => {
    closeAccountLocalStoreForTests();
    await new Promise<void>((resolve) => {
      const request = indexedDB.deleteDatabase("narrarium-local-account");
      request.onsuccess = () => resolve();
      request.onerror = () => resolve();
    });
    await initializeAccountLocalStore({ settings: DEFAULT_SETTINGS, costs: emptyCostsFile(), clipboard: [], chats: [] });
    useConnectionStore.setState({ hydrated: true, configuration: {} });
  });

  it("persists independent enabled providers without making them exclusive", async () => {
    await useConnectionStore.getState().connectGoogle({ identity: { provider: "google", providerAccountId: "g-1", displayName: "Google" }, accessToken: "google-token", rememberMe: true });
    await useConnectionStore.getState().connectMicrosoft({ identity: { provider: "microsoft", providerAccountId: "m-1", displayName: "Microsoft" }, accessToken: "microsoft-token", homeAccountId: "m-1", localAccountId: "local-m-1", rememberMe: true });
    await useConnectionStore.getState().connectGitHub({ method: "github-pat", credentialKind: "pat", identity: { provider: "github", providerAccountId: "42", displayName: "Writer", username: "writer" }, token: "github-token", rememberMe: true, accountSyncEnabled: true });
    const stored = await loadLocalSyncConfiguration();
    expect(stored.google?.replica.enabled).toBe(true);
    expect(stored.microsoft?.replica.enabled).toBe(true);
    expect(stored.github?.replica.enabled).toBe(true);
  });

  it("does not persist a session-only connector bearer", async () => {
    await useConnectionStore.getState().connectGoogle({ identity: { provider: "google", providerAccountId: "g-1", displayName: "Google" }, accessToken: "session-token", rememberMe: false });
    expect((await loadLocalSyncConfiguration()).google?.accessToken).toBeUndefined();
    expect(useConnectionStore.getState().configuration.google?.accessToken).toBe("session-token");
  });

  it("disconnects one provider without affecting the others", async () => {
    await useConnectionStore.getState().connectGoogle({ identity: { provider: "google", providerAccountId: "g-1", displayName: "Google" }, accessToken: "google-token", rememberMe: true });
    await useConnectionStore.getState().connectGitHub({ method: "github-pat", credentialKind: "pat", token: "github-token", rememberMe: true, accountSyncEnabled: true, repositoryOwner: "writer" });
    await useConnectionStore.getState().disconnect("google-drive");
    const stored = await loadLocalSyncConfiguration();
    expect(stored.google).toBeUndefined();
    expect(stored.github?.token).toBe("github-token");
  });

  it("keeps a connection saved before the general setting as its own setting, then lets the general one move only the ones that follow it", async () => {
    const { saveLocalSyncConfiguration } = await import("@/account/accountLocalStore");
    await saveLocalSyncConfiguration({
      google: { backend: "google-drive", method: "google", identity: { provider: "google", providerAccountId: "g-1", displayName: "G" }, rememberMe: true, accessToken: "t", replica: { enabled: false, status: "disabled" } },
      microsoft: { backend: "onedrive", method: "microsoft", identity: { provider: "microsoft", providerAccountId: "m-1", displayName: "M" }, homeAccountId: "m-1", localAccountId: "m-1", rememberMe: true, accessToken: "t", replica: { enabled: true, status: "idle" } },
    });
    useConnectionStore.setState({ hydrated: false, configuration: {} });
    await useConnectionStore.getState().hydrate();
    expect(useConnectionStore.getState().configuration.google?.replica).toMatchObject({ enabled: false, autoMode: "off" });
    expect(useConnectionStore.getState().configuration.microsoft?.replica).toMatchObject({ enabled: true, autoMode: "on" });
    expect((await loadLocalSyncConfiguration()).microsoft?.replica.autoMode).toBe("on");

    await useConnectionStore.getState().setAutoSyncAll(false);
    expect(useConnectionStore.getState().configuration.microsoft?.replica.enabled).toBe(true);
    expect((await loadLocalSyncConfiguration()).autoSyncAll).toBe(false);

    // A service connected now follows the general setting, which is off: it starts off, and turns on with it.
    await useConnectionStore.getState().connectGitHub({ method: "github-pat", credentialKind: "pat", token: "t", rememberMe: true, accountSyncEnabled: true, repositoryOwner: "writer" });
    expect(useConnectionStore.getState().configuration.github).toMatchObject({ accountSyncEnabled: false, replica: { enabled: false, autoMode: "inherit" } });
    await useConnectionStore.getState().setAutoSyncAll(true);
    expect(useConnectionStore.getState().configuration.github).toMatchObject({ accountSyncEnabled: true, replica: { enabled: true } });
    expect(useConnectionStore.getState().configuration.google?.replica.enabled).toBe(false);

    // The switch of one service sets it by itself; «follow the general setting» gives it back.
    await useConnectionStore.getState().setEnabled("github", false);
    expect(useConnectionStore.getState().configuration.github?.replica).toMatchObject({ enabled: false, autoMode: "off" });
    await useConnectionStore.getState().setAutoMode("github", "inherit");
    expect(useConnectionStore.getState().configuration.github?.replica).toMatchObject({ enabled: true, autoMode: "inherit" });
  });
});
