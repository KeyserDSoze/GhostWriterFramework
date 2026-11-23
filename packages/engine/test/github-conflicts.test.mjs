import test from "node:test";
import assert from "node:assert/strict";
import * as engine from "../dist/index.js";
import { MemoryBookStore, createFakeAutopilotAi, seedBookFiles } from "../dist/testing/index.js";

// New exports are read from the namespace so that, before they exist, each test fails on its own.
const { AutopilotSession, NarrariumServerClient, ServerRequestError, parseAutopilotState } = engine;

// ─── A conflict with GitHub: what the engine says of it, and the two calls of the server's client that resolve it ─────────────

const BASE = "http://127.0.0.1:24242";
const WITH = ["autopilot", "github", "github-conflicts"];
const WITHOUT = ["autopilot", "github", "autopilot-controls", "autopilot-retry"];

/** A personal server that announces `features`, answers every other request with `answer(request)`, and remembers each one. */
function fakeServer(features, answer = () => Response.json({})) {
  const log = [];
  const fetch = async (input, init = {}) => {
    const url = new URL(input);
    const request = { method: init.method ?? "GET", path: url.pathname, query: Object.fromEntries(url.searchParams), body: init.body === undefined ? undefined : JSON.parse(init.body) };
    log.push(request);
    if (url.pathname === "/api/v1/info") return Response.json({ name: "narrarium-server", apiVersion: 1, serverVersion: "0.1.10", engineVersion: "0.1.10", serverId: "s", label: "Test", git: true, features, publicKey: "k", fingerprint: "f", supervised: false });
    return answer(request);
  };
  return { fetch, log };
}

const client = (server) => new NarrariumServerClient({ baseUrl: BASE, token: "nrs_me", fetch: server.fetch });
const LISTED = {
  conflicts: [{ path: "chapters/001-one/001-scene.md", server: "modified", github: "modified", serverBytes: 120, githubBytes: 98, resolvable: true }],
  total: 1, offset: 0, limit: 100, ahead: 2, behind: 1, branch: "main", head: "a".repeat(40), githubHead: "b".repeat(40), fingerprint: "f".repeat(32),
};

test("a server says it resolves the conflicts with GitHub with the feature github-conflicts; reading it never throws", () => {
  assert.equal(engine.SERVER_FEATURE_GITHUB_CONFLICTS, "github-conflicts");
  assert.equal(engine.GITHUB_CONFLICT_CODE, "github_conflict");
  assert.equal(engine.serverSupportsGithubConflicts({ features: WITH }), true);
  assert.equal(engine.serverSupportsGithubConflicts(WITH), true, "a list of features is read as well");
  assert.equal(engine.serverSupportsGithubConflicts({ features: WITHOUT }), false);
  for (const odd of [null, undefined, {}, { features: "github-conflicts" }, "github-conflicts", 7]) assert.equal(engine.serverSupportsGithubConflicts(odd), false, JSON.stringify(odd));
  assert.deepEqual(engine.GITHUB_CONFLICT_CHOICES, ["server", "github"]);
  assert.deepEqual([engine.GITHUB_CONFLICTS_PAGE_LIMIT, engine.GITHUB_CONFLICTS_MAX_PAGE_LIMIT], [100, 500]);
});

test("listGithubConflicts reads a page of the conflicts: GET …/github-conflicts with the offset and the limit it was given, and nothing else", async () => {
  const server = fakeServer(WITH, () => Response.json(LISTED));
  const api = client(server);
  const answer = await api.listGithubConflicts("my book", { offset: 100, limit: 50 });
  assert.deepEqual(answer, LISTED, "the answer as the server gave it");
  await api.listGithubConflicts("my book");
  const calls = server.log.filter((request) => request.path !== "/api/v1/info");
  assert.deepEqual(calls.map((request) => [request.method, request.path, request.query, request.body]), [
    ["GET", "/api/v1/books/my%20book/github-conflicts", { offset: "100", limit: "50" }, undefined],
    ["GET", "/api/v1/books/my%20book/github-conflicts", {}, undefined],
  ]);
});

test("resolveGithubConflicts posts the choices as they are given, and answers the new head, the counts and what was left aside", async () => {
  const resolved = { head: "c".repeat(40), pushed: true, resolved: [{ path: "chapters/001-one/001-scene.md", choice: "github" }], counts: { total: 1, server: 0, github: 1, ignored: 1, unresolvable: 0 }, ignored: ["notes.md"], unresolvable: [] };
  const server = fakeServer(WITH, () => Response.json(resolved));
  const request = { choices: { "chapters/001-one/001-scene.md": "github", "notes.md": "server" }, default: "server", message: "Keep my edit", fingerprint: LISTED.fingerprint };
  const answer = await client(server).resolveGithubConflicts("b", request);
  assert.deepEqual(answer, resolved);
  const sent = server.log.find((entry) => entry.path !== "/api/v1/info");
  assert.deepEqual([sent.method, sent.path, sent.body], ["POST", "/api/v1/books/b/github-conflicts/resolve", request]);
});

test("a server that does not announce github-conflicts is refused before anything is sent, with a clear error", async () => {
  for (const call of [(api) => api.listGithubConflicts("b"), (api) => api.resolveGithubConflicts("b", { default: "server" })]) {
    const old = fakeServer(WITHOUT);
    const error = await call(client(old)).then(() => null, (failure) => failure);
    assert.ok(error instanceof ServerRequestError, String(error));
    assert.equal(error.code, "feature_unavailable");
    assert.equal(error.status, 501);
    assert.match(error.message, /github-conflicts/);
    assert.match(error.message, /update the server/i);
    assert.deepEqual(old.log.map((request) => request.path), ["/api/v1/info"], "only the features were asked");
  }
  // A server that has it is asked once: the client remembers what it said.
  const current = fakeServer(WITH, () => Response.json(LISTED));
  const api = client(current);
  await api.listGithubConflicts("b");
  await api.listGithubConflicts("b", { offset: 100 });
  assert.equal(current.log.filter((request) => request.path === "/api/v1/info").length, 1);
});

test("a refusal keeps what the server said with it: the files without a choice, the conflicts as they are now", async () => {
  const refusals = [
    [400, { code: "choice_missing", message: "Choose a version for 1 file, or give a default.", paths: ["notes.md"], missing: 1 }],
    [409, { code: "conflicts_changed", message: "The conflicts changed.", ...LISTED }],
  ];
  for (const [status, body] of refusals) {
    const server = fakeServer(WITH, () => Response.json(body, { status }));
    const error = await client(server).resolveGithubConflicts("b", { default: "server" }).then(() => null, (failure) => failure);
    assert.ok(error instanceof ServerRequestError, String(error));
    assert.deepEqual([error.status, error.code, error.message], [status, body.code, body.message]);
    const { code: _code, message: _message, ...rest } = body;
    assert.deepEqual(error.details, rest, `${body.code}: the other fields of the answer`);
  }
  const plain = fakeServer(WITH, () => Response.json({ code: "not_conflicted", message: "Nothing to resolve." }, { status: 409 }));
  const error = await client(plain).resolveGithubConflicts("b", { default: "github" }).then(() => null, (failure) => failure);
  assert.deepEqual(error.details, {}, "an answer with nothing else has empty details");
});

// ─── The engine's model of errors ───────────────────────────────────────────────────────────────────────────────────────────

/** The error a server throws when its commits conflict with GitHub, as another copy of the engine would see it (no class in common). */
const conflictError = (total = 3) => Object.assign(new Error(`The book changed on GitHub in a way that conflicts with the server's work (${total} files).`), { name: "GithubConflictError", code: "github_conflict", total, retryable: false });

test("a conflict with GitHub is a `conflict`, and its detail says how many files the author has to decide about", () => {
  assert.deepEqual(engine.classifyAutopilotError(conflictError(3)), { kind: "conflict", detail: { githubConflicts: 3 } });
  assert.deepEqual(engine.classifyAutopilotError(conflictError(1)).detail, { githubConflicts: 1 });
  const bare = Object.assign(new Error("conflict"), { code: "github_conflict" });
  assert.deepEqual(engine.classifyAutopilotError(bare), { kind: "conflict", detail: {} }, "a count that is not said is not made up");
  for (const total of [-1, 1.5, "3", Number.NaN, 2_000_000]) assert.deepEqual(engine.classifyAutopilotError({ ...conflictError(), total }).detail, {}, String(total));
  assert.equal(engine.classifyAutopilotError(new engine.BookConflictError("changed")).detail.githubConflicts, undefined, "a conflict of the book's files is no conflict with GitHub");
  assert.deepEqual(engine.normalizeErrorDetail({ githubConflicts: 4 }), { githubConflicts: 4 }, "read back from a file");
  for (const value of [0, -2, 2.5, "4", null, 2_000_000]) assert.equal(engine.normalizeErrorDetail({ githubConflicts: value, status: 409 })?.githubConflicts, undefined, String(value));
  assert.equal(engine.isRetryableError(conflictError()), false, "repeating the step cannot settle it");
});

test("a run whose book conflicts with GitHub stops at once, with the kind and the number of files in lastError, and is not retried", async () => {
  const store = new MemoryBookStore(seedBookFiles({ chapters: 1 }));
  let pulls = 0;
  const events = [];
  const session = new AutopilotSession({
    bookId: "book", store, ai: createFakeAutopilotAi(), host: "server", hostLabel: "test", retryDelayMs: 0,
    hooks: { beforeStep: async () => {
      pulls += 1;
      if (pulls === 3) throw conflictError(2);
    } },
  });
  session.subscribe((event) => events.push(event));
  await session.start({ brief: { idea: "x", targetChapters: 1, scenesPerChapter: 1, wordsPerScene: 300 }, options: { readers: false, readersOnPlan: false, specialists: false, pauseAfterPlan: false, longRetry: { everyMinutes: 1, cycles: 3 } } });
  await session.waitForIdle();
  const state = parseAutopilotState(store.files.get("autopilot/state.json"));
  assert.equal(state.status, "error");
  assert.equal(pulls, 3, "no attempt after the conflict");
  assert.equal(state.lastError.errorKind, "conflict");
  assert.deepEqual(state.lastError.errorDetail, { githubConflicts: 2 });
  assert.match(state.lastError.message, /conflicts with the server's work/);
  assert.deepEqual(events.filter((event) => event.type === "insight" && /Retry|failureRetry|longRetryWait/.test(event.code ?? "")), [], "no retry, quick or long");
  const summary = (await session.snapshot()).summary;
  assert.deepEqual([summary.lastError.kind, summary.lastError.detail], ["conflict", { githubConflicts: 2 }]);
});
