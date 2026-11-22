import test from "node:test";
import assert from "node:assert/strict";
import * as engine from "../dist/index.js";
import { MemoryBookStore, createFakeAutopilotAi, seedBookFiles } from "../dist/testing/index.js";

const { AiProviderError, AiReplyRejectedError, AutopilotSession, createFetchAi, pickAiRuntimeConfig } = engine;

const ASK = { capability: "autopilot", label: "t", system: "s", user: "u" };
const FAST = { readers: false, readersOnPlan: false, pauseAfterPlan: false };
const ONE_SCENE = { brief: { idea: "x", targetChapters: 1, scenesPerChapter: 1, wordsPerScene: 300 }, options: FAST };

// ─── Retry-After ────────────────────────────────────────────────────────────

function oneModel(fetch) {
  return createFetchAi(pickAiRuntimeConfig({ aiIntegrations: [{ id: "a", name: "A", provider: "openai", endpoint: "http://a.test/v1", apiKey: "k", chatModels: [{ id: "1", name: "m", capabilities: ["default"] }] }] }), { fetch });
}

const replyWith = (code, headers = {}) => async () => new Response(JSON.stringify({ error: { message: `provider said ${code}` } }), { status: code, headers: { "content-type": "application/json", ...headers } });
const failureOf = (code, headers) => oneModel(replyWith(code, headers)).complete(ASK).then(() => null, (error) => error);

test("Retry-After on a 429 or 503 becomes retryAfterMs: seconds or an HTTP date, never more than five minutes", async () => {
  assert.equal((await failureOf(429, { "retry-after": "7" })).retryAfterMs, 7_000);
  assert.equal((await failureOf(503, { "retry-after": "120" })).retryAfterMs, 120_000);
  assert.equal((await failureOf(429, { "retry-after": "1.5" })).retryAfterMs, 1_500);
  assert.equal((await failureOf(429, { "retry-after": "0" })).retryAfterMs, 0);
  assert.equal((await failureOf(429, { "retry-after": "3600" })).retryAfterMs, 300_000, "capped at five minutes");

  const soon = (await failureOf(429, { "retry-after": new Date(Date.now() + 30_000).toUTCString() })).retryAfterMs;
  assert.ok(soon > 25_000 && soon <= 30_500, `an HTTP date 30 s ahead: ${soon}`);
  assert.equal((await failureOf(503, { "retry-after": new Date(Date.now() - 60_000).toUTCString() })).retryAfterMs, 0, "a date in the past means now");
  assert.equal((await failureOf(429, { "retry-after": new Date(Date.now() + 3_600_000).toUTCString() })).retryAfterMs, 300_000);
});

test("Retry-After is ignored when it is absent, unreadable or on another status", async () => {
  assert.equal((await failureOf(429)).retryAfterMs, undefined);
  assert.equal((await failureOf(429, { "retry-after": "soon" })).retryAfterMs, undefined);
  assert.equal((await failureOf(429, { "retry-after": "-5" })).retryAfterMs, undefined);
  assert.equal((await failureOf(500, { "retry-after": "10" })).retryAfterMs, undefined);
  assert.equal((await failureOf(400, { "retry-after": "10" })).retryAfterMs, undefined);
});

test("rate limits, overload and timeouts are marked transient; a plain 500 and a bad request are not", async () => {
  for (const code of [408, 429, 502, 503, 504]) {
    const error = await failureOf(code);
    assert.equal(error.transient, true, String(code));
    assert.equal(error.retryable, true, String(code));
  }
  const server = await failureOf(500);
  assert.equal(server.retryable, true);
  assert.notEqual(server.transient, true, "a 500 may well repeat: the same answer twice in a row stops the retries");
  const bad = await failureOf(400);
  assert.equal(bad.retryable, false);
  assert.notEqual(bad.transient, true);

  const network = await oneModel(async () => { throw new TypeError("fetch failed"); }).complete(ASK).then(() => null, (error) => error);
  assert.equal(network.retryable, true);
  assert.equal(network.transient, true);
  const empty = await oneModel(async () => Response.json({ choices: [{ message: { content: "" }, finish_reason: "stop" }] })).complete(ASK).then(() => null, (error) => error);
  assert.equal(empty.retryable, true);
  assert.notEqual(empty.transient, true, "an empty reply depends on the prompt, not on the moment");
});

test("when every candidate is rate limited the error carries the longest wait asked for", async () => {
  const cfg = pickAiRuntimeConfig({ aiIntegrations: [
    { id: "a", name: "A", provider: "openai", endpoint: "http://a.test/v1", apiKey: "k", chatModels: [{ id: "1", name: "m1", capabilities: ["default"] }] },
    { id: "b", name: "B", provider: "openai", endpoint: "http://b.test/v1", apiKey: "k", chatModels: [{ id: "2", name: "m2", capabilities: ["default"] }] },
  ] });
  const fetch = async (url) => replyWith(429, { "retry-after": String(String(url).includes("a.test") ? 20 : 5) })();
  const error = await createFetchAi(cfg, { fetch }).complete(ASK).then(() => null, (failure) => failure);
  assert.equal(error.retryAfterMs, 20_000);
  assert.match(error.message, /provider said 429/);
});

test("a stream error that says the provider is busy is transient, one that does not say so is not", async () => {
  const streamFailure = (error) => async () => new Response(`data: ${JSON.stringify({ error })}\n\n`, { status: 200, headers: { "content-type": "text/event-stream" } });
  const run = (error) => oneModel(streamFailure(error)).complete({ ...ASK, onText: () => undefined }).then(() => null, (failure) => failure);
  assert.equal((await run({ message: "slow down", code: 429 })).transient, true);
  assert.equal((await run({ message: "The server is overloaded, try again later." })).transient, true);
  assert.notEqual((await run({ message: "context too long", type: "server_error" })).transient, true);
});

// ─── The runner's retries ───────────────────────────────────────────────────

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

async function run(ai, start = ONE_SCENE, extra = {}) {
  const store = new MemoryBookStore(seedBookFiles());
  const emitted = [];
  const session = new AutopilotSession({ bookId: "book", store, ai, host: "server", hostLabel: "test", retryDelayMs: 40, random: () => 0.5, ...extra });
  session.subscribe((event) => emitted.push(event));
  await session.start(start);
  await session.waitForIdle();
  return { state: (await session.snapshot()).state, events: emitted, store, session };
}

const retriesOf = (emitted) => emitted.filter((event) => event.type === "insight" && event.code === "failureRetry");
const concepts = (ai) => ai.calls.filter((call) => call.label === "autopilot:concept");
const unavailable = (message = "HTTP 503 — overloaded") => new AiProviderError(message, 503, true, { transient: true });

test("a transient provider error is retried up to three times with a growing wait", async () => {
  const ai = scripted((request, seen) => request.label === "autopilot:concept" && seen < 3 ? unavailable() : undefined);
  const { state, events: emitted } = await run(ai);
  assert.equal(state.status, "completed");
  assert.equal(concepts(ai).length, 4);
  const retries = retriesOf(emitted);
  assert.deepEqual(retries.map((event) => [event.attempt, event.retries, event.waitMs]), [[1, 3, 40], [2, 3, 120], [3, 3, 360]], "4 s, 12 s and 36 s, scaled by retryDelayMs");
  assert.match(retries[0].title, /retry 1 of 3/);
  assert.match(retries[2].title, /retry 3 of 3/);
  assert.match(retries[0].detail, /HTTP 503/, "the failure is still in the detail");
  assert.equal(state.stats.failures, 0);
});

test("after three retries a transient error ends the run", async () => {
  const ai = scripted((request) => request.label === "autopilot:concept" ? unavailable("HTTP 503 — still down") : undefined);
  const { state, events: emitted } = await run(ai);
  assert.equal(state.status, "error");
  assert.match(state.lastError.message, /still down/);
  assert.equal(concepts(ai).length, 4, "the first try and three retries");
  assert.equal(retriesOf(emitted).length, 3);
  assert.equal(state.stats.failures, 1);
});

test("the retries of a step start over after a success, whatever the step", async () => {
  const ai = scripted((request, seen) => (request.label === "autopilot:concept" || request.label === "autopilot:plan") && seen < 3 ? unavailable() : undefined);
  const { state, events: emitted } = await run(ai);
  assert.equal(state.status, "completed");
  assert.equal(retriesOf(emitted).length, 6, "three for the concept, three for the plan");
});

test("the wait respects Retry-After, the longer of it and the backoff, scaled like every delay", async () => {
  const limited = (retryAfterMs) => new AiProviderError("HTTP 429 — slow down", 429, true, { transient: true, retryAfterMs });
  const longer = await run(scripted((request, seen) => request.label === "autopilot:concept" && seen === 0 ? limited(20_000) : undefined));
  assert.deepEqual(retriesOf(longer.events).map((event) => event.waitMs), [200], "20 s asked, scaled by 40/4000, beats the 40 ms backoff");

  const shorter = await run(scripted((request, seen) => request.label === "autopilot:concept" && seen === 0 ? limited(1_000) : undefined));
  assert.deepEqual(retriesOf(shorter.events).map((event) => event.waitMs), [40], "a short Retry-After does not shorten the backoff");

  const later = await run(scripted((request, seen) => request.label === "autopilot:concept" && seen < 2 ? (seen === 1 ? limited(60_000) : unavailable()) : undefined));
  assert.deepEqual(retriesOf(later.events).map((event) => event.waitMs), [40, 600]);
});

test("the jitter keeps every wait within a quarter of its base", async () => {
  const lows = await run(scripted((request, seen) => request.label === "autopilot:concept" && seen < 3 ? unavailable() : undefined), ONE_SCENE, { random: () => 0 });
  assert.deepEqual(retriesOf(lows.events).map((event) => event.waitMs), [30, 90, 270]);
  const highs = await run(scripted((request, seen) => request.label === "autopilot:concept" && seen < 3 ? unavailable() : undefined), ONE_SCENE, { random: () => 0.999999 });
  assert.deepEqual(retriesOf(highs.events).map((event) => event.waitMs), [50, 150, 450]);
});

test("with retryDelayMs 0 every delay is 0, Retry-After included", async () => {
  const ai = scripted((request, seen) => request.label === "autopilot:concept" && seen < 3 ? new AiProviderError("HTTP 429", 429, true, { transient: true, retryAfterMs: 120_000 }) : undefined);
  const started = Date.now();
  const { state, events: emitted } = await run(ai, ONE_SCENE, { retryDelayMs: 0 });
  assert.equal(state.status, "completed");
  assert.deepEqual(retriesOf(emitted).map((event) => event.waitMs), [0, 0, 0]);
  assert.ok(Date.now() - started < 5_000);
});

test("without retryDelayMs the delays are the real ones: 4 s, 12 s, 36 s", async () => {
  const store = new MemoryBookStore(seedBookFiles());
  const emitted = [];
  const ai = scripted((request, seen) => request.label === "autopilot:concept" && seen === 0 ? unavailable() : undefined);
  const session = new AutopilotSession({ bookId: "book", store, ai, host: "server", hostLabel: "test", random: () => 0.5 });
  session.subscribe((event) => emitted.push(event));
  await session.start(ONE_SCENE);
  await waitFor(() => retriesOf(emitted).length === 1);
  assert.equal(retriesOf(emitted)[0].waitMs, 4_000);
  session.pause("now");
  await session.waitForIdle();
});

test("a rejected reply is retried once, with the reason, and a second rejection ends the run", async () => {
  const ai = scripted((request) => request.label === "autopilot:concept" ? new AiReplyRejectedError("The concept was rejected: the field \"storyDesign\" is missing.") : undefined);
  const { state, events: emitted } = await run(ai);
  assert.equal(state.status, "error");
  assert.equal(concepts(ai).length, 2);
  assert.match(concepts(ai)[1].user, /previous reply to this request was rejected because: The concept was rejected/);
  const retries = retriesOf(emitted);
  assert.equal(retries.length, 1);
  assert.match(retries[0].title, /retrying once/);
  assert.deepEqual([retries[0].attempt, retries[0].retries, retries[0].waitMs], [1, 1, 40]);
});

test("a transient retry repeats the request unchanged: only a rejected reply carries a note", async () => {
  const ai = scripted((request, seen) => request.label === "autopilot:concept" && seen === 0 ? unavailable() : undefined);
  await run(ai);
  assert.equal(concepts(ai)[1].user, concepts(ai)[0].user);
});

test("the same deterministic failure twice in a row stops at once, a transient one may repeat", async () => {
  const stuck = scripted((request) => request.label === "autopilot:concept" ? new AiProviderError("openai m: HTTP 500 — context too long", 500, true) : undefined);
  const first = await run(stuck);
  assert.equal(first.state.status, "error");
  assert.equal(concepts(stuck).length, 2, "one retry, then the same message again: no third try");
  assert.equal(retriesOf(first.events).length, 1);

  const empty = scripted((request) => request.label === "autopilot:concept" ? new AiProviderError("openai m: the provider returned an empty reply.", undefined, true) : undefined);
  assert.equal((await run(empty)).state.status, "error");
  assert.equal(concepts(empty).length, 2);

  const varied = scripted((request, seen) => request.label === "autopilot:concept" ? new AiProviderError(`openai m: HTTP 500 — attempt ${seen % 2}`, 500, true) : undefined);
  const mixed = await run(varied);
  assert.equal(mixed.state.status, "error");
  assert.equal(concepts(varied).length, 4, "different messages are not 'the same rejection': the three retries are used");

  const repeating = scripted((request) => request.label === "autopilot:concept" ? unavailable("openai m: HTTP 503 — overloaded") : undefined);
  const down = await run(repeating);
  assert.equal(concepts(repeating).length, 4, "an overloaded provider says the same thing every time: keep waiting");
  assert.equal(down.state.status, "error");

  const network = scripted((request) => request.label === "autopilot:concept" ? new AiProviderError("openai m: request timed out", undefined, true, { transient: true }) : undefined);
  await run(network);
  assert.equal(concepts(network).length, 4);
});

test("a provider failure from another AI port is read by its status or its words when it does not say it is transient", async () => {
  for (const error of [new AiProviderError("HTTP 503 — overloaded", 503, true), new AiProviderError("Connection error.", undefined, true), new AiProviderError("Request timed out.", undefined, true), new AiProviderError("HTTP 429 — slow down", 429, true)]) {
    const ai = scripted((request) => request.label === "autopilot:concept" ? error : undefined);
    const { state } = await run(ai);
    assert.equal(state.status, "error", error.message);
    assert.equal(concepts(ai).length, 4, `${error.message}: the same words again are no reason to give up on a busy or unreachable provider`);
  }
  const deterministic = scripted((request) => request.label === "autopilot:concept" ? new AiProviderError("The model refused to answer.", undefined, true) : undefined);
  await run(deterministic);
  assert.equal(concepts(deterministic).length, 2);
});

test("errors that are not provider failures keep a single retry", async () => {
  const ai = scripted((request) => request.label === "autopilot:concept" ? Object.assign(new Error("git pull timed out"), { retryable: true }) : undefined);
  const { state, events: emitted } = await run(ai);
  assert.equal(state.status, "error");
  assert.equal(concepts(ai).length, 2);
  assert.equal(retriesOf(emitted).length, 1);
  assert.match(retriesOf(emitted)[0].title, /retrying once/);
});

test("final errors are never retried: a bad key, a refused budget, a cut reply", async () => {
  for (const error of [new AiProviderError("HTTP 401 — invalid api key", 401, false), new engine.AiRoutingBudgetError("The first routing candidate exceeds the budget."), new AiProviderError("cut", undefined, false, { truncated: true })]) {
    const ai = scripted((request) => request.label === "autopilot:concept" ? error : undefined);
    const { state, events: emitted } = await run(ai);
    assert.equal(state.status, "error", error.message);
    assert.equal(concepts(ai).length, 1, error.message);
    assert.equal(retriesOf(emitted).length, 0, error.message);
  }
});

async function waitFor(condition, timeoutMs = 4_000) {
  const started = Date.now();
  while (!condition()) {
    if (Date.now() - started > timeoutMs) throw new Error("timed out waiting");
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
}

test("Pause now interrupts a long wait between retries", async () => {
  const store = new MemoryBookStore(seedBookFiles());
  const emitted = [];
  const ai = scripted((request) => request.label === "autopilot:concept" ? unavailable() : undefined);
  const session = new AutopilotSession({ bookId: "book", store, ai, host: "server", hostLabel: "test", retryDelayMs: 60_000, random: () => 0.5 });
  session.subscribe((event) => emitted.push(event));
  await session.start(ONE_SCENE);
  await waitFor(() => retriesOf(emitted).length === 1);
  const started = Date.now();
  session.pause("now");
  await session.waitForIdle();
  assert.ok(Date.now() - started < 3_000, "not a minute later");
  const state = (await session.snapshot()).state;
  assert.equal(state.status, "paused");
  assert.equal(concepts(ai).length, 1, "no further AI call");
  const activities = (await engine.readStoredAutopilot(store)).activities;
  assert.equal(activities.at(-1).status, "failed", "the failed attempt was saved before the wait");
});

test("Pause after the step also ends the wait instead of sitting through it", async () => {
  const store = new MemoryBookStore(seedBookFiles());
  const emitted = [];
  const ai = scripted((request) => request.label === "autopilot:concept" ? unavailable() : undefined);
  const session = new AutopilotSession({ bookId: "book", store, ai, host: "server", hostLabel: "test", retryDelayMs: 60_000, random: () => 0.5 });
  session.subscribe((event) => emitted.push(event));
  await session.start(ONE_SCENE);
  await waitFor(() => retriesOf(emitted).length === 1);
  const started = Date.now();
  assert.equal(session.pause("after-step"), true);
  await session.waitForIdle();
  assert.ok(Date.now() - started < 3_000);
  assert.equal((await session.snapshot()).state.status, "paused");
  assert.equal(concepts(ai).length, 1);

  const resumed = new AutopilotSession({ bookId: "book", store, ai: createFakeAutopilotAi(), host: "server", hostLabel: "test", retryDelayMs: 0 });
  await resumed.start();
  await resumed.waitForIdle();
  assert.equal((await resumed.snapshot()).state.status, "completed", "and the run resumes from where it was");
});

test("a retry that was waiting is cancelled cleanly when the run is stopped before the wait starts", async () => {
  const ai = scripted((request) => request.label === "autopilot:concept" ? unavailable() : undefined);
  const store = new MemoryBookStore(seedBookFiles());
  const session = new AutopilotSession({ bookId: "book", store, ai, host: "server", hostLabel: "test", retryDelayMs: 60_000 });
  await session.start(ONE_SCENE);
  session.pause("now");
  await session.waitForIdle();
  assert.equal((await session.snapshot()).state.status, "paused");
});
