import test from "node:test";
import assert from "node:assert/strict";
import * as engine from "../dist/index.js";
import { MemoryBookStore, createFakeAutopilotAi, seedBookFiles } from "../dist/testing/index.js";

// New exports are read from the namespace so that, before they exist, each test fails on its own.
const { AiProviderError, AutopilotSession, createAutopilotState, parseAutopilotState, readStoredAutopilot, serializeAutopilotState, summarizeAutopilotState } = engine;

const STATE = "autopilot/state.json";
const FAST = { readers: false, readersOnPlan: false, specialists: false, pauseAfterPlan: false };
const BOOK = (chapters = 2) => ({ brief: { idea: "x", targetChapters: chapters, scenesPerChapter: 1, wordsPerScene: 300 }, options: FAST });
const HOUR = 3_600_000;

const stateOf = (store) => parseAutopilotState(store.files.get(STATE));
const summaries = (events) => events.filter((event) => event.type === "state").map((event) => event.state);

function fakeClock(start = Date.parse("2026-02-01T08:00:00.000Z")) {
  const clock = { t: start, now: () => new Date(clock.t) };
  return clock;
}

/** The fake AI where every call takes `cost(request)` milliseconds of the fake clock: nothing else moves it. */
function slowAi(clock, cost, options = {}) {
  const base = createFakeAutopilotAi({ reviewVerdict: () => "approve", scenes: 1, ...options });
  return {
    calls: base.calls,
    async complete(request) {
      clock.t += cost(request);
      return base.complete(request);
    },
  };
}

const COSTS = { "autopilot:concept": 1000, "autopilot:plan": 2500, "autopilot:plan-review": 4000 };
const cost = (request) => COSTS[request.label] ?? 700;

function session(store, ai, clock, extra = {}) {
  const events = [];
  const instance = new AutopilotSession({ bookId: "book", store, ai, host: "server", hostLabel: "test", retryDelayMs: 0, now: clock.now, ...extra });
  instance.subscribe((event) => events.push(event));
  return { session: instance, events };
}

/** One run that saves `count` steps and pauses. */
async function steps(autopilot, count, start = {}) {
  await autopilot.start({ ...start, limits: { steps: count } });
  await autopilot.waitForIdle();
}

const durationOf = (activity) => Date.parse(activity.endedAt) - Date.parse(activity.startedAt);

// ─── The worked time is the sum of the steps that were saved ────────────────

test("three steps with a fake clock: the worked time is the sum of their durations, saved with the other statistics and in the summary", async () => {
  const clock = fakeClock();
  const store = new MemoryBookStore(seedBookFiles());
  const { session: autopilot, events } = session(store, slowAi(clock, cost), clock);
  await steps(autopilot, 3, BOOK());
  const state = stateOf(store);
  assert.equal(state.status, "paused", state.lastError?.message);
  assert.equal(state.stats.tasks, 3);
  assert.equal(state.stats.workedMs, 1000 + 2500 + 4000);
  assert.ok(Number.isInteger(state.stats.workedMs) && state.stats.workedMs >= 0);

  assert.equal(summaries(events).at(-1).stats.workedMs, 7500, "in the summary of the live events");
  assert.equal((await autopilot.snapshot()).summary.stats.workedMs, 7500, "and in the summary of a client that connects later");
  assert.equal(summarizeAutopilotState(state).stats.workedMs, 7500, "and in the summary made from the file");
  const seen = [];
  for (const { stats } of summaries(events)) if (stats.tasks > 0 && !seen.some(([tasks]) => tasks === stats.tasks)) seen.push([stats.tasks, stats.workedMs]);
  assert.deepEqual(seen, [[1, 1000], [2, 3500], [3, 7500]], "updated at every step, with the rest of the statistics");
  const finished = events.filter((event) => event.type === "task-finished").map((event) => durationOf(event.activity));
  assert.deepEqual(finished, [1000, 2500, 4000], "the durations of the steps are the ones the activities show");
});

test("a long pause between two runs does not count, whoever runs next", async () => {
  const clock = fakeClock();
  const store = new MemoryBookStore(seedBookFiles());
  const first = session(store, slowAi(clock, cost), clock);
  await steps(first.session, 3, BOOK());
  assert.equal(stateOf(store).stats.workedMs, 7500);

  clock.t += 6 * HOUR;
  const second = session(store, slowAi(clock, cost), clock);
  await steps(second.session, 2);
  const state = stateOf(store);
  assert.equal(state.status, "paused", state.lastError?.message);
  assert.equal(state.stats.tasks, 5);
  const calls = second.events.filter((event) => event.type === "task-finished").map((event) => durationOf(event.activity));
  assert.deepEqual(calls, [700, 1400], "the scene plan is one call, the scene is two (the prose and its summary)");
  assert.equal(state.stats.workedMs, 7500 + 700 + 1400, "the six hours are not work, and the new run adds to what the other one saved");

  clock.t += 30 * 24 * HOUR;
  await steps(session(store, slowAi(clock, cost), clock).session, 1);
  assert.equal(stateOf(store).stats.workedMs, 7500 + 700 + 1400 + 700, "nor are thirty days");
});

test("the wait for the author does not count", async () => {
  const clock = fakeClock();
  const store = new MemoryBookStore(seedBookFiles());
  const base = slowAi(clock, cost);
  const question = { question: "Which ending?", options: ["Hopeful", "Bleak"] };
  const ai = {
    calls: base.calls,
    async complete(request) {
      if (request.label !== "autopilot:plan-review") return base.complete(request);
      clock.t += cost(request);
      const json = { verdict: "approve", score: 8, summary: "A solid plan.", strengths: [], changes: [], guidance: [], questionForAuthor: question };
      return { text: JSON.stringify(json), json, usage: { inputTokens: 1, outputTokens: 1, cachedInputTokens: 0 }, model: "fake-model", provider: "fake", cost: 0.001, currency: "USD" };
    },
  };
  const { session: autopilot } = session(store, ai, clock);
  await autopilot.start(BOOK());
  await autopilot.waitForIdle();
  const waiting = stateOf(store);
  assert.equal(waiting.status, "waiting-author");
  assert.equal(waiting.stats.workedMs, 7500);

  clock.t += 3 * HOUR;
  await autopilot.answer({ questionId: waiting.question.id, answer: "Hopeful" });
  clock.t += HOUR;
  await steps(autopilot, 1);
  assert.equal(stateOf(store).stats.workedMs, 7500 + 700, "four hours of waiting for the author, and none of them is work");
});

test("a step that failed and was tried again counts the attempt that was saved: not the failed one, nor the wait between the two", async () => {
  const clock = fakeClock();
  const store = new MemoryBookStore(seedBookFiles());
  const base = slowAi(clock, cost);
  let failed = 0;
  const ai = {
    calls: base.calls,
    async complete(request) {
      if (request.label === "autopilot:concept" && failed < 2) {
        failed += 1;
        clock.t += 5000;
        throw new AiProviderError("HTTP 503 — overloaded", 503, true, { transient: true });
      }
      return base.complete(request);
    },
  };
  const { session: autopilot, events } = session(store, ai, clock);
  autopilot.subscribe((event) => {
    if (event.type === "insight" && event.code === "failureRetry") clock.t += 60_000;
  });
  await steps(autopilot, 1, BOOK());
  const state = stateOf(store);
  assert.equal(failed, 2);
  assert.equal(events.filter((event) => event.type === "insight" && event.code === "failureRetry").length, 2);
  assert.equal(state.stats.tasks, 1);
  assert.equal(state.stats.failures, 0);
  assert.equal(state.stats.workedMs, 1000, "only the step that was committed, from its own start to its own end");
});

test("a step that is abandoned, or that fails for good, adds nothing", async () => {
  const clock = fakeClock();
  const store = new MemoryBookStore(seedBookFiles());
  const base = slowAi(clock, cost);
  const failing = {
    calls: base.calls,
    async complete(request) {
      if (request.label !== "autopilot:plan") return base.complete(request);
      clock.t += 9000;
      throw new AiProviderError("HTTP 401 — invalid api key", 401, false);
    },
  };
  const { session: autopilot } = session(store, failing, clock);
  await autopilot.start(BOOK());
  await autopilot.waitForIdle();
  const state = stateOf(store);
  assert.equal(state.status, "error");
  assert.equal(state.stats.tasks, 1, "only the concept was saved");
  assert.equal(state.stats.workedMs, 1000, "the nine seconds of the plan that failed are not worked time");
});

test("a clock that goes backwards never makes the worked time negative or fractional", async () => {
  const clock = fakeClock();
  const store = new MemoryBookStore(seedBookFiles());
  const ai = slowAi(clock, (request) => (request.label === "autopilot:concept" ? -5000 : 400));
  const { session: autopilot } = session(store, ai, clock);
  await steps(autopilot, 2, BOOK());
  const { workedMs } = stateOf(store).stats;
  assert.ok(Number.isInteger(workedMs), String(workedMs));
  assert.equal(workedMs, 0 + 400, "a step that seems to take negative time counts for nothing");
});

test("a pause that abandons the request in flight adds nothing for the step it cut short", async () => {
  const clock = fakeClock();
  const store = new MemoryBookStore(seedBookFiles());
  const base = slowAi(clock, cost);
  let reached;
  const waiting = new Promise((resolve) => {
    reached = resolve;
  });
  const ai = {
    calls: base.calls,
    complete(request) {
      clock.t += 20_000;
      reached();
      return new Promise((_resolve, reject) => request.signal.addEventListener("abort", () => reject(request.signal.reason), { once: true }));
    },
  };
  const { session: autopilot } = session(store, ai, clock);
  await autopilot.start(BOOK());
  await waiting;
  autopilot.pause("now");
  await autopilot.waitForIdle();
  const state = stateOf(store);
  assert.equal(state.status, "paused");
  assert.equal(state.stats.workedMs ?? 0, 0);
});

// ─── It outlives the activity log, and older states have none ───────────────

test("the worked time survives the limit of the activity log: it counts every step, not the last 200", async () => {
  const clock = fakeClock();
  const store = new MemoryBookStore(seedBookFiles());
  const ai = slowAi(clock, () => 13, { scenes: 1, words: 120 });
  const { session: autopilot, events } = session(store, ai, clock);
  await autopilot.start({ brief: { idea: "x", targetChapters: 70, scenesPerChapter: 1, wordsPerScene: 200 }, options: FAST });
  await autopilot.waitForIdle();
  const state = stateOf(store);
  assert.equal(state.status, "completed", state.lastError?.message);
  const durations = events.filter((event) => event.type === "task-finished" && event.activity.status === "succeeded").map((event) => durationOf(event.activity));
  const total = durations.reduce((sum, duration) => sum + duration, 0);
  assert.ok(durations.length > 250, `${durations.length} steps`);
  assert.equal(state.stats.workedMs, total, "every step that was saved");
  const log = (await readStoredAutopilot(store)).activities;
  assert.equal(log.length, 200, "the log keeps only its last 200 entries");
  const inLog = log.reduce((sum, activity) => sum + durationOf(activity), 0);
  assert.ok(total > inLog, "so the log alone says less");
  assert.equal(summaries(events).at(-1).stats.workedMs, total);
});

test("a state saved before the worked time existed starts from zero, and its summary says nothing of it until a step is saved", async () => {
  const old = createAutopilotState(new Date(0), BOOK().brief, FAST);
  assert.equal("workedMs" in old.stats, false, "a state that was just created has none either");
  const store = new MemoryBookStore({ ...seedBookFiles(), [STATE]: serializeAutopilotState({ ...old, stats: { tasks: 4, aiCalls: 9, inputTokens: 900, outputTokens: 400, cost: 0.1, failures: 0 } }) });
  const parsed = stateOf(store);
  assert.equal(parsed.stats.workedMs, undefined);
  assert.equal("workedMs" in parsed.stats, false);
  const summary = summarizeAutopilotState(parsed);
  assert.equal("workedMs" in summary.stats, false, "absent, not zero and not NaN");
  assert.equal(Number.isNaN(summary.stats.workedMs), false);

  const clock = fakeClock();
  const { session: autopilot, events } = session(store, slowAi(clock, cost), clock);
  assert.equal("workedMs" in (await autopilot.snapshot()).summary.stats, false);
  await steps(autopilot, 1);
  assert.equal(stateOf(store).stats.workedMs, 1000, "it starts from zero: this step is all the file knows about");
  assert.equal(stateOf(store).stats.tasks, 5, "and the rest of the statistics go on from what the file said");
  assert.equal(summaries(events).at(-1).stats.workedMs, 1000);
});

test("the worked time is read as a non-negative whole number of milliseconds, and what is not a number is no value", () => {
  const read = (workedMs) => parseAutopilotState(JSON.stringify({ ...createAutopilotState(new Date(0)), stats: { tasks: 1, aiCalls: 1, inputTokens: 1, outputTokens: 1, cost: 0, failures: 0, workedMs } })).stats.workedMs;
  assert.equal(read(0), 0);
  assert.equal(read(12_345), 12_345);
  assert.equal(read(12.7), 13);
  assert.equal(read(-5), 0);
  assert.equal(read("9000"), 9000);
  assert.ok(Number.isSafeInteger(read(1e30)));
  for (const value of ["soon", null, [], {}, true, undefined]) assert.equal(read(value), undefined, JSON.stringify(value));
  let current = { ...createAutopilotState(new Date(0)), stats: { tasks: 1, aiCalls: 1, inputTokens: 1, outputTokens: 1, cost: 0, failures: 0, workedMs: 42_000 } };
  for (let pass = 0; pass < 3; pass += 1) current = parseAutopilotState(serializeAutopilotState(current));
  assert.equal(current.stats.workedMs, 42_000, "it survives every save");
});
