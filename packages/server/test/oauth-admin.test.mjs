import test from "node:test";
import assert from "node:assert/strict";
import { rawApi } from "./api-helpers.mjs";
import { adminLogin, until, withServer } from "./helpers.mjs";
import { fakeBrowser, settle } from "./fake-browser.mjs";
import { mcpBook, mcpClient, mcpFixture, mcpRoute } from "./mcp-helpers.mjs";
import { SoftwarePasskey } from "./passkey-helpers.mjs";
import { PUBLIC_HOST, PUBLIC_URL, approveWithPasskey, connectApp, refresh, registerPasskey, setPublic, startAuthorization, web } from "./oauth-helpers.mjs";

// The MCP section of the admin panel and the routes behind it (S7, phase B, R5): the owner's view of what is connected, his switches, his passkeys and the audit of what was called.
// Everything is behind the admin session. The web app has two routes of its own for the connected apps of a book (scope write).

const audit = (admin, query = "") => admin.call("GET", `/admin/api/mcp/audit${query}`);

test("S7B admin: every MCP route of the panel needs the admin session, and a state-changing one needs its token too", async () => {
  await withServer(async (server) => {
    const origin = server.adminUrl;
    for (const [method, route] of [["GET", "/admin/api/mcp"], ["GET", "/admin/api/mcp/audit"], ["POST", "/admin/api/mcp/book"], ["POST", "/admin/api/mcp/revoke"], ["POST", "/admin/api/passkeys/link"], ["POST", "/admin/api/passkeys/rename"], ["POST", "/admin/api/passkeys/remove"]]) {
      const answer = await fetch(`${origin}${route}`, { method, headers: { origin, "content-type": "application/json" }, body: method === "POST" ? "{}" : undefined });
      assert.equal(answer.status, 401, `${method} ${route}`);
    }
    const admin = await adminLogin(server);
    const noToken = await fetch(`${origin}/admin/api/mcp/book`, { method: "POST", headers: { origin, cookie: admin.cookie, "content-type": "application/json" }, body: "{}" });
    assert.equal(noToken.status, 403, "a session without its token cannot change anything");
    assert.equal((await admin.call("GET", "/admin/api/mcp")).status, 200);
  });
});

test("S7B admin: the overview lists every book with its switch, slug, address and connected apps, and the passkeys; looking at it writes nothing", async () => {
  await withServer(async (server, client) => {
    await mcpBook(client, "glass", "The Glass Harbor");
    await mcpBook(client, "moon", "Moon Book");
    const admin = await adminLogin(server);
    const first = (await admin.call("GET", "/admin/api/mcp")).body;
    assert.deepEqual(first.books.map((book) => [book.bookId, book.title, book.enabled, book.slug, book.url]), [
      ["glass", "The Glass Harbor", false, "the-glass-harbor", `${server.url}/mcp/the-glass-harbor`],
      ["moon", "Moon Book", false, "moon-book", `${server.url}/mcp/moon-book`],
    ]);
    assert.equal(server.mcp.books.resolve("the-glass-harbor"), undefined, "a slug is proposed, not taken: looking is not a write");
    assert.deepEqual([first.publicUrl, first.canAddPasskey, first.passkeys], ["", false, []]);
    assert.ok(first.books.every((book) => Array.isArray(book.apps) && book.apps.length === 0));

    const status = await (await mcpRoute(server, "glass")).put({ enabled: true });
    assert.equal(status.status, 200);
    const connected = await connectApp(server, { slug: status.json.slug, name: "Claude", scopes: ["read", "write"] });
    await setPublic(server);
    const after = (await admin.call("GET", "/admin/api/mcp")).body;
    assert.deepEqual([after.publicUrl, after.canAddPasskey], [PUBLIC_URL, true]);
    const glass = after.books.find((book) => book.bookId === "glass");
    assert.equal(glass.enabled, true);
    assert.equal(glass.url, `${PUBLIC_URL}/mcp/the-glass-harbor`);
    assert.equal(glass.apps.length, 1);
    const [app] = glass.apps;
    assert.deepEqual([app.name, app.clientId, app.redirectHost, app.scopes], ["Claude", connected.app.client_id, "127.0.0.1:8765", ["read", "write"]]);
    assert.match(app.id, /^[A-Za-z0-9_-]+$/);
    assert.ok(!Number.isNaN(Date.parse(app.createdAt)) && !Number.isNaN(Date.parse(app.lastUsedAt)));
    assert.equal(JSON.stringify(after).includes(connected.tokens.access_token), false);
    assert.equal(JSON.stringify(after).includes(connected.tokens.refresh_token), false, "never a token");
  });
});

test("S7B admin: the owner switches a book on and off and changes its slug here as he does through the API, and an app of that book is disconnected when its address goes", async () => {
  await withServer(async (server, client) => {
    await mcpBook(client, "glass", "The Glass Harbor");
    await mcpBook(client, "moon", "Moon Book");
    const admin = await adminLogin(server);
    const change = (body) => admin.call("POST", "/admin/api/mcp/book", body);

    const on = await change({ bookId: "glass", enabled: true });
    assert.equal(on.status, 200);
    assert.deepEqual([on.body.enabled, on.body.slug, on.body.url, on.body.connections], [true, "the-glass-harbor", `${server.url}/mcp/the-glass-harbor`, 0]);
    assert.equal((await mcpClient(server, "the-glass-harbor", (await rawApi(server)).token).request("ping")).status, 200, "and it is really on");

    const connected = await connectApp(server, { slug: "the-glass-harbor" });
    assert.equal((await (await mcpRoute(server)).get()).json.connections, 1);
    const renamed = await change({ bookId: "glass", slug: "glass" });
    assert.deepEqual([renamed.status, renamed.body.slug, renamed.body.connections], [200, "glass", 0]);
    assert.equal((await mcpClient(server, "glass", connected.tokens.access_token).request("ping")).status, 401, "the address changed: the app goes");

    assert.deepEqual([(await change({ bookId: "moon", slug: "glass" })).status, (await change({ bookId: "moon", slug: "glass" })).body.code], [409, "slug_taken"]);
    for (const [body, status, code] of [[{ bookId: "glass", slug: "Bad Slug" }, 400, "invalid_slug"], [{ bookId: "glass", enabled: "yes" }, 400, "invalid_request"], [{ bookId: "glass" }, 400, "invalid_request"], [{ enabled: true }, 400, "invalid_request"], [{ bookId: "nothing", enabled: true }, 404, undefined]]) {
      const answer = await change(body);
      assert.equal(answer.status, status, JSON.stringify(body));
      if (code) assert.equal(answer.body.code, code, JSON.stringify(body));
    }
    const second = await connectApp(server, { slug: "glass" });
    const off = await change({ bookId: "glass", enabled: false });
    assert.deepEqual([off.status, off.body.enabled, off.body.connections], [200, false, 0]);
    assert.equal((await mcpClient(server, "glass", second.tokens.access_token).request("ping")).status, 401);
    assert.equal((await refresh(web(server), { refreshToken: second.tokens.refresh_token, clientId: second.app.client_id })).json.error, "invalid_grant");
  });
});

test("S7B admin: the owner revokes a connected app from the overview, and only that one", async () => {
  await withServer(async (server, client) => {
    const { slug } = await mcpFixture(server, client);
    const admin = await adminLogin(server);
    const one = await connectApp(server, { slug, name: "App one" });
    const two = await connectApp(server, { slug, name: "App two" });
    const overview = async () => (await admin.call("GET", "/admin/api/mcp")).body.books.find((book) => book.bookId === "glass").apps;
    const apps = await overview();
    const target = apps.find((app) => app.name === "App one");
    assert.deepEqual((await admin.call("POST", "/admin/api/mcp/revoke", { id: target.id })).body, { revoked: true });
    assert.equal((await mcpClient(server, slug, one.tokens.access_token).request("ping")).status, 401);
    assert.equal((await mcpClient(server, slug, two.tokens.access_token).request("ping")).status, 200);
    assert.deepEqual((await overview()).map((app) => app.name), ["App two"]);
    assert.deepEqual((await admin.call("POST", "/admin/api/mcp/revoke", { id: target.id })).body, { revoked: false }, "revoking twice is not an error");
    assert.equal((await admin.call("POST", "/admin/api/mcp/revoke", {})).status, 400);
  });
});

test("S7B admin: a passkey is added with a link that works once, on the public address: renamed, listed, removed; the last one only when the owner has confirmed", async () => {
  await withServer(async (server, client) => {
    const { slug } = await mcpFixture(server, client);
    const admin = await adminLogin(server);
    const link = await admin.call("POST", "/admin/api/passkeys/link", {});
    assert.equal(link.status, 409, "a passkey needs the public address");
    assert.equal(link.body.code, "public_url_needed");

    await setPublic(server);
    const w = web(server, { host: PUBLIC_HOST });
    const made = await admin.call("POST", "/admin/api/passkeys/link", {});
    assert.equal(made.status, 200);
    const url = new URL(made.body.url);
    assert.equal(`${url.origin}${url.pathname}`, `${PUBLIC_URL}/oauth/passkeys/add`);
    assert.match(url.hash, /^#[A-Za-z0-9_-]{20,}$/, "the ticket is after the #: it never reaches a log or a Referer");
    assert.equal(url.search, "");
    assert.ok(made.body.expiresAt > Date.now() && made.body.expiresAt <= Date.now() + 10 * 60_000 + 1000);

    const phone = new SoftwarePasskey();
    const registered = await registerPasskey(w, url.hash.slice(1), phone, { label: "Phone" });
    assert.equal(registered.status, 200);
    assert.equal((await registerPasskey(w, url.hash.slice(1), new SoftwarePasskey())).status, 404, "the link worked once");

    const laptop = new SoftwarePasskey({ alg: -8 });
    const second = new URL((await admin.call("POST", "/admin/api/passkeys/link", {})).body.url);
    await registerPasskey(w, second.hash.slice(1), laptop, { label: "Laptop" });
    const listed = (await admin.call("GET", "/admin/api/mcp")).body.passkeys;
    assert.deepEqual(listed.map((entry) => [entry.id, entry.label, entry.usable, entry.rpId]), [[phone.id, "Phone", true, PUBLIC_HOST], [laptop.id, "Laptop", true, PUBLIC_HOST]]);
    assert.ok(listed.every((entry) => !Number.isNaN(Date.parse(entry.createdAt)) && entry.lastUsedAt === null && Array.isArray(entry.transports)));
    assert.equal(JSON.stringify(listed).includes("publicKey"), false, "the key is not shown");

    const started = await startAuthorization(w, { slug });
    assert.equal((await approveWithPasskey(w, started.page, { passkey: phone, scopes: ["read"] })).status, 200);
    assert.ok((await admin.call("GET", "/admin/api/mcp")).body.passkeys.find((entry) => entry.id === phone.id).lastUsedAt, "the use is noted");

    assert.deepEqual((await admin.call("POST", "/admin/api/passkeys/rename", { id: laptop.id, label: "  Work laptop  " })).body, { renamed: true });
    assert.equal((await admin.call("GET", "/admin/api/mcp")).body.passkeys.find((entry) => entry.id === laptop.id).label, "Work laptop");
    for (const label of ["", "   ", 5, "x".repeat(41)]) assert.equal((await admin.call("POST", "/admin/api/passkeys/rename", { id: laptop.id, label })).status, 422, JSON.stringify(label));
    assert.equal((await admin.call("POST", "/admin/api/passkeys/rename", { id: "nothing", label: "x" })).status, 404);

    assert.deepEqual((await admin.call("POST", "/admin/api/passkeys/remove", { id: laptop.id })).body, { removed: true }, "one of two goes without questions");
    const lastTry = await admin.call("POST", "/admin/api/passkeys/remove", { id: phone.id });
    assert.deepEqual([lastTry.status, lastTry.body.code], [409, "last_passkey"]);
    assert.equal((await admin.call("GET", "/admin/api/mcp")).body.passkeys.length, 1, "and it is still there");
    assert.deepEqual((await admin.call("POST", "/admin/api/passkeys/remove", { id: phone.id, confirmLast: true })).body, { removed: true });
    assert.deepEqual((await admin.call("GET", "/admin/api/mcp")).body.passkeys, []);
    const gone = await startAuthorization(w, { slug });
    assert.equal(gone.page.passkeys.available, false, "with none left the page offers the admin code only");
    assert.equal((await admin.call("POST", "/admin/api/passkeys/remove", { id: phone.id })).status, 404);
    assert.equal((await admin.call("POST", "/admin/api/passkeys/remove", { id: phone.id, confirmLast: true })).status, 404);
  });
});

test("S7B admin: no more than twenty passkeys are kept", async () => {
  await withServer(async (server) => {
    await setPublic(server);
    const admin = await adminLogin(server);
    const w = web(server, { host: PUBLIC_HOST });
    for (let index = 0; index < 20; index += 1) {
      const ticket = new URL((await admin.call("POST", "/admin/api/passkeys/link", {})).body.url).hash.slice(1);
      const answer = await registerPasskey(w, ticket, new SoftwarePasskey(), { label: `Key ${index}` });
      assert.equal(answer.status, 200, `passkey ${index + 1}: ${answer.text}`);
    }
    const ticket = new URL((await admin.call("POST", "/admin/api/passkeys/link", {})).body.url).hash.slice(1);
    const over = await registerPasskey(w, ticket, new SoftwarePasskey());
    assert.deepEqual([over.status, over.json.code], [409, "too_many_passkeys"]);
    assert.equal((await admin.call("GET", "/admin/api/mcp")).body.passkeys.length, 20);
  });
});

test("S7B admin: the audit is paginated newest first, can be limited to a book, and holds who and what, never what a tool returned", async () => {
  await withServer(async (server, client) => {
    const { slug, rpc } = await mcpFixture(server, client);
    await mcpBook(client, "moon", "Moon Book");
    const moon = (await (await mcpRoute(server, "moon")).put({ enabled: true })).json;
    const other = mcpClient(server, moon.slug, (await rawApi(server)).token);
    for (let index = 0; index < 4; index += 1) await rpc.call("book_info");
    await rpc.call("read_paragraph", { chapter: "001-arrival", paragraph: "001-the-quay" });
    await other.call("book_info");
    await server.mcp.audit.flush();
    const admin = await adminLogin(server);

    const all = (await audit(admin, "?limit=100")).body;
    assert.equal(all.entries.length, 6);
    assert.deepEqual(all.entries.map((entry) => entry.seq), [6, 5, 4, 3, 2, 1], "newest first, each with its number");
    assert.equal(all.nextBefore, null);
    const entry = all.entries.find((candidate) => candidate.tool === "read_paragraph");
    assert.deepEqual([entry.bookId, entry.client, entry.ok, entry.paths], ["glass", "Claude Code", true, ["chapters/001-arrival/001-the-quay.md"]]);
    assert.equal(JSON.stringify(all).includes("Mira stepped onto the quay"), false, "the path of a scene, never its text");

    const pages = [];
    let before;
    for (let guard = 0; guard < 5; guard += 1) {
      const page = (await audit(admin, `?limit=4${before ? `&before=${before}` : ""}`)).body;
      pages.push(page.entries.map((candidate) => candidate.seq));
      if (page.nextBefore === null) break;
      before = page.nextBefore;
    }
    assert.deepEqual(pages, [[6, 5, 4, 3], [2, 1]]);

    const book = (await audit(admin, "?book=moon")).body;
    assert.deepEqual(book.entries.map((candidate) => candidate.bookId), ["moon"]);
    assert.deepEqual((await audit(admin, "?book=glass&limit=2")).body.entries.map((candidate) => candidate.seq), [5, 4]);
    assert.equal((await audit(admin, "?limit=0")).status, 400);
    assert.equal((await audit(admin, "?limit=abc")).status, 400);
    assert.equal((await audit(admin, "?before=abc")).status, 400);
    assert.equal((await audit(admin, "?limit=100000")).body.entries.length, 6, "a limit that is too high is the highest there is, not an error");
    assert.equal((await audit(admin, "?book=nothing")).body.entries.length, 0);
    assert.equal(slug, "the-glass-harbor");
  });
});

test("S7B admin: the audit says which app made a call, whether it was a client token or an OAuth grant", async () => {
  await withServer(async (server, client) => {
    const { slug, rpc } = await mcpFixture(server, client);
    await rpc.call("book_info");
    const connected = await connectApp(server, { slug, name: "Claude" });
    await mcpClient(server, slug, connected.tokens.access_token).call("book_info");
    await server.mcp.audit.flush();
    const admin = await adminLogin(server);
    const entries = (await audit(admin)).body.entries;
    assert.deepEqual(entries.map((entry) => [entry.client, entry.clientId.startsWith("oauth:")]), [["Claude", true], ["Claude Code", false]]);
    assert.deepEqual(entries.map((entry) => entry.seq), [2, 1]);
  });
});

test("S7B web app routes: the connected apps of a book are listed and revoked with scope write; another book's grant is not found", async () => {
  await withServer(async (server, client) => {
    const { slug } = await mcpFixture(server, client);
    await mcpBook(client, "moon", "Moon Book");
    const moon = (await (await mcpRoute(server, "moon")).put({ enabled: true })).json;
    const reader = await rawApi(server, ["read"]);
    const writer = await rawApi(server, ["read", "write"]);
    const one = await connectApp(server, { slug, name: "Claude", scopes: ["read", "write", "run"] });
    const elsewhere = await connectApp(server, { slug: moon.slug, name: "ChatGPT" });

    const forbidden = await reader("GET", "/api/v1/books/glass/mcp/clients");
    assert.equal(forbidden.status, 403, "reading the list needs write: it says who may change the book");
    assert.equal((await reader("DELETE", "/api/v1/books/glass/mcp/clients/x")).status, 403);
    assert.equal((await fetch(`${server.url}/api/v1/books/glass/mcp/clients`)).status, 401);

    const listed = await writer("GET", "/api/v1/books/glass/mcp/clients");
    assert.equal(listed.status, 200);
    assert.equal(listed.json.clients.length, 1);
    const [entry] = listed.json.clients;
    assert.deepEqual(Object.keys(entry).sort(), ["clientId", "createdAt", "id", "lastUsedAt", "name", "redirectHost", "scopes"]);
    assert.deepEqual([entry.name, entry.clientId, entry.scopes, entry.redirectHost], ["Claude", one.app.client_id, ["read", "write", "run"], "127.0.0.1:8765"]);
    assert.ok(!Number.isNaN(Date.parse(entry.createdAt)) && !Number.isNaN(Date.parse(entry.lastUsedAt)));
    assert.equal(JSON.stringify(listed.json).includes("nra_"), false);
    assert.equal((await writer("GET", "/api/v1/books/nothing/mcp/clients")).status, 404);

    const wrongBook = await writer("DELETE", `/api/v1/books/moon/mcp/clients/${entry.id}`);
    assert.equal(wrongBook.status, 404, "a grant of another book is not found here");
    assert.equal((await mcpClient(server, slug, one.tokens.access_token).request("ping")).status, 200);
    assert.equal((await writer("DELETE", "/api/v1/books/glass/mcp/clients/nothing")).status, 404);
    const removed = await writer("DELETE", `/api/v1/books/glass/mcp/clients/${entry.id}`);
    assert.deepEqual([removed.status, removed.json], [200, { revoked: true }]);
    assert.equal((await mcpClient(server, slug, one.tokens.access_token).request("ping")).status, 401);
    assert.equal((await mcpClient(server, moon.slug, elsewhere.tokens.access_token).request("ping")).status, 200);
    assert.equal((await writer("GET", "/api/v1/books/glass/mcp/clients")).json.clients.length, 0);
  });
});

// ---------------------------------------------------------------------------------------------
// The panel itself: run its script against the real server
// ---------------------------------------------------------------------------------------------

async function openPanel(server, { language = "en-GB", confirm = () => true } = {}) {
  const admin = await adminLogin(server);
  const html = await (await fetch(`${server.adminUrl}/`)).text();
  const script = await (await fetch(`${server.adminUrl}/admin.js`)).text();
  const requests = [];
  const confirms = [];
  const fetchThroughSession = async (route, init = {}) => {
    requests.push({ route, method: init.method ?? "GET", body: init.body === undefined ? undefined : JSON.parse(init.body) });
    const response = await fetch(`${server.adminUrl}${route}`, { method: init.method, headers: { ...init.headers, origin: server.adminUrl, cookie: admin.cookie }, body: init.body });
    const text = await response.text();
    return { status: response.status, ok: response.ok, text: async () => text };
  };
  const browser = fakeBrowser(html, script, {
    fetch: fetchThroughSession,
    location: { origin: server.adminUrl },
    navigator: { language, clipboard: { writeText: async () => undefined } },
    storage: { "narrarium-admin-csrf": admin.csrf },
    confirm: (text) => {
      confirms.push(text);
      return confirm(text);
    },
    filename: "admin.js",
  });
  await browser.ready;
  await until(() => browser.$("main-view") && !browser.$("main-view").classList.contains("hidden"));
  return { browser, html, requests, confirms, admin };
}
const buttons = (element, label) => element.find((node) => node.tagName === "BUTTON" && node.textContent === label);

test("S7B admin panel: the section lists the books and their apps, switches a book on, changes its slug and revokes an app, with one click each", async () => {
  await withServer(async (server, client) => {
    const { slug } = await mcpFixture(server, client);
    await mcpBook(client, "moon", "Moon Book");
    await connectApp(server, { slug, name: "Claude", scopes: ["read", "write"] });
    const panel = await openPanel(server);
    assert.match(panel.html, /<section class="card wide" id="mcp">/);
    const rows = await until(() => (panel.browser.$("mcp-books").children.length === 2 ? panel.browser.$("mcp-books").children : null));
    const text = rows.map((row) => row.textContent);
    assert.match(text[0], /The Glass Harbor/);
    assert.ok(text[0].includes(`${server.url}/mcp/${slug}`), "the address");
    assert.match(text[0], /Claude.*read.*write/s, "the app and its permissions");
    assert.equal(/undefined|null|NaN/.test(text.join(" ")), false);
    assert.match(text[1], /Moon Book/);

    const moon = rows[1];
    const toggle = moon.find((node) => node.tagName === "INPUT" && node.type === "checkbox")[0];
    toggle.checked = true;
    await toggle.dispatch("change");
    await until(() => panel.requests.some((request) => request.route === "/admin/api/mcp/book"));
    assert.deepEqual(panel.requests.find((request) => request.route === "/admin/api/mcp/book").body, { bookId: "moon", enabled: true });
    await until(async () => (await mcpClient(server, "moon-book", (await rawApi(server)).token).request("ping")).status === 200);

    const glassRow = (await until(() => panel.browser.$("mcp-books").children.length === 2 ? panel.browser.$("mcp-books").children[0] : null));
    const revoke = (await until(() => { const found = buttons(glassRow, "Revoke"); return found.length ? found : null; }))[0];
    await revoke.click();
    await until(() => panel.requests.some((request) => request.route === "/admin/api/mcp/revoke"));
    assert.deepEqual(Object.keys(panel.requests.find((request) => request.route === "/admin/api/mcp/revoke").body), ["id"]);
    assert.deepEqual(panel.confirms, [], "no dialog for a revocation");
    await settle(60);
    assert.equal((await (await mcpRoute(server)).get()).json.connections, 0);
  });
});

test("S7B admin panel: switching a book off, or changing its address, asks first, because the apps of the book go with it", async () => {
  await withServer(async (server, client) => {
    const { slug } = await mcpFixture(server, client);
    await connectApp(server, { slug, name: "Claude" });
    const declined = await openPanel(server, { confirm: () => false });
    const row = await until(() => declined.browser.$("mcp-books").children[0]);
    const toggle = row.find((node) => node.tagName === "INPUT" && node.type === "checkbox")[0];
    toggle.checked = false;
    await toggle.dispatch("change");
    await settle(60);
    assert.equal(declined.confirms.length, 1);
    assert.match(declined.confirms[0], /disconnect|apps/i);
    assert.equal(declined.requests.some((request) => request.route === "/admin/api/mcp/book"), false, "the owner said no: nothing was sent");
    assert.equal(toggle.checked, true, "and the switch is as it was");
    assert.equal((await (await mcpRoute(server)).get()).json.enabled, true);

    const accepted = await openPanel(server, { confirm: () => true });
    const second = await until(() => accepted.browser.$("mcp-books").children[0]);
    const slugInput = second.find((node) => node.tagName === "INPUT" && node.type !== "checkbox")[0];
    slugInput.value = "glass-harbor";
    await buttons(second, "Change")[0].click();
    await until(() => accepted.requests.some((request) => request.route === "/admin/api/mcp/book"));
    assert.deepEqual(accepted.requests.find((request) => request.route === "/admin/api/mcp/book").body, { bookId: "glass", slug: "glass-harbor" });
    assert.equal(accepted.confirms.length, 1, "a slug asks too");
  });
});

test("S7B admin panel: the passkeys are listed, and adding one shows the link; the last cannot go before the owner has confirmed", async () => {
  await withServer(async (server, client) => {
    await mcpFixture(server, client);
    await setPublic(server);
    const admin = await adminLogin(server);
    const w = web(server, { host: PUBLIC_HOST });
    const phone = new SoftwarePasskey();
    const ticket = new URL((await admin.call("POST", "/admin/api/passkeys/link", {})).body.url).hash.slice(1);
    await registerPasskey(w, ticket, phone, { label: "Phone" });

    const declined = await openPanel(server, { confirm: () => false });
    const rows = await until(() => (declined.browser.$("passkey-rows").children.length === 1 ? declined.browser.$("passkey-rows").children : null));
    assert.match(rows[0].textContent, /Phone/);
    await buttons(rows[0], "Remove")[0].click();
    await settle(60);
    assert.equal(declined.confirms.length, 1);
    assert.match(declined.confirms[0], /admin code/i, "it says what is left");
    assert.equal(declined.requests.some((request) => request.route === "/admin/api/passkeys/remove"), false);

    const accepted = await openPanel(server, { confirm: () => true });
    const row = await until(() => accepted.browser.$("passkey-rows").children[0]);
    const nameInput = row.find((node) => node.tagName === "INPUT")[0];
    nameInput.value = "Alessandro's phone";
    await buttons(row, "Rename")[0].click();
    await until(() => accepted.requests.some((request) => request.route === "/admin/api/passkeys/rename"));
    assert.deepEqual(accepted.requests.find((request) => request.route === "/admin/api/passkeys/rename").body, { id: phone.id, label: "Alessandro's phone" });

    await accepted.browser.$("passkey-link").click();
    const shown = await until(() => (accepted.browser.$("passkey-link-value").textContent ? accepted.browser.$("passkey-link-value").textContent : null));
    assert.match(shown, new RegExp(`^${PUBLIC_URL}/oauth/passkeys/add#`));
    assert.equal(accepted.browser.$("passkey-link-box").classList.contains("hidden"), false);

    const row2 = await until(() => { const found = accepted.browser.$("passkey-rows").children[0]; return found && /Alessandro/.test(found.find((node) => node.tagName === "INPUT")[0].value) ? found : null; });
    await buttons(row2, "Remove")[0].click();
    await until(() => accepted.requests.some((request) => request.route === "/admin/api/passkeys/remove"));
    assert.deepEqual(accepted.requests.find((request) => request.route === "/admin/api/passkeys/remove").body, { id: phone.id, confirmLast: true });
    await until(async () => (await admin.call("GET", "/admin/api/mcp")).body.passkeys.length === 0);
  });
});

test("S7B admin panel: the audit is a table that loads older calls on demand, and the whole section is in Italian when the panel is", async () => {
  await withServer(async (server, client) => {
    const { rpc } = await mcpFixture(server, client);
    for (let index = 0; index < 25; index += 1) await rpc.call("book_info");
    await server.mcp.audit.flush();
    const english = await openPanel(server);
    const rows = await until(() => (english.browser.$("audit-rows").children.length ? english.browser.$("audit-rows").children : null));
    assert.equal(rows.length, 20, "twenty at first");
    assert.match(rows[0].textContent, /Claude Code.*book_info/s);
    await english.browser.$("audit-more").click();
    await until(() => english.browser.$("audit-rows").children.length === 25);
    assert.equal(english.browser.$("audit-more").classList.contains("hidden"), true, "nothing older: the button goes");
    assert.equal(/undefined|null|NaN/.test(english.browser.$("audit-rows").textContent), false);

    const section = /<section class="card wide" id="mcp">[\s\S]*?<\/section>/.exec(english.html)[0];
    const keys = [...new Set([...section.matchAll(/data-i18n="([^"]+)"/g)].map((match) => match[1]))];
    assert.ok(keys.length >= 10, `the section has its texts: ${keys.length}`);
    const italian = await openPanel(server, { language: "it-IT" });
    for (const key of keys) {
      const inEnglish = english.browser.all(`[data-i18n="${key}"]`)[0]?.textContent;
      const inItalian = italian.browser.all(`[data-i18n="${key}"]`)[0]?.textContent;
      assert.ok(inEnglish && inItalian, key);
      assert.notEqual(inEnglish, key, `${key} has an English text`);
      assert.notEqual(inItalian, key, `${key} has an Italian text`);
      assert.notEqual(inItalian, inEnglish, `${key}: the Italian text is Italian`);
    }
  });
});
