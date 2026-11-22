import test from "node:test";
import assert from "node:assert/strict";
import * as engine from "../dist/index.js";
import { MemoryBookStore, createFakeAutopilotAi, seedBookFiles } from "../dist/testing/index.js";

// New exports are read from the namespace so that, before they exist, each test fails on its own.
const {
  AiFallbackBlockedError,
  AiPromptTooLargeError,
  AiProviderError,
  AiReplyRejectedError,
  AiRoutingBudgetError,
  AiUnavailableError,
  AutopilotSession,
  BookConflictError,
  FrontmatterError,
  StructuredReplyError,
  createAutopilotState,
  createFetchAi,
  parseAutopilotState,
  pickAiRuntimeConfig,
  readStoredAutopilot,
  serializeAutopilotState,
  summarizeAutopilotState,
} = engine;

const STATE = "autopilot/state.json";
const FAST = { readers: false, readersOnPlan: false, pauseAfterPlan: false };
const ONE = { brief: { idea: "x", targetChapters: 1, scenesPerChapter: 1, wordsPerScene: 300 }, options: FAST };
const KINDS = ["network", "auth", "rate_limit", "timeout", "truncated", "refused", "conflict", "budget", "limit", "profile", "provider", "unknown"];

function reply(json) {
  return { text: JSON.stringify(json), json, usage: { inputTokens: 100, outputTokens: 50, cachedInputTokens: 0 }, model: "fake-model", provider: "fake", cost: 0.001, currency: "USD" };
}

/** The fake AI with some calls replaced: `script(request, seen)` returns undefined (default reply), an Error to throw or a response. */
function scripted(script, options = {}) {
  const base = createFakeAutopilotAi(options);
  return {
    calls: base.calls,
    async complete(request) {
      const seen = base.calls.filter((call) => call.label === request.label).length;
      const custom = script(request, seen);
      if (custom === undefined) return base.complete(request);
      base.calls.push(request);
      if (custom instanceof Error) throw custom;
      return custom;
    },
  };
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

async function waitFor(predicate, what, timeoutMs = 4000) {
  const deadline = Date.now() + timeoutMs;
  while (!predicate()) {
    if (Date.now() > deadline) assert.fail(`Timed out waiting for ${what}.`);
    await sleep(4);
  }
}

async function run(ai, start = ONE, files = seedBookFiles(), extra = {}) {
  const store = new MemoryBookStore(files);
  const events = [];
  const session = new AutopilotSession({ bookId: "book", store, ai, host: "server", hostLabel: "test", retryDelayMs: 0, ...extra });
  session.subscribe((event) => events.push(event));
  await session.start(start);
  await session.waitForIdle();
  const snapshot = await session.snapshot();
  return { state: snapshot.state, summary: snapshot.summary, events, store, session, activities: (await readStoredAutopilot(store)).activities };
}

const summaries = (events) => events.filter((event) => event.type === "state").map((event) => event.state);
const failedActivities = (activities) => activities.filter((activity) => activity.status === "failed");
const concept = (make) => scripted((request) => (request.label === "autopilot:concept" ? make() : undefined));

// ─── The kinds, and what an error is ────────────────────────────────────────

test("the kinds of error are a closed list a host can switch on", () => {
  assert.deepEqual([...(engine.AUTOPILOT_ERROR_KINDS ?? [])].sort(), [...KINDS].sort());
});

const http = (status, extra = {}) => new AiProviderError(`openai gpt-test: HTTP ${status} — said no`, status, status === 408 || status === 429 || status >= 500, { ...([408, 429, 502, 503, 504].includes(status) ? { transient: true } : {}), ...extra });

const CASES = [
  ["HTTP 401", () => http(401), "auth"],
  ["HTTP 403", () => http(403), "auth"],
  ["HTTP 429", () => http(429, { retryAfterMs: 5000 }), "rate_limit"],
  ["HTTP 408", () => http(408), "timeout"],
  ["HTTP 500", () => http(500), "provider"],
  ["HTTP 502", () => http(502), "provider"],
  ["HTTP 503", () => http(503), "provider"],
  ["HTTP 504", () => http(504), "provider"],
  ["HTTP 400", () => http(400), "provider"],
  ["HTTP 404", () => http(404), "provider"],
  ["a network failure", () => new AiProviderError("openai gpt-test: fetch failed", undefined, true, { transient: true }), "network"],
  ["a reply that could not be read", () => new AiProviderError("openai gpt-test: the reply could not be read.", undefined, true, { transient: true }), "network"],
  ["a stream that ended too soon", () => new AiProviderError("openai gpt-test: the stream ended before the reply was complete.", undefined, true, { transient: true }), "network"],
  ["a request that timed out", () => new AiProviderError("openai gpt-test: request timed out", undefined, true, { transient: true, timedOut: true }), "timeout"],
  ["a timeout another AI port words", () => new AiProviderError("Request timed out.", undefined, true), "timeout"],
  ["a connection failure another AI port words", () => new AiProviderError("Connection error.", undefined, true), "network"],
  ["a rate limit another AI port words", () => new AiProviderError("Rate limit reached for requests", undefined, true), "rate_limit"],
  ["a reply cut by the output limit", () => new AiProviderError("openai gpt-test: the reply was cut by the output token limit. Nothing was applied.", undefined, false, { truncated: true }), "truncated"],
  ["a model that only reasoned", () => new AiProviderError("openai gpt-test: the model used its output limit while reasoning.", undefined, false, { truncated: true, reasoningOnly: true }), "truncated"],
  ["a routing budget that leaves no candidate", () => new AiRoutingBudgetError("The first routing candidate exceeds the configured token-attempt or estimated-cost budget."), "budget"],
  ["a prompt no context window holds", () => new AiPromptTooLargeError("The prompt is larger than the context window.", 9000, 4000), "limit"],
  ["a fallback the privacy setting blocks", () => new AiFallbackBlockedError("The fallback was not used."), "refused"],
  ["no model routed to the task", () => new AiUnavailableError("autopilot"), "refused"],
  ["a reply that was rejected", () => new AiReplyRejectedError("The concept was rejected: the field \"storyDesign\" is missing."), "provider"],
  ["a reply that is not JSON", () => new StructuredReplyError("The model reply is not valid JSON."), "provider"],
  ["a frontmatter that cannot be read", () => new FrontmatterError("story-design.md", "bad indentation", 3, "en"), "profile"],
  ["a file that changed", () => new BookConflictError("File changed since it was read: plot.md", "plot.md"), "conflict"],
  ["a conflict another store reports", () => Object.assign(new Error("File changed"), { name: "BookConflictError" }), "conflict"],
  ["a server that cannot be reached", () => Object.assign(new Error("The personal server is not reachable at http://127.0.0.1:24242."), { name: "ServerRequestError", status: 0, code: "unreachable" }), "network"],
  ["a plain error", () => new Error("Chapter 3 is not in the plan."), "unknown"],
  ["a string", () => "something went wrong", "unknown"],
  ["nothing", () => undefined, "unknown"],
];

test("every error the engine knows is put in a kind, by what it says (its status and flags) before its words", () => {
  assert.equal(typeof engine.classifyAutopilotError, "function", "exported");
  const seen = new Set();
  for (const [name, make, kind] of CASES) {
    const found = engine.classifyAutopilotError(make());
    assert.equal(found.kind, kind, name);
    seen.add(found.kind);
  }
  assert.deepEqual([...seen].sort(), [...KINDS].sort(), "and every kind is somebody's");
});

test("a status decides before the words do: a 401 that talks of a timeout is still a 401", () => {
  assert.equal(engine.classifyAutopilotError(new AiProviderError("HTTP 401 — the request timed out before it was authorised", 401, false)).kind, "auth");
  assert.equal(engine.classifyAutopilotError(new AiProviderError("HTTP 500 — rate limit of the upstream", 500, true)).kind, "provider");
  assert.equal(engine.classifyAutopilotError(new AiProviderError("connection reset", undefined, true, { truncated: true })).kind, "truncated", "a flag decides before the words");
});

// ─── The detail: where it happened, and never a secret ──────────────────────

test("the detail says what the error knows: the status, the origin of the endpoint (never its path or query), the model, the provider and the integration", () => {
  const error = new AiProviderError("openai gpt-test: HTTP 401 — invalid", 401, false, {
    target: { provider: "openai", model: "gpt-test", integrationId: "main", endpoint: "https://proxy.example.com:8443/secret-path-ABC123/v1?key=QUERYSECRET789" },
  });
  const { kind, detail } = engine.classifyAutopilotError(error);
  assert.equal(kind, "auth");
  assert.deepEqual(detail, { status: 401, endpoint: "https://proxy.example.com:8443", model: "gpt-test", provider: "openai", integration: "main" });
  assert.equal(JSON.stringify(detail).includes("secret-path"), false);
  assert.equal(JSON.stringify(detail).includes("QUERYSECRET"), false);

  const own = engine.classifyAutopilotError(new AiProviderError("HTTP 429", 429, true, { provider: "azure_openai", model: "dep-1", integrationId: "az", transient: true }));
  assert.deepEqual(own.detail, { status: 429, model: "dep-1", provider: "azure_openai", integration: "az" }, "what the error carries by itself is used too");

  assert.deepEqual(engine.classifyAutopilotError(new Error("boom")).detail, {}, "an error that knows nothing has an empty detail");
  assert.deepEqual(engine.classifyAutopilotError(new AiProviderError("cut", undefined, false, { truncated: true })).detail, {}, "and no status is made up");
  for (const endpoint of ["api.example.com/v1", "javascript:alert(1)", "file:///etc/passwd", "", "   ", 42, null]) {
    const found = engine.classifyAutopilotError(new AiProviderError("x", 500, true, { target: { provider: "openai", model: "m", integrationId: "i", endpoint } }));
    assert.equal("endpoint" in found.detail, false, `an endpoint that is no web address is left out: ${JSON.stringify(endpoint)}`);
  }
  const credentials = engine.classifyAutopilotError(new AiProviderError("x", 500, true, { target: { provider: "openai", model: "m", integrationId: "i", endpoint: "https://user:hunter2@api.example.com/v1#frag" } }));
  assert.equal(credentials.detail.endpoint, "https://api.example.com", "credentials in the address are not an origin");
});

test("no secret is kept in any field of the detail, and the fields are short", () => {
  const key = "sk-abcdefghijklmnop1234";
  const error = new AiProviderError("HTTP 401", 401, false, { provider: "openai", model: key, integrationId: `Bearer ${key}`, target: { provider: "openai", model: key, integrationId: "api-key: abcdefghijkl", endpoint: "https://api.example.com" } });
  const { detail } = engine.classifyAutopilotError(error);
  assert.equal(JSON.stringify(detail).includes(key), false);
  assert.equal(JSON.stringify(detail).includes("abcdefghijkl"), false);
  assert.match(detail.model, /redacted/);
  const long = engine.classifyAutopilotError(new AiProviderError("x", 500, true, { model: "m".repeat(5000), provider: "p".repeat(5000), integrationId: "i".repeat(5000) })).detail;
  for (const field of ["model", "provider", "integration"]) assert.ok(long[field].length <= 200, `${field}: ${long[field].length}`);
});

test("classifying an error never throws, whatever the error is, and stays quick on huge texts", () => {
  const hostile = {
    get status() {
      throw new Error("a getter that throws");
    },
    get message() {
      throw new Error("so does this one");
    },
  };
  assert.deepEqual(engine.classifyAutopilotError(hostile), { kind: "unknown", detail: {} });
  const circular = new Error("loop");
  circular.cause = circular;
  assert.equal(engine.classifyAutopilotError(circular).kind, "unknown");
  assert.deepEqual(engine.autopilotErrorFields(hostile), { errorKind: "unknown" });
  const proxy = new Proxy({}, { get() { throw new Error("no property can be read"); } });
  assert.equal(engine.classifyAutopilotError(proxy).kind, "unknown");

  const started = performance.now();
  const huge = "sk-abcdefghijklmnop1234 ".repeat(200_000);
  const found = engine.classifyAutopilotError(new AiProviderError("x", 401, false, { model: huge, provider: huge, integrationId: huge }));
  assert.ok(performance.now() - started < 1500, `${(performance.now() - started).toFixed(0)} ms for three texts of ${huge.length} characters`);
  for (const field of ["model", "provider", "integration"]) assert.ok(found.detail[field].length <= 160 && !found.detail[field].includes("sk-abcdefghijklmnop1234"), field);
});

// ─── The kinds in a real run: the activity, the state and the summary ───────

const RUN_CASES = [
  ["network", () => new AiProviderError("openai gpt-test: fetch failed", undefined, true, { transient: true })],
  ["auth", () => http(401)],
  ["auth", () => http(403)],
  ["rate_limit", () => http(429)],
  ["timeout", () => new AiProviderError("openai gpt-test: request timed out", undefined, true, { transient: true, timedOut: true })],
  ["timeout", () => http(408)],
  ["truncated", () => new AiProviderError("cut", undefined, false, { truncated: true })],
  ["refused", () => new AiFallbackBlockedError("The fallback was not used: sending content to another account was not acknowledged.")],
  ["conflict", () => new BookConflictError("File changed since it was read: plot.md", "plot.md")],
  ["budget", () => new AiRoutingBudgetError("The first routing candidate exceeds the configured budget.")],
  ["limit", () => new AiPromptTooLargeError("The prompt is larger than the context window.", 9000, 4000)],
  ["provider", () => http(500)],
  ["provider", () => http(503)],
  ["provider", () => new AiReplyRejectedError("The concept was rejected: the field \"storyDesign\" is missing.")],
  ["unknown", () => new Error("Chapter 3 is not in the plan.")],
];

test("a run that ends in an error says its kind in the state, in the failed activity, in the event and in the summary, the same everywhere", async () => {
  for (const [kind, make] of RUN_CASES) {
    const probe = make();
    const label = `${kind}: ${probe.message}`;
    const { state, summary, events, activities } = await run(concept(make));
    assert.equal(state.status, "error", label);
    assert.equal(state.lastError.errorKind, kind, label);
    assert.equal(state.lastError.task, "concept");
    assert.ok(state.lastError.message.length > 0);

    const failed = failedActivities(activities).at(-1);
    assert.equal(failed.errorKind, kind, `${label}: the activity in the log`);
    const finished = events.filter((event) => event.type === "task-finished" && event.activity.status === "failed").at(-1).activity;
    assert.equal(finished.errorKind, kind, `${label}: the activity the live event carries`);
    assert.deepEqual(finished.errorDetail, failed.errorDetail, label);

    assert.equal(summary.lastError.kind, kind, `${label}: the summary of a client that connects later`);
    assert.equal(summaries(events).at(-1).lastError.kind, kind, `${label}: the summary of the last event`);
    assert.equal(summary.lastError.message, state.lastError.message, "the summary keeps the message");
    assert.deepEqual(summary.lastError.detail, state.lastError.errorDetail, `${label}: the same detail, under the short name`);
    assert.deepEqual(summary.lastError.errorDetail, state.lastError.errorDetail, `${label}: and under the name the state has`);
  }
});

test("a failure that is not retried says nothing of retries, and one that was says how far it got", async () => {
  const fatal = await run(concept(() => http(401)));
  assert.equal(fatal.state.lastError.errorDetail?.status, 401);
  assert.equal("attempt" in (fatal.state.lastError.errorDetail ?? {}), false);
  assert.equal("retries" in (fatal.state.lastError.errorDetail ?? {}), false);

  const down = await run(concept(() => http(503)));
  assert.equal(down.state.status, "error");
  const failures = failedActivities(down.activities);
  assert.equal(failures.length, 4, "the first try and three retries");
  assert.deepEqual(failures.map((activity) => [activity.errorDetail.attempt, activity.errorDetail.retries]), [[1, 3], [2, 3], [3, 3], [3, 3]], "the retry each failure belongs to: the one that followed it, and the last one when none did");
  assert.deepEqual([down.state.lastError.errorDetail.attempt, down.state.lastError.errorDetail.retries], [3, 3], "the run gave up after the three retries");
  assert.equal(down.state.lastError.errorDetail.status, 503);

  const rejected = await run(concept(() => new AiReplyRejectedError("The concept was rejected: the field \"storyDesign\" is missing.")));
  assert.equal(rejected.state.lastError.errorDetail.retries, 1, "a rejected reply is retried once");
});

test("a failure that was tried again and then went well leaves no error behind, only the failed activity with its kind", async () => {
  const ai = scripted((request, seen) => (request.label === "autopilot:concept" && seen === 0 ? http(429) : undefined));
  const { state, activities, summary } = await run(ai);
  assert.equal(state.status, "completed");
  assert.equal(state.lastError, null);
  assert.equal(summary.lastError, null);
  const failed = failedActivities(activities);
  assert.equal(failed.length, 1);
  assert.equal(failed[0].errorKind, "rate_limit");
  assert.deepEqual([failed[0].errorDetail.status, failed[0].errorDetail.attempt, failed[0].errorDetail.retries], [429, 1, 3]);
});

test("a step the author paused is cancelled, not failed: it has no kind of error", async () => {
  const base = createFakeAutopilotAi();
  let reached;
  const waiting = new Promise((resolve) => {
    reached = resolve;
  });
  const ai = {
    calls: base.calls,
    complete(request) {
      reached();
      return new Promise((_resolve, reject) => request.signal.addEventListener("abort", () => reject(request.signal.reason), { once: true }));
    },
  };
  const store = new MemoryBookStore(seedBookFiles());
  const session = new AutopilotSession({ bookId: "book", store, ai, host: "server", hostLabel: "test", retryDelayMs: 0 });
  await session.start(ONE);
  await waiting;
  session.pause("now");
  await session.waitForIdle();
  const activity = (await readStoredAutopilot(store)).activities.at(-1);
  assert.equal(activity.status, "cancelled");
  assert.equal("errorKind" in activity, false);
  assert.equal("errorDetail" in activity, false);
  assert.equal(parseAutopilotState(store.files.get(STATE)).lastError, null);
});

test("a book file the autopilot cannot read is a profile problem: the step is refused with the kind the author can act on", async () => {
  const design = "---\ntype: note\ntitle: Story: Design\nscope: story-design\n---\n\n# Story Design\n\n## Premise\n";
  const { state, activities } = await run(createFakeAutopilotAi(), ONE, { ...seedBookFiles(), "story-design.md": design });
  assert.equal(state.status, "error");
  assert.ok(state.lastError.message.includes("story-design.md"), state.lastError.message);
  assert.equal(state.lastError.errorKind, "profile");
  assert.equal(failedActivities(activities).at(-1)?.errorKind, "profile");
});

test("a run that goes round and round until the engine's own ceiling of steps stops it says so: the kind is limit", async () => {
  let arrivals = 0;
  const ai = {
    calls: [],
    complete(request) {
      arrivals += 1;
      return new Promise((_resolve, reject) => request.signal.addEventListener("abort", () => reject(request.signal.reason), { once: true }));
    },
  };
  const store = new MemoryBookStore(seedBookFiles());
  const events = [];
  const session = new AutopilotSession({ bookId: "book", store, ai, host: "server", hostLabel: "test", retryDelayMs: 0 });
  session.subscribe((event) => events.push(event));
  await session.start(ONE);
  const ceiling = engine.runStepCeiling({ brief: { targetChapters: 1 }, plan: null });
  // Every time the step is under way the author interrupts it: it is repeated, and every repeat is a turn of the loop the ceiling counts.
  for (let turn = 0; session.running && turn < ceiling + 20; turn += 1) {
    while (session.running && arrivals <= turn) await new Promise((resolve) => setImmediate(resolve));
    if (session.running) await session.intervene({ scope: "next_step", text: `Note ${turn}`, interrupt: true });
  }
  await session.waitForIdle();
  const state = parseAutopilotState(store.files.get(STATE));
  assert.equal(state.status, "error");
  assert.equal(state.lastError.message, "Too many steps in one run.");
  assert.equal(state.lastError.errorKind, "limit");
  assert.equal("errorDetail" in state.lastError, false, "an error of the engine's own says no more than that");
  assert.equal(summaries(events).at(-1).lastError.kind, "limit");
  assert.ok(arrivals > ceiling && arrivals < ceiling + 5, `${arrivals} turns of the loop for a ceiling of ${ceiling}`);
});

// ─── The real client: where it happened, and nothing that is secret ─────────

const SECRETS = ["sk-test-SECRETKEY-0123456789", "SECRETKEY", "secret-path-ABC123", "QUERYSECRET789"];

function integration(extra = {}) {
  return {
    id: "main",
    name: "Main",
    provider: "openai",
    endpoint: "https://proxy.example.com:8443/secret-path-ABC123/v1?key=QUERYSECRET789",
    apiKey: "sk-test-SECRETKEY-0123456789",
    chatModels: [{ id: "1", name: "gpt-test", capabilities: ["default"] }],
    ...extra,
  };
}

const failBody = (status, message = "Incorrect API key provided: sk-test-SECRETKEY-0123456789 (?key=QUERYSECRET789).") => new Response(JSON.stringify({ error: { message } }), { status, headers: { "content-type": "application/json" } });

async function realRun(fetch, extra = {}) {
  const ai = createFetchAi(pickAiRuntimeConfig({ aiIntegrations: [integration(extra)] }), { fetch });
  const outcome = await run(ai);
  const everything = [outcome.store.files.get(STATE), outcome.store.files.get("autopilot/activity.json"), JSON.stringify(outcome.events), JSON.stringify(outcome.summary)].join("\n");
  return { ...outcome, everything };
}

const ORIGIN = "https://proxy.example.com:8443";

test("through the engine's own client the kind and the detail are the real ones: the status, the origin, the model, the provider and the integration", async () => {
  const unauthorised = await realRun(async () => failBody(401));
  assert.equal(unauthorised.state.status, "error");
  assert.equal(unauthorised.state.lastError.errorKind, "auth");
  assert.deepEqual(unauthorised.state.lastError.errorDetail, { status: 401, endpoint: ORIGIN, model: "gpt-test", provider: "openai", integration: "main" });
  assert.deepEqual(unauthorised.summary.lastError.detail, unauthorised.state.lastError.errorDetail);

  const limited = await realRun(async () => failBody(429, "Rate limit reached."));
  assert.equal(limited.state.lastError.errorKind, "rate_limit");
  assert.deepEqual([limited.state.lastError.errorDetail.status, limited.state.lastError.errorDetail.endpoint, limited.state.lastError.errorDetail.attempt, limited.state.lastError.errorDetail.retries], [429, ORIGIN, 3, 3]);

  const broken = await realRun(async () => failBody(500, "Internal error."));
  assert.equal(broken.state.lastError.errorKind, "provider");
  assert.equal(broken.state.lastError.errorDetail.status, 500);

  const away = await realRun(async () => {
    throw new TypeError("fetch failed");
  });
  assert.equal(away.state.lastError.errorKind, "network");
  assert.deepEqual(away.state.lastError.errorDetail, { endpoint: ORIGIN, model: "gpt-test", provider: "openai", integration: "main", attempt: 3, retries: 3 }, "no status: nothing answered");

  const hang = (_url, init) => new Promise((_resolve, reject) => init.signal.addEventListener("abort", () => reject(init.signal.reason), { once: true }));
  const slow = await realRun(hang, { requestTimeoutMs: 20 });
  assert.equal(slow.state.lastError.errorKind, "timeout");
  assert.equal(slow.state.lastError.errorDetail.endpoint, ORIGIN);
});

test("what the engine's client reports about a failure is in the failed activity too, and none of it is a secret", async () => {
  for (const make of [() => failBody(401), () => failBody(429), () => failBody(500, "Boom: sk-test-SECRETKEY-0123456789")]) {
    const { activities, everything, events } = await realRun(async () => make());
    const failed = failedActivities(activities).at(-1);
    assert.ok(failed.errorKind, "the activity has a kind");
    assert.equal(failed.errorDetail.endpoint, ORIGIN);
    assert.equal(failed.errorDetail.model, "gpt-test");
    for (const secret of SECRETS) assert.equal(everything.includes(secret), false, `${secret} is nowhere in the state, the activity log, the events or the summary`);
    assert.ok(events.some((event) => event.type === "task-finished" && event.activity.errorKind));
  }
});

test("a secret in the model's name or the integration's id is redacted in the kind and the detail wherever the engine says them", async () => {
  const ai = concept(() => new AiProviderError("openai m: HTTP 401", 401, false, { provider: "openai", model: "sk-abcdefghijklmnop1234", integrationId: "Bearer sk-abcdefghijklmnop1234" }));
  const { state, summary, activities, events } = await run(ai);
  assert.equal(state.lastError.errorKind, "auth");
  const detail = JSON.stringify([state.lastError.errorDetail, summary.lastError.detail, summaries(events).at(-1).lastError.detail, failedActivities(activities).map((activity) => activity.errorDetail), events.filter((event) => event.type === "task-finished").map((event) => event.activity.errorDetail)]);
  assert.ok(detail.includes("status"), "there is a detail to look at");
  assert.equal(detail.includes("sk-abcdefghijklmnop1234"), false);
});

// ─── The retry that is waiting ──────────────────────────────────────────────

const unavailable = (message = "HTTP 503 — overloaded") => new AiProviderError(message, 503, true, { transient: true });

test("while the run waits for a retry the summary says when the next attempt is, in the events and in the snapshot, and says it no more once the attempt starts", async () => {
  const NOW = Date.parse("2026-03-01T10:00:00.000Z");
  const store = new MemoryBookStore(seedBookFiles());
  const ai = scripted((request, seen) => (request.label === "autopilot:concept" && seen < 2 ? unavailable() : undefined));
  const events = [];
  const session = new AutopilotSession({ bookId: "book", store, ai, host: "server", hostLabel: "test", retryDelayMs: 200, random: () => 0.5, now: () => new Date(NOW) });
  session.subscribe((event) => events.push(event));
  assert.equal((await session.snapshot()).summary, null, "no state, no summary");
  await session.start(ONE);
  await waitFor(() => summaries(events).some((summary) => summary.retry), "the first retry to be waiting");

  const during = (await session.snapshot()).summary;
  assert.deepEqual(during.retry, { at: new Date(NOW + 200).toISOString(), attempt: 1, retries: 3 }, "the instant of the next attempt, and which retry it is");
  assert.equal(during.status, "running");
  assert.ok(!store.files.get(STATE).includes("\"retry\""), "nothing of it is saved");

  await waitFor(() => summaries(events).filter((summary) => summary.retry).length >= 2, "the second retry to be waiting");
  assert.deepEqual(summaries(events).filter((summary) => summary.retry).map((summary) => summary.retry).filter((retry, index, list) => list.findIndex((other) => other.at === retry.at) === index), [
    { at: new Date(NOW + 200).toISOString(), attempt: 1, retries: 3 },
    { at: new Date(NOW + 600).toISOString(), attempt: 2, retries: 3 },
  ], "the wait grows with every retry, as the failureRetry insight says");

  await session.waitForIdle();
  const flow = events.filter((event) => event.type === "state" || event.type === "task-started" || (event.type === "insight" && event.code === "failureRetry")).map((event) => (event.type === "state" ? (event.state.retry ? "state+retry" : "state") : event.type === "insight" ? "retry-insight" : "task-started"));
  const first = flow.indexOf("state+retry");
  assert.equal(flow[first - 1], "retry-insight", "the insight says it, and the state event carries it");
  assert.equal(flow[first + 1], "state", "when the wait is over a state event says nothing waits any more");
  assert.equal(flow[first + 2], "task-started", "before the attempt starts");
  assert.equal(summaries(events).filter((summary) => summary.retry).length, 2, "one state event per change: two waits");

  const last = summaries(events).at(-1);
  assert.equal(last.status, "completed");
  assert.equal("retry" in last, false, "absent once the run is over, not null");
  const after = (await session.snapshot()).summary;
  assert.equal("retry" in after, false);
  assert.equal(parseAutopilotState(store.files.get(STATE)).stats.failures, 0);
});

test("the retry is gone when the run ends before the wait does: a pause, or the last retry failing", async () => {
  const store = new MemoryBookStore(seedBookFiles());
  const events = [];
  const ai = scripted((request) => (request.label === "autopilot:concept" ? unavailable() : undefined));
  const session = new AutopilotSession({ bookId: "book", store, ai, host: "server", hostLabel: "test", retryDelayMs: 60_000, random: () => 0.5 });
  session.subscribe((event) => events.push(event));
  try {
    await session.start(ONE);
    await waitFor(() => summaries(events).some((summary) => summary.retry), "the retry to be waiting");
    assert.equal((await session.snapshot()).summary.retry.retries, 3);
    const asked = Date.now();
    session.pause("after-step");
    await session.waitForIdle();
    assert.ok(Date.now() - asked < 3000, "the pause ends the wait");
    const last = summaries(events).at(-1);
    assert.equal(last.status, "paused");
    assert.equal("retry" in last, false);
    assert.equal("retry" in (await session.snapshot()).summary, false);
  } finally {
    session.pause("now");
    await session.waitForIdle();
  }
  const doomed = await run(concept(() => unavailable()), ONE, seedBookFiles(), { retryDelayMs: 5, random: () => 0.5 });
  assert.equal(doomed.state.status, "error");
  assert.equal("retry" in summaries(doomed.events).at(-1), false);
  assert.equal(summaries(doomed.events).filter((summary) => summary.retry).length, 3, "one for every retry that was waited for");
  assert.deepEqual(summaries(doomed.events).filter((summary) => summary.retry).map((summary) => summary.retry.attempt), [1, 2, 3]);
});

test("a run without a failure never says it waits for a retry", async () => {
  const { events, summary } = await run(createFakeAutopilotAi({ reviewVerdict: () => "approve" }));
  assert.ok(summaries(events).length > 3);
  assert.ok(summaries(events).every((entry) => !("retry" in entry)));
  assert.equal("retry" in summary, false);
  assert.equal("retry" in summarizeAutopilotState(createAutopilotState(new Date(0))), false, "a summary made from the file alone has none");
});

// ─── Older states, odd states, round trips ──────────────────────────────────

test("a state written before the errors were classified is read as it was: no kind, no detail, and its summary has none", () => {
  const old = { ...createAutopilotState(new Date(0)), status: "error", lastError: { message: "HTTP 401 — invalid api key", at: "2026-01-01T00:00:00.000Z", task: "concept" } };
  const parsed = parseAutopilotState(JSON.stringify(old));
  assert.deepEqual(parsed.lastError, { message: "HTTP 401 — invalid api key", at: "2026-01-01T00:00:00.000Z", task: "concept" });
  const summary = summarizeAutopilotState(parsed);
  assert.deepEqual(summary.lastError, parsed.lastError);
  assert.equal("kind" in summary.lastError, false);
  assert.equal("detail" in summary.lastError, false);
  assert.equal(summarizeAutopilotState(createAutopilotState(new Date(0))).lastError, null);
});

test("the kind and the detail survive every save, and what is not a kind or not safe is dropped on the way in", () => {
  const detail = { status: 401, endpoint: "https://api.example.com", model: "m", provider: "openai", integration: "main", attempt: 1, retries: 3 };
  let current = { ...createAutopilotState(new Date(0)), status: "error", lastError: { message: "m", at: "t", task: "plan", errorKind: "auth", errorDetail: detail } };
  for (let pass = 0; pass < 3; pass += 1) current = parseAutopilotState(serializeAutopilotState(current));
  assert.equal(current.lastError.errorKind, "auth");
  assert.deepEqual(current.lastError.errorDetail, detail);
  assert.equal(summarizeAutopilotState(current).lastError.kind, "auth");
  assert.deepEqual(summarizeAutopilotState(current).lastError.detail, detail);

  const read = (extra) => parseAutopilotState(JSON.stringify({ ...createAutopilotState(new Date(0)), lastError: { message: "m", at: "t", ...extra } })).lastError;
  assert.equal(read({ errorKind: "banana" }).errorKind, undefined, "a kind nobody knows is no kind");
  assert.equal("errorKind" in read({ errorKind: 7 }), false);
  assert.equal("errorDetail" in read({ errorKind: "auth", errorDetail: {} }), false, "an empty detail is no detail");
  assert.equal("errorDetail" in read({ errorDetail: "text" }), false);
  const odd = read({ errorKind: "network", errorDetail: { status: "abc", endpoint: "https://x.test/v1/secret?key=abc", model: 5, provider: ["a"], integration: "ok", attempt: -2, retries: 400, extra: "no" } }).errorDetail;
  assert.deepEqual(odd, { endpoint: "https://x.test", integration: "ok" }, "only what is valid, and an endpoint only as an origin");
  assert.equal(read({ errorDetail: { status: 700 } }).errorDetail, undefined, "a status that is none");
});
