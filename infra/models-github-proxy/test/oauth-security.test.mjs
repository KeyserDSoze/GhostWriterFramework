import assert from "node:assert/strict";
import { describe, it } from "node:test";
import worker from "../src/index.js";
import {
  CLIENT_SECRETS,
  FAKE_GOOGLE_SECRET,
  FAKE_MICROSOFT_SECRET,
  GOOGLE_REVOKE_URL,
  GOOGLE_TOKEN_REPLY,
  GOOGLE_TOKEN_URL,
  MICROSOFT_TOKEN_REPLY,
  MICROSOFT_TOKEN_URL,
  OAUTH_ROUTES,
  PROVIDER_URLS,
  assertError,
  assertNoneOf,
  captureConsole,
  configuredEnv,
  formOf,
  headerText,
  headersOf,
  jsonResponse,
  oauthCall,
  oauthRequest,
  useProviderStub,
} from "./helpers.mjs";

const provider = useProviderStub();

const PROVIDER_ROUTES = OAUTH_ROUTES.filter((route) => route.upstream);
const CLIENT_INFO = Buffer.from('{"uid":"leak-uid","utid":"leak-utid"}').toString("base64url");

const INPUT_CREDENTIALS = OAUTH_ROUTES.flatMap((route) =>
  ["code", "codeVerifier", "refreshToken", "token"].map((key) => route.request[key]).filter(Boolean),
);
const PROVIDER_TOKENS = [
  GOOGLE_TOKEN_REPLY.access_token,
  GOOGLE_TOKEN_REPLY.refresh_token,
  GOOGLE_TOKEN_REPLY.id_token,
  MICROSOFT_TOKEN_REPLY.access_token,
  MICROSOFT_TOKEN_REPLY.refresh_token,
  MICROSOFT_TOKEN_REPLY.id_token,
  "ya29.google-refreshed",
  "ey.microsoft-refreshed",
  "0.microsoft-rotated-refresh-token",
  CLIENT_INFO,
];
const SENSITIVE = [...CLIENT_SECRETS, ...INPUT_CREDENTIALS, ...PROVIDER_TOKENS];
const EVERYTHING = SENSITIVE.join(" ");

const LEAKY_HEADERS = {
  "Set-Cookie": `sid=${EVERYTHING}`,
  "X-Leak": EVERYTHING,
  "WWW-Authenticate": `Bearer realm="${EVERYTHING}"`,
  "X-Request-Id": "req-1234",
  Location: "https://evil.example/",
};
const LEAKY_HEADER_NAMES = ["set-cookie", "x-leak", "www-authenticate", "x-request-id", "location"];

const SCENARIOS = [
  { label: "success", reply: (route) => route.reply },
  {
    label: "success carrying client_info",
    reply: (route) =>
      route.label.startsWith("microsoft") && route.success === 200
        ? () => jsonResponse(200, { ...MICROSOFT_TOKEN_REPLY, client_info: CLIENT_INFO })
        : route.reply,
  },
  { label: "invalid_grant echoing everything", reply: () => () => jsonResponse(400, { error: "invalid_grant", error_description: EVERYTHING, client_info: CLIENT_INFO }, LEAKY_HEADERS) },
  { label: "invalid_client echoing everything", reply: () => () => jsonResponse(401, { error: "invalid_client", error_description: EVERYTHING }, LEAKY_HEADERS) },
  { label: "500 echoing everything", reply: () => () => new Response(EVERYTHING, { status: 500, headers: LEAKY_HEADERS }) },
  { label: "network error echoing everything", reply: () => () => Promise.reject(new Error(EVERYTHING)) },
  { label: "abort echoing everything", reply: () => () => Promise.reject(new DOMException(EVERYTHING, "AbortError")) },
  { label: "garbage 200 echoing everything", reply: () => () => new Response(EVERYTHING, { status: 200, headers: LEAKY_HEADERS }) },
];

/** Runs every provider route through every scenario and reports what leaked into responses. */
async function runBattery() {
  const problems = [];
  for (const route of PROVIDER_ROUTES) {
    for (const scenario of SCENARIOS) {
      const label = `${route.label} / ${scenario.label}`;
      provider.reply(scenario.reply(route));
      const response = await oauthCall(route.path, {
        json: route.request,
        headers: { Cookie: "sid=incoming-cookie", Authorization: "Bearer incoming-authorization" },
      });
      const body = await response.text();
      const headers = headerText(response);

      // The tokens a provider legitimately returns belong in a success body, and only there.
      const notInBody = [...CLIENT_SECRETS, ...INPUT_CREDENTIALS, "incoming-cookie", "incoming-authorization"];
      if (response.status >= 400) notInBody.push(...PROVIDER_TOKENS);
      const notInHeaders = [...notInBody, ...PROVIDER_TOKENS];
      for (const needle of notInBody) {
        if (body.includes(needle)) problems.push(`${label}: the body (${response.status}) contains ${needle}`);
      }
      for (const needle of notInHeaders) {
        if (headers.includes(needle)) problems.push(`${label}: a header contains ${needle}`);
      }
      for (const name of LEAKY_HEADER_NAMES) {
        if (response.headers.has(name)) problems.push(`${label}: the response forwards the provider header ${name}`);
      }
    }
  }
  return problems;
}

describe("secrets and tokens never leak", () => {
  it("keeps client secrets, tokens, codes and client_info out of responses, errors and response headers", async () => {
    assert.deepEqual(await runBattery(), []);
  });

  it("keeps them out of the console", async (t) => {
    const output = captureConsole(t);
    await runBattery();
    assertNoneOf(output.text(), SENSITIVE, "console output");
  });

  it("does not write anything to the console, on success, failure or abuse", async (t) => {
    const output = captureConsole(t);
    await runBattery();
    await oauthCall("/oauth/status", { method: "GET" });
    await oauthCall("/oauth/status", { method: "GET", origin: "https://evil.example" });
    await oauthCall("/oauth/unknown", { method: "GET" });
    await oauthCall("/oauth/google/token", { method: "GET" });
    await oauthCall("/oauth/google/token", { json: {} });
    await oauthCall("/oauth/google/token", { body: "x".repeat(9000), contentType: "application/json" });
    await oauthCall("/oauth/google/token", { json: { code: "c" } }, {});
    assert.deepEqual(output.lines, []);
  });

  it("reports an unexpected internal error generically, without its message", async (t) => {
    const output = captureConsole(t);
    const request = oauthRequest("/oauth/google/token", { json: { code: "c" } });
    Object.defineProperty(request, "body", {
      get() {
        throw new Error(`internal failure carrying ${FAKE_GOOGLE_SECRET}`);
      },
    });
    const response = await worker.fetch(request, configuredEnv());
    const body = await assertError(response, 500, "internal_error");
    assertNoneOf(`${JSON.stringify(body)}\n${headerText(response)}\n${output.text()}`, [FAKE_GOOGLE_SECRET, "internal failure"], "the 500 response");
  });

  it("never echoes the secret in a 403, 404, 405, 413 or 501 answer", async () => {
    const answers = [
      await oauthCall("/oauth/status", { method: "GET", origin: "https://evil.example" }),
      await oauthCall("/oauth/unknown", { method: "GET" }),
      await oauthCall("/oauth/google/token", { method: "GET" }),
      await oauthCall("/oauth/google/token", { body: "x".repeat(9000), contentType: "application/json" }),
      await oauthCall("/oauth/google/token", { json: { code: "c" } }, {}),
    ];
    for (const answer of answers) {
      assertNoneOf(`${await answer.text()}\n${headerText(answer)}`, CLIENT_SECRETS, `the ${answer.status} answer`);
    }
  });
});

describe("what the Worker sends to the providers", () => {
  it("sends only fixed headers: nothing of the caller's cookies, authorization, origin or address", async () => {
    for (const route of PROVIDER_ROUTES) {
      provider.reply(route.reply);
      await oauthCall(route.path, {
        json: route.request,
        headers: {
          Cookie: "sid=incoming-cookie",
          Authorization: "Bearer incoming-authorization",
          "X-Forwarded-For": "198.51.100.9",
          "User-Agent": "attacker/1.0",
        },
      });
    }
    assert.equal(provider.calls.length, PROVIDER_ROUTES.length);
    for (const call of provider.calls) {
      assert.deepEqual([...headersOf(call).keys()].sort(), ["accept", "content-type"], call.url);
    }
  });

  it("only ever calls the three fixed provider endpoints, whatever the body says", async () => {
    for (const route of PROVIDER_ROUTES) {
      provider.reply(route.reply);
      await oauthCall(route.path, {
        json: {
          ...route.request,
          url: "https://evil.example/token",
          endpoint: "https://evil.example/token",
          token_url: "https://evil.example/token",
          tenant: "evil-tenant",
          authority: "https://evil.example",
          host: "evil.example",
        },
      });
      const call = provider.calls.at(-1);
      assert.equal(call.url, route.upstream);
      assert.ok(PROVIDER_URLS.includes(call.url));
      const target = new URL(call.url);
      assert.equal(target.search, "");
      assert.equal(target.hash, "");
    }
    assert.equal(provider.calls.length, PROVIDER_ROUTES.length);
  });

  it("sends each client secret only in the form body of its own provider's token requests", async () => {
    for (const route of PROVIDER_ROUTES) {
      provider.reply(route.reply);
      await oauthCall(route.path, { json: route.request });
    }
    for (const call of provider.calls) {
      const headers = [...headersOf(call)].map(([name, value]) => `${name}: ${value}`).join("\n");
      assertNoneOf(`${call.url}\n${headers}`, CLIENT_SECRETS, `the URL and headers of ${call.url}`);

      const form = formOf(call);
      const body = String(call.init.body);
      if (call.url === GOOGLE_TOKEN_URL) {
        assert.equal(form.client_secret, FAKE_GOOGLE_SECRET);
        assertNoneOf(body, [FAKE_MICROSOFT_SECRET], "a Google request");
      } else if (call.url === MICROSOFT_TOKEN_URL) {
        assert.equal(form.client_secret, FAKE_MICROSOFT_SECRET);
        assertNoneOf(body, [FAKE_GOOGLE_SECRET], "a Microsoft request");
      } else {
        assert.equal(call.url, GOOGLE_REVOKE_URL);
        assertNoneOf(body, CLIENT_SECRETS, "a revoke request");
        assert.equal(Object.hasOwn(form, "client_id"), false);
      }
    }
  });
});
