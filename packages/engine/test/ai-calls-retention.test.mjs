import test from "node:test";
import assert from "node:assert/strict";
import * as engine from "../dist/index.js";

// The retention policy is a pure function of task headers: oldest unpinned tasks that are not running go first, whole, until the book keeps at
// most its budget. Pinned tasks count but are never dropped; the running task is never dropped.

/** A small deterministic random generator, so that a failing case can be run again. */
function random(seed) {
  let state = seed >>> 0;
  return () => {
    state = (state * 1664525 + 1013904223) >>> 0;
    return state / 0x100000000;
  };
}

function tasksOf(count, next, { pinnedRate = 0.1, runningRate = 0.02 } = {}) {
  const tasks = [];
  for (let index = 0; index < count; index += 1) {
    const day = String(1 + Math.floor(index / 10) % 28).padStart(2, "0");
    tasks.push({
      activityId: `activity_${String(index).padStart(6, "0")}`,
      bytes: Math.floor(next() * 5_000_000),
      pinned: next() < pinnedRate,
      running: next() < runningRate,
      startedAt: `2026-11-${day}T10:${String(index % 60).padStart(2, "0")}:00.000Z`,
    });
  }
  return tasks;
}

/** The reference: the same policy written the slow way, for a comparison. */
function referencePlan(tasks, budget) {
  const sorted = [...tasks].sort((left, right) => (left.startedAt === right.startedAt ? (left.activityId < right.activityId ? -1 : 1) : left.startedAt < right.startedAt ? -1 : 1));
  let bytes = tasks.reduce((sum, task) => sum + task.bytes, 0);
  const drop = [];
  for (const task of sorted) {
    if (bytes <= budget) break;
    if (task.pinned || task.running) continue;
    drop.push(task.activityId);
    bytes -= task.bytes;
  }
  return { drop, bytes };
}

test("the plan drops the oldest unpinned tasks that are not running, whole, until the budget holds", () => {
  const tasks = [
    { activityId: "a", bytes: 100, pinned: false, running: false, startedAt: "2026-11-01T00:00:00.000Z" },
    { activityId: "b", bytes: 100, pinned: true, running: false, startedAt: "2026-11-02T00:00:00.000Z" },
    { activityId: "c", bytes: 100, pinned: false, running: true, startedAt: "2026-11-03T00:00:00.000Z" },
    { activityId: "d", bytes: 100, pinned: false, running: false, startedAt: "2026-11-04T00:00:00.000Z" },
  ];
  const plan = engine.planRetention(tasks, 250);
  assert.deepEqual(plan.drop, ["a", "d"], "the oldest go first until the budget holds");
  assert.equal(plan.bytes, 200);
  assert.equal(plan.pinnedTasks, 1);
  assert.equal(plan.pinnedBytes, 100);
  assert.equal(plan.overBudget, false);
  assert.deepEqual(engine.planRetention(tasks, 10_000).drop, []);
});

test("pinned and running tasks are never dropped, and the plan says when they alone are over the budget", () => {
  const tasks = [
    { activityId: "pinned", bytes: 500, pinned: true, running: false, startedAt: "2026-11-01T00:00:00.000Z" },
    { activityId: "running", bytes: 500, pinned: false, running: true, startedAt: "2026-11-01T00:00:01.000Z" },
    { activityId: "old", bytes: 500, pinned: false, running: false, startedAt: "2026-11-01T00:00:02.000Z" },
  ];
  const plan = engine.planRetention(tasks, 400);
  assert.deepEqual(plan.drop, ["old"]);
  assert.equal(plan.overBudget, true, "the pinned and the running task keep 1000 bytes, over the 400 allowed");
  assert.equal(plan.pinnedBytes, 500);
});

test("the plan matches the slow reference on many random books, and keeps the minimum", () => {
  for (let seed = 1; seed <= 200; seed += 1) {
    const next = random(seed);
    const tasks = tasksOf(1 + Math.floor(next() * 80), next);
    const total = tasks.reduce((sum, task) => sum + task.bytes, 0);
    const budget = Math.floor(next() * total * 1.1);
    const before = JSON.stringify(tasks);
    const plan = engine.planRetention(tasks, budget);
    const expected = referencePlan(tasks, budget);
    assert.deepEqual(plan.drop, expected.drop, `seed ${seed}`);
    assert.equal(plan.bytes, expected.bytes, `seed ${seed}`);
    assert.equal(JSON.stringify(tasks), before, "the input is not changed");
    const dropped = new Set(plan.drop);
    for (const task of tasks) if (task.pinned || task.running) assert.equal(dropped.has(task.activityId), false, `seed ${seed}: ${task.activityId} is kept`);
    if (plan.drop.length > 0) {
      const lastDropped = tasks.find((task) => task.activityId === plan.drop[plan.drop.length - 1]);
      assert.ok(plan.bytes + lastDropped.bytes > budget, `seed ${seed}: the plan drops only what it must`);
    }
    assert.equal(plan.overBudget, plan.bytes > budget);
  }
});

test("a book of 1,200 chapters, with its tasks and their pins, is planned in well under a second", () => {
  const next = random(42);
  const tasks = tasksOf(1200 * 30, next, { pinnedRate: 0.02, runningRate: 0.001 });
  const total = tasks.reduce((sum, task) => sum + task.bytes, 0);
  const started = performance.now();
  const plan = engine.planRetention(tasks, total / 3);
  const elapsed = performance.now() - started;
  assert.ok(elapsed < 1000, `planned ${tasks.length} tasks in ${elapsed} ms`);
  assert.ok(plan.drop.length > 0);
  assert.ok(plan.bytes <= total / 3 || plan.overBudget);
  const reference = referencePlan(tasks, total / 3);
  assert.deepEqual(plan.drop, reference.drop);
});

test("the ids of a call and of a task are safe to name a file, and the limits are the documented ones", () => {
  assert.equal(engine.isSafeAiCallId("activity_1-0001"), true);
  assert.equal(engine.isSafeAiCallId("../etc"), false);
  assert.equal(engine.isSafeAiCallId(""), false);
  assert.equal(engine.AI_CALL_LIMITS.maxSystemBytes, 1024 * 1024);
  assert.equal(engine.AI_CALL_LIMITS.maxUserBytes, 1024 * 1024);
  assert.equal(engine.AI_CALL_LIMITS.maxResponseBytes, 2 * 1024 * 1024);
  assert.equal(engine.AI_CALL_LIMITS.responseTailBytes, 256 * 1024);
  assert.equal(engine.AI_CALL_LIMITS.maxCallBytes, 4 * 1024 * 1024);
  assert.equal(engine.AI_CALL_LIMITS.maxCallsPerTask, 64);
  assert.equal(engine.AI_CALL_BUDGETS.browserPerBookBytes, 256 * 1024 * 1024);
  assert.equal(engine.AI_CALL_BUDGETS.browserPerDeviceBytes, 1024 * 1024 * 1024);
  assert.equal(engine.AI_CALL_BUDGETS.serverPerBookBytes, 2048 * 1024 * 1024);
  assert.equal(engine.AI_CALL_BUDGETS.minFreeDiskBytes, 1024 * 1024 * 1024);
  assert.equal(engine.AI_CALLS_FORMAT_VERSION, 1);
});

test("the UTF-8 helpers agree with the encoder, lone surrogates included", () => {
  const next = random(7);
  const alphabet = ["a", "é", "€", "😀", "\uD800", "\uDC00", "中"];
  for (let round = 0; round < 300; round += 1) {
    let text = "";
    for (let index = 0; index < 40; index += 1) text += alphabet[Math.floor(next() * alphabet.length)];
    assert.equal(engine.utf8Length(text), Buffer.byteLength(text, "utf8"), JSON.stringify(text));
    const cut = engine.cutHead(text, 0, 17);
    assert.ok(engine.utf8Length(text, 0, cut) <= 17);
    const isHigh = (index) => text.charCodeAt(index) >= 0xd800 && text.charCodeAt(index) <= 0xdbff;
    const isLow = (index) => text.charCodeAt(index) >= 0xdc00 && text.charCodeAt(index) <= 0xdfff;
    if (cut > 0 && cut < text.length) assert.equal(isHigh(cut - 1) && isLow(cut), false, "a pair is not split");
    const start = engine.suffixStart(text, 17);
    assert.ok(engine.utf8Length(text, start) <= 17);
  }
});
