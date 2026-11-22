import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import "fake-indexeddb/auto";
import { closeAccountLocalStoreForTests, initializeAccountLocalStore, loadLocalSyncConfiguration } from "@/account/accountLocalStore";
import { AccountCredentialError, useConnectionStore } from "@/account/connectionStore";
import { BrokerError, resetBrokerAvailabilityForTests } from "@/account/credentialBroker";
import { closeCredentialVaultForTests, loadRefreshToken } from "@/account/credentialVault";
import { acquireMicrosoftConnectionToken } from "@/account/microsoftConnectionToken";
import { resetTokenRefreshLockForTests } from "@/account/tokenRefreshLock";
import { registeredCloudAccount } from "@/drive/cloudWriteBarrier";
import { emptyCostsFile } from "@/costs/model";
import { useAuthStore } from "@/store/authStore";
import { DEFAULT_SETTINGS } from "@/types/settings";
import { BROKER_BASE, SECRETS, createFakeNetwork, deleteDatabases, installFakeLocks, jsonResponse, type FakeLocks, type FakeNetwork } from "./oauthTestKit";

const msal = vi.hoisted(() => {
  const client = { getAllAccounts: vi.fn(), acquireTokenSilent: vi.fn(), setActiveAccount: vi.fn() };
  return { client, instance: vi.fn(() => client), initialize: vi.fn(), silentRequest: vi.fn((account: unknown) => ({ account, scopes: ["User.Read", "Files.ReadWrite"] })) };
});

vi.mock("@/config/msal", () => ({
  microsoftMsalInstance: msal.instance,
  ensureMsalInitialized: msal.initialize,
  microsoftSilentRequest: msal.silentRequest,
  findMicrosoftAccountIn: (input: { homeAccountId?: string; localAccountId?: string }, accounts: Array<{ homeAccountId: string; localAccountId: string }>) =>
    accounts.find((account) => account.homeAccountId === input.homeAccountId && account.localAccountId === input.localAccountId) ?? null,
}));

const REFRESH_URL = `${BROKER_BASE}/oauth/microsoft/refresh`;
const HOME = "11111111-2222-3333-4444-555555555555.9188040d-6c67-4c5b-b112-36a304b66dad";
const LOCAL = "11111111-2222-3333-4444-555555555555";
let net: FakeNetwork;
let locks: FakeLocks | null = null;

const clientInfo = (uid: string, utid: string) => Buffer.from(JSON.stringify({ uid, utid })).toString("base64url");
const connect = (patch: Record<string, unknown> = {}) => useConnectionStore.getState().connectMicrosoft({
  identity: { provider: "microsoft", providerAccountId: HOME, displayName: "Writer", email: "writer@example.com" },
  homeAccountId: HOME,
  localAccountId: LOCAL,
  accessToken: SECRETS.access,
  accessTokenExpiry: Date.now() - 1_000,
  rememberMe: true,
  refreshToken: SECRETS.refresh,
  ...patch,
});
const connection = () => useConnectionStore.getState().configuration.microsoft!;
const answer = (extra: Record<string, unknown> = {}) => ({ accessToken: SECRETS.accessFresh, expiresIn: 3599, refreshToken: SECRETS.refreshRotated, clientInfo: clientInfo(LOCAL, HOME.split(".")[1]), ...extra });

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
  useAuthStore.setState({ accessToken: null, accessTokenExpiry: null, provider: null, providerAccountId: null, user: null, rememberMe: false });
  msal.instance.mockClear().mockReturnValue(msal.client);
  msal.initialize.mockReset().mockResolvedValue(undefined);
  msal.silentRequest.mockClear();
  msal.client.getAllAccounts.mockReset().mockReturnValue([]);
  msal.client.acquireTokenSilent.mockReset();
  msal.client.setActiveAccount.mockReset();
  await initializeAccountLocalStore({ settings: DEFAULT_SETTINGS, costs: emptyCostsFile(), clipboard: [], chats: [] });
  useConnectionStore.setState({ hydrated: true, configuration: {} });
});

afterEach(() => {
  locks?.uninstall();
  locks = null;
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
  closeCredentialVaultForTests();
});

describe("OneDrive with long-lived credentials renews through the broker, not through MSAL", () => {
  it("asks the broker when the access token has expired, and never touches MSAL", async () => {
    net.reply("POST", REFRESH_URL, answer());
    await connect();

    await expect(acquireMicrosoftConnectionToken()).resolves.toBe(SECRETS.accessFresh);

    expect(net.broker("/oauth/microsoft/refresh")[0].body).toEqual({ refreshToken: SECRETS.refresh });
    expect(msal.instance).not.toHaveBeenCalled();
    expect(msal.client.acquireTokenSilent).not.toHaveBeenCalled();
  });

  it("uses a token that still has a minute of life without any request", async () => {
    await connect({ accessTokenExpiry: Date.now() + 3_000_000 });
    await expect(acquireMicrosoftConnectionToken()).resolves.toBe(SECRETS.access);
    expect(net.calls).toHaveLength(0);
    expect(msal.client.acquireTokenSilent).not.toHaveBeenCalled();
  });

  it("always saves the refresh token Microsoft hands back, and uses that one next time", async () => {
    net.reply("POST", REFRESH_URL, answer());
    await connect();
    await acquireMicrosoftConnectionToken();

    expect(connection().refreshToken).toBe(SECRETS.refreshRotated);
    await expect(loadRefreshToken("microsoft", HOME)).resolves.toBe(SECRETS.refreshRotated);

    net.reply("POST", REFRESH_URL, answer({ accessToken: "at-third", refreshToken: "rt-third" }));
    await acquireMicrosoftConnectionToken({ force: true });

    expect(net.broker("/oauth/microsoft/refresh")[1].body).toEqual({ refreshToken: SECRETS.refreshRotated });
    expect(connection().refreshToken).toBe("rt-third");
    await expect(loadRefreshToken("microsoft", HOME)).resolves.toBe("rt-third");
  });

  it("keeps the refresh token it has when Microsoft sends none", async () => {
    net.reply("POST", REFRESH_URL, answer({ refreshToken: undefined }));
    await connect();
    await acquireMicrosoftConnectionToken();
    expect(connection().refreshToken).toBe(SECRETS.refresh);
  });

  it("saves the new access token and expiry on the device and keeps the secrets out of the device database", async () => {
    net.reply("POST", REFRESH_URL, answer());
    await connect();
    await acquireMicrosoftConnectionToken();

    const stored = (await loadLocalSyncConfiguration()).microsoft!;
    expect(stored.accessToken).toBe(SECRETS.accessFresh);
    expect(stored.accessTokenExpiry!).toBeGreaterThan(Date.now());
    expect(JSON.stringify(stored)).not.toContain(SECRETS.refreshRotated);
  });

  it("registers the token for the connected account and refreshes the app login of that account", async () => {
    net.reply("POST", REFRESH_URL, answer());
    await connect();
    useAuthStore.setState({ user: { provider: "microsoft", providerAccountId: HOME, name: "Writer", email: "writer@example.com", picture: "", homeAccountId: HOME, localAccountId: LOCAL }, accessToken: SECRETS.access, accessTokenExpiry: Date.now() - 1, provider: "microsoft", providerAccountId: HOME });

    await acquireMicrosoftConnectionToken();

    expect(registeredCloudAccount("microsoft", SECRETS.accessFresh)).toBe(HOME.toLowerCase());
    expect(useAuthStore.getState().accessToken).toBe(SECRETS.accessFresh);
  });

  it("refuses tokens that belong to another Microsoft account, and stores none of them", async () => {
    net.reply("POST", REFRESH_URL, answer({ clientInfo: clientInfo("99999999-8888-7777-6666-555555555555", "72f988bf-86f1-41af-91ab-2d7cd011db47") }));
    await connect();

    await expect(acquireMicrosoftConnectionToken()).rejects.toMatchObject({ backend: "onedrive", reason: "expired" });

    expect(connection()).toMatchObject({ accessToken: SECRETS.access, refreshToken: SECRETS.refresh });
  });

  it("asks to reconnect on invalid_grant and drops the dead refresh token", async () => {
    net.reply("POST", REFRESH_URL, { error: "invalid_grant", message: "x" }, 400);
    await connect();

    const error = await acquireMicrosoftConnectionToken().catch((cause: unknown) => cause);

    expect(error).toBeInstanceOf(AccountCredentialError);
    expect(error).toMatchObject({ backend: "onedrive", reason: "expired" });
    expect(connection().refreshToken).toBeUndefined();
    await expect(loadRefreshToken("microsoft", HOME)).resolves.toBeNull();
  });

  it.each([
    ["the network is down", "network", undefined],
    ["the broker answers 502", "upstream", () => jsonResponse({ error: "upstream_error", message: "x" }, 502)],
  ])("reports a passing problem, not a lost login, when %s", async (_label, code, reply) => {
    if (reply) net.on("POST", REFRESH_URL, reply);
    await connect();

    const error = await acquireMicrosoftConnectionToken().catch((cause: unknown) => cause);

    expect(error).toBeInstanceOf(BrokerError);
    expect((error as BrokerError).code).toBe(code);
    expect(connection().refreshToken).toBe(SECRETS.refresh);
    await expect(loadRefreshToken("microsoft", HOME)).resolves.toBe(SECRETS.refresh);
  });

  it("renews once when several syncs ask together", async () => {
    locks = installFakeLocks();
    net.on("POST", REFRESH_URL, async () => { await new Promise((resolve) => setTimeout(resolve, 20)); return jsonResponse(answer()); });
    await connect();

    const tokens = await Promise.all([acquireMicrosoftConnectionToken(), acquireMicrosoftConnectionToken()]);

    expect(tokens).toEqual([SECRETS.accessFresh, SECRETS.accessFresh]);
    expect(net.broker("/oauth/microsoft/refresh")).toHaveLength(1);
    expect(locks.requests[0]).toEqual({ name: "narrarium-token-refresh:microsoft", mode: "exclusive" });
  });
});

describe("a OneDrive connection made with MSAL keeps working as before", () => {
  const account = { homeAccountId: HOME, localAccountId: LOCAL, username: "writer@example.com" };

  it("still goes through MSAL when it has no refresh token, even while the broker is available", async () => {
    net.reply("GET", `${BROKER_BASE}/oauth/status`, { google: true, microsoft: true });
    msal.client.getAllAccounts.mockReturnValue([account]);
    msal.client.acquireTokenSilent.mockResolvedValue({ accessToken: "msal-token", expiresOn: new Date(Date.now() + 3_600_000), account });
    await connect({ refreshToken: undefined });

    await expect(acquireMicrosoftConnectionToken()).resolves.toBe("msal-token");

    expect(msal.client.acquireTokenSilent).toHaveBeenCalledTimes(1);
    expect(net.broker("/oauth/microsoft/refresh")).toHaveLength(0);
  });
});
