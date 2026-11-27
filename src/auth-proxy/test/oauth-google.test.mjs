import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  ALLOWED_ORIGIN,
  FAKE_GOOGLE_CLIENT_ID,
  FAKE_GOOGLE_SECRET,
  GOOGLE_REVOKE_URL,
  GOOGLE_TOKEN_REPLY,
  GOOGLE_TOKEN_URL,
  assertError,
  formOf,
  headersOf,
  jsonResponse,
  oauthCall,
  readJson,
  useProviderStub,
} from "./helpers.mjs";

const provider = useProviderStub();

function assertFormPost(call, url) {
  assert.equal(call.url, url);
  assert.equal(call.init.method, "POST");
  assert.equal(call.init.redirect, "manual");
  const headers = headersOf(call);
  assert.equal(headers.get("content-type"), "application/x-www-form-urlencoded");
  assert.equal(headers.get("accept"), "application/json");
}

describe("POST /oauth/google/token", () => {
  it("exchanges the authorization code using the client secret held by the Worker", async () => {
    provider.reply(() => jsonResponse(200, GOOGLE_TOKEN_REPLY));
    const response = await oauthCall("/oauth/google/token", { json: { code: "4/0AGoogleAuthCode" } });

    assert.deepEqual(await readJson(response, 200), {
      accessToken: "ya29.google-access-token",
      expiresIn: 3599,
      refreshToken: "1//google-refresh-token",
      scope: "openid email profile https://www.googleapis.com/auth/drive.appdata",
      idToken: "google.id.token",
    });
    assert.equal(provider.calls.length, 1);
    assertFormPost(provider.calls[0], GOOGLE_TOKEN_URL);
    assert.deepEqual(formOf(provider.calls[0]), {
      code: "4/0AGoogleAuthCode",
      client_id: FAKE_GOOGLE_CLIENT_ID,
      client_secret: FAKE_GOOGLE_SECRET,
      redirect_uri: "postmessage",
      grant_type: "authorization_code",
    });
  });

  it("never names a scope to Google, and ignores one the caller sends: the scopes are the browser's choice, the Worker only swaps the code", async () => {
    provider.reply(() => jsonResponse(200, GOOGLE_TOKEN_REPLY));
    await oauthCall("/oauth/google/token", { json: { code: "4/0AGoogleAuthCode", scope: "https://www.googleapis.com/auth/drive" } });
    const form = formOf(provider.calls[0]);
    assert.equal("scope" in form, false);
    assert.ok(!JSON.stringify(provider.calls[0].init.body ?? "").includes("auth/drive"));
  });

  it("omits the optional fields that Google did not send", async () => {
    provider.reply(() => jsonResponse(200, { access_token: "ya29.only-access", expires_in: 1800, token_type: "Bearer" }));
    const response = await oauthCall("/oauth/google/token", { json: { code: "c" } });
    assert.deepEqual(await readJson(response, 200), { accessToken: "ya29.only-access", expiresIn: 1800 });
  });

  it("accepts expires_in sent as a numeric string and always answers with a number", async () => {
    provider.reply(() => jsonResponse(200, { access_token: "ya29.string-expiry", expires_in: "3600" }));
    const response = await oauthCall("/oauth/google/token", { json: { code: "c" } });
    assert.deepEqual(await readJson(response, 200), { accessToken: "ya29.string-expiry", expiresIn: 3600 });
  });

  it("answers 400 invalid_grant when Google rejects the code, without relaying Google's text", async () => {
    provider.reply(() => jsonResponse(400, { error: "invalid_grant", error_description: "Malformed auth code." }));
    const response = await oauthCall("/oauth/google/token", { json: { code: "bad-code" } });
    const body = await assertError(response, 400, "invalid_grant");
    assert.ok(!body.message.includes("Malformed"));
    assert.ok(!body.message.includes("bad-code"));
  });

  it("tries the page's origin as redirect_uri when Google says that «postmessage» does not match, and only then", async () => {
    provider.reply((call) => {
      const form = formOf(call);
      return form.redirect_uri === "postmessage"
        ? jsonResponse(400, { error: "redirect_uri_mismatch", error_description: "Bad Request" })
        : jsonResponse(200, GOOGLE_TOKEN_REPLY);
    });
    const response = await oauthCall("/oauth/google/token", { json: { code: "4/0AGoogleAuthCode" } });
    assert.equal((await readJson(response, 200)).accessToken, "ya29.google-access-token");
    assert.deepEqual(provider.calls.map((call) => formOf(call).redirect_uri), ["postmessage", ALLOWED_ORIGIN]);
    for (const call of provider.calls) assert.equal(formOf(call).code, "4/0AGoogleAuthCode");
  });

  it("never sends an origin that the Worker does not allow, and never retries another failure", async () => {
    // A request from an origin that is not allowed is refused before any exchange: its origin cannot reach Google.
    provider.reply(() => jsonResponse(400, { error: "redirect_uri_mismatch", error_description: "Bad Request" }));
    const foreign = await oauthCall("/oauth/google/token", { json: { code: "c" }, origin: "https://evil.example" });
    assert.equal(foreign.status, 403);
    assert.equal(provider.calls.length, 0);

    // A request with no origin at all (not a browser of the site) gets the first try only: there is no origin to offer.
    const none = await oauthCall("/oauth/google/token", { json: { code: "c" }, origin: "" });
    assert.ok(none.status === 502 || none.status === 403, `status ${none.status}`);
    assert.ok(provider.calls.every((call) => formOf(call).redirect_uri === "postmessage"));

    provider.calls.length = 0;
    provider.reply(() => jsonResponse(400, { error: "invalid_grant", error_description: "Malformed auth code." }));
    await assertError(await oauthCall("/oauth/google/token", { json: { code: "c" } }), 400, "invalid_grant");
    assert.equal(provider.calls.length, 1, "a rejected code is not tried again");
  });

  it("reports a misconfigured client as upstream_error rather than as a caller mistake", async () => {
    const failures = [
      [401, { error: "invalid_client", error_description: "Unauthorized" }],
      [400, { error: "redirect_uri_mismatch", error_description: "Bad Request" }],
      [400, { error: "unauthorized_client", error_description: "Unauthorized" }],
      [400, { error: "invalid_request", error_description: "Missing required parameter: code" }],
    ];
    for (const [status, payload] of failures) {
      provider.reply(() => jsonResponse(status, payload));
      const response = await oauthCall("/oauth/google/token", { json: { code: "c" } });
      await assertError(response, 502, "upstream_error");
    }
  });
});

describe("Google answers and the Microsoft-only client_info", () => {
  it("never asks Google for client_info and never answers with clientInfo", async () => {
    provider.reply(() => jsonResponse(200, { ...GOOGLE_TOKEN_REPLY, client_info: "must-not-be-relayed" }));
    const token = await readJson(await oauthCall("/oauth/google/token", { json: { code: "c" } }), 200);
    const refreshed = await readJson(await oauthCall("/oauth/google/refresh", { json: { refreshToken: "r" } }), 200);
    for (const body of [token, refreshed]) {
      assert.equal(Object.hasOwn(body, "clientInfo"), false);
      assert.ok(!JSON.stringify(body).includes("must-not-be-relayed"));
    }
    for (const call of provider.calls) {
      assert.equal(Object.hasOwn(formOf(call), "client_info"), false);
    }
  });
});

describe("POST /oauth/google/refresh", () => {
  it("refreshes the access token with the client secret held by the Worker", async () => {
    provider.reply(() =>
      jsonResponse(200, {
        access_token: "ya29.refreshed",
        expires_in: 3599,
        scope: "openid email profile",
        token_type: "Bearer",
        id_token: "google.id.token",
        refresh_token: "1//must-not-be-relayed",
      }),
    );
    const response = await oauthCall("/oauth/google/refresh", { json: { refreshToken: "1//stored-refresh-token" } });

    assert.deepEqual(await readJson(response, 200), {
      accessToken: "ya29.refreshed",
      expiresIn: 3599,
      scope: "openid email profile",
    });
    assert.equal(provider.calls.length, 1);
    assertFormPost(provider.calls[0], GOOGLE_TOKEN_URL);
    assert.deepEqual(formOf(provider.calls[0]), {
      refresh_token: "1//stored-refresh-token",
      client_id: FAKE_GOOGLE_CLIENT_ID,
      client_secret: FAKE_GOOGLE_SECRET,
      grant_type: "refresh_token",
    });
  });

  it("renews without naming a scope either: the refresh keeps what the person granted", async () => {
    provider.reply(() => jsonResponse(200, { access_token: "ya29.new", expires_in: 3599 }));
    await oauthCall("/oauth/google/refresh", { json: { refreshToken: "1//google-refresh-token", scope: "https://www.googleapis.com/auth/drive" } });
    assert.equal("scope" in formOf(provider.calls[0]), false);
  });

  it("omits scope when Google does not send one", async () => {
    provider.reply(() => jsonResponse(200, { access_token: "ya29.refreshed", expires_in: 3599 }));
    const response = await oauthCall("/oauth/google/refresh", { json: { refreshToken: "r" } });
    assert.deepEqual(await readJson(response, 200), { accessToken: "ya29.refreshed", expiresIn: 3599 });
  });

  it("answers 400 invalid_grant when the refresh token was revoked or has expired", async () => {
    provider.reply(() => jsonResponse(400, { error: "invalid_grant", error_description: "Token has been expired or revoked." }));
    const response = await oauthCall("/oauth/google/refresh", { json: { refreshToken: "1//revoked" } });
    const body = await assertError(response, 400, "invalid_grant");
    assert.ok(!body.message.includes("1//revoked"));
  });
});

describe("POST /oauth/google/revoke", () => {
  it("revokes the token at Google and answers 204 without sending the client secret", async () => {
    provider.reply(() => new Response("", { status: 200 }));
    const response = await oauthCall("/oauth/google/revoke", { json: { token: "1//token-to-revoke" } });

    assert.equal(await readJson(response, 204), null);
    assert.equal(provider.calls.length, 1);
    assertFormPost(provider.calls[0], GOOGLE_REVOKE_URL);
    assert.deepEqual(formOf(provider.calls[0]), { token: "1//token-to-revoke" });
  });

  it("is idempotent: a token Google already considers invalid still answers 204", async () => {
    provider.reply(() => jsonResponse(400, { error: "invalid_token", error_description: "Token expired or revoked" }));
    const response = await oauthCall("/oauth/google/revoke", { json: { token: "1//already-revoked" } });
    assert.equal(await readJson(response, 204), null);
  });

  it("reports other Google failures as upstream_error", async () => {
    for (const [status, payload] of [
      [401, { error: "invalid_client" }],
      [400, { error: "invalid_request" }],
      [500, { error: "server_error" }],
    ]) {
      provider.reply(() => jsonResponse(status, payload));
      const response = await oauthCall("/oauth/google/revoke", { json: { token: "t" } });
      await assertError(response, 502, "upstream_error");
    }
  });
});
