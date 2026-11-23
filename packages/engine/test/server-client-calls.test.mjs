import test from "node:test";
import assert from "node:assert/strict";
import * as engine from "../dist/index.js";

// The routes of the AI call records go only to a server that announces `autopilot-calls`: the engine's client refuses the others before it sends anything, and speaks the routes' own words to the
// ones that do (what each method sends, and what it gives back as it came).

/** A personal server that announces `features` and answers each call with `answers[method + " " + path]` (a value, or a function of the request); every request is remembered. */
function fakeServer(features, answers = {}) {
  const log = [];
  const fetch = async (input, init = {}) => {
    const url = new URL(input);
    const request = { method: init.method ?? "GET", path: url.pathname, search: url.search, body: init.body === undefined ? undefined : JSON.parse(init.body), authorization: init.headers?.authorization };
    log.push(request);
    if (url.pathname === "/api/v1/info") return Response.json({ name: "narrarium-server", apiVersion: 1, serverVersion: "0.1.15", engineVersion: "0.1.13", serverId: "s", label: "Test", git: true, features });
    const answer = answers[`${request.method} ${request.path}`];
    const value = typeof answer === "function" ? answer(request) : answer;
    if (value?.httpStatus) return Response.json(value.body ?? {}, { status: value.httpStatus });
    return Response.json(value ?? {});
  };
  return { fetch, log };
}

const clientOf = (server) => new engine.NarrariumServerClient({ baseUrl: "http://127.0.0.1:24242", token: "nrs_me", fetch: server.fetch });
const WITH = ["autopilot", "autopilot-calls"];
const WITHOUT = ["autopilot", "autopilot-outline-brief"];

const HEADER = { bookId: "b", activityId: "activity_1", title: "Write chapter 1", kind: "write", chapter: 1, scene: null, status: "done", startedAt: "2026-11-23T10:00:00.000Z", endedAt: "2026-11-23T10:01:00.000Z", calls: 2, bytes: 1234, pinned: false };

test("a server says it keeps the AI call records with the feature autopilot-calls; reading it never throws", () => {
  assert.equal(engine.SERVER_FEATURE_AUTOPILOT_CALLS, "autopilot-calls");
  assert.equal(engine.serverHasCalls({ features: WITH }), true);
  assert.equal(engine.serverHasCalls(WITH), true, "a list of features is read as well");
  assert.equal(engine.serverHasCalls({ features: WITHOUT }), false);
  for (const odd of [null, undefined, {}, { features: "autopilot-calls" }, "autopilot-calls", 7, { features: [7] }]) assert.equal(engine.serverHasCalls(odd), false, JSON.stringify(odd));
});

test("the limits of the routes are what the server enforces, and the three fields are the three texts of a call", () => {
  assert.deepEqual([engine.SERVER_CALLS_PAGE_LIMIT, engine.SERVER_CALLS_MAX_PAGE_LIMIT, engine.SERVER_CALL_TEXT_MAX_BYTES], [20, 100, 256 * 1024]);
  assert.deepEqual([...engine.SERVER_CALL_FIELDS], ["system", "user", "response"]);
});

test("a server that does not announce autopilot-calls is refused before anything but its features is sent: 501 feature_unavailable, in the style of the other features", async () => {
  const calls = [
    (api) => api.listCalls("b"),
    (api) => api.readCallTask("b", "activity_1"),
    (api) => api.readCallText("b", "activity_1-0001", { field: "system" }),
    (api) => api.keepCallTask("b", "activity_1", true),
    (api) => api.deleteCalls("b"),
  ];
  for (const call of calls) {
    const old = fakeServer(WITHOUT);
    const error = await call(clientOf(old)).then(() => null, (failure) => failure);
    assert.ok(error instanceof engine.ServerRequestError, String(error));
    assert.deepEqual([error.status, error.code], [501, "feature_unavailable"]);
    assert.match(error.message, /autopilot-calls/);
    assert.match(error.message, /update the server/i);
    assert.deepEqual(old.log.map((request) => request.path), ["/api/v1/info"], "only the server's features were asked: nothing was sent");
  }
});

test("listCalls sends the page it was given and gives back the page as the server made it", async () => {
  const page = { tasks: [HEADER], next: "2026-11-23T10:00:00.000Z|activity_1" };
  const server = fakeServer(WITH, { "GET /api/v1/books/b/autopilot/calls": page });
  const api = clientOf(server);
  assert.deepEqual(await api.listCalls("b"), page);
  assert.deepEqual(await api.listCalls("b", { before: "2026-11-23T10:00:00.000Z|activity_1", limit: 5 }), page);
  const requests = server.log.filter((request) => request.path !== "/api/v1/info");
  assert.deepEqual(requests.map((request) => [request.method, request.search]), [["GET", ""], ["GET", `?before=${encodeURIComponent("2026-11-23T10:00:00.000Z|activity_1")}&limit=5`]]);
  assert.ok(requests.every((request) => request.authorization === "Bearer nrs_me"));
});

test("readCallTask names the task in the address, and a book or a task with odd characters is encoded", async () => {
  const task = { header: HEADER, calls: [] };
  const server = fakeServer(WITH, { "GET /api/v1/books/my%20book/autopilot/calls/tasks/activity_1": task });
  assert.deepEqual(await clientOf(server).readCallTask("my book", "activity_1"), task);
  const missing = fakeServer(WITH, { "GET /api/v1/books/b/autopilot/calls/tasks/activity_x": { httpStatus: 404, body: { code: "call_task_not_found", message: "No such task." } } });
  const error = await clientOf(missing).readCallTask("b", "activity_x").then(() => null, (failure) => failure);
  assert.deepEqual([error.status, error.code], [404, "call_task_not_found"], "a refusal keeps the code of the server");
});

test("readCallText asks for a field, from an offset, at most so many bytes, and gives the piece as it came", async () => {
  const piece = { text: "héllo", from: 0, next: 6, size: 6, attempt: 1, done: true };
  const server = fakeServer(WITH, { "GET /api/v1/books/b/autopilot/calls/activity_1-0001/text": piece });
  const api = clientOf(server);
  assert.deepEqual(await api.readCallText("b", "activity_1-0001", { field: "response" }), piece);
  assert.deepEqual(await api.readCallText("b", "activity_1-0001", { field: "response", attempt: 2, from: 10, limit: 100 }), piece);
  assert.deepEqual(await api.readCallText("b", "activity_1-0001", { field: "user", from: 0 }), piece);
  const searches = server.log.filter((request) => request.path !== "/api/v1/info").map((request) => request.search);
  assert.deepEqual(searches, ["?field=response", "?field=response&attempt=2&from=10&limit=100", "?field=user&from=0"]);
});

test("keepCallTask sends only {pinned} to the task and gives back its header; deleteCalls sends nothing and says what it removed", async () => {
  const server = fakeServer(WITH, {
    "PUT /api/v1/books/b/autopilot/calls/tasks/activity_1/keep": (request) => ({ ...HEADER, pinned: request.body.pinned }),
    "DELETE /api/v1/books/b/autopilot/calls": { deleted: true, tasks: 3, calls: 9, bytes: 4096 },
  });
  const api = clientOf(server);
  assert.equal((await api.keepCallTask("b", "activity_1", true)).pinned, true);
  assert.equal((await api.keepCallTask("b", "activity_1", false)).pinned, false);
  assert.deepEqual(await api.deleteCalls("b"), { deleted: true, tasks: 3, calls: 9, bytes: 4096 });
  const requests = server.log.filter((request) => request.path !== "/api/v1/info");
  assert.deepEqual(requests.map((request) => [request.method, request.body]), [["PUT", { pinned: true }], ["PUT", { pinned: false }], ["DELETE", undefined]]);
});

test("the features are asked once while they are not known, and not again once the server has said yes; a server that is updated meanwhile is found", async () => {
  let features = WITHOUT;
  const log = [];
  const fetch = async (input, init = {}) => {
    const url = new URL(input);
    log.push(`${init.method ?? "GET"} ${url.pathname}`);
    if (url.pathname === "/api/v1/info") return Response.json({ name: "narrarium-server", apiVersion: 1, serverVersion: "0.1.15", engineVersion: "0.1.13", serverId: "s", label: "Test", git: true, features });
    return Response.json({ tasks: [], next: null });
  };
  const api = new engine.NarrariumServerClient({ baseUrl: "http://127.0.0.1:24242", token: "nrs_me", fetch });
  await assert.rejects(api.listCalls("b"), (error) => error.code === "feature_unavailable");
  features = WITH;
  assert.deepEqual(await api.listCalls("b"), { tasks: [], next: null });
  await api.listCalls("b");
  await api.listCalls("b");
  assert.equal(log.filter((line) => line.endsWith("/api/v1/info")).length, 2, "one question that was answered no, one that was answered yes: no more");
});
