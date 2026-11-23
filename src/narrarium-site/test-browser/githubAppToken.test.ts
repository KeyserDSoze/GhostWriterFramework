import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import "fake-indexeddb/auto";

vi.mock("@/config/publicClients", () => ({ GITHUB_APP_CLIENT_ID: "Iv1.client-id", GITHUB_APP_SLUG: "narrarium", GOOGLE_CLIENT_ID: "g", MICROSOFT_CLIENT_ID: "m" }));
const scheduled = vi.hoisted(() => ({ schedule: vi.fn() }));
vi.mock("@/account/accountSync", async (importOriginal) => ({ ...(await importOriginal<typeof import("@/account/accountSync")>()), scheduleAccountSync: scheduled.schedule }));

import { closeAccountLocalStoreForTests, initializeAccountLocalStore, loadLocalSyncConfiguration } from "@/account/accountLocalStore";
import { acquireGitHubAppToken, installGitHubAppTokenRetry, onGitHubAppTokenRenewed, resetGitHubAppTokenForTests } from "@/account/githubAppToken";
import { acquireGitHubConnectionToken } from "@/account/githubConnectionToken";
import { AccountCredentialError, useConnectionStore } from "@/account/connectionStore";
import { resetBrokerAvailabilityForTests } from "@/account/credentialBroker";
import { closeCredentialVaultForTests, loadRefreshToken } from "@/account/credentialVault";
import { resetDeviceLocalSecretsForTests } from "@/account/deviceSecrets";
import { installProactiveCredentialRefresh, renewLongLivedCredentials, resetProactiveCredentialRefreshForTests } from "@/account/proactiveCredentialRefresh";
import { classifyAccountSyncError } from "@/account/accountSync";
import { resetTokenRefreshLockForTests } from "@/account/tokenRefreshLock";
import { emptyCostsFile } from "@/costs/model";
import { currentConnectedGitHubToken, setConnectedGitHubToken } from "@/github/githubCredentialRuntime";
import { DEFAULT_SETTINGS } from "@/types/settings";
import { BROKER_BASE, SECRETS, createFakeNetwork, deleteDatabases, dumpIndexedDb, installFakeLocks, jsonResponse, spyOnConsole, type FakeLocks, type FakeNetwork } from "./oauthTestKit";

const REFRESH_URL = `${BROKER_BASE}/oauth/github/refresh`;
const REVOKE_URL = `${BROKER_BASE}/oauth/github/revoke`;
const ACCOUNT = "4242";
let net: FakeNetwork;
let locks: FakeLocks | null = null;

const fresh = (n: number) => ({ accessToken: `at-SENTINEL-gh-${n}`, expiresIn: 28_800, refreshToken: `rt-SENTINEL-gh-${n}` });
const connect = (patch: Record<string, unknown> = {}) => useConnectionStore.getState().connectGitHub({
  method: "github-app", credentialKind: "app",
  identity: { provider: "github", providerAccountId: ACCOUNT, displayName: "Writer", username: "writer" },
  token: SECRETS.access, accessTokenExpiry: Date.now() - 1_000, refreshToken: SECRETS.refresh,
  rememberMe: true, accountSyncEnabled: false, repositoryOwner: "writer",
  ...patch,
});
const github = () => useConnectionStore.getState().configuration.github!;
const refreshCalls = () => net.broker("/oauth/github/refresh");

beforeEach(async () => {
  closeAccountLocalStoreForTests();
  closeCredentialVaultForTests();
  await deleteDatabases("narrarium-local-account", "narrarium-credential-vault");
  localStorage.clear();
  resetBrokerAvailabilityForTests();
  resetTokenRefreshLockForTests();
  resetProactiveCredentialRefreshForTests();
  resetGitHubAppTokenForTests();
  resetDeviceLocalSecretsForTests();
  setConnectedGitHubToken(undefined);
  scheduled.schedule.mockReset();
  net = createFakeNetwork();
  vi.stubGlobal("fetch", net.fetch);
  vi.stubEnv("VITE_AUTH_BROKER_BASE", BROKER_BASE);
  await initializeAccountLocalStore({ settings: DEFAULT_SETTINGS, costs: emptyCostsFile(), clipboard: [], chats: [] });
  useConnectionStore.setState({ hydrated: true, configuration: {} });
});
afterEach(() => {
  locks?.uninstall();
  locks = null;
  resetGitHubAppTokenForTests();
  resetProactiveCredentialRefreshForTests();
  vi.useRealTimers();
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
  closeCredentialVaultForTests();
});

describe("the GitHub App token is kept alive through the broker", () => {
  it("uses a token that has life left as it is, without asking anybody", async () => {
    await connect({ accessTokenExpiry: Date.now() + 3 * 3_600_000 });
    await expect(acquireGitHubAppToken()).resolves.toBe(SECRETS.access);
    expect(net.calls).toHaveLength(0);
  });

  it("renews an expired token, keeps the ROTATED refresh token (sealed first), and gives the new token to the readers that do not wait", async () => {
    net.reply("POST", REFRESH_URL, fresh(1));
    await connect();
    await expect(acquireGitHubAppToken()).resolves.toBe("at-SENTINEL-gh-1");
    expect(refreshCalls()[0].body).toEqual({ refreshToken: SECRETS.refresh });
    expect(github()).toMatchObject({ token: "at-SENTINEL-gh-1", refreshToken: "rt-SENTINEL-gh-1" });
    expect(github().accessTokenExpiry).toBeGreaterThan(Date.now() + 7 * 3_600_000);
    await expect(loadRefreshToken("github", ACCOUNT)).resolves.toBe("rt-SENTINEL-gh-1");
    expect(currentConnectedGitHubToken()).toBe("at-SENTINEL-gh-1");
    const device = await loadLocalSyncConfiguration();
    expect(device.github?.token).toBe("at-SENTINEL-gh-1");
    expect(device.github?.refreshToken).toBeUndefined();
    expect(await dumpIndexedDb("narrarium-local-account")).not.toContain("rt-SENTINEL-gh-1");
  });

  it("renews a token that is about to end (less than a minute left), not one that has a few minutes", async () => {
    net.reply("POST", REFRESH_URL, fresh(1));
    await connect({ accessTokenExpiry: Date.now() + 30_000 });
    await acquireGitHubAppToken();
    expect(refreshCalls()).toHaveLength(1);
    net.reset();
    await useConnectionStore.setState({ configuration: { github: { ...github(), accessTokenExpiry: Date.now() + 5 * 60_000 } } });
    await acquireGitHubAppToken();
    expect(net.calls).toHaveLength(0);
  });

  it("renews once for any number of callers at the same time", async () => {
    let calls = 0;
    net.on("POST", REFRESH_URL, async () => { calls += 1; await new Promise((resolve) => setTimeout(resolve, 20)); return jsonResponse(fresh(1)); });
    await connect();
    const tokens = await Promise.all([acquireGitHubAppToken(), acquireGitHubAppToken(), acquireGitHubAppToken()]);
    expect(tokens).toEqual(["at-SENTINEL-gh-1", "at-SENTINEL-gh-1", "at-SENTINEL-gh-1"]);
    expect(calls).toBe(1);
  });

  it("takes a Web Lock named for the provider, so two tabs never spend the same refresh token", async () => {
    locks = installFakeLocks();
    net.reply("POST", REFRESH_URL, fresh(1));
    await connect();
    await acquireGitHubAppToken();
    expect(locks.requests).toEqual([{ name: "narrarium-token-refresh:github", mode: "exclusive" }]);
  });

  it("another tab that renewed meanwhile is adopted, not renewed again (the refresh token already rotated)", async () => {
    locks = installFakeLocks();
    net.reply("POST", REFRESH_URL, fresh(1));
    await connect();
    await acquireGitHubAppToken(); // tab A renewed: the device holds the new token and the sealed new refresh token
    const renewedByA = github();
    // Tab B still has what it had when it started: the expired token and the old, now dead, refresh token.
    useConnectionStore.setState({ configuration: { github: { ...renewedByA, token: SECRETS.access, accessTokenExpiry: Date.now() - 1_000, refreshToken: SECRETS.refresh } } });
    net.reset();
    net.reply("POST", REFRESH_URL, { error: "invalid_grant", message: "used twice" }, 400);

    await expect(acquireGitHubAppToken()).resolves.toBe("at-SENTINEL-gh-1");

    expect(net.calls).toHaveLength(0);
    expect(github()).toMatchObject({ token: "at-SENTINEL-gh-1", refreshToken: "rt-SENTINEL-gh-1" });
  });

  it("after a forced renewal of a token another tab already replaced, uses the new one instead of renewing a third time", async () => {
    locks = installFakeLocks();
    net.reply("POST", REFRESH_URL, fresh(1));
    await connect({ accessTokenExpiry: Date.now() + 3_600_000 });
    await acquireGitHubAppToken({ force: true, stale: SECRETS.access });
    expect(refreshCalls()).toHaveLength(1);
    await acquireGitHubAppToken({ force: true, stale: SECRETS.access });
    expect(refreshCalls()).toHaveLength(1);
  });

  it("tells the listeners (the personal server's copy is one) about each renewed token, and survives one that throws", async () => {
    net.reply("POST", REFRESH_URL, fresh(1));
    const seen: string[] = [];
    onGitHubAppTokenRenewed(() => { throw new Error("boom"); });
    onGitHubAppTokenRenewed((token) => seen.push(token));
    await connect();
    await acquireGitHubAppToken();
    expect(seen).toEqual(["at-SENTINEL-gh-1"]);
  });

  describe("a refresh token that no longer works means «Reconnect GitHub», never a retry", () => {
    it("invalid_grant: the token is forgotten here and in the vault, the error says the sign-in must be renewed, and the account sync class is credential-expired", async () => {
      net.reply("POST", REFRESH_URL, { error: "invalid_grant", message: "Connect again." }, 400);
      await connect();
      const error = await acquireGitHubAppToken().catch((cause: unknown) => cause);
      expect(error).toBeInstanceOf(AccountCredentialError);
      expect(error).toMatchObject({ backend: "github", reason: "expired", code: "bad_refresh_token" });
      expect(classifyAccountSyncError(error)).toBe("credential-expired");
      expect(github().refreshToken).toBeUndefined();
      await expect(loadRefreshToken("github", ACCOUNT)).resolves.toBeNull();
      expect(github()).toMatchObject({ credentialKind: "app", identity: { username: "writer" } });
      // The next try does not call the broker again: there is nothing left to try with.
      net.reset();
      await expect(acquireGitHubAppToken()).rejects.toMatchObject({ reason: "expired" });
      expect(net.calls).toHaveLength(0);
    });

    it("not_configured (the Worker lost its secret): reconnect, and the token is kept in case it comes back", async () => {
      net.reply("POST", REFRESH_URL, { error: "not_configured", message: "x" }, 501);
      await connect();
      await expect(acquireGitHubAppToken()).rejects.toMatchObject({ reason: "expired", code: "not_configured" });
      expect(github().refreshToken).toBe(SECRETS.refresh);
    });

    it("a passing problem (network, 5xx, rate limit) is passed on as it is and nothing is deleted", async () => {
      await connect();
      net.reply("POST", REFRESH_URL, { error: "upstream_error", message: "x" }, 502);
      await expect(acquireGitHubAppToken()).rejects.toMatchObject({ code: "upstream" });
      net.on("POST", REFRESH_URL, () => { throw new TypeError("offline"); });
      await expect(acquireGitHubAppToken()).rejects.toMatchObject({ code: "network" });
      expect(github().refreshToken).toBe(SECRETS.refresh);
      await expect(loadRefreshToken("github", ACCOUNT)).resolves.toBe(SECRETS.refresh);
    });

    it("a connection with no refresh token (a session that was not kept) asks to reconnect without calling anybody", async () => {
      await connect({ refreshToken: undefined, rememberMe: false });
      await expect(acquireGitHubAppToken()).rejects.toMatchObject({ reason: "expired" });
      expect(net.calls).toHaveLength(0);
    });
  });

  it("asks for a PAT connection what it always did: its token, with nothing renewed", async () => {
    await useConnectionStore.getState().connectGitHub({ method: "github-pat", credentialKind: "pat", token: "ghp_pat", identity: { provider: "github", providerAccountId: "1", displayName: "W", username: "w" }, rememberMe: true, accountSyncEnabled: true, repositoryOwner: "w" });
    await expect(acquireGitHubConnectionToken()).resolves.toBe("ghp_pat");
    expect(net.calls).toHaveLength(0);
  });

  it("writes nothing to the console", async () => {
    const consoleSpy = spyOnConsole();
    net.reply("POST", REFRESH_URL, fresh(1));
    await connect();
    await acquireGitHubAppToken();
    net.reply("POST", REFRESH_URL, { error: "invalid_grant", message: "x" }, 400);
    await acquireGitHubAppToken({ force: true }).catch(() => undefined);
    expect(consoleSpy.count()).toBe(0);
  });
});

describe("a 401 from GitHub: one renewal, one retry, no loop", () => {
  const API = "https://api.github.com/user/repos";
  const call = (token: string, init: RequestInit = {}) => fetch(API, { ...init, headers: { Authorization: `token ${token}`, Accept: "application/vnd.github+json" } });
  const used = () => net.callsTo("GET", API).map((entry) => entry.headers.authorization);

  async function setup(answer: (call: { headers: Record<string, string> }) => Response) {
    net.on("GET", API, answer);
    await connect({ accessTokenExpiry: Date.now() + 3_600_000 });
    installGitHubAppTokenRetry();
  }

  it("renews the app's token when GitHub refuses it, and repeats the request once with the new one", async () => {
    net.reply("POST", REFRESH_URL, fresh(1));
    await setup((entry) => (entry.headers.authorization === `token ${SECRETS.access}` ? jsonResponse({ message: "Bad credentials" }, 401) : jsonResponse([{ id: 1 }])));

    const response = await call(SECRETS.access);

    expect(response.status).toBe(200);
    expect(used()).toEqual([`token ${SECRETS.access}`, "token at-SENTINEL-gh-1"]);
    expect(refreshCalls()).toHaveLength(1);
    expect(currentConnectedGitHubToken()).toBe("at-SENTINEL-gh-1");
  });

  it("keeps the scheme the request used (Bearer stays Bearer) and its body", async () => {
    net.reply("POST", REFRESH_URL, fresh(1));
    net.on("POST", "https://api.github.com/user/repos", (entry) => (entry.headers.authorization === `Bearer ${SECRETS.access}` ? jsonResponse({}, 401) : jsonResponse({ ok: true }, 201)));
    await connect({ accessTokenExpiry: Date.now() + 3_600_000 });
    installGitHubAppTokenRetry();
    const response = await fetch(API, { method: "POST", body: JSON.stringify({ name: "x" }), headers: { Authorization: `Bearer ${SECRETS.access}` } });
    expect(response.status).toBe(201);
    const [first, second] = net.callsTo("POST", API);
    expect(second.headers.authorization).toBe("Bearer at-SENTINEL-gh-1");
    expect(second.body).toEqual(first.body);
  });

  it("a second 401 is the answer: nothing loops", async () => {
    net.reply("POST", REFRESH_URL, fresh(1));
    await setup(() => jsonResponse({ message: "Bad credentials" }, 401));
    const response = await call(SECRETS.access);
    expect(response.status).toBe(401);
    expect(used()).toHaveLength(2);
    expect(refreshCalls()).toHaveLength(1);
  });

  it("a refresh that fails (invalid_grant) leaves the 401 as it was and asks to reconnect", async () => {
    net.reply("POST", REFRESH_URL, { error: "invalid_grant", message: "x" }, 400);
    await setup(() => jsonResponse({ message: "Bad credentials" }, 401));
    const response = await call(SECRETS.access);
    expect(response.status).toBe(401);
    expect(used()).toHaveLength(1);
    expect(github().refreshToken).toBeUndefined();
  });

  it("two requests refused at once share one renewal", async () => {
    let refreshes = 0;
    net.on("POST", REFRESH_URL, async () => { refreshes += 1; await new Promise((resolve) => setTimeout(resolve, 15)); return jsonResponse(fresh(1)); });
    await setup((entry) => (entry.headers.authorization === `token ${SECRETS.access}` ? jsonResponse({}, 401) : jsonResponse([])));
    const [a, b] = await Promise.all([call(SECRETS.access), call(SECRETS.access)]);
    expect([a.status, b.status]).toEqual([200, 200]);
    expect(refreshes).toBe(1);
  });

  it("a request that still carries the token that was just replaced is repeated with the new one without renewing again", async () => {
    net.reply("POST", REFRESH_URL, fresh(1));
    await setup((entry) => (entry.headers.authorization === `token ${SECRETS.access}` ? jsonResponse({}, 401) : jsonResponse([])));
    await call(SECRETS.access);
    net.reset();
    net.on("GET", API, (entry) => (entry.headers.authorization === `token ${SECRETS.access}` ? jsonResponse({}, 401) : jsonResponse([])));
    const response = await call(SECRETS.access);
    expect(response.status).toBe(200);
    expect(refreshCalls()).toHaveLength(0);
  });

  it("leaves alone a 401 for a personal access token, for another host and for a body that cannot be sent twice", async () => {
    await setup(() => jsonResponse({}, 401));
    expect((await call("ghp_personal")).status).toBe(401);
    net.on("GET", "https://example.test/x", () => jsonResponse({}, 401));
    expect((await fetch("https://example.test/x", { headers: { Authorization: `token ${SECRETS.access}` } })).status).toBe(401);
    net.on("POST", API, () => jsonResponse({}, 401));
    const stream = new ReadableStream({ start(controller) { controller.close(); } });
    const response = await fetch(API, { method: "POST", body: stream, headers: { Authorization: `token ${SECRETS.access}` }, duplex: "half" } as RequestInit);
    expect(response.status).toBe(401);
    expect(refreshCalls()).toHaveLength(0);
  });

  it("changes nothing for a 200, and installs only once", async () => {
    await setup(() => jsonResponse([]));
    installGitHubAppTokenRetry();
    expect((await call(SECRETS.access)).status).toBe(200);
    expect(used()).toHaveLength(1);
  });
});

describe("renewing ahead of time, with a backoff", () => {
  it("renews an app token that is about to end even when the account sync of GitHub is off, and sends no sync", async () => {
    net.reply("POST", REFRESH_URL, fresh(1));
    await connect({ accessTokenExpiry: Date.now() + 2 * 60_000 });
    await renewLongLivedCredentials("start");
    expect(github().token).toBe("at-SENTINEL-gh-1");
    expect(scheduled.schedule).not.toHaveBeenCalled();
  });

  it("does not touch a PAT connection", async () => {
    await useConnectionStore.getState().connectGitHub({ method: "github-pat", credentialKind: "pat", token: "ghp_pat", identity: { provider: "github", providerAccountId: "1", displayName: "W", username: "w" }, rememberMe: true, accountSyncEnabled: true, repositoryOwner: "w" });
    await renewLongLivedCredentials("start");
    expect(net.calls).toHaveLength(0);
  });

  it("backs off after a failure: the next attempt waits (30 s, then twice as long), and a lapsed sign-in is reported on the replica", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(new Date("2026-11-23T10:00:00.000Z"));
    net.reply("POST", REFRESH_URL, { error: "upstream_error", message: "x" }, 502);
    await connect({ accessTokenExpiry: Date.now() - 1_000 });
    await renewLongLivedCredentials("start");
    expect(refreshCalls()).toHaveLength(1);
    await renewLongLivedCredentials("visible");
    expect(refreshCalls()).toHaveLength(1);
    vi.setSystemTime(new Date("2026-11-23T10:00:31.000Z"));
    await renewLongLivedCredentials("visible");
    expect(refreshCalls()).toHaveLength(2);
    vi.setSystemTime(new Date("2026-11-23T10:01:00.000Z"));
    await renewLongLivedCredentials("visible");
    expect(refreshCalls()).toHaveLength(2);
    vi.setSystemTime(new Date("2026-11-23T10:01:40.000Z"));
    net.reply("POST", REFRESH_URL, { error: "invalid_grant", message: "x" }, 400);
    await renewLongLivedCredentials("visible");
    expect(refreshCalls()).toHaveLength(3);
    expect(github().replica).toMatchObject({ status: "needs-auth", errorKind: "credential-expired" });
    expect(github().replica.lastErrorMessage).toContain("bad_refresh_token");
  });

  it("renews again just before the token ends, for as long as the tab stays open", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "Date"] });
    vi.setSystemTime(new Date("2026-11-23T10:00:00.000Z"));
    net.reply("POST", REFRESH_URL, fresh(1));
    await connect({ accessTokenExpiry: Date.now() + 2 * 3_600_000 });
    installProactiveCredentialRefresh();
    await vi.advanceTimersByTimeAsync(10);
    expect(refreshCalls()).toHaveLength(0);
    await vi.advanceTimersByTimeAsync(2 * 3_600_000);
    await vi.waitFor(() => expect(github().token).toBe("at-SENTINEL-gh-1"));
    expect(refreshCalls()).toHaveLength(1);
  });
});

describe("restoring the connection when the app starts", () => {
  it("unseals the refresh token of a remembered app connection, and the 401 retry is installed", async () => {
    net.reply("POST", REFRESH_URL, fresh(1));
    await connect({ accessTokenExpiry: Date.now() + 3_600_000 });
    // A new start: memory is gone, the device and the vault remain.
    useConnectionStore.setState({ hydrated: false, configuration: {} });
    setConnectedGitHubToken(undefined);
    await useConnectionStore.getState().hydrate();
    expect(github()).toMatchObject({ credentialKind: "app", token: SECRETS.access, refreshToken: SECRETS.refresh });
    expect(currentConnectedGitHubToken()).toBe(SECRETS.access);
    await vi.waitFor(() => expect((globalThis.fetch as unknown as { name?: string }).name).not.toBe("mockConstructor"));
  });
});
