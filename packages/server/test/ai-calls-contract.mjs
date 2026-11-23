import test from "node:test";
import assert from "node:assert/strict";
import * as engine from "narrarium-engine";

// The behaviours of an `AiCallStore` that every host shares: the engine's reference (`MemoryAiCallStore`) and the server's files (`FileAiCallStore`) are run through the same tests, so that
// what the pages and the recorder rely on is the same on both. Each test gets a store of its own from `make`, which gives `{ store, cleanup, maxCallsPerTask }`.

export const BOOK = "book-1";

export function recordOf(callId, activityId, seq, overrides = {}) {
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
    host: "server",
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

export function finalOf(status = "ok", overrides = {}) {
  return {
    status,
    response: { text: null, partial: false },
    attempts: [],
    timing: { startedAt: "2026-11-20T10:00:00.000Z", firstTextAt: "2026-11-20T10:00:01.000Z", endedAt: "2026-11-20T10:00:09.000Z" },
    storedBytes: 6,
    dropped: null,
    ...overrides,
  };
}

export function headerOf(activityId, startedAt, overrides = {}) {
  return { bookId: BOOK, activityId, title: activityId, kind: "write", chapter: 1, scene: null, status: "done", startedAt, endedAt: startedAt, ...overrides };
}

/** The same call written to the two stores, in the order the recorder writes it: its task, its start, its text in pieces, its end. */
export async function writeCall(store, activityId, seq, { system = "sys", user = "usr", pieces = [], status = "ok", startedAt = "2026-11-20T10:00:00.000Z", book = BOOK } = {}) {
  const callId = engine.aiCallIdOf(activityId, seq);
  await store.begin({ record: recordOf(callId, activityId, seq, { bookId: book, timing: { startedAt, firstTextAt: null, endedAt: null } }), system, user });
  let offset = 0;
  for (const piece of pieces) {
    await store.append(callId, 1, offset, piece);
    offset += Buffer.byteLength(piece);
  }
  if (status) await store.end(callId, finalOf(status));
  return callId;
}

/** Defines the shared tests under `label`: `make()` returns a fresh `{ store, cleanup, maxCallsPerTask? }`. */
export function defineContract(label, make) {
  const run = (name, body) =>
    test(`${label}: ${name}`, async () => {
      const made = await make();
      try {
        await body(made.store, made);
      } finally {
        await made.cleanup?.();
      }
    });

  run("a call is written and read back: its record, its texts by attempt, and its end", async (store) => {
    await store.saveTask(headerOf("activity_1", "2026-11-20T10:00:00.000Z"));
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
    assert.equal(await store.readText(BOOK, "activity_1-0009", "system", 0), null, "a call that was never begun is not kept");
  });

  run("writes out of order and twice leave the same state as in order", async (inOrder, made) => {
    const other = await make();
    try {
      const shuffled = other.store;
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
    } finally {
      await other.cleanup?.();
    }
  });

  run("a read from the middle of a character rounds down to its start", async (store) => {
    const callId = "activity_3-0001";
    await store.begin({ record: recordOf(callId, "activity_3", 1), system: "", user: "" });
    await store.append(callId, 1, 0, "é€");
    const chunk = await store.readText(BOOK, callId, "response", 1, 1);
    assert.equal(chunk.from, 0);
    assert.equal(chunk.text, "é€");
    assert.equal((await store.readText(BOOK, callId, "response", 2, 1)).text, "€");
    assert.equal((await store.readText(BOOK, callId, "response", 99, 1)).text, "", "past the end is empty");
    const emoji = "a😀b";
    await store.append(callId, 2, 0, emoji);
    for (const middle of [2, 3, 4]) assert.equal((await store.readText(BOOK, callId, "response", middle, 2)).text, "😀b", `from the byte ${middle} of a four-byte character`);
  });

  run("the task list is newest first, pages with a cursor, and lists a task with calls but no header", async (store) => {
    for (let index = 0; index < 5; index += 1) await store.saveTask(headerOf(`activity_p${index}`, `2026-11-20T10:0${index}:00.000Z`));
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
    assert.equal((await store.listTasks(BOOK, { limit: 1000 })).tasks.length, 6, "a limit past the most is the most");
  });

  run("the totals follow what the book keeps, and the pins count", async (store) => {
    await store.saveTask(headerOf("activity_t1", "2026-11-20T10:00:00.000Z"));
    await store.begin({ record: recordOf("activity_t1-0001", "activity_t1", 1), system: "abcd", user: "ef" });
    await store.append("activity_t1-0001", 1, 0, "0123456789");
    await store.saveTask(headerOf("activity_t2", "2026-11-20T11:00:00.000Z"));
    await store.begin({ record: recordOf("activity_t2-0001", "activity_t2", 1), system: "", user: "" });
    assert.deepEqual(await store.totals(BOOK), { bytes: 16, tasks: 2, calls: 2, pinnedTasks: 0, pinnedBytes: 0 });
    await store.keep(BOOK, "activity_t1", true);
    const totals = await store.totals(BOOK);
    assert.equal(totals.pinnedTasks, 1);
    assert.equal(totals.pinnedBytes, 16);
    assert.equal((await store.readTask(BOOK, "activity_t1")).header.pinned, true);
    await store.keep(BOOK, "activity_t1", false);
    assert.equal((await store.totals(BOOK)).pinnedTasks, 0, "a pin is let go");
    assert.deepEqual(await store.totals("nobody"), { bytes: 0, tasks: 0, calls: 0, pinnedTasks: 0, pinnedBytes: 0 });
  });

  run("prune drops whole old tasks, keeps the pinned and the running ones, and reports what it did", async (store) => {
    const days = ["01", "02", "03", "04"];
    for (const [index, day] of days.entries()) {
      const activityId = `activity_d${index}`;
      await store.saveTask(headerOf(activityId, `2026-11-${day}T10:00:00.000Z`, { status: index === 3 ? "running" : "done" }));
      await store.begin({ record: recordOf(`${activityId}-0001`, activityId, 1, { timing: { startedAt: `2026-11-${day}T10:00:00.000Z`, firstTextAt: null, endedAt: null } }), system: "x".repeat(100), user: "y".repeat(100) });
    }
    await store.keep(BOOK, "activity_d0", true);
    assert.equal((await store.totals(BOOK)).bytes, 800);
    const result = await store.prune(BOOK, 300);
    assert.deepEqual(result.dropped, ["activity_d1", "activity_d2"], "the oldest unpinned, not running, first, whole");
    assert.equal(result.bytes, 400);
    assert.equal(result.overBudget, true, "the pinned and the running task keep 400, over the 300 budget");
    assert.equal(result.pinnedTasks, 1);
    assert.equal(result.pinnedBytes, 200);
    assert.equal(await store.readTask(BOOK, "activity_d1"), null);
    assert.equal(await store.readText(BOOK, "activity_d1-0001", "system", 0), null, "what a dropped task held is gone with it");
    assert.ok(await store.readTask(BOOK, "activity_d0"));
    assert.ok(await store.readTask(BOOK, "activity_d3"));
    assert.deepEqual(await store.totals(BOOK), { bytes: 400, tasks: 2, calls: 2, pinnedTasks: 1, pinnedBytes: 200 });
    assert.deepEqual((await store.prune(BOOK, 300)).dropped, [], "a book that is as it can be is left alone");
    assert.deepEqual((await store.prune("nobody", 10)).dropped, []);
  });

  run("deleting a book removes its calls and tasks and nothing of another book", async (store) => {
    await store.begin({ record: recordOf("activity_b-0001", "activity_b", 1), system: "x", user: "" });
    await store.begin({ record: recordOf("activity_o-0001", "activity_o", 1, { bookId: "other" }), system: "x", user: "" });
    await store.keep(BOOK, "activity_b", true);
    await store.deleteBook(BOOK);
    assert.equal(await store.readTask(BOOK, "activity_b"), null);
    assert.equal((await store.totals(BOOK)).calls, 0);
    assert.equal((await store.listTasks(BOOK, { limit: 10 })).tasks.length, 0, "a pinned task goes too: this is the author's choice");
    assert.equal((await store.readText("other", "activity_o-0001", "system", 0)).text, "x");
    await store.deleteBook("never-there");
  });

  run("a task keeps at most its calls: a later call of the task is not kept, and what it writes is let go", async (store, made) => {
    const most = made.maxCallsPerTask ?? engine.AI_CALL_LIMITS.maxCallsPerTask;
    for (let seq = 1; seq <= most + 1; seq += 1) await store.begin({ record: recordOf(engine.aiCallIdOf("activity_many", seq), "activity_many", seq), system: "s", user: "" });
    const refused = engine.aiCallIdOf("activity_many", most + 1);
    await store.append(refused, 1, 0, "nobody keeps this");
    await store.end(refused, finalOf());
    const task = await store.readTask(BOOK, "activity_many");
    assert.equal(task.calls.length, most);
    assert.equal(await store.readText(BOOK, refused, "system", 0), null);
    assert.equal((await store.totals(BOOK)).calls, most);
  });

  run("a text that is not a whole number of bytes, or an attempt below 1, is refused", async (store) => {
    await store.begin({ record: recordOf("activity_r-0001", "activity_r", 1), system: "", user: "" });
    await assert.rejects(store.append("activity_r-0001", 0, 0, "x"), RangeError);
    await assert.rejects(store.append("activity_r-0001", 1, -1, "x"), RangeError);
    await assert.rejects(store.append("activity_r-0001", 1, 1.5, "x"), RangeError);
    await store.append("activity_r-0001", 1, 0, "", "empty text is nothing");
    assert.equal((await store.readText(BOOK, "activity_r-0001", "response", 0)).size, 0);
  });

  run("a call that has not ended is readable as it is, and is not complete; its end makes it so", async (store) => {
    const callId = "activity_live-0001";
    await store.begin({ record: recordOf(callId, "activity_live", 1), system: "s", user: "u" });
    await store.append(callId, 1, 0, "The harbor ");
    const running = await store.readText(BOOK, callId, "response", 0);
    assert.deepEqual([running.text, running.next, running.size, running.complete], ["The harbor ", 11, 11, false]);
    await store.append(callId, 1, 11, "woke");
    const more = await store.readText(BOOK, callId, "response", running.next);
    assert.deepEqual([more.text, more.from, more.next, more.size, more.complete], ["woke", 11, 15, 15, false], "a reader that follows asks from what it has");
    assert.equal((await store.readTask(BOOK, "activity_live")).calls[0].status, "running");
    await store.end(callId, finalOf("ok"));
    const done = await store.readText(BOOK, callId, "response", more.next);
    assert.deepEqual([done.text, done.next, done.size, done.complete], ["", 15, 15, true]);
    assert.equal((await store.readTask(BOOK, "activity_live")).calls[0].status, "ok");
  });

  run("a response of each provider attempt is its own, the last one with text is the default, and an attempt with none reads as empty", async (store) => {
    const callId = "activity_att-0001";
    await store.begin({ record: recordOf(callId, "activity_att", 1), system: "", user: "" });
    await store.append(callId, 1, 0, "first try");
    await store.append(callId, 3, 0, "third");
    await store.end(callId, finalOf("ok"));
    assert.equal((await store.readText(BOOK, callId, "response", 0, 1)).text, "first try");
    assert.equal((await store.readText(BOOK, callId, "response", 0, 3)).text, "third");
    assert.equal((await store.readText(BOOK, callId, "response", 0)).text, "third");
    const none = await store.readText(BOOK, callId, "response", 0, 2);
    assert.deepEqual([none.text, none.size], ["", 0]);
  });

  run("the last end of a call is the state it keeps, and its texts stay", async (store) => {
    const callId = "activity_end-0001";
    await store.begin({ record: recordOf(callId, "activity_end", 1), system: "kept", user: "too" });
    await store.append(callId, 1, 0, "answer");
    await store.end(callId, finalOf("failed", { response: { text: { characters: 6, bytes: 6, storedBytes: 6, truncated: false }, partial: true }, dropped: "limit", storedBytes: 13 }));
    await store.end(callId, finalOf("aborted", { storedBytes: 14 }));
    const [call] = (await store.readTask(BOOK, "activity_end")).calls;
    assert.deepEqual([call.status, call.storedBytes, call.dropped, call.response.partial], ["aborted", 14, null, false]);
    assert.equal((await store.readText(BOOK, callId, "response", 0)).text, "answer");
    assert.equal((await store.readText(BOOK, callId, "system", 0)).text, "kept");
  });

  run("a text that arrives after the end is still the text, and the totals follow", async (store) => {
    const callId = "activity_late-0001";
    await store.begin({ record: recordOf(callId, "activity_late", 1), system: "s", user: "u" });
    await store.append(callId, 1, 0, "one ");
    await store.end(callId, finalOf("ok"));
    await store.append(callId, 1, 4, "two");
    await store.append(callId, 1, 4, "two");
    assert.equal((await store.readText(BOOK, callId, "response", 0)).text, "one two");
    assert.equal((await store.totals(BOOK)).bytes, 1 + 1 + 7);
  });

  run("a task made by a pin or a header alone exists but is not listed until it has what to show", async (store) => {
    await store.keep(BOOK, "activity_pin", true);
    assert.equal(await store.readTask(BOOK, "activity_pin"), null);
    assert.deepEqual((await store.listTasks(BOOK, { limit: 5 })).tasks, []);
    assert.equal((await store.totals(BOOK)).tasks, 0);
    await store.saveTask(headerOf("activity_pin", "2026-11-20T10:00:00.000Z"));
    const task = await store.readTask(BOOK, "activity_pin");
    assert.equal(task.header.pinned, true, "the pin was waiting for the task");
    assert.equal((await store.totals(BOOK)).pinnedTasks, 1);
    await store.saveTask(headerOf("activity_header", "2026-11-20T11:00:00.000Z", { title: "Only a header" }));
    assert.equal((await store.readTask(BOOK, "activity_header")).header.title, "Only a header");
    assert.deepEqual((await store.readTask(BOOK, "activity_header")).calls, []);
  });

  run("the start of a task is the one its header says, and a call that began earlier does not move the header", async (store) => {
    await store.begin({ record: recordOf("activity_s-0001", "activity_s", 1, { timing: { startedAt: "2026-11-20T09:00:00.000Z", firstTextAt: null, endedAt: null } }), system: "", user: "" });
    await store.saveTask(headerOf("activity_s", "2026-11-20T10:00:00.000Z", { title: "S" }));
    await store.saveTask(headerOf("activity_later", "2026-11-20T09:30:00.000Z", { title: "Later" }));
    const listed = (await store.listTasks(BOOK, { limit: 5 })).tasks;
    assert.deepEqual(listed.map((task) => task.activityId), ["activity_s", "activity_later"], "a header says when a task started");
    assert.equal(listed.find((task) => task.activityId === "activity_s").startedAt, "2026-11-20T10:00:00.000Z");
  });

  run("texts with accents, symbols, other scripts and line breaks come back as they were written", async (store) => {
    const callId = "activity_text-0001";
    await store.begin({ record: recordOf(callId, "activity_text", 1, { label: "Write chapter 1" }), system: "The harbor, “cittá” — 日本語 ✓", user: "line one\nline two\r\nline three" });
    assert.equal((await store.readText(BOOK, callId, "system", 0)).text, "The harbor, “cittá” — 日本語 ✓");
    assert.equal((await store.readText(BOOK, callId, "user", 0)).text, "line one\nline two\r\nline three");
    assert.equal((await store.readTask(BOOK, "activity_text")).calls[0].label, "Write chapter 1");
  });
}

export { engine };
