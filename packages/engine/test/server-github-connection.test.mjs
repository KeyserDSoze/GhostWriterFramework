import test from "node:test";
import assert from "node:assert/strict";
import * as engine from "../dist/index.js";

// New exports are read from the namespace so that, before they exist, each test fails on its own.
const { NarrariumServerClient, ServerRequestError } = engine;

// ─── The server's own GitHub connection: what the engine says of it, and the three calls of the server's client that use it ───

const BASE = "http://127.0.0.1:24242";
const WITH = ["autopilot", "github", "server-github-connection"];
const WITHOUT = ["autopilot", "github", "github-conflicts", "autopilot-retry"];

/** A personal server that announces `features`, answers every other request with `answer(request)`, and remembers each one. */
function fakeServer(features, answer = () => Response.json({ state: "disconnected" })) {
  const log = [];
  const fetch = async (input, init = {}) => {
    const url = new URL(input);
    const request = { method: init.method ?? "GET", path: url.pathname, body: init.body === undefined ? undefined : JSON.parse(init.body), authorization: init.headers?.authorization };
    log.push(request);
    if (url.pathname === "/api/v1/info") return Response.json({ name: "narrarium-server", apiVersion: 1, serverVersion: "0.1.23", engineVersion: "0.1.28", serverId: "s", label: "Test", git: true, features, publicKey: "k", fingerprint: "f", supervised: false });
    return answer(request);
  };
  return { fetch, log };
}

const client = (server) => new NarrariumServerClient({ baseUrl: BASE, token: "nrs_me", fetch: server.fetch });
const calls = (server) => server.log.filter((request) => request.path !== "/api/v1/info");
const PENDING = {
  state: "pending",
  broker: "https://auth.example.com",
  pending: { userCode: "WDJB-MJHT", verificationUri: "https://github.com/login/device", expiresAt: "2026-11-28T10:15:00.000Z", interval: 5 },
};

test("a server says it has its own GitHub connection with the feature server-github-connection; reading it never throws", () => {
  assert.equal(engine.SERVER_FEATURE_GITHUB_CONNECTION, "server-github-connection");
  assert.equal(engine.serverSupportsGitHubConnection({ features: WITH }), true);
  assert.equal(engine.serverSupportsGitHubConnection(WITH), true, "a list of features is read as well");
  assert.equal(engine.serverSupportsGitHubConnection({ features: WITHOUT }), false);
  assert.equal(engine.serverSupportsGitHubConnection(WITHOUT), false);
  for (const odd of [null, undefined, {}, { features: "server-github-connection" }, "server-github-connection", 7]) assert.equal(engine.serverSupportsGitHubConnection(odd), false, JSON.stringify(odd));
});

test("the states, the problems, the ways a book proves itself and the refusals are one closed list each, the same the server and the app read", () => {
  assert.deepEqual(engine.GITHUB_CONNECTION_STATES, ["disconnected", "pending", "connected", "needs-reconnect"]);
  assert.deepEqual(engine.GITHUB_CONNECTION_PROBLEM_CODES, [
    "device-flow-disabled", "expiring-tokens-off", "access-denied", "code-expired", "renewal-failed", "broker-unreachable", "broker-not-configured", "github-unreachable", "client-id-rejected", "github-rejected",
  ]);
  assert.deepEqual(engine.GITHUB_AUTH_MODES, ["token", "connection"]);
  assert.deepEqual(engine.GITHUB_CONNECTION_ERROR_CODES, { required: "github_connection_required", exists: "github_connection_exists", unavailable: "github_connection_unavailable" });
});

test("githubConnection reads the status: GET …/github/connection with the token and no body, and answers it as the server gave it", async () => {
  const server = fakeServer(WITH, () => Response.json(PENDING));
  const answer = await client(server).githubConnection();
  assert.deepEqual(answer, PENDING);
  assert.deepEqual(calls(server).map((request) => [request.method, request.path, request.body, request.authorization]), [["GET", "/api/v1/github/connection", undefined, "Bearer nrs_me"]]);
});

test("connectGitHub posts the client id and the broker, and nothing else, and answers the status", async () => {
  const server = fakeServer(WITH, () => Response.json(PENDING));
  const answer = await client(server).connectGitHub({ clientId: "Iv1.0123456789abcdef", broker: "https://auth.example.com" });
  assert.equal(answer.state, "pending");
  assert.equal(answer.pending.userCode, "WDJB-MJHT");
  assert.deepEqual(calls(server).map((request) => [request.method, request.path, request.body]), [["POST", "/api/v1/github/connection", { clientId: "Iv1.0123456789abcdef", broker: "https://auth.example.com" }]]);
});

test("disconnectGitHub deletes the connection and answers the status", async () => {
  const server = fakeServer(WITH, () => Response.json({ state: "disconnected" }));
  assert.deepEqual(await client(server).disconnectGitHub(), { state: "disconnected" });
  assert.deepEqual(calls(server).map((request) => [request.method, request.path, request.body]), [["DELETE", "/api/v1/github/connection", undefined]]);
});

test("the client never sends the three calls to a server that does not announce server-github-connection: it refuses before sending anything, and says why", async () => {
  const run = [
    (api) => api.githubConnection(),
    (api) => api.connectGitHub({ clientId: "Iv1.0123456789abcdef", broker: "https://auth.example.com" }),
    (api) => api.disconnectGitHub(),
  ];
  for (const call of run) {
    const old = fakeServer(WITHOUT);
    const error = await call(client(old)).then(() => null, (failure) => failure);
    assert.ok(error instanceof ServerRequestError, String(error));
    assert.equal(error.code, "feature_unavailable");
    assert.equal(error.status, 501);
    assert.match(error.message, /server-github-connection/);
    assert.deepEqual(old.log.map((request) => request.path), ["/api/v1/info"], "only the server's features were asked: nothing was sent");
  }
});

test("a server that announces the feature is asked for its features once: the next calls go straight to the route", async () => {
  const server = fakeServer(WITH, () => Response.json({ state: "disconnected" }));
  const api = client(server);
  await api.githubConnection();
  await api.githubConnection();
  await api.disconnectGitHub();
  assert.deepEqual(server.log.map((request) => request.path), ["/api/v1/info", "/api/v1/github/connection", "/api/v1/github/connection", "/api/v1/github/connection"]);
});

test("a refusal of the server keeps its code and what it said besides, as every other call of the client does", async () => {
  const refuse = (status, code) => () => Response.json({ code, message: `refused ${code}` }, { status });
  const exists = await client(fakeServer(WITH, refuse(409, "github_connection_exists"))).connectGitHub({ clientId: "Iv1.0123456789abcdef", broker: "https://auth.example.com" }).then(() => null, (failure) => failure);
  assert.ok(exists instanceof ServerRequestError);
  assert.deepEqual([exists.status, exists.code], [409, engine.GITHUB_CONNECTION_ERROR_CODES.exists]);
  const required = await client(fakeServer(WITH, refuse(412, "github_connection_required"))).registerBook("b", { title: "B", storage: { kind: "github", owner: "o", repo: "r", branch: "main" }, githubAuth: "connection" }).then(() => null, (failure) => failure);
  assert.deepEqual([required.status, required.code], [412, engine.GITHUB_CONNECTION_ERROR_CODES.required]);
});

test("registerBook sends githubAuth as it is given, and a request that does not give it sends none (an old caller is unchanged)", async () => {
  const server = fakeServer(WITH, () => Response.json({ bookId: "b" }));
  const api = client(server);
  const storage = { kind: "github", owner: "o", repo: "r", branch: "main" };
  await api.registerBook("b", { title: "B", storage, githubAuth: "connection" });
  await api.registerBook("b", { title: "B", storage, githubToken: "ghp_x" });
  assert.deepEqual(calls(server).map((request) => request.body), [{ title: "B", storage, githubAuth: "connection" }, { title: "B", storage, githubToken: "ghp_x" }]);
});
