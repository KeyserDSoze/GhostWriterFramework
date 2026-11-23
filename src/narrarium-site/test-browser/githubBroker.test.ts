import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { BrokerError, brokerAvailable, exchangeCode, refresh, resetBrokerAvailabilityForTests, revoke } from "@/account/credentialBroker";
import { BROKER_BASE, SECRETS, createFakeNetwork, jsonResponse, spyOnConsole, type FakeNetwork } from "./oauthTestKit";

const url = (path: string) => `${BROKER_BASE}${path}`;
let net: FakeNetwork;

beforeEach(() => {
  resetBrokerAvailabilityForTests();
  net = createFakeNetwork();
  vi.stubGlobal("fetch", net.fetch);
  vi.stubEnv("VITE_AUTH_BROKER_BASE", BROKER_BASE);
});
afterEach(() => { vi.unstubAllGlobals(); vi.unstubAllEnvs(); });

const caught = async (promise: Promise<unknown>): Promise<BrokerError> => {
  const error = await promise.then(() => undefined, (cause: unknown) => cause);
  expect(error).toBeInstanceOf(BrokerError);
  return error as BrokerError;
};
const REQUEST = { provider: "github" as const, code: SECRETS.code, codeVerifier: SECRETS.verifier, redirectUri: "https://narrarium.net/auth/github/callback" };
const ANSWER = { accessToken: SECRETS.access, expiresIn: 28_800, refreshToken: SECRETS.refresh, refreshTokenExpiresIn: 15_897_600 };

describe("GitHub through the broker: is it there? (GET /oauth/status)", () => {
  it("reads the github boolean next to the other two", async () => {
    net.reply("GET", url("/oauth/status"), { google: false, microsoft: false, github: true });
    await expect(brokerAvailable("github")).resolves.toBe(true);
    await expect(brokerAvailable("google")).resolves.toBe(false);
    expect(net.broker("/oauth/status")).toHaveLength(1);
  });

  it("takes an older Worker, that answers two booleans, as github: false", async () => {
    net.reply("GET", url("/oauth/status"), { google: true, microsoft: true });
    await expect(brokerAvailable("github")).resolves.toBe(false);
    await expect(brokerAvailable("google")).resolves.toBe(true);
  });

  it("does not trust a github value that is not a boolean: the whole answer is refused", async () => {
    net.reply("GET", url("/oauth/status"), { google: true, microsoft: true, github: "yes" });
    await expect(brokerAvailable("github")).resolves.toBe(false);
    await expect(brokerAvailable("google")).resolves.toBe(false);
  });
});

describe("exchanging the code of the GitHub App", () => {
  it("sends the code, the verifier and the redirect address, and nothing else, and returns the tokens with the rotating refresh token", async () => {
    net.reply("POST", url("/oauth/github/token"), ANSWER);
    await expect(exchangeCode(REQUEST)).resolves.toEqual(ANSWER);
    const [call] = net.broker("/oauth/github/token");
    expect(call.body).toEqual({ code: SECRETS.code, codeVerifier: SECRETS.verifier, redirectUri: REQUEST.redirectUri });
    expect(call.headers["content-type"]).toBe("application/json");
    expect(call.init.credentials).toBe("omit");
    expect(JSON.stringify(call.body)).not.toMatch(/secret|client/i);
  });

  it("keeps a scope that is there, and takes none as none", async () => {
    net.reply("POST", url("/oauth/github/token"), { ...ANSWER, scope: "x" });
    await expect(exchangeCode(REQUEST)).resolves.toMatchObject({ scope: "x" });
    net.reply("POST", url("/oauth/github/token"), { accessToken: "a", expiresIn: 28_800, refreshToken: "r" });
    expect(await exchangeCode(REQUEST)).toEqual({ accessToken: "a", expiresIn: 28_800, refreshToken: "r" });
  });

  it.each([
    ["no access token", { expiresIn: 28_800 }],
    ["an empty access token", { accessToken: "", expiresIn: 28_800 }],
    ["a lifetime that is not a whole number", { accessToken: "a", expiresIn: 28_800.5 }],
    ["a lifetime of zero", { accessToken: "a", expiresIn: 0 }],
    ["an absurd lifetime", { accessToken: "a", expiresIn: 99_999_999 }],
    ["a refresh token that is not text", { accessToken: "a", expiresIn: 1, refreshToken: 7 }],
    ["a refresh lifetime that is not a number", { accessToken: "a", expiresIn: 1, refreshToken: "r", refreshTokenExpiresIn: "soon" }],
    ["a refresh lifetime that is negative", { accessToken: "a", expiresIn: 1, refreshToken: "r", refreshTokenExpiresIn: -5 }],
    ["an array", [ANSWER]],
  ])("refuses an answer with %s", async (_label, body) => {
    net.reply("POST", url("/oauth/github/token"), body);
    const error = await caught(exchangeCode(REQUEST));
    expect(error.code).toBe("upstream");
  });

  it("says invalid_grant for a code GitHub refused, and never quotes what was sent", async () => {
    net.reply("POST", url("/oauth/github/token"), { error: "invalid_grant", message: `GitHub rejected ${SECRETS.code}` }, 400);
    const error = await caught(exchangeCode(REQUEST));
    expect(error.code).toBe("invalid_grant");
    expect(error.status).toBe(400);
    expect(error.message).not.toContain(SECRETS.code);
  });

  it("says not_configured when the Worker has no secret for GitHub", async () => {
    net.reply("POST", url("/oauth/github/token"), { error: "not_configured", message: "GitHub sign-in is not configured." }, 501);
    expect((await caught(exchangeCode(REQUEST))).code).toBe("not_configured");
  });

  it("says rate_limited, with the wait the Worker asked for", async () => {
    net.reply("POST", url("/oauth/github/token"), { error: "rate_limited", message: "slow down" }, 429, { "Retry-After": "12" });
    const error = await caught(exchangeCode(REQUEST));
    expect(error.code).toBe("rate_limited");
    expect(error.retryAfterMs).toBe(12_000);
  });

  it("says upstream for a Worker error and for a GitHub that cannot be reached, and network for a dead connection", async () => {
    net.reply("POST", url("/oauth/github/token"), { error: "upstream_error", message: "x" }, 502);
    expect((await caught(exchangeCode(REQUEST))).code).toBe("upstream");
    net.on("POST", url("/oauth/github/token"), () => { throw new TypeError("Failed to fetch"); });
    expect((await caught(exchangeCode(REQUEST))).code).toBe("network");
  });
});

describe("renewing, and revoking, the GitHub App's token", () => {
  it("sends the refresh token alone, and returns the NEW refresh token that replaces it", async () => {
    net.reply("POST", url("/oauth/github/refresh"), { accessToken: SECRETS.accessFresh, expiresIn: 28_800, refreshToken: SECRETS.refreshRotated, refreshTokenExpiresIn: 15_897_600 });
    const tokens = await refresh("github", SECRETS.refresh);
    expect(tokens).toMatchObject({ accessToken: SECRETS.accessFresh, refreshToken: SECRETS.refreshRotated, refreshTokenExpiresIn: 15_897_600 });
    expect(net.broker("/oauth/github/refresh")[0].body).toEqual({ refreshToken: SECRETS.refresh });
  });

  it("says invalid_grant for a refresh token that was used twice, revoked or has expired", async () => {
    net.reply("POST", url("/oauth/github/refresh"), { error: "invalid_grant", message: "Connect again." }, 400);
    expect((await caught(refresh("github", SECRETS.refresh))).code).toBe("invalid_grant");
  });

  it("revokes with the access token, and says what failed without quoting it", async () => {
    net.reply("POST", url("/oauth/github/revoke"), null, 204);
    await expect(revoke("github", SECRETS.accessFresh)).resolves.toBeUndefined();
    expect(net.broker("/oauth/github/revoke")[0].body).toEqual({ token: SECRETS.accessFresh });
    net.reply("POST", url("/oauth/github/revoke"), { error: "upstream_error", message: `no ${SECRETS.accessFresh}` }, 502);
    const error = await caught(revoke("github", SECRETS.accessFresh));
    expect(error.message).not.toContain(SECRETS.accessFresh);
    expect(error.message).toContain("GitHub");
  });

  it("writes nothing to the console, whatever happens", async () => {
    const consoleSpy = spyOnConsole();
    net.reply("POST", url("/oauth/github/token"), { error: "invalid_grant", message: "x" }, 400);
    await caught(exchangeCode(REQUEST));
    net.reply("POST", url("/oauth/github/refresh"), ANSWER);
    await refresh("github", SECRETS.refresh);
    net.on("POST", url("/oauth/github/revoke"), () => { throw new TypeError("offline"); });
    await caught(revoke("github", SECRETS.accessFresh));
    expect(consoleSpy.count()).toBe(0);
    void jsonResponse;
  });
});
