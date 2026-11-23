import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import "fake-indexeddb/auto";

vi.mock("@/config/publicClients", () => ({ GITHUB_APP_CLIENT_ID: "Iv1.client-id", GITHUB_APP_SLUG: "narrarium", GOOGLE_CLIENT_ID: "g", MICROSOFT_CLIENT_ID: "m" }));

import { closeAccountLocalStoreForTests, initializeAccountLocalStore, loadLocalSyncConfiguration } from "@/account/accountLocalStore";
import { projectSyncableSettings, sensitiveAccountData } from "@/account/dataProjection";
import { useConnectionStore } from "@/account/connectionStore";
import { resetBrokerAvailabilityForTests } from "@/account/credentialBroker";
import { closeCredentialVaultForTests, loadRefreshToken } from "@/account/credentialVault";
import { isDeviceLocalSecret, resetDeviceLocalSecretsForTests } from "@/account/deviceSecrets";
import { normalizeSyncableAccountData } from "@/account/serialization";
import { resetGitHubAppTokenForTests } from "@/account/githubAppToken";
import { resetTokenRefreshLockForTests } from "@/account/tokenRefreshLock";
import { emptyCostsFile } from "@/costs/model";
import { currentConnectedGitHubToken, setConnectedGitHubToken } from "@/github/githubCredentialRuntime";
import { DEFAULT_SETTINGS, type AppSettings } from "@/types/settings";
import { BROKER_BASE, SECRETS, createFakeNetwork, deleteDatabases, dumpIndexedDb, jsonResponse, spyOnConsole, type FakeNetwork } from "./oauthTestKit";

let net: FakeNetwork;
const ACCOUNT = "4242";
const APP_TOKEN = SECRETS.access;
const connectApp = (patch: Record<string, unknown> = {}) => useConnectionStore.getState().connectGitHub({
  method: "github-app", credentialKind: "app", identity: { provider: "github", providerAccountId: ACCOUNT, displayName: "W", username: "writer" },
  token: APP_TOKEN, accessTokenExpiry: Date.now() + 3_600_000, refreshToken: SECRETS.refresh, rememberMe: true, accountSyncEnabled: false, repositoryOwner: "writer", ...patch,
});
const settingsWith = (patch: Record<string, unknown>): AppSettings => ({
  ...DEFAULT_SETTINGS,
  defaultGitHubToken: "ghp_default_pat",
  extraGitHubTokens: [{ label: "work", token: "ghp_named_pat" }],
  books: [{ id: "b1", owner: "me", repo: "one", name: "One", tokenIndex: null, bookToken: "ghp_book_pat", addedAt: "2026-11-01T00:00:00.000Z" }],
  ...patch,
} as AppSettings);

beforeEach(async () => {
  closeAccountLocalStoreForTests();
  closeCredentialVaultForTests();
  await deleteDatabases("narrarium-local-account", "narrarium-credential-vault");
  localStorage.clear();
  sessionStorage.clear();
  resetBrokerAvailabilityForTests();
  resetTokenRefreshLockForTests();
  resetGitHubAppTokenForTests();
  resetDeviceLocalSecretsForTests();
  setConnectedGitHubToken(undefined);
  net = createFakeNetwork();
  vi.stubGlobal("fetch", net.fetch);
  vi.stubEnv("VITE_AUTH_BROKER_BASE", BROKER_BASE);
  await initializeAccountLocalStore({ settings: DEFAULT_SETTINGS, costs: emptyCostsFile(), clipboard: [], chats: [] });
  useConnectionStore.setState({ hydrated: true, configuration: {} });
});
afterEach(() => { resetGitHubAppTokenForTests(); vi.unstubAllGlobals(); vi.unstubAllEnvs(); closeCredentialVaultForTests(); });

describe("the GitHub App's tokens never enter the synced account data", () => {
  it("are device-local secrets as soon as the connection holds them, and forgotten with it", async () => {
    await connectApp();
    expect(isDeviceLocalSecret(APP_TOKEN)).toBe(true);
    expect(isDeviceLocalSecret("ghp_default_pat")).toBe(false);
    await useConnectionStore.getState().disconnect("github");
    expect(isDeviceLocalSecret(APP_TOKEN)).toBe(false);
  });

  it("the projected data of a normal account holds the PATs (as ever) and no app token and no refresh token", async () => {
    await connectApp();
    const projected = JSON.stringify([projectSyncableSettings(settingsWith({})), sensitiveAccountData(settingsWith({}))]);
    expect(projected).toContain("ghp_default_pat");
    expect(projected).toContain("ghp_named_pat");
    expect(projected).toContain("ghp_book_pat");
    for (const secret of [APP_TOKEN, SECRETS.refresh]) expect(projected).not.toContain(secret);
  });

  it("FAILS if a copy of the app token reaches a field that IS synced: the default, a named or a book's own token are emptied", async () => {
    await connectApp();
    const mistaken = settingsWith({ defaultGitHubToken: APP_TOKEN, extraGitHubTokens: [{ label: "app", token: APP_TOKEN }, { label: "work", token: "ghp_named_pat" }] });
    mistaken.books = [{ ...mistaken.books[0], bookToken: APP_TOKEN }];
    const projected = projectSyncableSettings(mistaken);
    const sensitive = sensitiveAccountData(mistaken);
    const everything = JSON.stringify([projected, sensitive, normalizeSyncableAccountData({ schemaVersion: 1, settings: mistaken, costs: emptyCostsFile(), clipboard: [], chats: [] })]);
    expect(everything).not.toContain(APP_TOKEN);
    expect(projected.defaultGitHubToken).toBe("");
    expect(projected.extraGitHubTokens.map((entry) => entry.token)).toEqual(["", "ghp_named_pat"]);
    expect(projected.books[0]).not.toHaveProperty("bookToken");
    expect(sensitive.bookTokens).toEqual({});
  });

  it("a token that is not one of the device's secrets is left alone", async () => {
    await connectApp();
    expect(projectSyncableSettings(settingsWith({ defaultGitHubToken: "ghp_other" })).defaultGitHubToken).toBe("ghp_other");
  });

  it("the preference to use the connection is a plain flag and does travel", () => {
    expect(projectSyncableSettings(settingsWith({ githubPreferConnection: true })).githubPreferConnection).toBe(true);
  });

  it("the refresh token is in the sealed vault only: not in the device database, not in storage, not in the debug or error output", async () => {
    const consoleSpy = spyOnConsole();
    await connectApp();
    await expect(loadRefreshToken("github", ACCOUNT)).resolves.toBe(SECRETS.refresh);
    const everything = [JSON.stringify({ ...localStorage }), JSON.stringify({ ...sessionStorage }), await dumpIndexedDb("narrarium-local-account"), await dumpIndexedDb("narrarium-credential-vault")].join("\n");
    expect(everything).not.toContain(SECRETS.refresh);
    expect((await loadLocalSyncConfiguration()).github?.refreshToken).toBeUndefined();
    expect(consoleSpy.output()).not.toContain(SECRETS.refresh);
    expect(consoleSpy.output()).not.toContain(APP_TOKEN);
  });
});

describe("disconnecting GitHub", () => {
  const REFRESH = `${BROKER_BASE}/oauth/github/refresh`;
  const REVOKE = `${BROKER_BASE}/oauth/github/revoke`;

  it("refreshes first (GitHub revokes by a LIVE token), revokes the grant at the broker, then forgets everything", async () => {
    net.reply("POST", REFRESH, { accessToken: "at-SENTINEL-live", expiresIn: 28_800, refreshToken: "rt-SENTINEL-rotated" });
    net.reply("POST", REVOKE, null, 204);
    await connectApp({ accessTokenExpiry: Date.now() - 1_000 });

    await useConnectionStore.getState().disconnect("github");

    expect(net.broker("/oauth/github/revoke")[0].body).toEqual({ token: "at-SENTINEL-live" });
    expect(net.calls.map((call) => call.url)).toEqual([REFRESH, REVOKE]);
    expect(useConnectionStore.getState().configuration.github).toBeUndefined();
    await expect(loadRefreshToken("github", ACCOUNT)).resolves.toBeNull();
    expect(currentConnectedGitHubToken()).toBe("");
    expect((await loadLocalSyncConfiguration()).github).toBeUndefined();
  });

  it("a revoke that fails (even a refresh that fails too) never keeps the connection", async () => {
    net.on("POST", REFRESH, () => { throw new TypeError("offline"); });
    net.reply("POST", REVOKE, { error: "upstream_error", message: "x" }, 502);
    await connectApp();
    await expect(useConnectionStore.getState().disconnect("github")).resolves.toBeUndefined();
    expect(useConnectionStore.getState().configuration.github).toBeUndefined();
    await expect(loadRefreshToken("github", ACCOUNT)).resolves.toBeNull();
    expect(net.broker("/oauth/github/revoke")[0].body).toEqual({ token: APP_TOKEN });
  });

  it("is gone from the device BEFORE the broker is asked", async () => {
    let seen: unknown = "unset";
    net.on("POST", REFRESH, () => { seen = useConnectionStore.getState().configuration.github; return jsonResponse({ accessToken: "a", expiresIn: 1, refreshToken: "r" }); });
    net.reply("POST", REVOKE, null, 204);
    await connectApp({ accessTokenExpiry: Date.now() - 1_000 });
    await useConnectionStore.getState().disconnect("github");
    expect(seen).toBeUndefined();
  });

  it("a personal access token connection is forgotten without calling the broker", async () => {
    await useConnectionStore.getState().connectGitHub({ method: "github-pat", credentialKind: "pat", token: "ghp_pat", identity: { provider: "github", providerAccountId: "1", displayName: "W", username: "w" }, rememberMe: true, accountSyncEnabled: true, repositoryOwner: "w" });
    await useConnectionStore.getState().disconnect("github");
    expect(net.calls).toHaveLength(0);
    expect(useConnectionStore.getState().configuration.github).toBeUndefined();
  });
});
