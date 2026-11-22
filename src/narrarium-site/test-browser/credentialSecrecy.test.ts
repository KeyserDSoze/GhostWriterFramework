import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import "fake-indexeddb/auto";
import { closeAccountLocalStoreForTests, initializeAccountLocalStore } from "@/account/accountLocalStore";
import { acquireGoogleConnectionToken } from "@/account/googleConnectionToken";
import { acquireMicrosoftConnectionToken } from "@/account/microsoftConnectionToken";
import { completeGoogleCodeConnection, completeMicrosoftBrokerConnection } from "@/account/brokerConnect";
import { useConnectionStore } from "@/account/connectionStore";
import { resetBrokerAvailabilityForTests } from "@/account/credentialBroker";
import { closeCredentialVaultForTests } from "@/account/credentialVault";
import { resetTokenRefreshLockForTests } from "@/account/tokenRefreshLock";
import { classifyAccountSyncError, syncOneAccountReplica, useAccountSyncStore } from "@/account/accountSync";
import { useLlmDebugStore } from "@/debug/llmDebugStore";
import { useAuthStore } from "@/store/authStore";
import { emptyCostsFile } from "@/costs/model";
import { DEFAULT_SETTINGS } from "@/types/settings";
import { BROKER_BASE, SECRETS, createFakeNetwork, deleteDatabases, dumpIndexedDb, jsonResponse, spyOnConsole, type FakeNetwork } from "./oauthTestKit";

vi.mock("@/account/sync/driveBackend", () => ({
  DriveAccountSyncBackend: class {
    readonly kind = "google-drive" as const;
    pull = async () => null;
    push = async () => ({ revision: "r" });
    deleteRemoteData = async () => undefined;
  },
}));
vi.mock("@/account/sync/githubBackend", () => ({ GitHubAccountSyncBackend: class {} }));

const WORK = { uid: "f2a1c5e0-3b7d-4a98-8c3e-5d1f0a9b7c42", utid: "72f988bf-86f1-41af-91ab-2d7cd011db47" };
const HOME = `${WORK.uid}.${WORK.utid}`;
let net: FakeNetwork;

/** Everything a page could leak into: the two Web Storage areas and every IndexedDB database. */
async function everythingStored(): Promise<string> {
  const databases = (await indexedDB.databases()).map((entry) => entry.name!).filter(Boolean);
  const dumps = await Promise.all(databases.map((name) => dumpIndexedDb(name)));
  return [JSON.stringify({ ...localStorage }), JSON.stringify({ ...sessionStorage }), ...dumps].join("\n");
}

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
  useAuthStore.setState({ accessToken: null, accessTokenExpiry: null, provider: null, providerAccountId: null, user: null, rememberMe: false });
  useLlmDebugStore.getState().clear();
  await initializeAccountLocalStore({ settings: DEFAULT_SETTINGS, costs: emptyCostsFile(), clipboard: [], chats: [] });
  useConnectionStore.setState({ hydrated: true, configuration: {} });
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
  closeCredentialVaultForTests();
});

describe("a refresh token stays a secret from the first exchange to the last renewal", () => {
  it("is nowhere in clear text in the browser's storage, in the debug history or in the console, for remembered and unremembered connections", async () => {
    const spy = spyOnConsole();
    for (const rememberMe of [true, false]) {
      net.reply("POST", `${BROKER_BASE}/oauth/google/token`, { accessToken: SECRETS.access, expiresIn: 3599, refreshToken: SECRETS.refresh, idToken: SECRETS.idToken });
      net.reply("GET", "https://www.googleapis.com/oauth2/v3/userinfo", { sub: "g-1", name: "Ada", email: "ada@example.com", picture: "" });
      await completeGoogleCodeConnection({ code: SECRETS.code, rememberMe });

      net.reply("POST", `${BROKER_BASE}/oauth/microsoft/token`, { accessToken: SECRETS.access, expiresIn: 3599, refreshToken: SECRETS.refresh, idToken: SECRETS.idToken, clientInfo: Buffer.from(JSON.stringify(WORK)).toString("base64url") });
      net.reply("GET", "https://graph.microsoft.com/v1.0/me", { displayName: "Ada", mail: "ada@contoso.com" });
      await completeMicrosoftBrokerConnection({ authorization: { code: SECRETS.code, codeVerifier: SECRETS.verifier, redirectUri: "https://narrarium.net/auth/microsoft-callback.html" }, rememberMe });

      // Renewals, including the rotation of the Microsoft token.
      net.reply("POST", `${BROKER_BASE}/oauth/google/refresh`, { accessToken: SECRETS.accessFresh, expiresIn: 3599 });
      net.reply("POST", `${BROKER_BASE}/oauth/microsoft/refresh`, { accessToken: SECRETS.accessFresh, expiresIn: 3599, refreshToken: SECRETS.refreshRotated, clientInfo: Buffer.from(JSON.stringify(WORK)).toString("base64url") });
      await acquireGoogleConnectionToken({ force: true });
      await acquireMicrosoftConnectionToken({ force: true });
      expect(useConnectionStore.getState().configuration.microsoft?.refreshToken).toBe(SECRETS.refreshRotated);

      const stored = await everythingStored();
      for (const secret of [SECRETS.refresh, SECRETS.refreshRotated, SECRETS.code, SECRETS.verifier, SECRETS.idToken]) {
        expect(stored, `${secret} (rememberMe: ${rememberMe})`).not.toContain(secret);
        expect(JSON.stringify(useLlmDebugStore.getState()), secret).not.toContain(secret);
      }
      expect(JSON.stringify(useAuthStore.getState()), "the app login state never holds a refresh token").not.toContain(SECRETS.refresh);
      await useConnectionStore.getState().disconnect("google-drive");
      await useConnectionStore.getState().disconnect("onedrive");
    }
    expect(spy.output()).not.toMatch(/SENTINEL/);
    expect(spy.count()).toBe(0);
  });

  it("is in no error text that reaches the owner, whatever fails", async () => {
    const spy = spyOnConsole();
    await useConnectionStore.getState().connectGoogle({ identity: { provider: "google", providerAccountId: "g-1", displayName: "Ada" }, accessToken: SECRETS.access, accessTokenExpiry: Date.now() - 1_000, rememberMe: true, refreshToken: SECRETS.refresh });
    const failures: Array<() => Response | undefined> = [
      () => jsonResponse({ error: "upstream_error", message: `Google rejected ${SECRETS.refresh} ya29.A0ARrdaM-0123456789abcdef0123456789` }, 502),
      () => jsonResponse({ error: "invalid_grant", message: `bad token ${SECRETS.refresh}` }, 400),
      () => jsonResponse({ error: "rate_limited", message: SECRETS.refresh }, 429, { "Retry-After": "5" }),
      () => new Response(`<html>${SECRETS.refresh}</html>`, { status: 500 }),
      () => undefined,
    ];
    const shown: string[] = [];
    for (const failure of failures) {
      net.reset();
      const answer = failure();
      if (answer) net.on("POST", `${BROKER_BASE}/oauth/google/refresh`, () => answer.clone());
      await useConnectionStore.getState().connectGoogle({ identity: { provider: "google", providerAccountId: "g-1", displayName: "Ada" }, accessToken: SECRETS.access, accessTokenExpiry: Date.now() - 1_000, rememberMe: true, refreshToken: SECRETS.refresh });
      const error = await syncOneAccountReplica("google-drive").then(() => "", (cause: unknown) => (cause as Error).message);
      shown.push(error, useConnectionStore.getState().configuration.google?.replica.lastErrorMessage ?? "");
      const direct = await acquireGoogleConnectionToken({ force: true }).then(() => undefined, (cause: unknown) => cause);
      shown.push(String(direct), String((direct as Error | undefined)?.stack ?? ""), classifyAccountSyncError(direct));
    }
    const everything = shown.join("\n");
    expect(everything).not.toContain(SECRETS.refresh);
    expect(everything).not.toContain("ya29.A0ARrdaM-0123456789abcdef0123456789");
    expect(spy.output()).not.toContain(SECRETS.refresh);
  });
});
