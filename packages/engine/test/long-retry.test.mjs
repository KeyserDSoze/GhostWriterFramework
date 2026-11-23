import test from "node:test";
import assert from "node:assert/strict";
import * as engine from "../dist/index.js";
import { MemoryBookStore, createFakeAutopilotAi, seedBookFiles } from "../dist/testing/index.js";

// New exports are read from the namespace so that, before they exist, each test fails on its own.
const { AiProviderError, AiReplyRejectedError, AutopilotSession, parseAutopilotState } = engine;

// ─── «Retry later»: the long-term retry of a step that keeps failing with a transient provider error ──────────────────────
// The short level repeats a failed step up to three times (4 s, 12 s, 36 s); the long level, when the author turns it on
// (`options.longRetry`), waits `everyMinutes` once those are used up and opens a new group of attempts, up to `cycles` times or
// without a limit ("unlimited"). Every wait scales with `retryDelayMs` (the long one too), so these tests take milliseconds.

const STATE = "autopilot/state.json";
const FAST = { readers: false, readersOnPlan: false, specialists: false, pauseAfterPlan: false };
const BRIEF = { idea: "x", targetChapters: 1, scenesPerChapter: 1, wordsPerScene: 300 };

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

const down = (message = "openai m: HTTP 503 — overloaded") => new AiProviderError(message, 503, true, { transient: true });
/** A failure that says the same words every time and does not depend on the moment: the short level gives up after one retry. */
const crashed = () => new AiProviderError("openai m: HTTP 500 — the node crashed", 500, true);
/** The concept fails its first `times` calls (with `error(seen)`), then works. */
const conceptFails = (times, error = () => down()) => scripted((request, seen) => (request.label === "autopilot:concept" && seen < times ? error(seen) : undefined));

function newSession(store, ai, extra = {}) {
  const events = [];
  const session = new AutopilotSession({ bookId: "book", store, ai, host: "server", hostLabel: "test", retryDelayMs: 0, random: () => 0.5, ...extra });
  session.subscribe((event) => events.push(event));
  return { session, events };
}

async function run(ai, { options = {}, extra = {}, files = seedBookFiles() } = {}) {
  const store = new MemoryBookStore(files);
  const { session, events } = newSession(store, ai, extra);
  await session.start({ brief: BRIEF, options: { ...FAST, ...options } });
  await session.waitForIdle();
  return { store, session, events, state: parseAutopilotState(store.files.get(STATE)) };
}

const insights = (events, code) => events.filter((event) => event.type === "insight" && event.code === code);
const runEnded = (events) => events.filter((event) => event.type === "run-ended");
const concepts = (ai) => ai.calls.filter((call) => call.label === "autopilot:concept").length;
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

async function waitFor(condition, what, timeoutMs = 8_000) {
  const started = Date.now();
  while (!(await condition())) {
    if (Date.now() - started > timeoutMs) assert.fail(`Timed out waiting for ${what}.`);
    await sleep(4);
  }
}

// ─── The option ─────────────────────────────────────────────────────────────

test("options.longRetry is off unless the author turns it on: absent, null and every value that is not a policy are off, never made up or cut", () => {
  assert.equal(engine.LONG_RETRY_MAX_MINUTES, 10_080);
  assert.equal(engine.LONG_RETRY_MAX_CYCLES, 1000);
  assert.equal(engine.DEFAULT_OPTIONS.longRetry, undefined, "off by default");
  assert.deepEqual(engine.normalizeOptions({}), engine.DEFAULT_OPTIONS, "an empty request adds nothing");
  assert.ok(engine.LIVE_AUTOPILOT_OPTIONS.includes("longRetry"), "it can change while a run goes on");

  const valid = [
    [{ everyMinutes: 15, cycles: 3 }, { everyMinutes: 15, cycles: 3 }],
    [{ everyMinutes: 1, cycles: 1 }, { everyMinutes: 1, cycles: 1 }],
    [{ everyMinutes: 10_080, cycles: 1000 }, { everyMinutes: 10_080, cycles: 1000 }],
    [{ everyMinutes: 60, cycles: "unlimited" }, { everyMinutes: 60, cycles: "unlimited" }],
    [{ everyMinutes: 60, cycles: " Unlimited " }, { everyMinutes: 60, cycles: "unlimited" }],
    [{ everyMinutes: 30, cycles: 2, note: "kept out" }, { everyMinutes: 30, cycles: 2 }],
  ];
  for (const [value, expected] of valid) {
    assert.deepEqual(engine.normalizeOptions({ longRetry: value }).longRetry, expected, JSON.stringify(value));
    assert.deepEqual(parseAutopilotState(JSON.stringify({ options: { longRetry: value } })).options.longRetry, expected, `read from a file: ${JSON.stringify(value)}`);
  }

  const invalid = [
    { everyMinutes: 0, cycles: 3 }, { everyMinutes: -5, cycles: 3 }, { everyMinutes: 15.5, cycles: 3 }, { everyMinutes: Number.NaN, cycles: 3 },
    { everyMinutes: "15", cycles: 3 }, { everyMinutes: 10_081, cycles: 3 }, { everyMinutes: Number.POSITIVE_INFINITY, cycles: 3 },
    { everyMinutes: 15, cycles: 0 }, { everyMinutes: 15, cycles: 1001 }, { everyMinutes: 15, cycles: 2.5 }, { everyMinutes: 15, cycles: -1 },
    { everyMinutes: 15, cycles: "3" }, { everyMinutes: 15, cycles: "forever" }, { everyMinutes: 15, cycles: "" }, { everyMinutes: 15, cycles: null },
    { everyMinutes: 15 }, { cycles: 3 }, {}, [], [15, 3], "15", 15, true, "unlimited",
  ];
  const on = engine.normalizeOptions({ longRetry: { everyMinutes: 20, cycles: 4 } });
  for (const value of invalid) {
    assert.equal(engine.normalizeOptions({ longRetry: value }).longRetry, undefined, `${JSON.stringify(value)} is off`);
    assert.equal(parseAutopilotState(JSON.stringify({ options: { longRetry: value } })).options.longRetry, undefined, `${JSON.stringify(value)} read from a file is off`);
    assert.deepEqual(engine.normalizeOptions({ longRetry: value }, on).longRetry, { everyMinutes: 20, cycles: 4 }, `${JSON.stringify(value)} changes nothing`);
  }
  assert.equal(engine.normalizeOptions({ longRetry: null }, on).longRetry, undefined, "null turns it off");
  assert.equal(parseAutopilotState(JSON.stringify({ options: { longRetry: null } })).options.longRetry, undefined);
  const saved = parseAutopilotState(engine.serializeAutopilotState({ ...engine.createAutopilotState(new Date(0)), options: on }));
  assert.deepEqual(saved.options.longRetry, { everyMinutes: 20, cycles: 4 }, "saved with the other options");
});

test("longRetryProblem says in plain words why a value is not a policy; a host checks what it sends with it", () => {
  assert.equal(engine.longRetryProblem(null), null, "null turns it off");
  assert.equal(engine.longRetryProblem({ everyMinutes: 15, cycles: 3 }), null);
  assert.equal(engine.longRetryProblem({ everyMinutes: 15, cycles: "unlimited" }), null);
  const problems = [
    [{ everyMinutes: 0, cycles: 3 }, /everyMinutes.*1.*10080/],
    [{ everyMinutes: 15.5, cycles: 3 }, /everyMinutes.*whole number/],
    [{ everyMinutes: "15", cycles: 3 }, /everyMinutes/],
    [{ everyMinutes: 15, cycles: 1001 }, /cycles.*1.*1000.*unlimited/],
    [{ everyMinutes: 15, cycles: "forever" }, /cycles/],
    [{ everyMinutes: 15, cycles: " Unlimited " }, /cycles/],
    [{ everyMinutes: 15 }, /cycles/],
    [{ cycles: 3 }, /everyMinutes/],
    [{ everyMinutes: 15, cycles: 3, extra: 1 }, /extra/],
    ["often", /object/],
    [[15, 3], /object/],
    [undefined, /object/],
  ];
  for (const [value, pattern] of problems) assert.match(engine.longRetryProblem(value) ?? "", pattern, JSON.stringify(value));
});

// ─── Which failures may wait ────────────────────────────────────────────────

test("only a transient provider failure may open a long cycle: a closed list, crossed with the short level", () => {
  const { classifyRetry } = engine;
  const rows = [
    // [what, error, the short level's kind, a long cycle]
    ["HTTP 503 (transient)", down(), "transient", true],
    ["HTTP 500 with no flag", new AiProviderError("HTTP 500", 500, true), "transient", true],
    ["HTTP 502", new AiProviderError("HTTP 502", 502, true, { transient: true }), "transient", true],
    ["HTTP 504", new AiProviderError("HTTP 504", 504, true, { transient: true }), "transient", true],
    ["HTTP 408", new AiProviderError("HTTP 408", 408, true, { transient: true }), "transient", true],
    ["HTTP 429", new AiProviderError("HTTP 429", 429, true, { transient: true, retryAfterMs: 2000 }), "transient", true],
    ["the endpoint cannot be reached", new AiProviderError("openai m: fetch failed", undefined, true, { transient: true }), "transient", true],
    ["a timeout", new AiProviderError("openai m: no answer in 600 s", undefined, true, { transient: true, timedOut: true }), "transient", true],
    ["the stream was lost", new AiProviderError("openai m: the connection with the provider was lost", undefined, true, { transient: true }), "transient", true],
    ["an empty reply", new AiProviderError("openai m: the provider returned an empty reply.", undefined, true), "transient", true],
    ["a stream that ended before [DONE]", new AiProviderError("openai m: unexpected finish reason \"x\"", undefined, true), "transient", true],
    ["HTTP 409 (retryable, not about time)", new AiProviderError("HTTP 409", 409, true), "transient", false],
    ["a rejected reply", new AiReplyRejectedError("The concept was rejected: the field \"storyDesign\" is missing."), "rejected", false],
    ["a reply that is not JSON", new engine.StructuredReplyError("The model reply is not valid JSON."), "rejected", false],
    ["HTTP 400", new AiProviderError("HTTP 400", 400, false), null, false],
    ["HTTP 401", new AiProviderError("HTTP 401 — invalid api key", 401, false), null, false],
    ["HTTP 403", new AiProviderError("HTTP 403", 403, false), null, false],
    ["HTTP 404", new AiProviderError("HTTP 404", 404, false), null, false],
    ["HTTP 422", new AiProviderError("HTTP 422", 422, false), null, false],
    ["a reply cut by the output limit", new AiProviderError("cut", undefined, false, { truncated: true }), null, false],
    ["a model that looped (runaway stream)", new AiProviderError("openai m: the stream went over 256 MB", undefined, false), null, false],
    ["a prompt no window holds", new engine.AiPromptTooLargeError("too large", 300_000, 100_000), null, false],
    ["the routing budget", new engine.AiRoutingBudgetError("over budget"), null, false],
    ["a fallback the privacy settings keep out", new engine.AiFallbackBlockedError("blocked"), null, false],
    ["Tools only with no model that calls functions", new engine.AiToolsRequiredError("tools", ["m"]), null, false],
    ["no model routed to the task", new engine.AiUnavailableError("autopilot"), null, false],
    ["a conflict of the book", new engine.BookConflictError("changed"), null, false],
    ["the author's pause", new DOMException("Paused by the author.", "AbortError"), null, false],
    ["a front matter that cannot be read", new engine.FrontmatterError("chapters/x.md", "bad YAML"), null, false],
    ["an error a host marks retryable", Object.assign(new Error("git pull timed out"), { retryable: true }), "other", false],
    ["an error nobody classified", new Error("Something unexpected"), null, false],
    ["a value that is not an error", "HTTP 503", null, false],
    ["nothing", undefined, null, false],
  ];
  for (const [what, error, short, long] of rows) {
    const classified = classifyRetry(error);
    assert.equal(classified.short, short, `${what}: the short level`);
    assert.equal(classified.long, long, `${what}: the long level`);
  }
});

test("a failure that may not wait ends the run as it always did, with the long level on", async () => {
  const cases = [
    [new AiReplyRejectedError("The concept was rejected: the field \"storyDesign\" is missing."), 2],
    [new AiProviderError("HTTP 401 — invalid api key", 401, false), 1],
    [new AiProviderError("openai m: HTTP 409 — conflict", 409, true), 2],
    [new engine.AiToolsRequiredError("Tools only is on and no model can call a function.", ["m"]), 1],
    [Object.assign(new Error("git pull timed out"), { retryable: true }), 2],
  ];
  for (const [error, calls] of cases) {
    const ai = conceptFails(Number.POSITIVE_INFINITY, () => error);
    const { state, events } = await run(ai, { options: { longRetry: { everyMinutes: 1, cycles: 3 } } });
    assert.equal(state.status, "error", error.message);
    assert.equal(concepts(ai), calls, `${error.message}: the attempts it always had`);
    assert.equal(insights(events, "longRetryWait").length, 0, `${error.message}: no long wait`);
  }
});

// ─── The cycles ─────────────────────────────────────────────────────────────

test("after the short retries are used up, one long cycle opens a new group of attempts; without the option the run ends as it did", async () => {
  const off = conceptFails(4);
  const before = await run(off);
  assert.equal(before.state.status, "error", "the short level alone gives up after four attempts");
  assert.equal(concepts(off), 4);

  const ai = conceptFails(4);
  const { state, events } = await run(ai, { options: { longRetry: { everyMinutes: 1, cycles: 1 } } });
  assert.equal(state.status, "completed", state.lastError?.message);
  assert.equal(concepts(ai), 5, "four attempts, the wait, and the fifth works");
  const waits = insights(events, "longRetryWait");
  assert.deepEqual(waits.map((event) => [event.cycle, event.cycles, event.waitMs]), [[1, 1, 0]], "retryDelayMs 0 makes the long wait instant too");
  assert.equal(waits[0].tone, "warning");
  assert.match(waits[0].detail, /HTTP 503/, "the failure is in the detail");
  assert.equal(insights(events, "failureRetry").length, 3);
  assert.equal(state.stats.failures, 0, "the step went well in the end");
  assert.equal(runEnded(events).at(-1).code, undefined);
});

test("two cycles, and the end: when the cycles are used up the run stops with the error, after N restarts, with the code longRetryExhausted", async () => {
  const twice = conceptFails(8);
  const fine = await run(twice, { options: { longRetry: { everyMinutes: 1, cycles: 2 } } });
  assert.equal(fine.state.status, "completed", fine.state.lastError?.message);
  assert.equal(concepts(twice), 9);
  assert.deepEqual(insights(fine.events, "longRetryWait").map((event) => [event.cycle, event.cycles]), [[1, 2], [2, 2]]);

  const always = conceptFails(Number.POSITIVE_INFINITY, () => down("openai m: HTTP 503 — still down"));
  const { state, events } = await run(always, { options: { longRetry: { everyMinutes: 1, cycles: 2 } } });
  assert.equal(state.status, "error");
  assert.equal(concepts(always), 12, "(1 + 3) attempts × (1 + 2) groups");
  assert.equal(insights(events, "longRetryWait").length, 2);
  assert.match(state.message, /after 2 restarts/, "the message says how many restarts were made");
  assert.match(state.message, /still down/, "and what the error was");
  assert.match(state.lastError.message, /still down/, "the error is the one that ended the run");
  assert.equal(state.stats.failures, 1);
  const exhausted = insights(events, "longRetryExhausted");
  assert.equal(exhausted.length, 1);
  assert.deepEqual([exhausted[0].cycle, exhausted[0].cycles], [2, 2]);
  assert.equal(runEnded(events).at(-1).code, "longRetryExhausted");

  const once = conceptFails(Number.POSITIVE_INFINITY);
  const one = await run(once, { options: { longRetry: { everyMinutes: 1, cycles: 1 } } });
  assert.match(one.state.message, /after 1 restart\b/, "one restart, in the singular");
});

test("unlimited cycles go on until the step works, and the summary says it with cycles: null", async () => {
  const ai = conceptFails(20);
  const { state, events } = await run(ai, { options: { longRetry: { everyMinutes: 1, cycles: "unlimited" } } });
  assert.equal(state.status, "completed", state.lastError?.message);
  assert.equal(concepts(ai), 21);
  const waits = insights(events, "longRetryWait");
  assert.deepEqual(waits.map((event) => [event.cycle, event.cycles]), [[1, null], [2, null], [3, null], [4, null], [5, null]]);
  const waiting = events.filter((event) => event.type === "state" && event.state.retry?.longTerm).map((event) => event.state.retry.longTerm);
  assert.deepEqual(waiting, [1, 2, 3, 4, 5].map((cycle) => ({ cycle, cycles: null })), "a state event for every long wait");
  assert.equal(events.filter((event) => event.type === "state").at(-1).state.retry, undefined, "and none once it is over");
});

test("the attempts that end in a long wait do not count against the ceiling of a run that loops: unlimited is not cut short", async () => {
  // One chapter: a run is stopped as a runaway after 580 steps. 150 cycles of four attempts are 600.
  assert.equal(engine.runStepCeiling({ brief: { targetChapters: 1 }, plan: null }), 580);
  const ai = conceptFails(600);
  const { state, events } = await run(ai, { options: { longRetry: { everyMinutes: 1, cycles: "unlimited" } } });
  assert.equal(state.status, "completed", state.message);
  assert.equal(concepts(ai), 601);
  assert.equal(insights(events, "longRetryWait").length, 150);
});

test("a step that works puts the cycles back to zero, and every long cycle gives back the whole short level", async () => {
  // The concept fails two groups (two cycles), then works; the plan fails one group: its first wait is cycle 1 again.
  const ai = scripted((request, seen) => ((request.label === "autopilot:concept" && seen < 8) || (request.label === "autopilot:plan" && seen < 4) ? down() : undefined));
  const { state, events } = await run(ai, { options: { longRetry: { everyMinutes: 1, cycles: 2 } } });
  assert.equal(state.status, "completed", state.lastError?.message);
  assert.deepEqual(insights(events, "longRetryWait").map((event) => event.cycle), [1, 2, 1]);
  assert.deepEqual(insights(events, "failureRetry").map((event) => event.attempt), [1, 2, 3, 1, 2, 3, 1, 2, 3], "after a long wait the short retries start again from the first");
});

test("the same words twice in a row open a long cycle too, and after it the same words are no longer 'the same failure'", async () => {
  const ai = conceptFails(Number.POSITIVE_INFINITY, () => crashed());
  const { state, events } = await run(ai, { options: { longRetry: { everyMinutes: 1, cycles: 1 } } });
  assert.equal(state.status, "error");
  assert.equal(concepts(ai), 4, "two attempts, the long wait, two more: the wait made the last failure's words count for nothing");
  assert.equal(insights(events, "longRetryWait").length, 1);
  assert.equal(runEnded(events).at(-1).code, "longRetryExhausted");
});

test("a budget that is already used up is not waited for: the run pauses for the budget, as it always does", async () => {
  const costly = () => new AiProviderError("openai m: HTTP 503 — overloaded", 503, true, { transient: true, usage: { inputTokens: 300, outputTokens: 0, cachedInputTokens: 0 }, model: "m", provider: "openai" });
  const ai = conceptFails(Number.POSITIVE_INFINITY, costly);
  const { state, events } = await run(ai, { options: { budgetTokens: 1000, longRetry: { everyMinutes: 60, cycles: 3 } }, extra: { retryDelayMs: 4 } });
  assert.equal(state.status, "paused");
  assert.match(state.message, /Token budget reached/);
  assert.equal(insights(events, "longRetryWait").length, 0, "no wait for a run that cannot spend");
  assert.equal(concepts(ai), 4);
  assert.equal(state.stats.inputTokens, 1200, "every failed attempt is counted, as always");
});

// ─── Waiting ────────────────────────────────────────────────────────────────

/** A run whose concept fails like a crashed node, with the long level on, that is now in its first long wait (36 s at this scale). */
async function waitingLong(times = Number.POSITIVE_INFINITY, longRetry = { everyMinutes: 60, cycles: 3 }, files = seedBookFiles()) {
  const store = new MemoryBookStore(files);
  const ai = conceptFails(times, () => crashed());
  const { session, events } = newSession(store, ai, { retryDelayMs: 40 });
  await session.start({ brief: BRIEF, options: { ...FAST, longRetry } });
  await waitFor(() => insights(events, "longRetryWait").length === 1, "the first long wait");
  return { store, ai, session, events };
}

test("while the run waits for a long cycle the summary says when, which cycle and how many; the wait is no activity, and the run keeps the book", async () => {
  const { store, ai, session, events } = await waitingLong();
  const [wait] = insights(events, "longRetryWait");
  assert.deepEqual([wait.cycle, wait.cycles, wait.waitMs], [1, 3, 36_000], "60 minutes, scaled by 40 / 4000");
  const snapshot = await session.snapshot();
  assert.equal(snapshot.running, true);
  const { retry } = snapshot.summary;
  assert.deepEqual([retry.attempt, retry.retries, retry.longTerm], [1, 3, { cycle: 1, cycles: 3 }], "the short retries made, and the cycle");
  assert.ok(Date.parse(retry.at) - Date.now() > 30_000, "the next attempt is far away");
  assert.deepEqual(events.filter((event) => event.type === "state").at(-1).state.retry, retry, "a state event said it");
  const { activities } = await engine.readStoredAutopilot(store);
  assert.ok(activities.every((activity) => activity.status !== "running"), "no activity stands for the time that passes");
  assert.equal(parseAutopilotState(store.files.get(STATE)).runner?.runId !== undefined, true, "the run still owns the book");
  assert.equal(concepts(ai), 2);
  session.pause("now");
  await session.waitForIdle();
});

test("a pause ends the long wait at once: nothing more is called, and the summary waits for nothing", async () => {
  const { store, ai, session } = await waitingLong();
  const started = Date.now();
  assert.equal(session.pause("after-step"), true);
  await session.waitForIdle();
  assert.ok(Date.now() - started < 3_000, "not 36 seconds later");
  const state = parseAutopilotState(store.files.get(STATE));
  assert.equal(state.status, "paused");
  assert.equal(state.message, null);
  assert.equal(concepts(ai), 2, "no call after the pause");
  assert.equal((await session.snapshot()).summary.retry, undefined);
});

test("a host that takes the book over ends a long wait at the next heartbeat: the run stops, and writes nothing more", async () => {
  const store = new MemoryBookStore(seedBookFiles());
  const ai = conceptFails(Number.POSITIVE_INFINITY, () => crashed());
  const { session, events } = newSession(store, ai, { retryDelayMs: 40, persistHeartbeatMs: 20 });
  await session.start({ brief: BRIEF, options: { ...FAST, longRetry: { everyMinutes: 60, cycles: 3 } } });
  await waitFor(() => insights(events, "longRetryWait").length === 1, "the long wait");
  // The other host keeps the book until the waiting run has seen it: a run that is over within one heartbeat leaves a stored runner of null, and that is no takeover.
  let release = () => undefined;
  let reached = () => undefined;
  const gate = new Promise((resolve) => (release = resolve));
  const holding = new Promise((resolve) => (reached = resolve));
  const fake = createFakeAutopilotAi();
  const held = {
    calls: fake.calls,
    async complete(request) {
      reached();
      await gate;
      return fake.complete(request);
    },
  };
  const other = new AutopilotSession({ bookId: "book", store, ai: held, host: "browser", hostLabel: "another device", hostId: "device-2", retryDelayMs: 0 });
  // A heartbeat of the waiting run can land between the start's read and its commit: a host tries again.
  for (let attempt = 0; ; attempt += 1) {
    try {
      await other.start({ force: true });
      break;
    } catch (error) {
      if (!(error instanceof engine.BookConflictError) || attempt >= 5) throw error;
    }
  }
  await holding;
  const owned = store.files.get(STATE);
  const commits = store.commits.length;
  const started = Date.now();
  await session.waitForIdle();
  assert.ok(Date.now() - started < 3_000, "not 36 seconds later");
  assert.equal(runEnded(events).at(-1).code, "takenOver");
  assert.equal(concepts(ai), 2, "no attempt after the wait");
  assert.equal(store.files.get(STATE), owned, "the new owner's state was left alone");
  assert.equal(store.commits.length, commits, "and nothing was written");
  release();
  await other.waitForIdle();
  const state = parseAutopilotState(store.files.get(STATE));
  assert.equal(state.status, "completed", "the other host's run went on undisturbed");
  assert.equal(state.stats.failures, 0);
});

test("retryNow ends a short wait and the attempt starts at once; the counters stay, and a pause after it works as always", async () => {
  const store = new MemoryBookStore(seedBookFiles());
  const ai = conceptFails(2);
  const { session, events } = newSession(store, ai, { retryDelayMs: 60_000 });
  await session.start({ brief: BRIEF, options: FAST });
  await waitFor(() => insights(events, "failureRetry").length === 1, "the first short wait");
  assert.equal(session.retryNow(), true);
  const skipped = insights(events, "retrySkipped");
  assert.equal(skipped.length, 1);
  assert.ok(skipped[0].waitMs > 50_000 && skipped[0].waitMs <= 60_000, `the wait that was skipped: ${skipped[0].waitMs} ms`);
  const after = events.filter((event) => event.type === "state").at(-1);
  assert.equal(after.state.retry, undefined, "a state event at once, with nothing waiting");
  await waitFor(() => insights(events, "failureRetry").length === 2, "the second failure");
  assert.deepEqual(insights(events, "failureRetry").map((event) => event.attempt), [1, 2], "the skipped wait still counted its retry");
  const attempts = () => events.filter((event) => event.type === "task-started" && event.activity.task === "concept").length;
  assert.equal(session.retryNow(), true);
  await waitFor(() => attempts() === 3, "the third attempt to start");
  assert.equal(session.pause("after-step"), true, "a pause asked once the wait is over");
  await session.waitForIdle();
  const state = parseAutopilotState(store.files.get(STATE));
  assert.equal(state.status, "paused", "the attempt ran, the step was saved, and the run paused after it");
  assert.equal(state.concept.done, true);
  assert.equal(concepts(ai), 3);
});

test("retryNow ends a long wait: the new group starts, and the cycle stays counted", async () => {
  const { session, events } = await waitingLong(4);
  assert.equal(session.retryNow(), true);
  await waitFor(() => insights(events, "longRetryWait").length === 2, "the second long wait");
  assert.deepEqual(insights(events, "longRetryWait").map((event) => event.cycle), [1, 2], "the skipped wait was cycle 1, and stays it");
  assert.equal(session.retryNow(), true);
  await session.waitForIdle();
  assert.equal((await session.snapshot()).state.status, "completed");
  assert.equal(insights(events, "retrySkipped").length, 2);
});

test("retryNow with no wait does nothing and says false: no run, or a run that is not waiting", async () => {
  const store = new MemoryBookStore(seedBookFiles());
  let release = () => undefined;
  let reached = false;
  const held = new Promise((resolve) => {
    release = resolve;
  });
  const base = createFakeAutopilotAi();
  const ai = {
    calls: base.calls,
    async complete(request) {
      if (request.label === "autopilot:concept" && !reached) {
        reached = true;
        await held;
      }
      return base.complete(request);
    },
  };
  const { session, events } = newSession(store, ai);
  assert.equal(session.retryNow(), false, "nothing runs");
  await session.start({ brief: BRIEF, options: FAST });
  await waitFor(() => reached, "the first call");
  assert.equal(session.retryNow(), false, "the run is not waiting");
  release();
  await session.waitForIdle();
  assert.equal(session.retryNow(), false, "the run is over");
  assert.equal(insights(events, "retrySkipped").length, 0);
  assert.equal(typeof engine.AutopilotRun.prototype.retryNow, "function", "the run has the same command");
});

test("turning the long level off while the run waits ends the wait: the run stops with the error, and says that «Retry later» was turned off", async () => {
  const { store, ai, session, events } = await waitingLong();
  const started = Date.now();
  const saved = await session.updateOptions({ longRetry: null });
  assert.equal(saved.options.longRetry, undefined, "saved off");
  await session.waitForIdle();
  assert.ok(Date.now() - started < 3_000, "at once");
  const state = parseAutopilotState(store.files.get(STATE));
  assert.equal(state.status, "error");
  assert.match(state.lastError.message, /node crashed/, "the error that caused the wait");
  assert.match(state.message, /Retry later.*turned off/);
  assert.equal(runEnded(events).at(-1).code, "longRetryOff");
  assert.equal(concepts(ai), 2);
});

test("«Retry later» turned off on another device reaches a run that waits with its next heartbeat", async () => {
  const store = new MemoryBookStore(seedBookFiles());
  const ai = conceptFails(Number.POSITIVE_INFINITY, () => crashed());
  const { session, events } = newSession(store, ai, { retryDelayMs: 40, persistHeartbeatMs: 20 });
  await session.start({ brief: BRIEF, options: { ...FAST, longRetry: { everyMinutes: 60, cycles: 3 } } });
  await waitFor(() => insights(events, "longRetryWait").length === 1, "the long wait");
  // Another tab saves the options: it writes the file, and this session is not told.
  const other = new AutopilotSession({ bookId: "book", store, ai: createFakeAutopilotAi(), host: "browser", hostLabel: "another tab", hostId: "tab-2", retryDelayMs: 0 });
  await other.updateOptions({ longRetry: null });
  const started = Date.now();
  await session.waitForIdle();
  assert.ok(Date.now() - started < 3_000, "not 36 seconds later");
  const state = parseAutopilotState(store.files.get(STATE));
  assert.equal(state.status, "error");
  assert.equal(state.options.longRetry, undefined, "and the run did not bring it back");
  assert.equal(runEnded(events).at(-1).code, "longRetryOff");
  assert.equal(concepts(ai), 2);
});

test("changing the minutes or the cycles while the run waits changes the next cycle, not the wait in progress", async () => {
  const { session, events } = await waitingLong(4);
  const before = (await session.snapshot()).summary.retry;
  await session.updateOptions({ longRetry: { everyMinutes: 1, cycles: 3 } });
  const during = (await session.snapshot()).summary.retry;
  assert.equal(during.at, before.at, "the wait in progress is neither shorter nor longer");
  assert.deepEqual(during.longTerm, { cycle: 1, cycles: 3 });
  assert.equal(session.retryNow(), true);
  await session.waitForIdle();
  assert.equal((await session.snapshot()).state.status, "completed");
  const waits = insights(events, "longRetryWait");
  assert.deepEqual(waits.map((event) => [event.cycle, event.waitMs]), [[1, 36_000], [2, 600]], "the second cycle waits the new minutes (1 minute, scaled)");
});

test("an hours-long wait keeps the book: the heartbeat is saved, and another host does not take the run for dead", async () => {
  // A clock 5000 times faster than the real one: 1 ms is 5 s, and retryDelayMs scales the waits the same way (4000 / 5000). The long wait is 10
  // hours of that clock (7.2 s, ended early by «Retry now»), and the heartbeat is saved every 20 ms (100 s of it). A host takes a run for dead when
  // its heartbeat is older than 20 minutes (240 ms): the check is made 400 ms into the wait.
  const scenario = async (persistHeartbeatMs) => {
    const realStart = Date.now();
    const fakeStart = Date.parse("2026-01-01T00:00:00.000Z");
    const clock = () => new Date(fakeStart + (Date.now() - realStart) * 5000);
    const store = new MemoryBookStore(seedBookFiles());
    const ai = conceptFails(4);
    const { session, events } = newSession(store, ai, { retryDelayMs: 0.8, now: clock, persistHeartbeatMs });
    await session.start({ brief: BRIEF, options: { ...FAST, longRetry: { everyMinutes: 600, cycles: 1 } } });
    await waitFor(() => insights(events, "longRetryWait").length === 1, "the long wait");
    const waitStarted = Date.now();
    await sleep(400);
    const stored = parseAutopilotState(store.files.get(STATE));
    const activity = engine.runnerActivity(stored, clock());
    const other = new AutopilotSession({ bookId: "book", store, ai: createFakeAutopilotAi(), host: "browser", hostLabel: "another device", hostId: "device-2", retryDelayMs: 0, now: clock });
    const takeover = activity === "active" ? await other.start().then(() => "started", (error) => error.name) : null;
    const stillWaiting = Date.now() - waitStarted < 7_000;
    session.retryNow();
    await session.waitForIdle();
    return { activity, takeover, stillWaiting };
  };
  const kept = await scenario(20);
  assert.equal(kept.stillWaiting, true, "(the check was made during the wait)");
  assert.equal(kept.activity, "active", "the heartbeat was saved during the wait");
  assert.equal(kept.takeover, "AutopilotBusyError", "another host is refused");
  const silent = await scenario(0);
  assert.equal(silent.activity, "stale", "without the heartbeat the same wait would look like a dead run: the check measures it");
});

// ─── What the author reads ──────────────────────────────────────────────────

test("the long wait, the restarts and «Retry now» are said in the language of the book", async () => {
  // 1000 minutes scaled by 8 / 4000 is 2 minutes: the words say the real wait.
  const italian = await waitingLongWords(seedBookFiles({ language: "it" }), { everyMinutes: 1000, cycles: 3 });
  assert.equal(italian.wait.title, "Il passo è fallito dopo i tentativi ravvicinati: riprovo tra 2 minuti (ripartenza 1 di 3)");
  assert.match(italian.skipped.title, /^Attesa saltata: riprovo subito/);
  const english = await waitingLongWords(seedBookFiles(), { everyMinutes: 1000, cycles: "unlimited" });
  assert.equal(english.wait.title, "The step failed after the quick retries: retrying in 2 minutes (restart 1, no limit)");
  assert.match(english.skipped.title, /^Wait skipped: retrying now/);

  const ended = await run(conceptFails(Number.POSITIVE_INFINITY), { options: { longRetry: { everyMinutes: 1, cycles: 2 } }, files: seedBookFiles({ language: "it" }) });
  assert.match(ended.state.message, /^Il passo è fallito ancora dopo 2 ripartenze \(Riprova più tardi\): /);
  const singular = await run(conceptFails(Number.POSITIVE_INFINITY), { options: { longRetry: { everyMinutes: 1, cycles: 1 } }, files: seedBookFiles({ language: "it" }) });
  assert.match(singular.state.message, /dopo 1 ripartenza \(/);
});

async function waitingLongWords(files, longRetry) {
  const store = new MemoryBookStore(files);
  const ai = conceptFails(4);
  const { session, events } = newSession(store, ai, { retryDelayMs: 8 });
  await session.start({ brief: BRIEF, options: { ...FAST, longRetry } });
  await waitFor(() => insights(events, "longRetryWait").length === 1, "the long wait");
  session.retryNow();
  await session.waitForIdle();
  return { wait: insights(events, "longRetryWait")[0], skipped: insights(events, "retrySkipped")[0] };
}
