import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import "fake-indexeddb/auto";
import { closeAccountLocalStoreForTests, initializeAccountLocalStore, loadLocalAccountSnapshot, loadLocalSyncConfiguration, saveLocalSyncConfiguration } from "@/account/accountLocalStore";
import { AccountCredentialError, persistedConfiguration, useConnectionStore } from "@/account/connectionStore";
import { closeCredentialVaultForTests, loadRefreshToken, saveRefreshToken } from "@/account/credentialVault";
import { resetBrokerAvailabilityForTests } from "@/account/credentialBroker";
import { accountSyncEnvelope, serializeAccountRepository } from "@/account/serialization";
import { sensitiveAccountData } from "@/account/dataProjection";
import type { LocalSyncConfiguration } from "@/account/types";
import { emptyCostsFile } from "@/costs/model";
import { DEFAULT_SETTINGS } from "@/types/settings";
import { BROKER_BASE, SECRETS, createFakeNetwork, deleteDatabases, dumpIndexedDb, jsonResponse, spyOnConsole, type FakeNetwork } from "./oauthTestKit";

const ACCOUNT_DB = "narrarium-local-account";
const VAULT_DB = "narrarium-credential-vault";
let net: FakeNetwork;

const google = (patch: Record<string, unknown> = {}) => ({
  identity: { provider: "google" as const, providerAccountId: "g-1", displayName: "Writer", email: "writer@example.com" },
  accessToken: SECRETS.access,
  accessTokenExpiry: Date.now() + 3_000_000,
  rememberMe: true,
  refreshToken: SECRETS.refresh,
  ...patch,
});

const microsoft = (patch: Record<string, unknown> = {}) => ({
  identity: { provider: "microsoft" as const, providerAccountId: "uid-1.tid-1", displayName: "Writer" },
  homeAccountId: "uid-1.tid-1",
  localAccountId: "uid-1",
  accessToken: SECRETS.access,
  accessTokenExpiry: Date.now() + 3_000_000,
  rememberMe: true,
  refreshToken: SECRETS.refresh,
  ...patch,
});

const store = () => useConnectionStore.getState();
const reload = async () => {
  useConnectionStore.setState({ hydrated: false, configuration: {} });
  await store().hydrate();
};

beforeEach(async () => {
  closeAccountLocalStoreForTests();
  closeCredentialVaultForTests();
  await deleteDatabases(ACCOUNT_DB, VAULT_DB);
  localStorage.clear();
  resetBrokerAvailabilityForTests();
  net = createFakeNetwork();
  vi.stubGlobal("fetch", net.fetch);
  vi.stubEnv("VITE_AUTH_BROKER_BASE", BROKER_BASE);
  await initializeAccountLocalStore({ settings: DEFAULT_SETTINGS, costs: emptyCostsFile(), clipboard: [], chats: [] });
  useConnectionStore.setState({ hydrated: true, configuration: {} });
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
  closeCredentialVaultForTests();
});

describe("what may be written to the device database", () => {
  const withTokens = (): LocalSyncConfiguration => ({
    google: { backend: "google-drive", method: "google", ...google(), replica: { enabled: true, status: "idle" } },
    microsoft: { backend: "onedrive", method: "microsoft", ...microsoft({ rememberMe: false }), replica: { enabled: true, status: "idle" } },
    github: { backend: "github", method: "github-pat", credentialKind: "pat", token: "ghp_token", rememberMe: false, accountSyncEnabled: true, repositoryName: "narrarium.settings", replica: { enabled: true, status: "idle" } },
  });

  it("never contains a refresh token, whether or not the connection is remembered", () => {
    const stored = persistedConfiguration(withTokens());
    expect(JSON.stringify(stored)).not.toContain(SECRETS.refresh);
    expect(stored.google && "refreshToken" in stored.google).toBe(false);
    expect(stored.microsoft && "refreshToken" in stored.microsoft).toBe(false);
  });

  it("keeps doing what it did for access tokens and for the GitHub token", () => {
    const stored = persistedConfiguration(withTokens());
    expect(stored.google?.accessToken).toBe(SECRETS.access);
    expect(stored.microsoft?.accessToken).toBeUndefined();
    expect(stored.github?.token).toBeUndefined();
    expect(stored.google?.identity.providerAccountId).toBe("g-1");
  });

  it("does not touch the configuration the app is running with", () => {
    const configuration = withTokens();
    persistedConfiguration(configuration);
    expect(configuration.google?.refreshToken).toBe(SECRETS.refresh);
    expect(configuration.microsoft?.refreshToken).toBe(SECRETS.refresh);
  });

  it("is also enforced where the record is written, so no caller can store a plain refresh token", async () => {
    await saveLocalSyncConfiguration(withTokens());
    expect(JSON.stringify(await loadLocalSyncConfiguration())).not.toContain(SECRETS.refresh);
    expect(await dumpIndexedDb(ACCOUNT_DB)).not.toContain(SECRETS.refresh);
  });
});

describe("connecting with a refresh token", () => {
  it("keeps it in memory, encrypted in the vault, and out of the device database", async () => {
    await store().connectGoogle(google());

    expect(store().configuration.google?.refreshToken).toBe(SECRETS.refresh);
    expect((await loadLocalSyncConfiguration()).google?.refreshToken).toBeUndefined();
    expect(await dumpIndexedDb(ACCOUNT_DB)).not.toContain(SECRETS.refresh);
    expect(await dumpIndexedDb(VAULT_DB)).not.toContain(SECRETS.refresh);
    await expect(loadRefreshToken("google", "g-1")).resolves.toBe(SECRETS.refresh);
  });

  it("restores it when the app starts again", async () => {
    await store().connectGoogle(google());
    await store().connectMicrosoft(microsoft({ refreshToken: SECRETS.refreshRotated }));

    await reload();

    expect(store().configuration.google?.refreshToken).toBe(SECRETS.refresh);
    expect(store().configuration.microsoft?.refreshToken).toBe(SECRETS.refreshRotated);
  });

  it("keeps it in memory only when the connection is not remembered on this device", async () => {
    await store().connectGoogle(google({ rememberMe: false }));

    expect(store().configuration.google?.refreshToken).toBe(SECRETS.refresh);
    expect(await dumpIndexedDb(VAULT_DB)).toBe("");
    expect(await dumpIndexedDb(ACCOUNT_DB)).not.toContain(SECRETS.refresh);
    await reload();
    expect(store().configuration.google?.refreshToken).toBeUndefined();
  });

  it("keeps it in memory only when the browser has no WebCrypto, without failing the connection", async () => {
    vi.stubGlobal("crypto", { getRandomValues: globalThis.crypto.getRandomValues.bind(globalThis.crypto), randomUUID: globalThis.crypto.randomUUID.bind(globalThis.crypto) });
    await expect(store().connectMicrosoft(microsoft())).resolves.toBeUndefined();

    expect(store().configuration.microsoft?.refreshToken).toBe(SECRETS.refresh);
    expect(await dumpIndexedDb(VAULT_DB)).toBe("");
    expect(await dumpIndexedDb(ACCOUNT_DB)).not.toContain(SECRETS.refresh);
  });

  it("does not hand a stored token to a different account", async () => {
    await store().connectGoogle(google());
    await saveLocalSyncConfiguration(persistedConfiguration({ google: { backend: "google-drive", method: "google", ...google({ identity: { provider: "google", providerAccountId: "g-2", displayName: "Other" }, refreshToken: undefined }), replica: { enabled: true, status: "idle" } } }));

    await reload();

    expect(store().configuration.google?.identity.providerAccountId).toBe("g-2");
    expect(store().configuration.google?.refreshToken).toBeUndefined();
  });

  it("forgets an earlier refresh token when the account is connected again without one", async () => {
    await store().connectGoogle(google());
    await store().connectGoogle(google({ refreshToken: undefined, accessToken: SECRETS.accessFresh }));

    await expect(loadRefreshToken("google", "g-1")).resolves.toBeNull();
    await reload();
    expect(store().configuration.google?.refreshToken).toBeUndefined();
  });

  it("never ends up in the data that is synced to the cloud, in its files, or in the exports built from them", async () => {
    await store().connectGoogle(google());
    await store().connectMicrosoft(microsoft());
    const snapshot = (await loadLocalAccountSnapshot())!;

    const envelope = await accountSyncEnvelope(snapshot);
    const files = await serializeAccountRepository(snapshot);
    const everything = [JSON.stringify(envelope), JSON.stringify([...files.files.entries()]), JSON.stringify(snapshot), JSON.stringify(sensitiveAccountData(snapshot.data.settings))].join("\n");

    expect(everything).not.toContain(SECRETS.refresh);
    expect(everything).not.toContain("refreshToken");
  });
});

describe("renewing and rotating", () => {
  it("keeps the stored refresh token when the provider sends no new one (Google)", async () => {
    await store().connectGoogle(google());

    await store().updateCredentials("google-drive", { accessToken: SECRETS.accessFresh, accessTokenExpiry: Date.now() + 3_000_000 });

    expect(store().configuration.google).toMatchObject({ accessToken: SECRETS.accessFresh, refreshToken: SECRETS.refresh });
    await expect(loadRefreshToken("google", "g-1")).resolves.toBe(SECRETS.refresh);
    expect((await loadLocalSyncConfiguration()).google?.accessToken).toBe(SECRETS.accessFresh);
  });

  it("replaces the refresh token with the rotated one, in memory and in the vault (Microsoft)", async () => {
    await store().connectMicrosoft(microsoft());

    await store().updateCredentials("onedrive", { accessToken: SECRETS.accessFresh, accessTokenExpiry: Date.now() + 3_000_000, refreshToken: SECRETS.refreshRotated });

    expect(store().configuration.microsoft?.refreshToken).toBe(SECRETS.refreshRotated);
    await expect(loadRefreshToken("microsoft", "uid-1.tid-1")).resolves.toBe(SECRETS.refreshRotated);
    expect(await dumpIndexedDb(ACCOUNT_DB)).not.toContain(SECRETS.refreshRotated);
    await reload();
    expect(store().configuration.microsoft?.refreshToken).toBe(SECRETS.refreshRotated);
  });

  it("refuses to update a connection that does not exist", async () => {
    await expect(store().updateCredentials("google-drive", { accessToken: "x", accessTokenExpiry: 1 })).rejects.toBeInstanceOf(AccountCredentialError);
  });

  it("drops a refresh token that no longer works, and nothing else", async () => {
    await store().connectGoogle(google());

    await store().clearRefreshToken("google-drive");

    expect(store().configuration.google).toMatchObject({ accessToken: SECRETS.access });
    expect(store().configuration.google?.refreshToken).toBeUndefined();
    await expect(loadRefreshToken("google", "g-1")).resolves.toBeNull();
  });

  it("picks up what another tab saved while this one was waiting for the lock", async () => {
    await store().connectMicrosoft(microsoft({ accessTokenExpiry: Date.now() - 1_000 }));
    const otherTab = persistedConfiguration({ microsoft: { backend: "onedrive", method: "microsoft", ...microsoft({ accessToken: SECRETS.accessFresh, accessTokenExpiry: Date.now() + 3_000_000 }), replica: { enabled: true, status: "idle" } } });
    await saveLocalSyncConfiguration(otherTab);
    await saveRefreshToken("microsoft", "uid-1.tid-1", SECRETS.refreshRotated);

    await store().reloadCredentialsFromDevice("onedrive");

    expect(store().configuration.microsoft).toMatchObject({ accessToken: SECRETS.accessFresh, refreshToken: SECRETS.refreshRotated });
    expect(store().configuration.microsoft!.accessTokenExpiry!).toBeGreaterThan(Date.now());
  });

  it("does not let an older copy on the device overwrite a newer one in memory, or another account's copy replace this one", async () => {
    await store().connectGoogle(google({ accessToken: SECRETS.accessFresh, accessTokenExpiry: Date.now() + 3_000_000 }));
    await saveLocalSyncConfiguration(persistedConfiguration({ google: { backend: "google-drive", method: "google", ...google({ accessToken: SECRETS.access, accessTokenExpiry: Date.now() + 1_000 }), replica: { enabled: true, status: "idle" } } }));
    await store().reloadCredentialsFromDevice("google-drive");
    expect(store().configuration.google?.accessToken).toBe(SECRETS.accessFresh);

    await saveLocalSyncConfiguration(persistedConfiguration({ google: { backend: "google-drive", method: "google", ...google({ identity: { provider: "google", providerAccountId: "g-2", displayName: "Other" }, accessToken: "other-access", accessTokenExpiry: Date.now() + 9_000_000 }), replica: { enabled: true, status: "idle" } } }));
    await store().reloadCredentialsFromDevice("google-drive");
    expect(store().configuration.google?.accessToken).toBe(SECRETS.accessFresh);
    expect(store().configuration.google?.identity.providerAccountId).toBe("g-1");
  });

  it("leaves a connection that is not remembered alone when it looks at the device", async () => {
    await store().connectGoogle(google({ rememberMe: false }));
    await store().reloadCredentialsFromDevice("google-drive");
    expect(store().configuration.google).toMatchObject({ accessToken: SECRETS.access, refreshToken: SECRETS.refresh });
  });
});

describe("disconnecting", () => {
  it("revokes a Google refresh token through the broker, then forgets it everywhere", async () => {
    net.on("POST", `${BROKER_BASE}/oauth/google/revoke`, () => jsonResponse(null, 204));
    await store().connectGoogle(google());

    await store().disconnect("google-drive");

    expect(net.broker("/oauth/google/revoke")).toHaveLength(1);
    expect(net.broker("/oauth/google/revoke")[0].body).toEqual({ token: SECRETS.refresh });
    expect(store().configuration.google).toBeUndefined();
    expect((await loadLocalSyncConfiguration()).google).toBeUndefined();
    await expect(loadRefreshToken("google", "g-1")).resolves.toBeNull();
    expect(await dumpIndexedDb(VAULT_DB)).not.toContain("device-key");
  });

  it("does not wait for Google before the connection is gone from this device", async () => {
    let release!: () => void;
    net.on("POST", `${BROKER_BASE}/oauth/google/revoke`, () => new Promise<Response>((resolve) => { release = () => resolve(jsonResponse(null, 204)); }));
    await store().connectGoogle(google());

    const finished = store().disconnect("google-drive");
    await vi.waitFor(() => expect(net.broker("/oauth/google/revoke")).toHaveLength(1));
    expect(store().configuration.google).toBeUndefined();
    await expect(loadRefreshToken("google", "g-1")).resolves.toBeNull();
    release();
    await finished;
  });

  it.each([
    ["the Worker is unreachable", undefined],
    ["the Worker answers 502", () => jsonResponse({ error: "upstream_error", message: "x" }, 502)],
    ["Google says the token is invalid", () => jsonResponse({ error: "invalid_grant", message: "x" }, 400)],
  ])("is not blocked when %s", async (_label, answer) => {
    if (answer) net.on("POST", `${BROKER_BASE}/oauth/google/revoke`, answer);
    await store().connectGoogle(google());
    await expect(store().disconnect("google-drive")).resolves.toBeUndefined();
    expect(store().configuration.google).toBeUndefined();
    await expect(loadRefreshToken("google", "g-1")).resolves.toBeNull();
  });

  it("only forgets a Microsoft refresh token on this device: Microsoft has nothing to revoke it with", async () => {
    await store().connectMicrosoft(microsoft());

    await store().disconnect("onedrive");

    expect(net.calls).toHaveLength(0);
    expect(store().configuration.microsoft).toBeUndefined();
    await expect(loadRefreshToken("microsoft", "uid-1.tid-1")).resolves.toBeNull();
  });

  it("does not call the broker for a connection without a refresh token", async () => {
    await store().connectGoogle(google({ refreshToken: undefined }));
    await store().disconnect("google-drive");
    expect(net.calls).toHaveLength(0);
  });

  it("keeps the other provider's token, and the key it needs", async () => {
    net.on("POST", `${BROKER_BASE}/oauth/google/revoke`, () => jsonResponse(null, 204));
    await store().connectGoogle(google());
    await store().connectMicrosoft(microsoft());

    await store().disconnect("google-drive");

    await expect(loadRefreshToken("microsoft", "uid-1.tid-1")).resolves.toBe(SECRETS.refresh);
  });

  it("stays silent, and never prints a token", async () => {
    const spy = spyOnConsole();
    await store().connectGoogle(google());
    await store().disconnect("google-drive");
    expect(spy.count()).toBe(0);
  });
});
