import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import "fake-indexeddb/auto";

vi.mock("@/config/publicClients", () => ({ GITHUB_APP_CLIENT_ID: "Iv1.client-id", GITHUB_APP_SLUG: "narrarium", GOOGLE_CLIENT_ID: "g", MICROSOFT_CLIENT_ID: "m" }));

import { closeAccountLocalStoreForTests, initializeAccountLocalStore, loadLocalSyncConfiguration } from "@/account/accountLocalStore";
import { completeGitHubBrokerConnection } from "@/account/brokerConnect";
import { ConnectFlowError } from "@/account/connectErrors";
import { useConnectionStore } from "@/account/connectionStore";
import { BrokerError, resetBrokerAvailabilityForTests } from "@/account/credentialBroker";
import { closeCredentialVaultForTests, loadRefreshToken } from "@/account/credentialVault";
import { resetDeviceLocalSecretsForTests } from "@/account/deviceSecrets";
import { emptyCostsFile } from "@/costs/model";
import { createGitHubAppAuthorizationUrl } from "@/github/githubOAuth";
import { currentConnectedGitHubSource, currentConnectedGitHubToken, setConnectedGitHubToken } from "@/github/githubCredentialRuntime";
import { DEFAULT_SETTINGS } from "@/types/settings";
import { BROKER_BASE, SECRETS, createFakeNetwork, deleteDatabases, dumpIndexedDb, jsonResponse, spyOnConsole, type FakeNetwork } from "./oauthTestKit";

const TOKEN_URL = `${BROKER_BASE}/oauth/github/token`;
const USER_URL = "https://api.github.com/user";
const USER = { id: 4242, login: "writer", name: "The Writer", email: "writer@example.com", avatar_url: "https://avatars.example/u/4242" };
const ANSWER = { accessToken: SECRETS.access, expiresIn: 28_800, refreshToken: SECRETS.refresh, refreshTokenExpiresIn: 15_897_600 };
let net: FakeNetwork;

async function authorize(options: { rememberMe?: boolean } = {}): Promise<string> {
  const url = new URL(await createGitHubAppAuthorizationUrl({ rememberMe: options.rememberMe ?? true, returnTo: "/app/account-sync" }));
  return url.searchParams.get("state")!;
}
const connection = () => useConnectionStore.getState().configuration.github;

beforeEach(async () => {
  closeAccountLocalStoreForTests();
  closeCredentialVaultForTests();
  await deleteDatabases("narrarium-local-account", "narrarium-credential-vault");
  localStorage.clear();
  sessionStorage.clear();
  resetBrokerAvailabilityForTests();
  resetDeviceLocalSecretsForTests();
  setConnectedGitHubToken(undefined);
  net = createFakeNetwork();
  vi.stubGlobal("fetch", net.fetch);
  vi.stubEnv("VITE_AUTH_BROKER_BASE", BROKER_BASE);
  await initializeAccountLocalStore({ settings: DEFAULT_SETTINGS, costs: emptyCostsFile(), clipboard: [], chats: [] });
  useConnectionStore.setState({ hydrated: true, configuration: {} });
});
afterEach(() => { vi.unstubAllGlobals(); vi.unstubAllEnvs(); closeCredentialVaultForTests(); });

describe("finishing «Connect with GitHub»", () => {
  it("swaps the code at the broker, reads the user with the new token and saves the connection, with the refresh token sealed in the vault", async () => {
    net.reply("POST", TOKEN_URL, ANSWER);
    net.reply("GET", USER_URL, USER);
    const state = await authorize();

    const done = await completeGitHubBrokerConnection({ code: SECRETS.code, state });

    expect(done).toEqual({ returnTo: "/app/account-sync", rememberMe: true });
    const [exchange] = net.broker("/oauth/github/token");
    expect(exchange.body).toMatchObject({ code: SECRETS.code, redirectUri: expect.stringMatching(/\/auth\/github\/callback$/) });
    expect((exchange.body as { codeVerifier: string }).codeVerifier).toMatch(/^[A-Za-z0-9_-]{80,}$/);
    expect(net.callsTo("GET", USER_URL)[0].headers.authorization).toBe(`Bearer ${SECRETS.access}`);
    expect(connection()).toMatchObject({
      backend: "github", method: "github-app", credentialKind: "app", token: SECRETS.access, refreshToken: SECRETS.refresh, rememberMe: true,
      identity: { provider: "github", providerAccountId: "4242", username: "writer", displayName: "The Writer" },
      accountSyncEnabled: true, replica: { enabled: true },
    });
    expect(connection()!.accessTokenExpiry).toBeGreaterThan(Date.now() + 7 * 3_600_000);
    expect(connection()!.accessTokenExpiry).toBeLessThan(Date.now() + 8 * 3_600_000);
    expect(currentConnectedGitHubToken()).toBe(SECRETS.access);
    expect(currentConnectedGitHubSource()).toBe("app");
  });

  it("keeps the refresh token out of the device database, in the sealed vault only", async () => {
    net.reply("POST", TOKEN_URL, ANSWER);
    net.reply("GET", USER_URL, USER);
    await completeGitHubBrokerConnection({ code: SECRETS.code, state: await authorize() });
    await expect(loadRefreshToken("github", "4242")).resolves.toBe(SECRETS.refresh);
    await expect(loadRefreshToken("github", "someone-else")).resolves.toBeNull();
    const device = await dumpIndexedDb("narrarium-local-account");
    expect(device).not.toContain(SECRETS.refresh);
    expect((await loadLocalSyncConfiguration()).github?.refreshToken).toBeUndefined();
    expect(await dumpIndexedDb("narrarium-credential-vault")).not.toContain(SECRETS.refresh);
  });

  it("keeps nothing of the session on the device when it is not remembered: the tokens stay in memory", async () => {
    net.reply("POST", TOKEN_URL, ANSWER);
    net.reply("GET", USER_URL, USER);
    await completeGitHubBrokerConnection({ code: SECRETS.code, state: await authorize({ rememberMe: false }) });
    expect(connection()).toMatchObject({ rememberMe: false, token: SECRETS.access, refreshToken: SECRETS.refresh });
    await expect(loadRefreshToken("github", "4242")).resolves.toBeNull();
    expect((await loadLocalSyncConfiguration()).github?.token).toBeUndefined();
    expect(await dumpIndexedDb("narrarium-local-account")).not.toContain(SECRETS.access);
  });

  it("keeps the sync switch and history of the same account that signs in again", async () => {
    await useConnectionStore.getState().connectGitHub({ method: "github-pat", credentialKind: "pat", token: "ghp_old", identity: { provider: "github", providerAccountId: "4242", displayName: "W", username: "writer" }, rememberMe: true, accountSyncEnabled: true, repositoryOwner: "writer", replica: { enabled: true, status: "needs-auth", errorKind: "credential-expired", lastSuccessfulSyncAtUtc: "2026-11-20T10:00:00.000Z" } });
    net.reply("POST", TOKEN_URL, ANSWER);
    net.reply("GET", USER_URL, USER);
    await completeGitHubBrokerConnection({ code: SECRETS.code, state: await authorize() });
    expect(connection()).toMatchObject({ credentialKind: "app", accountSyncEnabled: true, replica: { enabled: true, status: "dirty", lastSuccessfulSyncAtUtc: "2026-11-20T10:00:00.000Z" } });
    expect(connection()!.replica.errorKind).toBeUndefined();
  });

  it("keeps the sync switched off for the same account that had it off, and starts afresh for another account", async () => {
    const PAT = { method: "github-pat" as const, credentialKind: "pat" as const, token: "ghp_old", rememberMe: true, accountSyncEnabled: false, repositoryOwner: "writer" };
    await useConnectionStore.getState().connectGitHub({ ...PAT, identity: { provider: "github", providerAccountId: "4242", displayName: "W", username: "writer" }, replica: { enabled: false, status: "disabled" } });
    net.reply("POST", TOKEN_URL, ANSWER);
    net.reply("GET", USER_URL, USER);
    await completeGitHubBrokerConnection({ code: SECRETS.code, state: await authorize() });
    expect(connection()).toMatchObject({ credentialKind: "app", accountSyncEnabled: false, replica: { enabled: false, status: "disabled" } });

    await useConnectionStore.getState().connectGitHub({ ...PAT, identity: { provider: "github", providerAccountId: "999", displayName: "Other", username: "other" }, replica: { enabled: false, status: "disabled" } });
    net.reply("POST", TOKEN_URL, ANSWER);
    net.reply("GET", USER_URL, USER);
    await completeGitHubBrokerConnection({ code: SECRETS.code, state: await authorize() });
    expect(connection()).toMatchObject({ identity: { providerAccountId: "4242" }, accountSyncEnabled: true, replica: { enabled: true } });
  });

  describe("saves nothing, and leaves the existing connection as it was, when any step fails", () => {
    const PAT = { method: "github-pat" as const, credentialKind: "pat" as const, token: "ghp_existing", identity: { provider: "github" as const, providerAccountId: "1", displayName: "W", username: "old" }, rememberMe: true, accountSyncEnabled: true, repositoryOwner: "old" };
    beforeEach(async () => { await useConnectionStore.getState().connectGitHub(PAT); });
    const untouched = async () => {
      expect(connection()).toMatchObject({ credentialKind: "pat", token: "ghp_existing" });
      expect((await loadLocalSyncConfiguration()).github).toMatchObject({ credentialKind: "pat", token: "ghp_existing" });
      await expect(loadRefreshToken("github", "4242")).resolves.toBeNull();
    };

    it("a state that does not match the attempt: the broker is never asked", async () => {
      await authorize();
      await expect(completeGitHubBrokerConnection({ code: SECRETS.code, state: "not-the-state" })).rejects.toMatchObject({ code: "state_mismatch" });
      expect(net.calls).toHaveLength(0);
      await untouched();
    });

    it("a state used twice, or an attempt that expired", async () => {
      net.reply("POST", TOKEN_URL, ANSWER);
      net.reply("GET", USER_URL, USER);
      const state = await authorize();
      await completeGitHubBrokerConnection({ code: SECRETS.code, state });
      await expect(completeGitHubBrokerConnection({ code: SECRETS.code, state })).rejects.toBeInstanceOf(ConnectFlowError);
      const late = new URL(await createGitHubAppAuthorizationUrl({ rememberMe: true, now: 1_000 })).searchParams.get("state")!;
      await expect(completeGitHubBrokerConnection({ code: SECRETS.code, state: late, now: 1_000 + 11 * 60_000 })).rejects.toMatchObject({ code: "state_mismatch" });
    });

    it("no state at all (the sign-in was started in another tab): nothing is asked of anybody", async () => {
      await expect(completeGitHubBrokerConnection({ code: SECRETS.code, state: "abc" })).rejects.toMatchObject({ code: "state_mismatch" });
      expect(net.calls).toHaveLength(0);
      await untouched();
    });

    it("a refused code", async () => {
      net.reply("POST", TOKEN_URL, { error: "invalid_grant", message: "x" }, 400);
      const failure = await completeGitHubBrokerConnection({ code: SECRETS.code, state: await authorize() }).catch((cause: unknown) => cause);
      expect(failure).toBeInstanceOf(BrokerError);
      expect((failure as BrokerError).code).toBe("invalid_grant");
      expect(net.callsTo("GET", USER_URL)).toHaveLength(0);
      await untouched();
    });

    it("an answer without the refresh token (a token that would end after 8 hours)", async () => {
      net.reply("POST", TOKEN_URL, { accessToken: SECRETS.access, expiresIn: 28_800 });
      await expect(completeGitHubBrokerConnection({ code: SECRETS.code, state: await authorize() })).rejects.toMatchObject({ code: "invalid_response" });
      expect(net.callsTo("GET", USER_URL)).toHaveLength(0);
      await untouched();
    });

    it.each([
      ["GitHub does not accept the new token", () => jsonResponse({ message: "Bad credentials" }, 401)],
      ["GitHub answers with a user that has no stable id", () => jsonResponse({ login: "writer" })],
      ["GitHub answers with an id that is not a positive whole number", () => jsonResponse({ id: -3, login: "writer" })],
      ["GitHub answers with something that is not JSON", () => new Response("<html>", { status: 200 })],
    ])("%s", async (_label, answer) => {
      net.reply("POST", TOKEN_URL, ANSWER);
      net.on("GET", USER_URL, answer);
      await expect(completeGitHubBrokerConnection({ code: SECRETS.code, state: await authorize() })).rejects.toMatchObject({ code: "invalid_response" });
      await untouched();
    });

    it("GitHub cannot be reached to read the account", async () => {
      net.reply("POST", TOKEN_URL, ANSWER);
      net.on("GET", USER_URL, () => { throw new TypeError("Failed to fetch"); });
      await expect(completeGitHubBrokerConnection({ code: SECRETS.code, state: await authorize() })).rejects.toMatchObject({ code: "invalid_response" });
      await untouched();
    });
  });

  it("never logs a token, a code or a verifier", async () => {
    const consoleSpy = spyOnConsole();
    net.reply("POST", TOKEN_URL, { error: "invalid_grant", message: "x" }, 400);
    await completeGitHubBrokerConnection({ code: SECRETS.code, state: await authorize() }).catch(() => undefined);
    net.reply("POST", TOKEN_URL, ANSWER);
    net.reply("GET", USER_URL, USER);
    await completeGitHubBrokerConnection({ code: SECRETS.code, state: await authorize() });
    expect(consoleSpy.count()).toBe(0);
  });
});
