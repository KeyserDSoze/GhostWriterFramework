import test from "node:test";
import assert from "node:assert/strict";
import { withServer } from "./helpers.mjs";
import { mcpBook, mcpClient, mcpFixture, mcpRoute, enableMcp } from "./mcp-helpers.mjs";
import {
  APP_REDIRECT, LOCAL_REDIRECT, MINUTE, PUBLIC_HOST, PUBLIC_URL, adminCode, approveWithCode, authorizeRoute, codeOf, exchange, makeClock, openConsent, pageState, pkce, refresh, registerApp,
  setPublic, startAuthorization, token, web,
} from "./oauth-helpers.mjs";

// What the authorization endpoint and the token endpoint refuse (S7, phase B, R3 and R4): PKCE, the redirect address, the resource, the scope, the code, the refresh token.
// An error that the app can be told about is sent to its registered address; one that would send the owner to an address he cannot trust is a page, never a redirect.

const errorOf = (answer, label = "") => {
  assert.equal(answer.status, 302, `${label}: ${answer.status} ${answer.text.slice(0, 120)}`);
  const url = new URL(answer.location);
  return { error: url.searchParams.get("error"), description: url.searchParams.get("error_description"), state: url.searchParams.get("state"), iss: url.searchParams.get("iss"), code: url.searchParams.get("code"), url };
};

test("S7B: a request whose app or redirect address cannot be trusted gets an error page and never a redirect", async () => {
  await withServer(async (server, client) => {
    const { slug } = await mcpFixture(server, client);
    const w = web(server);
    const app = await registerApp(w, { redirect_uris: [LOCAL_REDIRECT, "https://app.example/cb"] });
    const { challenge } = pkce();
    const resource = `${server.url}/mcp/${slug}`;
    const good = { clientId: app.client_id, redirectUri: LOCAL_REDIRECT, challenge, resource };
    const route = (overrides) => authorizeRoute({ ...good, ...overrides });
    const bad = {
      "no client": route({ clientId: undefined }),
      "unknown client": route({ clientId: "nobody" }),
      "no redirect address": route({ redirectUri: null }),
      "another address": route({ redirectUri: "https://evil.example/cb" }),
      "the registered address with a path added": route({ redirectUri: `${LOCAL_REDIRECT}/more` }),
      "the registered address with a query": route({ redirectUri: `${LOCAL_REDIRECT}?x=1` }),
      "the registered address with another port": route({ redirectUri: "http://127.0.0.1:9999/callback" }),
      "the registered address with another case": route({ redirectUri: "HTTP://127.0.0.1:8765/callback" }),
      "the registered address with a trailing slash": route({ redirectUri: "https://app.example/cb/" }),
      "a prefix of it": route({ redirectUri: "https://app.example" }),
      "a lookalike host": route({ redirectUri: "https://app.example.evil.test/cb" }),
      "a userinfo trick": route({ redirectUri: "https://app.example@evil.test/cb" }),
      "a relative address": route({ redirectUri: "/callback" }),
      "the client twice": `${route({})}&client_id=nobody`,
      "the redirect address twice": `${route({})}&redirect_uri=https%3A%2F%2Fevil.example%2Fcb`,
      "the client as an empty text": route({ clientId: "" }),
    };
    for (const [name, address] of Object.entries(bad)) {
      const answer = await w.get(address);
      assert.equal(answer.status, 400, name);
      assert.equal(answer.location, undefined, `${name}: no redirect`);
      assert.match(answer.headers["content-type"], /^text\/html/, name);
      assert.equal(answer.text.includes("evil.example") && /href=["'][^"']*evil\.example/.test(answer.text), false, `${name}: what was sent is not turned into a link`);
      assert.equal(/<script[^>]*>[^<]/.test(answer.text), false, `${name}: no inline script`);
    }
    const ok = await w.get(route({}));
    assert.equal(ok.status, 200, "the same request with the address as registered is a consent page");
    assert.equal((await w.get(route({ redirectUri: "https://app.example/cb" }))).status, 200, "and so is the other address that was registered");
  });
});

test("S7B: what is wrong with the rest of a request is sent to the app at its registered address, with the state and the issuer", async () => {
  await withServer(async (server, client) => {
    const { slug } = await mcpFixture(server, client);
    await setPublic(server);
    const w = web(server, { host: PUBLIC_HOST });
    const app = await registerApp(w);
    const { challenge } = pkce();
    const resource = `${PUBLIC_URL}/mcp/${slug}`;
    const good = { clientId: app.client_id, redirectUri: APP_REDIRECT, challenge, resource, state: "s-1" };
    const cases = [
      ["an implicit request", { responseType: "token" }, "unsupported_response_type"],
      ["no response type", { responseType: null }, "invalid_request"],
      ["no PKCE challenge", { challenge: undefined }, "invalid_request"],
      ["plain PKCE", { method: "plain" }, "invalid_request"],
      ["no PKCE method", { method: null }, "invalid_request"],
      ["an unknown PKCE method", { method: "S512" }, "invalid_request"],
      ["a challenge that is too short", { challenge: "abc" }, "invalid_request"],
      ["a challenge that is not base64url", { challenge: `${"a".repeat(42)}!` }, "invalid_request"],
      ["a challenge that is too long", { challenge: "a".repeat(44) }, "invalid_request"],
      ["a scope the server does not have", { scope: "mcp:read admin" }, "invalid_scope"],
      ["only an unknown scope", { scope: "admin" }, "invalid_scope"],
      ["a resource on another host", { resource: "https://evil.example/mcp/x" }, "invalid_target"],
      ["a resource that is not an MCP address", { resource: `${PUBLIC_URL}/api/v1/books` }, "invalid_target"],
      ["the endpoint without a slug", { resource: `${PUBLIC_URL}/mcp/` }, "invalid_target"],
      ["a resource with a query", { resource: `${resource}?a=1` }, "invalid_target"],
      ["a resource with a fragment", { resource: `${resource}#a` }, "invalid_target"],
      ["a resource with credentials", { resource: `https://u:p@${PUBLIC_HOST}/mcp/${slug}` }, "invalid_target"],
      ["a resource that is not a URL", { resource: "the-glass-harbor" }, "invalid_target"],
      ["a resource on this computer's address, asked on the public one", { resource: `${server.url}/mcp/${slug}` }, "invalid_target"],
      ["a state that is too long", { state: "s".repeat(1100) }, "invalid_request"],
    ];
    for (const [name, overrides, expected] of cases) {
      const answer = await w.get(authorizeRoute({ ...good, ...overrides }));
      const result = errorOf(answer, name);
      assert.equal(result.error, expected, name);
      assert.equal(typeof result.description, "string", name);
      assert.equal(`${result.url.origin}${result.url.pathname}`, APP_REDIRECT, `${name}: to the address that was registered`);
      assert.equal(result.iss, PUBLIC_URL, `${name}: with the issuer (RFC 9207)`);
      assert.equal(result.code, null, `${name}: and no code`);
      if (name !== "a state that is too long") assert.equal(result.state, "s-1", `${name}: with the state it came with`);
    }
    const twice = await w.get(`${authorizeRoute({ ...good, scope: "mcp:read" })}&scope=mcp%3Awrite`);
    assert.equal(errorOf(twice, "scope twice").error, "invalid_request", "a parameter given twice is not guessed at");
    for (const name of ["state", "resource", "code_challenge", "response_type"]) {
      const answer = await w.get(`${authorizeRoute(good)}&${name}=other`);
      assert.equal(errorOf(answer, `${name} twice`).error, "invalid_request", name);
    }
    const noState = errorOf(await w.get(authorizeRoute({ ...good, state: null, method: "plain" })));
    assert.equal(noState.state, null, "no state came, none goes back");
    assert.equal((await w.get(authorizeRoute({ ...good, extra: { nonce: "n", prompt: "consent", login_hint: "me", max_age: "1", ui_locales: "it", code_challenge_extra: "x" } }))).status, 200, "what an OpenID app adds is ignored");
    assert.equal((await w.get(authorizeRoute({ ...good, scope: "" }))).status, 200, "an empty scope is no scope: the app asks for what the server offers");
    const habitual = await w.get(authorizeRoute({ ...good, scope: "openid profile offline_access mcp:read" }));
    assert.equal(habitual.status, 200, "the scopes that apps ask for out of habit are left out, not refused");
    assert.deepEqual(pageState(habitual.text).scopes.map((entry) => entry.scope), ["read"]);
    const onlyHabitual = await w.get(authorizeRoute({ ...good, scope: "offline_access" }));
    assert.deepEqual(pageState(onlyHabitual.text).scopes.map((entry) => entry.scope), ["read", "write", "run"], "and an app that asks for nothing else is offered what the server has");
    assert.equal((await w.post("/oauth/authorize", { form: {} })).status, 405);
  });
});

test("S7B: the address of the resource is looked at again when the owner has proved who he is, not before: nobody who only opens the page learns which books are on", async () => {
  await withServer(async (server, client) => {
    const { slug } = await mcpFixture(server, client);
    await mcpBook(client, "moon", "Moon Book");
    const moon = await enableMcp(server, "moon");
    await (await mcpRoute(server, "moon")).put({ enabled: false });
    const w = web(server);
    const code = await adminCode(server);

    const known = await startAuthorization(w, { slug });
    const unknown = await startAuthorization(w, { resource: `${server.url}/mcp/no-such-book` });
    const off = await startAuthorization(w, { resource: `${server.url}/mcp/${moon.slug}` });
    assert.deepEqual([known.page.resource, unknown.page.resource, off.page.resource], [`${server.url}/mcp/${slug}`, `${server.url}/mcp/no-such-book`, `${server.url}/mcp/${moon.slug}`], "the page shows the address as the app gave it");
    const shape = (page) => JSON.stringify({ ...page, requestId: 0, csrf: 0, resource: 0 });
    assert.equal(shape(unknown.page), shape(known.page), "and the pages are the same for a book that is there, one that is not, and one that is off");

    for (const started of [unknown, off]) {
      const refused = await approveWithCode(w, started.page, { code });
      assert.equal(refused.status, 422);
      assert.equal(refused.json.code, "invalid_target");
      assert.match(refused.json.message, /MCP/);
    }
    const again = await approveWithCode(w, unknown.page, { code });
    assert.equal(again.status, 422, "the request stays open: the owner can only refuse it, or the app can ask again");
    assert.equal((await approveWithCode(w, known.page, { code })).status, 200);
  });
});

test("S7B: an app that names no resource is not given one: the owner says which book, by its address or its slug, and only a book that is on counts", async () => {
  await withServer(async (server, client) => {
    const { slug } = await mcpFixture(server, client);
    await mcpBook(client, "moon", "Moon Book");
    await mcpRoute(server, "moon");
    const w = web(server);
    const code = await adminCode(server);

    const started = await startAuthorization(w, { resource: null, slug });
    assert.equal(started.page.resource, null);
    assert.equal(started.page.bookInput, true, "the page asks which book");
    assert.match(started.html, /<input[^>]+name="book"/, "with a field for it");
    const missing = await approveWithCode(w, started.page, { code });
    assert.equal(missing.status, 400);
    assert.equal(missing.json.code, "book_required");
    for (const book of ["no-such-book", `${server.url}/mcp/no-such-book`, "moon-book", `${server.url}/api/v1/books`, "https://evil.example/mcp/the-glass-harbor", "x".repeat(300), "Not A Slug"]) {
      const refused = await approveWithCode(w, started.page, { code, book });
      assert.equal(refused.status, 422, book.slice(0, 50));
      assert.equal(refused.json.code, "invalid_target", book.slice(0, 50));
    }

    const verifier = started.verifier;
    const approved = await approveWithCode(w, started.page, { code, book: `${server.url}/mcp/${slug}` });
    assert.equal(approved.status, 200, approved.text);
    const tokens = await exchange(w, { code: codeOf(approved.json.redirect), verifier, clientId: started.app.client_id, redirectUri: started.redirectUri });
    assert.equal(tokens.status, 200, "the token request need not name a resource that the authorization did not");
    assert.equal((await mcpClient(server, slug, tokens.json.access_token).request("ping")).status, 200);
    assert.equal((await mcpClient(server, "moon-book", tokens.json.access_token).request("ping")).status, 404, "the grant is for the book the owner named, and that one only");

    const bySlug = await startAuthorization(w, { resource: null, slug });
    const named = await approveWithCode(w, bySlug.page, { code, book: slug });
    assert.equal(named.status, 200, "a slug is enough");
    const exchanged = await exchange(w, { code: codeOf(named.json.redirect), verifier: bySlug.verifier, clientId: bySlug.app.client_id, redirectUri: bySlug.redirectUri, resource: `${server.url}/mcp/${slug}` });
    assert.equal(exchanged.status, 200, "and the token request may name the resource that the owner chose");
  });
});

const flow = async (server, slug, w = web(server)) => {
  const started = await startAuthorization(w, { slug });
  const approved = await approveWithCode(w, started.page, { code: await adminCode(server) });
  return { ...started, code: codeOf(approved.json.redirect), w, form: (extra = {}) => ({ grant_type: "authorization_code", code: codeOf(approved.json.redirect), code_verifier: started.verifier, client_id: started.app.client_id, redirect_uri: started.redirectUri, resource: started.resource, ...extra }) };
};

test("S7B: the token endpoint refuses what is wrong with a request in the words of RFC 6749: JSON, no-store, and nothing a secret could be read from", async () => {
  await withServer(async (server, client) => {
    const { slug } = await mcpFixture(server, client);
    const w = web(server);
    const wrongRequest = async (name, changes, expected, status = 400) => {
      const started = await flow(server, slug, w);
      const form = { ...started.form(), ...changes };
      for (const key of Object.keys(form)) if (form[key] === undefined) delete form[key];
      const answer = await token(w, form);
      assert.equal(answer.status, status, `${name}: ${answer.text}`);
      assert.equal(answer.json.error, expected, name);
      assert.equal(typeof answer.json.error_description, "string", name);
      assert.deepEqual(Object.keys(answer.json).sort(), ["error", "error_description"], `${name}: the two fields of RFC 6749 and nothing else`);
      assert.match(answer.headers["content-type"], /^application\/json/);
      assert.equal(answer.headers["cache-control"], "no-store", name);
      assert.equal(answer.headers.pragma, "no-cache", name);
      assert.equal(answer.text.includes(started.code) || answer.text.includes(started.verifier), false, `${name}: the answer does not repeat the secrets it was sent`);
      return started;
    };
    await wrongRequest("no grant type", { grant_type: undefined }, "invalid_request");
    await wrongRequest("a password grant", { grant_type: "password" }, "unsupported_grant_type");
    await wrongRequest("client credentials", { grant_type: "client_credentials" }, "unsupported_grant_type");
    await wrongRequest("no code", { code: undefined }, "invalid_request");
    await wrongRequest("no verifier", { code_verifier: undefined }, "invalid_request");
    await wrongRequest("a verifier that is too short", { code_verifier: "short" }, "invalid_request");
    await wrongRequest("a verifier with characters it may not have", { code_verifier: `${"a".repeat(42)}!` }, "invalid_request");
    await wrongRequest("no client", { client_id: undefined }, "invalid_request");
    await wrongRequest("an unknown client", { client_id: "nobody" }, "invalid_client");
    await wrongRequest("no redirect address", { redirect_uri: undefined }, "invalid_request");
    await wrongRequest("a code nobody made", { code: "A".repeat(43) }, "invalid_grant");
    await wrongRequest("another verifier", { code_verifier: pkce().verifier }, "invalid_grant");
    await wrongRequest("another redirect address", { redirect_uri: "https://evil.example/cb" }, "invalid_grant");
    await wrongRequest("the redirect address with a slash more", { redirect_uri: `${LOCAL_REDIRECT}/` }, "invalid_grant");
    await wrongRequest("another book", { resource: `${server.url}/mcp/another-book` }, "invalid_target");
    await wrongRequest("a resource that is not even an address", { resource: "nonsense" }, "invalid_target");

    const other = await registerApp(w, { redirect_uris: [LOCAL_REDIRECT] });
    await wrongRequest("a code of another app", { client_id: other.client_id }, "invalid_grant");

    const started = await flow(server, slug, w);
    const twice = await token(w, new URLSearchParams([...Object.entries(started.form()), ["grant_type", "authorization_code"]]));
    assert.equal(twice.json.error, "invalid_request", "a parameter that is sent twice");
    const json = await w.post("/oauth/token", { json: started.form() });
    assert.ok(json.status === 400 || json.status === 415, `JSON is not a token request: ${json.status}`);
    assert.equal(json.json.error, "invalid_request");
    assert.equal((await w.get("/oauth/token")).status, 405);
    const big = await w.post("/oauth/token", { body: `grant_type=authorization_code&code=${"a".repeat(20_000)}`, headers: { "content-type": "application/x-www-form-urlencoded" } });
    assert.equal(big.status, 413);
    assert.equal(typeof big.json.error, "string");
    assert.equal((await token(w, started.form())).status, 200, "none of those spent a good code");
  });
});

test("S7B: a code that was presented wrongly is spent: the right verifier afterwards does not work either, so a code cannot be tried again and again", async () => {
  await withServer(async (server, client) => {
    const { slug } = await mcpFixture(server, client);
    const started = await flow(server, slug);
    assert.equal((await token(started.w, started.form({ code_verifier: pkce().verifier }))).json.error, "invalid_grant");
    assert.equal((await token(started.w, started.form())).json.error, "invalid_grant");
  });
});

test("S7B: a code is bound to the book of its resource: it cannot be traded for a token of another, and an app cannot choose a resource at the token endpoint", async () => {
  await withServer(async (server, client) => {
    const { slug } = await mcpFixture(server, client);
    await mcpBook(client, "moon", "Moon Book");
    const moon = await enableMcp(server, "moon");
    const started = await flow(server, slug);
    assert.equal((await token(started.w, started.form({ resource: `${server.url}/mcp/${moon.slug}` }))).json.error, "invalid_target");
    const second = await flow(server, slug);
    const tokens = await token(second.w, second.form());
    assert.equal((await mcpClient(server, moon.slug, tokens.json.access_token).request("ping")).status, 404, "a token for the first book is nothing at the second");
  });
});

test("S7B: the refresh token endpoint refuses an unknown token, another app's, a missing one, and an app that never took part", async () => {
  await withServer(async (server, client) => {
    const { slug } = await mcpFixture(server, client);
    const w = web(server);
    const started = await flow(server, slug, w);
    const tokens = (await token(w, started.form())).json;
    const other = await registerApp(w, { redirect_uris: [LOCAL_REDIRECT], grant_types: ["authorization_code", "refresh_token"] });
    const cases = [
      ["no token", { grant_type: "refresh_token", client_id: started.app.client_id }, "invalid_request"],
      ["no client", { grant_type: "refresh_token", refresh_token: tokens.refresh_token }, "invalid_request"],
      ["an unknown client", { grant_type: "refresh_token", refresh_token: tokens.refresh_token, client_id: "nobody" }, "invalid_client"],
      ["a token nobody made", { grant_type: "refresh_token", refresh_token: `nrr_${"A".repeat(43)}`, client_id: started.app.client_id }, "invalid_grant"],
      ["the access token as a refresh token", { grant_type: "refresh_token", refresh_token: tokens.access_token, client_id: started.app.client_id }, "invalid_grant"],
      ["a token of another app", { grant_type: "refresh_token", refresh_token: tokens.refresh_token, client_id: other.client_id }, "invalid_grant"],
      ["a token that is not even text of ours", { grant_type: "refresh_token", refresh_token: "x".repeat(500), client_id: started.app.client_id }, "invalid_grant"],
    ];
    for (const [name, form, expected] of cases) {
      const answer = await token(w, form);
      assert.equal(answer.status, 400, name);
      assert.equal(answer.json.error, expected, name);
    }
    assert.equal((await refresh(w, { refreshToken: tokens.refresh_token, clientId: started.app.client_id })).status, 200, "and the refresh token that was right all along still is: wrong requests do not spend it");
  });
});

test("S7B: the revocation endpoint (RFC 7009) answers 200 for what it does not know, revokes only the calling app's own tokens, and takes the access token or the refresh token", async () => {
  await withServer(async (server, client) => {
    const { slug } = await mcpFixture(server, client);
    const w = web(server);
    const one = await flow(server, slug, w);
    const oneTokens = (await token(w, one.form())).json;
    const two = await flow(server, slug, w);
    const twoTokens = (await token(w, two.form())).json;
    const revoke = (form) => w.post("/oauth/revoke", { form });
    const works = async (tokens) => (await mcpClient(server, slug, tokens.access_token).request("ping")).status === 200;

    assert.equal((await revoke({ token: "nrr_unknown", client_id: one.app.client_id })).status, 200, "a token that is not known: 200, nothing to tell");
    assert.equal((await revoke({ token: "x".repeat(1000), client_id: one.app.client_id })).status, 200);
    assert.equal((await revoke({ token: oneTokens.refresh_token })).status, 400, "an app says who it is");
    assert.equal((await revoke({ client_id: one.app.client_id })).status, 400, "and what it revokes");
    const stranger = await revoke({ token: oneTokens.refresh_token, client_id: two.app.client_id });
    assert.equal(stranger.status, 200);
    assert.equal(await works(oneTokens), true, "another app cannot revoke it");

    const byAccess = await revoke({ token: oneTokens.access_token, token_type_hint: "access_token", client_id: one.app.client_id });
    assert.equal(byAccess.status, 200);
    assert.equal(byAccess.headers["cache-control"], "no-store");
    assert.equal(await works(oneTokens), false, "an access token revokes its grant, the refresh token too");
    assert.equal((await refresh(w, { refreshToken: oneTokens.refresh_token, clientId: one.app.client_id })).json.error, "invalid_grant");
    assert.equal(await works(twoTokens), true, "and the other grant is whole");
    assert.equal((await revoke({ token: twoTokens.refresh_token, token_type_hint: "unknown_hint", client_id: two.app.client_id })).status, 200, "a hint is only a hint");
    assert.equal(await works(twoTokens), false);
    assert.equal((await w.get("/oauth/revoke")).status, 405);
  });
});

test("S7B: the OAuth endpoints share one budget per source a minute: past it the answer is 429 in the OAuth shape with Retry-After, and another source is not affected", async () => {
  await withServer(async (server, client) => {
    await mcpFixture(server, client);
    await setPublic(server);
    const w = web(server, { host: PUBLIC_HOST });
    const from = (address) => ({ headers: { "cf-connecting-ip": address } });
    for (let index = 0; index < 5; index += 1) assert.equal((await w.post("/oauth/token", { form: { grant_type: "x" }, ...from("203.0.113.5") })).status, 400);
    const refused = await w.post("/oauth/token", { form: { grant_type: "x" }, ...from("203.0.113.5") });
    assert.equal(refused.status, 429);
    assert.equal(refused.json.error, "temporarily_unavailable");
    assert.ok(Number(refused.headers["retry-after"]) >= 1);
    assert.equal(refused.headers["cache-control"], "no-store");
    assert.equal((await w.get("/oauth/authorize", from("203.0.113.5"))).status, 429, "the same budget for every OAuth endpoint");
    assert.equal((await w.post("/oauth/token", { form: { grant_type: "x" }, ...from("203.0.113.6") })).status, 400, "another source has its own");
  }, { limits: { oauthRequestsPerMinute: 5 } });
});
