import test from "node:test";
import assert from "node:assert/strict";
import * as engine from "../dist/index.js";
import { runBook, scriptedAi } from "./estimate-fakes.mjs";

// New exports are read from the namespace so that, before they exist, each test fails on its own.
const { TWO_CALL_TASKS, estimateAutopilotRun, estimateModelsFromConfig, measuredSpeed, pickAiRuntimeConfig } = engine;

const T0 = Date.parse("2026-03-01T10:00:00.000Z");
const at = (seconds) => new Date(T0 + seconds * 1000).toISOString();
let counter = 0;

/** A step of the autopilot that wrote `tokens` tokens in `seconds` seconds, as the log of activities keeps it. */
function activity({ model = "model-a", tokens = 200, seconds = 10, start = 0, task = "scenes", status = "succeeded", ...extra } = {}) {
  counter += 1;
  return { id: `activity-${counter}`, runId: "run-1", task, phase: "write", title: "A step", reason: "Because", next: "Then", status, startedAt: at(start), endedAt: at(start + seconds), model, provider: "test", usage: { inputTokens: 1000, outputTokens: tokens, cachedInputTokens: 0 }, ...extra };
}

const speedOf = (activities, options, model = "model-a") => measuredSpeed(activities, options).get(model);

test("a step that wrote two hundred tokens in ten seconds is twenty tokens a second, for the model that wrote them", () => {
  const speeds = measuredSpeed([activity()]);
  assert.ok(speeds instanceof Map);
  assert.deepEqual(speeds.get("model-a"), { tokensPerSecond: 20, samples: 1 });
  assert.equal(speeds.size, 1);
  assert.deepEqual(speedOf([activity({ tokens: 90, seconds: 3 })]), { tokensPerSecond: 30, samples: 1 }, "the seconds are the time between the start and the end");
  assert.deepEqual(speedOf([activity({ tokens: 25, seconds: 2 })]), { tokensPerSecond: 12.5, samples: 1 }, "and the speed is not rounded");
});

test("the speed of a model is the median of its steps, which a step that was slow once, or fast once, does not move", () => {
  const steps = (speeds) => speeds.map((tokensPerSecond, index) => activity({ tokens: tokensPerSecond * 10, start: index * 100 }));
  assert.equal(speedOf(steps([10, 20, 40])).tokensPerSecond, 20, "the one in the middle");
  assert.equal(speedOf(steps([10, 20, 30, 40])).tokensPerSecond, 25, "between the two in the middle");
  assert.equal(speedOf(steps([20, 20, 20, 20, 2000])).tokensPerSecond, 20, "a step that was fast once");
  assert.equal(speedOf(steps([20, 20, 20, 20, 0.2])).tokensPerSecond, 20, "or slow");
  assert.equal(speedOf(steps([7])).samples, 1);
  assert.equal(speedOf(steps([7, 8, 9, 10, 11])).samples, 5);
});

test("only the latest steps count, the latest by the time they ended and not by their place in the list; twenty unless the host says otherwise", () => {
  const old = Array.from({ length: 6 }, (_, index) => activity({ tokens: 10, start: index * 100 }));
  const recent = Array.from({ length: 20 }, (_, index) => activity({ tokens: 500, start: 1000 + index * 100 }));
  assert.deepEqual(speedOf([...old, ...recent]), { tokensPerSecond: 50, samples: 20 }, "the first six are of a model that was slower, long ago");
  assert.deepEqual(speedOf([...recent, ...old].reverse()), { tokensPerSecond: 50, samples: 20 }, "in whatever order the list is");
  const all = [...old, ...recent];
  const shuffled = all.map((_, index) => all[(index * 7) % all.length]);
  assert.notDeepEqual(shuffled.map((entry) => entry.id), all.map((entry) => entry.id));
  assert.deepEqual(speedOf(shuffled), { tokensPerSecond: 50, samples: 20 });
  assert.deepEqual(speedOf([...old, ...recent], { last: 3 }), { tokensPerSecond: 50, samples: 3 });
  assert.deepEqual(speedOf([...old, ...recent], { last: 100 }), { tokensPerSecond: 50, samples: 26 }, "the median of all twenty-six: twenty of them are fast");
  for (const last of [0, -4, Number.NaN, undefined, "3", null]) assert.equal(speedOf([...old, ...recent], { last }).samples, 20, `a limit of ${String(last)} is no limit: twenty`);
  assert.equal(speedOf([...old, ...recent], { last: 2.9 }).samples, 2, "a whole number of steps");
});

test("a step with no data is not a sample: not finished, without a model, without tokens written, without a time, or too short to tell", () => {
  const good = activity({ tokens: 200, seconds: 10 });
  const bad = {
    failed: activity({ status: "failed" }),
    cancelled: activity({ status: "cancelled" }),
    running: activity({ status: "running", endedAt: undefined }),
    "no status": { ...activity(), status: undefined },
    "no model": { ...activity(), model: undefined },
    "empty model": activity({ model: "" }),
    "blank model": activity({ model: "   " }),
    "numeric model": activity({ model: 5 }),
    "no usage": activity({ usage: undefined }),
    "empty usage": activity({ usage: {} }),
    "null usage": activity({ usage: null }),
    "no output": activity({ tokens: 0 }),
    "negative output": activity({ tokens: -50 }),
    "output that is no number": activity({ tokens: Number.NaN }),
    "output of infinity": activity({ tokens: Number.POSITIVE_INFINITY }),
    "output as text": activity({ tokens: "200" }),
    "no end": activity({ endedAt: undefined }),
    "no start": activity({ startedAt: undefined }),
    "end that is no date": activity({ endedAt: "later" }),
    "start that is no date": activity({ startedAt: "yesterday" }),
    "end that is a number": activity({ endedAt: 1_800_000_000_000 }),
    "end before the start": activity({ seconds: -5 }),
    "no time at all": activity({ seconds: 0 }),
    "under a second": activity({ seconds: 0.4 }),
  };
  for (const [name, entry] of Object.entries(bad)) {
    assert.equal(measuredSpeed([entry]).size, 0, `${name}: no speed from it alone`);
    assert.deepEqual(speedOf([good, entry]), { tokensPerSecond: 20, samples: 1 }, `${name}: and it does not count among the others`);
  }
  assert.deepEqual(speedOf([activity({ seconds: 1 })]), { tokensPerSecond: 200, samples: 1 }, "a second is enough");
});

test("how short a step can be to tell something is the host's to say, and it can never be nothing: the speed is a division", () => {
  const quick = activity({ tokens: 40, seconds: 0.5 });
  assert.equal(measuredSpeed([quick]).size, 0, "half a second: not by default");
  assert.deepEqual(speedOf([quick], { minSeconds: 0.25 }), { tokensPerSecond: 80, samples: 1 });
  assert.equal(speedOf([activity({ tokens: 40, seconds: 2 })], { minSeconds: 5 }), undefined);
  const instant = activity({ seconds: 0 });
  assert.equal(measuredSpeed([instant], { minSeconds: 0 }).size, 0, "a step that took no time has no speed, not an infinite one");
  assert.equal(measuredSpeed([instant], { minSeconds: -3 }).size, 0);
  assert.ok(Math.abs(measuredSpeed([activity({ seconds: 0.001 })], { minSeconds: 0 }).get("model-a").tokensPerSecond - 200_000) < 1e-6, "a millisecond is a time");
  assert.equal(speedOf([quick], { minSeconds: Number.NaN }), undefined, "a value that is no number is the default");
});

test("no data is no speed, never a made-up one: the model is not in the answer", () => {
  assert.equal(measuredSpeed([]).size, 0);
  assert.equal(measuredSpeed([]).get("model-a"), undefined);
  assert.equal(measuredSpeed([activity({ status: "failed" })]).get("model-a"), undefined);
  for (const garbage of [undefined, null, 0, 5, "steps", {}, true, () => []]) {
    const speeds = measuredSpeed(garbage);
    assert.ok(speeds instanceof Map && speeds.size === 0, `${String(garbage)}`);
  }
  assert.equal(speedOf([activity({ model: "model-b" })]), undefined, "a model that was never measured");
});

test("each model has its own speed, and a step is the model's that ended it", () => {
  const speeds = measuredSpeed([activity({ model: "model-a", tokens: 200 }), activity({ model: "model-b", tokens: 600, start: 50 }), activity({ model: "model-a", tokens: 400, start: 100 }), activity({ model: "model-c", tokens: 10, status: "failed" })]);
  assert.deepEqual([...speeds.keys()].sort(), ["model-a", "model-b"]);
  assert.deepEqual(speeds.get("model-a"), { tokensPerSecond: 30, samples: 2 });
  assert.deepEqual(speeds.get("model-b"), { tokensPerSecond: 60, samples: 1 });
});

test("a step that makes two calls is skipped when the host says so, because the model it records is the second call's", () => {
  assert.deepEqual([...TWO_CALL_TASKS], ["write", "repair", "revise"]);
  const steps = [activity({ task: "write", tokens: 1000 }), activity({ task: "repair", tokens: 1000, start: 20 }), activity({ task: "revise", tokens: 1000, start: 40 }), activity({ task: "scenes", tokens: 200, start: 60 }), activity({ task: "director-review", tokens: 400, start: 80 })];
  assert.deepEqual(speedOf(steps), { tokensPerSecond: 100, samples: 5 }, "by default every step counts");
  assert.deepEqual(speedOf(steps, { ignoreTasks: TWO_CALL_TASKS }), { tokensPerSecond: 30, samples: 2 });
  assert.deepEqual(speedOf(steps, { ignoreTasks: ["scenes"] }), { tokensPerSecond: 100, samples: 4 });
  assert.deepEqual(speedOf(steps, { ignoreTasks: [] }), { tokensPerSecond: 100, samples: 5 });
  assert.deepEqual(speedOf(steps, { ignoreTasks: undefined }), { tokensPerSecond: 100, samples: 5 });
  assert.equal(speedOf(steps, { ignoreTasks: [...TWO_CALL_TASKS, "scenes", "director-review"] }), undefined, "every step ignored: no speed");
  assert.ok(Object.isFrozen(TWO_CALL_TASKS), "a list that a host cannot change by mistake");
});

test("a log with things in it that are not steps is read for the steps that are", () => {
  const junk = [null, undefined, 5, "step", true, [], [activity()], {}, { model: "model-a", status: "succeeded" }, { ...activity(), usage: "200" }, Object.create(null)];
  assert.equal(measuredSpeed(junk).size, 0);
  assert.deepEqual(speedOf([...junk, activity({ tokens: 300 })]), { tokensPerSecond: 30, samples: 1 });
  const holes = [activity()];
  holes[3] = activity({ tokens: 400, start: 30 });
  assert.equal(speedOf(holes).samples, 2, "a list with holes in it");
});

test("a model can be called anything: its name is a key of the answer and nothing else", () => {
  for (const model of ["__proto__", "constructor", "toString", "hasOwnProperty", "prototype", "gpt-4o (2026-01)", "модель", "a b"]) {
    const speeds = measuredSpeed([activity({ model })]);
    assert.deepEqual(speeds.get(model), { tokensPerSecond: 20, samples: 1 }, model);
    assert.equal(speeds.size, 1);
  }
  assert.equal(({}).tokensPerSecond, undefined);
  assert.equal(Object.prototype.samples, undefined, "nothing was written to the prototype");
});

function deepFreeze(value) {
  if (value && typeof value === "object" && !Object.isFrozen(value)) {
    Object.freeze(value);
    for (const inner of Object.values(value)) deepFreeze(inner);
  }
  return value;
}

test("the speed is a function of the log: no clock, no change to the log, a new answer every time", () => {
  const log = deepFreeze([activity({ tokens: 100 }), activity({ tokens: 300, start: 50 }), activity({ model: "model-b", tokens: 50, start: 90 })]);
  const options = deepFreeze({ last: 5, minSeconds: 1, ignoreTasks: ["write"] });
  const RealDate = Date;
  const now = performance.now;
  let speeds;
  try {
    globalThis.Date = class extends RealDate {
      constructor(...args) {
        if (args.length === 0) throw new Error("the speed read the clock");
        super(...args);
      }

      static now() {
        throw new Error("the speed read the clock");
      }
    };
    performance.now = () => { throw new Error("the speed read the clock"); };
    speeds = measuredSpeed(log, options);
  } finally {
    globalThis.Date = RealDate;
    performance.now = now;
  }
  assert.deepEqual(speeds.get("model-a"), { tokensPerSecond: 20, samples: 2 });
  assert.deepEqual(measuredSpeed(log, options), speeds);
  speeds.set("model-a", { tokensPerSecond: 1, samples: 1 });
  assert.deepEqual(measuredSpeed(log, options).get("model-a"), { tokensPerSecond: 20, samples: 2 }, "the answer is the caller's");
});

test("the log of a real run is read as the engine writes it: a step is as fast as its tokens over its seconds", async () => {
  const ai = scriptedAi({ scenes: 2, words: 300 });
  const { activities } = await runBook({ brief: { targetChapters: 2, scenesPerChapter: 2, wordsPerScene: 300 }, options: { readers: true, maxReaders: 2, readersOnPlan: false, specialists: true }, ai });
  assert.ok(activities.length > 10);
  assert.equal(measuredSpeed(activities).size, 0, "the fake AI answers at once, which is no measure of a speed");
  const timed = activities.map((entry, index) => ({ ...entry, startedAt: at(index * 30), endedAt: at(index * 30 + 10) }));
  const usable = timed.filter((entry) => entry.status === "succeeded" && entry.model && entry.usage && entry.usage.outputTokens > 0);
  assert.ok(usable.length >= 10, `${usable.length} of ${timed.length} steps wrote something`);
  const speeds = usable.slice(-20).map((entry) => entry.usage.outputTokens / 10).sort((left, right) => left - right);
  const middle = speeds.length >> 1;
  const median = speeds.length % 2 ? speeds[middle] : (speeds[middle - 1] + speeds[middle]) / 2;
  assert.deepEqual(measuredSpeed(timed).get("fake-model"), { tokensPerSecond: median, samples: Math.min(20, usable.length) });
  assert.deepEqual(measuredSpeed(timed, { last: usable.length }).get("fake-model").samples, usable.length);
});

test("what the host does with it: the models of the configuration with the speeds measured, then the estimate says how long the book takes", () => {
  const config = pickAiRuntimeConfig({
    aiIntegrations: [{ id: "a", name: "Alpha", provider: "openai", endpoint: "http://a.test/v1", apiKey: "sk-secret-0123456789", chatModels: [{ id: "w", name: "writer-model", capabilities: ["default"], maxInputTokens: 64_000, pricing: { inputPerMTok: 1, outputPerMTok: 4 } }] }],
  });
  const none = estimateAutopilotRun({ brief: { targetChapters: 3, scenesPerChapter: 1, wordsPerScene: 500 }, models: estimateModelsFromConfig(config) });
  assert.equal(none.minutes, null, "nothing was measured: no time is made up");
  assert.ok(none.warnings.some((warning) => warning.code === "noSpeed"));
  const speeds = measuredSpeed([activity({ model: "writer-model", tokens: 300, seconds: 10 }), activity({ model: "writer-model", tokens: 300, seconds: 10, start: 20 })], { ignoreTasks: TWO_CALL_TASKS });
  const timed = estimateAutopilotRun({ brief: { targetChapters: 3, scenesPerChapter: 1, wordsPerScene: 500 }, models: estimateModelsFromConfig(config, speeds) });
  assert.ok(timed.minutes.min > 0 && timed.minutes.max >= timed.minutes.min);
  assert.ok(Math.abs(timed.minutes.max - timed.outputTokens.max / 30 / 60) < 1e-9, "the output tokens at thirty a second");
  assert.deepEqual(timed.warnings.filter((warning) => warning.code === "noSpeed"), []);
});
