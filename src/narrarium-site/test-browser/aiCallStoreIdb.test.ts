import "fake-indexeddb/auto";
import { IDBFactory, IDBKeyRange, IDBObjectStore } from "fake-indexeddb";
import { afterEach, describe, expect, it, vi } from "vitest";
import { AI_CALL_BUDGETS, AiCallDiskFullError, MemoryAiCallStore, type AiCallBegin, type AiCallEnd, type AiCallRecord, type AiCallStore, type AiCallTaskDraft } from "narrarium-engine";
import { AiCallStoreUnavailableError, isQuotaError, runTransaction } from "@/autopilot/calls/idb";
import { STALE_RUNNING_TASK_MS, IndexedDbAiCallStore } from "@/autopilot/calls/store";
import type { AiCallStoreOptions, StorageManagerLike } from "@/autopilot/calls/types";
import { useSettingsStore } from "@/store/settingsStore";

// What is the browser's own in the store: how the live chunks become a compressed text, what a crash leaves, that a long response is written once, the quota,
// the account fence, what the browser says about keeping the data, the budgets, a database that another tab upgrades or blocks, and the outbox of the copies.

const BOOK = "book-1";
const T0 = "2026-11-20T10:00:00.000Z";
const KIB = 1024;
const encoder = new TextEncoder();

function recordOf(callId: string, activityId: string, seq: number, overrides: Partial<AiCallRecord> = {}): AiCallRecord {
  return {
    formatVersion: 1, callId, bookId: BOOK, accountScope: null, runId: "run_1", activityId, seq, stepAttempt: 1, task: "write", chapter: 1, scene: 1, label: "Write", capability: "autopilot", host: "browser",
    request: { system: { characters: 3, bytes: 3, storedBytes: 3, truncated: false }, user: { characters: 3, bytes: 3, storedBytes: 3, truncated: false }, images: 0, tool: null, toolSchemaHash: null, structured: false, maxOutputTokens: null, temperature: null },
    status: "running", response: { text: null, partial: false }, attempts: [], timing: { startedAt: T0, firstTextAt: null, endedAt: null }, storedBytes: 6, dropped: null, ...overrides,
  };
}

const finalOf = (status: AiCallEnd["status"] = "ok"): AiCallEnd => ({ status, response: { text: null, partial: false }, attempts: [], timing: { startedAt: T0, firstTextAt: T0, endedAt: T0 }, storedBytes: 6, dropped: null });
const header = (activityId: string, startedAt: string, overrides: Partial<AiCallTaskDraft> = {}): AiCallTaskDraft => ({ bookId: BOOK, activityId, title: activityId, kind: "write", chapter: 1, scene: null, status: "done", startedAt, endedAt: startedAt, ...overrides });
const begin = (callId: string, activityId: string, seq: number, system = "sys", user = "usr", overrides: Partial<AiCallRecord> = {}): AiCallBegin => ({ record: recordOf(callId, activityId, seq, overrides), system, user });

/** A database of its own, and the account the page is in (a test changes it). */
function fresh(options: AiCallStoreOptions = {}) {
  const factory = new IDBFactory();
  const account = { value: "workspace:a" };
  const open = (more: AiCallStoreOptions = {}) => IndexedDbAiCallStore.open({ factory, keyRange: IDBKeyRange, scope: () => account.value, storage: null, ...options, ...more });
  return { factory, account, open };
}

/** The rows of an object store, read through a connection of the test's own. */
async function rawRows<T>(factory: IDBFactory, store: string): Promise<T[]> {
  const db = await new Promise<IDBDatabase>((resolve, reject) => {
    const request = factory.open("narrarium-ai-calls");
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
  try {
    return await new Promise<T[]>((resolve, reject) => {
      const request = db.transaction(store, "readonly").objectStore(store).getAll();
      request.onsuccess = () => resolve(request.result as T[]);
      request.onerror = () => reject(request.error);
    });
  } finally {
    db.close();
  }
}

/** Text that compresses well, in ASCII: its length in characters is its length in bytes. */
const compressible = (bytes: number) => "Il gabbiano e gia volato via. ".repeat(Math.ceil(bytes / 30)).slice(0, bytes);

afterEach(() => {
  vi.unstubAllGlobals();
  useSettingsStore.setState({ accountIdentity: null });
});

describe("the live chunks of a response, and how they become its text", () => {
  it("are folded into a compressed text when the call ends, and the totals are the bytes of the text as the port counts them", async () => {
    const { factory, open } = fresh();
    const store = await open();
    const system = compressible(5 * KIB);
    await store.begin(begin("activity_1-0001", "activity_1", 1, system, "ok"));
    const text = compressible(40 * KIB);
    for (let at = 0; at < text.length; at += 4 * KIB) await store.append("activity_1-0001", 1, at, text.slice(at, at + 4 * KIB));
    expect((await store.stats()).chunks, "one row for each write while it streams").toBe(10);
    expect((await rawRows<{ field: string }>(factory, "texts")).map((row) => row.field).sort()).toEqual(["system", "user"]);
    await store.end("activity_1-0001", finalOf());
    await store.idle();
    expect((await store.stats()).chunks).toBe(0);
    const rows = await rawRows<{ field: string; encoding: string; size: number; data: Uint8Array }>(factory, "texts");
    const response = rows.find((row) => row.field === "response")!;
    expect(response.encoding).toBe("gzip");
    expect(response.size).toBe(40 * KIB);
    expect(response.data.length, "it is smaller than the text").toBeLessThan(response.size / 4);
    expect(rows.find((row) => row.field === "system")?.encoding, "the long system message is compressed with it").toBe("gzip");
    expect(rows.find((row) => row.field === "user")?.encoding, "a short one is kept as it is: a gzip header would cost more").toBe("plain");
    expect((await store.readText(BOOK, "activity_1-0001", "response", 0, 1))?.text).toBe(text);
    expect((await store.readText(BOOK, "activity_1-0001", "system", 0))?.text).toBe(system);
    expect((await store.totals(BOOK)).bytes).toBe(5 * KIB + 2 + 40 * KIB);
    expect(await store.audit(BOOK)).toEqual({ bytes: 5 * KIB + 2 + 40 * KIB, tasks: 1, calls: 1 });
  });

  it("are kept as plain text when the browser cannot compress, and read back the same", async () => {
    vi.stubGlobal("CompressionStream", undefined);
    const { factory, open } = fresh();
    const store = await open();
    await store.begin(begin("activity_2-0001", "activity_2", 1));
    const text = compressible(8 * KIB);
    await store.append("activity_2-0001", 1, 0, text);
    await store.end("activity_2-0001", finalOf());
    await store.idle();
    const rows = await rawRows<{ field: string; encoding: string }>(factory, "texts");
    expect(rows.every((row) => row.encoding === "plain")).toBe(true);
    expect((await store.stats()).chunks).toBe(0);
    expect((await store.readText(BOOK, "activity_2-0001", "response", 0, 1))?.text).toBe(text);
  });

  it("are folded when the store opens, after a page that was closed in the middle of a call: the text is whole, the call is still running", async () => {
    const { open } = fresh();
    const first = await open({ recover: false });
    await first.begin(begin("activity_c-0001", "activity_c", 1));
    const text = compressible(20 * KIB);
    for (let at = 0; at < text.length; at += 2 * KIB) await first.append("activity_c-0001", 1, at, text.slice(at, at + 2 * KIB));
    first.close();
    expect((await (await open({ recover: false })).stats()).chunks, "nothing folded them").toBe(10);

    const second = await open();
    await second.idle();
    expect((await second.stats()).chunks).toBe(0);
    const chunk = await second.readText(BOOK, "activity_c-0001", "response", 0, 1);
    expect(chunk?.text).toBe(text);
    expect(chunk?.complete).toBe(false);
    expect((await second.readTask(BOOK, "activity_c"))?.calls[0].status).toBe("running");
    expect((await second.totals(BOOK)).bytes).toBe(6 + 20 * KIB);
    // And the call goes on where it was left.
    await second.append("activity_c-0001", 1, 20 * KIB, "!");
    expect((await second.readText(BOOK, "activity_c-0001", "response", 0, 1))?.text).toBe(`${text}!`);
  });

  it("are not lost to a fold that runs while the page that wrote them goes on: a text is never replaced by an older one", async () => {
    const { open } = fresh();
    const writer = await open({ recover: false });
    await writer.begin(begin("activity_t-0001", "activity_t", 1));
    let text = "";
    for (let index = 0; index < 30; index += 1) {
      const piece = `${index}: ${compressible(900)}\n`;
      await writer.append("activity_t-0001", 1, encoder.encode(text).length, piece);
      text += piece;
      // Another page opens now and then, and folds what it finds.
      if (index % 7 === 3) await (await open()).idle();
    }
    await writer.end("activity_t-0001", finalOf());
    await writer.idle();
    const reader = await open();
    await reader.idle();
    expect((await reader.readText(BOOK, "activity_t-0001", "response", 0, 1))?.text).toBe(text);
    expect((await reader.totals(BOOK)).bytes).toBe(6 + encoder.encode(text).length);
    expect(await reader.audit(BOOK)).toEqual({ bytes: 6 + encoder.encode(text).length, tasks: 1, calls: 1 });
  });

  it("are dropped, when no begin ever came for them, after a day; younger ones wait for their call", async () => {
    const { open } = fresh();
    const clock = { now: Date.parse(T0) };
    const first = await open({ recover: false, now: () => clock.now });
    await first.append("activity_o-0001", 1, 0, "waiting");
    clock.now += 12 * 3600 * 1000;
    await first.append("activity_o-0002", 1, 0, "waiting too");
    expect((await first.stats()).pending).toBe(2);
    clock.now += 13 * 3600 * 1000;
    const second = await open({ now: () => clock.now });
    await second.idle();
    const stats = await second.stats();
    expect(stats.pending, "the one that is a day and an hour old is gone").toBe(1);
    expect(stats.chunks).toBe(1);
    await second.begin(begin("activity_o-0002", "activity_o", 2, "s", "u"));
    expect((await second.readText(BOOK, "activity_o-0002", "response", 0, 1))?.text).toBe("waiting too");
  });
});

describe("a long response is written once", () => {
  it("never rewrites what it has: every byte is put once, as a chunk, and the rows that change with it stay small", async () => {
    const { open } = fresh();
    const store = await open();
    await store.begin(begin("activity_big-0001", "activity_big", 1, "s", "u"));
    const puts: Array<{ store: string; bytes: number }> = [];
    const original = IDBObjectStore.prototype.put;
    vi.spyOn(IDBObjectStore.prototype, "put").mockImplementation(function (this: IDBObjectStore, value: unknown, key?: IDBValidKey) {
      const row = value as { data?: Uint8Array };
      puts.push({ store: this.name, bytes: row.data ? row.data.length : JSON.stringify(value).length });
      return original.call(this, value, key);
    });
    const piece = compressible(16 * KIB);
    const total = 2 * 1024 * KIB;
    let offset = 0;
    while (offset < total) {
      await store.append("activity_big-0001", 1, offset, piece);
      offset += encoder.encode(piece).length;
    }
    const during = [...puts];
    expect(during.filter((put) => put.store === "chunks")).toHaveLength(total / (16 * KIB));
    expect(during.filter((put) => put.store === "chunks").reduce((sum, put) => sum + put.bytes, 0), "each byte once").toBe(offset);
    expect(during.filter((put) => put.store === "texts"), "no text is written while it streams").toEqual([]);
    expect(Math.max(...during.filter((put) => put.store !== "chunks").map((put) => put.bytes)), "the rows that follow it are small whatever its size").toBeLessThan(2 * KIB);
    puts.length = 0;
    await store.end("activity_big-0001", finalOf());
    await store.idle();
    expect(puts.filter((put) => put.store === "texts" && put.bytes > 0)).toHaveLength(1);
    expect((await store.readText(BOOK, "activity_big-0001", "response", 0, 1))?.size).toBe(offset);
  });

  it("is followed by a live reader at the cost of what is new, not of what there is", async () => {
    const { open } = fresh();
    const store = await open();
    await store.begin(begin("activity_live-0001", "activity_live", 1, "s", "u"));
    const piece = compressible(4 * KIB);
    let offset = 0;
    for (let index = 0; index < 100; index += 1) {
      await store.append("activity_live-0001", 1, offset, piece);
      offset += encoder.encode(piece).length;
    }
    const rows = { chunks: 0 };
    const original = IDBObjectStore.prototype.getAll;
    vi.spyOn(IDBObjectStore.prototype, "getAll").mockImplementation(function (this: IDBObjectStore, ...args: Parameters<IDBObjectStore["getAll"]>) {
      const request = original.apply(this, args);
      if (this.name === "chunks") request.addEventListener("success", () => { rows.chunks += (request.result as unknown[]).length; });
      return request;
    });
    await store.append("activity_live-0001", 1, offset, "new");
    const read = await store.readText(BOOK, "activity_live-0001", "response", offset, 1);
    expect(read?.text).toBe("new");
    expect(rows.chunks, "a poll reads the last chunks, not the hundred").toBeLessThanOrEqual(3);
  });
});

describe("the quota", () => {
  it("is the error of the port: a write the browser refuses for lack of room says AiCallDiskFullError, and leaves the store as it was", async () => {
    const { open } = fresh();
    const store = await open();
    await store.begin(begin("activity_q-0001", "activity_q", 1, "s", "u"));
    await store.append("activity_q-0001", 1, 0, "before ");
    const original = IDBObjectStore.prototype.put;
    let full = true;
    vi.spyOn(IDBObjectStore.prototype, "put").mockImplementation(function (this: IDBObjectStore, value: unknown, key?: IDBValidKey) {
      if (full && this.name === "chunks") throw new DOMException("The quota has been exceeded.", "QuotaExceededError");
      return original.call(this, value, key);
    });
    await expect(store.append("activity_q-0001", 1, 7, "refused")).rejects.toBeInstanceOf(AiCallDiskFullError);
    expect(await store.totals(BOOK)).toMatchObject({ bytes: 2 + 7 });
    expect((await store.readText(BOOK, "activity_q-0001", "response", 0, 1))?.text).toBe("before ");
    full = false;
    await store.append("activity_q-0001", 1, 7, "now");
    expect((await store.readText(BOOK, "activity_q-0001", "response", 0, 1))?.text).toBe("before now");
    expect(await store.audit(BOOK)).toMatchObject({ bytes: 2 + 10 });
  });

  it("is also what a transaction that the browser aborts at its end says: the quota error comes out as it is, and is told as such", async () => {
    expect(isQuotaError(new DOMException("full", "QuotaExceededError"))).toBe(true);
    expect(isQuotaError(Object.assign(new Error("x"), { code: 22 }))).toBe(true);
    expect(isQuotaError(new TypeError("quota of a typed array"))).toBe(false);
    expect(isQuotaError(new Error("boom"))).toBe(false);
    const quota = new DOMException("full", "QuotaExceededError");
    const raw: Record<string, unknown> = { error: null, abort() { /* the database aborts it by itself */ } };
    const db = { transaction: () => { setTimeout(() => { raw.error = quota; (raw.onabort as () => void)(); }, 0); return raw; } } as unknown as IDBDatabase;
    await expect(runTransaction(db, IDBKeyRange, ["texts"], "readwrite", async () => "done")).rejects.toBe(quota);
  });

  it("is a reason to keep a book within a quarter of the room the browser says there is", async () => {
    const storage: StorageManagerLike = { estimate: async () => ({ quota: 400 * 1024 * 1024, usage: 1000 }) };
    const { open } = fresh();
    const store = await open({ storage });
    const status = await store.status();
    expect(status.budgets).toEqual({ perBookBytes: 100 * 1024 * 1024, perDeviceBytes: 100 * 1024 * 1024, quotaBytes: 400 * 1024 * 1024, usageBytes: 1000 });
    const roomy = await open({ storage: { estimate: async () => ({ quota: 100 * 1024 ** 3 }) } });
    expect((await roomy.status()).budgets).toMatchObject({ perBookBytes: AI_CALL_BUDGETS.browserPerBookBytes, perDeviceBytes: AI_CALL_BUDGETS.browserPerDeviceBytes });
    const unknown = await open({ storage: { estimate: async () => { throw new Error("no estimate"); } } });
    expect((await unknown.status()).budgets).toMatchObject({ perBookBytes: AI_CALL_BUDGETS.browserPerBookBytes, quotaBytes: null });
  });
});

describe("the account", () => {
  it("fences the writes of a store that was bound to an account: after the page changes account they are dropped, and what the new account reads is its own", async () => {
    const { account, open } = fresh();
    const store = await open();
    const bound = store.bind("workspace:a");
    await bound.saveTask(header("activity_a", T0));
    await bound.begin(begin("activity_a-0001", "activity_a", 1, "private to a", ""));
    await bound.append("activity_a-0001", 1, 0, "first ");
    account.value = "google:b";
    await bound.append("activity_a-0001", 1, 6, "dropped");
    await bound.end("activity_a-0001", finalOf());
    await bound.begin(begin("activity_a-0002", "activity_a", 2));
    await bound.saveTask(header("activity_a2", T0));
    await bound.keep(BOOK, "activity_a", true);
    expect(store.fencedWrites).toBe(6);
    expect(await store.listTasks(BOOK, { limit: 10 }), "b sees nothing of a").toEqual({ tasks: [], next: null });
    expect(await store.readTask(BOOK, "activity_a")).toBeNull();
    expect(await store.readText(BOOK, "activity_a-0001", "system", 0)).toBeNull();
    expect(await store.totals(BOOK)).toEqual({ bytes: 0, tasks: 0, calls: 0, pinnedTasks: 0, pinnedBytes: 0 });
    expect(await bound.readTask(BOOK, "activity_a"), "a bound store reads nothing either while the page is in another account").toBeNull();
    // b writes the same book and the same ids of its own.
    await store.saveTask(header("activity_b", T0));
    await store.begin(begin("activity_b-0001", "activity_b", 1, "private to b", ""));
    expect((await store.readText(BOOK, "activity_b-0001", "system", 0))?.text).toBe("private to b");
    // a comes back: its data is as it was, to the byte.
    account.value = "workspace:a";
    expect((await bound.readText(BOOK, "activity_a-0001", "response", 0, 1))?.text).toBe("first ");
    expect((await bound.readTask(BOOK, "activity_a"))?.calls[0].status, "the end that was dropped did not happen").toBe("running");
    expect((await bound.listTasks(BOOK, { limit: 10 })).tasks.map((task) => task.activityId)).toEqual(["activity_a"]);
    expect(await bound.readText(BOOK, "activity_b-0001", "system", 0), "a sees nothing of b").toBeNull();
    expect(await bound.audit(BOOK)).toEqual({ bytes: 12 + 6, tasks: 1, calls: 1 });
  });

  it("drops a write whose account changes between the start of its transaction and its write: nothing of it is kept", async () => {
    const { account, open } = fresh();
    const store = await open();
    await store.begin(begin("activity_m-0001", "activity_m", 1));
    const original = IDBObjectStore.prototype.get;
    let armed = true;
    vi.spyOn(IDBObjectStore.prototype, "get").mockImplementation(function (this: IDBObjectStore, ...args: Parameters<IDBObjectStore["get"]>) {
      const request = original.apply(this, args);
      if (armed && this.name === "chunks") {
        armed = false;
        account.value = "google:b";
      }
      return request;
    });
    await store.append("activity_m-0001", 1, 0, "in flight");
    account.value = "workspace:a";
    expect(store.fencedWrites).toBe(1);
    expect((await store.stats()).chunks).toBe(0);
    expect((await store.readText(BOOK, "activity_m-0001", "response", 0, 1))?.size).toBe(0);
  });

  it("is, by default, the account of the site: the repository scope that the rest of the app is fenced by", async () => {
    useSettingsStore.setState({ accountIdentity: "workspace:one" });
    const factory = new IDBFactory();
    const store = await IndexedDbAiCallStore.open({ factory, keyRange: IDBKeyRange, storage: null });
    const mine = store.bind("workspace:one");
    await mine.saveTask(header("activity_site", T0));
    expect((await store.listTasks(BOOK, { limit: 5 })).tasks).toHaveLength(1);
    useSettingsStore.setState({ accountIdentity: "workspace:two" });
    expect((await store.listTasks(BOOK, { limit: 5 })).tasks).toEqual([]);
    await mine.saveTask(header("activity_site2", T0, { status: "running" }));
    expect(store.fencedWrites).toBe(1);
    useSettingsStore.setState({ accountIdentity: "workspace:one" });
    expect((await store.listTasks(BOOK, { limit: 5 })).tasks.map((task) => task.activityId)).toEqual(["activity_site"]);
  });
});

describe("what the browser is asked on the first write", () => {
  it("is to keep the data, once: the first write asks `persist()`, the next ones and every read do not, and the answer is remembered", async () => {
    const storage = { persist: vi.fn(async () => true), persisted: vi.fn(async () => false) };
    const { open } = fresh();
    const store = await open({ storage });
    expect((await store.status()).persistence, "nothing was written").toBe("unknown");
    await store.listTasks(BOOK, { limit: 1 });
    await store.totals(BOOK);
    expect(storage.persist).not.toHaveBeenCalled();
    await store.begin(begin("activity_p-0001", "activity_p", 1));
    await store.append("activity_p-0001", 1, 0, "x");
    await store.saveTask(header("activity_p", T0));
    await vi.waitFor(async () => expect((await store.status()).persistence).toBe("granted"));
    expect(storage.persist).toHaveBeenCalledTimes(1);
  });

  it("is told as it was answered: refused, already granted (no question), thrown, or no such thing in this browser", async () => {
    const cases: Array<{ storage: StorageManagerLike | null; expected: string; asked: number }> = [
      { storage: { persist: vi.fn(async () => false), persisted: vi.fn(async () => false) }, expected: "denied", asked: 1 },
      { storage: { persist: vi.fn(async () => true), persisted: vi.fn(async () => true) }, expected: "granted", asked: 0 },
      { storage: { persist: vi.fn(async () => { throw new Error("blocked"); }) }, expected: "denied", asked: 1 },
      { storage: {}, expected: "unsupported", asked: 0 },
      { storage: null, expected: "unsupported", asked: 0 },
    ];
    for (const { storage, expected, asked } of cases) {
      const { open } = fresh();
      const store = await open({ storage });
      await store.saveTask(header("activity_a", T0));
      await vi.waitFor(async () => expect((await store.status()).persistence).toBe(expected));
      expect(vi.mocked(storage?.persist ?? (async () => true)).mock?.calls?.length ?? 0, expected).toBe(asked);
    }
  });
});

describe("the budgets", () => {
  const book = (id: string) => ({ bookId: id });
  async function task(store: AiCallStore, bookId: string, activityId: string, startedAt: string, bytes: number, status: AiCallTaskDraft["status"] = "done") {
    await store.begin({ record: recordOf(`${activityId}-0001`, activityId, 1, { bookId, timing: { startedAt, firstTextAt: null, endedAt: null } }), system: "x".repeat(bytes), user: "" });
    await store.saveTask(header(activityId, startedAt, { ...book(bookId), status }));
  }

  it("keep a book within its budget after each task: the oldest tasks go first, whole, and a pinned or a running one never", async () => {
    const { open } = fresh();
    const store = await open({ budgets: { perBookBytes: 1000, perDeviceBytes: 100_000 } });
    await task(store, BOOK, "activity_1", "2026-11-01T10:00:00.000Z", 400);
    await task(store, BOOK, "activity_2", "2026-11-02T10:00:00.000Z", 400);
    await store.keep(BOOK, "activity_1", true);
    await task(store, BOOK, "activity_3", "2026-11-03T10:00:00.000Z", 400);
    expect((await store.listTasks(BOOK, { limit: 10 })).tasks.map((item) => item.activityId), "the oldest that is not pinned went").toEqual(["activity_3", "activity_1"]);
    await task(store, BOOK, "activity_4", "2026-11-04T10:00:00.000Z", 400, "running");
    expect((await store.listTasks(BOOK, { limit: 10 })).tasks.map((item) => item.activityId), "a running task is not a task that is over: nothing is dropped for it").toEqual(["activity_4", "activity_3", "activity_1"]);
    await task(store, BOOK, "activity_5", "2026-11-05T10:00:00.000Z", 400);
    expect((await store.listTasks(BOOK, { limit: 10 })).tasks.map((item) => item.activityId), "the pin and the running task keep 800: the two that are over go, the new one too").toEqual(["activity_4", "activity_1"]);
    expect((await store.totals(BOOK)).bytes).toBe(800);
    expect(await store.audit(BOOK)).toEqual({ bytes: 800, tasks: 2, calls: 2 });
  });

  it("keep the device within its budget, whichever book holds the oldest task, and never touch a book that is within its own", async () => {
    const { open } = fresh();
    const store = await open({ budgets: { perBookBytes: 10_000, perDeviceBytes: 1000 } });
    await task(store, "one", "activity_o1", "2026-11-01T10:00:00.000Z", 400);
    await task(store, "two", "activity_t1", "2026-11-02T10:00:00.000Z", 400);
    await task(store, "one", "activity_o2", "2026-11-03T10:00:00.000Z", 400);
    expect((await store.listTasks("one", { limit: 10 })).tasks.map((item) => item.activityId), "the oldest of the device, in the book that held it").toEqual(["activity_o2"]);
    expect((await store.listTasks("two", { limit: 10 })).tasks.map((item) => item.activityId)).toEqual(["activity_t1"]);
    expect((await store.totals("one")).bytes + (await store.totals("two")).bytes).toBe(800);
  });

  it("never drop a pinned task, even when the pins alone are over the budget, and say so", async () => {
    const { open } = fresh();
    const store = await open({ budgets: { perBookBytes: 300, perDeviceBytes: 300 } });
    await task(store, BOOK, "activity_p1", "2026-11-01T10:00:00.000Z", 200);
    await task(store, BOOK, "activity_p2", "2026-11-02T10:00:00.000Z", 200, "running");
    await store.keep(BOOK, "activity_p1", true);
    await task(store, BOOK, "activity_p3", "2026-11-03T10:00:00.000Z", 50);
    const result = await store.enforceBudgets(BOOK);
    expect(result.overBudget).toBe(true);
    expect((await store.listTasks(BOOK, { limit: 10 })).tasks.map((item) => item.activityId)).toEqual(["activity_p2", "activity_p1"]);
  });

  it("let go of a task that says it is running when nothing has touched it for a day: a page that was closed left it", async () => {
    const clock = { now: Date.parse(T0) };
    const { open } = fresh();
    const store = await open({ budgets: { perBookBytes: 300, perDeviceBytes: 100_000 }, now: () => clock.now });
    await task(store, BOOK, "activity_z", "2026-11-01T10:00:00.000Z", 250, "running");
    clock.now += STALE_RUNNING_TASK_MS - 1000;
    await task(store, BOOK, "activity_y", "2026-11-02T10:00:00.000Z", 250);
    expect((await store.listTasks(BOOK, { limit: 10 })).tasks.map((item) => item.activityId), "a day less a second: it still runs, so the new one is what goes").toEqual(["activity_z"]);
    clock.now += 2000;
    await task(store, BOOK, "activity_x", "2026-11-03T10:00:00.000Z", 250);
    expect((await store.listTasks(BOOK, { limit: 10 })).tasks.map((item) => item.activityId), "a day and a second: nobody is running it, and it is the oldest").toEqual(["activity_x"]);
  });
});

describe("the database", () => {
  it("is closed when another tab upgrades it, and what the store does next is told as what it is: unavailable, and nothing is lost", async () => {
    const { factory, open } = fresh();
    const store = await open();
    await store.begin(begin("activity_v-0001", "activity_v", 1, "kept", ""));
    // Another tab (of a newer version of the app) opens the database at version 2.
    const upgraded = await new Promise<IDBDatabase>((resolve, reject) => {
      const request = factory.open("narrarium-ai-calls", 2);
      request.onupgradeneeded = () => undefined;
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error);
    });
    await expect(store.append("activity_v-0001", 1, 0, "x")).rejects.toBeInstanceOf(AiCallStoreUnavailableError);
    await expect(store.listTasks(BOOK, { limit: 1 })).rejects.toBeInstanceOf(AiCallStoreUnavailableError);
    upgraded.close();
    // A store of the new version reads what the old one kept.
    const next = await open({ version: 2 });
    expect((await next.readText(BOOK, "activity_v-0001", "system", 0))?.text).toBe("kept");
  });

  it("opens again by itself when its connection was closed for another reason, once, and goes on", async () => {
    const { open } = fresh();
    const store = await open();
    await store.begin(begin("activity_r-0001", "activity_r", 1, "s", ""));
    // Whoever holds the connection closes it (a browser that frees memory, a tab that clears the origin): the next operation opens the database again.
    (store as unknown as { core: { db: IDBDatabase } }).core.db.close();
    await store.append("activity_r-0001", 1, 0, "again");
    expect((await store.readText(BOOK, "activity_r-0001", "response", 0, 1))?.text).toBe("again");
  });

  it("is not opened when another tab holds an older version and does not close it: the store says so after a moment, and does not wait for ever", async () => {
    const { factory, open } = fresh();
    await open();
    const holder = await new Promise<IDBDatabase>((resolve, reject) => {
      const request = factory.open("narrarium-ai-calls", 1);
      request.onsuccess = () => {
        // This tab ignores the request to close.
        request.result.onversionchange = () => undefined;
        resolve(request.result);
      };
      request.onerror = () => reject(request.error);
    });
    const started = Date.now();
    await expect(open({ version: 2, blockedTimeoutMs: 40 })).rejects.toThrow(/blocked by another/);
    expect(Date.now() - started).toBeLessThan(2000);
    holder.close();
  });

  it("is not opened by a browser that refuses, has no IndexedDB, or never answers: an error that says so, and no hang", async () => {
    const refusing = { open: () => { throw new DOMException("denied", "SecurityError"); } } as unknown as IDBFactory;
    await expect(IndexedDbAiCallStore.open({ factory: refusing, keyRange: IDBKeyRange, storage: null })).rejects.toBeInstanceOf(AiCallStoreUnavailableError);
    vi.stubGlobal("indexedDB", undefined);
    await expect(IndexedDbAiCallStore.open({ storage: null })).rejects.toThrow(/no IndexedDB/);
    vi.unstubAllGlobals();
    const silent = { open: () => ({}) } as unknown as IDBFactory;
    await expect(IndexedDbAiCallStore.open({ factory: silent, keyRange: IDBKeyRange, storage: null, openTimeoutMs: 30 })).rejects.toThrow(/did not open in time/);
    const failing = { open: () => { const request: Record<string, unknown> = {}; setTimeout(() => { request.error = new DOMException("old", "VersionError"); (request.onerror as () => void)(); }, 0); return request; } } as unknown as IDBFactory;
    await expect(IndexedDbAiCallStore.open({ factory: failing, keyRange: IDBKeyRange, storage: null })).rejects.toBeInstanceOf(AiCallStoreUnavailableError);
  });
});

describe("the outbox of the copies", () => {
  const entry = (taskId: string, target: string, extra: Partial<{ attempts: number; nextAt: string | null; error: string | null; bookId: string }> = {}) => ({ bookId: BOOK, taskId, target, attempts: 0, nextAt: null, error: null, ...extra });

  it("keeps what waits for a place, lists the entries that are due first, replaces an entry of the same task and target, and deletes", async () => {
    const { open } = fresh();
    const { outbox } = await open();
    await outbox.put(entry("activity_1", "drive", { nextAt: "2026-11-20T12:00:00.000Z", attempts: 2, error: "offline" }));
    await outbox.put(entry("activity_2", "drive"));
    await outbox.put(entry("activity_1", "github", { nextAt: "2026-11-20T11:00:00.000Z" }));
    await outbox.put(entry("activity_9", "drive", { bookId: "other" }));
    expect((await outbox.list()).map((item) => `${item.bookId}/${item.taskId}/${item.target}`), "the ones that are due now first, then by time").toEqual(["book-1/activity_2/drive", "other/activity_9/drive", "book-1/activity_1/github", "book-1/activity_1/drive"]);
    expect((await outbox.list({ bookId: BOOK })).map((item) => `${item.taskId}/${item.target}`)).toEqual(["activity_2/drive", "activity_1/github", "activity_1/drive"]);
    expect((await outbox.list({ target: "github" })).map((item) => item.taskId)).toEqual(["activity_1"]);
    expect((await outbox.list({ dueBy: "2026-11-20T11:30:00.000Z" })).map((item) => `${item.taskId}/${item.target}`), "the ones that are due by then, with the ones that are due now").toEqual(["activity_2/drive", "activity_9/drive", "activity_1/github"]);
    await outbox.put(entry("activity_1", "drive", { attempts: 3, nextAt: "2026-11-20T13:00:00.000Z", error: "still offline" }));
    const replaced = (await outbox.list({ target: "drive", bookId: BOOK })).find((item) => item.taskId === "activity_1");
    expect(replaced).toEqual(entry("activity_1", "drive", { attempts: 3, nextAt: "2026-11-20T13:00:00.000Z", error: "still offline" }));
    await outbox.delete(BOOK, "activity_1", "drive");
    await outbox.delete(BOOK, "activity_nothing", "drive");
    expect((await outbox.list({ bookId: BOOK })).map((item) => `${item.taskId}/${item.target}`)).toEqual(["activity_2/drive", "activity_1/github"]);
  });

  it("belongs to the account that put it, and goes with its book when the book is deleted", async () => {
    const { account, open } = fresh();
    const store = await open();
    await store.outbox.put(entry("activity_1", "drive"));
    account.value = "google:b";
    expect(await store.outbox.list()).toEqual([]);
    await store.outbox.put(entry("activity_1", "drive", { attempts: 7 }));
    account.value = "workspace:a";
    expect((await store.outbox.list())[0].attempts).toBe(0);
    await store.deleteBook(BOOK);
    expect(await store.outbox.list()).toEqual([]);
    account.value = "google:b";
    expect((await store.outbox.list())[0].attempts, "the book of the other account is not touched").toBe(7);
  });

  it("is not written by a store that is bound to an account the page has left", async () => {
    const { account, open } = fresh();
    const store = await open();
    const bound = store.bind("workspace:a");
    account.value = "google:b";
    await bound.outbox.put(entry("activity_1", "drive"));
    expect(await store.outbox.list()).toEqual([]);
    account.value = "workspace:a";
    expect(await store.outbox.list()).toEqual([]);
  });
});

describe("the tasks that are finished", () => {
  const saved = (store: IndexedDbAiCallStore) => {
    const events: Array<{ bookId: string; activityId: string; scope: string }> = [];
    const stop = store.onTaskFinished((event) => events.push(event));
    return { events, stop };
  };

  it("are told to whoever listens once their header says they are no longer running and the budget kept them: never a running one", async () => {
    const { open } = fresh();
    const store = await open();
    const { events, stop } = saved(store);
    await store.saveTask(header("activity_1", T0, { status: "running", endedAt: null }));
    expect(events).toEqual([]);
    await store.saveTask(header("activity_1", T0));
    await store.saveTask(header("activity_2", T0, { status: "failed" }));
    await store.saveTask(header("activity_3", T0, { status: "stopped" }));
    expect(events).toEqual([
      { bookId: BOOK, activityId: "activity_1", scope: "workspace:a" },
      { bookId: BOOK, activityId: "activity_2", scope: "workspace:a" },
      { bookId: BOOK, activityId: "activity_3", scope: "workspace:a" },
    ]);
    stop();
    await store.saveTask(header("activity_4", T0));
    expect(events, "a listener that was stopped hears nothing").toHaveLength(3);
  });

  it("are not told when the write was dropped because the page changed account, nor for a store that is bound to the account it has left", async () => {
    const { account, open } = fresh();
    const store = await open();
    const { events } = saved(store);
    const bound = store.bind("workspace:a");
    account.value = "workspace:b";
    await bound.saveTask(header("activity_1", T0));
    expect(events).toEqual([]);
    expect(store.fencedWrites).toBeGreaterThan(0);
    await store.saveTask(header("activity_2", T0));
    expect(events.map((event) => `${event.scope}|${event.activityId}`), "the account the page is in is told, with its own scope").toEqual(["workspace:b|activity_2"]);
  });

  it("are not told when the budget dropped the task that was just finished: it is not kept, so there is nothing to copy", async () => {
    const { open } = fresh({ budgets: { perBookBytes: 300, perDeviceBytes: 100_000 } });
    const store = await open();
    await store.saveTask(header("activity_old", "2026-11-01T10:00:00.000Z"));
    await store.begin(begin("activity_old-0001", "activity_old", 1, "o".repeat(250), ""));
    await store.end("activity_old-0001", finalOf());
    await store.keep(BOOK, "activity_old", true);
    const { events } = saved(store);
    await store.begin(begin("activity_new-0001", "activity_new", 1, "n".repeat(250), ""));
    await store.end("activity_new-0001", finalOf());
    await store.saveTask(header("activity_new", T0));
    expect((await store.listTasks(BOOK, { limit: 5 })).tasks.map((task) => task.activityId), "the pinned task stays, and the new one went to make room").toEqual(["activity_old"]);
    expect(events).toEqual([]);
  });

  it("are not the store's to fail on: a listener that throws is ignored, and the others still hear", async () => {
    const { open } = fresh();
    const store = await open();
    store.onTaskFinished(() => { throw new Error("A listener of the copies."); });
    const { events } = saved(store);
    await expect(store.saveTask(header("activity_1", T0))).resolves.toBeUndefined();
    expect(events).toHaveLength(1);
  });
});

describe("the notes of the copier", () => {
  it("are kept for the account, one for each key, and a null removes one", async () => {
    const { account, open } = fresh();
    const store = await open();
    expect(await store.notes.get("copier:book-1")).toBeNull();
    await store.notes.set("copier:book-1", "2026-11-20T10:00:00.000Z|activity_1");
    expect(await store.notes.get("copier:book-1")).toBe("2026-11-20T10:00:00.000Z|activity_1");
    account.value = "google:b";
    expect(await store.notes.get("copier:book-1")).toBeNull();
    account.value = "workspace:a";
    await store.notes.set("copier:book-1", null);
    expect(await store.notes.get("copier:book-1")).toBeNull();
  });
});

// ─── The same random work on the reference and on this store ────────────────

function random(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

describe("two hundred random writes", () => {
  it.each([1, 2, 3, 4, 5, 6, 7, 8, 9, 10])("give the same books, tasks, texts and totals on this store as on the reference (seed %i)", async (seed) => {
    const reference = new MemoryAiCallStore();
    const { open } = fresh();
    const mine = await open({ budgets: { perBookBytes: 1e12, perDeviceBytes: 1e12 } });
    const next = random(seed);
    const pick = <T,>(items: readonly T[]): T => items[Math.floor(next() * items.length)];
    const books = ["b1", "b2"];
    const activities = Array.from({ length: 6 }, (_, index) => `activity_${seed}_${index}`);
    const words = ["gabbiano ", "è già ", "volato — ", "你好 ", "😀 ", "𝄞 ", "x"];
    const sizes = new Map<string, number>();
    const days = [1, 2, 3, 4, 5, 6];
    const startOf = (activity: string) => `2026-11-0${days[activities.indexOf(activity)]}T10:00:00.000Z`;
    const callsOf = new Map<string, number>();

    const trace: string[] = [];
    const both = async (what: string, action: (store: AiCallStore) => Promise<unknown>) => {
      trace.push(what);
      const expected = await action(reference).then((value) => ({ value }), (error: Error) => ({ error: error.constructor.name }));
      const actual = await action(mine).then((value) => ({ value }), (error: Error) => ({ error: error.constructor.name }));
      expect(actual, trace.slice(-8).join("\n")).toEqual(expected);
      for (const id of books) {
        expect(await mine.totals(id), `${id} after:\n${trace.slice(-8).join("\n")}`).toEqual(await reference.totals(id));
      }
    };

    for (let step = 0; step < 200; step += 1) {
      const book = pick(books);
      const activity = pick(activities);
      const kind = next();
      if (kind < 0.12) {
        const status = next() < 0.7 ? "done" : "running";
        await both(`saveTask ${book}/${activity} ${status}`, (store) => store.saveTask({ bookId: book, activityId: activity, title: activity, kind: "write", chapter: 1, scene: null, status, startedAt: startOf(activity), endedAt: null }));
      } else if (kind < 0.3) {
        const seq = (callsOf.get(`${book}/${activity}`) ?? 0) + (next() < 0.1 ? 0 : 1);
        callsOf.set(`${book}/${activity}`, Math.max(seq, callsOf.get(`${book}/${activity}`) ?? 0));
        const callId = `${activity}-${String(Math.max(1, seq)).padStart(4, "0")}`;
        const record = recordOf(callId, activity, Math.max(1, seq), { bookId: book, timing: { startedAt: startOf(activity), firstTextAt: null, endedAt: null } });
        const system = pick(words).repeat(Math.floor(next() * 4));
        const user = pick(words);
        await both(`begin ${book}/${callId} system=${JSON.stringify(system)} user=${JSON.stringify(user)}`, (store) => store.begin({ record, system, user }));
      } else if (kind < 0.7) {
        const seq = Math.max(1, Math.floor(next() * ((callsOf.get(`${book}/${activity}`) ?? 1) + 1)));
        const callId = `${activity}-${String(seq).padStart(4, "0")}`;
        const attempt = 1 + Math.floor(next() * 3);
        const text = Array.from({ length: 1 + Math.floor(next() * 3) }, () => pick(words)).join("");
        const known = sizes.get(callId + attempt) ?? 0;
        const offset = next() < 0.7 ? known : Math.floor(next() * (known + 4));
        sizes.set(callId + attempt, Math.max(known, offset + encoder.encode(text).length));
        await both(`append ${callId} attempt ${attempt} at ${offset} ${JSON.stringify(text)}`, (store) => store.append(callId, attempt, offset, text));
      } else if (kind < 0.8) {
        const seq = Math.max(1, Math.floor(next() * ((callsOf.get(`${book}/${activity}`) ?? 1) + 1)));
        const callId = `${activity}-${String(seq).padStart(4, "0")}`;
        const status = pick(["ok", "failed", "aborted"] as const);
        await both(`end ${callId} ${status}`, (store) => store.end(callId, { ...finalOf(status), attempts: [] }));
      } else if (kind < 0.88) {
        const pinned = next() < 0.6;
        await both(`keep ${book}/${activity} ${pinned}`, (store) => store.keep(book, activity, pinned));
      } else if (kind < 0.95) {
        const budget = Math.floor(next() * 400);
        await both(`prune ${book} ${budget}`, (store) => store.prune(book, budget));
      } else if (kind < 0.97) {
        await both(`deleteBook ${book}`, (store) => store.deleteBook(book));
        for (const key of [...callsOf.keys()]) if (key.startsWith(`${book}/`)) callsOf.delete(key);
      } else {
        await mine.idle();
      }
    }
    await mine.idle();
    for (const id of books) {
      const expected = await reference.listTasks(id, { limit: 200 });
      const actual = await mine.listTasks(id, { limit: 200 });
      expect(actual).toEqual(expected);
      expect(await mine.totals(id)).toEqual(await reference.totals(id));
      for (const header of expected.tasks) {
        const task = await reference.readTask(id, header.activityId);
        expect(await mine.readTask(id, header.activityId)).toEqual(task);
        for (const call of task!.calls) {
          for (const field of ["system", "user"] as const) expect(await mine.readText(id, call.callId, field, 0)).toEqual(await reference.readText(id, call.callId, field, 0));
          for (const attempt of [undefined, 1, 2, 3]) {
            for (const from of [0, 3, 11]) expect(await mine.readText(id, call.callId, "response", from, attempt)).toEqual(await reference.readText(id, call.callId, "response", from, attempt));
          }
        }
      }
    }
  });
});
