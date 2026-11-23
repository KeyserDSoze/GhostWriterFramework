import test from "node:test";
import assert from "node:assert/strict";
import * as engine from "../dist/index.js";

// The reference store: every write may come twice and in any order, and the book's totals follow what it keeps.

const BOOK = "book-1";

function recordOf(callId, activityId, seq, overrides = {}) {
  return {
    formatVersion: 1,
    callId,
    bookId: BOOK,
    accountScope: null,
    runId: "run_1",
    activityId,
    seq,
    stepAttempt: 1,
    task: "write",
    chapter: 1,
    scene: 1,
    label: "Write",
    capability: "autopilot",
    host: "browser",
    request: {
      system: { characters: 3, bytes: 3, storedBytes: 3, truncated: false },
      user: { characters: 3, bytes: 3, storedBytes: 3, truncated: false },
      images: 0,
      tool: null,
      toolSchemaHash: null,
      structured: false,
      maxOutputTokens: null,
      temperature: null,
    },
    status: "running",
    response: { text: null, partial: false },
    attempts: [],
    timing: { startedAt: "2026-11-20T10:00:00.000Z", firstTextAt: null, endedAt: null },
    storedBytes: 6,
    dropped: null,
    ...overrides,
  };
}

function finalOf(status = "ok") {
  return {
    status,
    response: { text: null, partial: false },
    attempts: [],
    timing: { startedAt: "2026-11-20T10:00:00.000Z", firstTextAt: "2026-11-20T10:00:01.000Z", endedAt: "2026-11-20T10:00:09.000Z" },
    storedBytes: 6,
    dropped: null,
  };
}

function header(activityId, startedAt, overrides = {}) {
  return { bookId: BOOK, activityId, title: activityId, kind: "write", chapter: 1, scene: null, status: "done", startedAt, endedAt: startedAt, ...overrides };
}

test("a call is written and read back: its record, its texts by attempt, and its end", async () => {
  const store = new engine.MemoryAiCallStore();
  await store.saveTask(header("activity_1", "2026-11-20T10:00:00.000Z"));
  await store.begin({ record: recordOf("activity_1-0001", "activity_1", 1), system: "sys", user: "usr" });
  await store.append("activity_1-0001", 1, 0, "Hel");
  await store.append("activity_1-0001", 1, 3, "lo");
  await store.append("activity_1-0001", 2, 0, "Retry");
  await store.end("activity_1-0001", finalOf());
  const task = await store.readTask(BOOK, "activity_1");
  assert.equal(task.header.calls, 1);
  assert.equal(task.header.bytes, 3 + 3 + 5 + 5);
  assert.equal(task.calls[0].status, "ok");
  assert.equal((await store.readText(BOOK, "activity_1-0001", "response", 0, 1)).text, "Hello");
  assert.equal((await store.readText(BOOK, "activity_1-0001", "response", 0)).text, "Retry", "the last attempt with text is the default");
  assert.equal((await store.readText(BOOK, "activity_1-0001", "system", 0)).text, "sys");
  assert.equal((await store.readText(BOOK, "activity_1-0001", "user", 0)).text, "usr");
  assert.equal((await store.readText(BOOK, "activity_1-0001", "response", 0)).complete, true);
  assert.equal(await store.readText("other-book", "activity_1-0001", "system", 0), null, "a call belongs to its book");
});

test("writes out of order and twice leave the same state as in order", async () => {
  const inOrder = new engine.MemoryAiCallStore();
  const shuffled = new engine.MemoryAiCallStore();
  const parts = [[0, "héllo "], [7, "wörld"], [13, "!!"]];
  const callId = "activity_2-0001";
  await inOrder.begin({ record: recordOf(callId, "activity_2", 1), system: "s", user: "u" });
  for (const [offset, text] of parts) await inOrder.append(callId, 1, offset, text);
  await inOrder.end(callId, finalOf());

  await shuffled.append(callId, 1, 13, "!!");
  await shuffled.end(callId, finalOf());
  await shuffled.append(callId, 1, 7, "wörld");
  await shuffled.begin({ record: recordOf(callId, "activity_2", 1), system: "s", user: "u" });
  await shuffled.append(callId, 1, 0, "héllo ");
  await shuffled.append(callId, 1, 0, "héllo ");
  await shuffled.append(callId, 1, 7, "wörld");
  await shuffled.begin({ record: recordOf(callId, "activity_2", 1), system: "other", user: "other" });
  await shuffled.end(callId, finalOf());
  await shuffled.end(callId, finalOf());

  const expected = "héllo wörld!!";
  assert.equal((await inOrder.readText(BOOK, callId, "response", 0, 1)).text, expected);
  assert.equal((await shuffled.readText(BOOK, callId, "response", 0, 1)).text, expected);
  assert.equal((await shuffled.readText(BOOK, callId, "system", 0)).text, "s", "the first begin is kept");
  assert.deepEqual(await shuffled.totals(BOOK), await inOrder.totals(BOOK));
});

test("a read from the middle of a character rounds down to its start", async () => {
  const store = new engine.MemoryAiCallStore();
  const callId = "activity_3-0001";
  await store.begin({ record: recordOf(callId, "activity_3", 1), system: "", user: "" });
  await store.append(callId, 1, 0, "é€");
  const chunk = await store.readText(BOOK, callId, "response", 1, 1);
  assert.equal(chunk.from, 0);
  assert.equal(chunk.text, "é€");
  assert.equal((await store.readText(BOOK, callId, "response", 2, 1)).text, "€");
  assert.equal((await store.readText(BOOK, callId, "response", 99, 1)).text, "", "past the end is empty");
});

test("the task list is newest first, pages with a cursor, and lists a task with calls but no header", async () => {
  const store = new engine.MemoryAiCallStore();
  for (let index = 0; index < 5; index += 1) {
    const activityId = `activity_p${index}`;
    await store.saveTask(header(activityId, `2026-11-20T10:0${index}:00.000Z`));
  }
  await store.begin({ record: recordOf("activity_orphan-0001", "activity_orphan", 1, { timing: { startedAt: "2026-11-20T10:09:00.000Z", firstTextAt: null, endedAt: null } }), system: "", user: "" });
  const first = await store.listTasks(BOOK, { limit: 2 });
  assert.deepEqual(first.tasks.map((task) => task.activityId), ["activity_orphan", "activity_p4"]);
  assert.equal(first.tasks[0].status, "running", "a task with no header is running");
  const second = await store.listTasks(BOOK, { before: first.next, limit: 2 });
  assert.deepEqual(second.tasks.map((task) => task.activityId), ["activity_p3", "activity_p2"]);
  const third = await store.listTasks(BOOK, { before: second.next, limit: 2 });
  assert.deepEqual(third.tasks.map((task) => task.activityId), ["activity_p1", "activity_p0"]);
  assert.equal(third.next, null);
  assert.deepEqual(await store.listTasks("nobody", { limit: 5 }), { tasks: [], next: null });
});

test("the totals follow what the book keeps, and the pins count", async () => {
  const store = new engine.MemoryAiCallStore();
  await store.saveTask(header("activity_t1", "2026-11-20T10:00:00.000Z"));
  await store.begin({ record: recordOf("activity_t1-0001", "activity_t1", 1), system: "abcd", user: "ef" });
  await store.append("activity_t1-0001", 1, 0, "0123456789");
  await store.saveTask(header("activity_t2", "2026-11-20T11:00:00.000Z"));
  await store.begin({ record: recordOf("activity_t2-0001", "activity_t2", 1), system: "", user: "" });
  assert.deepEqual(await store.totals(BOOK), { bytes: 16, tasks: 2, calls: 2, pinnedTasks: 0, pinnedBytes: 0 });
  await store.keep(BOOK, "activity_t1", true);
  const totals = await store.totals(BOOK);
  assert.equal(totals.pinnedTasks, 1);
  assert.equal(totals.pinnedBytes, 16);
  assert.equal((await store.readTask(BOOK, "activity_t1")).header.pinned, true);
});

test("prune drops whole old tasks, keeps the pinned and the running ones, and reports what it did", async () => {
  const store = new engine.MemoryAiCallStore();
  const days = ["01", "02", "03", "04"];
  for (const [index, day] of days.entries()) {
    const activityId = `activity_d${index}`;
    await store.saveTask(header(activityId, `2026-11-${day}T10:00:00.000Z`, { status: index === 3 ? "running" : "done" }));
    await store.begin({ record: recordOf(`${activityId}-0001`, activityId, 1, { timing: { startedAt: `2026-11-${day}T10:00:00.000Z`, firstTextAt: null, endedAt: null } }), system: "x".repeat(100), user: "y".repeat(100) });
  }
  await store.keep(BOOK, "activity_d0", true);
  const before = await store.totals(BOOK);
  assert.equal(before.bytes, 800);
  const result = await store.prune(BOOK, 300);
  assert.deepEqual(result.dropped, ["activity_d1", "activity_d2"], "the oldest unpinned, not running, first, whole");
  assert.equal(result.bytes, 400);
  assert.equal(result.overBudget, true, "the pinned and the running task keep 400, over the 300 budget");
  assert.equal(result.pinnedTasks, 1);
  assert.equal(result.pinnedBytes, 200);
  assert.equal(await store.readTask(BOOK, "activity_d1"), null);
  assert.ok(await store.readTask(BOOK, "activity_d0"));
  assert.ok(await store.readTask(BOOK, "activity_d3"));
});

test("deleting a book removes its calls and tasks and nothing of another book", async () => {
  const store = new engine.MemoryAiCallStore();
  await store.begin({ record: recordOf("activity_b-0001", "activity_b", 1), system: "x", user: "" });
  await store.begin({ record: recordOf("activity_o-0001", "activity_o", 1, { bookId: "other" }), system: "x", user: "" });
  await store.deleteBook(BOOK);
  assert.equal(await store.readTask(BOOK, "activity_b"), null);
  assert.equal((await store.totals(BOOK)).calls, 0);
  assert.equal((await store.readText("other", "activity_o-0001", "system", 0)).text, "x");
});

test("a book keeps at most 64 calls per task: a later call of the task is not kept", async () => {
  const store = new engine.MemoryAiCallStore();
  for (let seq = 1; seq <= engine.AI_CALL_LIMITS.maxCallsPerTask + 1; seq += 1) {
    await store.begin({ record: recordOf(engine.aiCallIdOf("activity_many", seq), "activity_many", seq), system: "s", user: "" });
  }
  const task = await store.readTask(BOOK, "activity_many");
  assert.equal(task.calls.length, 64);
  assert.equal(await store.readText(BOOK, engine.aiCallIdOf("activity_many", 65), "system", 0), null);
});

test("a text that is not a whole number of bytes, or an attempt below 1, is refused", async () => {
  const store = new engine.MemoryAiCallStore();
  await store.begin({ record: recordOf("activity_r-0001", "activity_r", 1), system: "", user: "" });
  await assert.rejects(store.append("activity_r-0001", 0, 0, "x"), RangeError);
  await assert.rejects(store.append("activity_r-0001", 1, -1, "x"), RangeError);
  await assert.rejects(store.append("activity_r-0001", 1, 1.5, "x"), RangeError);
});
