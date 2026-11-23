import test from "node:test";
import assert from "node:assert/strict";
import * as engine from "../dist/index.js";

// New exports are read from the namespace so that, before they exist, each test fails on its own.
const { NarrariumServerClient, ServerRequestError } = engine;

// ─── «Retry later» and «Retry now» through the client of the personal server ───────────────────────────────────────────────

const BASE = "http://127.0.0.1:24242";

/** A personal server that announces `features`, answers every other request with `answer(request)`, and remembers each one. */
function fakeServer(features, answer = () => Response.json(snapshot())) {
  const log = [];
  const fetch = async (input, init = {}) => {
    const url = new URL(input);
    const request = { method: init.method ?? "GET", path: url.pathname, body: init.body === undefined ? undefined : JSON.parse(init.body), contentType: init.headers?.["content-type"] };
    log.push(request);
    if (url.pathname === "/api/v1/info") return Response.json({ name: "narrarium-server", apiVersion: 1, serverVersion: "0.1.9", engineVersion: "0.1.9", serverId: "s", label: "Test", git: true, features, publicKey: "k", fingerprint: "f", supervised: false });
    return answer(request);
  };
  return { fetch, log };
}

const client = (server) => new NarrariumServerClient({ baseUrl: BASE, token: "nrs_me", fetch: server.fetch });
const snapshot = (extra = {}) => ({ bookId: "my-book", state: { status: "running" }, summary: { status: "running" }, activities: [], live: null, running: true, host: "server", ...extra });
const WITH = ["autopilot", "autopilot-controls", "autopilot-retry", "autopilot-outline-brief"];
const WITHOUT = ["autopilot", "autopilot-controls", "autopilot-rules", "autopilot-frozen", "autopilot-outline-brief"];
const POLICY = { everyMinutes: 15, cycles: 3 };

test("a server says it has «Retry later» and «Retry now» with the feature autopilot-retry; reading it never throws", () => {
  assert.equal(engine.SERVER_FEATURE_AUTOPILOT_RETRY, "autopilot-retry");
  assert.equal(engine.serverSupportsAutopilotRetry({ features: WITH }), true);
  assert.equal(engine.serverSupportsAutopilotRetry(WITH), true, "a list of features is read as well");
  assert.equal(engine.serverSupportsAutopilotRetry({ features: WITHOUT }), false);
  assert.equal(engine.serverSupportsAutopilotRetry(WITHOUT), false);
  for (const odd of [null, undefined, {}, { features: "autopilot-retry" }, "autopilot-retry", 7]) assert.equal(engine.serverSupportsAutopilotRetry(odd), false, JSON.stringify(odd));
});

test("retryNow posts to …/autopilot/retry-now with no body and answers the snapshot with `skipped`", async () => {
  const server = fakeServer(WITH, () => Response.json({ ...snapshot(), skipped: true }));
  const answer = await client(server).retryNow("my book");
  assert.equal(answer.skipped, true);
  assert.equal(answer.bookId, "my-book");
  assert.deepEqual(server.log.map((request) => [request.method, request.path, request.body]), [["POST", "/api/v1/books/my%20book/autopilot/retry-now", undefined]]);
});

test("the client never sends longRetry to a server that does not announce autopilot-retry: it refuses before sending anything, and says why", async () => {
  const calls = [
    (api) => api.updateAutopilotOptions("b", { longRetry: POLICY }),
    (api) => api.updateOptions("b", { longRetry: null }),
    (api) => api.configureAutopilot("b", { options: { longRetry: POLICY } }),
    (api) => api.startAutopilot("b", { options: { pauseAfterPlan: false, longRetry: { everyMinutes: 60, cycles: "unlimited" } } }),
  ];
  for (const call of calls) {
    const old = fakeServer(WITHOUT);
    const error = await call(client(old)).then(() => null, (failure) => failure);
    assert.ok(error instanceof ServerRequestError, String(error));
    assert.equal(error.code, "feature_unavailable");
    assert.equal(error.status, 501);
    assert.match(error.message, /Retry later/);
    assert.match(error.message, /autopilot-retry/);
    assert.deepEqual(old.log.map((request) => request.path), ["/api/v1/info"], "only the server's features were asked: nothing was sent");

    const current = fakeServer(WITH);
    await call(client(current));
    const sent = current.log.find((request) => request.path !== "/api/v1/info");
    assert.ok(sent, "a server that has it gets the request");
    assert.ok(JSON.stringify(sent.body).includes("longRetry"), "with the setting in it");
  }

  const plain = fakeServer(WITHOUT);
  await client(plain).updateAutopilotOptions("b", { publishEvery: "off" });
  await client(plain).startAutopilot("b", { options: { pauseAfterPlan: false } });
  assert.deepEqual(plain.log.map((request) => request.path), ["/api/v1/books/b/autopilot/options", "/api/v1/info", "/api/v1/books/b/autopilot/start"], "a request without the setting asks only for the features a start needs: the Scaletta's");
});
