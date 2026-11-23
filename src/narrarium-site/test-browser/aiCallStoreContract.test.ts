import "fake-indexeddb/auto";
import { IDBFactory, IDBKeyRange } from "fake-indexeddb";
import { describe, expect, it } from "vitest";
import { AI_CALL_LIMITS, MemoryAiCallStore, aiCallIdOf, type AiCallBegin, type AiCallEnd, type AiCallRecord, type AiCallStore, type AiCallTaskDraft } from "narrarium-engine";
import { IndexedDbAiCallStore } from "@/autopilot/calls/store";

// The contract of the engine's `AiCallStore`, written once and run on both stores: the reference (the engine's memory store) and the browser's (IndexedDB). A test that
// is written here is true of the reference first: that is what makes it the contract, and what makes the browser's store "the same".

interface Subject {
  store: AiCallStore;
  /** Waits for what a store does after a write (the browser's folds the chunks of a response into a text). */
  settle(): Promise<void>;
}

const subjects: Array<[string, () => Promise<Subject>]> = [
  ["the engine's memory store", async () => ({ store: new MemoryAiCallStore(), settle: async () => undefined })],
  ["the browser's IndexedDB store", async () => {
    const store = await IndexedDbAiCallStore.open({ factory: new IDBFactory(), keyRange: IDBKeyRange, scope: () => "workspace:test", storage: null });
    return { store, settle: () => store.idle() };
  }],
];

const BOOK = "book-1";
const T0 = "2026-11-20T10:00:00.000Z";

function recordOf(callId: string, activityId: string, seq: number, overrides: Partial<AiCallRecord> = {}): AiCallRecord {
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
    timing: { startedAt: T0, firstTextAt: null, endedAt: null },
    storedBytes: 6,
    dropped: null,
    ...overrides,
  };
}

function finalOf(status: AiCallEnd["status"] = "ok", overrides: Partial<AiCallEnd> = {}): AiCallEnd {
  return {
    status,
    response: { text: null, partial: false },
    attempts: [],
    timing: { startedAt: T0, firstTextAt: "2026-11-20T10:00:01.000Z", endedAt: "2026-11-20T10:00:09.000Z" },
    storedBytes: 6,
    dropped: null,
    ...overrides,
  };
}

function header(activityId: string, startedAt: string, overrides: Partial<AiCallTaskDraft> = {}): AiCallTaskDraft {
  return { bookId: BOOK, activityId, title: activityId, kind: "write", chapter: 1, scene: null, status: "done", startedAt, endedAt: startedAt, ...overrides };
}

const begin = (callId: string, activityId: string, seq: number, system = "sys", user = "usr", overrides: Partial<AiCallRecord> = {}): AiCallBegin => ({ record: recordOf(callId, activityId, seq, overrides), system, user });

describe.each(subjects)("the AiCallStore contract: %s", (_name, make) => {
  it("keeps a call and reads it back: its record, its texts by attempt, and its end", async () => {
    const { store, settle } = await make();
    await store.saveTask(header("activity_1", T0));
    await store.begin(begin("activity_1-0001", "activity_1", 1));
    await store.append("activity_1-0001", 1, 0, "Hel");
    await store.append("activity_1-0001", 1, 3, "lo");
    await store.append("activity_1-0001", 2, 0, "Retry");
    await store.end("activity_1-0001", finalOf());
    for (const phase of ["at once", "once the chunks are folded"]) {
      if (phase !== "at once") await settle();
      const task = await store.readTask(BOOK, "activity_1");
      expect(task?.header.calls, phase).toBe(1);
      expect(task?.header.bytes, phase).toBe(3 + 3 + 5 + 5);
      expect(task?.calls[0].status, phase).toBe("ok");
      expect((await store.readText(BOOK, "activity_1-0001", "response", 0, 1))?.text, phase).toBe("Hello");
      expect((await store.readText(BOOK, "activity_1-0001", "response", 0))?.text, `${phase}: the last attempt with text is the default`).toBe("Retry");
      expect((await store.readText(BOOK, "activity_1-0001", "system", 0))?.text, phase).toBe("sys");
      expect((await store.readText(BOOK, "activity_1-0001", "user", 0))?.text, phase).toBe("usr");
      expect((await store.readText(BOOK, "activity_1-0001", "response", 0))?.complete, phase).toBe(true);
    }
    expect(await store.readText("other-book", "activity_1-0001", "system", 0), "a call belongs to its book").toBeNull();
    expect(await store.readText(BOOK, "no-such-call", "system", 0)).toBeNull();
  });

  it("answers `size`, `next` and `complete` of a call that is still running, and `complete` once it has ended", async () => {
    const { store } = await make();
    await store.begin(begin("activity_r-0001", "activity_r", 1));
    await store.append("activity_r-0001", 1, 0, "abc");
    const live = await store.readText(BOOK, "activity_r-0001", "response", 0, 1);
    expect(live).toEqual({ text: "abc", from: 0, next: 3, size: 3, complete: false });
    await store.append("activity_r-0001", 1, 3, "def");
    expect(await store.readText(BOOK, "activity_r-0001", "response", live!.next, 1)).toEqual({ text: "def", from: 3, next: 6, size: 6, complete: false });
    await store.end("activity_r-0001", finalOf());
    expect((await store.readText(BOOK, "activity_r-0001", "response", 6, 1))?.complete).toBe(true);
  });

  it("gives the same state for writes that come twice and out of order as for writes that come once and in order", async () => {
    const inOrder = await make();
    const shuffled = await make();
    const parts: Array<[number, string]> = [[0, "héllo "], [7, "wörld"], [13, "!!"]];
    const callId = "activity_2-0001";
    await inOrder.store.begin(begin(callId, "activity_2", 1, "s", "u"));
    for (const [offset, text] of parts) await inOrder.store.append(callId, 1, offset, text);
    await inOrder.store.end(callId, finalOf());

    await shuffled.store.append(callId, 1, 13, "!!");
    await shuffled.store.end(callId, finalOf());
    await shuffled.store.append(callId, 1, 7, "wörld");
    await shuffled.store.begin(begin(callId, "activity_2", 1, "s", "u"));
    await shuffled.store.append(callId, 1, 0, "héllo ");
    await shuffled.store.append(callId, 1, 0, "héllo ");
    await shuffled.store.append(callId, 1, 7, "wörld");
    await shuffled.store.begin(begin(callId, "activity_2", 1, "other", "other"));
    await shuffled.store.end(callId, finalOf());
    await shuffled.store.end(callId, finalOf());

    for (const subject of [inOrder, shuffled]) await subject.settle();
    expect((await inOrder.store.readText(BOOK, callId, "response", 0, 1))?.text).toBe("héllo wörld!!");
    expect((await shuffled.store.readText(BOOK, callId, "response", 0, 1))?.text).toBe("héllo wörld!!");
    expect((await shuffled.store.readText(BOOK, callId, "system", 0))?.text, "the first begin is kept").toBe("s");
    expect(await shuffled.store.totals(BOOK)).toEqual(await inOrder.store.totals(BOOK));
    expect((await shuffled.store.readTask(BOOK, "activity_2"))?.calls[0].status).toBe("ok");
  });

  it("keeps an `append` that comes after the `end`: its bytes are the text", async () => {
    const { store, settle } = await make();
    await store.begin(begin("activity_l-0001", "activity_l", 1));
    await store.append("activity_l-0001", 1, 0, "one ");
    await store.end("activity_l-0001", finalOf());
    await settle();
    await store.append("activity_l-0001", 1, 4, "two");
    expect((await store.readText(BOOK, "activity_l-0001", "response", 0, 1))?.text).toBe("one two");
    await settle();
    expect((await store.readText(BOOK, "activity_l-0001", "response", 0, 1))?.text).toBe("one two");
    expect((await store.totals(BOOK)).bytes).toBe(3 + 3 + 7);
  });

  it("sets bytes: a write over bytes that are there leaves the text as the last write says, a repeat leaves it as it was, and a gap is zeros until it is filled", async () => {
    const { store } = await make();
    await store.begin(begin("activity_s-0001", "activity_s", 1, "", ""));
    await store.append("activity_s-0001", 1, 0, "Hello");
    await store.append("activity_s-0001", 1, 0, "Hello");
    await store.append("activity_s-0001", 1, 0, "Hi");
    expect((await store.readText(BOOK, "activity_s-0001", "response", 0, 1))?.text).toBe("Hillo");
    await store.append("activity_s-0001", 1, 8, "!");
    expect((await store.readText(BOOK, "activity_s-0001", "response", 0, 1))?.text).toBe("Hillo\0\0\0!");
    await store.append("activity_s-0001", 1, 5, "123");
    expect((await store.readText(BOOK, "activity_s-0001", "response", 0, 1))?.text).toBe("Hillo123!");
    expect((await store.totals(BOOK)).bytes).toBe(9);
  });

  it("counts offsets in bytes of UTF-8: a read from the middle of a character rounds down to its start, and a read past the end is empty", async () => {
    const { store, settle } = await make();
    const callId = "activity_3-0001";
    await store.begin(begin(callId, "activity_3", 1, "", ""));
    await store.append(callId, 1, 0, "é€");
    for (const phase of ["live", "folded"]) {
      if (phase === "folded") {
        await store.end(callId, finalOf());
        await settle();
      }
      const middle = await store.readText(BOOK, callId, "response", 1, 1);
      expect(middle?.from, phase).toBe(0);
      expect(middle?.text, phase).toBe("é€");
      expect((await store.readText(BOOK, callId, "response", 2, 1))?.text, phase).toBe("€");
      expect((await store.readText(BOOK, callId, "response", 3, 1))?.from, phase).toBe(2);
      expect((await store.readText(BOOK, callId, "response", 4, 1))?.from, phase).toBe(2);
      expect((await store.readText(BOOK, callId, "response", 5, 1))?.text, phase).toBe("");
      expect((await store.readText(BOOK, callId, "response", 99, 1))?.text, `${phase}: past the end is empty`).toBe("");
      expect((await store.readText(BOOK, callId, "response", -5, 1))?.text, `${phase}: before the start is the start`).toBe("é€");
    }
  });

  it("writes text of every width at its byte offset, in any order, and reads it back whole and by pieces", async () => {
    const { store, settle } = await make();
    const callId = "activity_w-0001";
    const pieces = ["a", "é", "€", "𝄞", "你好", "😀", " fine."];
    const offsets: number[] = [];
    let at = 0;
    for (const piece of pieces) {
      offsets.push(at);
      at += new TextEncoder().encode(piece).length;
    }
    await store.begin(begin(callId, "activity_w", 1, "", ""));
    for (const index of [4, 1, 6, 0, 3, 5, 2]) await store.append(callId, 1, offsets[index], pieces[index]);
    await store.end(callId, finalOf());
    const whole = pieces.join("");
    for (const phase of ["at once", "folded"]) {
      if (phase === "folded") await settle();
      expect((await store.readText(BOOK, callId, "response", 0, 1))?.text, phase).toBe(whole);
      let read = "";
      let from = 0;
      for (let step = 0; step < 100; step += 1) {
        const chunk = await store.readText(BOOK, callId, "response", from, 1);
        read += chunk!.text;
        if (chunk!.next === from + (chunk!.text ? new TextEncoder().encode(chunk!.text).length : 0) && chunk!.next >= chunk!.size) break;
        from = chunk!.next;
      }
      expect(read, phase).toBe(whole);
      for (const [index, offset] of offsets.entries()) expect((await store.readText(BOOK, callId, "response", offset, 1))?.text, `${phase}: from the character ${index}`).toBe(pieces.slice(index).join(""));
    }
  });

  it("streams a response in pieces that a reader follows with the `next` it was given, until the end", async () => {
    const { store, settle } = await make();
    const callId = "activity_f-0001";
    await store.begin(begin(callId, "activity_f", 1, "", ""));
    const text = Array.from({ length: 300 }, (_, index) => `Frase ${index} del gabbiano — già volato via. `).join("");
    const bytes = new TextEncoder().encode(text);
    const followed: string[] = [];
    let next = 0;
    let written = 0;
    const encoder = new TextEncoder();
    while (written < text.length) {
      const piece = text.slice(written, written + 997);
      await store.append(callId, 1, encoder.encode(text.slice(0, written)).length, piece);
      written += piece.length;
      const chunk = await store.readText(BOOK, callId, "response", next, 1);
      followed.push(chunk!.text);
      next = chunk!.next;
    }
    await store.end(callId, finalOf());
    await settle();
    expect(followed.join("")).toBe(text);
    expect(next).toBe(bytes.length);
    expect((await store.readText(BOOK, callId, "response", 0, 1))?.text).toBe(text);
    expect((await store.totals(BOOK)).bytes).toBe(bytes.length);
  });

  it("lists the tasks newest first, in pages with a cursor, and lists a task with calls and no header as running", async () => {
    const { store } = await make();
    for (let index = 0; index < 5; index += 1) await store.saveTask(header(`activity_p${index}`, `2026-11-20T10:0${index}:00.000Z`));
    await store.begin(begin("activity_orphan-0001", "activity_orphan", 1, "", "", { timing: { startedAt: "2026-11-20T10:09:00.000Z", firstTextAt: null, endedAt: null } }));
    const first = await store.listTasks(BOOK, { limit: 2 });
    expect(first.tasks.map((task) => task.activityId)).toEqual(["activity_orphan", "activity_p4"]);
    expect(first.tasks[0].status, "a task with no header is running").toBe("running");
    expect(first.tasks[0].kind).toBe("write");
    const second = await store.listTasks(BOOK, { before: first.next ?? undefined, limit: 2 });
    expect(second.tasks.map((task) => task.activityId)).toEqual(["activity_p3", "activity_p2"]);
    const third = await store.listTasks(BOOK, { before: second.next ?? undefined, limit: 2 });
    expect(third.tasks.map((task) => task.activityId)).toEqual(["activity_p1", "activity_p0"]);
    expect(third.next).toBeNull();
    expect(await store.listTasks("nobody", { limit: 5 })).toEqual({ tasks: [], next: null });
    expect((await store.listTasks(BOOK, { limit: 1000 })).tasks).toHaveLength(6);
  });

  it("orders tasks that started at the same moment by their id, and never repeats or skips one across pages", async () => {
    const { store } = await make();
    for (const id of ["activity_c", "activity_a", "activity_d", "activity_b"]) await store.saveTask(header(id, T0));
    const seen: string[] = [];
    let before: string | undefined;
    for (let page = 0; page < 5; page += 1) {
      const result = await store.listTasks(BOOK, { before, limit: 1 });
      seen.push(...result.tasks.map((task) => task.activityId));
      if (!result.next) break;
      before = result.next;
    }
    expect(seen).toEqual(["activity_d", "activity_c", "activity_b", "activity_a"]);
  });

  it("keeps the totals of a book as what its tasks keep, and the pins count", async () => {
    const { store } = await make();
    await store.saveTask(header("activity_t1", T0));
    await store.begin(begin("activity_t1-0001", "activity_t1", 1, "abcd", "ef"));
    await store.append("activity_t1-0001", 1, 0, "0123456789");
    await store.saveTask(header("activity_t2", "2026-11-20T11:00:00.000Z"));
    await store.begin(begin("activity_t2-0001", "activity_t2", 1, "", ""));
    expect(await store.totals(BOOK)).toEqual({ bytes: 16, tasks: 2, calls: 2, pinnedTasks: 0, pinnedBytes: 0 });
    await store.keep(BOOK, "activity_t1", true);
    const totals = await store.totals(BOOK);
    expect(totals.pinnedTasks).toBe(1);
    expect(totals.pinnedBytes).toBe(16);
    expect((await store.readTask(BOOK, "activity_t1"))?.header.pinned).toBe(true);
    await store.keep(BOOK, "activity_t1", false);
    expect((await store.totals(BOOK)).pinnedTasks).toBe(0);
    expect(await store.totals("nobody")).toEqual({ bytes: 0, tasks: 0, calls: 0, pinnedTasks: 0, pinnedBytes: 0 });
  });

  it("creates a task that a pin names before it exists, without listing it, and the pin is there when the task arrives", async () => {
    const { store } = await make();
    await store.keep(BOOK, "activity_early", true);
    expect(await store.readTask(BOOK, "activity_early")).toBeNull();
    expect((await store.listTasks(BOOK, { limit: 10 })).tasks).toEqual([]);
    expect((await store.totals(BOOK)).tasks).toBe(0);
    await store.saveTask(header("activity_early", T0));
    const task = await store.readTask(BOOK, "activity_early");
    expect(task?.header.pinned).toBe(true);
    expect((await store.totals(BOOK)).pinnedTasks).toBe(1);
  });

  it("drops whole old tasks on `prune`, never a pinned one and never a running one, and says what it did", async () => {
    const { store } = await make();
    const days = ["01", "02", "03", "04"];
    for (const [index, day] of days.entries()) {
      const activityId = `activity_d${index}`;
      await store.saveTask(header(activityId, `2026-11-${day}T10:00:00.000Z`, { status: index === 3 ? "running" : "done" }));
      await store.begin(begin(`${activityId}-0001`, activityId, 1, "x".repeat(100), "y".repeat(100), { timing: { startedAt: `2026-11-${day}T10:00:00.000Z`, firstTextAt: null, endedAt: null } }));
    }
    await store.keep(BOOK, "activity_d0", true);
    expect((await store.totals(BOOK)).bytes).toBe(800);
    const result = await store.prune(BOOK, 300);
    expect(result.dropped, "the oldest unpinned that are not running, first, whole").toEqual(["activity_d1", "activity_d2"]);
    expect(result.bytes).toBe(400);
    expect(result.overBudget, "the pinned and the running task keep 400, over the 300 budget").toBe(true);
    expect(result.pinnedTasks).toBe(1);
    expect(result.pinnedBytes).toBe(200);
    expect(await store.readTask(BOOK, "activity_d1")).toBeNull();
    expect(await store.readText(BOOK, "activity_d1-0001", "system", 0)).toBeNull();
    expect(await store.readTask(BOOK, "activity_d0")).not.toBeNull();
    expect(await store.readTask(BOOK, "activity_d3")).not.toBeNull();
    expect((await store.totals(BOOK)).bytes).toBe(400);
    expect((await store.totals(BOOK)).tasks).toBe(2);
    const again = await store.prune(BOOK, 300);
    expect(again.dropped).toEqual([]);
  });

  it("stops dropping as soon as the book is within its budget, and drops nothing when it already is", async () => {
    const { store } = await make();
    for (let index = 0; index < 5; index += 1) {
      const activityId = `activity_b${index}`;
      await store.saveTask(header(activityId, `2026-11-0${index + 1}T10:00:00.000Z`));
      await store.begin(begin(`${activityId}-0001`, activityId, 1, "x".repeat(50), "y".repeat(50), { timing: { startedAt: `2026-11-0${index + 1}T10:00:00.000Z`, firstTextAt: null, endedAt: null } }));
    }
    expect((await store.prune(BOOK, 1000)).dropped).toEqual([]);
    const result = await store.prune(BOOK, 250);
    expect(result.dropped).toEqual(["activity_b0", "activity_b1", "activity_b2"]);
    expect(result.overBudget).toBe(false);
    expect((await store.listTasks(BOOK, { limit: 10 })).tasks.map((task) => task.activityId)).toEqual(["activity_b4", "activity_b3"]);
  });

  it("deletes a book with its calls, tasks and pins, and nothing of another book", async () => {
    const { store } = await make();
    await store.begin(begin("activity_b-0001", "activity_b", 1, "x", ""));
    await store.keep(BOOK, "activity_b", true);
    await store.begin(begin("activity_o-0001", "activity_o", 1, "x", "", { bookId: "other" }));
    await store.deleteBook(BOOK);
    expect(await store.readTask(BOOK, "activity_b")).toBeNull();
    expect(await store.readText(BOOK, "activity_b-0001", "system", 0)).toBeNull();
    expect((await store.totals(BOOK)).calls).toBe(0);
    expect((await store.listTasks(BOOK, { limit: 10 })).tasks).toEqual([]);
    expect((await store.readText("other", "activity_o-0001", "system", 0))?.text).toBe("x");
    expect((await store.totals("other")).calls).toBe(1);
  });

  it("keeps at most 64 calls for a task: a later call is not kept, and nothing of it is written afterwards", async () => {
    const { store } = await make();
    for (let seq = 1; seq <= AI_CALL_LIMITS.maxCallsPerTask + 1; seq += 1) await store.begin(begin(aiCallIdOf("activity_many", seq), "activity_many", seq, "s", ""));
    const extra = aiCallIdOf("activity_many", AI_CALL_LIMITS.maxCallsPerTask + 1);
    await store.append(extra, 1, 0, "late");
    await store.end(extra, finalOf());
    const task = await store.readTask(BOOK, "activity_many");
    expect(task?.calls).toHaveLength(64);
    expect(task?.header.calls).toBe(64);
    expect(await store.readText(BOOK, extra, "system", 0)).toBeNull();
    expect((await store.totals(BOOK)).bytes).toBe(64);
  });

  it("refuses a text that is not a whole number of bytes from 0, and an attempt below 1; an empty text is nothing", async () => {
    const { store } = await make();
    await store.begin(begin("activity_x-0001", "activity_x", 1, "", ""));
    await expect(store.append("activity_x-0001", 0, 0, "x")).rejects.toBeInstanceOf(RangeError);
    await expect(store.append("activity_x-0001", 1, -1, "x")).rejects.toBeInstanceOf(RangeError);
    await expect(store.append("activity_x-0001", 1, 1.5, "x")).rejects.toBeInstanceOf(RangeError);
    await expect(store.append("activity_x-0001", 1.5, 0, "x")).rejects.toBeInstanceOf(RangeError);
    await store.append("activity_x-0001", 1, 0, "");
    expect((await store.readText(BOOK, "activity_x-0001", "response", 0))?.size).toBe(0);
  });

  it("keeps what a call that failed or was cut had written, says it is partial, and ends it with its attempts", async () => {
    const { store, settle } = await make();
    const callId = "activity_p-0001";
    await store.begin(begin(callId, "activity_p", 1, "s", "u"));
    await store.append(callId, 1, 0, "Il gabbiano è già ");
    const final = finalOf("interrupted", {
      response: { text: { characters: 18, bytes: 19, storedBytes: 19, truncated: false }, partial: true },
      attempts: [{ index: 1, textAttempt: 1, text: { characters: 18, bytes: 19, storedBytes: 19, truncated: false }, provider: "openai", model: "m", integrationId: "i", endpoint: "https://api.example.com", stream: true, tools: false, firstByteMs: 10, durationMs: 90, outcome: "interrupted", finishReason: null, reasoningCharacters: 0, usage: null, usageKnown: false, cost: null, costKnown: false, currency: null, transport: { status: 200, end: "reset" }, error: { name: "AiStreamInterruptedError", message: "the connection was lost", status: null, transient: true, timedOut: false }, partialCharacters: 18 }],
      dropped: null,
    });
    await store.end(callId, final);
    await settle();
    const task = await store.readTask(BOOK, "activity_p");
    expect(task?.calls[0].status).toBe("interrupted");
    expect(task?.calls[0].response.partial).toBe(true);
    expect(task?.calls[0].attempts[0].error?.name).toBe("AiStreamInterruptedError");
    expect(task?.calls[0].attempts[0].transport).toEqual({ status: 200, end: "reset" });
    expect((await store.readText(BOOK, callId, "response", 0))?.text).toBe("Il gabbiano è già ");
  });

  it("starts a call with no attempts and no response, whatever its record said, and ends it with the ones it is given", async () => {
    const { store } = await make();
    const dirty = recordOf("activity_c-0001", "activity_c", 1, { status: "failed", response: { text: { characters: 1, bytes: 1, storedBytes: 1, truncated: false }, partial: true } });
    await store.begin({ record: dirty, system: "", user: "" });
    const started = (await store.readTask(BOOK, "activity_c"))?.calls[0];
    expect(started?.attempts).toEqual([]);
    expect(started?.response).toEqual({ text: null, partial: false });
    await store.end("activity_c-0001", finalOf("failed"));
    expect((await store.readTask(BOOK, "activity_c"))?.calls[0].status).toBe("failed");
  });

  it("dates a task by its header when it has one, and by its earliest call until then", async () => {
    const { store } = await make();
    await store.begin(begin("activity_k-0001", "activity_k", 1, "", "", { timing: { startedAt: "2026-11-20T12:00:00.000Z", firstTextAt: null, endedAt: null } }));
    await store.begin(begin("activity_k-0002", "activity_k", 2, "", "", { timing: { startedAt: "2026-11-20T11:00:00.000Z", firstTextAt: null, endedAt: null } }));
    expect((await store.readTask(BOOK, "activity_k"))?.header.startedAt).toBe("2026-11-20T11:00:00.000Z");
    await store.saveTask(header("activity_k", "2026-11-20T13:00:00.000Z"));
    const task = await store.readTask(BOOK, "activity_k");
    expect(task?.header.startedAt).toBe("2026-11-20T13:00:00.000Z");
    expect(task?.header.title).toBe("activity_k");
    expect(task?.calls.map((call) => call.seq)).toEqual([1, 2]);
  });

  it("keeps two books apart: their tasks, their totals and their pruning", async () => {
    const { store } = await make();
    for (const book of ["one", "two"]) {
      await store.saveTask(header("activity_same", T0, { bookId: book }));
      await store.begin({ record: recordOf(`${book}-0001`, "activity_same", 1, { bookId: book }), system: "x".repeat(10), user: "" });
    }
    await store.prune("one", 0);
    expect(await store.readTask("one", "activity_same")).toBeNull();
    expect((await store.readTask("two", "activity_same"))?.calls).toHaveLength(1);
    expect((await store.totals("two")).bytes).toBe(10);
  });
});
