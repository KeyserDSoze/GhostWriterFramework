import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import "fake-indexeddb/auto";
import { closeAccountLocalStoreForTests, initializeAccountLocalStore } from "@/account/accountLocalStore";
import { useConnectionStore } from "@/account/connectionStore";
import { classifyAccountSyncError, syncOneAccountReplica, useAccountSyncStore } from "@/account/accountSync";
import { BrokerError, resetBrokerAvailabilityForTests } from "@/account/credentialBroker";
import { closeCredentialVaultForTests, loadRefreshToken } from "@/account/credentialVault";
import { resetTokenRefreshLockForTests } from "@/account/tokenRefreshLock";
import { summarizeSyncStatus } from "@/account/syncStatus";
import { emptyCostsFile } from "@/costs/model";
import { DEFAULT_SETTINGS } from "@/types/settings";
import { BROKER_BASE, SECRETS, createFakeNetwork, deleteDatabases, jsonResponse, type FakeNetwork } from "./oauthTestKit";

const drives = vi.hoisted(() => ({
  constructed: [] as Array<{ provider: string; token: string; account: string }>,
  google: { pull: vi.fn(), push: vi.fn(), remove: vi.fn() },
  microsoft: { pull: vi.fn(), push: vi.fn(), remove: vi.fn() },
}));
vi.mock("@/account/sync/driveBackend", () => ({
  DriveAccountSyncBackend: class {
    readonly kind: "google-drive" | "onedrive";
    constructor(private readonly provider: "google" | "microsoft", token: string, account: string) {
      this.kind = provider === "google" ? "google-drive" : "onedrive";
      drives.constructed.push({ provider, token, account });
    }
    pull = (...args: unknown[]) => drives[this.provider].pull(...args);
    push = (...args: unknown[]) => drives[this.provider].push(...args);
    deleteRemoteData = (...args: unknown[]) => drives[this.provider].remove(...args);
  },
}));
vi.mock("@/account/sync/githubBackend", () => ({ GitHubAccountSyncBackend: class {} }));

const HOME = "11111111-2222-3333-4444-555555555555.9188040d-6c67-4c5b-b112-36a304b66dad";
let net: FakeNetwork;

const connectGoogle = (patch: Record<string, unknown> = {}) => useConnectionStore.getState().connectGoogle({
  identity: { provider: "google", providerAccountId: "g-1", displayName: "Writer" },
  accessToken: SECRETS.access,
  accessTokenExpiry: Date.now() - 1_000,
  rememberMe: true,
  refreshToken: SECRETS.refresh,
  ...patch,
});
const connectMicrosoft = (patch: Record<string, unknown> = {}) => useConnectionStore.getState().connectMicrosoft({
  identity: { provider: "microsoft", providerAccountId: HOME, displayName: "Writer" },
  homeAccountId: HOME,
  localAccountId: HOME.split(".")[0],
  accessToken: SECRETS.access,
  accessTokenExpiry: Date.now() - 1_000,
  rememberMe: true,
  refreshToken: SECRETS.refresh,
  ...patch,
});
const googleReplica = () => useConnectionStore.getState().configuration.google!.replica;
const microsoftReplica = () => useConnectionStore.getState().configuration.microsoft!.replica;

beforeEach(async () => {
  closeAccountLocalStoreForTests();
  closeCredentialVaultForTests();
  await deleteDatabases("narrarium-local-account", "narrarium-credential-vault");
  localStorage.clear();
  sessionStorage.clear();
  resetBrokerAvailabilityForTests();
  resetTokenRefreshLockForTests();
  net = createFakeNetwork();
  vi.stubGlobal("fetch", net.fetch);
  vi.stubEnv("VITE_AUTH_BROKER_BASE", BROKER_BASE);
  useAccountSyncStore.setState({ syncing: false, reconciliation: null });
  useConnectionStore.setState({ hydrated: true, configuration: {} });
  drives.constructed.length = 0;
  for (const backend of [drives.google, drives.microsoft]) {
    backend.pull.mockReset().mockResolvedValue(null);
    backend.push.mockReset().mockResolvedValue({ revision: "r1" });
    backend.remove.mockReset();
  }
  await initializeAccountLocalStore({ settings: DEFAULT_SETTINGS, costs: emptyCostsFile(), clipboard: [], chats: [] });
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
  closeCredentialVaultForTests();
});

describe("syncing with long-lived credentials", () => {
  it("renews an expired Google token on its own and then syncs with it", async () => {
    net.reply("POST", `${BROKER_BASE}/oauth/google/refresh`, { accessToken: SECRETS.accessFresh, expiresIn: 3599 });
    await connectGoogle();

    await syncOneAccountReplica("google-drive");

    expect(drives.constructed).toEqual([{ provider: "google", token: SECRETS.accessFresh, account: "g-1" }]);
    expect(drives.google.push).toHaveBeenCalledTimes(1);
    expect(googleReplica()).toMatchObject({ status: "idle" });
  });

  it("renews an expired OneDrive token on its own, rotating the refresh token, and then syncs with it", async () => {
    net.reply("POST", `${BROKER_BASE}/oauth/microsoft/refresh`, { accessToken: SECRETS.accessFresh, expiresIn: 3599, refreshToken: SECRETS.refreshRotated, clientInfo: Buffer.from(JSON.stringify({ uid: HOME.split(".")[0], utid: HOME.split(".")[1] })).toString("base64url") });
    await connectMicrosoft();

    await syncOneAccountReplica("onedrive");

    expect(drives.constructed).toEqual([{ provider: "microsoft", token: SECRETS.accessFresh, account: HOME }]);
    expect(microsoftReplica()).toMatchObject({ status: "idle" });
    await expect(loadRefreshToken("microsoft", HOME)).resolves.toBe(SECRETS.refreshRotated);
  });

  it("does not ask the broker when the token is still good", async () => {
    await connectGoogle({ accessTokenExpiry: Date.now() + 3_000_000 });
    await syncOneAccountReplica("google-drive");
    expect(net.calls).toHaveLength(0);
    expect(drives.constructed[0].token).toBe(SECRETS.access);
  });
});

describe("a refresh token that stopped working", () => {
  it("marks Google as needing the login (needs-auth) and the header indicator invites to reconnect", async () => {
    net.reply("POST", `${BROKER_BASE}/oauth/google/refresh`, { error: "invalid_grant", message: "x" }, 400);
    await connectGoogle();

    await expect(syncOneAccountReplica("google-drive")).rejects.toThrow(/credential-expired/);

    expect(googleReplica()).toMatchObject({ status: "needs-auth", errorKind: "credential-expired" });
    expect(drives.constructed).toHaveLength(0);
    const summary = summarizeSyncStatus({ configuration: useConnectionStore.getState().configuration, syncing: false, deviceOffline: false });
    expect(summary).toMatchObject({ state: "needs-login", focus: { backend: "google-drive" } });
  });

  it("marks OneDrive as needing the login too", async () => {
    net.reply("POST", `${BROKER_BASE}/oauth/microsoft/refresh`, { error: "invalid_grant", message: "x" }, 400);
    await connectMicrosoft();

    await expect(syncOneAccountReplica("onedrive")).rejects.toThrow(/credential-expired/);

    expect(microsoftReplica()).toMatchObject({ status: "needs-auth", errorKind: "credential-expired" });
    expect(summarizeSyncStatus({ configuration: useConnectionStore.getState().configuration, syncing: false, deviceOffline: false }).state).toBe("needs-login");
  });
});

describe("a problem that is only passing", () => {
  it("leaves the login alone when the network is down: Google is in error, not needs-auth, and nothing is deleted", async () => {
    await connectGoogle();

    await expect(syncOneAccountReplica("google-drive")).rejects.toThrow(/network/);

    expect(googleReplica()).toMatchObject({ status: "error", errorKind: "network" });
    expect(useConnectionStore.getState().configuration.google).toMatchObject({ accessToken: SECRETS.access, refreshToken: SECRETS.refresh });
    await expect(loadRefreshToken("google", "g-1")).resolves.toBe(SECRETS.refresh);
    expect(summarizeSyncStatus({ configuration: useConnectionStore.getState().configuration, syncing: false, deviceOffline: false }).state).toBe("failed");
  });

  it("reports the service as offline, as it does today, when the browser itself is offline", async () => {
    vi.spyOn(window.navigator, "onLine", "get").mockReturnValue(false);
    await connectGoogle();

    await expect(syncOneAccountReplica("google-drive")).rejects.toThrow();

    expect(googleReplica()).toMatchObject({ status: "offline", errorKind: "offline" });
  });

  it("is an error, not a lost login, when the broker answers 502", async () => {
    net.reply("POST", `${BROKER_BASE}/oauth/microsoft/refresh`, { error: "upstream_error", message: "Microsoft could not be reached." }, 502);
    await connectMicrosoft();

    await expect(syncOneAccountReplica("onedrive")).rejects.toThrow();

    expect(microsoftReplica()).toMatchObject({ status: "error", errorKind: "network" });
    expect(useConnectionStore.getState().configuration.microsoft?.refreshToken).toBe(SECRETS.refresh);
  });

  it("is rate-limited when the broker says so", async () => {
    net.on("POST", `${BROKER_BASE}/oauth/google/refresh`, () => jsonResponse({ error: "rate_limited", message: "slow down" }, 429, { "Retry-After": "30" }));
    await connectGoogle();
    await expect(syncOneAccountReplica("google-drive")).rejects.toThrow();
    expect(googleReplica()).toMatchObject({ status: "error", errorKind: "rate-limited" });
  });

  it("keeps the explanation shown to the owner free of any token", async () => {
    net.reply("POST", `${BROKER_BASE}/oauth/google/refresh`, { error: "upstream_error", message: `Google rejected ${SECRETS.refresh}` }, 502);
    await connectGoogle();
    await expect(syncOneAccountReplica("google-drive")).rejects.toThrow();
    expect(googleReplica().lastErrorMessage).toBeTruthy();
    expect(JSON.stringify(useConnectionStore.getState().configuration)).not.toContain(`Google rejected ${SECRETS.refresh}`);
    expect(googleReplica().lastErrorMessage).not.toContain(SECRETS.refresh);
  });
});

describe("how broker failures are classified", () => {
  it.each([
    ["invalid_grant", "credential-expired"],
    ["not_configured", "credential-expired"],
    ["rate_limited", "rate-limited"],
    ["upstream", "network"],
    ["network", "network"],
  ] as const)("%s is %s", (code, kind) => {
    expect(classifyAccountSyncError(new BrokerError(code, "Credential broker failed (HTTP 400): says the login is expired and forbidden"))).toBe(kind);
  });
});
