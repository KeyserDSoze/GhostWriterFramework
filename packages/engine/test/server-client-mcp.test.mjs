import test from "node:test";
import assert from "node:assert/strict";
import * as engine from "../dist/index.js";

// New exports are read from the namespace so that, before they exist, each test fails on its own.
const {
  NarrariumServerClient,
  SERVER_FEATURE_AUTOPILOT_CONTROLS,
  SERVER_FEATURE_AUTOPILOT_RULES,
  SERVER_FEATURE_MCP,
  SERVER_FEATURE_MCP_OAUTH,
  ServerRequestError,
  bookRoute,
  serverSupportsAutopilotControls,
  serverSupportsAutopilotRules,
  serverSupportsMcp,
  serverSupportsMcpOAuth,
} = engine;

const BASE = "http://127.0.0.1:24242";

/** A personal server that answers every request with `answer(request)` and remembers each one. */
function fakeServer(answer) {
  const log = [];
  const fetch = async (input, init = {}) => {
    const url = new URL(input);
    log.push({
      method: init.method ?? "GET",
      path: url.pathname,
      search: url.search,
      authorization: init.headers?.authorization,
      contentType: init.headers?.["content-type"],
      accept: init.headers?.accept,
      body: init.body ? JSON.parse(init.body) : undefined,
      rawBody: init.body,
    });
    return answer(log.at(-1));
  };
  return { fetch, log };
}

const client = (server) => new NarrariumServerClient({ baseUrl: BASE, token: "nrs_me", fetch: server.fetch });
const refuse = (status, code, message = "Refused.") => () => Response.json({ code, message }, { status });

/** The status of a book's MCP as a server that has the OAuth server answers it. */
const status = (extra = {}) => ({
  bookId: "my-book",
  enabled: true,
  slug: "my-book",
  path: "/mcp/my-book",
  url: "https://api.example.com/mcp/my-book",
  public: true,
  protocolVersions: ["2025-06-18", "2025-03-26"],
  updatedAt: "2026-11-22T10:00:00.000Z",
  connections: 2,
  oauth: {
    issuer: "https://api.example.com",
    metadataUrl: "https://api.example.com/.well-known/oauth-authorization-server",
    resourceMetadataUrl: "https://api.example.com/.well-known/oauth-protected-resource/mcp/my-book",
    scopes: ["mcp:read", "mcp:write", "mcp:run"],
  },
  ...extra,
});

/** An app connected to a book, as the server lists it. */
const app = (extra = {}) => ({
  id: "Xk3pQ9aT7wRe",
  clientId: "c1-4rNn1sWq0Hh7dA",
  name: "Claude",
  redirectHost: "claude.ai",
  scopes: ["read", "write"],
  createdAt: "2026-11-22T09:00:00.000Z",
  lastUsedAt: "2026-11-22T09:30:00.000Z",
  ...extra,
});

const MCP = "/api/v1/books/my-book/mcp";

// ─── The features a server announces ────────────────────────────────────────

test("a server says whether it has the MCP endpoint of a book, and whether apps can connect to it through OAuth, in the features it announces; a host can ask without a risk", async () => {
  assert.equal(SERVER_FEATURE_MCP, "mcp");
  assert.equal(SERVER_FEATURE_MCP_OAUTH, "mcp-oauth");
  assert.equal(typeof serverSupportsMcp, "function");
  assert.equal(typeof serverSupportsMcpOAuth, "function");
  const base = ["autopilot", "director", "sync", "pairing", "updates", "github"];
  assert.deepEqual([serverSupportsMcp({ features: base }), serverSupportsMcpOAuth({ features: base })], [false, false], "a server from before them announces neither");
  assert.deepEqual([serverSupportsMcp({ features: [...base, "mcp"] }), serverSupportsMcpOAuth({ features: [...base, "mcp"] })], [true, false], "the first release of the endpoint: tokens only, no OAuth");
  assert.deepEqual([serverSupportsMcp({ features: [...base, "mcp", "mcp-oauth"] }), serverSupportsMcpOAuth({ features: [...base, "mcp", "mcp-oauth"] })], [true, true]);
  assert.deepEqual([serverSupportsMcp({ features: ["mcp-oauth"] }), serverSupportsMcpOAuth({ features: ["mcp-oauth"] })], [false, true], "two entries, read one by one: a feature is not taken for the other");
  assert.equal(serverSupportsMcp({ features: [SERVER_FEATURE_AUTOPILOT_CONTROLS, SERVER_FEATURE_AUTOPILOT_RULES] }), false, "the autopilot features are other things");
  assert.equal(serverSupportsAutopilotControls({ features: [...base, "mcp", "mcp-oauth"] }), false, "and so are these");
  assert.equal(serverSupportsAutopilotRules({ features: [...base, "mcp", "mcp-oauth"] }), false);
  for (const info of [undefined, null, {}, { features: undefined }, { features: null }, { features: "mcp" }, { features: [1, null] }, { features: {} }, { features: "mcp-oauth" }, 7, "mcp", "mcp-oauth"]) {
    assert.equal(serverSupportsMcp(info), false, JSON.stringify(info));
    assert.equal(serverSupportsMcpOAuth(info), false, JSON.stringify(info));
  }

  const server = fakeServer(() => Response.json({ name: "narrarium-server", apiVersion: 1, serverVersion: "0.1.8", engineVersion: "0.1.8", serverId: "s", label: "x", git: true, features: [...base, "mcp", "mcp-oauth"] }));
  const info = await client(server).info();
  assert.deepEqual([serverSupportsMcp(info), serverSupportsMcpOAuth(info)], [true, true], "read from what the server's info answers");
});

// ─── The status of a book's MCP ─────────────────────────────────────────────

test("mcpStatus is a GET of the status of the book's MCP, and passes the answer on as the server gave it", async () => {
  const server = fakeServer(() => Response.json(status()));
  const answer = await client(server).mcpStatus("my-book");
  assert.deepEqual(server.log, [{ method: "GET", path: MCP, search: "", authorization: "Bearer nrs_me", contentType: undefined, accept: "application/json", body: undefined, rawBody: undefined }], "one request, with the token and no body");
  assert.deepEqual(answer, status(), "nothing is taken out of it");
  assert.equal(answer.oauth.issuer, "https://api.example.com");
  assert.equal(answer.connections, 2);
});

test("the status of a server that has the endpoint but no OAuth server (no connections, no oauth), or that has no public address (a message), is not a problem for the client", async () => {
  const first = { bookId: "my-book", enabled: false, slug: "my-book", path: "/mcp/my-book", url: "http://127.0.0.1:24242/mcp/my-book", public: false, message: "This server has no public address yet, so this address works only from this computer.", protocolVersions: ["2025-06-18", "2025-03-26"], updatedAt: "2026-11-22T10:00:00.000Z" };
  const answer = await client(fakeServer(() => Response.json(first))).mcpStatus("my-book");
  assert.deepEqual(answer, first, "as it is");
  assert.equal(answer.connections, undefined, "a missing count is unknown, not zero");
  assert.equal(answer.oauth, undefined);
  assert.match(answer.message, /public address/);
  const extra = await client(fakeServer(() => Response.json({ ...first, somethingNew: { a: 1 } }))).mcpStatus("my-book");
  assert.deepEqual(extra.somethingNew, { a: 1 }, "and what a newer server adds is not dropped on the way");
});

test("the id of the book is part of the path of every MCP call, whatever characters it has", async () => {
  const id = "my book/1?x";
  const base = `/api/v1/books/${encodeURIComponent(id)}/mcp`;
  assert.equal(bookRoute(id, "/mcp"), base);
  const server = fakeServer((request) => (request.method === "DELETE" ? Response.json({ revoked: true }) : request.path.endsWith("/clients") ? Response.json({ clients: [] }) : Response.json(status({ bookId: id }))));
  const api = client(server);
  await api.mcpStatus(id);
  await api.updateMcp(id, { enabled: true });
  await api.listMcpClients(id);
  await api.revokeMcpClient(id, "a-grant");
  assert.deepEqual(server.log.map((entry) => `${entry.method} ${entry.path}`), [`GET ${base}`, `PUT ${base}`, `GET ${base}/clients`, `DELETE ${base}/clients/a-grant`]);
  assert.ok(server.log.every((entry) => entry.search === ""), "and nothing goes in a query");
});

// ─── Switching a book's MCP on and off, and its slug ────────────────────────

test("updateMcp is a PUT of what is given, and only that: the switch, the slug, or both; a switch that is false is sent", async () => {
  const server = fakeServer(() => Response.json(status()));
  const api = client(server);
  const calls = [{ enabled: true }, { enabled: false }, { slug: "the-glass-harbor" }, { enabled: true, slug: "glass" }, { enabled: undefined, slug: "only-slug" }, {}];
  for (const input of calls) await api.updateMcp("my-book", input);
  assert.deepEqual(server.log.map((entry) => entry.body), [{ enabled: true }, { enabled: false }, { slug: "the-glass-harbor" }, { enabled: true, slug: "glass" }, { slug: "only-slug" }, {}]);
  assert.ok(server.log.every((entry) => entry.method === "PUT" && entry.path === MCP && entry.authorization === "Bearer nrs_me" && entry.contentType === "application/json"));
  assert.equal(server.log[1].rawBody, JSON.stringify({ enabled: false }), "false is a value, not an absence");
  assert.equal(server.log[5].rawBody, "{}", "and a call with nothing to change sends nothing more: the server says what it thinks of it");
});

test("updateMcp sends nothing but the two things the server reads, and answers the status after the change", async () => {
  const server = fakeServer(({ body }) => Response.json(status({ enabled: body.enabled ?? true, slug: body.slug ?? "my-book", connections: 0 })));
  const answer = await client(server).updateMcp("my-book", { enabled: false, slug: "new-slug", connections: 9, bookId: "other" });
  assert.deepEqual(server.log[0].body, { enabled: false, slug: "new-slug" }, "what is not part of the request is not sent");
  assert.deepEqual([answer.enabled, answer.slug, answer.connections], [false, "new-slug", 0], "a book that is switched off has no connected apps");
});

// ─── The apps connected to a book ───────────────────────────────────────────

test("listMcpClients is a GET of the apps connected to the book and answers the list, entry by entry as the server gave it", async () => {
  const first = app();
  const second = app({ id: "Zz9yY8xX7wVv", clientId: "c2", name: "ChatGPT", redirectHost: "chatgpt.com", scopes: ["read", "write", "run"], lastUsedAt: "2026-11-22T09:45:00.000Z" });
  const server = fakeServer(() => Response.json({ clients: [first, second] }));
  const clients = await client(server).listMcpClients("my-book");
  assert.deepEqual(server.log, [{ method: "GET", path: `${MCP}/clients`, search: "", authorization: "Bearer nrs_me", contentType: undefined, accept: "application/json", body: undefined, rawBody: undefined }]);
  assert.deepEqual(clients, [first, second], "the array, not the object around it");
  assert.deepEqual(clients.map((entry) => entry.name), ["Claude", "ChatGPT"]);
  assert.deepEqual(Object.keys(clients[0]).sort(), ["clientId", "createdAt", "id", "lastUsedAt", "name", "redirectHost", "scopes"]);

  const newer = await client(fakeServer(() => Response.json({ clients: [app({ scopes: ["read", "write", "run", "something-new"], icon: "x.png" })] }))).listMcpClients("my-book");
  assert.deepEqual([newer[0].scopes, newer[0].icon], [["read", "write", "run", "something-new"], "x.png"], "a scope or a field that a newer server adds goes through");
});

test("no app connected is an empty list, and an answer without a list is an empty list too: a host never has to guard for it", async () => {
  assert.deepEqual(await client(fakeServer(() => Response.json({ clients: [] }))).listMcpClients("my-book"), []);
  for (const odd of [{}, { clients: null }, { clients: "none" }, { clients: { a: 1 } }, null, []]) {
    assert.deepEqual(await client(fakeServer(() => Response.json(odd))).listMcpClients("my-book"), [], JSON.stringify(odd));
  }
  assert.deepEqual(await client(fakeServer(() => new Response("", { status: 200 }))).listMcpClients("my-book"), [], "an empty reply");
});

test("revokeMcpClient is a DELETE of one connection, by its id (the connection's, not the app's), with no body, and answers { revoked: true }", async () => {
  const server = fakeServer(() => Response.json({ revoked: true }));
  const answer = await client(server).revokeMcpClient("my-book", "Xk3pQ9aT7wRe");
  assert.deepEqual(server.log, [{ method: "DELETE", path: `${MCP}/clients/Xk3pQ9aT7wRe`, search: "", authorization: "Bearer nrs_me", contentType: undefined, accept: "application/json", body: undefined, rawBody: undefined }]);
  assert.deepEqual(answer, { revoked: true });
  await client(server).revokeMcpClient("my-book", "a/b?c d");
  assert.equal(server.log[1].path, `${MCP}/clients/a%2Fb%3Fc%20d`, "an id with odd characters cannot leave its place in the path");
  assert.equal(server.log[1].search, "");
});

// ─── What the server refuses ────────────────────────────────────────────────

test("what the server refuses comes back as the error the client always gave, with the status and the code of the server", async () => {
  const cases = [
    ["a book that is not there", (api) => api.mcpStatus("nope"), 404, "book_not_found", "This book is not registered on the server."],
    ["a book id the server cannot keep", (api) => api.mcpStatus("con"), 400, "invalid_book", "Invalid book id."],
    ["a slug that is not a slug", (api) => api.updateMcp("my-book", { slug: "Not A Slug" }), 400, "invalid_slug", "A slug has 1 to 80 characters."],
    ["a slug that another book has", (api) => api.updateMcp("my-book", { slug: "taken" }), 409, "slug_taken", 'The slug "taken" belongs to another book.'],
    ["a request with nothing to change", (api) => api.updateMcp("my-book", {}), 400, "invalid_request", "Send `enabled` (true or false) and/or `slug`."],
    ["a book that is not there, to change", (api) => api.updateMcp("nope", { enabled: true }), 404, "book_not_found", "This book is not registered on the server."],
    ["a server about to restart", (api) => api.updateMcp("my-book", { enabled: true }), 503, "maintenance", "The server is about to restart for an update: try again in a minute."],
    ["a token without write, to change", (api) => api.updateMcp("my-book", { enabled: true }), 403, "scope", 'This client token does not have the "write" permission.'],
    ["a token without write, to list the apps", (api) => api.listMcpClients("my-book"), 403, "scope", 'This client token does not have the "write" permission.'],
    ["a book that is not there, to list the apps", (api) => api.listMcpClients("nope"), 404, "book_not_found", "This book is not registered on the server."],
    ["an app that is not connected", (api) => api.revokeMcpClient("my-book", "gone"), 404, "client_missing", "No app with this id is connected to this book."],
    ["a book that is not there, to revoke", (api) => api.revokeMcpClient("nope", "gone"), 404, "book_not_found", "This book is not registered on the server."],
    ["a token that is not valid", (api) => api.mcpStatus("my-book"), 401, "unauthorized", "This client token is not valid or was revoked. Pair this client again."],
  ];
  for (const [name, call, statusCode, code, message] of cases) {
    const server = fakeServer(refuse(statusCode, code, message));
    await assert.rejects(() => call(client(server)), (error) => error instanceof ServerRequestError && error.status === statusCode && error.code === code && error.message === message, name);
  }
});

test("two refusals with the same status are told apart by their code: a book that is not there and an app that is not connected are both 404", async () => {
  const server = fakeServer(({ path }) => (path.includes("/clients/") ? Response.json({ code: "client_missing", message: "No app with this id is connected to this book." }, { status: 404 }) : Response.json({ code: "book_not_found", message: "This book is not registered on the server." }, { status: 404 })));
  const api = client(server);
  const app404 = await api.revokeMcpClient("my-book", "gone").catch((error) => error);
  const book404 = await api.mcpStatus("my-book").catch((error) => error);
  assert.deepEqual([app404.status, app404.code, book404.status, book404.code], [404, "client_missing", 404, "book_not_found"]);
  assert.ok(app404 instanceof ServerRequestError && book404 instanceof ServerRequestError);
});

test("a server from before the MCP routes answers 404 not_found to them: the client says so, as an error a host can recognise; one that cannot be reached, or answers something odd, says that", async () => {
  const old = fakeServer(refuse(404, "not_found", "Unknown endpoint."));
  const api = client(old);
  for (const call of [() => api.mcpStatus("my-book"), () => api.updateMcp("my-book", { enabled: true }), () => api.listMcpClients("my-book"), () => api.revokeMcpClient("my-book", "x")]) {
    await assert.rejects(call, (error) => error instanceof ServerRequestError && error.status === 404 && error.code === "not_found");
  }
  const away = new NarrariumServerClient({ baseUrl: BASE, token: "nrs_me", fetch: async () => { throw new TypeError("fetch failed"); } });
  await assert.rejects(() => away.mcpStatus("my-book"), (error) => error instanceof ServerRequestError && error.code === "unreachable" && error.status === 0);
  await assert.rejects(() => away.listMcpClients("my-book"), (error) => error.code === "unreachable");
  const odd = fakeServer(() => new Response("<html>bad gateway</html>", { status: 502 }));
  await assert.rejects(() => client(odd).mcpStatus("my-book"), (error) => error instanceof ServerRequestError && error.status === 502 && error.code === "invalid_reply");
});

test("a server that has the endpoint but not the OAuth server answers 404 not_found to the list of apps: a host asks serverSupportsMcpOAuth before it offers one", async () => {
  const features = ["autopilot", "pairing", "mcp"];
  const server = fakeServer(({ path }) => (path === "/api/v1/info" ? Response.json({ name: "narrarium-server", apiVersion: 1, serverVersion: "0.1.6", engineVersion: "0.1.6", serverId: "s", label: "x", git: false, features }) : path === MCP ? Response.json({ bookId: "my-book", enabled: true, slug: "my-book", path: "/mcp/my-book", url: "http://127.0.0.1:24242/mcp/my-book", public: false, protocolVersions: ["2025-06-18"], updatedAt: "2026-11-21T10:00:00.000Z" }) : Response.json({ code: "not_found", message: "Unknown endpoint." }, { status: 404 })));
  const api = client(server);
  const info = await api.info();
  assert.deepEqual([serverSupportsMcp(info), serverSupportsMcpOAuth(info)], [true, false]);
  assert.equal((await api.mcpStatus("my-book")).slug, "my-book", "the status works on that server");
  await assert.rejects(() => api.listMcpClients("my-book"), (error) => error.status === 404 && error.code === "not_found");
});
