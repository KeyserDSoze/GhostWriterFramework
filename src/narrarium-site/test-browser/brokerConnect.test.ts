import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import "fake-indexeddb/auto";
import { closeAccountLocalStoreForTests, initializeAccountLocalStore } from "@/account/accountLocalStore";
import { completeGoogleCodeConnection, completeMicrosoftBrokerConnection } from "@/account/brokerConnect";
import { ConnectFlowError } from "@/account/connectErrors";
import { useConnectionStore } from "@/account/connectionStore";
import { BrokerError, resetBrokerAvailabilityForTests } from "@/account/credentialBroker";
import { closeCredentialVaultForTests, loadRefreshToken } from "@/account/credentialVault";
import { emptyCostsFile } from "@/costs/model";
import { useAuthStore } from "@/store/authStore";
import { DEFAULT_SETTINGS } from "@/types/settings";
import { BROKER_BASE, SECRETS, createFakeNetwork, deleteDatabases, dumpIndexedDb, jsonResponse, spyOnConsole, type FakeNetwork } from "./oauthTestKit";

const USERINFO = "https://www.googleapis.com/oauth2/v3/userinfo";
const GRAPH_ME = "https://graph.microsoft.com/v1.0/me";
const REDIRECT = "https://narrarium.net/auth/microsoft-callback.html";
const PERSONAL = { uid: "00000000-0000-0000-4d3c-0f1e2a3b4c5d", utid: "9188040d-6c67-4c5b-b112-36a304b66dad" };
const WORK = { uid: "f2a1c5e0-3b7d-4a98-8c3e-5d1f0a9b7c42", utid: "72f988bf-86f1-41af-91ab-2d7cd011db47" };
let net: FakeNetwork;

const clientInfo = (info: { uid: string; utid: string }) => Buffer.from(JSON.stringify(info)).toString("base64url");
const store = () => useConnectionStore.getState();
const googleProfile = { sub: "g-1", name: "Ada Writer", email: "ada@example.com", picture: "https://example.com/ada.png" };

beforeEach(async () => {
  closeAccountLocalStoreForTests();
  closeCredentialVaultForTests();
  await deleteDatabases("narrarium-local-account", "narrarium-credential-vault");
  localStorage.clear();
  sessionStorage.clear();
  resetBrokerAvailabilityForTests();
  net = createFakeNetwork();
  vi.stubGlobal("fetch", net.fetch);
  vi.stubEnv("VITE_AUTH_BROKER_BASE", BROKER_BASE);
  useAuthStore.setState({ accessToken: null, accessTokenExpiry: null, provider: null, providerAccountId: null, user: null, rememberMe: false });
  await initializeAccountLocalStore({ settings: DEFAULT_SETTINGS, costs: emptyCostsFile(), clipboard: [], chats: [] });
  useConnectionStore.setState({ hydrated: true, configuration: {} });
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
  closeCredentialVaultForTests();
});

describe("connecting Google with the authorization code", () => {
  const exchange = (extra: Record<string, unknown> = {}) => net.reply("POST", `${BROKER_BASE}/oauth/google/token`, { accessToken: SECRETS.access, expiresIn: 3599, refreshToken: SECRETS.refresh, scope: "openid", ...extra });

  it("swaps the code at the broker, reads the profile as before, and connects with the refresh token", async () => {
    exchange();
    net.reply("GET", USERINFO, googleProfile);
    const before = Date.now();

    await expect(completeGoogleCodeConnection({ code: SECRETS.code, rememberMe: true })).resolves.toEqual({ longLived: true });

    expect(net.broker("/oauth/google/token")[0].body).toEqual({ code: SECRETS.code });
    expect(net.callsTo("GET", USERINFO)[0].headers.authorization).toBe(`Bearer ${SECRETS.access}`);
    const connection = store().configuration.google!;
    expect(connection).toMatchObject({
      identity: { provider: "google", providerAccountId: "g-1", displayName: "Ada Writer", email: "ada@example.com", avatarUrl: "https://example.com/ada.png" },
      accessToken: SECRETS.access,
      refreshToken: SECRETS.refresh,
      rememberMe: true,
      replica: { enabled: true },
    });
    expect(connection.accessTokenExpiry!).toBeGreaterThanOrEqual(before + (3599 - 60) * 1_000);
    expect(connection.accessTokenExpiry!).toBeLessThanOrEqual(Date.now() + 3599 * 1_000);
    await expect(loadRefreshToken("google", "g-1")).resolves.toBe(SECRETS.refresh);
  });

  it("signs the app in with the same details as the implicit flow does", async () => {
    exchange();
    net.reply("GET", USERINFO, googleProfile);

    await completeGoogleCodeConnection({ code: SECRETS.code, rememberMe: false });

    expect(useAuthStore.getState()).toMatchObject({
      accessToken: SECRETS.access,
      provider: "google",
      providerAccountId: "g-1",
      rememberMe: false,
      user: { provider: "google", providerAccountId: "g-1", name: "Ada Writer", email: "ada@example.com", picture: "https://example.com/ada.png" },
    });
  });

  it("keeps the refresh token in memory only when the connection is not remembered", async () => {
    exchange();
    net.reply("GET", USERINFO, googleProfile);
    await completeGoogleCodeConnection({ code: SECRETS.code, rememberMe: false });
    expect(store().configuration.google?.refreshToken).toBe(SECRETS.refresh);
    expect(await dumpIndexedDb("narrarium-credential-vault")).toBe("");
  });

  it("connects without long-lived credentials when Google issued no refresh token, and says so", async () => {
    exchange({ refreshToken: undefined });
    net.reply("GET", USERINFO, googleProfile);

    await expect(completeGoogleCodeConnection({ code: SECRETS.code, rememberMe: true })).resolves.toEqual({ longLived: false });

    expect(store().configuration.google).toBeDefined();
    expect(store().configuration.google?.refreshToken).toBeUndefined();
  });

  it("keeps the refresh token it already had for the same account when Google issues none, but never lends it to another account", async () => {
    exchange();
    net.reply("GET", USERINFO, googleProfile);
    await completeGoogleCodeConnection({ code: SECRETS.code, rememberMe: true });

    exchange({ accessToken: SECRETS.accessFresh, refreshToken: undefined });
    await expect(completeGoogleCodeConnection({ code: "again", rememberMe: true })).resolves.toEqual({ longLived: true });
    expect(store().configuration.google).toMatchObject({ accessToken: SECRETS.accessFresh, refreshToken: SECRETS.refresh });
    await expect(loadRefreshToken("google", "g-1")).resolves.toBe(SECRETS.refresh);

    net.reply("GET", USERINFO, { ...googleProfile, sub: "g-2", email: "other@example.com" });
    await expect(completeGoogleCodeConnection({ code: "other", rememberMe: true })).resolves.toEqual({ longLived: false });
    expect(store().configuration.google?.identity.providerAccountId).toBe("g-2");
    expect(store().configuration.google?.refreshToken).toBeUndefined();
    await expect(loadRefreshToken("google", "g-1")).resolves.toBeNull();
  });

  it("changes nothing when the broker refuses the code", async () => {
    net.reply("POST", `${BROKER_BASE}/oauth/google/token`, { error: "invalid_grant", message: "x" }, 400);
    await expect(completeGoogleCodeConnection({ code: SECRETS.code, rememberMe: true })).rejects.toMatchObject({ code: "invalid_grant" });
    await expect(completeGoogleCodeConnection({ code: SECRETS.code, rememberMe: true })).rejects.toBeInstanceOf(BrokerError);
    expect(store().configuration.google).toBeUndefined();
    expect(useAuthStore.getState().user).toBeNull();
  });

  it("changes nothing when the profile cannot be read, or has no immutable account id", async () => {
    exchange();
    net.reply("GET", USERINFO, { error: "unauthorized" }, 401);
    await expect(completeGoogleCodeConnection({ code: SECRETS.code, rememberMe: true })).rejects.toThrow("Google profile failed (401).");
    net.reply("GET", USERINFO, { name: "No Subject" });
    await expect(completeGoogleCodeConnection({ code: SECRETS.code, rememberMe: true })).rejects.toThrow("Google did not return an immutable account ID.");
    expect(store().configuration.google).toBeUndefined();
    expect(await dumpIndexedDb("narrarium-credential-vault")).toBe("");
  });

  it("refuses a different account when it was asked to upgrade the one that is connected, and keeps everything as it was", async () => {
    exchange();
    net.reply("GET", USERINFO, googleProfile);
    await completeGoogleCodeConnection({ code: SECRETS.code, rememberMe: true });
    const connected = store().configuration.google;

    exchange({ accessToken: "at-other", refreshToken: "rt-other" });
    net.reply("GET", USERINFO, { ...googleProfile, sub: "g-2" });
    const failure = await completeGoogleCodeConnection({ code: "other", rememberMe: true, expectedAccountId: "g-1" }).catch((cause: unknown) => cause);

    expect(failure).toBeInstanceOf(ConnectFlowError);
    expect(failure).toMatchObject({ code: "wrong_account" });
    expect(store().configuration.google).toEqual(connected);
    await expect(loadRefreshToken("google", "g-1")).resolves.toBe(SECRETS.refresh);
  });

  it("upgrades in place: the sync switch and the sync history of the connection are kept", async () => {
    await store().connectGoogle({ identity: { provider: "google", providerAccountId: "g-1", displayName: "Ada Writer" }, accessToken: "old", rememberMe: true, replica: { enabled: false, status: "disabled", lastSuccessfulSyncAtUtc: "2026-11-20T10:00:00.000Z", lastKnownRemoteSnapshotId: "snap-1" } });
    exchange();
    net.reply("GET", USERINFO, googleProfile);

    await completeGoogleCodeConnection({ code: SECRETS.code, rememberMe: true, expectedAccountId: "g-1", preserveReplica: true });

    expect(store().configuration.google).toMatchObject({ refreshToken: SECRETS.refresh, accessToken: SECRETS.access, replica: { enabled: false, status: "disabled", lastSuccessfulSyncAtUtc: "2026-11-20T10:00:00.000Z", lastKnownRemoteSnapshotId: "snap-1" } });
  });

  it("clears an earlier failure when it upgrades a connection that was waiting for the login", async () => {
    await store().connectGoogle({ identity: { provider: "google", providerAccountId: "g-1", displayName: "Ada Writer" }, accessToken: "old", rememberMe: true, replica: { enabled: true, status: "needs-auth", errorKind: "credential-expired", lastErrorMessage: "google-drive credential is expired." } });
    exchange();
    net.reply("GET", USERINFO, googleProfile);

    await completeGoogleCodeConnection({ code: SECRETS.code, rememberMe: true, expectedAccountId: "g-1", preserveReplica: true });

    const replica = store().configuration.google!.replica;
    expect(replica.enabled).toBe(true);
    expect(replica.status).toBe("dirty");
    expect(replica.errorKind).toBeUndefined();
    expect(replica.lastErrorMessage).toBeUndefined();
  });

  it("stays silent", async () => {
    const spy = spyOnConsole();
    exchange();
    net.reply("GET", USERINFO, googleProfile);
    await completeGoogleCodeConnection({ code: SECRETS.code, rememberMe: true });
    expect(spy.count()).toBe(0);
  });
});

describe("connecting OneDrive through the broker", () => {
  const authorization = { code: SECRETS.code, codeVerifier: SECRETS.verifier, redirectUri: REDIRECT };
  const exchange = (info: { uid: string; utid: string } | null = PERSONAL, extra: Record<string, unknown> = {}) =>
    net.reply("POST", `${BROKER_BASE}/oauth/microsoft/token`, { accessToken: SECRETS.access, expiresIn: 3599, refreshToken: SECRETS.refresh, ...(info ? { clientInfo: clientInfo(info) } : {}), ...extra });

  it("builds the identity MSAL would have built for a personal account, and reads the profile from Graph", async () => {
    exchange(PERSONAL);
    net.reply("GET", GRAPH_ME, { displayName: "Ada Writer", mail: "ada@outlook.com", userPrincipalName: "ada_outlook.com#EXT#@x" });

    await expect(completeMicrosoftBrokerConnection({ authorization, rememberMe: true })).resolves.toEqual({ longLived: true });

    expect(net.broker("/oauth/microsoft/token")[0].body).toEqual({ code: SECRETS.code, codeVerifier: SECRETS.verifier, redirectUri: REDIRECT });
    expect(net.callsTo("GET", GRAPH_ME)[0].headers.authorization).toBe(`Bearer ${SECRETS.access}`);
    expect(net.callsTo("GET", GRAPH_ME)[0].init.cache).toBe("no-store");
    expect(store().configuration.microsoft).toMatchObject({
      identity: { provider: "microsoft", providerAccountId: "00000000-0000-0000-4d3c-0f1e2a3b4c5d.9188040d-6c67-4c5b-b112-36a304b66dad", displayName: "Ada Writer", email: "ada@outlook.com" },
      homeAccountId: "00000000-0000-0000-4d3c-0f1e2a3b4c5d.9188040d-6c67-4c5b-b112-36a304b66dad",
      localAccountId: "00000000-0000-0000-4d3c-0f1e2a3b4c5d",
      accessToken: SECRETS.access,
      refreshToken: SECRETS.refresh,
      rememberMe: true,
    });
    await expect(loadRefreshToken("microsoft", "00000000-0000-0000-4d3c-0f1e2a3b4c5d.9188040d-6c67-4c5b-b112-36a304b66dad")).resolves.toBe(SECRETS.refresh);
  });

  it("builds the same kind of identity for a work or school account, falling back to the user principal name", async () => {
    exchange(WORK);
    net.reply("GET", GRAPH_ME, { displayName: "Ada Writer", userPrincipalName: "ada@contoso.com" });

    await completeMicrosoftBrokerConnection({ authorization, rememberMe: true });

    expect(store().configuration.microsoft).toMatchObject({
      identity: { providerAccountId: "f2a1c5e0-3b7d-4a98-8c3e-5d1f0a9b7c42.72f988bf-86f1-41af-91ab-2d7cd011db47", email: "ada@contoso.com" },
      homeAccountId: "f2a1c5e0-3b7d-4a98-8c3e-5d1f0a9b7c42.72f988bf-86f1-41af-91ab-2d7cd011db47",
      localAccountId: "f2a1c5e0-3b7d-4a98-8c3e-5d1f0a9b7c42",
    });
  });

  it("signs the app in with the Microsoft identifiers, as the MSAL flow does", async () => {
    exchange(WORK);
    net.reply("GET", GRAPH_ME, { displayName: "Ada Writer", mail: "ada@contoso.com" });

    await completeMicrosoftBrokerConnection({ authorization, rememberMe: false });

    expect(useAuthStore.getState()).toMatchObject({
      accessToken: SECRETS.access,
      provider: "microsoft",
      providerAccountId: "f2a1c5e0-3b7d-4a98-8c3e-5d1f0a9b7c42.72f988bf-86f1-41af-91ab-2d7cd011db47",
      user: { provider: "microsoft", name: "Ada Writer", email: "ada@contoso.com", homeAccountId: "f2a1c5e0-3b7d-4a98-8c3e-5d1f0a9b7c42.72f988bf-86f1-41af-91ab-2d7cd011db47", localAccountId: "f2a1c5e0-3b7d-4a98-8c3e-5d1f0a9b7c42" },
    });
  });

  it("keeps the refresh token in memory only when the connection is not remembered", async () => {
    exchange(WORK);
    net.reply("GET", GRAPH_ME, { displayName: "Ada Writer", mail: "ada@contoso.com" });
    await completeMicrosoftBrokerConnection({ authorization, rememberMe: false });
    expect(store().configuration.microsoft?.refreshToken).toBe(SECRETS.refresh);
    expect(await dumpIndexedDb("narrarium-credential-vault")).toBe("");
  });

  it("refuses to connect when Microsoft did not say which account this is, instead of inventing an identity", async () => {
    exchange(null);
    net.reply("GET", GRAPH_ME, { displayName: "Ada Writer", mail: "ada@contoso.com" });
    await expect(completeMicrosoftBrokerConnection({ authorization, rememberMe: true })).rejects.toMatchObject({ code: "invalid_response" });
    expect(store().configuration.microsoft).toBeUndefined();
    expect(net.callsTo("GET", GRAPH_ME)).toHaveLength(0);
  });

  it("refuses an answer without a refresh token: that would not be a long-lived connection", async () => {
    exchange(WORK, { refreshToken: undefined });
    await expect(completeMicrosoftBrokerConnection({ authorization, rememberMe: true })).rejects.toMatchObject({ code: "invalid_response" });
    expect(store().configuration.microsoft).toBeUndefined();
  });

  it("changes nothing when the broker refuses the code or Graph refuses the profile", async () => {
    net.reply("POST", `${BROKER_BASE}/oauth/microsoft/token`, { error: "invalid_grant", message: "x" }, 400);
    await expect(completeMicrosoftBrokerConnection({ authorization, rememberMe: true })).rejects.toMatchObject({ code: "invalid_grant" });

    exchange(WORK);
    net.reply("GET", GRAPH_ME, {}, 403);
    await expect(completeMicrosoftBrokerConnection({ authorization, rememberMe: true })).rejects.toThrow("Microsoft profile failed (403).");
    expect(store().configuration.microsoft).toBeUndefined();
    expect(await dumpIndexedDb("narrarium-credential-vault")).toBe("");
  });

  it("refuses a different account when it was asked to upgrade the one that is connected", async () => {
    exchange(WORK);
    net.reply("GET", GRAPH_ME, { displayName: "Ada Writer", mail: "ada@contoso.com" });
    await completeMicrosoftBrokerConnection({ authorization, rememberMe: true });
    const connected = store().configuration.microsoft;

    exchange(PERSONAL, { accessToken: "at-other", refreshToken: "rt-other" });
    const failure = await completeMicrosoftBrokerConnection({ authorization, rememberMe: true, expectedHomeAccountId: "f2a1c5e0-3b7d-4a98-8c3e-5d1f0a9b7c42.72f988bf-86f1-41af-91ab-2d7cd011db47" }).catch((cause: unknown) => cause);

    expect(failure).toBeInstanceOf(ConnectFlowError);
    expect(failure).toMatchObject({ code: "wrong_account" });
    expect(store().configuration.microsoft).toEqual(connected);
  });

  it("upgrades in place when it is the same account that was connected with MSAL, keeping the sync switch and history", async () => {
    await store().connectMicrosoft({
      identity: { provider: "microsoft", providerAccountId: "f2a1c5e0-3b7d-4a98-8c3e-5d1f0a9b7c42.72f988bf-86f1-41af-91ab-2d7cd011db47", displayName: "Ada Writer" },
      homeAccountId: "f2a1c5e0-3b7d-4a98-8c3e-5d1f0a9b7c42.72f988bf-86f1-41af-91ab-2d7cd011db47",
      localAccountId: "f2a1c5e0-3b7d-4a98-8c3e-5d1f0a9b7c42",
      accessToken: "msal-token",
      rememberMe: true,
      replica: { enabled: false, status: "disabled", lastSuccessfulSyncAtUtc: "2026-11-20T10:00:00.000Z" },
    });
    exchange(WORK);
    net.reply("GET", GRAPH_ME, { displayName: "Ada Writer", mail: "ada@contoso.com" });

    await completeMicrosoftBrokerConnection({ authorization, rememberMe: true, expectedHomeAccountId: "f2a1c5e0-3b7d-4a98-8c3e-5d1f0a9b7c42.72f988bf-86f1-41af-91ab-2d7cd011db47", preserveReplica: true });

    expect(store().configuration.microsoft).toMatchObject({ refreshToken: SECRETS.refresh, accessToken: SECRETS.access, replica: { enabled: false, lastSuccessfulSyncAtUtc: "2026-11-20T10:00:00.000Z" } });
  });

  it("stays silent", async () => {
    const spy = spyOnConsole();
    exchange(WORK);
    net.reply("GET", GRAPH_ME, { displayName: "Ada Writer", mail: "ada@contoso.com" });
    await completeMicrosoftBrokerConnection({ authorization, rememberMe: true });
    net.on("POST", `${BROKER_BASE}/oauth/microsoft/token`, () => jsonResponse({ error: "invalid_grant", message: `bad ${SECRETS.code} ${SECRETS.verifier}` }, 400));
    await completeMicrosoftBrokerConnection({ authorization, rememberMe: true }).catch(() => undefined);
    expect(spy.count()).toBe(0);
  });
});
