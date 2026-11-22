import test from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { withServer } from "./helpers.mjs";
import { mcpFixture } from "./mcp-helpers.mjs";
import { SoftwarePasskey } from "./passkey-helpers.mjs";
import {
  APP_REDIRECT, PUBLIC_HOST, PUBLIC_URL, adminCode, approveWithCode, approveWithPasskey, authorizeRoute, codeOf, connectApp, enrollPasskey, exchange, logCollector, openConsent, pkce, refresh,
  registerApp, setPublic, startAuthorization, web,
} from "./oauth-helpers.mjs";

// The security notes of the OAuth server (S7, phase B, R6), each as a test. The README says the same in words.
//
//  1. Open redirect: the redirect address must be one the app registered, written out exactly; an error about it is a page, never a redirect.
//  2. CSRF on the consent form: every decision carries the token of its page, comes with JSON (a form of another site cannot send that) and, from a browser, an
//     Origin that is the server's own.
//  3. Clickjacking: nothing the server renders can be framed: `frame-ancestors 'none'` and `X-Frame-Options: DENY`, with a CSP that allows no inline script.
//  4. Secrets in logs: codes, verifiers, tokens, the admin code, the challenge of a request and the state never reach the log; the query of /oauth/ is masked.
//  5. Rate limits: registration, every OAuth request, wrong admin codes (the admin login's own count).
//  6. WebAuthn: the relying party is the host the page is served on, so a server reached only on an IP address uses the admin code.
//  7. Cookies: the OAuth server sets none (the consent page keeps what it needs in the page and in the server's memory); a cookie it ever sets must be Secure, HttpOnly, SameSite=Lax.
//  8. Tokens at rest: only hashes of tokens and codes are kept; a token opens one book's MCP endpoint and nothing else.

const sha256 = (value) => createHash("sha256").update(value).digest();
const CSP = "default-src 'none'; script-src 'self'; style-src 'self'; connect-src 'self'; img-src 'self' data:; frame-ancestors 'none'; base-uri 'none'; form-action 'self'";

test("S7B security 1: the redirect always goes to the registered address, with its own query kept, and what the app sent as state cannot change where it goes or split a header", async () => {
  await withServer(async (server, client) => {
    const { slug } = await mcpFixture(server, client);
    await setPublic(server);
    const w = web(server, { host: PUBLIC_HOST });
    const app = await registerApp(w, { redirect_uris: ["https://app.example/cb?tenant=7"] });
    const nasty = "a&redirect_uri=https://evil.example/x&code=stolen#frag\r\nSet-Cookie: x=1";
    const { challenge } = pkce();
    const opened = await openConsent(w, { clientId: app.client_id, redirectUri: "https://app.example/cb?tenant=7", challenge, resource: `${PUBLIC_URL}/mcp/${slug}`, state: nasty });
    assert.equal(opened.status, 200);
    const approved = await approveWithCode(w, opened.page, { code: await adminCode(server) });
    const back = new URL(approved.json.redirect);
    assert.equal(`${back.origin}${back.pathname}`, "https://app.example/cb");
    assert.deepEqual([back.searchParams.get("tenant"), back.searchParams.get("state"), back.searchParams.get("iss")], ["7", nasty, PUBLIC_URL], "the registered query stays, the state comes back as it was sent, and as data");
    assert.equal(back.hash, "");
    assert.equal(back.searchParams.getAll("redirect_uri").length, 0);
    assert.equal(back.searchParams.getAll("code").length, 1, "one code, ours");

    const failing = await w.get(authorizeRoute({ clientId: app.client_id, redirectUri: "https://app.example/cb?tenant=7", challenge: null, resource: `${PUBLIC_URL}/mcp/${slug}`, state: nasty }));
    assert.equal(failing.status, 302);
    assert.equal(/[\r\n]/.test(failing.location), false, "no line break in a header");
    assert.equal(new URL(failing.location).searchParams.get("state"), nasty);
    assert.equal(failing.headers["set-cookie"], undefined);
  });
});

test("S7B security 2: every decision of the consent page needs its page's token, JSON, and an Origin that is the server's own (or none); a form of another site can do none of it", async () => {
  await withServer(async (server, client) => {
    const { slug } = await mcpFixture(server, client);
    await setPublic(server);
    const w = web(server, { host: PUBLIC_HOST });
    const code = await adminCode(server);
    const one = await startAuthorization(w, { slug });
    const two = await startAuthorization(w, { slug });
    const decision = (page, extra = {}) => ({ json: { requestId: page.requestId, scopes: ["read"], proof: { type: "admin-code", code } }, headers: { "x-csrf-token": page.csrf }, ...extra });

    for (const route of ["/oauth/authorize/approve", "/oauth/authorize/deny", "/oauth/authorize/challenge"]) {
      const none = await w.post(route, { json: { requestId: one.page.requestId, scopes: ["read"], proof: { type: "admin-code", code } } });
      assert.deepEqual([none.status, none.json.code], [403, "csrf"], `${route} without the token`);
      const wrong = await w.post(route, { json: { requestId: one.page.requestId, scopes: ["read"] }, headers: { "x-csrf-token": "x".repeat(43) } });
      assert.deepEqual([wrong.status, wrong.json.code], [403, "csrf"], `${route} with a wrong token`);
      const other = await w.post(route, { json: { requestId: one.page.requestId, scopes: ["read"] }, headers: { "x-csrf-token": two.page.csrf } });
      assert.deepEqual([other.status, other.json.code], [403, "csrf"], `${route} with the token of another page`);
    }
    const body = new URLSearchParams({ requestId: one.page.requestId, code }).toString();
    const form = await w.post("/oauth/authorize/approve", { body, headers: { "content-type": "application/x-www-form-urlencoded", "x-csrf-token": one.page.csrf } });
    assert.equal(form.status, 415, "a form is what another site can send, so a form is not accepted");
    const plain = await w.post("/oauth/authorize/approve", { body: JSON.stringify(decision(one.page).json), headers: { "content-type": "text/plain", "x-csrf-token": one.page.csrf } });
    assert.equal(plain.status, 415, "nor is text/plain, which a form can send as JSON-looking text");
    for (const route of ["/oauth/authorize/approve", "/oauth/authorize/deny", "/oauth/authorize/challenge"]) assert.equal((await w.get(route)).status, 405, `${route} by GET`);

    for (const origin of ["https://evil.example", "null", "http://api.example.test", `${PUBLIC_URL}.evil.example`, `https://evil.example/${PUBLIC_HOST}`]) {
      const answer = await w.post("/oauth/authorize/approve", decision(one.page, { origin }));
      assert.equal(answer.status, 403, `from ${origin}`);
    }
    assert.equal((await approveWithCode(w, one.page, { code, origin: PUBLIC_URL })).status, 200, "the server's own origin");
    assert.equal((await approveWithCode(w, two.page, { code, origin: false })).status, 200, "no Origin at all (a command line, a test): the token is what protects");

    const local = web(server);
    const third = await startAuthorization(local, { slug });
    const crossHost = await local.post("/oauth/authorize/approve", decision(third.page, { origin: PUBLIC_URL }));
    assert.equal(crossHost.status, 403, "the public origin is not the origin of a page served on this computer's address");
  });
});

test("S7B security 3: nothing the server renders can be framed, and nothing it renders runs inline code", async () => {
  await withServer(async (server, client) => {
    const { slug } = await mcpFixture(server, client);
    await setPublic(server);
    const w = web(server, { host: PUBLIC_HOST });
    const started = await startAuthorization(w, { slug });
    const responses = [
      ["consent page", { headers: started.headers, text: started.html }],
      ["error page", await w.get("/oauth/authorize?client_id=nobody")],
      ["registration page", await w.get("/oauth/passkeys/add")],
      ["script", await w.get("/oauth/assets/page.js")],
      ["style", await w.get("/oauth/assets/page.css")],
      ["not found", await w.get("/oauth/assets/nothing.js")],
    ];
    for (const [name, answer] of responses) {
      assert.equal(answer.headers["x-frame-options"], "DENY", name);
      assert.ok(answer.headers["content-security-policy"].includes("frame-ancestors 'none'"), name);
      assert.equal(answer.headers["cache-control"], "no-store", name);
      assert.equal(answer.headers["x-content-type-options"], "nosniff", name);
      assert.equal(answer.headers["referrer-policy"], "no-referrer", name);
    }
    for (const [name, answer] of responses.slice(0, 3)) {
      assert.equal(answer.headers["content-security-policy"], CSP, name);
      assert.equal(/<script(?![^>]*\bsrc=)/i.test(answer.text), false, `${name}: no inline script`);
      assert.equal(/<style/i.test(answer.text), false, `${name}: no inline style`);
      assert.equal(/\sstyle=/i.test(answer.text), false, `${name}: no style attribute`);
      assert.equal(/\son[a-z]+\s*=/i.test(answer.text), false, `${name}: no event handler attribute`);
      assert.equal(/javascript:/i.test(answer.text), false, name);
    }
    const script = responses[3][1].text;
    for (const forbidden of ["eval(", "new Function", "innerHTML", "outerHTML", "document.write", "insertAdjacentHTML", "setTimeout(\"", "localStorage", "document.cookie"]) {
      assert.equal(script.includes(forbidden), false, `the script never uses ${forbidden}`);
    }
  });
});

test("S7B security 4: codes, verifiers, tokens, the admin code, the state and the secrets of a request never reach the log, and the query of the OAuth addresses is masked", async () => {
  const logs = logCollector();
  await withServer(async (server, client) => {
    const { slug } = await mcpFixture(server, client);
    await setPublic(server);
    const w = web(server, { host: PUBLIC_HOST });
    const passkey = new SoftwarePasskey();
    await enrollPasskey(server, passkey, { slug });
    const secrets = [await adminCode(server)];

    const state = "state-that-must-not-be-logged";
    const started = await startAuthorization(w, { slug, state });
    secrets.push(started.page.requestId, started.page.csrf, started.verifier, started.challenge, state);
    const approved = await approveWithCode(w, started.page, { code: secrets[0] });
    const authorization = codeOf(approved.json.redirect);
    secrets.push(authorization, approved.json.passkeyOffer.ticket);
    const tokens = (await exchange(w, { code: authorization, verifier: started.verifier, clientId: started.app.client_id, redirectUri: started.redirectUri, resource: started.resource })).json;
    secrets.push(tokens.access_token, tokens.refresh_token);
    const refreshed = (await refresh(w, { refreshToken: tokens.refresh_token, clientId: started.app.client_id })).json;
    secrets.push(refreshed.access_token, refreshed.refresh_token);
    await refresh(w, { refreshToken: tokens.refresh_token, clientId: started.app.client_id });
    await w.get(`/oauth/authorize?client_id=${started.app.client_id}&secret=${"s".repeat(40)}&code=${authorization}`);
    await w.post("/oauth/token", { form: { grant_type: "authorization_code", code: authorization, code_verifier: started.verifier } });
    await w.post("/oauth/revoke", { form: { token: refreshed.refresh_token, client_id: started.app.client_id } });
    await connectApp(server, { slug, w, passkey });
    await fetch(`${server.url}/mcp/${slug}?access_token=${tokens.access_token}`, { method: "POST", body: "{}" });
    secrets.push("s".repeat(40));

    const text = logs.text();
    assert.ok(logs.lines.some((line) => /\/oauth\/token/.test(line)), "the requests are logged");
    for (const secret of secrets) assert.equal(text.includes(secret), false, `a secret of ${secret.length} characters is in the log`);
    const authorizeLines = logs.lines.filter((line) => line.includes("/oauth/authorize?"));
    assert.ok(authorizeLines.length > 0);
    assert.ok(authorizeLines.every((line) => line.includes("/oauth/authorize?***")), authorizeLines[0]);
    assert.equal(logs.lines.some((line) => /client_id=|code_challenge|redirect_uri=/.test(line)), false, "not even the parts of the query that are not secret");
  }, { log: logs.log });
});

test("S7B security 5: a wrong, empty or malformed proof is refused alike, and the answer never says more than that the admin code was wrong", async () => {
  await withServer(async (server, client) => {
    const { slug } = await mcpFixture(server, client);
    const w = web(server);
    const { page } = await startAuthorization(w, { slug });
    const wrong = await approveWithCode(w, page, { code: "wrong" });
    const missing = await approveWithCode(w, page, { code: "" });
    assert.deepEqual([wrong.status, wrong.json.code, wrong.json.message], [401, "admin_login", "Wrong admin code."]);
    assert.deepEqual([missing.status, missing.json.code], [401, "admin_login"], "an empty code is a wrong code, counted as one");
    const notText = await w.post("/oauth/authorize/approve", { json: { requestId: page.requestId, scopes: ["read"], proof: { type: "admin-code", code: 5 } }, headers: { "x-csrf-token": page.csrf } });
    assert.equal(notText.status, 401);
    const noProof = await w.post("/oauth/authorize/approve", { json: { requestId: page.requestId, scopes: ["read"] }, headers: { "x-csrf-token": page.csrf } });
    assert.equal(noProof.status, 400);
    const unknownKind = await w.post("/oauth/authorize/approve", { json: { requestId: page.requestId, scopes: ["read"], proof: { type: "magic" } }, headers: { "x-csrf-token": page.csrf } });
    assert.equal(unknownKind.status, 400);
  });
});

test("S7B security 6: a passkey is bound to the host it was made for: when the public address changes it cannot be used, and the owner is left with the admin code", async () => {
  await withServer(async (server, client) => {
    const { slug } = await mcpFixture(server, client);
    await setPublic(server);
    const passkey = new SoftwarePasskey();
    await enrollPasskey(server, passkey, { slug });
    const connected = await connectApp(server, { slug, w: web(server, { host: PUBLIC_HOST }), passkey });
    assert.equal(connected.tokens.token_type, "Bearer");

    await server.data.updateConfig((config) => {
      config.publicUrl = "https://other.example.test";
    });
    const moved = web(server, { host: "other.example.test" });
    const started = await startAuthorization(moved, { slug });
    assert.deepEqual(started.page.passkeys, { available: false, canRegister: true, reason: "none" }, "the passkey of the old host is not offered on the new one");
    const challenged = await moved.post("/oauth/authorize/challenge", { json: { requestId: started.page.requestId, scopes: ["read"] }, headers: { "x-csrf-token": started.page.csrf } });
    assert.deepEqual([challenged.status, challenged.json.code], [409, "passkey_unavailable"]);
    const code = await approveWithCode(moved, started.page, { code: await adminCode(server) });
    assert.equal(code.status, 200, "the admin code is the way in, and it offers a passkey for the new host");
    assert.equal(typeof code.json.passkeyOffer.ticket, "string");

    const stale = web(server, { host: PUBLIC_HOST });
    assert.equal((await stale.get("/.well-known/oauth-authorization-server")).status, 421, "the old host is not this server's name any more");
  });
});

test("S7B security 7: the OAuth server sets no cookie, on any of its pages or endpoints", async () => {
  await withServer(async (server, client) => {
    const { slug } = await mcpFixture(server, client);
    await setPublic(server);
    const record = [];
    const w = web(server, { host: PUBLIC_HOST, record });
    const passkey = new SoftwarePasskey();
    await enrollPasskey(server, passkey, { slug });
    const connected = await connectApp(server, { slug, w, passkey });
    await refresh(w, { refreshToken: connected.tokens.refresh_token, clientId: connected.app.client_id });
    await w.get("/oauth/passkeys/add");
    await w.get("/oauth/assets/page.js");
    await w.get("/.well-known/oauth-authorization-server");
    await w.post("/oauth/revoke", { form: { token: connected.tokens.refresh_token, client_id: connected.app.client_id } });
    assert.ok(record.length >= 10);
    for (const answer of record) {
      assert.equal(answer.headers["set-cookie"], undefined, `${answer.method} ${answer.route.split("?")[0]}`);
      assert.equal(answer.headers["access-control-allow-origin"], undefined, "and no CORS for a page: the only origin that may call the consent endpoints is the server's own");
    }
  });
});

test("S7B security 8: only hashes of tokens and codes are kept, the file is private, and a token opens one book's endpoint and nothing else", async () => {
  await withServer(async (server, client) => {
    const { slug } = await mcpFixture(server, client);
    await setPublic(server);
    const passkey = new SoftwarePasskey();
    await enrollPasskey(server, passkey, { slug });
    const w = web(server, { host: PUBLIC_HOST });
    const started = await startAuthorization(w, { slug });
    const approved = await approveWithPasskey(w, started.page, { passkey, scopes: ["read", "write"] });
    const authorization = codeOf(approved.json.redirect);
    const tokens = (await exchange(w, { code: authorization, verifier: started.verifier, clientId: started.app.client_id, redirectUri: started.redirectUri, resource: started.resource })).json;

    const text = await readFile(path.join(server.data.root, "private", "oauth.json"), "utf8");
    for (const secret of [tokens.access_token, tokens.refresh_token, authorization, started.verifier, await adminCode(server)]) assert.equal(text.includes(secret), false, "a secret is on disk in the clear");
    for (const token of [tokens.access_token, tokens.refresh_token]) {
      const digest = sha256(token);
      assert.ok(text.includes(digest.toString("hex")) || text.includes(digest.toString("base64url")), "what is kept is the hash of a token");
    }
    assert.equal(JSON.parse(text).version, 1);
    for (const route of ["/api/v1/books", "/api/v1/session"]) {
      const answer = await fetch(`${server.url}${route}`, { headers: { authorization: `Bearer ${tokens.access_token}` } });
      assert.equal(answer.status, 401, route);
    }
    const admin = await fetch(`${server.adminUrl}/admin/api/status`, { headers: { authorization: `Bearer ${tokens.access_token}` } });
    assert.equal(admin.status, 401, "and the admin panel does not know it either");
  });
});

test("S7B security 9: the OAuth addresses refuse the wrong methods with an Allow header, and an unknown path under them is a 404 (not a request for a token)", async () => {
  await withServer(async (server) => {
    const w = web(server);
    for (const [method, route] of [["PUT", "/oauth/token"], ["DELETE", "/oauth/register"], ["PUT", "/oauth/revoke"], ["POST", "/oauth/authorize"], ["POST", "/oauth/assets/page.js"], ["PUT", "/oauth/authorize/approve"]]) {
      const answer = await w.send(method, route, { json: {}, origin: false });
      assert.equal(answer.status, 405, `${method} ${route}`);
      assert.ok(answer.headers.allow, `${method} ${route} says which methods it takes`);
    }
    for (const route of ["/oauth", "/oauth/", "/oauth/unknown", "/oauth/authorize/other", "/oauth/assets/", "/oauth/assets/page.txt"]) {
      assert.equal((await w.get(route)).status, 404, route);
    }
    const unknownRequest = await w.post("/oauth/authorize/approve", { json: { requestId: "nope", scopes: ["read"] }, headers: { "x-csrf-token": "x" } });
    assert.ok([403, 404].includes(unknownRequest.status), "a request that is not there: no way to tell it from one that was used");
  });
});
