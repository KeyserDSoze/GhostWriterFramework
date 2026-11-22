import test from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import { writeFile } from "node:fs/promises";
import path from "node:path";
import { createFakeAutopilotAi } from "narrarium-engine/testing";
import * as testing from "../dist/testing.mjs";
import { noRelease, withServer } from "./helpers.mjs";
import { rawApi } from "./api-helpers.mjs";
import { enableMcp, issueToken, mcpBook, mcpClient, mcpFixture, mcpRoute } from "./mcp-helpers.mjs";

// The per-book MCP endpoint, its switch and its access (S7, phase A): what a book's address is, who may reach it, and what it never says.
// The protocol itself is in mcp-protocol.test.mjs, the tools in mcp-tools.test.mjs, the official client in mcp-sdk.test.mjs.

const PING = { jsonrpc: "2.0", id: 1, method: "ping" };

test("S7: `info.features` announces `mcp`, next to everything it announced before", async () => {
  await withServer(async (server) => {
    const info = await (await fetch(`${server.url}/api/v1/info`)).json();
    assert.ok(info.features.includes("mcp"), JSON.stringify(info.features));
    for (const feature of ["autopilot", "director", "sync", "pairing", "updates", "spend", "autopilot-controls", "autopilot-rules"]) assert.ok(info.features.includes(feature), `${feature} is still announced`);
    assert.equal(new Set(info.features).size, info.features.length, "each feature once");
  });
});

test("S7: a book's MCP is off until the owner switches it on, and its status says where it would be: a slug made from the title, the local address while the server knows no public one", async () => {
  await withServer(async (server, client) => {
    await mcpBook(client, "jungle", "Il Grande Libro della Giungla — Èdizione Città");
    const route = await mcpRoute(server, "jungle");
    const status = await route.get();
    const slug = "il-grande-libro-della-giungla-edizione-citta";
    assert.equal(status.status, 200);
    assert.deepEqual(
      { bookId: status.json.bookId, enabled: status.json.enabled, slug: status.json.slug, path: status.json.path, url: status.json.url, public: status.json.public },
      { bookId: "jungle", enabled: false, slug, path: `/mcp/${slug}`, url: `${server.url}/mcp/${slug}`, public: false },
    );
    assert.match(status.json.message, /public address/i, "it says why the address is the local one");
    assert.deepEqual(status.json.protocolVersions, ["2025-06-18", "2025-03-26"]);

    const token = await issueToken(server);
    const off = await mcpClient(server, slug, token).request("ping");
    assert.equal(off.status, 404, "off: the address is not there for anybody");

    await server.data.updateConfig((config) => {
      config.publicUrl = "https://api.example.test";
    });
    const published = (await route.get()).json;
    assert.equal(published.url, `https://api.example.test/mcp/${slug}`, "the address is the one the owner gave the server");
    assert.equal(published.public, true);
    assert.equal("message" in published, false, "and there is nothing to explain");
  });
});

test("S7: PUT switches a book on and off and lets the owner choose the slug: not valid is 400, taken is 409, a book that is not there is 404, an empty request is 400; GET needs read and PUT write", async () => {
  await withServer(async (server, client) => {
    await mcpBook(client, "one", "Moon Book");
    await mcpBook(client, "two", "Sun Book");
    const one = await mcpRoute(server, "one");
    const two = await mcpRoute(server, "two");

    const on = await one.put({ enabled: true });
    assert.equal(on.status, 200);
    assert.deepEqual([on.json.enabled, on.json.slug], [true, "moon-book"]);
    const renamed = await one.put({ slug: "luna" });
    assert.deepEqual([renamed.json.enabled, renamed.json.slug, renamed.json.url], [true, "luna", `${server.url}/mcp/luna`], "choosing a slug leaves the switch where it was");
    const both = await one.put({ enabled: false, slug: "luna-nova" });
    assert.deepEqual([both.json.enabled, both.json.slug], [false, "luna-nova"]);
    assert.deepEqual((await one.get()).json.slug, "luna-nova", "and what was said is kept");

    for (const slug of ["", "Moon", "a_b", "-x", "x-", "a--b", "a b", "ä", "x".repeat(81), 5, null, ["a"], { a: 1 }]) {
      const refused = await one.put({ slug });
      assert.equal(refused.status, 400, JSON.stringify(slug));
      assert.equal(refused.json.code, "invalid_slug", JSON.stringify(slug));
    }
    for (const body of [{ enabled: "yes" }, { enabled: 1 }, {}, { other: true }]) {
      const refused = await one.put(body);
      assert.equal(refused.status, 400, JSON.stringify(body));
      assert.equal(refused.json.code, "invalid_request", JSON.stringify(body));
    }
    assert.equal((await one.get()).json.slug, "luna-nova", "a refused request changes nothing");

    const taken = await two.put({ slug: "luna-nova" });
    assert.deepEqual([taken.status, taken.json.code], [409, "slug_taken"], "a slug is the book's, whether its MCP is on or not");
    assert.equal((await one.put({ slug: "luna-nova" })).status, 200, "a book keeps its own slug without a conflict");

    const ghost = await mcpRoute(server, "ghost");
    assert.equal((await ghost.get()).status, 404);
    assert.equal((await ghost.put({ enabled: true })).status, 404);
    assert.equal((await ghost.get()).json.code, "book_not_found");

    const reader = await rawApi(server, ["read"]);
    assert.equal((await reader("GET", "/api/v1/books/one/mcp")).status, 200);
    const refused = await reader("PUT", "/api/v1/books/one/mcp", { enabled: true });
    assert.deepEqual([refused.status, refused.json.code], [403, "scope"]);
    const writer = await rawApi(server, ["write"]);
    assert.deepEqual([(await writer("GET", "/api/v1/books/one/mcp")).status, (await writer("PUT", "/api/v1/books/one/mcp", { enabled: false })).status], [403, 200]);
  });
});

test("S7: the slug is stable and unique: a new title does not move the address, a title shared by two books gets -2, a script without letters of ours falls back to the book id, and a removed book frees its slug", async () => {
  await withServer(async (server, client) => {
    const slugOf = async (id) => (await (await mcpRoute(server, id)).get()).json.slug;
    await mcpBook(client, "a1", "Twin Title");
    await mcpBook(client, "a2", "Twin Title");
    await mcpBook(client, "ru", "Книга джунглей");
    await mcpBook(client, "JP_Book.1", "日本語の本");
    await mcpBook(client, "long", `${"word ".repeat(40)}end`);
    assert.deepEqual([await slugOf("a1"), await slugOf("a2"), await slugOf("ru"), await slugOf("JP_Book.1")], ["twin-title", "twin-title-2", "ru", "jp-book-1"]);
    const long = await slugOf("long");
    assert.ok(long.length <= 60 && /^[a-z0-9]+(-[a-z0-9]+)*$/.test(long), `a long title makes a short, valid slug: ${long}`);

    await client.registerBook("a1", { title: "Another Title Entirely", storage: { kind: "local" } });
    assert.equal(await slugOf("a1"), "twin-title", "a new title does not move the address");

    const api = await rawApi(server);
    const token = await issueToken(server);
    await (await mcpRoute(server, "a2")).put({ enabled: true });
    assert.equal((await mcpClient(server, "twin-title-2", token).request("ping")).status, 200);
    assert.equal((await api("DELETE", "/api/v1/books/a2")).status, 200);
    assert.equal((await mcpClient(server, "twin-title-2", token).request("ping")).status, 404, "a removed book has no address");
    await mcpBook(client, "a3", "Twin Title");
    assert.equal(await slugOf("a3"), "twin-title-2", "and its slug is free again");
    assert.equal((await mcpClient(server, "twin-title-2", token).request("ping")).status, 404, "but the new book's MCP is off");
  });
});

test("S7: the switch and the slugs are kept in the data folder across a restart, and a file that is damaged leaves every book off", async () => {
  await withServer(async (server, client, dataDir) => {
    const { slug, token } = await mcpFixture(server, client);
    await (await mcpRoute(server)).put({ slug: "my-glass" });
    await server.close();
    const options = { dataDir, port: 0, adminPort: 0, ai: createFakeAutopilotAi(), supervised: false, checkRelease: noRelease, tunnel: { findBinary: () => undefined, detectOtherConnectors: async () => [] } };
    const again = await testing.startNarrariumServer(options);
    try {
      assert.equal((await mcpClient(again, "my-glass", token).request("ping")).status, 200, "still on, at the slug the owner chose");
      assert.equal((await mcpClient(again, slug, token).request("ping")).status, 404, "and the old address is gone");
    } finally {
      await again.close();
    }
    await writeFile(path.join(dataDir, "mcp.json"), "{ this is not json");
    const lines = [];
    const damaged = await testing.startNarrariumServer({ ...options, log: (line) => lines.push(line) });
    try {
      assert.ok(lines.some((line) => /mcp\.json/.test(line)), `the log says what happened: ${lines.join(" | ")}`);
      assert.equal((await mcpClient(damaged, "my-glass", token).request("ping")).status, 404, "off: nothing opens by accident");
      const route = await mcpRoute(damaged);
      assert.equal((await route.get()).json.enabled, false);
      assert.equal((await route.put({ enabled: true })).status, 200, "the owner can switch it on again");
      assert.equal((await mcpClient(damaged, (await route.get()).json.slug, token).request("ping")).status, 200);
    } finally {
      await damaged.close();
    }
  });
});

test("S7: switching a book off closes its address at once, for the tokens already issued too, and a book that is off answers exactly what an address that never existed answers", async () => {
  await withServer(async (server, client) => {
    const { slug, token, rpc } = await mcpFixture(server, client);
    assert.equal((await rpc.request("ping")).status, 200);
    const route = await mcpRoute(server);
    assert.equal((await route.put({ enabled: false })).status, 200);
    const off = await rpc.request("ping");
    const never = await mcpClient(server, "never-existed", token).request("ping");
    assert.equal(off.status, 404);
    assert.equal(off.text, never.text, "the same words: nothing tells which books there are");
    for (const suffix of ["/other", "/", "/.."]) {
      const response = await fetch(`${server.url}/mcp/${slug}${suffix}`, { method: "POST", headers: { authorization: `Bearer ${token}`, "content-type": "application/json" }, body: JSON.stringify(PING) });
      assert.equal(response.status, 404, suffix || "(root)");
    }
    assert.equal((await mcpClient(server, "", token).request("ping")).status, 404, "/mcp/ alone is not an address either");
    assert.equal((await route.put({ enabled: true })).status, 200);
    assert.equal((await rpc.request("ping")).status, 200, "back on, at the same address");
  });
});

test("S7: no token, a wrong token and a revoked one are 401 with WWW-Authenticate: Bearer, a token without the read permission is 403, and none of them learns whether the book exists", async () => {
  await withServer(async (server, client) => {
    const { slug, rpc } = await mcpFixture(server, client);
    const missing = await mcpClient(server, slug).request("ping");
    assert.equal(missing.status, 401);
    assert.match(missing.headers.get("www-authenticate"), /^Bearer\b/);
    assert.equal(missing.json.code, "unauthorized");
    const wrong = await mcpClient(server, slug, "nrs_not-a-token").request("ping");
    assert.equal(wrong.status, 401);
    assert.match(wrong.headers.get("www-authenticate"), /^Bearer\b[^]*invalid_token/);
    const nowhere = await mcpClient(server, "no-such-book", "nrs_not-a-token").request("ping");
    assert.deepEqual([nowhere.status, nowhere.text], [401, wrong.text], "the same answer, whether the book is there or not");

    const { token, clientId } = await server.auth.issue("short lived", ["read"]);
    const shortLived = mcpClient(server, slug, token);
    assert.equal((await shortLived.request("ping")).status, 200);
    await server.auth.revoke(clientId);
    const revoked = await shortLived.request("ping");
    assert.equal(revoked.status, 401, "a token that is revoked reaches nothing, at once");
    assert.match(revoked.headers.get("www-authenticate"), /^Bearer\b/);

    for (const scopes of [["write"], ["run"], ["update"], ["write", "run"]]) {
      const forbidden = await mcpClient(server, slug, await issueToken(server, "no read", scopes)).request("ping");
      assert.deepEqual([forbidden.status, forbidden.json.code], [403, "scope"], scopes.join());
    }
    assert.equal((await rpc.request("ping")).status, 200, "and the client that may read is served");
  });
});

test("S7: the request log has the address of the endpoint and never the token or the query that came with it", async () => {
  const lines = [];
  await withServer(async (server, client) => {
    const { slug, token } = await mcpFixture(server, client);
    const headers = { authorization: `Bearer ${token}`, "content-type": "application/json" };
    const answer = await fetch(`${server.url}/mcp/${slug}?access_token=${token}&password=SECRETQUERY`, { method: "POST", headers, body: JSON.stringify(PING) });
    assert.equal(answer.status, 200);
    const refused = await fetch(`${server.url}/mcp/${slug}?access_token=QUERYTOKEN-2`, { method: "POST", headers: { authorization: "Bearer nrs_wrong-1234", "content-type": "application/json" }, body: JSON.stringify(PING) });
    assert.equal(refused.status, 401);
    assert.ok(lines.some((line) => line.includes(`POST /mcp/${slug}?*** 200`)), `the call is logged, its query hidden: ${lines.filter((line) => line.includes("/mcp/")).join(" | ")}`);
    assert.ok(lines.some((line) => line.includes(`POST /mcp/${slug}?*** 401`)), "and so is the refusal");
    const all = lines.join("\n");
    for (const secret of [token, "SECRETQUERY", "QUERYTOKEN-2", "nrs_wrong-1234", "access_token"]) assert.equal(all.includes(secret), false, `${secret} is not in the log`);
  }, { log: (line) => lines.push(line) });
});

test("S7: a browser origin that was never approved is refused as on every route, with no CORS header; an approved one is answered as it always was", async () => {
  await withServer(async (server, client) => {
    const { rpc } = await mcpFixture(server, client);
    const foreign = await rpc.post(PING, { origin: "https://evil.example" });
    assert.deepEqual([foreign.status, foreign.json.code], [403, "origin_not_allowed"]);
    assert.equal(foreign.headers.get("access-control-allow-origin"), null);
    const preflight = await fetch(rpc.url, { method: "OPTIONS", headers: { origin: "https://evil.example", "access-control-request-method": "POST" } });
    assert.equal(preflight.status, 403);
    assert.equal(preflight.headers.get("access-control-allow-origin"), null);
    const approved = await rpc.post(PING, { origin: "https://narrarium.net" });
    assert.equal(approved.status, 200);
    assert.equal(approved.headers.get("access-control-allow-origin"), "https://narrarium.net");
    assert.equal((await rpc.post(PING)).headers.get("access-control-allow-origin"), null, "a client that is no browser gets no CORS header");
  });
});

test("S7: where one public address reaches the admin port (the panel and the API behind one hostname), the MCP address is carried to the API as /api/v1 is, and still needs its token", async () => {
  /** A request to the admin port with the Host of the public address (fetch cannot set it). */
  const viaAdmin = (server, slug, headers) => new Promise((resolve, reject) => {
    const request = http.request(`${server.adminUrl}/mcp/${slug}`, { method: "POST", headers: { host: "books.example.com", "content-type": "application/json", ...headers } }, (response) => {
      const chunks = [];
      response.on("data", (chunk) => chunks.push(chunk));
      response.on("end", () => resolve({ status: response.statusCode, headers: response.headers, text: Buffer.concat(chunks).toString("utf8") }));
    });
    request.on("error", reject);
    request.end(JSON.stringify(PING));
  });
  await withServer(async (server, client) => {
    const { slug, token } = await mcpFixture(server, client);
    await server.data.updateConfig((config) => {
      config.publicUrl = "https://books.example.com";
      config.adminPublicUrl = "https://books.example.com";
      config.allowRemoteAdmin = true;
    });
    const answered = await viaAdmin(server, slug, { authorization: `Bearer ${token}` });
    assert.deepEqual([answered.status, JSON.parse(answered.text)], [200, { jsonrpc: "2.0", id: 1, result: {} }]);
    const anonymous = await viaAdmin(server, slug, {});
    assert.equal(anonymous.status, 401, "the gateway does not bypass the token");
    assert.match(anonymous.headers["www-authenticate"], /^Bearer\b/, "and the API's own refusal is what comes back");
    await server.data.updateConfig((config) => {
      config.allowRemoteAdmin = false;
    });
    assert.equal((await viaAdmin(server, slug, { authorization: `Bearer ${token}` })).status, 403, "with the panel closed to the public address, nothing is carried");
  });
});

test("S7: a slug is made from a title by taking the accents off and joining the words with hyphens; a slug the owner types is never corrected into one", () => {
  const { slugFromTitle, assertSlug } = testing;
  assert.equal(slugFromTitle("Il Grande Libro della Giungla", "b"), "il-grande-libro-della-giungla");
  assert.equal(slugFromTitle("  Èdizione   Città — 2nd: the *Final* one!  ", "b"), "edizione-citta-2nd-the-final-one");
  assert.equal(slugFromTitle("Книга джунглей", "My_Book.2"), "my-book-2", "no letter of ours: the book's id");
  assert.equal(slugFromTitle("日本語", "___"), "book", "and when even the id has nothing to give");
  const long = slugFromTitle("alpha ".repeat(30), "b");
  assert.ok(long.length <= 60 && !long.endsWith("-") && /^(alpha-)*alpha$/.test(long), `cut at a hyphen: ${long}`);
  for (const good of ["a", "my-book", "book-2", "x".repeat(80)]) assert.equal(assertSlug(good), good);
  for (const bad of ["", "My-Book", "my_book", "my book", "-a", "a-", "a--b", "è", "x".repeat(81), undefined, null, 5, []]) {
    assert.throws(() => assertSlug(bad), (error) => error.status === 400 && error.code === "invalid_slug", JSON.stringify(bad));
  }
});
