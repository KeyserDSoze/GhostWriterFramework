import test from "node:test";
import assert from "node:assert/strict";
import { readFile, stat } from "node:fs/promises";
import path from "node:path";
import { withServer } from "./helpers.mjs";
import { mcpFixture } from "./mcp-helpers.mjs";
import { APP_REDIRECT, DAY, LOCAL_REDIRECT, PUBLIC_HOST, authorizeRoute, connectApp, makeClock, openConsent, pkce, registerApp, setPublic, web } from "./oauth-helpers.mjs";

// Dynamic client registration (S7, phase B, R2, RFC 7591): an app (Claude, ChatGPT, a command line tool) tells the server its name and where to send the owner back,
// and gets an id. It is a public client: it has no secret, so what keeps others from using its id is that the redirect address is exact and the code needs PKCE.

const register = (w, body, options) => w.post("/oauth/register", { json: body, ...options });
const base = { client_name: "Claude", redirect_uris: [APP_REDIRECT] };

test("S7B: registering an app answers 201 with an id, what the server will honour of it, no secret, and keeps it in the data folder", async () => {
  await withServer(async (server) => {
    const w = web(server);
    const answer = await register(w, { ...base, grant_types: ["authorization_code", "refresh_token"], response_types: ["code"], token_endpoint_auth_method: "none", scope: "mcp:read mcp:write", logo_uri: "https://claude.example/logo.png", client_secret: "x", is_admin: true });
    assert.equal(answer.status, 201, answer.text);
    assert.match(answer.headers["content-type"], /^application\/json/);
    assert.equal(answer.headers["cache-control"], "no-store");
    const registered = answer.json;
    assert.match(registered.client_id, /^[A-Za-z0-9_-]{16,}$/);
    assert.equal(typeof registered.client_id_issued_at, "number");
    assert.deepEqual(
      { name: registered.client_name, uris: registered.redirect_uris, grants: registered.grant_types, responses: registered.response_types, method: registered.token_endpoint_auth_method },
      { name: "Claude", uris: [APP_REDIRECT], grants: ["authorization_code", "refresh_token"], responses: ["code"], method: "none" },
    );
    assert.equal(registered.scope, "mcp:read mcp:write", "the scope it asked for, as far as the server has it");
    for (const field of ["client_secret", "client_secret_expires_at", "is_admin", "registration_access_token"]) assert.equal(field in registered, false, `${field} is never given or echoed`);

    const defaults = (await register(w, { redirect_uris: [LOCAL_REDIRECT] })).json;
    assert.equal(defaults.client_name, "Unnamed app");
    assert.deepEqual([defaults.grant_types, defaults.response_types, defaults.token_endpoint_auth_method, defaults.scope], [["authorization_code"], ["code"], "none", "mcp:read mcp:write mcp:run"]);
    assert.notEqual(defaults.client_id, registered.client_id);

    const file = path.join(server.data.root, "private", "oauth.json");
    const stored = JSON.parse(await readFile(file, "utf8"));
    assert.ok(JSON.stringify(stored).includes(registered.client_id), "it is kept in the data folder");
    if (process.platform !== "win32") assert.equal((await stat(file)).mode & 0o777, 0o600, "where only the owner can read it");
  });
});

test("S7B: redirect addresses are https, or http on this computer, written out exactly: nothing with a wildcard, a fragment, credentials or another scheme", async () => {
  await withServer(async (server) => {
    const w = web(server);
    const good = ["https://claude.ai/api/mcp/auth_callback", "https://chatgpt.com/connector_platform_oauth_redirect", "https://app.example/cb?tenant=1", "http://127.0.0.1:8765/callback", "http://localhost:3000/cb", "http://[::1]:9000/cb", "https://app.example:8443/cb"];
    for (const uri of good) {
      const answer = await register(w, { redirect_uris: [uri] });
      assert.equal(answer.status, 201, `${uri}: ${answer.text}`);
      assert.deepEqual(answer.json.redirect_uris, [uri]);
    }
    const bad = [
      "http://example.com/cb", "http://localhost.evil.example/cb", "http://127.0.0.1.evil.test/cb", "http://10.0.0.5/cb",
      "https://app.example/cb#fragment", "https://*.example.com/cb", "https://app.example/*", "https://app.example/c*b",
      "javascript:alert(1)", "data:text/html,x", "ftp://app.example/cb", "myapp://callback", "file:///etc/passwd",
      "https://user:secret@app.example/cb", "https://:secret@app.example/cb", "not a url", "", "/relative/cb", "//app.example/cb",
      `https://app.example/${"a".repeat(2100)}`,
    ];
    for (const uri of bad) {
      const answer = await register(w, { redirect_uris: [uri] });
      assert.equal(answer.status, 400, `${uri.slice(0, 60)}: ${answer.text.slice(0, 100)}`);
      assert.equal(answer.json.error, "invalid_redirect_uri", uri.slice(0, 60));
      assert.equal(typeof answer.json.error_description, "string");
    }
    for (const redirect_uris of [undefined, [], "https://app.example/cb", {}, [5], [null], ["https://app.example/a", "https://app.example/a"], Array.from({ length: 6 }, (_, index) => `https://app.example/${index}`)]) {
      const answer = await register(w, { client_name: "X", redirect_uris });
      assert.equal(answer.status, 400, JSON.stringify(redirect_uris)?.slice(0, 80));
      assert.equal(answer.json.error, "invalid_redirect_uri");
    }
    const five = await register(w, { redirect_uris: Array.from({ length: 5 }, (_, index) => `https://app.example/${index}`) });
    assert.equal(five.status, 201, "five is the most");
  }, { limits: { oauthRegistrationsPerHour: 1000 } });
});

test("S7B: what else may be asked for is only what the server does: public clients, the code flow, refresh; anything else is refused as invalid metadata", async () => {
  await withServer(async (server) => {
    const w = web(server);
    const refused = [
      { token_endpoint_auth_method: "client_secret_basic" }, { token_endpoint_auth_method: "client_secret_post" }, { token_endpoint_auth_method: "private_key_jwt" },
      { grant_types: ["implicit"] }, { grant_types: ["client_credentials"] }, { grant_types: ["password"] }, { grant_types: ["authorization_code", "urn:ietf:params:oauth:grant-type:device_code"] }, { grant_types: [] }, { grant_types: "authorization_code" },
      { response_types: ["token"] }, { response_types: ["code", "id_token"] }, { response_types: [] },
      { client_name: 5 }, { client_name: ["a"] }, { client_name: { a: 1 } }, { scope: 5 },
    ];
    for (const extra of refused) {
      const answer = await register(w, { ...base, ...extra });
      assert.equal(answer.status, 400, JSON.stringify(extra));
      assert.equal(answer.json.error, "invalid_client_metadata", JSON.stringify(extra));
    }
    const refreshOnly = await register(w, { ...base, grant_types: ["refresh_token"] });
    assert.equal(refreshOnly.status, 400, "a client that cannot use the code flow has nothing to register for");
    const narrower = await register(w, { ...base, scope: "mcp:read nonsense" });
    assert.equal(narrower.json.scope, "mcp:read", "a scope the server does not have is left out of what was granted to be asked for");
  }, { limits: { oauthRegistrationsPerHour: 1000 } });
});

test("S7B: a name is shown to the owner on the consent page, so it is cleaned (no control or direction-changing characters), cut at 80 characters, and never trusted as markup", async () => {
  await withServer(async (server) => {
    const w = web(server);
    const dirty = await register(w, { redirect_uris: [APP_REDIRECT], client_name: `  Evil\u0000\u001b[31m\u202e App\u2066 ${"x".repeat(200)}  ` });
    assert.equal(dirty.status, 201);
    const name = dirty.json.client_name;
    assert.equal(/[\u0000-\u001f\u007f-\u009f\u200b-\u200f\u2028-\u202e\u2066-\u2069\ufeff]/u.test(name), false, JSON.stringify(name));
    assert.ok([...name].length <= 80 && name.startsWith("Evil"), name);
    for (const empty of ["", "   ", "\u0000\u202e"]) assert.equal((await register(w, { redirect_uris: [APP_REDIRECT], client_name: empty })).json.client_name, "Unnamed app", JSON.stringify(empty));
    const markup = await register(w, { redirect_uris: [APP_REDIRECT], client_name: `<img src=x onerror=alert(1)>` });
    assert.equal(markup.json.client_name, "<img src=x onerror=alert(1)>", "kept as text: it is escaped where it is shown, not rewritten here");
  });
});

test("S7B: a body that is too big, not JSON, or not an object is refused, in the OAuth error shape, with nothing stored", async () => {
  await withServer(async (server) => {
    const w = web(server);
    const big = await w.post("/oauth/register", { body: JSON.stringify({ ...base, client_name: "x".repeat(20_000) }), headers: { "content-type": "application/json" } });
    assert.equal(big.status, 413);
    for (const body of ["{not json", "[]", "null", '"text"', "5"]) {
      const answer = await w.post("/oauth/register", { body, headers: { "content-type": "application/json" } });
      assert.equal(answer.status, 400, body);
      assert.equal(typeof answer.json.error, "string", body);
      assert.equal("code" in answer.json, false, "the OAuth shape, not the API's");
    }
    const form = await w.post("/oauth/register", { form: { redirect_uris: APP_REDIRECT } });
    assert.equal(form.status, 415, "registration is JSON (RFC 7591)");
    assert.equal((await w.get("/oauth/register")).status, 405);
    const file = path.join(server.data.root, "private", "oauth.json");
    const kept = await readFile(file, "utf8").then((text) => JSON.parse(text).clients?.length ?? 0, () => 0);
    assert.equal(kept, 0, "nothing was stored");
  });
});

test("S7B: one source may register only so many apps an hour, and the others are not affected", async () => {
  await withServer(async (server) => {
    await setPublic(server);
    const w = web(server, { host: PUBLIC_HOST });
    const from = (address) => ({ headers: { "cf-connecting-ip": address } });
    for (let index = 0; index < 3; index += 1) assert.equal((await register(w, base, from("203.0.113.5"))).status, 201);
    const refused = await register(w, base, from("203.0.113.5"));
    assert.equal(refused.status, 429);
    assert.equal(refused.json.error, "temporarily_unavailable");
    assert.ok(Number(refused.headers["retry-after"]) >= 1);
    assert.equal(refused.headers["cache-control"], "no-store");
    assert.equal((await register(w, base, from("203.0.113.6"))).status, 201, "another source has its own budget");
  }, { limits: { oauthRegistrationsPerHour: 3 } });
});

test("S7B: the apps kept are bounded: past the limit the one nobody used for longest makes room, and when every app holds a grant the next registration waits", async () => {
  const clock = makeClock();
  await withServer(async (server, client) => {
    const w = web(server);
    const known = async (id) => (await openConsent(w, { clientId: id, challenge: pkce().challenge, resource: `${server.url}/mcp/x` })).status === 200;
    const first = (await registerApp(w)).client_id;
    clock.advance(DAY);
    const second = (await registerApp(w)).client_id;
    clock.advance(DAY);
    const third = (await registerApp(w)).client_id;
    const fourth = await register(w, base);
    assert.equal(fourth.status, 201, "the oldest unused one made room");
    assert.deepEqual([await known(first), await known(second), await known(third), await known(fourth.json.client_id)], [false, true, true, true]);
  }, { now: clock.now, limits: { oauthMaxClients: 3 } });
  await withServer(async (server, client) => {
    const w = web(server);
    const { slug } = await mcpFixture(server, client);
    for (let index = 0; index < 3; index += 1) await connectApp(server, { slug, w, name: `App ${index}` });
    const refused = await register(w, base);
    assert.equal(refused.status, 503, "every app has a grant: none can be taken away");
    assert.equal(refused.json.error, "temporarily_unavailable");
    assert.ok(Number(refused.headers["retry-after"]) >= 1);
  }, { limits: { oauthMaxClients: 3 } });
});

test("S7B: the removal of apps follows what was used, not what was registered: an app opened on day 20 is kept past day 30, and one that holds a grant is kept while the grant holds", async () => {
  const clock = makeClock();
  await withServer(async (server, client) => {
    const w = web(server);
    const { slug } = await mcpFixture(server, client);
    const unused = (await registerApp(w)).client_id;
    const opened = (await registerApp(w)).client_id;
    const connected = await connectApp(server, { slug, name: "Connected", w });
    const known = async (id, redirectUri = APP_REDIRECT) => (await openConsent(w, { clientId: id, redirectUri, challenge: pkce().challenge, resource: `${server.url}/mcp/${slug}` })).status === 200;

    clock.advance(20 * DAY);
    assert.equal(await known(opened), true, "opening it on day 20 is use");
    clock.advance(11 * DAY);
    await server.oauth.sweep();
    assert.equal(await known(unused), false, "never used, 31 days: removed");
    assert.equal(await known(opened), true, "used 11 days ago: kept");
    assert.equal(await known(connected.app.client_id, LOCAL_REDIRECT), true, "its grant still holds (60 days): kept");

    clock.advance(31 * DAY);
    await server.oauth.sweep();
    assert.equal(await known(opened), false, "idle for 31 days: removed");
    assert.equal(await known(connected.app.client_id, LOCAL_REDIRECT), false, "its refresh token ran out on day 60 and nobody used it: the app goes with it");
  }, { now: clock.now });
});

test("S7B: an app that was never registered is refused at authorize with a page, never a redirect", async () => {
  await withServer(async (server) => {
    const w = web(server);
    const answer = await w.get(authorizeRoute({ clientId: "never-registered", challenge: pkce().challenge, resource: `${server.url}/mcp/x` }));
    assert.equal(answer.status, 400);
    assert.equal(answer.location, undefined, "an app that is not known gets no redirect, whatever it asks for");
    assert.match(answer.headers["content-type"], /^text\/html/);
  });
});
