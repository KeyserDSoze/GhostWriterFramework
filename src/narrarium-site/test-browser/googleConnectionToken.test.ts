import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import "fake-indexeddb/auto";
import { closeAccountLocalStoreForTests, initializeAccountLocalStore, loadLocalSyncConfiguration, saveLocalSyncConfiguration } from "@/account/accountLocalStore";
import { AccountCredentialError, persistedConfiguration, useConnectionStore } from "@/account/connectionStore";
import { BrokerError, resetBrokerAvailabilityForTests } from "@/account/credentialBroker";
import { closeCredentialVaultForTests, loadRefreshToken } from "@/account/credentialVault";
import { acquireGoogleConnectionToken } from "@/account/googleConnectionToken";
import { resetTokenRefreshLockForTests } from "@/account/tokenRefreshLock";
import { registeredCloudAccount } from "@/drive/cloudWriteBarrier";
import { emptyCostsFile } from "@/costs/model";
import { useAuthStore } from "@/store/authStore";
import { DEFAULT_SETTINGS } from "@/types/settings";
import { BROKER_BASE, SECRETS, createFakeNetwork, deleteDatabases, installFakeLocks, jsonResponse, spyOnConsole, type FakeLocks, type FakeNetwork } from "./oauthTestKit";

const REFRESH_URL = `${BROKER_BASE}/oauth/google/refresh`;
let net: FakeNetwork;
let locks: FakeLocks | null = null;

const connect = (patch: Record<string, unknown> = {}) => useConnectionStore.getState().connectGoogle({
  identity: { provider: "google", providerAccountId: "g-1", displayName: "Writer", email: "writer@example.com" },
  accessToken: SECRETS.access,
  accessTokenExpiry: Date.now() + 3_000_000,
  rememberMe: true,
  refreshToken: SECRETS.refresh,
  ...patch,
});
const connection = () => useConnectionStore.getState().configuration.google!;
const refreshAnswer = (extra: Record<string, unknown> = {}) => ({ accessToken: SECRETS.accessFresh, expiresIn: 3599, scope: "openid", ...extra });

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
  await initializeAccountLocalStore({ settings: DEFAULT_SETTINGS, costs: emptyCostsFile(), clipboard: [], chats: [] });
  useConnectionStore.setState({ hydrated: true, configuration: {} });
});

afterEach(() => {
  locks?.uninstall();
  locks = null;
  vi.useRealTimers();
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
  closeCredentialVaultForTests();
});

describe("a Google connection without long-lived credentials behaves exactly as before", () => {
  it("hands back the token it has while it is still valid, without any request", async () => {
    await connect({ refreshToken: undefined });
    await expect(acquireGoogleConnectionToken()).resolves.toBe(SECRETS.access);
    expect(net.calls).toHaveLength(0);
  });

  it("is happy with a token that has less than a minute left: only an expired one is refused", async () => {
    await connect({ refreshToken: undefined, accessTokenExpiry: Date.now() + 30_000 });
    await expect(acquireGoogleConnectionToken()).resolves.toBe(SECRETS.access);
  });

  it("trusts a token whose expiry was never recorded", async () => {
    await connect({ refreshToken: undefined, accessTokenExpiry: undefined });
    await expect(acquireGoogleConnectionToken()).resolves.toBe(SECRETS.access);
  });

  it("asks to reconnect once the token has expired, and never calls the broker", async () => {
    await connect({ refreshToken: undefined, accessTokenExpiry: Date.now() - 1 });
    const error = await acquireGoogleConnectionToken().catch((cause: unknown) => cause);
    expect(error).toBeInstanceOf(AccountCredentialError);
    expect(error).toMatchObject({ backend: "google-drive", reason: "expired" });
    expect(net.calls).toHaveLength(0);
  });

  it("reports a missing connection or a missing token", async () => {
    await expect(acquireGoogleConnectionToken()).rejects.toMatchObject({ backend: "google-drive", reason: "missing" });
    await connect({ refreshToken: undefined, accessToken: undefined });
    await expect(acquireGoogleConnectionToken()).rejects.toMatchObject({ backend: "google-drive", reason: "missing" });
  });
});

describe("a Google connection with a refresh token", () => {
  it("uses the access token it has while it has at least a minute of life left, without asking the broker", async () => {
    await connect();
    await expect(acquireGoogleConnectionToken()).resolves.toBe(SECRETS.access);
    expect(net.calls).toHaveLength(0);
  });

  it.each([
    ["has already expired", () => Date.now() - 1_000],
    ["has less than a minute left", () => Date.now() + 30_000],
    ["has no recorded expiry", () => undefined],
  ])("asks the broker for a new access token when the current one %s", async (_label, expiry) => {
    net.reply("POST", REFRESH_URL, refreshAnswer());
    await connect({ accessTokenExpiry: expiry() });

    await expect(acquireGoogleConnectionToken()).resolves.toBe(SECRETS.accessFresh);

    expect(net.broker("/oauth/google/refresh")).toHaveLength(1);
    expect(net.broker("/oauth/google/refresh")[0].body).toEqual({ refreshToken: SECRETS.refresh });
  });

  it("saves the new token and its expiry, here and on the device, and keeps the refresh token (Google does not rotate it)", async () => {
    net.reply("POST", REFRESH_URL, refreshAnswer());
    await connect({ accessTokenExpiry: Date.now() - 1_000 });
    const before = Date.now();

    await acquireGoogleConnectionToken();

    expect(connection()).toMatchObject({ accessToken: SECRETS.accessFresh, refreshToken: SECRETS.refresh });
    expect(connection().accessTokenExpiry!).toBeGreaterThanOrEqual(before + 3_000_000);
    expect(connection().accessTokenExpiry!).toBeLessThanOrEqual(Date.now() + 3_599_000);
    expect((await loadLocalSyncConfiguration()).google).toMatchObject({ accessToken: SECRETS.accessFresh });
    await expect(loadRefreshToken("google", "g-1")).resolves.toBe(SECRETS.refresh);
  });

  it("takes a new refresh token if the broker ever sends one", async () => {
    net.reply("POST", REFRESH_URL, refreshAnswer({ refreshToken: SECRETS.refreshRotated }));
    await connect({ accessTokenExpiry: Date.now() - 1_000 });
    await acquireGoogleConnectionToken();
    expect(connection().refreshToken).toBe(SECRETS.refreshRotated);
    await expect(loadRefreshToken("google", "g-1")).resolves.toBe(SECRETS.refreshRotated);
  });

  it("renews even a token that looks valid when the last sync was refused for an expired login, or when told to", async () => {
    net.reply("POST", REFRESH_URL, refreshAnswer());
    await connect({ replica: { enabled: true, status: "needs-auth", errorKind: "credential-expired" } });
    await expect(acquireGoogleConnectionToken()).resolves.toBe(SECRETS.accessFresh);

    net.reply("POST", REFRESH_URL, refreshAnswer({ accessToken: "at-second" }));
    await connect();
    await expect(acquireGoogleConnectionToken({ force: true })).resolves.toBe("at-second");
    expect(net.broker("/oauth/google/refresh")).toHaveLength(2);
  });

  it("registers the new token for the right account and refreshes the app login when it is the same account", async () => {
    net.reply("POST", REFRESH_URL, refreshAnswer());
    await connect({ accessTokenExpiry: Date.now() - 1_000 });
    useAuthStore.setState({ user: { provider: "google", providerAccountId: "g-1", name: "Writer", email: "writer@example.com", picture: "" }, accessToken: SECRETS.access, accessTokenExpiry: Date.now() - 1, provider: "google", providerAccountId: "g-1" });

    await acquireGoogleConnectionToken();

    expect(registeredCloudAccount("google", SECRETS.accessFresh)).toBe("g-1");
    expect(useAuthStore.getState().accessToken).toBe(SECRETS.accessFresh);
  });

  it("does not touch the app login of a different account", async () => {
    net.reply("POST", REFRESH_URL, refreshAnswer());
    await connect({ accessTokenExpiry: Date.now() - 1_000 });
    useAuthStore.setState({ user: { provider: "google", providerAccountId: "someone-else", name: "Other", email: "other@example.com", picture: "" }, accessToken: "their-token", accessTokenExpiry: Date.now() + 100_000, provider: "google", providerAccountId: "someone-else" });

    await acquireGoogleConnectionToken();

    expect(useAuthStore.getState().accessToken).toBe("their-token");
  });
});

describe("when Google or the broker refuses or cannot be reached", () => {
  it("asks to reconnect on invalid_grant, forgets the dead refresh token, and keeps the connection", async () => {
    net.reply("POST", REFRESH_URL, { error: "invalid_grant", message: "x" }, 400);
    await connect({ accessTokenExpiry: Date.now() - 1_000 });

    const error = await acquireGoogleConnectionToken().catch((cause: unknown) => cause);

    expect(error).toBeInstanceOf(AccountCredentialError);
    expect(error).toMatchObject({ backend: "google-drive", reason: "expired" });
    expect(connection()).toBeDefined();
    expect(connection().refreshToken).toBeUndefined();
    await expect(loadRefreshToken("google", "g-1")).resolves.toBeNull();

    net.reset();
    await expect(acquireGoogleConnectionToken()).rejects.toMatchObject({ reason: "expired" });
    expect(net.calls).toHaveLength(0);
  });

  it("asks to reconnect when the broker is no longer configured, but keeps the token for when it comes back", async () => {
    net.reply("POST", REFRESH_URL, { error: "not_configured", message: "x" }, 501);
    await connect({ accessTokenExpiry: Date.now() - 1_000 });

    await expect(acquireGoogleConnectionToken()).rejects.toMatchObject({ backend: "google-drive", reason: "expired" });

    expect(connection().refreshToken).toBe(SECRETS.refresh);
    await expect(loadRefreshToken("google", "g-1")).resolves.toBe(SECRETS.refresh);
  });

  it.each([
    ["the network is down", "network", undefined],
    ["the broker answers 502", "upstream", () => jsonResponse({ error: "upstream_error", message: "x" }, 502)],
    ["the broker answers 504", "upstream", () => jsonResponse({ error: "upstream_timeout", message: "x" }, 504)],
    ["the broker rate-limits", "rate_limited", () => jsonResponse({ error: "rate_limited", message: "x" }, 429, { "Retry-After": "30" })],
  ])("reports a passing problem, not a lost login, when %s, and deletes nothing", async (_label, code, answer) => {
    if (answer) net.on("POST", REFRESH_URL, answer);
    await connect({ accessTokenExpiry: Date.now() - 1_000 });
    const staleExpiry = connection().accessTokenExpiry;

    const error = await acquireGoogleConnectionToken().catch((cause: unknown) => cause);

    expect(error).toBeInstanceOf(BrokerError);
    expect(error).not.toBeInstanceOf(AccountCredentialError);
    expect((error as BrokerError).code).toBe(code);
    expect(connection()).toMatchObject({ accessToken: SECRETS.access, accessTokenExpiry: staleExpiry, refreshToken: SECRETS.refresh });
    await expect(loadRefreshToken("google", "g-1")).resolves.toBe(SECRETS.refresh);
    expect((await loadLocalSyncConfiguration()).google).toMatchObject({ accessToken: SECRETS.access });
  });

  it("can try again right away after a passing problem", async () => {
    await connect({ accessTokenExpiry: Date.now() - 1_000 });
    await expect(acquireGoogleConnectionToken()).rejects.toBeInstanceOf(BrokerError);
    net.reply("POST", REFRESH_URL, refreshAnswer());
    await expect(acquireGoogleConnectionToken()).resolves.toBe(SECRETS.accessFresh);
  });

  it("never prints a token while doing any of this", async () => {
    const spy = spyOnConsole();
    net.reply("POST", REFRESH_URL, refreshAnswer());
    await connect({ accessTokenExpiry: Date.now() - 1_000 });
    await acquireGoogleConnectionToken();
    net.reply("POST", REFRESH_URL, { error: "invalid_grant", message: `bad ${SECRETS.refresh}` }, 400);
    await connect({ accessTokenExpiry: Date.now() - 1_000 });
    await acquireGoogleConnectionToken().catch(() => undefined);
    expect(spy.count()).toBe(0);
  });
});

describe("renewing once, however many callers ask", () => {
  it("sends a single request when two syncs ask at the same time, and both get the new token", async () => {
    locks = installFakeLocks();
    net.on("POST", REFRESH_URL, async () => { await new Promise((resolve) => setTimeout(resolve, 20)); return jsonResponse(refreshAnswer()); });
    await connect({ accessTokenExpiry: Date.now() - 1_000 });

    const tokens = await Promise.all([acquireGoogleConnectionToken(), acquireGoogleConnectionToken(), acquireGoogleConnectionToken()]);

    expect(tokens).toEqual([SECRETS.accessFresh, SECRETS.accessFresh, SECRETS.accessFresh]);
    expect(net.broker("/oauth/google/refresh")).toHaveLength(1);
    expect(locks.requests.every((request) => request.name === "narrarium-token-refresh:google" && request.mode === "exclusive")).toBe(true);
    expect(locks.requests.length).toBeGreaterThanOrEqual(1);
  });

  it("still sends a single request when the browser has no Web Locks", async () => {
    net.on("POST", REFRESH_URL, async () => { await new Promise((resolve) => setTimeout(resolve, 20)); return jsonResponse(refreshAnswer()); });
    await connect({ accessTokenExpiry: Date.now() - 1_000 });
    await expect(Promise.all([acquireGoogleConnectionToken(), acquireGoogleConnectionToken()])).resolves.toEqual([SECRETS.accessFresh, SECRETS.accessFresh]);
    expect(net.broker("/oauth/google/refresh")).toHaveLength(1);
  });

  it("looks at the device again once it has the lock: another tab may have renewed while it waited", async () => {
    locks = installFakeLocks();
    locks.onGranted = async () => {
      await saveLocalSyncConfiguration(persistedConfiguration({ google: { backend: "google-drive", method: "google", identity: { provider: "google", providerAccountId: "g-1", displayName: "Writer" }, accessToken: "at-from-the-other-tab", accessTokenExpiry: Date.now() + 3_000_000, rememberMe: true, replica: { enabled: true, status: "idle" } } }));
    };
    await connect({ accessTokenExpiry: Date.now() - 1_000 });

    await expect(acquireGoogleConnectionToken()).resolves.toBe("at-from-the-other-tab");

    expect(net.calls).toHaveLength(0);
    expect(connection().accessToken).toBe("at-from-the-other-tab");
  });

  it("does not renew twice for two forced requests that were waiting for the same lock", async () => {
    locks = installFakeLocks();
    net.on("POST", REFRESH_URL, async () => { await new Promise((resolve) => setTimeout(resolve, 20)); return jsonResponse(refreshAnswer()); });
    await connect();

    const tokens = await Promise.all([acquireGoogleConnectionToken({ force: true }), acquireGoogleConnectionToken({ force: true })]);

    expect(tokens).toEqual([SECRETS.accessFresh, SECRETS.accessFresh]);
    expect(net.broker("/oauth/google/refresh")).toHaveLength(1);
  });

  it("lets the next caller try again after a failed renewal released the lock", async () => {
    locks = installFakeLocks();
    await connect({ accessTokenExpiry: Date.now() - 1_000 });
    await expect(acquireGoogleConnectionToken()).rejects.toBeInstanceOf(BrokerError);
    net.reply("POST", REFRESH_URL, refreshAnswer());
    await expect(acquireGoogleConnectionToken()).resolves.toBe(SECRETS.accessFresh);
  });
});
