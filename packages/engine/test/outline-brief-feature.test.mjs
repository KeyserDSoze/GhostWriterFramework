import test from "node:test";
import assert from "node:assert/strict";
import * as engine from "../dist/index.js";

// A server takes the length of a book from its Scaletta only when it announces `autopilot-outline-brief`. An older one plans the default number of
// chapters and writes them, ignoring the outline: the engine's client refuses to start or configure it, before anything is sent.

/** A personal server that announces `features`, answers every other request with a snapshot, and remembers each one. */
function fakeServer(features) {
  const log = [];
  const fetch = async (input, init = {}) => {
    const url = new URL(input);
    log.push({ method: init.method ?? "GET", path: url.pathname, body: init.body === undefined ? undefined : JSON.parse(init.body) });
    if (url.pathname === "/api/v1/info") return Response.json({ name: "narrarium-server", apiVersion: 1, serverVersion: "0.1.11", engineVersion: "0.1.11", serverId: "s", label: "Test", git: true, features, publicKey: "k", fingerprint: "f", supervised: false });
    return Response.json({ bookId: "b", state: null, summary: null, activities: [], live: null, running: false, host: null });
  };
  return { fetch, log };
}

const serverClient = (server) => new engine.NarrariumServerClient({ baseUrl: "http://127.0.0.1:24242", token: "nrs_me", fetch: server.fetch });
const WITH = ["autopilot", "autopilot-controls", "autopilot-retry", "autopilot-auto-resume", "autopilot-outline-brief"];
const WITHOUT = ["autopilot", "autopilot-controls", "autopilot-retry", "autopilot-auto-resume"];

test("a server says the length of a book comes from its Scaletta with the feature autopilot-outline-brief; reading it never throws", () => {
  assert.equal(engine.SERVER_FEATURE_AUTOPILOT_OUTLINE_BRIEF, "autopilot-outline-brief");
  assert.equal(engine.serverHasOutlineBrief({ features: WITH }), true);
  assert.equal(engine.serverHasOutlineBrief(WITH), true, "a list of features is read as well");
  assert.equal(engine.serverHasOutlineBrief({ features: WITHOUT }), false);
  for (const odd of [null, undefined, {}, { features: "autopilot-outline-brief" }, "autopilot-outline-brief", 7]) assert.equal(engine.serverHasOutlineBrief(odd), false, JSON.stringify(odd));
});

test("the client never starts or configures the autopilot of a server that does not announce autopilot-outline-brief: it refuses before sending anything", async () => {
  const calls = [
    (api) => api.startAutopilot("b", { brief: { idea: "x" }, options: { pauseAfterPlan: false } }),
    (api) => api.startAutopilot("b"),
    (api) => api.configureAutopilot("b", { brief: { genre: "Noir" } }),
    (api) => api.configureAutopilot("b", { options: { pauseAfterEachChapter: true } }),
  ];
  for (const call of calls) {
    const old = fakeServer(WITHOUT);
    const error = await call(serverClient(old)).then(() => null, (failure) => failure);
    assert.ok(error instanceof engine.ServerRequestError, String(error));
    assert.deepEqual([error.status, error.code], [501, "feature_unavailable"]);
    assert.match(error.message, /autopilot-outline-brief/);
    assert.match(error.message, /Update the server/);
    assert.deepEqual(old.log.map((request) => request.path), ["/api/v1/info"], "only the server's features were asked: nothing was sent");

    const current = fakeServer(WITH);
    await call(serverClient(current));
    assert.ok(current.log.some((request) => /\/autopilot\/(start|configure)$/.test(request.path)), "a server that announces it gets the request");
  }
});

test("a server that announces autopilot-outline-brief is reached as before: nothing is refused for the feature", async () => {
  const current = fakeServer(WITH);
  const snapshot = await serverClient(current).startAutopilot("b", { brief: { idea: "x" } });
  assert.ok(snapshot);
  assert.deepEqual(current.log.map((request) => request.path).at(-1), "/api/v1/books/b/autopilot/start");
});
