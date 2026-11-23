import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  FAKE_MICROSOFT_CLIENT_ID,
  FAKE_MICROSOFT_SECRET,
  MICROSOFT_REDIRECT_URI,
  MICROSOFT_SCOPE,
  MICROSOFT_TOKEN_REPLY,
  MICROSOFT_TOKEN_URL,
  assertError,
  configuredEnv,
  formOf,
  headersOf,
  jsonResponse,
  oauthCall,
  readJson,
  useProviderStub,
} from "./helpers.mjs";

const provider = useProviderStub();

const TOKEN_REQUEST = {
  code: "M.C507_BAY.2.U.microsoft-auth-code",
  codeVerifier: "microsoft-code-verifier-0123456789-abcdefghijklmnop",
  redirectUri: MICROSOFT_REDIRECT_URI,
};

function assertFormPost(call) {
  assert.equal(call.url, MICROSOFT_TOKEN_URL);
  assert.equal(call.init.method, "POST");
  assert.equal(call.init.redirect, "manual");
  const headers = headersOf(call);
  assert.equal(headers.get("content-type"), "application/x-www-form-urlencoded");
  assert.equal(headers.get("accept"), "application/json");
}

describe("POST /oauth/microsoft/token", () => {
  it("exchanges the code with the PKCE verifier, the fixed scope and the client secret", async () => {
    provider.reply(() => jsonResponse(200, MICROSOFT_TOKEN_REPLY));
    const response = await oauthCall("/oauth/microsoft/token", { json: TOKEN_REQUEST });

    assert.deepEqual(await readJson(response, 200), {
      accessToken: "ey.microsoft-access-token",
      expiresIn: 3599,
      refreshToken: "0.microsoft-refresh-token",
      scope: "User.Read Files.ReadWrite",
      idToken: "microsoft.id.token",
    });
    assert.equal(provider.calls.length, 1);
    assertFormPost(provider.calls[0]);
    assert.deepEqual(formOf(provider.calls[0]), {
      client_id: FAKE_MICROSOFT_CLIENT_ID,
      client_secret: FAKE_MICROSOFT_SECRET,
      grant_type: "authorization_code",
      code: TOKEN_REQUEST.code,
      code_verifier: TOKEN_REQUEST.codeVerifier,
      redirect_uri: MICROSOFT_REDIRECT_URI,
      scope: MICROSOFT_SCOPE,
      client_info: "1",
    });
  });

  it("never lets the body change the scope, the client or the grant type", async () => {
    provider.reply(() => jsonResponse(200, MICROSOFT_TOKEN_REPLY));
    await oauthCall("/oauth/microsoft/token", {
      json: { ...TOKEN_REQUEST, scope: "Mail.Read", client_id: "evil", grant_type: "client_credentials" },
    });
    const form = formOf(provider.calls[0]);
    assert.equal(form.scope, MICROSOFT_SCOPE);
    assert.equal(form.client_id, FAKE_MICROSOFT_CLIENT_ID);
    assert.equal(form.grant_type, "authorization_code");
  });

  it("omits the optional fields Microsoft did not send", async () => {
    provider.reply(() => jsonResponse(200, { access_token: "ey.access", refresh_token: "0.refresh", expires_in: 3600 }));
    const response = await oauthCall("/oauth/microsoft/token", { json: TOKEN_REQUEST });
    assert.deepEqual(await readJson(response, 200), { accessToken: "ey.access", expiresIn: 3600, refreshToken: "0.refresh" });
  });

  it("answers 502 when Microsoft sends no refresh token, because the contract promises one", async () => {
    provider.reply(() => jsonResponse(200, { access_token: "ey.access", expires_in: 3600, scope: "User.Read" }));
    const response = await oauthCall("/oauth/microsoft/token", { json: TOKEN_REQUEST });
    await assertError(response, 502, "upstream_error");
  });

  it("answers 400 invalid_grant when Microsoft rejects the code, without relaying its text", async () => {
    provider.reply(() =>
      jsonResponse(400, {
        error: "invalid_grant",
        error_description: "AADSTS54005: OAuth2 Authorization code was already redeemed, please retry with a new valid code.\r\nTrace ID: 11111111",
        error_codes: [54005],
        suberror: "code_already_redeemed",
      }),
    );
    const response = await oauthCall("/oauth/microsoft/token", { json: TOKEN_REQUEST });
    const body = await assertError(response, 400, "invalid_grant");
    assert.ok(!body.message.includes("AADSTS"));
    assert.ok(!body.message.includes("Trace ID"));
  });

  it("reports a misconfigured app registration as upstream_error", async () => {
    const failures = [
      [401, { error: "invalid_client", error_description: "AADSTS7000215: Invalid client secret provided." }],
      [400, { error: "invalid_request", error_description: "AADSTS9002327: Tokens issued for the 'Single-Page Application' client-type may only be redeemed via cross-origin requests." }],
      [400, { error: "unauthorized_client", error_description: "AADSTS700016" }],
    ];
    for (const [status, payload] of failures) {
      provider.reply(() => jsonResponse(status, payload));
      const response = await oauthCall("/oauth/microsoft/token", { json: TOKEN_REQUEST });
      const body = await assertError(response, 502, "upstream_error");
      assert.ok(!body.message.includes("AADSTS"));
    }
  });
});

describe("POST /oauth/microsoft/token: redirect URI allow-list", () => {
  it("accepts the four built-in redirect URIs", async () => {
    for (const redirectUri of [
      "https://narrarium.net/auth/microsoft-callback.html",
      "https://www.narrarium.net/auth/microsoft-callback.html",
      "http://localhost:5173/auth/microsoft-callback.html",
      "http://localhost:4173/auth/microsoft-callback.html",
    ]) {
      provider.reply(() => jsonResponse(200, MICROSOFT_TOKEN_REPLY));
      const response = await oauthCall("/oauth/microsoft/token", { json: { ...TOKEN_REQUEST, redirectUri } });
      assert.equal(response.status, 200, redirectUri);
      assert.equal(formOf(provider.calls.at(-1)).redirect_uri, redirectUri);
    }
  });

  it("rejects any other redirect URI with 400 invalid_request and never calls Microsoft", async () => {
    const rejected = [
      "https://evil.example/auth/microsoft-callback.html",
      "https://narrarium.net.evil.example/auth/microsoft-callback.html",
      "https://narrarium.net/auth/microsoft-callback.html/",
      "https://narrarium.net/auth/microsoft-callback.html?next=https://evil.example",
      "https://narrarium.net/auth/microsoft-callback.html#fragment",
      "https://narrarium.net/auth/other.html",
      "https://narrarium.net/",
      "https://NARRARIUM.NET/auth/microsoft-callback.html",
      "http://narrarium.net/auth/microsoft-callback.html",
      "http://localhost:3000/auth/microsoft-callback.html",
      "https://narrarium.net@evil.example/auth/microsoft-callback.html",
      "javascript:alert(1)",
      "postmessage",
      "*",
    ];
    for (const redirectUri of rejected) {
      const response = await oauthCall("/oauth/microsoft/token", { json: { ...TOKEN_REQUEST, redirectUri } });
      assert.equal(response.status, 400, redirectUri);
      await assertError(response, 400, "invalid_request");
    }
    assert.equal(provider.calls.length, 0);
  });

  it("lets ALLOWED_REDIRECT_URIS replace the defaults, trimming and skipping empty entries", async () => {
    const sitePath = "https://example.github.io/narrarium/auth/microsoft-callback.html";
    const env = configuredEnv({ ALLOWED_REDIRECT_URIS: ` ${sitePath} ,, http://127.0.0.1:8080/cb ` });
    for (const redirectUri of [sitePath, "http://127.0.0.1:8080/cb"]) {
      provider.reply(() => jsonResponse(200, MICROSOFT_TOKEN_REPLY));
      const response = await oauthCall("/oauth/microsoft/token", { json: { ...TOKEN_REQUEST, redirectUri } }, env);
      assert.equal(response.status, 200, redirectUri);
    }
    provider.calls.length = 0;
    const builtIn = await oauthCall("/oauth/microsoft/token", { json: TOKEN_REQUEST }, env);
    await assertError(builtIn, 400, "invalid_request");
    assert.equal(provider.calls.length, 0);
  });

  it("ignores unsafe entries in ALLOWED_REDIRECT_URIS instead of trusting them", async () => {
    const safe = "https://ok.example.com/cb";
    const unsafe = [
      "*",
      "https://*.example.com/cb",
      "javascript:alert(1)",
      "http://insecure.example.com/cb",
      "https://user:secret@example.com/cb",
      "https://example.com/cb#fragment",
      "not a url",
    ];
    const env = configuredEnv({ ALLOWED_REDIRECT_URIS: [...unsafe, safe].join(",") });

    provider.reply(() => jsonResponse(200, MICROSOFT_TOKEN_REPLY));
    const accepted = await oauthCall("/oauth/microsoft/token", { json: { ...TOKEN_REQUEST, redirectUri: safe } }, env);
    assert.equal(accepted.status, 200);

    provider.calls.length = 0;
    for (const redirectUri of unsafe) {
      const response = await oauthCall("/oauth/microsoft/token", { json: { ...TOKEN_REQUEST, redirectUri } }, env);
      assert.equal(response.status, 400, redirectUri);
    }
    assert.equal(provider.calls.length, 0);
  });

  it("refuses every redirect URI when ALLOWED_REDIRECT_URIS is set but holds nothing usable", async () => {
    const env = configuredEnv({ ALLOWED_REDIRECT_URIS: "*,javascript:alert(1)" });
    const response = await oauthCall("/oauth/microsoft/token", { json: TOKEN_REQUEST }, env);
    await assertError(response, 400, "invalid_request");
    assert.equal(provider.calls.length, 0);
  });

  it("falls back to the defaults when ALLOWED_REDIRECT_URIS is blank", async () => {
    provider.reply(() => jsonResponse(200, MICROSOFT_TOKEN_REPLY));
    const response = await oauthCall("/oauth/microsoft/token", { json: TOKEN_REQUEST }, configuredEnv({ ALLOWED_REDIRECT_URIS: "  " }));
    assert.equal(response.status, 200);
    assert.equal(provider.calls.length, 1);
    assert.equal(provider.calls[0].url, MICROSOFT_TOKEN_URL);
    assert.equal(formOf(provider.calls[0]).redirect_uri, MICROSOFT_REDIRECT_URI);
  });
});

describe("POST /oauth/microsoft/refresh", () => {
  it("refreshes with the fixed scope and returns the rotated refresh token", async () => {
    provider.reply(() =>
      jsonResponse(200, {
        token_type: "Bearer",
        scope: "User.Read Files.ReadWrite",
        expires_in: 3599,
        access_token: "ey.microsoft-refreshed",
        refresh_token: "0.microsoft-rotated-refresh-token",
        id_token: "microsoft.id.token",
      }),
    );
    const response = await oauthCall("/oauth/microsoft/refresh", { json: { refreshToken: "0.microsoft-stored-refresh-token" } });

    assert.deepEqual(await readJson(response, 200), {
      accessToken: "ey.microsoft-refreshed",
      expiresIn: 3599,
      refreshToken: "0.microsoft-rotated-refresh-token",
    });
    assert.equal(provider.calls.length, 1);
    assertFormPost(provider.calls[0]);
    assert.deepEqual(formOf(provider.calls[0]), {
      client_id: FAKE_MICROSOFT_CLIENT_ID,
      client_secret: FAKE_MICROSOFT_SECRET,
      grant_type: "refresh_token",
      refresh_token: "0.microsoft-stored-refresh-token",
      scope: MICROSOFT_SCOPE,
      client_info: "1",
    });
  });

  it("omits refreshToken when Microsoft did not rotate it", async () => {
    provider.reply(() => jsonResponse(200, { access_token: "ey.refreshed", expires_in: 3599 }));
    const response = await oauthCall("/oauth/microsoft/refresh", { json: { refreshToken: "0.stored" } });
    assert.deepEqual(await readJson(response, 200), { accessToken: "ey.refreshed", expiresIn: 3599 });
  });

  it("answers 400 invalid_grant for an expired or revoked refresh token", async () => {
    const rejections = [
      { error: "invalid_grant", error_description: "AADSTS700082: The refresh token has expired due to inactivity.", error_codes: [700082] },
      { error: "invalid_grant", error_description: "AADSTS50173: The provided grant has expired due to it being revoked.", error_codes: [50173] },
      { error: "interaction_required", error_description: "AADSTS50076: multi-factor authentication is required." },
      { error: "consent_required", error_description: "AADSTS65001: consent is required." },
      { error: "login_required", error_description: "AADSTS50058: a silent sign-in request was sent." },
    ];
    for (const payload of rejections) {
      provider.reply(() => jsonResponse(400, payload));
      const response = await oauthCall("/oauth/microsoft/refresh", { json: { refreshToken: "0.stored" } });
      const body = await assertError(response, 400, "invalid_grant");
      assert.ok(!body.message.includes("AADSTS"), payload.error);
    }
  });
});

describe("Microsoft client_info (the account identity MSAL builds homeAccountId from)", () => {
  // Opaque to the Worker: base64url of {"uid": "...", "utid": "..."}, exactly as Microsoft sends it.
  const CLIENT_INFO = Buffer.from(
    JSON.stringify({ uid: "00000000-0000-0000-0000-0000000000aa", utid: "9188040d-6c67-4c5b-b112-36a304b66dad" }),
  ).toString("base64url");

  it("asks Microsoft for client_info on every token request, as MSAL does", async () => {
    provider.reply(() => jsonResponse(200, MICROSOFT_TOKEN_REPLY));
    await oauthCall("/oauth/microsoft/token", { json: TOKEN_REQUEST });
    await oauthCall("/oauth/microsoft/refresh", { json: { refreshToken: "0.stored" } });
    assert.equal(provider.calls.length, 2);
    for (const call of provider.calls) {
      assert.equal(formOf(call).client_info, "1");
    }
  });

  it("passes client_info through unchanged as clientInfo on /token, next to idToken", async () => {
    provider.reply(() => jsonResponse(200, { ...MICROSOFT_TOKEN_REPLY, client_info: CLIENT_INFO }));
    const response = await oauthCall("/oauth/microsoft/token", { json: TOKEN_REQUEST });
    const body = await readJson(response, 200);
    assert.deepEqual(body, {
      accessToken: "ey.microsoft-access-token",
      expiresIn: 3599,
      refreshToken: "0.microsoft-refresh-token",
      scope: "User.Read Files.ReadWrite",
      idToken: "microsoft.id.token",
      clientInfo: CLIENT_INFO,
    });
    assert.equal(body.clientInfo, CLIENT_INFO);
  });

  it("passes client_info through unchanged as clientInfo on /refresh", async () => {
    provider.reply(() =>
      jsonResponse(200, {
        access_token: "ey.microsoft-refreshed",
        refresh_token: "0.microsoft-rotated-refresh-token",
        expires_in: 3599,
        client_info: CLIENT_INFO,
      }),
    );
    const response = await oauthCall("/oauth/microsoft/refresh", { json: { refreshToken: "0.stored" } });
    assert.deepEqual(await readJson(response, 200), {
      accessToken: "ey.microsoft-refreshed",
      expiresIn: 3599,
      refreshToken: "0.microsoft-rotated-refresh-token",
      clientInfo: CLIENT_INFO,
    });
  });

  it("still answers when client_info is absent, and then has no clientInfo key", async () => {
    provider.reply(() => jsonResponse(200, MICROSOFT_TOKEN_REPLY));
    const token = await readJson(await oauthCall("/oauth/microsoft/token", { json: TOKEN_REQUEST }), 200);
    assert.equal(Object.hasOwn(token, "clientInfo"), false);
    assert.equal(token.accessToken, "ey.microsoft-access-token");

    provider.reply(() => jsonResponse(200, { access_token: "ey.refreshed", expires_in: 3599 }));
    const refreshed = await readJson(await oauthCall("/oauth/microsoft/refresh", { json: { refreshToken: "0.stored" } }), 200);
    assert.deepEqual(refreshed, { accessToken: "ey.refreshed", expiresIn: 3599 });
  });

  it("does not decode, validate or normalise client_info", async () => {
    for (const clientInfo of ["eyJ1aWQiOiJ4In0=", "not-base64-at-all!", "a b c", CLIENT_INFO.toUpperCase()]) {
      provider.reply(() => jsonResponse(200, { ...MICROSOFT_TOKEN_REPLY, client_info: clientInfo }));
      const body = await readJson(await oauthCall("/oauth/microsoft/token", { json: TOKEN_REQUEST }), 200);
      assert.equal(body.clientInfo, clientInfo);
    }
  });

  it("drops an empty, non-string or oversized client_info instead of failing or relaying it", async () => {
    const unusable = ["", null, 42, true, { uid: "x", utid: "y" }, [CLIENT_INFO], "x".repeat(2049)];
    for (const clientInfo of unusable) {
      provider.reply(() => jsonResponse(200, { ...MICROSOFT_TOKEN_REPLY, client_info: clientInfo }));
      const response = await oauthCall("/oauth/microsoft/token", { json: TOKEN_REQUEST });
      assert.equal(response.status, 200, JSON.stringify(clientInfo)?.slice(0, 30));
      const body = await response.json();
      assert.equal(Object.hasOwn(body, "clientInfo"), false);
      assert.equal(body.accessToken, "ey.microsoft-access-token");
    }
    provider.reply(() => jsonResponse(200, { ...MICROSOFT_TOKEN_REPLY, client_info: "x".repeat(2048) }));
    const atLimit = await readJson(await oauthCall("/oauth/microsoft/token", { json: TOKEN_REQUEST }), 200);
    assert.equal(atLimit.clientInfo, "x".repeat(2048));
  });

  it("never relays client_info from a Microsoft error answer", async () => {
    provider.reply(() => jsonResponse(400, { error: "invalid_grant", error_description: "expired", client_info: CLIENT_INFO }));
    const response = await oauthCall("/oauth/microsoft/refresh", { json: { refreshToken: "0.stored" } });
    const text = JSON.stringify(await assertError(response, 400, "invalid_grant"));
    assert.ok(!text.includes(CLIENT_INFO));
  });
});

describe("POST /oauth/microsoft/revoke", () => {
  it("answers 204 without calling Microsoft, which has no usable revocation endpoint", async () => {
    const response = await oauthCall("/oauth/microsoft/revoke", { json: { token: "0.microsoft-token" } });
    assert.equal(await readJson(response, 204), null);
    assert.equal(provider.calls.length, 0);
  });

  it("still validates its body", async () => {
    const response = await oauthCall("/oauth/microsoft/revoke", { json: {} });
    await assertError(response, 400, "invalid_request");
  });
});
