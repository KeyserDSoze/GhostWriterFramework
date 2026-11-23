import test from "node:test";
import assert from "node:assert/strict";
import * as engine from "../dist/index.js";

// New exports are read from the namespace so that, before they exist, each test fails on its own.
const { NarrariumServerClient, PAUSE_AUTOPILOT_MODES, SERVER_FEATURE_AUTOPILOT_CONTROLS, ServerRequestError, bookRoute, serverSupportsAutopilotControls } = engine;

const BASE = "http://127.0.0.1:24242";

/** A personal server that answers the routes it is given, and remembers every request. */
function fakeServer(routes = {}) {
  // A server of this version: the client asks its features before it starts or configures (`autopilot-outline-brief`).
  routes = { "GET /api/v1/info": () => Response.json({ name: "narrarium-server", apiVersion: 1, serverVersion: "0.1.12", engineVersion: "0.1.12", serverId: "s", label: "x", git: true, features: ["autopilot", "autopilot-controls", "autopilot-outline-brief"], publicKey: "k", fingerprint: "f", supervised: false }), ...routes };
  const log = [];
  const fetch = async (input, init = {}) => {
    const url = new URL(input);
    const method = init.method ?? "GET";
    const body = init.body ? JSON.parse(init.body) : undefined;
    log.push({ method, path: url.pathname, authorization: init.headers?.authorization, contentType: init.headers?.["content-type"], body, rawBody: init.body });
    const answer = routes[`${method} ${url.pathname}`];
    return answer ? answer(body) : Response.json({ code: "not_found", message: "This route does not exist." }, { status: 404 });
  };
  return { fetch, log };
}

const client = (server) => new NarrariumServerClient({ baseUrl: BASE, token: "nrs_me", fetch: server.fetch });

/** The snapshot of a book that has a pause waiting, as a server that knows the quick controls answers it. */
const snapshot = (extra = {}) => ({
  bookId: "my-book",
  state: null,
  activities: [],
  live: null,
  running: true,
  host: "server",
  summary: { status: "running", pausePending: "after-chapter", limits: null, publish: "chapter" },
  ...extra,
});

const PAUSE = "POST /api/v1/books/my-book/autopilot/pause";
const START = "POST /api/v1/books/my-book/autopilot/start";
const OPTIONS = "PUT /api/v1/books/my-book/autopilot/options";

// ─── Q4: pause, limits and options through the client ───────────────────────

test("pauseAutopilot sends every mode, among them the pause at the end of the chapter and the cancel of a pause that is waiting", async () => {
  assert.deepEqual([...PAUSE_AUTOPILOT_MODES], ["now", "after-step", "after-chapter", "cancel"], "the modes a server accepts, in one list");
  const server = fakeServer({ [PAUSE]: () => Response.json(snapshot()) });
  const answers = [];
  for (const mode of PAUSE_AUTOPILOT_MODES) answers.push(await client(server).pauseAutopilot("my-book", mode));
  assert.deepEqual(server.log.map((entry) => [entry.method, entry.path, entry.body]), ["now", "after-step", "after-chapter", "cancel"].map((mode) => ["POST", "/api/v1/books/my-book/autopilot/pause", { mode }]));
  assert.ok(server.log.every((entry) => entry.authorization === "Bearer nrs_me" && entry.contentType === "application/json"));
  assert.equal(answers[2].summary.pausePending, "after-chapter", "the answer is the snapshot, with the summary a newer server sends");
  assert.deepEqual(answers[0], snapshot(), "and nothing is taken out of it");
});

test("startAutopilot sends the limits of the run with the rest of the request, and a server that does not know them is not a problem for the client", async () => {
  const server = fakeServer({ [START]: () => Response.json(snapshot({ summary: undefined })) });
  const input = { brief: { idea: "x", targetChapters: 3 }, options: { pauseAfterPlan: false, publishEvery: "step" }, limits: { steps: 1, chapters: 2 }, force: true };
  const answer = await client(server).startAutopilot("my-book", input);
  assert.deepEqual(server.log.find((request) => request.path === "/api/v1/books/my-book/autopilot/start").body, input, "everything goes in the body, as it was given");
  assert.equal(answer.summary, undefined, "an older server answers a snapshot without a summary: the client passes it on as it is");
  await client(server).startAutopilot("my-book");
  assert.deepEqual(server.log.filter((request) => request.path === "/api/v1/books/my-book/autopilot/start").at(-1).body, {}, "a plain start still sends nothing else");
});

test("updateAutopilotOptions is a PUT of the two settings, and answers the snapshot like configure does; updateOptions is the same call", async () => {
  const server = fakeServer({ [OPTIONS]: () => Response.json(snapshot({ summary: { status: "running", pausePending: null, limits: null, publish: "step" } })) });
  const api = client(server);
  assert.equal(typeof api.updateAutopilotOptions, "function");
  const answer = await api.updateAutopilotOptions("my-book", { publishEvery: "step", pauseAfterEachChapter: true });
  assert.deepEqual(server.log[0], { method: "PUT", path: "/api/v1/books/my-book/autopilot/options", authorization: "Bearer nrs_me", contentType: "application/json", body: { publishEvery: "step", pauseAfterEachChapter: true }, rawBody: JSON.stringify({ publishEvery: "step", pauseAfterEachChapter: true }) });
  assert.equal(answer.summary.publish, "step");
  assert.equal(answer.running, true);

  assert.equal(typeof api.updateOptions, "function", "the short name");
  await api.updateOptions("my-book", { publishEvery: null });
  assert.deepEqual(server.log[1].body, { publishEvery: null }, "null is sent: it takes the choice back");
  await api.updateOptions("my-book", { pauseAfterEachChapter: false });
  assert.deepEqual(server.log[2].body, { pauseAfterEachChapter: false }, "and only what is given is sent");
  assert.deepEqual(server.log.map((entry) => entry.method + " " + entry.path), [OPTIONS, OPTIONS, OPTIONS]);
});

test("the id of the book is part of the path, whatever characters it has", async () => {
  const id = "my book/1?x";
  const path = `/api/v1/books/${encodeURIComponent(id)}/autopilot/options`;
  const server = fakeServer({ [`PUT ${path}`]: () => Response.json(snapshot({ bookId: id })) });
  assert.equal(bookRoute(id, "/autopilot/options"), path);
  const answer = await client(server).updateAutopilotOptions(id, { publishEvery: "off" });
  assert.equal(answer.bookId, id);
  assert.equal(new URL(`${BASE}${path}`).pathname, path);
});

test("what the server refuses comes back as the error the client always gave, with the status and the code of the server", async () => {
  const refuse = (status, code, message) => () => Response.json({ code, message }, { status });
  const server = fakeServer({
    [OPTIONS]: refuse(400, "invalid_request", "publishEvery must be off, chapter, step or null."),
    [PAUSE]: refuse(400, "invalid_request", "The pause mode is not known."),
    [START]: refuse(409, "busy", "The autopilot of this book is already running."),
  });
  const api = client(server);
  await assert.rejects(() => api.updateAutopilotOptions("my-book", { publishEvery: "weekly" }), (error) => error instanceof ServerRequestError && error.status === 400 && error.code === "invalid_request" && /publishEvery/.test(error.message));
  await assert.rejects(() => api.pauseAutopilot("my-book", "cancel"), (error) => error instanceof ServerRequestError && error.status === 400);
  await assert.rejects(() => api.startAutopilot("my-book", { limits: { steps: 1 } }), (error) => error instanceof ServerRequestError && error.status === 409 && error.code === "busy");

  const conflict = fakeServer({ [OPTIONS]: refuse(409, "conflict", "File changed since it was read: autopilot/state.json") });
  await assert.rejects(() => client(conflict).updateAutopilotOptions("my-book", { publishEvery: "step" }), (error) => error.status === 409 && error.code === "conflict");
  const corrupt = fakeServer({ [OPTIONS]: refuse(409, "state_corrupt", "The autopilot state file cannot be read.") });
  await assert.rejects(() => client(corrupt).updateAutopilotOptions("my-book", { publishEvery: "step" }), (error) => error.status === 409 && error.code === "state_corrupt");
});

test("a server from before the controls answers 404 to the new route: the client says so, as an error a host can recognise", async () => {
  const old = fakeServer({ [PAUSE]: () => Response.json(snapshot({ summary: undefined })) });
  await assert.rejects(() => client(old).updateAutopilotOptions("my-book", { publishEvery: "step" }), (error) => error instanceof ServerRequestError && error.status === 404 && error.code === "not_found");
  const away = new NarrariumServerClient({ baseUrl: BASE, token: "nrs_me", fetch: async () => { throw new TypeError("fetch failed"); } });
  await assert.rejects(() => away.updateAutopilotOptions("my-book", { publishEvery: "step" }), (error) => error instanceof ServerRequestError && error.code === "unreachable");
});

test("a server says whether it knows the quick controls in the features it announces, and a host can ask before it sends what an older server would take for something else", async () => {
  assert.equal(SERVER_FEATURE_AUTOPILOT_CONTROLS, "autopilot-controls");
  assert.equal(typeof serverSupportsAutopilotControls, "function");
  const base = ["autopilot", "director", "sync", "pairing", "updates", "github"];
  assert.equal(serverSupportsAutopilotControls({ features: [...base, SERVER_FEATURE_AUTOPILOT_CONTROLS] }), true);
  assert.equal(serverSupportsAutopilotControls({ features: base }), false, "a server from before them does not announce it");
  for (const info of [undefined, null, {}, { features: undefined }, { features: null }, { features: "autopilot-controls" }, { features: [1, null] }]) assert.equal(serverSupportsAutopilotControls(info), false, JSON.stringify(info));

  const server = fakeServer({ "GET /api/v1/info": () => Response.json({ name: "narrarium-server", apiVersion: 1, serverVersion: "0.1.4", engineVersion: "0.1.4", serverId: "s", label: "x", git: true, features: [...base, SERVER_FEATURE_AUTOPILOT_CONTROLS] }) });
  assert.equal(serverSupportsAutopilotControls(await client(server).info()), true, "read from what the server's info answers");
});
