import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  ALLOWED_ORIGIN,
  CLIENT_SECRETS,
  FAKE_GITHUB_CLIENT_ID,
  FAKE_GITHUB_SECRET,
  FAKE_GOOGLE_CLIENT_ID,
  FAKE_GOOGLE_SECRET,
  FAKE_MICROSOFT_CLIENT_ID,
  FAKE_MICROSOFT_SECRET,
  GOOGLE_TOKEN_REPLY,
  GOOGLE_TOKEN_URL,
  MICROSOFT_REDIRECT_URI,
  MICROSOFT_TOKEN_URL,
  OAUTH_ROUTES,
  assertError,
  assertNoneOf,
  assertStandardHeaders,
  configuredEnv,
  formOf,
  headerText,
  jsonResponse,
  oauthCall,
  paddedJson,
  readJson,
  useProviderStub,
} from "./helpers.mjs";

const provider = useProviderStub();

const GOOGLE_TOKEN = OAUTH_ROUTES[0];

function replyWithGoogleToken() {
  provider.reply(() => jsonResponse(200, GOOGLE_TOKEN_REPLY));
}

/** A real success: the broker's own answer shape, produced by exactly one call to Google's token endpoint. */
async function assertGoogleTokenAnswer(response) {
  assert.deepEqual(await readJson(response, 200), {
    accessToken: "ya29.google-access-token",
    expiresIn: 3599,
    refreshToken: "1//google-refresh-token",
    scope: GOOGLE_TOKEN_REPLY.scope,
    idToken: "google.id.token",
  });
  assert.equal(provider.calls.at(-1).url, GOOGLE_TOKEN_URL);
}

describe("OAuth broker: origins and CORS", () => {
  it("answers a preflight from an allowed origin with 204 and scoped CORS headers", async () => {
    const response = await oauthCall("/oauth/google/token", {
      method: "OPTIONS",
      headers: { "Access-Control-Request-Method": "POST", "Access-Control-Request-Headers": "content-type" },
    });
    assert.equal(response.status, 204);
    assertStandardHeaders(response);
    assert.equal(response.headers.get("access-control-allow-origin"), ALLOWED_ORIGIN);
    assert.match(response.headers.get("access-control-allow-methods"), /\bPOST\b/);
    assert.match(response.headers.get("access-control-allow-methods"), /\bGET\b/);
    assert.match(response.headers.get("access-control-allow-headers"), /content-type/i);
    assert.equal(await response.text(), "");
    assert.equal(provider.calls.length, 0);
  });

  it("only grants the Content-Type request header in a preflight", async () => {
    const response = await oauthCall("/oauth/google/token", {
      method: "OPTIONS",
      headers: { "Access-Control-Request-Headers": "content-type, authorization, x-evil" },
    });
    const allowed = response.headers.get("access-control-allow-headers").toLowerCase();
    assert.match(allowed, /content-type/);
    assert.doesNotMatch(allowed, /authorization|x-evil|\*/);
  });

  it("refuses a preflight from an unknown origin and one without Origin", async () => {
    const unknown = await oauthCall("/oauth/google/token", { method: "OPTIONS", origin: "https://evil.example" });
    await assertError(unknown, 403, "forbidden_origin");
    assert.equal(unknown.headers.get("access-control-allow-origin"), null);

    const missing = await oauthCall("/oauth/google/token", { method: "OPTIONS", origin: null });
    await assertError(missing, 403, "forbidden_origin");
    assert.equal(missing.headers.get("access-control-allow-origin"), null);
  });

  it("allows the production, www and local development origins", async () => {
    for (const origin of ["https://narrarium.net", "https://www.narrarium.net", "http://localhost:5173", "http://localhost:4173"]) {
      const response = await oauthCall("/oauth/status", { method: "GET", origin });
      assert.equal(response.status, 200, origin);
      assert.equal(response.headers.get("access-control-allow-origin"), origin);
      assert.notEqual(response.headers.get("access-control-allow-origin"), "*");
    }
  });

  it("refuses every other origin with 403, no CORS headers and no provider call", async () => {
    const origins = [
      "https://evil.example",
      "https://narrarium.net.evil.example",
      "http://narrarium.net",
      "https://NARRARIUM.NET",
      "https://narrarium.net:8443",
      "http://localhost:3000",
      "null",
    ];
    for (const origin of origins) {
      const status = await oauthCall("/oauth/status", { method: "GET", origin });
      await assertError(status, 403, "forbidden_origin");
      assert.equal(status.headers.get("access-control-allow-origin"), null, origin);

      const token = await oauthCall(GOOGLE_TOKEN.path, { origin, json: GOOGLE_TOKEN.request });
      await assertError(token, 403, "forbidden_origin");
      assert.equal(token.headers.get("access-control-allow-origin"), null, origin);
    }
    assert.equal(provider.calls.length, 0);
  });

  it("serves callers without an Origin header (curl, servers) and adds no CORS headers", async () => {
    replyWithGoogleToken();
    const status = await oauthCall("/oauth/status", { method: "GET", origin: null });
    assert.equal(status.status, 200);
    assert.equal(status.headers.get("access-control-allow-origin"), null);

    const token = await oauthCall(GOOGLE_TOKEN.path, { origin: null, json: GOOGLE_TOKEN.request });
    assert.equal(token.status, 200);
    assert.equal(token.headers.get("access-control-allow-origin"), null);
    assertStandardHeaders(token);
  });

  it("adds CORS headers to error responses for allowed origins so the site can read them", async () => {
    const response = await oauthCall(GOOGLE_TOKEN.path, { json: {} });
    await assertError(response, 400, "invalid_request");
    assert.equal(response.headers.get("access-control-allow-origin"), ALLOWED_ORIGIN);
  });

  it("lets ALLOWED_ORIGINS_EXTRA add origins, normalising each entry to an origin", async () => {
    const env = configuredEnv({
      ALLOWED_ORIGINS_EXTRA: " https://example.github.io/narrarium/ , http://localhost:3000,, https://app.example.org ",
    });
    for (const origin of ["https://example.github.io", "http://localhost:3000", "https://app.example.org", ALLOWED_ORIGIN]) {
      const response = await oauthCall("/oauth/status", { method: "GET", origin }, env);
      assert.equal(response.status, 200, origin);
      assert.equal(response.headers.get("access-control-allow-origin"), origin);
    }
    const refused = await oauthCall("/oauth/status", { method: "GET", origin: "https://other.example" }, env);
    assert.equal(refused.status, 403);
  });

  it("ignores wildcards, null, junk and insecure entries in ALLOWED_ORIGINS_EXTRA", async () => {
    const env = configuredEnv({
      ALLOWED_ORIGINS_EXTRA:
        "*,null,https://*.example.com,not a url,ftp://files.example.com,http://insecure.example.com,javascript:alert(1),https://valid.example.org",
    });
    const control = await oauthCall("/oauth/status", { method: "GET", origin: "https://valid.example.org" }, env);
    assert.equal(control.status, 200, "the valid entry of the same list is honoured");

    const origins = [
      "*",
      "null",
      "https://*.example.com",
      "https://sub.example.com",
      "ftp://files.example.com",
      "http://insecure.example.com",
      "https://anything.example",
    ];
    for (const origin of origins) {
      const response = await oauthCall("/oauth/status", { method: "GET", origin }, env);
      assert.equal(response.status, 403, origin);
    }
  });
});

describe("OAuth broker: response headers", () => {
  it("gives every response no-store, application/json and Vary: Origin", async () => {
    replyWithGoogleToken();
    const scenarios = [
      [200, () => oauthCall("/oauth/status", { method: "GET" })],
      [200, () => oauthCall(GOOGLE_TOKEN.path, { json: GOOGLE_TOKEN.request })],
      [204, () => oauthCall("/oauth/google/token", { method: "OPTIONS" })],
      [204, () => oauthCall("/oauth/microsoft/revoke", { json: { token: "t" } })],
      [400, () => oauthCall(GOOGLE_TOKEN.path, { json: {} })],
      [403, () => oauthCall("/oauth/status", { method: "GET", origin: "https://evil.example" })],
      [404, () => oauthCall("/oauth/unknown", { method: "GET" })],
      [405, () => oauthCall(GOOGLE_TOKEN.path, { method: "GET" })],
      [413, () => oauthCall(GOOGLE_TOKEN.path, { body: paddedJson(GOOGLE_TOKEN.request, 8193), contentType: "application/json" })],
      [501, () => oauthCall(GOOGLE_TOKEN.path, { json: GOOGLE_TOKEN.request }, {})],
    ];
    for (const [status, send] of scenarios) {
      const response = await send();
      assert.equal(response.status, status);
      assertStandardHeaders(response);
      assert.equal(response.headers.get("set-cookie"), null);
    }
  });
});

describe("OAuth broker: routes and methods", () => {
  it("never forwards /oauth paths to models.github.ai", async () => {
    const attempts = [
      ["GET", "/oauth/status"],
      ["GET", "/oauth"],
      ["GET", "/oauth/"],
      ["POST", "/oauth/unknown"],
      ["DELETE", "/oauth/google/token"],
      ["OPTIONS", "/oauth/anything"],
    ];
    for (const [method, path] of attempts) {
      await oauthCall(path, { method }, {});
    }
    assert.equal(provider.calls.length, 0);
  });

  it("answers GET on a POST route with 405 and an Allow header", async () => {
    for (const route of OAUTH_ROUTES) {
      const response = await oauthCall(route.path, { method: "GET" });
      await assertError(response, 405, "method_not_allowed");
      assert.deepEqual(response.headers.get("allow").split(/\s*,\s*/).sort(), ["OPTIONS", "POST"]);
    }
  });

  it("only allows GET on /oauth/status", async () => {
    const post = await oauthCall("/oauth/status", { json: {} });
    await assertError(post, 405, "method_not_allowed");
    assert.deepEqual(post.headers.get("allow").split(/\s*,\s*/).sort(), ["GET", "OPTIONS"]);

    for (const method of ["PUT", "PATCH", "DELETE"]) {
      const response = await oauthCall("/oauth/status", { method });
      await assertError(response, 405, "method_not_allowed");
    }
    assert.equal((await oauthCall("/oauth/status", { method: "HEAD" })).status, 405);
  });

  it("rejects PUT, PATCH and DELETE on the POST routes", async () => {
    for (const method of ["PUT", "PATCH", "DELETE"]) {
      const response = await oauthCall(GOOGLE_TOKEN.path, { method });
      await assertError(response, 405, "method_not_allowed");
    }
    assert.equal(provider.calls.length, 0);
  });

  it("answers an unknown /oauth path with 404", async () => {
    const paths = [
      "/oauth",
      "/oauth/",
      "/oauth/unknown",
      "/oauth/google",
      "/oauth/google/",
      "/oauth/google/unknown",
      "/oauth/google/token/",
      "/oauth/google/token/extra",
      "/oauth/status/",
      "/oauth/Google/token",
      "/oauth/%67oogle/token",
      "/oauth/__proto__/token",
      "/oauth/constructor/token",
      "/oauth/toString/token",
      "/oauth/google/__proto__",
    ];
    for (const path of paths) {
      const response = await oauthCall(path, { json: { code: "c" } });
      await assertError(response, 404, "not_found");
    }
    assert.equal(provider.calls.length, 0);
  });
});

describe("OAuth broker: GET /oauth/status", () => {
  const cases = [
    ["every provider configured", configuredEnv(), { google: true, microsoft: true, github: true }],
    ["nothing configured", {}, { google: false, microsoft: false, github: false }],
    ["only Google", configuredEnv({ MICROSOFT_CLIENT_SECRET: undefined, GITHUB_APP_CLIENT_SECRET: undefined }), { google: true, microsoft: false, github: false }],
    ["only Microsoft", configuredEnv({ GOOGLE_CLIENT_SECRET: undefined, GITHUB_APP_CLIENT_SECRET: undefined }), { google: false, microsoft: true, github: false }],
    ["only GitHub", configuredEnv({ GOOGLE_CLIENT_SECRET: undefined, MICROSOFT_CLIENT_SECRET: undefined }), { google: false, microsoft: false, github: true }],
    ["client id without a secret", configuredEnv({ GOOGLE_CLIENT_SECRET: "", MICROSOFT_CLIENT_SECRET: "", GITHUB_APP_CLIENT_SECRET: "" }), { google: false, microsoft: false, github: false }],
    ["secret without a client id", configuredEnv({ GOOGLE_CLIENT_ID: undefined, MICROSOFT_CLIENT_ID: undefined, GITHUB_APP_CLIENT_ID: undefined }), { google: false, microsoft: false, github: false }],
    ["the GitHub client id left empty, as in wrangler.toml before the app exists", configuredEnv({ GITHUB_APP_CLIENT_ID: "" }), { google: true, microsoft: true, github: false }],
    ["blank values", configuredEnv({ GOOGLE_CLIENT_SECRET: "   ", MICROSOFT_CLIENT_ID: "\n", GITHUB_APP_CLIENT_ID: " " }), { google: false, microsoft: false, github: false }],
  ];
  for (const [label, env, expected] of cases) {
    it(`reports ${label}`, async () => {
      const response = await oauthCall("/oauth/status", { method: "GET" }, env);
      assert.deepEqual(await readJson(response, 200), expected);
      assert.equal(provider.calls.length, 0);
    });
  }

  it("answers with exactly three booleans and never exposes a secret or a client id", async () => {
    const response = await oauthCall("/oauth/status", { method: "GET" });
    const text = await response.text();
    assert.equal(text, '{"google":true,"microsoft":true,"github":true}');
    assertNoneOf(`${text}\n${headerText(response)}`, [...CLIENT_SECRETS, FAKE_GOOGLE_CLIENT_ID, FAKE_MICROSOFT_CLIENT_ID, FAKE_GITHUB_CLIENT_ID], "the status response");
  });

  it("is not counted against the rate limit", async () => {
    const address = "203.0.113.77";
    for (let index = 0; index < 100; index += 1) {
      const response = await oauthCall("/oauth/status", { method: "GET", address });
      assert.equal(response.status, 200);
    }
  });
});

describe("OAuth broker: request body", () => {
  it("requires Content-Type: application/json", async () => {
    const body = JSON.stringify(GOOGLE_TOKEN.request);
    for (const contentType of [
      "text/plain",
      "application/x-www-form-urlencoded",
      "application/jsonp",
      "application/json5",
      "text/json",
      "multipart/form-data; boundary=x",
    ]) {
      const response = await oauthCall(GOOGLE_TOKEN.path, { body, contentType });
      await assertError(response, 400, "invalid_request");
    }
    const missing = await oauthCall(GOOGLE_TOKEN.path, { body: new TextEncoder().encode(body) });
    await assertError(missing, 400, "invalid_request");
    assert.equal(provider.calls.length, 0);
  });

  it("accepts application/json with parameters and in any letter case", async () => {
    replyWithGoogleToken();
    for (const contentType of ["application/json", "application/json; charset=utf-8", "Application/JSON"]) {
      const response = await oauthCall(GOOGLE_TOKEN.path, { body: JSON.stringify(GOOGLE_TOKEN.request), contentType });
      await assertGoogleTokenAnswer(response);
    }
  });

  it("rejects anything that is not a JSON object", async () => {
    const bodies = ["", "{", "[]", "null", '"text"', "42", "true", '{"code":"c"} trailing', '{"code":"c"}{"code":"d"}'];
    for (const body of bodies) {
      const response = await oauthCall(GOOGLE_TOKEN.path, { body, contentType: "application/json" });
      assert.equal(response.status, 400, JSON.stringify(body));
      await assertError(response, 400, "invalid_request");
    }
    const invalidUtf8 = new Uint8Array([0x7b, 0x22, 0x63, 0x6f, 0x64, 0x65, 0x22, 0x3a, 0x22, 0xff, 0x22, 0x7d]);
    const response = await oauthCall(GOOGLE_TOKEN.path, { body: invalidUtf8, contentType: "application/json" });
    await assertError(response, 400, "invalid_request");
    assert.equal(provider.calls.length, 0);
  });

  it("accepts a body of exactly 8 KiB", async () => {
    replyWithGoogleToken();
    const body = paddedJson(GOOGLE_TOKEN.request, 8192);
    assert.equal(new TextEncoder().encode(body).length, 8192);
    const response = await oauthCall(GOOGLE_TOKEN.path, { body, contentType: "application/json" });
    await assertGoogleTokenAnswer(response);
  });

  it("rejects a body of 8 KiB plus one byte with 413", async () => {
    const body = paddedJson(GOOGLE_TOKEN.request, 8193);
    const response = await oauthCall(GOOGLE_TOKEN.path, { body, contentType: "application/json" });
    await assertError(response, 413, "payload_too_large");
    assert.equal(provider.calls.length, 0);
  });

  it("rejects a declared Content-Length above 8 KiB with 413", async () => {
    const response = await oauthCall(GOOGLE_TOKEN.path, {
      body: JSON.stringify(GOOGLE_TOKEN.request),
      contentType: "application/json",
      headers: { "Content-Length": "100000" },
    });
    await assertError(response, 413, "payload_too_large");
    assert.equal(provider.calls.length, 0);
  });

  it("stops reading an endless body that has no Content-Length", async () => {
    let pulls = 0;
    const endless = new ReadableStream({
      pull(controller) {
        pulls += 1;
        controller.enqueue(new Uint8Array(1024).fill(0x20));
      },
    });
    const response = await oauthCall(GOOGLE_TOKEN.path, { body: endless, contentType: "application/json" });
    await assertError(response, 413, "payload_too_large");
    assert.ok(pulls <= 20, `read ${pulls} chunks of an endless body`);
    assert.equal(provider.calls.length, 0);
  });

  for (const route of OAUTH_ROUTES) {
    for (const [field, max] of Object.entries(route.fields)) {
      it(`${route.label}: rejects an invalid "${field}"`, async () => {
        const invalid = [undefined, null, 123, true, ["x"], { x: 1 }, "", "   ", "bad\ncontrol", "caf\u00e9", "x".repeat(max + 1)];
        for (const value of invalid) {
          const json = { ...route.request };
          if (value === undefined) delete json[field];
          else json[field] = value;
          const response = await oauthCall(route.path, { json });
          assert.equal(response.status, 400, `${field} = ${JSON.stringify(value)?.slice(0, 40)}`);
          await assertError(response, 400, "invalid_request");
        }
        assert.equal(provider.calls.length, 0);
      });

      if (field !== "redirectUri") {
        it(`${route.label}: accepts a "${field}" of exactly ${max} characters`, async () => {
          provider.reply(route.reply);
          const response = await oauthCall(route.path, { json: { ...route.request, [field]: "x".repeat(max) } });
          assert.equal(response.status, route.success);
          if (route.upstream) {
            assert.equal(provider.calls.length, 1);
            assert.equal(provider.calls[0].url, route.upstream);
          } else {
            assert.equal(provider.calls.length, 0);
          }
        });
      }
    }
  }

  it("accepts the printable ASCII an OAuth credential may contain", async () => {
    replyWithGoogleToken();
    const code = "4/0A-_.~+/=:;!@#$%^&*()[]{}<>?";
    const response = await oauthCall(GOOGLE_TOKEN.path, { json: { code } });
    await assertGoogleTokenAnswer(response);
    assert.equal(formOf(provider.calls[0]).code, code);
  });

  it("ignores unknown fields and never uses them", async () => {
    replyWithGoogleToken();
    const response = await oauthCall(GOOGLE_TOKEN.path, {
      json: { ...GOOGLE_TOKEN.request, client_id: "evil", client_secret: "evil", grant_type: "password", redirect_uri: "https://evil.example", scope: "everything", url: "https://evil.example/token" },
    });
    assert.equal(response.status, 200);
    const sent = new URLSearchParams(String(provider.calls[0].init.body));
    assert.deepEqual([...sent.keys()].sort(), ["client_id", "client_secret", "code", "grant_type", "redirect_uri"]);
    assert.equal(sent.get("client_id"), FAKE_GOOGLE_CLIENT_ID);
    assert.equal(sent.get("client_secret"), FAKE_GOOGLE_SECRET);
    assert.equal(sent.get("grant_type"), "authorization_code");
    assert.equal(sent.get("redirect_uri"), "postmessage");
  });
});

describe("OAuth broker: configuration", () => {
  it("answers 501 not_configured for every provider route when id or secret is missing", async () => {
    const variants = {
      "no configuration": {},
      "id only": { GOOGLE_CLIENT_ID: FAKE_GOOGLE_CLIENT_ID, MICROSOFT_CLIENT_ID: FAKE_MICROSOFT_CLIENT_ID, GITHUB_APP_CLIENT_ID: FAKE_GITHUB_CLIENT_ID },
      "secret only": { GOOGLE_CLIENT_SECRET: FAKE_GOOGLE_SECRET, MICROSOFT_CLIENT_SECRET: FAKE_MICROSOFT_SECRET, GITHUB_APP_CLIENT_SECRET: FAKE_GITHUB_SECRET },
      "blank values": configuredEnv({
        GOOGLE_CLIENT_ID: " ",
        GOOGLE_CLIENT_SECRET: "",
        MICROSOFT_CLIENT_ID: "",
        MICROSOFT_CLIENT_SECRET: " ",
        GITHUB_APP_CLIENT_ID: "",
        GITHUB_APP_CLIENT_SECRET: "\n",
      }),
    };
    for (const [label, env] of Object.entries(variants)) {
      for (const route of OAUTH_ROUTES) {
        const response = await oauthCall(route.path, { json: route.request }, env);
        assert.equal(response.status, 501, `${label}: ${route.label}`);
        const body = await assertError(response, 501, "not_configured");
        assertNoneOf(`${body.message}\n${headerText(response)}`, CLIENT_SECRETS, "the 501 response");
      }
    }
    assert.equal(provider.calls.length, 0);
  });

  it("keeps one provider working when only the other one is configured", async () => {
    provider.reply(OAUTH_ROUTES[3].reply);
    const onlyMicrosoft = configuredEnv({ GOOGLE_CLIENT_SECRET: undefined });
    const google = await oauthCall(OAUTH_ROUTES[0].path, { json: OAUTH_ROUTES[0].request }, onlyMicrosoft);
    await assertError(google, 501, "not_configured");
    const microsoft = await oauthCall(OAUTH_ROUTES[3].path, { json: OAUTH_ROUTES[3].request }, onlyMicrosoft);
    assert.equal(microsoft.status, 200);

    provider.reply(OAUTH_ROUTES[0].reply);
    const onlyGoogle = configuredEnv({ MICROSOFT_CLIENT_ID: undefined });
    const microsoftOff = await oauthCall(OAUTH_ROUTES[3].path, { json: OAUTH_ROUTES[3].request }, onlyGoogle);
    await assertError(microsoftOff, 501, "not_configured");
    const googleOn = await oauthCall(OAUTH_ROUTES[0].path, { json: OAUTH_ROUTES[0].request }, onlyGoogle);
    assert.equal(googleOn.status, 200);
  });

  it("works with the unconfigured redirect list by falling back to the built-in defaults", async () => {
    provider.reply(OAUTH_ROUTES[3].reply);
    const response = await oauthCall("/oauth/microsoft/token", {
      json: { ...OAUTH_ROUTES[3].request, redirectUri: MICROSOFT_REDIRECT_URI },
    });
    assert.equal(response.status, 200);
    assert.equal(provider.calls.length, 1);
    assert.equal(provider.calls[0].url, MICROSOFT_TOKEN_URL);
    assert.equal(formOf(provider.calls[0]).redirect_uri, MICROSOFT_REDIRECT_URI);
  });
});
