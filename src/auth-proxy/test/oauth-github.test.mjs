import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  CLIENT_SECRETS,
  FAKE_GITHUB_CLIENT_ID,
  FAKE_GITHUB_SECRET,
  GITHUB_GRANT_URL,
  GITHUB_REDIRECT_URI,
  GITHUB_TOKEN_REPLY,
  GITHUB_TOKEN_URL,
  assertError,
  assertNoneOf,
  captureConsole,
  configuredEnv,
  formOf,
  headerText,
  headersOf,
  jsonResponse,
  oauthCall,
  readJson,
  useProviderStub,
} from "./helpers.mjs";

const provider = useProviderStub();

const TOKEN_REQUEST = {
  code: "github-authorization-code-0123",
  codeVerifier: "github-code-verifier-0123456789-abcdefghijklmnopqrstuvwxyz",
  redirectUri: GITHUB_REDIRECT_URI,
};
const REFRESH_REQUEST = { refreshToken: "ghr_stored-refresh-token-0123456789" };
const REVOKE_REQUEST = { token: "ghu_token-to-revoke-0123456789" };

const BASIC_VALUE = Buffer.from(`${FAKE_GITHUB_CLIENT_ID}:${FAKE_GITHUB_SECRET}`).toString("base64");
const BASIC = `Basic ${BASIC_VALUE}`;

function assertFormPost(call) {
  assert.equal(call.url, GITHUB_TOKEN_URL);
  assert.equal(call.init.method, "POST");
  assert.equal(call.init.redirect, "manual");
  const headers = headersOf(call);
  assert.equal(headers.get("content-type"), "application/x-www-form-urlencoded");
  // GitHub answers form-encoded text unless it is asked for JSON.
  assert.equal(headers.get("accept"), "application/json");
}

describe("POST /oauth/github/token", () => {
  it("exchanges the code with the PKCE verifier, the redirect URI and the client secret", async () => {
    provider.reply(() => jsonResponse(200, GITHUB_TOKEN_REPLY));
    const response = await oauthCall("/oauth/github/token", { json: TOKEN_REQUEST });

    assert.deepEqual(await readJson(response, 200), {
      accessToken: "ghu_fakegithubaccesstoken0123456789",
      expiresIn: 28800,
      refreshToken: "ghr_fakegithubrefreshtoken0123456789",
      refreshTokenExpiresIn: 15897600,
    });
    assert.equal(provider.calls.length, 1);
    assertFormPost(provider.calls[0]);
    assert.deepEqual(formOf(provider.calls[0]), {
      client_id: FAKE_GITHUB_CLIENT_ID,
      client_secret: FAKE_GITHUB_SECRET,
      code: TOKEN_REQUEST.code,
      code_verifier: TOKEN_REQUEST.codeVerifier,
      redirect_uri: GITHUB_REDIRECT_URI,
    });
  });

  it("leaves out the empty scope GitHub Apps report, and relays a non-empty one", async () => {
    provider.reply(() => jsonResponse(200, { ...GITHUB_TOKEN_REPLY, scope: "" }));
    const empty = await readJson(await oauthCall("/oauth/github/token", { json: TOKEN_REQUEST }), 200);
    assert.equal(Object.hasOwn(empty, "scope"), false);

    provider.reply(() => jsonResponse(200, { ...GITHUB_TOKEN_REPLY, scope: "offline_access" }));
    const full = await readJson(await oauthCall("/oauth/github/token", { json: TOKEN_REQUEST }), 200);
    assert.equal(full.scope, "offline_access");
  });

  it("omits refreshTokenExpiresIn when GitHub sends none, or something unusable", async () => {
    for (const value of [undefined, null, 0, -1, "soon", "", true]) {
      provider.reply(() => jsonResponse(200, { ...GITHUB_TOKEN_REPLY, refresh_token_expires_in: value }));
      const body = await readJson(await oauthCall("/oauth/github/token", { json: TOKEN_REQUEST }), 200);
      assert.equal(Object.hasOwn(body, "refreshTokenExpiresIn"), false, JSON.stringify(value));
      assert.equal(body.refreshToken, GITHUB_TOKEN_REPLY.refresh_token);
    }
  });

  it("never lets the body change the client, the grant type or the redirect target", async () => {
    provider.reply(() => jsonResponse(200, GITHUB_TOKEN_REPLY));
    await oauthCall("/oauth/github/token", {
      json: { ...TOKEN_REQUEST, client_id: "evil", client_secret: "evil", grant_type: "refresh_token", repository_id: "1", scope: "repo" },
    });
    const form = formOf(provider.calls[0]);
    assert.equal(form.client_id, FAKE_GITHUB_CLIENT_ID);
    assert.equal(form.client_secret, FAKE_GITHUB_SECRET);
    assert.equal(Object.hasOwn(form, "grant_type"), false);
    assert.equal(Object.hasOwn(form, "repository_id"), false);
    assert.equal(Object.hasOwn(form, "scope"), false);
  });

  it("requires code, codeVerifier and redirectUri", async () => {
    for (const missing of ["code", "codeVerifier", "redirectUri"]) {
      const rest = { ...TOKEN_REQUEST };
      delete rest[missing];
      const response = await oauthCall("/oauth/github/token", { json: rest });
      await assertError(response, 400, "invalid_request");
    }
    assert.equal(provider.calls.length, 0);
  });
});

describe("POST /oauth/github/token: redirect URI allow-list", () => {
  it("accepts the four callback URLs of the site, built in and in wrangler.toml", async () => {
    for (const redirectUri of [
      "https://narrarium.net/auth/github/callback",
      "https://www.narrarium.net/auth/github/callback",
      "http://localhost:5173/auth/github/callback",
      "http://localhost:4173/auth/github/callback",
    ]) {
      provider.reply(() => jsonResponse(200, GITHUB_TOKEN_REPLY));
      const response = await oauthCall("/oauth/github/token", { json: { ...TOKEN_REQUEST, redirectUri } });
      assert.equal(response.status, 200, redirectUri);
      assert.equal(formOf(provider.calls.at(-1)).redirect_uri, redirectUri);
    }
  });

  it("refuses any other redirect URI with 400 invalid_request and never calls GitHub", async () => {
    const rejected = [
      "https://evil.example/auth/github/callback",
      "https://narrarium.net.evil.example/auth/github/callback",
      "https://narrarium.net/auth/github/callback/",
      "https://narrarium.net/auth/github/callback?next=https://evil.example",
      "https://narrarium.net/auth/github/callback#fragment",
      "https://narrarium.net/auth/github/other",
      "https://narrarium.net/auth/github/callback/sub",
      "https://oauth.narrarium.net/auth/github/callback",
      "http://narrarium.net/auth/github/callback",
      "http://localhost:3000/auth/github/callback",
      "https://narrarium.net@evil.example/auth/github/callback",
      "javascript:alert(1)",
      "*",
    ];
    for (const redirectUri of rejected) {
      const response = await oauthCall("/oauth/github/token", { json: { ...TOKEN_REQUEST, redirectUri } });
      assert.equal(response.status, 400, redirectUri);
      await assertError(response, 400, "invalid_request");
    }
    assert.equal(provider.calls.length, 0);
  });

  it("lets ALLOWED_REDIRECT_URIS replace the defaults, so a site under a sub-path can add its own callback", async () => {
    const sitePath = "https://example.github.io/narrarium/auth/github/callback";
    const env = configuredEnv({ ALLOWED_REDIRECT_URIS: sitePath });
    provider.reply(() => jsonResponse(200, GITHUB_TOKEN_REPLY));
    const accepted = await oauthCall("/oauth/github/token", { json: { ...TOKEN_REQUEST, redirectUri: sitePath } }, env);
    assert.equal(accepted.status, 200);
    provider.calls.length = 0;
    const builtIn = await oauthCall("/oauth/github/token", { json: TOKEN_REQUEST }, env);
    await assertError(builtIn, 400, "invalid_request");
    assert.equal(provider.calls.length, 0);
  });
});

describe("GitHub reports OAuth errors inside an HTTP 200 answer", () => {
  const FAILING_ROUTES = [
    ["token", "/oauth/github/token", TOKEN_REQUEST],
    ["refresh", "/oauth/github/refresh", REFRESH_REQUEST],
  ];

  function errorBody(code, extra = {}) {
    return {
      error: code,
      error_description: `GitHub text about ${code}. Secret ${FAKE_GITHUB_SECRET}, code ${TOKEN_REQUEST.code}.`,
      error_uri: "/apps/managing-oauth-apps/troubleshooting-oauth-app-access-token-request-errors/",
      ...extra,
    };
  }

  it("maps a rejected code or refresh token to 400 invalid_grant, never to success", async () => {
    for (const code of ["bad_verification_code", "bad_refresh_token", "invalid_grant"]) {
      for (const [label, path, request] of FAILING_ROUTES) {
        provider.reply(() => jsonResponse(200, errorBody(code)));
        const response = await oauthCall(path, { json: request });
        assert.equal(response.status, 400, `${label} / ${code}`);
        const body = await assertError(response, 400, "invalid_grant");
        assertNoneOf(JSON.stringify(body), [FAKE_GITHUB_SECRET, TOKEN_REQUEST.code, "GitHub text"], `${label} / ${code} answer`);
      }
    }
  });

  it("maps the same errors when GitHub does use a 4xx status", async () => {
    for (const status of [400, 401, 422]) {
      provider.reply(() => jsonResponse(status, errorBody("bad_verification_code")));
      const response = await oauthCall("/oauth/github/token", { json: TOKEN_REQUEST });
      await assertError(response, 400, "invalid_grant");
    }
  });

  it("maps wrong client credentials to 501 not_configured, because the Worker's id or secret is wrong", async () => {
    for (const [label, path, request] of FAILING_ROUTES) {
      provider.reply(() => jsonResponse(200, errorBody("incorrect_client_credentials")));
      const response = await oauthCall(path, { json: request });
      const body = await assertError(response, 501, "not_configured");
      assert.match(body.message, /client id or secret/, label);
    }
  });

  it("maps an unverified primary email to invalid_grant with a message that says what to do", async () => {
    provider.reply(() => jsonResponse(200, errorBody("unverified_user_email")));
    const response = await oauthCall("/oauth/github/token", { json: TOKEN_REQUEST });
    const body = await assertError(response, 400, "invalid_grant");
    assert.match(body.message, /email/i);
  });

  it("maps a mismatching redirect URI to upstream_error and quotes only its code", async () => {
    provider.reply(() => jsonResponse(200, errorBody("redirect_uri_mismatch")));
    const response = await oauthCall("/oauth/github/token", { json: TOKEN_REQUEST });
    const body = await assertError(response, 502, "upstream_error");
    assert.match(body.message, /redirect_uri_mismatch/);
    assert.ok(!body.message.includes("GitHub text"));
  });

  it("maps any other error code to a generic upstream_error, without echoing it", async () => {
    for (const code of ["device_flow_disabled", "something_new", "<script>", "x".repeat(500)]) {
      provider.reply(() => jsonResponse(200, errorBody(code)));
      const response = await oauthCall("/oauth/github/token", { json: TOKEN_REQUEST });
      const body = await assertError(response, 502, "upstream_error");
      assert.ok(!body.message.includes(code.slice(0, 10)), code);
      assertNoneOf(JSON.stringify(body), [FAKE_GITHUB_SECRET, "GitHub text"], "the answer");
    }
  });

  it("never answers 200 for an error body, even when it also carries an access token", async () => {
    provider.reply(() =>
      jsonResponse(200, errorBody("bad_verification_code", { access_token: "ghu_must-not-pass", expires_in: 3600, refresh_token: "ghr_must-not-pass" })),
    );
    const response = await oauthCall("/oauth/github/token", { json: TOKEN_REQUEST });
    const body = await assertError(response, 400, "invalid_grant");
    assertNoneOf(JSON.stringify(body), ["ghu_must-not-pass", "ghr_must-not-pass"], "the answer");
  });

  it("answers 502 for a token that never expires or has no refresh token, and says which setting to turn on", async () => {
    const withoutExpiry = { access_token: "ghu_forever", token_type: "bearer", scope: "" };
    const withoutRefresh = { access_token: "ghu_short", expires_in: 28800, token_type: "bearer", scope: "" };
    for (const payload of [withoutExpiry, withoutRefresh]) {
      for (const [, path, request] of FAILING_ROUTES) {
        provider.reply(() => jsonResponse(200, payload));
        const response = await oauthCall(path, { json: request });
        const body = await assertError(response, 502, "upstream_error");
        assert.match(body.message, /Expire user authorization tokens/);
        assert.ok(!JSON.stringify(body).includes("ghu_"));
      }
    }
  });

  it("answers 502 when the 200 body is not JSON (GitHub ignores Accept: application/json)", async () => {
    provider.reply(() => new Response("error=bad_verification_code&error_description=The+code+passed+is+incorrect+or+expired.", { status: 200 }));
    const response = await oauthCall("/oauth/github/token", { json: TOKEN_REQUEST });
    await assertError(response, 502, "upstream_error");
  });
});

describe("POST /oauth/github/refresh", () => {
  it("refreshes with the refresh token and returns the rotated one, with its lifetime", async () => {
    provider.reply(() =>
      jsonResponse(200, {
        access_token: "ghu_fakegithubrefreshedaccess0123",
        expires_in: 28800,
        refresh_token: "ghr_fakegithubrotatedrefresh0123",
        refresh_token_expires_in: 15897600,
        token_type: "bearer",
        scope: "",
      }),
    );
    const response = await oauthCall("/oauth/github/refresh", { json: REFRESH_REQUEST });

    assert.deepEqual(await readJson(response, 200), {
      accessToken: "ghu_fakegithubrefreshedaccess0123",
      expiresIn: 28800,
      refreshToken: "ghr_fakegithubrotatedrefresh0123",
      refreshTokenExpiresIn: 15897600,
    });
    assert.equal(provider.calls.length, 1);
    assertFormPost(provider.calls[0]);
    assert.deepEqual(formOf(provider.calls[0]), {
      client_id: FAKE_GITHUB_CLIENT_ID,
      client_secret: FAKE_GITHUB_SECRET,
      grant_type: "refresh_token",
      refresh_token: REFRESH_REQUEST.refreshToken,
    });
  });

  it("never lets the body change the grant type or the client", async () => {
    provider.reply(() => jsonResponse(200, GITHUB_TOKEN_REPLY));
    await oauthCall("/oauth/github/refresh", { json: { ...REFRESH_REQUEST, grant_type: "authorization_code", client_id: "evil", code: "stolen" } });
    const form = formOf(provider.calls[0]);
    assert.equal(form.grant_type, "refresh_token");
    assert.equal(form.client_id, FAKE_GITHUB_CLIENT_ID);
    assert.equal(Object.hasOwn(form, "code"), false);
  });

  it("answers 400 invalid_grant for a spent, expired or revoked refresh token (GitHub rotates them)", async () => {
    provider.reply(() => jsonResponse(200, { error: "bad_refresh_token", error_description: "The refresh token passed is incorrect or expired." }));
    const response = await oauthCall("/oauth/github/refresh", { json: REFRESH_REQUEST });
    await assertError(response, 400, "invalid_grant");
  });
});

describe("POST /oauth/github/revoke", () => {
  it("deletes the app's grant with Basic client authentication and the token in the JSON body", async () => {
    provider.reply(() => new Response(null, { status: 204 }));
    const response = await oauthCall("/oauth/github/revoke", { json: REVOKE_REQUEST });
    assert.equal(await readJson(response, 204), null);

    assert.equal(provider.calls.length, 1);
    const call = provider.calls[0];
    assert.equal(call.url, GITHUB_GRANT_URL);
    assert.equal(call.init.method, "DELETE");
    assert.equal(call.init.redirect, "manual");
    const headers = headersOf(call);
    assert.equal(headers.get("authorization"), BASIC);
    assert.equal(headers.get("accept"), "application/vnd.github+json");
    assert.equal(headers.get("content-type"), "application/json");
    assert.match(headers.get("x-github-api-version") ?? "", /^\d{4}-\d{2}-\d{2}$/);
    assert.ok(headers.get("user-agent"), "GitHub's API requires a User-Agent");
    assert.deepEqual(JSON.parse(String(call.init.body)), { access_token: REVOKE_REQUEST.token });
  });

  it("puts the client id in the path, encoded, and never takes the URL from the body", async () => {
    provider.reply(() => new Response(null, { status: 204 }));
    const env = configuredEnv({ GITHUB_APP_CLIENT_ID: "Iv1/odd id?x" });
    await oauthCall("/oauth/github/revoke", { json: { ...REVOKE_REQUEST, url: "https://evil.example/grant", client_id: "evil" } }, env);
    assert.equal(provider.calls[0].url, "https://api.github.com/applications/Iv1%2Fodd%20id%3Fx/grant");
  });

  it("treats a missing grant (404) as revoked", async () => {
    provider.reply(() => jsonResponse(404, { message: "Not Found" }));
    const response = await oauthCall("/oauth/github/revoke", { json: REVOKE_REQUEST });
    assert.equal(await readJson(response, 204), null);
  });

  it("reports wrong client credentials (401) as not_configured and other failures as upstream_error", async () => {
    provider.reply(() => jsonResponse(401, { message: "Bad credentials" }));
    await assertError(await oauthCall("/oauth/github/revoke", { json: REVOKE_REQUEST }), 501, "not_configured");

    for (const [status, payload] of [
      [422, { message: "Validation Failed" }],
      [403, { message: "API rate limit exceeded" }],
      [500, { message: "Server Error" }],
    ]) {
      provider.reply(() => jsonResponse(status, payload));
      const body = await assertError(await oauthCall("/oauth/github/revoke", { json: REVOKE_REQUEST }), 502, "upstream_error");
      assert.ok(!body.message.includes("Validation") && !body.message.includes("rate limit"));
    }
  });

  it("still validates its body", async () => {
    await assertError(await oauthCall("/oauth/github/revoke", { json: {} }), 400, "invalid_request");
    assert.equal(provider.calls.length, 0);
  });
});

describe("GitHub provider configuration", () => {
  const ROUTES = [
    ["/oauth/github/token", TOKEN_REQUEST],
    ["/oauth/github/refresh", REFRESH_REQUEST],
    ["/oauth/github/revoke", REVOKE_REQUEST],
  ];

  it("answers 501 not_configured for every route while the client id or the secret is missing", async () => {
    const variants = [
      configuredEnv({ GITHUB_APP_CLIENT_ID: "" }),
      configuredEnv({ GITHUB_APP_CLIENT_ID: undefined }),
      configuredEnv({ GITHUB_APP_CLIENT_SECRET: "" }),
      configuredEnv({ GITHUB_APP_CLIENT_SECRET: undefined }),
      configuredEnv({ GITHUB_APP_CLIENT_ID: "  ", GITHUB_APP_CLIENT_SECRET: "\n" }),
    ];
    for (const env of variants) {
      for (const [path, request] of ROUTES) {
        const response = await oauthCall(path, { json: request }, env);
        const body = await assertError(response, 501, "not_configured");
        assertNoneOf(`${body.message}\n${headerText(response)}`, CLIENT_SECRETS, "the 501 answer");
      }
    }
    assert.equal(provider.calls.length, 0);
  });

  it("does not stop the other providers", async () => {
    provider.reply(() => jsonResponse(200, { access_token: "ya29.x", expires_in: 3599, refresh_token: "r" }));
    const env = configuredEnv({ GITHUB_APP_CLIENT_SECRET: undefined });
    const google = await oauthCall("/oauth/google/token", { json: { code: "c" } }, env);
    assert.equal(google.status, 200);
  });

  it("uses only POST for its routes", async () => {
    for (const [path] of ROUTES) {
      const response = await oauthCall(path, { method: "GET" });
      await assertError(response, 405, "method_not_allowed");
    }
    await assertError(await oauthCall("/oauth/github/other", { json: {} }), 404, "not_found");
  });
});

describe("GitHub: the secret and the tokens never leak", () => {
  const SENSITIVE = [
    FAKE_GITHUB_SECRET,
    TOKEN_REQUEST.code,
    TOKEN_REQUEST.codeVerifier,
    REFRESH_REQUEST.refreshToken,
    REVOKE_REQUEST.token,
    GITHUB_TOKEN_REPLY.access_token,
    GITHUB_TOKEN_REPLY.refresh_token,
    BASIC,
    BASIC_VALUE,
  ];
  const EVERYTHING = SENSITIVE.join(" ");
  const LEAKY = { "Set-Cookie": `sid=${EVERYTHING}`, "X-Leak": EVERYTHING, "WWW-Authenticate": EVERYTHING };

  const SCENARIOS = [
    ["success", () => jsonResponse(200, GITHUB_TOKEN_REPLY, LEAKY)],
    ["bad_verification_code in a 200", () => jsonResponse(200, { error: "bad_verification_code", error_description: EVERYTHING }, LEAKY)],
    ["incorrect_client_credentials in a 200", () => jsonResponse(200, { error: "incorrect_client_credentials", error_description: EVERYTHING }, LEAKY)],
    ["unknown error in a 200", () => jsonResponse(200, { error: EVERYTHING, error_description: EVERYTHING }, LEAKY)],
    ["401 echoing everything", () => jsonResponse(401, { message: EVERYTHING }, LEAKY)],
    ["500 echoing everything", () => new Response(EVERYTHING, { status: 500, headers: LEAKY })],
    ["network error echoing everything", () => Promise.reject(new Error(EVERYTHING))],
    ["garbage 200 echoing everything", () => new Response(EVERYTHING, { status: 200, headers: LEAKY })],
  ];
  const ROUTES = [
    ["/oauth/github/token", TOKEN_REQUEST],
    ["/oauth/github/refresh", REFRESH_REQUEST],
    ["/oauth/github/revoke", REVOKE_REQUEST],
  ];

  async function battery() {
    const problems = [];
    for (const [path, request] of ROUTES) {
      for (const [label, reply] of SCENARIOS) {
        provider.reply(reply);
        const response = await oauthCall(path, { json: request });
        const text = `${await response.text()}\n${headerText(response)}`;
        const tokensMayAppear = response.status === 200 && label === "success";
        for (const needle of SENSITIVE) {
          const allowed = tokensMayAppear && [GITHUB_TOKEN_REPLY.access_token, GITHUB_TOKEN_REPLY.refresh_token].includes(needle);
          if (text.includes(needle) && !allowed) problems.push(`${path} / ${label}: ${response.status} contains ${needle.slice(0, 12)}…`);
        }
        for (const name of ["set-cookie", "x-leak", "www-authenticate"]) {
          if (response.headers.has(name)) problems.push(`${path} / ${label}: forwards ${name}`);
        }
      }
    }
    return problems;
  }

  it("keeps the client secret, codes and tokens out of every answer and header", async () => {
    assert.deepEqual(await battery(), []);
  });

  it("writes nothing to the console", async (t) => {
    const output = captureConsole(t);
    await battery();
    assert.deepEqual(output.lines, []);
  });
});
