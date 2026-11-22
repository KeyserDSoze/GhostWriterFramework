import test from "node:test";
import assert from "node:assert/strict";
import { rawApi } from "./api-helpers.mjs";
import { withServer } from "./helpers.mjs";
import { READ_TOOLS, RUN_TOOLS, TITLE, WRITE_TOOLS, enableMcp, lastCommit, mcpBook, mcpClient, mcpFixture, mcpRoute } from "./mcp-helpers.mjs";
import { SoftwarePasskey } from "./passkey-helpers.mjs";
import {
  APP_REDIRECT, DAY, HOUR, LOCAL_REDIRECT, MINUTE, PUBLIC_HOST, PUBLIC_URL, adminCode, approveWithCode, approveWithPasskey, challengeParams, codeOf, connectApp, enrollPasskey,
  exchange, makeClock, openConsent, pkce, refresh, registerApp, setPublic, startAuthorization, token, web,
} from "./oauth-helpers.mjs";

// The authorization code flow of the book's OAuth server (S7, phase B, R3 and R4), end to end with a fake app: what an app does and what the owner does, in order.

const PING = { jsonrpc: "2.0", id: 1, method: "ping" };

test("S7B: the whole flow with a passkey: discovery, registration, consent, token, a call of a tool, refresh with rotation, reuse detection, revoke", async () => {
  const clock = makeClock();
  await withServer(async (server, client) => {
    const { slug } = await mcpFixture(server, client);
    await setPublic(server);
    const passkey = new SoftwarePasskey();
    await enrollPasskey(server, passkey, { slug });
    const w = web(server, { host: PUBLIC_HOST });

    // Discovery: what an app finds out by itself after a refusal.
    const refused = await w.post(`/mcp/${slug}`, { json: PING, origin: false });
    assert.equal(refused.status, 401);
    const resource = (await w.get(new URL(challengeParams(refused.headers["www-authenticate"]).resource_metadata).pathname)).json;
    assert.equal(resource.resource, `${PUBLIC_URL}/mcp/${slug}`);
    const metadata = (await w.get("/.well-known/oauth-authorization-server")).json;
    assert.equal(metadata.issuer, resource.authorization_servers[0]);

    // Registration, at the address the metadata gave.
    const registered = await w.post(new URL(metadata.registration_endpoint).pathname, { json: { client_name: "Claude", redirect_uris: [APP_REDIRECT], grant_types: ["authorization_code", "refresh_token"], token_endpoint_auth_method: "none" } });
    assert.equal(registered.status, 201);
    const app = registered.json;

    // The owner opens the consent page the app sent him to.
    const { verifier, challenge } = pkce();
    const opened = await openConsent(w, { clientId: app.client_id, challenge, resource: resource.resource, scope: "mcp:read mcp:write mcp:run", state: "xyz" });
    assert.equal(opened.status, 200);
    const { page } = opened;
    assert.deepEqual(page.client, { name: "Claude", redirectHost: "claude.example" });
    assert.equal(page.resource, resource.resource);
    assert.deepEqual(page.scopes.map((entry) => [entry.scope, entry.requested, entry.locked, entry.checked]), [["read", true, true, true], ["write", true, false, false], ["run", true, false, false]], "read only until the owner says more");
    assert.equal(page.passkeys.available, true);

    // He proves it is him with the passkey and lets the app change the book (not run its autopilot).
    const approved = await approveWithPasskey(w, page, { passkey, scopes: ["read", "write"] });
    assert.equal(approved.status, 200, approved.text);
    const back = new URL(approved.json.redirect);
    assert.equal(`${back.origin}${back.pathname}`, APP_REDIRECT);
    assert.deepEqual([back.searchParams.get("state"), back.searchParams.get("iss")], ["xyz", PUBLIC_URL]);
    assert.equal("passkeyOffer" in approved.json, false, "with a passkey there is nothing to offer");

    // The app trades the code for tokens.
    const tokens = await exchange(w, { code: codeOf(approved.json.redirect), verifier, clientId: app.client_id, resource: resource.resource });
    assert.equal(tokens.status, 200, tokens.text);
    assert.equal(tokens.headers["cache-control"], "no-store");
    assert.equal(tokens.headers.pragma, "no-cache");
    assert.deepEqual(Object.keys(tokens.json).sort(), ["access_token", "expires_in", "refresh_token", "scope", "token_type"]);
    assert.match(tokens.json.access_token, /^nra_[A-Za-z0-9_-]{43}$/);
    assert.match(tokens.json.refresh_token, /^nrr_[A-Za-z0-9_-]{43}$/);
    assert.deepEqual([tokens.json.token_type, tokens.json.expires_in, tokens.json.scope], ["Bearer", 3600, "mcp:read mcp:write"]);

    // The token opens the book's endpoint, with the permissions the owner chose and no more.
    const rpc = mcpClient(server, slug, tokens.json.access_token);
    assert.deepEqual(await rpc.list(), [...READ_TOOLS, ...WRITE_TOOLS]);
    assert.equal((await rpc.call("book_info")).data.title, TITLE);
    const created = await rpc.call("create_chapter", { title: "The Tide", summary: "The water goes out." });
    assert.equal(created.isError, false, created.text);
    assert.match(lastCommit(server), /^MCP \(Claude\): /, "the author's history says which app wrote");
    const paused = await rpc.call("autopilot_pause");
    assert.equal(paused.isError, true);
    assert.match(paused.text, /^\[scope\]/);
    const audit = await server.mcp.audit.recent(10);
    assert.ok(audit.length >= 3 && audit.every((entry) => entry.client === "Claude" && entry.clientId.startsWith("oauth:")), JSON.stringify(audit[0]));

    // Refresh: a new pair, and the old refresh token is spent.
    clock.advance(30 * MINUTE);
    const refreshed = await refresh(w, { refreshToken: tokens.json.refresh_token, clientId: app.client_id, resource: resource.resource });
    assert.equal(refreshed.status, 200, refreshed.text);
    assert.notEqual(refreshed.json.refresh_token, tokens.json.refresh_token);
    assert.notEqual(refreshed.json.access_token, tokens.json.access_token);
    assert.deepEqual([refreshed.json.scope, refreshed.json.expires_in], ["mcp:read mcp:write", 3600]);
    assert.equal((await mcpClient(server, slug, refreshed.json.access_token).call("book_info")).isError, false);

    // Reuse: the old refresh token is shown again (stolen, or an app that lost track): the whole grant is revoked, the new tokens too.
    const reused = await refresh(w, { refreshToken: tokens.json.refresh_token, clientId: app.client_id });
    assert.equal(reused.status, 400);
    assert.equal(reused.json.error, "invalid_grant");
    assert.equal((await mcpClient(server, slug, refreshed.json.access_token).request("ping")).status, 401, "the access token of the rotation is gone");
    assert.equal((await refresh(w, { refreshToken: refreshed.json.refresh_token, clientId: app.client_id })).json.error, "invalid_grant", "and so is its refresh token");

    // Revoke (RFC 7009): the owner's app says it is done.
    const second = await connectApp(server, { slug, w, passkey, scopes: ["read"] });
    assert.equal((await mcpClient(server, slug, second.tokens.access_token).request("ping")).status, 200);
    const revoked = await w.post("/oauth/revoke", { form: { token: second.tokens.refresh_token, token_type_hint: "refresh_token", client_id: second.app.client_id } });
    assert.equal(revoked.status, 200);
    assert.equal((await mcpClient(server, slug, second.tokens.access_token).request("ping")).status, 401, "the access token ends with its grant");
    assert.equal((await refresh(w, { refreshToken: second.tokens.refresh_token, clientId: second.app.client_id })).json.error, "invalid_grant");
  }, { now: clock.now });
});

test("S7B: on this computer's own address the admin code does it and no passkey is offered; on the public address the admin code offers to register one, and it works the next time", async () => {
  await withServer(async (server, client) => {
    const { slug } = await mcpFixture(server, client);
    const local = web(server);
    const first = await startAuthorization(local, { slug });
    assert.deepEqual(first.page.passkeys, { available: false, canRegister: false, reason: "address" });
    const challenged = await local.post("/oauth/authorize/challenge", { json: { requestId: first.page.requestId, scopes: ["read"] }, headers: { "x-csrf-token": first.page.csrf } });
    assert.equal(challenged.status, 409);
    assert.equal(challenged.json.code, "passkey_unavailable");
    const done = await approveWithCode(local, first.page, { code: await adminCode(server) });
    assert.equal(done.status, 200);
    assert.equal("passkeyOffer" in done.json, false, "a passkey cannot be registered on an address that is not a domain the owner serves");

    await setPublic(server);
    const w = web(server, { host: PUBLIC_HOST });
    const before = await startAuthorization(w, { slug });
    assert.deepEqual(before.page.passkeys, { available: false, canRegister: true, reason: "none" }, "no passkey yet: only the code");
    const approved = await approveWithCode(w, before.page, { code: await adminCode(server) });
    assert.equal(approved.status, 200, approved.text);
    const { ticket } = approved.json.passkeyOffer;
    assert.equal(typeof ticket, "string");

    const options = await w.post("/oauth/passkeys/options", { json: { ticket } });
    assert.equal(options.status, 200, options.text);
    const key = options.json.publicKey;
    assert.deepEqual([key.rp.id, key.attestation, key.authenticatorSelection.userVerification, key.authenticatorSelection.residentKey], [PUBLIC_HOST, "none", "required", "preferred"]);
    assert.deepEqual(key.pubKeyCredParams.map((entry) => entry.alg), [-7, -8, -257], "ES256, EdDSA, RS256");
    assert.ok(key.pubKeyCredParams.every((entry) => entry.type === "public-key"));
    assert.deepEqual(key.excludeCredentials, []);
    assert.match(key.challenge, /^[A-Za-z0-9_-]{43}$/);
    assert.ok(key.timeout > 0 && key.timeout <= 300_000);
    const again = (await w.post("/oauth/passkeys/options", { json: { ticket } })).json.publicKey;
    assert.equal(again.user.id, key.user.id, "one owner: the same user handle every time");
    assert.notEqual(again.challenge, key.challenge, "a new challenge every time");

    const passkey = new SoftwarePasskey();
    const registered = await w.post("/oauth/passkeys/register", { json: { ticket, label: "  My phone  ", credential: passkey.create({ challenge: again.challenge, origin: PUBLIC_URL, rpId: PUBLIC_HOST }) } });
    assert.equal(registered.status, 200, registered.text);
    assert.deepEqual([registered.json.id, registered.json.label], [passkey.id, "My phone"]);
    const reused = await w.post("/oauth/passkeys/register", { json: { ticket, label: "Again", credential: passkey.create({ challenge: again.challenge, origin: PUBLIC_URL, rpId: PUBLIC_HOST }) } });
    assert.deepEqual([reused.status, reused.json.code], [404, "ticket_invalid"], "a ticket is used once");
    assert.deepEqual((await w.post("/oauth/passkeys/options", { json: { ticket } })).status, 404, "also to ask for options");

    const next = await startAuthorization(w, { slug });
    assert.deepEqual(next.page.passkeys, { available: true, canRegister: true });
    const signed = await approveWithPasskey(w, next.page, { passkey, scopes: ["read"] });
    assert.equal(signed.status, 200, signed.text);
    assert.equal("passkeyOffer" in signed.json, false);
  });
});

test("S7B: the admin code on the consent page has the admin login's limits: ten wrong ones lock a source for the right code too, and the panel's login spends the same count", async () => {
  await withServer(async (server, client) => {
    const { slug } = await mcpFixture(server, client);
    await setPublic(server);
    const w = web(server, { host: PUBLIC_HOST });
    const { page } = await startAuthorization(w, { slug });
    const code = await adminCode(server);
    for (let index = 0; index < 10; index += 1) {
      const wrong = await approveWithCode(w, page, { code: `not-the-code-${index}` });
      assert.equal(wrong.status, 401, `attempt ${index + 1}`);
      assert.equal(wrong.json.code, "admin_login");
      assert.equal(wrong.text.includes(code), false);
    }
    const locked = await approveWithCode(w, page, { code });
    assert.equal(locked.status, 429, "the right code is refused as well: the count cannot be used to guess");
    assert.equal(locked.json.code, "too_many_attempts");
    assert.ok(Number(locked.headers["retry-after"]) >= 1);
    const login = await fetch(`${server.adminUrl}/admin/api/login`, { method: "POST", headers: { origin: server.adminUrl, "content-type": "application/json" }, body: JSON.stringify({ code }) });
    assert.equal(login.status, 429, "the admin panel's login is the same budget");

    const other = await approveWithCode(w, page, { code, headers: { "cf-connecting-ip": "203.0.113.9" } });
    assert.equal(other.status, 200, "another source has its own: the request waited for the owner");
  });
});

test("S7B: a right admin code clears the count of wrong ones, and a wrong one leaves the request open for another try", async () => {
  await withServer(async (server, client) => {
    const { slug } = await mcpFixture(server, client);
    const w = web(server);
    const code = await adminCode(server);
    const first = await startAuthorization(w, { slug });
    for (let index = 0; index < 9; index += 1) assert.equal((await approveWithCode(w, first.page, { code: `wrong-${index}` })).status, 401);
    assert.equal((await approveWithCode(w, first.page, { code })).status, 200, "the ninth wrong one did not lock it, and the request was still there");
    const second = await startAuthorization(w, { slug });
    for (let index = 0; index < 9; index += 1) assert.equal((await approveWithCode(w, second.page, { code: `wrong-${index}` })).status, 401, "the success started the count again");
    assert.equal((await approveWithCode(w, second.page, { code })).status, 200);
  });
});

test("S7B: a consent request is used once: approving or denying ends it, and denying sends the app back with access_denied and its state", async () => {
  await withServer(async (server, client) => {
    const { slug } = await mcpFixture(server, client);
    const w = web(server);
    const code = await adminCode(server);
    const approving = await startAuthorization(w, { slug, state: "keep-me" });
    assert.equal((await approveWithCode(w, approving.page, { code })).status, 200);
    const twice = await approveWithCode(w, approving.page, { code });
    assert.equal(twice.status, 404, "a request that was answered is gone");
    assert.equal(twice.json.code, "request_expired");

    const denying = await startAuthorization(w, { slug, state: "keep-me" });
    const denied = await w.post("/oauth/authorize/deny", { json: { requestId: denying.page.requestId }, headers: { "x-csrf-token": denying.page.csrf } });
    assert.equal(denied.status, 200);
    const back = new URL(denied.json.redirect);
    assert.equal(`${back.origin}${back.pathname}`, LOCAL_REDIRECT);
    assert.deepEqual([back.searchParams.get("error"), back.searchParams.get("state"), back.searchParams.has("code")], ["access_denied", "keep-me", false]);
    assert.equal((await approveWithCode(w, denying.page, { code })).status, 404, "after a refusal there is nothing to approve");
  });
});

test("S7B: a request that waits more than ten minutes is gone, and the owner is told to start again from the app", async () => {
  const clock = makeClock();
  await withServer(async (server, client) => {
    const { slug } = await mcpFixture(server, client);
    const w = web(server);
    const { page } = await startAuthorization(w, { slug });
    clock.advance(11 * MINUTE);
    const late = await approveWithCode(w, page, { code: await adminCode(server) });
    assert.equal(late.status, 404);
    assert.equal(late.json.code, "request_expired");
    assert.match(late.json.message, /app/i);
  }, { now: clock.now });
});

test("S7B: a code is for one use and for 60 seconds: using it twice revokes what the first use gave, and a late one gives nothing", async () => {
  const clock = makeClock();
  await withServer(async (server, client) => {
    const { slug } = await mcpFixture(server, client);
    const w = web(server);
    const code = await adminCode(server);

    const replayed = await startAuthorization(w, { slug });
    const done = await approveWithCode(w, replayed.page, { code });
    const authorization = codeOf(done.json.redirect);
    const form = { code: authorization, verifier: replayed.verifier, clientId: replayed.app.client_id, redirectUri: replayed.redirectUri, resource: replayed.resource };
    const tokens = await exchange(w, form);
    assert.equal(tokens.status, 200);
    assert.equal((await mcpClient(server, slug, tokens.json.access_token).request("ping")).status, 200);
    const again = await exchange(w, form);
    assert.equal(again.status, 400);
    assert.equal(again.json.error, "invalid_grant");
    assert.equal((await mcpClient(server, slug, tokens.json.access_token).request("ping")).status, 401, "RFC 6749 §4.1.2: what a code gave is revoked when it is used again");

    const late = await startAuthorization(w, { slug });
    const lateCode = codeOf((await approveWithCode(w, late.page, { code })).json.redirect);
    clock.advance(61_000);
    const expired = await exchange(w, { code: lateCode, verifier: late.verifier, clientId: late.app.client_id, redirectUri: late.redirectUri, resource: late.resource });
    assert.equal(expired.json.error, "invalid_grant");
    const fresh = await startAuthorization(w, { slug });
    const freshCode = codeOf((await approveWithCode(w, fresh.page, { code })).json.redirect);
    clock.advance(59_000);
    assert.equal((await exchange(w, { code: freshCode, verifier: fresh.verifier, clientId: fresh.app.client_id, redirectUri: fresh.redirectUri, resource: fresh.resource })).status, 200, "59 seconds is in time");
  }, { now: clock.now });
});

test("S7B: the scopes of an app map to the permissions of the endpoint: what it asks is the most it gets, the owner can only lower it, and read is always in", async () => {
  await withServer(async (server, client) => {
    const { slug } = await mcpFixture(server, client);
    const w = web(server);
    const code = await adminCode(server);
    const run = async (scope, scopes) => {
      const started = await startAuthorization(w, { slug, scope });
      const approved = await approveWithCode(w, started.page, { code, scopes });
      if (approved.status !== 200) return { approved };
      const tokens = await exchange(w, { code: codeOf(approved.json.redirect), verifier: started.verifier, clientId: started.app.client_id, redirectUri: started.redirectUri, resource: started.resource });
      return { approved, started, tokens: tokens.json, tools: await mcpClient(server, slug, tokens.json.access_token).list() };
    };

    const readOnly = await run("mcp:read", ["read"]);
    assert.equal(readOnly.tokens.scope, "mcp:read");
    assert.deepEqual(readOnly.tools, READ_TOOLS);

    const everything = await run(undefined, ["read", "write", "run"]);
    assert.equal(everything.tokens.scope, "mcp:read mcp:write mcp:run");
    assert.deepEqual(everything.tools, [...READ_TOOLS, ...WRITE_TOOLS, ...RUN_TOOLS]);
    assert.deepEqual(everything.started.page.scopes.map((entry) => entry.scope), ["read", "write", "run"], "an app that names no scope may ask for them all, and the page offers them all");
    assert.deepEqual(everything.started.page.scopes.map((entry) => entry.checked), [true, false, false], "read only by default");

    const lowered = await run("mcp:read mcp:write mcp:run", ["read", "run"]);
    assert.equal(lowered.tokens.scope, "mcp:read mcp:run");
    assert.deepEqual(lowered.tools, [...READ_TOOLS, ...RUN_TOOLS]);

    const writeOnly = await run("mcp:write", ["write"]);
    assert.equal(writeOnly.started.page.scopes.find((entry) => entry.scope === "read").requested, false, "read was not asked for...");
    assert.equal(writeOnly.started.page.scopes.find((entry) => entry.scope === "read").checked, true, "...but a permission to change a book that cannot be read means nothing");
    assert.equal(writeOnly.tokens.scope, "mcp:read mcp:write");
    assert.equal(writeOnly.started.page.scopes.some((entry) => entry.scope === "run"), false, "a permission nobody asked for has no toggle");

    const none = await run("mcp:read", []);
    assert.equal(none.tokens.scope, "mcp:read", "no choice is the least: read");

    const more = await run("mcp:read", ["read", "write"]);
    assert.equal(more.approved.status, 400, "the page can only lower what was asked; a request that raises it is not from the page");
    assert.equal(more.approved.json.code, "scope");
    const unknown = await run("mcp:read", ["read", "admin"]);
    assert.equal(unknown.approved.status, 400);
  });
});

test("S7B: an app registered for the code flow only gets no refresh token and cannot refresh", async () => {
  await withServer(async (server, client) => {
    const { slug } = await mcpFixture(server, client);
    const w = web(server);
    const app = await registerApp(w, { client_name: "One shot", redirect_uris: [LOCAL_REDIRECT], grant_types: ["authorization_code"] });
    const { verifier, challenge } = pkce();
    const resource = `${server.url}/mcp/${slug}`;
    const { page } = await openConsent(w, { clientId: app.client_id, redirectUri: LOCAL_REDIRECT, challenge, resource });
    const approved = await approveWithCode(w, page, { code: await adminCode(server) });
    const tokens = await exchange(w, { code: codeOf(approved.json.redirect), verifier, clientId: app.client_id, redirectUri: LOCAL_REDIRECT, resource });
    assert.equal(tokens.status, 200);
    assert.equal("refresh_token" in tokens.json, false);
    const denied = await refresh(w, { refreshToken: "nrr_nothing-like-it", clientId: app.client_id });
    assert.equal(denied.status, 400);
    assert.equal(denied.json.error, "unauthorized_client");
  });
});

test("S7B: an access token lives an hour and a refresh token 60 days from its last use; a refresh that is used in time keeps the grant alive", async () => {
  const clock = makeClock();
  await withServer(async (server, client) => {
    const { slug } = await mcpFixture(server, client);
    const w = web(server);
    const connected = await connectApp(server, { slug, w });
    const ask = (access) => mcpClient(server, slug, access).post(PING);
    clock.advance(59 * MINUTE);
    assert.equal((await ask(connected.tokens.access_token)).status, 200, "59 minutes in");
    clock.advance(2 * MINUTE);
    const expired = await ask(connected.tokens.access_token);
    assert.equal(expired.status, 401, "an hour and a minute in");
    assert.equal(challengeParams(expired.headers.get("www-authenticate")).error, "invalid_token");
    assert.match(challengeParams(expired.headers.get("www-authenticate")).resource_metadata, /\/\.well-known\/oauth-protected-resource\/mcp\//);

    const first = await refresh(w, { refreshToken: connected.tokens.refresh_token, clientId: connected.app.client_id, resource: connected.resource });
    assert.equal(first.status, 200);
    assert.equal((await ask(first.json.access_token)).status, 200);
    clock.advance(50 * DAY);
    const second = await refresh(w, { refreshToken: first.json.refresh_token, clientId: connected.app.client_id });
    assert.equal(second.status, 200, "50 days after the last use: still good, and the 60 days start again");
    clock.advance(59 * DAY);
    const third = await refresh(w, { refreshToken: second.json.refresh_token, clientId: connected.app.client_id });
    assert.equal(third.status, 200, "59 days after the last use");
    clock.advance(61 * DAY);
    const dead = await refresh(w, { refreshToken: third.json.refresh_token, clientId: connected.app.client_id });
    assert.equal(dead.status, 400);
    assert.equal(dead.json.error, "invalid_grant", "61 days of silence ends it");
  }, { now: clock.now });
});

test("S7B: a refresh may ask for less than was granted, never for more, and for the same book only", async () => {
  await withServer(async (server, client) => {
    const { slug } = await mcpFixture(server, client);
    const w = web(server);
    const connected = await connectApp(server, { slug, w, scopes: ["read", "write"] });
    const narrower = await refresh(w, { refreshToken: connected.tokens.refresh_token, clientId: connected.app.client_id, scope: "mcp:read" });
    assert.equal(narrower.status, 200, narrower.text);
    assert.equal(narrower.json.scope, "mcp:read");
    assert.deepEqual(await mcpClient(server, slug, narrower.json.access_token).list(), READ_TOOLS, "this access token reads only");
    const wider = await refresh(w, { refreshToken: narrower.json.refresh_token, clientId: connected.app.client_id, scope: "mcp:read mcp:run" });
    assert.equal(wider.status, 400);
    assert.equal(wider.json.error, "invalid_scope", "a scope the owner did not grant");
    const full = await refresh(w, { refreshToken: narrower.json.refresh_token, clientId: connected.app.client_id });
    assert.equal(full.json.scope, "mcp:read mcp:write", "asking for nothing in particular gives what was granted: the narrower one was only for that token");
    const other = await refresh(w, { refreshToken: full.json.refresh_token, clientId: connected.app.client_id, resource: `${server.url}/mcp/another-book` });
    assert.equal(other.json.error, "invalid_target");
  });
});

test("S7B: a token is for one book: another book's address does not know it, the REST API does not accept it, and an OAuth token is not a client token", async () => {
  await withServer(async (server, client) => {
    const { slug } = await mcpFixture(server, client);
    await mcpBook(client, "moon", "Moon Book");
    const moon = await enableMcp(server, "moon");
    const connected = await connectApp(server, { slug, scopes: ["read", "write", "run"] });
    const access = connected.tokens.access_token;

    assert.equal((await mcpClient(server, slug, access).request("ping")).status, 200);
    const elsewhere = await mcpClient(server, moon.slug, access).request("ping");
    assert.equal(elsewhere.status, 404, "the address of a book it is not for: the same 404 as an address that is not there");
    assert.equal((await mcpClient(server, "no-such-book", access).request("ping")).status, 404);
    for (const route of ["/api/v1/books", "/api/v1/session", `/api/v1/books/glass/mcp`, "/api/v1/ai"]) {
      const answer = await fetch(`${server.url}${route}`, { headers: { authorization: `Bearer ${access}` } });
      assert.equal(answer.status, 401, `${route}: an OAuth token opens one book's MCP endpoint and nothing else`);
    }
    const api = await rawApi(server);
    assert.equal((await api("GET", `/api/v1/books/glass/mcp/clients`)).json.clients.length, 1);
    assert.equal((await api("GET", `/api/v1/books/moon/mcp/clients`)).json.clients.length, 0, "and it is a connection of the first book only");
  });
});

test("S7B: switching a book's MCP off, giving it another slug, or deleting it ends its tokens at once, and they do not come back when it is switched on again", async () => {
  await withServer(async (server, client) => {
    const { slug } = await mcpFixture(server, client);
    const route = await mcpRoute(server);
    const w = web(server);

    const off = await connectApp(server, { slug, w });
    assert.equal((await mcpClient(server, slug, off.tokens.access_token).request("ping")).status, 200);
    assert.equal((await route.put({ enabled: false })).status, 200);
    const refused = await mcpClient(server, slug, off.tokens.access_token).post(PING);
    assert.equal(refused.status, 401, "at once: the very next request");
    assert.equal(challengeParams(refused.headers.get("www-authenticate")).error, "invalid_token");
    assert.equal((await refresh(w, { refreshToken: off.tokens.refresh_token, clientId: off.app.client_id })).json.error, "invalid_grant");
    assert.equal((await route.put({ enabled: true })).status, 200);
    assert.equal((await mcpClient(server, slug, off.tokens.access_token).request("ping")).status, 401, "switched on again: the app has to ask the owner again");
    assert.equal((await route.get()).json.connections, 0);

    const renamed = await connectApp(server, { slug, w });
    assert.equal((await route.put({ slug: "new-address" })).status, 200);
    assert.equal((await mcpClient(server, "new-address", renamed.tokens.access_token).request("ping")).status, 401, "the app was sent to the old address: it is another resource now");
    assert.equal((await refresh(w, { refreshToken: renamed.tokens.refresh_token, clientId: renamed.app.client_id })).json.error, "invalid_grant");

    const removed = await connectApp(server, { slug: "new-address", w });
    const api = await rawApi(server);
    assert.equal((await api("DELETE", "/api/v1/books/glass")).status, 200);
    assert.equal((await mcpClient(server, "new-address", removed.tokens.access_token).request("ping")).status, 401);
    await mcpBook(client, "glass", TITLE);
    await route.put({ enabled: true, slug: "new-address" });
    assert.equal((await mcpClient(server, "new-address", removed.tokens.access_token).request("ping")).status, 401, "a book that has the same id and address again is not the one that was allowed");
    assert.equal((await refresh(w, { refreshToken: removed.tokens.refresh_token, clientId: removed.app.client_id })).json.error, "invalid_grant");
  });
});

test("S7B: a client token of phase A keeps working next to the OAuth tokens, and revoking an app leaves every other credential alone", async () => {
  await withServer(async (server, client) => {
    const { slug, token: clientToken } = await mcpFixture(server, client);
    const a = await connectApp(server, { slug, name: "App A" });
    const b = await connectApp(server, { slug, name: "App B" });
    const api = await rawApi(server);
    const listed = (await api("GET", "/api/v1/books/glass/mcp/clients")).json.clients;
    assert.deepEqual(listed.map((entry) => entry.name).sort(), ["App A", "App B"]);
    const grantA = listed.find((entry) => entry.name === "App A");
    const removed = await api("DELETE", `/api/v1/books/glass/mcp/clients/${grantA.id}`);
    assert.equal(removed.status, 200);
    assert.equal((await mcpClient(server, slug, a.tokens.access_token).request("ping")).status, 401);
    assert.equal((await mcpClient(server, slug, b.tokens.access_token).request("ping")).status, 200, "the other app is untouched");
    assert.equal((await mcpClient(server, slug, clientToken).request("ping")).status, 200, "and so is the client token");
  });
});
