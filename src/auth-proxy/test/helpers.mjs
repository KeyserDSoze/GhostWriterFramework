import assert from "node:assert/strict";
import { afterEach, beforeEach } from "node:test";
import { inspect } from "node:util";
import worker from "../src/index.js";

export const WORKER_URL = "https://auth-proxy.example.workers.dev";
export const ALLOWED_ORIGIN = "https://narrarium.net";

export const GOOGLE_TOKEN_URL = "https://oauth2.googleapis.com/token";
export const GOOGLE_REVOKE_URL = "https://oauth2.googleapis.com/revoke";
export const MICROSOFT_TOKEN_URL = "https://login.microsoftonline.com/common/oauth2/v2.0/token";
export const MICROSOFT_SCOPE = "User.Read Files.ReadWrite offline_access";
export const MICROSOFT_REDIRECT_URI = "https://narrarium.net/auth/microsoft-callback.html";
export const GITHUB_TOKEN_URL = "https://github.com/login/oauth/access_token";
export const FAKE_GITHUB_CLIENT_ID = "Iv1.fakegithubclient00";
export const GITHUB_GRANT_URL = `https://api.github.com/applications/${FAKE_GITHUB_CLIENT_ID}/grant`;
export const GITHUB_REDIRECT_URI = "https://narrarium.net/auth/github/callback";
export const PROVIDER_URLS = [GOOGLE_TOKEN_URL, GOOGLE_REVOKE_URL, MICROSOFT_TOKEN_URL, GITHUB_TOKEN_URL, GITHUB_GRANT_URL];

// Obviously fake values: nothing in this suite is, or resembles, a real credential.
export const FAKE_GOOGLE_CLIENT_ID = "fake-google-client.apps.googleusercontent.com";
export const FAKE_GOOGLE_SECRET = "FAKE-google-secret-0123456789abcdef";
export const FAKE_MICROSOFT_CLIENT_ID = "00000000-0000-0000-0000-00000000fake";
export const FAKE_MICROSOFT_SECRET = "FAKE-microsoft-secret-fedcba9876543210";
export const FAKE_GITHUB_SECRET = "FAKE-github-secret-0123456789fedcba98765432";
export const CLIENT_SECRETS = [FAKE_GOOGLE_SECRET, FAKE_MICROSOFT_SECRET, FAKE_GITHUB_SECRET];

export function configuredEnv(overrides = {}) {
  return {
    GOOGLE_CLIENT_ID: FAKE_GOOGLE_CLIENT_ID,
    GOOGLE_CLIENT_SECRET: FAKE_GOOGLE_SECRET,
    MICROSOFT_CLIENT_ID: FAKE_MICROSOFT_CLIENT_ID,
    MICROSOFT_CLIENT_SECRET: FAKE_MICROSOFT_SECRET,
    GITHUB_APP_CLIENT_ID: FAKE_GITHUB_CLIENT_ID,
    GITHUB_APP_CLIENT_SECRET: FAKE_GITHUB_SECRET,
    ...overrides,
  };
}

let addressCounter = 0;

/** A unique caller address per request, so the in-memory rate limit never couples two tests. */
export function nextAddress() {
  addressCounter += 1;
  return `10.${(addressCounter >> 16) & 255}.${(addressCounter >> 8) & 255}.${addressCounter & 255}`;
}

/**
 * Builds a Request for the Worker. `json` is serialised and sent as application/json;
 * `body` is sent as is. `origin: null` / `address: null` omit the Origin / cf-connecting-ip headers.
 */
export function oauthRequest(path, options = {}) {
  const { method = "POST", origin = ALLOWED_ORIGIN, address = nextAddress(), json, contentType, headers = {} } = options;
  let { body } = options;
  const requestHeaders = new Headers(headers);
  if (origin) requestHeaders.set("Origin", origin);
  if (address) requestHeaders.set("cf-connecting-ip", address);
  if (json !== undefined) {
    body = JSON.stringify(json);
    if (contentType === undefined) requestHeaders.set("Content-Type", "application/json");
  }
  if (contentType) requestHeaders.set("Content-Type", contentType);
  const init = { method, headers: requestHeaders };
  if (body !== undefined) {
    init.body = body;
    if (body instanceof ReadableStream) init.duplex = "half";
  }
  return new Request(`${WORKER_URL}${path}`, init);
}

export function oauthCall(path, options = {}, env = configuredEnv()) {
  return worker.fetch(oauthRequest(path, options), env);
}

export function jsonResponse(status, payload, headers = {}) {
  return new Response(JSON.stringify(payload), {
    status,
    headers: { "Content-Type": "application/json", ...headers },
  });
}

export const GOOGLE_TOKEN_REPLY = {
  access_token: "ya29.google-access-token",
  expires_in: 3599,
  refresh_token: "1//google-refresh-token",
  scope: "openid email profile https://www.googleapis.com/auth/drive.appdata",
  token_type: "Bearer",
  id_token: "google.id.token",
};

export const MICROSOFT_TOKEN_REPLY = {
  token_type: "Bearer",
  scope: "User.Read Files.ReadWrite",
  expires_in: 3599,
  ext_expires_in: 3599,
  access_token: "ey.microsoft-access-token",
  refresh_token: "0.microsoft-refresh-token",
  id_token: "microsoft.id.token",
};

export const GITHUB_TOKEN_REPLY = {
  access_token: "ghu_fakegithubaccesstoken0123456789",
  expires_in: 28800,
  refresh_token: "ghr_fakegithubrefreshtoken0123456789",
  refresh_token_expires_in: 15897600,
  token_type: "bearer",
  scope: "",
};

/**
 * Every provider-facing route with a valid request body, the maximum length of each body
 * field, the upstream endpoint it must call (null: none), the HTTP status of a success
 * and a factory for the provider's success response.
 */
export const OAUTH_ROUTES = [
  {
    label: "google token",
    path: "/oauth/google/token",
    request: { code: "google-auth-code" },
    fields: { code: 4096 },
    upstream: GOOGLE_TOKEN_URL,
    success: 200,
    reply: () => jsonResponse(200, GOOGLE_TOKEN_REPLY),
  },
  {
    label: "google refresh",
    path: "/oauth/google/refresh",
    request: { refreshToken: "google-refresh-token-in" },
    fields: { refreshToken: 4096 },
    upstream: GOOGLE_TOKEN_URL,
    success: 200,
    reply: () => jsonResponse(200, { access_token: "ya29.google-refreshed", expires_in: 3599, scope: "openid", token_type: "Bearer" }),
  },
  {
    label: "google revoke",
    path: "/oauth/google/revoke",
    request: { token: "google-token-to-revoke" },
    fields: { token: 4096 },
    upstream: GOOGLE_REVOKE_URL,
    success: 204,
    reply: () => new Response(null, { status: 200 }),
  },
  {
    label: "microsoft token",
    path: "/oauth/microsoft/token",
    request: {
      code: "microsoft-auth-code",
      codeVerifier: "microsoft-code-verifier-0123456789",
      redirectUri: MICROSOFT_REDIRECT_URI,
    },
    fields: { code: 4096, codeVerifier: 128, redirectUri: 2048 },
    upstream: MICROSOFT_TOKEN_URL,
    success: 200,
    reply: () => jsonResponse(200, MICROSOFT_TOKEN_REPLY),
  },
  {
    label: "microsoft refresh",
    path: "/oauth/microsoft/refresh",
    request: { refreshToken: "microsoft-refresh-token-in" },
    fields: { refreshToken: 4096 },
    upstream: MICROSOFT_TOKEN_URL,
    success: 200,
    reply: () =>
      jsonResponse(200, {
        token_type: "Bearer",
        scope: "User.Read Files.ReadWrite",
        expires_in: 3599,
        access_token: "ey.microsoft-refreshed",
        refresh_token: "0.microsoft-rotated-refresh-token",
      }),
  },
  {
    label: "microsoft revoke",
    path: "/oauth/microsoft/revoke",
    request: { token: "microsoft-token-to-revoke" },
    fields: { token: 4096 },
    upstream: null,
    success: 204,
    reply: null,
  },
  {
    label: "github token",
    path: "/oauth/github/token",
    request: {
      code: "github-auth-code",
      codeVerifier: "github-code-verifier-0123456789-abcdefghijklmnopqrstuvwxyz",
      redirectUri: GITHUB_REDIRECT_URI,
    },
    fields: { code: 4096, codeVerifier: 128, redirectUri: 2048 },
    upstream: GITHUB_TOKEN_URL,
    success: 200,
    reply: () => jsonResponse(200, GITHUB_TOKEN_REPLY),
  },
  {
    label: "github refresh",
    path: "/oauth/github/refresh",
    request: { refreshToken: "ghr_github-refresh-token-in" },
    fields: { refreshToken: 4096 },
    upstream: GITHUB_TOKEN_URL,
    success: 200,
    reply: () =>
      jsonResponse(200, {
        access_token: "ghu_fakegithubrefreshedaccess0123",
        expires_in: 28800,
        refresh_token: "ghr_fakegithubrotatedrefresh0123",
        refresh_token_expires_in: 15897600,
        token_type: "bearer",
        scope: "",
      }),
  },
  {
    label: "github revoke",
    path: "/oauth/github/revoke",
    request: { token: "ghu_github-token-to-revoke" },
    fields: { token: 4096 },
    upstream: GITHUB_GRANT_URL,
    success: 204,
    reply: () => new Response(null, { status: 204 }),
  },
];

/**
 * Replaces globalThis.fetch for every test of the file. Any call that a test did not
 * explicitly allow with `reply()` throws, so no test can ever reach the network.
 */
export function useProviderStub() {
  const realFetch = globalThis.fetch;
  const stub = {
    calls: [],
    handler: null,
    reply(handler) {
      stub.handler = handler;
    },
  };
  beforeEach(() => {
    stub.calls.length = 0;
    stub.handler = (call) => {
      throw new Error(`Unexpected network call to ${call.url}`);
    };
    globalThis.fetch = async (input, init = {}) => {
      const call = { url: String(input), init };
      stub.calls.push(call);
      return stub.handler(call);
    };
  });
  afterEach(() => {
    globalThis.fetch = realFetch;
  });
  return stub;
}

export function formOf(call) {
  const entries = [...new URLSearchParams(String(call.init.body))];
  const form = Object.fromEntries(entries);
  assert.equal(entries.length, Object.keys(form).length, "the form must not repeat a field");
  return form;
}

export function headersOf(call) {
  return new Headers(call.init.headers);
}

export async function waitFor(condition, label) {
  for (let attempt = 0; attempt < 500; attempt += 1) {
    if (condition()) return;
    await new Promise((resolve) => setImmediate(resolve));
  }
  assert.fail(`Timed out waiting for ${label}`);
}

/** Fake setTimeout/clearTimeout for one test: nothing waits for real time. */
export function installFakeTimers(t) {
  const realSetTimeout = globalThis.setTimeout;
  const realClearTimeout = globalThis.clearTimeout;
  const timers = [];
  globalThis.setTimeout = (callback, delay) => {
    const timer = { callback, delay, cleared: false, fired: false };
    timers.push(timer);
    return timer;
  };
  globalThis.clearTimeout = (timer) => {
    if (timer) timer.cleared = true;
  };
  t.after(() => {
    globalThis.setTimeout = realSetTimeout;
    globalThis.clearTimeout = realClearTimeout;
  });
  const pending = (delay) => timers.filter((timer) => timer.delay === delay && !timer.cleared && !timer.fired);
  return {
    timers,
    async fire(delay) {
      await waitFor(() => pending(delay).length > 0, `a ${delay} ms timer`);
      for (const timer of pending(delay)) {
        timer.fired = true;
        timer.callback();
      }
    },
  };
}

/** Records everything written through console.* for the duration of the test. */
export function captureConsole(t) {
  const lines = [];
  for (const name of ["log", "info", "warn", "error", "debug", "trace", "dir"]) {
    t.mock.method(console, name, (...args) => {
      lines.push(args.map((arg) => (typeof arg === "string" ? arg : inspect(arg, { depth: 6 }))).join(" "));
    });
  }
  return { lines, text: () => lines.join("\n") };
}

export function assertStandardHeaders(response) {
  assert.equal(response.headers.get("cache-control"), "no-store");
  assert.equal(response.headers.get("content-type"), "application/json");
  assert.match(response.headers.get("vary") ?? "", /\bOrigin\b/);
}

export function headerText(response) {
  return [...response.headers].map(([name, value]) => `${name}: ${value}`).join("\n");
}

/** Asserts status plus the headers every OAuth response must carry; returns the parsed JSON (null for 204). */
export async function readJson(response, status) {
  assert.equal(response.status, status);
  assertStandardHeaders(response);
  const text = await response.text();
  if (status === 204) {
    assert.equal(text, "");
    return null;
  }
  return JSON.parse(text);
}

export async function assertError(response, status, code) {
  const body = await readJson(response, status);
  assert.deepEqual(Object.keys(body).sort(), ["error", "message"]);
  assert.equal(body.error, code);
  assert.equal(typeof body.message, "string");
  assert.ok(body.message.length > 0 && body.message.length <= 300, "the message is a short human text");
  return body;
}

export function assertNoneOf(haystack, needles, label) {
  for (const needle of needles) {
    assert.ok(!haystack.includes(needle), `${label} must not contain ${needle}`);
  }
}

/** A body of exactly `size` bytes: a valid request object padded with an ignored field. */
export function paddedJson(base, size) {
  const empty = JSON.stringify({ ...base, pad: "" });
  const padding = size - new TextEncoder().encode(empty).length;
  assert.ok(padding >= 0, "base object is larger than the requested size");
  return JSON.stringify({ ...base, pad: "x".repeat(padding) });
}
