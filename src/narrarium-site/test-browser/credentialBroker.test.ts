import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { BrokerError, brokerAvailabilitySnapshot, brokerAvailable, exchangeCode, refresh, resetBrokerAvailabilityForTests, revoke } from "@/account/credentialBroker";
import { BROKER_BASE, SECRETS, createFakeNetwork, jsonResponse, spyOnConsole, type FakeNetwork } from "./oauthTestKit";

const url = (path: string) => `${BROKER_BASE}${path}`;
let net: FakeNetwork;

beforeEach(() => {
  resetBrokerAvailabilityForTests();
  net = createFakeNetwork();
  vi.stubGlobal("fetch", net.fetch);
  vi.stubEnv("VITE_AUTH_BROKER_BASE", BROKER_BASE);
});

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
});

const caught = async (promise: Promise<unknown>): Promise<BrokerError> => {
  const error = await promise.then(() => undefined, (cause: unknown) => cause);
  expect(error).toBeInstanceOf(BrokerError);
  return error as BrokerError;
};

describe("is the broker there? (GET /oauth/status)", () => {
  it("asks the Worker once per session and answers for each provider from memory", async () => {
    net.reply("GET", url("/oauth/status"), { google: true, microsoft: false });

    expect(brokerAvailabilitySnapshot("google")).toBeUndefined();
    await expect(brokerAvailable("google")).resolves.toBe(true);
    await expect(brokerAvailable("microsoft")).resolves.toBe(false);
    await expect(brokerAvailable("google")).resolves.toBe(true);

    expect(net.broker("/oauth/status")).toHaveLength(1);
    expect(brokerAvailabilitySnapshot("google")).toBe(true);
    expect(brokerAvailabilitySnapshot("microsoft")).toBe(false);
    const [call] = net.broker("/oauth/status");
    expect(call.method).toBe("GET");
    expect(call.body).toBeUndefined();
    expect(call.init.credentials).toBe("omit");
  });

  it("sends a single request even when several callers ask at the same time", async () => {
    net.reply("GET", url("/oauth/status"), { google: true, microsoft: true });
    await expect(Promise.all([brokerAvailable("google"), brokerAvailable("microsoft"), brokerAvailable("google")])).resolves.toEqual([true, true, true]);
    expect(net.broker("/oauth/status")).toHaveLength(1);
  });

  it("is unavailable, without sending anything, when no Worker is configured", async () => {
    vi.stubEnv("VITE_AUTH_BROKER_BASE", "");
    expect(brokerAvailabilitySnapshot("google")).toBe(false);
    await expect(brokerAvailable("google")).resolves.toBe(false);
    await expect(brokerAvailable("microsoft")).resolves.toBe(false);
    expect(net.calls).toHaveLength(0);
  });

  it.each([
    ["the network is down", () => undefined],
    ["the Worker answers 500", () => jsonResponse({ error: "internal_error", message: "x" }, 500)],
    ["the origin is refused", () => jsonResponse({ error: "forbidden_origin", message: "x" }, 403)],
    ["the answer is not JSON", () => new Response("<html>bad gateway</html>", { status: 200 })],
    ["a flag is not a boolean", () => jsonResponse({ google: "true", microsoft: true })],
    ["a flag is missing", () => jsonResponse({ google: true })],
    ["the answer is null", () => jsonResponse(null)],
    ["the answer is a list", () => jsonResponse([true, true])],
  ])("means unavailable, never an error, when %s", async (_label, answer) => {
    const reply = answer();
    if (reply) net.on("GET", url("/oauth/status"), () => reply);
    await expect(brokerAvailable("google")).resolves.toBe(false);
    await expect(brokerAvailable("microsoft")).resolves.toBe(false);
  });

  it("gives up quickly when the Worker does not answer", async () => {
    vi.useFakeTimers();
    let signal: AbortSignal | undefined;
    net.on("GET", url("/oauth/status"), (call) => new Promise<Response>((_resolve, reject) => {
      signal = call.init.signal ?? undefined;
      signal?.addEventListener("abort", () => reject(new DOMException("aborted", "AbortError")));
    }));
    const answer = brokerAvailable("google");
    await vi.advanceTimersByTimeAsync(5_000);
    await expect(answer).resolves.toBe(false);
    expect(signal?.aborted).toBe(true);
  });

  it("does not hammer a Worker that just failed, but tries again later in the same session", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-11-21T10:00:00Z"));
    await expect(brokerAvailable("google")).resolves.toBe(false);
    expect(net.broker("/oauth/status")).toHaveLength(1);

    await vi.advanceTimersByTimeAsync(60_000);
    await expect(brokerAvailable("google")).resolves.toBe(false);
    expect(net.broker("/oauth/status")).toHaveLength(1);

    net.reply("GET", url("/oauth/status"), { google: true, microsoft: true });
    await vi.advanceTimersByTimeAsync(10 * 60_000);
    await expect(brokerAvailable("google")).resolves.toBe(true);
    expect(net.broker("/oauth/status")).toHaveLength(2);
  });

  it("keeps a positive answer for the whole session", async () => {
    vi.useFakeTimers();
    net.reply("GET", url("/oauth/status"), { google: true, microsoft: true });
    await expect(brokerAvailable("google")).resolves.toBe(true);
    await vi.advanceTimersByTimeAsync(24 * 60 * 60_000);
    await expect(brokerAvailable("microsoft")).resolves.toBe(true);
    expect(net.broker("/oauth/status")).toHaveLength(1);
  });
});

describe("the typed broker calls", () => {
  it("exchanges a Google code and returns only the documented fields (no ID token)", async () => {
    net.reply("POST", url("/oauth/google/token"), { accessToken: SECRETS.access, expiresIn: 3599, refreshToken: SECRETS.refresh, scope: "openid email", idToken: SECRETS.idToken, extra: "ignored" });

    const tokens = await exchangeCode({ provider: "google", code: SECRETS.code });

    expect(tokens).toEqual({ accessToken: SECRETS.access, expiresIn: 3599, refreshToken: SECRETS.refresh, scope: "openid email" });
    const [call] = net.broker("/oauth/google/token");
    expect(call.method).toBe("POST");
    expect(call.body).toEqual({ code: SECRETS.code });
  });

  it("exchanges a Microsoft code with its PKCE verifier and redirect URI, and passes client_info through", async () => {
    net.reply("POST", url("/oauth/microsoft/token"), { accessToken: SECRETS.access, expiresIn: 3599, refreshToken: SECRETS.refresh, clientInfo: "eyJ1aWQiOiJhIiwidXRpZCI6ImIifQ" });

    const tokens = await exchangeCode({ provider: "microsoft", code: SECRETS.code, codeVerifier: SECRETS.verifier, redirectUri: "https://narrarium.net/auth/microsoft-callback.html" });

    expect(tokens).toEqual({ accessToken: SECRETS.access, expiresIn: 3599, refreshToken: SECRETS.refresh, clientInfo: "eyJ1aWQiOiJhIiwidXRpZCI6ImIifQ" });
    expect(net.broker("/oauth/microsoft/token")[0].body).toEqual({ code: SECRETS.code, codeVerifier: SECRETS.verifier, redirectUri: "https://narrarium.net/auth/microsoft-callback.html" });
  });

  it("renews a Google access token; Google answers without a new refresh token", async () => {
    net.reply("POST", url("/oauth/google/refresh"), { accessToken: SECRETS.accessFresh, expiresIn: 3599, scope: "openid" });
    const tokens = await refresh("google", SECRETS.refresh);
    expect(tokens).toEqual({ accessToken: SECRETS.accessFresh, expiresIn: 3599, scope: "openid" });
    expect(tokens.refreshToken).toBeUndefined();
    expect(net.broker("/oauth/google/refresh")[0].body).toEqual({ refreshToken: SECRETS.refresh });
  });

  it("renews a Microsoft access token and hands back the rotated refresh token", async () => {
    net.reply("POST", url("/oauth/microsoft/refresh"), { accessToken: SECRETS.accessFresh, expiresIn: 3599, refreshToken: SECRETS.refreshRotated, clientInfo: "eyJ1aWQiOiJhIiwidXRpZCI6ImIifQ" });
    const tokens = await refresh("microsoft", SECRETS.refresh);
    expect(tokens.refreshToken).toBe(SECRETS.refreshRotated);
    expect(tokens.accessToken).toBe(SECRETS.accessFresh);
    expect(net.broker("/oauth/microsoft/refresh")[0].body).toEqual({ refreshToken: SECRETS.refresh });
  });

  it.each(["google", "microsoft"] as const)("revokes a %s token with a body that holds only the token", async (provider) => {
    net.on("POST", url(`/oauth/${provider}/revoke`), () => jsonResponse(null, 204));
    await expect(revoke(provider, SECRETS.refresh)).resolves.toBeUndefined();
    expect(net.broker(`/oauth/${provider}/revoke`)[0].body).toEqual({ token: SECRETS.refresh });
  });

  it("sends nothing but a JSON body: no cookies, no cache, no redirects, no referrer", async () => {
    net.reply("POST", url("/oauth/google/refresh"), { accessToken: SECRETS.accessFresh, expiresIn: 60 });
    await refresh("google", SECRETS.refresh);
    const [call] = net.broker("/oauth/google/refresh");
    expect(call.headers["content-type"]).toBe("application/json");
    expect(call.headers.accept).toContain("application/json");
    expect(call.headers.authorization).toBeUndefined();
    expect(call.init).toMatchObject({ method: "POST", credentials: "omit", cache: "no-store", redirect: "error", referrerPolicy: "no-referrer" });
  });

  it("refuses to call anything when no Worker is configured", async () => {
    vi.stubEnv("VITE_AUTH_BROKER_BASE", "");
    expect((await caught(refresh("google", SECRETS.refresh))).code).toBe("not_configured");
    expect((await caught(exchangeCode({ provider: "google", code: SECRETS.code }))).code).toBe("not_configured");
    expect((await caught(revoke("google", SECRETS.refresh))).code).toBe("not_configured");
    expect(net.calls).toHaveLength(0);
  });
});

describe("what the broker's errors become", () => {
  const error = (code: string) => ({ error: code, message: `short text for ${code}` });
  it.each([
    [400, error("invalid_grant"), "invalid_grant"],
    [501, error("not_configured"), "not_configured"],
    [429, error("rate_limited"), "rate_limited"],
    [502, error("upstream_error"), "upstream"],
    [504, error("upstream_timeout"), "upstream"],
    [500, error("internal_error"), "upstream"],
    [403, error("forbidden_origin"), "upstream"],
    [413, error("payload_too_large"), "upstream"],
    [400, error("invalid_request"), "upstream"],
    [404, error("not_found"), "upstream"],
    [405, error("method_not_allowed"), "upstream"],
    [400, { message: "no error code at all" }, "upstream"],
    [418, error("invalid_grant"), "upstream"],
  ] as const)("HTTP %i %j is %s", async (status, body, code) => {
    net.reply("POST", url("/oauth/google/refresh"), body, status);
    const failure = await caught(refresh("google", SECRETS.refresh));
    expect(failure.code).toBe(code);
    expect(failure.status).toBe(status);
  });

  it("keeps how long to wait when the Worker rate-limits", async () => {
    net.reply("POST", url("/oauth/microsoft/refresh"), error("rate_limited"), 429, { "Retry-After": "12" });
    const failure = await caught(refresh("microsoft", SECRETS.refresh));
    expect(failure.code).toBe("rate_limited");
    expect(failure.retryAfterMs).toBe(12_000);
  });

  it("keeps the provider's plain error code and numeric codes, and nothing else the Worker adds", async () => {
    net.reply("POST", url("/oauth/microsoft/token"), { error: "upstream_error", message: "Microsoft rejected the request (invalid_request, AADSTS9002327).", providerError: "invalid_request", providerCodes: [9002327, "x", -4], other: "ignored" }, 502);
    const failure = await caught(exchangeCode({ provider: "microsoft", code: SECRETS.code, codeVerifier: "v".repeat(50), redirectUri: "https://narrarium.net/auth/microsoft-callback.html" }));
    expect(failure.code).toBe("upstream");
    expect(failure.providerDetail).toBe("invalid_request AADSTS9002327");
  });

  it("ignores a provider error that is not a plain code", async () => {
    net.reply("POST", url("/oauth/google/refresh"), { error: "upstream_error", message: "x", providerError: "Bad <b>" }, 502);
    expect((await caught(refresh("google", SECRETS.refresh))).providerDetail).toBeUndefined();
  });

  it("treats a page that is not JSON as an upstream failure", async () => {
    net.on("POST", url("/oauth/google/refresh"), () => new Response("<html>Error 520</html>", { status: 520 }));
    expect((await caught(refresh("google", SECRETS.refresh))).code).toBe("upstream");
    net.on("POST", url("/oauth/google/refresh"), () => new Response("", { status: 500 }));
    expect((await caught(refresh("google", SECRETS.refresh))).code).toBe("upstream");
  });

  it("is a network error when the request never gets an answer", async () => {
    const failure = await caught(refresh("google", SECRETS.refresh));
    expect(failure.code).toBe("network");
    expect(failure.status).toBeUndefined();
  });

  it("is a network error when the Worker is too slow", async () => {
    vi.useFakeTimers();
    net.on("POST", url("/oauth/google/refresh"), (call) => new Promise<Response>((_resolve, reject) => {
      call.init.signal?.addEventListener("abort", () => reject(new DOMException("aborted", "AbortError")));
    }));
    const pending = caught(refresh("google", SECRETS.refresh, { timeoutMs: 2_000 }));
    await vi.advanceTimersByTimeAsync(2_500);
    expect((await pending).code).toBe("network");
  });
});

describe("a strict reading of the answer", () => {
  const good = { accessToken: SECRETS.access, expiresIn: 3599 };
  it.each([
    ["an empty object", {}],
    ["no expiry", { accessToken: SECRETS.access }],
    ["an empty access token", { ...good, accessToken: "" }],
    ["a numeric access token", { ...good, accessToken: 5 }],
    ["an expiry as text", { ...good, expiresIn: "3599" }],
    ["a zero expiry", { ...good, expiresIn: 0 }],
    ["a negative expiry", { ...good, expiresIn: -5 }],
    ["a fractional expiry", { ...good, expiresIn: 1.5 }],
    ["an absurd expiry", { ...good, expiresIn: 9_000_000_000 }],
    ["an empty refresh token", { ...good, refreshToken: "" }],
    ["a refresh token that is not text", { ...good, refreshToken: 7 }],
    ["a null optional field", { ...good, scope: null }],
    ["a scope that is not text", { ...good, scope: ["a"] }],
    ["a client_info that is not text", { ...good, clientInfo: 1 }],
    ["an ID token that is not text", { ...good, idToken: {} }],
    ["a list instead of an object", [good]],
    ["a plain string", "ok"],
    ["null", null],
  ])("rejects %s", async (_label, body) => {
    net.reply("POST", url("/oauth/google/refresh"), body);
    expect((await caught(refresh("google", SECRETS.refresh))).code).toBe("upstream");
  });

  it("rejects an answer larger than the broker ever sends", async () => {
    net.on("POST", url("/oauth/google/refresh"), () => new Response(JSON.stringify({ ...good, scope: "x".repeat(200_000) }), { status: 200 }));
    expect((await caught(refresh("google", SECRETS.refresh))).code).toBe("upstream");
  });
});

describe("never leaking a token, a code or a verifier", () => {
  const echo = (secret: string) => ({ error: "upstream_error", message: `Google rejected ${secret} (invalid_client)` });
  const everyCall: Array<[string, () => Promise<unknown>, string]> = [
    ["google token", () => exchangeCode({ provider: "google", code: SECRETS.code }), SECRETS.code],
    ["microsoft token", () => exchangeCode({ provider: "microsoft", code: SECRETS.code, codeVerifier: SECRETS.verifier, redirectUri: "https://narrarium.net/auth/microsoft-callback.html" }), SECRETS.verifier],
    ["google refresh", () => refresh("google", SECRETS.refresh), SECRETS.refresh],
    ["microsoft refresh", () => refresh("microsoft", SECRETS.refresh), SECRETS.refresh],
    ["google revoke", () => revoke("google", SECRETS.refresh), SECRETS.refresh],
  ];

  it.each(everyCall)("keeps %s failures free of what was sent, even when the server echoes it back", async (label, call, secret) => {
    const spy = spyOnConsole();
    const [provider, action] = label.split(" ");
    net.reply("POST", url(`/oauth/${provider}/${action}`), echo(secret), 502);
    const failure = await caught(call());
    const everything = [failure.message, String(failure), JSON.stringify({ ...failure }), failure.stack ?? "", JSON.stringify((failure as { cause?: unknown }).cause ?? null)].join("\n");
    for (const value of Object.values(SECRETS)) expect(everything).not.toContain(value);
    expect(spy.count()).toBe(0);
  });

  it("does not repeat the text of the underlying network error either", async () => {
    net.on("POST", url("/oauth/google/refresh"), (call) => { throw new TypeError(`failed to fetch ${call.url} with ${JSON.stringify(call.body)}`); });
    const failure = await caught(refresh("google", SECRETS.refresh));
    expect(failure.code).toBe("network");
    expect(`${failure.message}\n${String(failure)}\n${failure.stack}`).not.toContain(SECRETS.refresh);
    expect((failure as { cause?: unknown }).cause).toBeUndefined();
  });

  it("stays silent on success too, and a message that looks like a token is not repeated", async () => {
    const spy = spyOnConsole();
    net.reply("POST", url("/oauth/google/refresh"), { accessToken: SECRETS.accessFresh, expiresIn: 3599 });
    await refresh("google", SECRETS.refresh);
    net.reply("POST", url("/oauth/google/refresh"), { error: "upstream_error", message: "Google said ya29.A0ARrdaM-this-is-a-long-looking-access-token-value-0123456789abcdef" }, 502);
    const failure = await caught(refresh("google", SECRETS.refresh));
    expect(failure.message).not.toContain("ya29.A0ARrdaM-this-is-a-long-looking-access-token-value");
    expect(spy.count()).toBe(0);
  });

  it("keeps the text of a short, harmless broker message so the owner can diagnose a bad configuration", async () => {
    net.reply("POST", url("/oauth/google/refresh"), { error: "upstream_error", message: "Google rejected the request (invalid_client)." }, 502);
    const failure = await caught(refresh("google", SECRETS.refresh));
    expect(failure.message).toContain("invalid_client");
    expect(failure.message.length).toBeLessThan(400);
  });

  it("has no console call anywhere in the client", () => {
    const source = readFileSync(resolve(process.cwd(), "src/account/credentialBroker.ts"), "utf8");
    expect(source).not.toMatch(/\bconsole\s*\./);
  });
});

describe("cancelling a call", () => {
  it("does not send anything when the signal is already aborted", async () => {
    const controller = new AbortController();
    controller.abort();
    await expect(refresh("google", SECRETS.refresh, { signal: controller.signal })).rejects.toMatchObject({ name: "AbortError" });
    expect(net.calls).toHaveLength(0);
  });

  it("aborts a request in flight and reports the cancellation as such, not as a broker failure", async () => {
    const controller = new AbortController();
    net.on("POST", url("/oauth/google/refresh"), (call) => new Promise<Response>((_resolve, reject) => {
      call.init.signal?.addEventListener("abort", () => reject(new DOMException("aborted", "AbortError")));
    }));
    const pending = refresh("google", SECRETS.refresh, { signal: controller.signal }).then(() => undefined, (cause: unknown) => cause);
    await vi.waitFor(() => expect(net.calls).toHaveLength(1));
    controller.abort();
    const failure = await pending;
    expect(failure).not.toBeInstanceOf(BrokerError);
    expect(failure).toMatchObject({ name: "AbortError" });
  });
});
