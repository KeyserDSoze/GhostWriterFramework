import "fake-indexeddb/auto";
import { IDBFactory, IDBKeyRange } from "fake-indexeddb";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ServerRequestError, type AiCallBegin, type AiCallEnd, type AiCallRecord } from "narrarium-engine";

const identity = vi.hoisted(() => ({ client: null as unknown as { deleteCalls: (bookId: string) => Promise<unknown> } }));
vi.mock("@/autopilot/serverIdentity", () => ({ verifiedClient: async () => identity.client }));

import { IndexedDbAiCallStore } from "@/autopilot/calls/store";
import { copyOutboxOf, copyServerCalls, deleteBookRecords, ensureCallsHost, resetCallsHostForTests } from "@/autopilot/calls/host";
import { callsStoreFacade, getAiCallStore, resetAiCallStoreForTests, wireBrowserCalls } from "@/autopilot/calls/wire";
import { resetRecordingForTests, setRecording } from "@/autopilot/calls/recording";
import { callsCopier, configureCopyServices, copyServices, resetCopyServicesForTests } from "@/autopilot/calls/copies/services";
import { stopCopiesRuntimeForTests } from "@/autopilot/calls/copies/runtime";
import { MemoryCopyLedger } from "@/autopilot/calls/copies/stores";
import type { CopyFile, CopyTarget, CopyTargetKind } from "@/autopilot/calls/copies/types";
import { useSettingsStore } from "@/store/settingsStore";
import { DEFAULT_SETTINGS, type BookEntry } from "@/types/settings";
import { BOOK, FakeServer, day, recordOf } from "./helpers/fakeServerCalls";

// The browser's host of the AI call records: the outbox of the copies over the store's own, the services the copies get, the copy that starts when a task is finished (the
// engine's session of this browser, or the copy of a server's records), the copy of a personal server's records, and the deletion on both sides.

const ME = "workspace:host-a";
const T0 = "2026-11-20T10:00:00.000Z";
const book = (patch: Partial<BookEntry> = {}): BookEntry => ({ id: BOOK, owner: "me", repo: "book", name: "Book", tokenIndex: null, addedAt: "2026-11-01T00:00:00.000Z", ...patch });
const settingsOf = (books: BookEntry[]) => useSettingsStore.setState({ accountIdentity: ME, settings: { ...DEFAULT_SETTINGS, books } });

const finalOf = (): AiCallEnd => ({ status: "ok", response: { text: null, partial: false }, attempts: [], timing: { startedAt: T0, firstTextAt: T0, endedAt: T0 }, storedBytes: 6, dropped: null });
const begin = (callId: string, activityId: string): AiCallBegin => ({ record: recordOf(callId, activityId, 1, BOOK, T0) as AiCallRecord, system: `system of ${activityId}`, user: `user of ${activityId}` });

/** A place to copy to that remembers what it was given, and says when it was given something. */
function placeToCopyTo(kind: CopyTargetKind = "github") {
  const written: CopyFile[] = [];
  const waiting: Array<{ count: number; resolve: () => void }> = [];
  const target: CopyTarget = {
    kind,
    prepare: async () => undefined,
    write: async (files, onWritten) => {
      for (const file of files) {
        written.push(file);
        await onWritten(file.taskId, file.bytes.length);
      }
      for (const entry of [...waiting]) if (written.length >= entry.count) { waiting.splice(waiting.indexOf(entry), 1); entry.resolve(); }
    },
    removeDays: async () => undefined,
    removeAll: async () => undefined,
  };
  return { target, written, until: (count: number) => (written.length >= count ? Promise.resolve() : new Promise<void>((resolve) => waiting.push({ count, resolve }))) };
}

async function forget(): Promise<void> {
  (await getAiCallStore())?.close();
  resetAiCallStoreForTests();
  await new Promise<void>((resolve) => {
    const request = indexedDB.deleteDatabase("narrarium-ai-calls");
    request.onsuccess = request.onerror = request.onblocked = () => resolve();
  });
  resetAiCallStoreForTests();
}

beforeEach(() => {
  window.localStorage.clear();
  resetRecordingForTests();
  settingsOf([book()]);
  identity.client = { deleteCalls: vi.fn(async () => ({ deleted: true })) };
});

afterEach(async () => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  stopCopiesRuntimeForTests();
  resetCopyServicesForTests();
  resetCallsHostForTests();
  await forget();
  window.localStorage.clear();
  resetRecordingForTests();
  useSettingsStore.setState({ accountIdentity: null, settings: DEFAULT_SETTINGS });
});

describe("the outbox of the copies over the store's own", () => {
  const open = async (account: { value: string }) => IndexedDbAiCallStore.open({ factory: new IDBFactory(), keyRange: IDBKeyRange, scope: () => account.value, storage: null });

  it("keeps what the copies queue in the store, in their words, and a reload finds it", async () => {
    const account = { value: ME };
    const factory = new IDBFactory();
    const first = await IndexedDbAiCallStore.open({ factory, keyRange: IDBKeyRange, scope: () => account.value, storage: null });
    const outbox = copyOutboxOf(first, () => account.value);
    await outbox.put({ bookId: BOOK, taskId: "a", target: "github", attempts: 2, nextAt: 1_700_000_000_000, error: "offline", scope: ME });
    await outbox.put({ bookId: BOOK, taskId: "b", target: "onedrive", attempts: 0, nextAt: 0, error: null, scope: ME });
    await outbox.put({ bookId: "book-2", taskId: "c", target: "google-drive", attempts: 0, nextAt: 0, error: null, scope: ME });
    const sorted = async (bookId?: string) => (await outbox.list(bookId)).sort((left, right) => left.taskId.localeCompare(right.taskId));
    expect(await sorted(BOOK)).toEqual([
      { bookId: BOOK, taskId: "a", target: "github", attempts: 2, nextAt: 1_700_000_000_000, error: "offline", scope: ME },
      { bookId: BOOK, taskId: "b", target: "onedrive", attempts: 0, nextAt: 0, error: null, scope: ME },
    ]);
    expect((await sorted()).map((item) => item.taskId)).toEqual(["a", "b", "c"]);
    // The same item replaces itself: the copier's retry writes it again with one more attempt.
    await outbox.put({ bookId: BOOK, taskId: "a", target: "github", attempts: 3, nextAt: 1_700_000_100_000, error: "failed", scope: ME });
    expect((await sorted(BOOK))[0]).toMatchObject({ attempts: 3, nextAt: 1_700_000_100_000, error: "failed" });
    first.close();

    // The page is reloaded: a store on the same database finds what was queued.
    const second = await IndexedDbAiCallStore.open({ factory, keyRange: IDBKeyRange, scope: () => account.value, storage: null });
    const again = copyOutboxOf(second, () => account.value);
    expect((await again.list(BOOK)).map((item) => item.taskId).sort()).toEqual(["a", "b"]);
    await again.delete(BOOK, "a", "github");
    await again.delete(BOOK, "nothing-here", "github");
    expect((await again.list(BOOK)).map((item) => item.taskId)).toEqual(["b"]);
  });

  it("is fenced by the account: what was queued for another account is not put, not listed and not deleted from here", async () => {
    const account = { value: ME };
    const store = await open(account);
    const outbox = copyOutboxOf(store, () => account.value);
    await outbox.put({ bookId: BOOK, taskId: "mine", target: "github", attempts: 0, nextAt: 0, error: null, scope: ME });
    await outbox.put({ bookId: BOOK, taskId: "theirs", target: "github", attempts: 0, nextAt: 0, error: null, scope: "workspace:other" });
    expect((await outbox.list(BOOK)).map((item) => item.taskId)).toEqual(["mine"]);
    account.value = "workspace:other";
    expect(await outbox.list(BOOK), "the other account sees nothing of it").toEqual([]);
    await outbox.delete(BOOK, "mine", "github");
    account.value = ME;
    expect((await outbox.list(BOOK)).map((item) => item.taskId), "and cannot delete it").toEqual(["mine"]);
  });

  it("leaves out what is not a copy of the site's (an entry of a place it does not know)", async () => {
    const account = { value: ME };
    const store = await open(account);
    await store.outbox.put({ bookId: BOOK, taskId: "x", target: "somewhere-else", attempts: 0, nextAt: null, error: null });
    await store.outbox.put({ bookId: BOOK, taskId: "y", target: "github", attempts: 0, nextAt: null, error: null });
    expect((await copyOutboxOf(store, () => account.value).list(BOOK)).map((item) => item.taskId)).toEqual(["y"]);
  });
});

describe("the host of the browser", () => {
  it("gives the copies the browser's store, its outbox and the deletion, once, and opens nothing until it is asked", async () => {
    const open = vi.spyOn(indexedDB, "open");
    expect(open).not.toHaveBeenCalled();
    const store = await ensureCallsHost();
    expect(store).not.toBeNull();
    expect(await ensureCallsHost(), "once").toBe(store);
    const services = copyServices();
    const mine = services.store();
    expect(mine).not.toBeNull();
    await mine!.saveTask({ bookId: BOOK, activityId: "a1", title: "t", kind: "write", chapter: 1, scene: null, status: "done", startedAt: T0, endedAt: T0 });
    expect((await mine!.totals(BOOK)).tasks).toBe(1);
    await services.outbox.put({ bookId: BOOK, taskId: "a1", target: "github", attempts: 0, nextAt: 0, error: null, scope: ME });
    expect((await store!.bind(ME).outbox.list({ bookId: BOOK })).map((entry) => entry.taskId), "the outbox is the store's, so a reload resumes it").toEqual(["a1"]);
    expect(services.deleteRecords).toBeTypeOf("function");
  });

  it("hands the copies a store that acts for the account the page is in when they ask, and a page that changes account is not written into", async () => {
    await ensureCallsHost();
    const first = copyServices().store()!;
    await first.saveTask({ bookId: BOOK, activityId: "a1", title: "t", kind: "write", chapter: 1, scene: null, status: "done", startedAt: T0, endedAt: T0 });
    useSettingsStore.setState({ accountIdentity: "workspace:host-b" });
    const second = copyServices().store()!;
    expect((await second.listTasks(BOOK, { limit: 5 })).tasks, "the other account has nothing").toEqual([]);
    await first.saveTask({ bookId: BOOK, activityId: "a2", title: "t", kind: "write", chapter: 1, scene: null, status: "done", startedAt: T0, endedAt: T0 });
    useSettingsStore.setState({ accountIdentity: ME });
    expect((await copyServices().store()!.listTasks(BOOK, { limit: 5 })).tasks.map((task) => task.activityId), "what the first one wrote after the change was dropped").toEqual(["a1"]);
  });

  it("resolves with null and rejects at nothing where this browser keeps no store, and tries again when it can", async () => {
    vi.spyOn(indexedDB, "open").mockImplementation(() => { throw new DOMException("A private window.", "SecurityError"); });
    expect(await ensureCallsHost()).toBeNull();
    expect(copyServices().store()).toBeNull();
    vi.restoreAllMocks();
    resetAiCallStoreForTests();
    expect(await ensureCallsHost(), "the next ask finds the store").not.toBeNull();
    expect(copyServices().store()).not.toBeNull();
  });
});

describe("the copy of a finished task, from the browser's own session", () => {
  it("starts when the store saves the task as finished, and copies it to the place the book has", async () => {
    settingsOf([book({ aiCallsCopy: "github" })]);
    const place = placeToCopyTo();
    await ensureCallsHost();
    configureCopyServices({ openTarget: async () => place.target, ledger: new MemoryCopyLedger(), scope: () => ME, online: () => true });
    const { calls } = wireBrowserCalls({ bookId: BOOK });
    await calls!.saveTask({ bookId: BOOK, activityId: "a1", title: "Step", kind: "write", chapter: 1, scene: 1, status: "running", startedAt: T0, endedAt: null });
    await calls!.begin(begin("a1-0001", "a1"));
    await calls!.append("a1-0001", 1, 0, "the answer");
    await calls!.end("a1-0001", finalOf());
    expect(place.written, "a task that is running is not copied").toHaveLength(0);
    await calls!.saveTask({ bookId: BOOK, activityId: "a1", title: "Step", kind: "write", chapter: 1, scene: 1, status: "done", startedAt: T0, endedAt: T0 });
    await place.until(1);
    expect(place.written.map((file) => file.taskId)).toEqual(["a1"]);
    const status = await callsCopier().status(BOOK, "github");
    expect(status).toMatchObject({ waiting: 0, copiedTasks: 1 });
  });

  it("starts the copies of a book that has a place even when the settings that say so arrive after the host was ready: what was never copied goes", async () => {
    settingsOf([book()]);
    const place = placeToCopyTo();
    await ensureCallsHost();
    configureCopyServices({ openTarget: async () => place.target, ledger: new MemoryCopyLedger(), scope: () => ME, online: () => true });
    await callsStoreFacade(ME).saveTask({ bookId: BOOK, activityId: "early", title: "Step", kind: "write", chapter: 1, scene: 1, status: "done", startedAt: T0, endedAt: T0 });
    await copyServices().store()!.totals(BOOK);
    expect(place.written, "no place yet: nothing goes").toHaveLength(0);
    settingsOf([book({ aiCallsCopy: "github" })]);
    await ensureCallsHost();
    await place.until(1);
    expect(place.written.map((file) => file.taskId)).toEqual(["early"]);
  });

  it("queues nothing for a book that has no place to copy to", async () => {
    settingsOf([book()]);
    const place = placeToCopyTo();
    await ensureCallsHost();
    configureCopyServices({ openTarget: async () => place.target, ledger: new MemoryCopyLedger(), scope: () => ME });
    const calls = callsStoreFacade(ME);
    await calls.saveTask({ bookId: BOOK, activityId: "a1", title: "Step", kind: "write", chapter: 1, scene: 1, status: "done", startedAt: T0, endedAt: T0 });
    await copyServices().store()!.totals(BOOK);
    expect(await copyServices().outbox.list(BOOK)).toEqual([]);
    expect(place.written).toHaveLength(0);
  });

  it("does not copy what a page of another account finished, and does not for a task the budget dropped", async () => {
    settingsOf([book({ aiCallsCopy: "github" })]);
    const place = placeToCopyTo();
    await ensureCallsHost();
    configureCopyServices({ openTarget: async () => place.target, ledger: new MemoryCopyLedger(), scope: () => ME });
    const stale = callsStoreFacade(ME);
    useSettingsStore.setState({ accountIdentity: "workspace:host-b" });
    await stale.saveTask({ bookId: BOOK, activityId: "late", title: "Step", kind: "write", chapter: 1, scene: 1, status: "done", startedAt: T0, endedAt: T0 });
    useSettingsStore.setState({ accountIdentity: ME });
    expect(await copyServices().outbox.list(BOOK)).toEqual([]);
    expect(place.written).toHaveLength(0);
  });
});

describe("the copy of a personal server's records", () => {
  it("brings the finished tasks of the server here, and the copies take them on to the place the book has", async () => {
    settingsOf([book({ aiCallsCopy: "github", autopilotHost: "server" })]);
    const place = placeToCopyTo();
    const server = new FakeServer();
    await server.addTask("activity_a", day(1));
    await server.addTask("activity_b", day(2));
    await ensureCallsHost();
    configureCopyServices({ openTarget: async () => place.target, ledger: new MemoryCopyLedger(), scope: () => ME });
    const report = await copyServerCalls(BOOK, server, "open");
    expect(report).toMatchObject({ state: "done", copied: 2 });
    const store = (await getAiCallStore())!.bind(ME);
    expect((await store.listTasks(BOOK, { limit: 10 })).tasks.map((task) => task.activityId)).toEqual(["activity_b", "activity_a"]);
    await place.until(2);
    expect(place.written.map((file) => file.taskId).sort()).toEqual(["activity_a", "activity_b"]);
    await server.addTask("activity_c", day(3));
    expect(await copyServerCalls(BOOK, server, "run-ended")).toMatchObject({ state: "done", copied: 1 });
    await place.until(3);
  });

  it("does nothing for a book whose recording is turned off on this device", async () => {
    const server = new FakeServer();
    await server.addTask("activity_a", day(1));
    setRecording(BOOK, false);
    expect(await copyServerCalls(BOOK, server)).toBeNull();
    expect(server.counts).toEqual({ list: 0, task: 0, text: 0 });
    expect(callsStoreFacade(ME)).toBeDefined();
    expect((await (await getAiCallStore())?.bind(ME).listTasks(BOOK, { limit: 5 }))?.tasks ?? []).toEqual([]);
  });

  it("resolves with null where this browser keeps no store", async () => {
    vi.spyOn(indexedDB, "open").mockImplementation(() => { throw new DOMException("A private window.", "SecurityError"); });
    expect(await copyServerCalls(BOOK, new FakeServer())).toBeNull();
  });

  it("copies for the account the page is in when it is asked: another account has its own copy", async () => {
    const server = new FakeServer();
    await server.addTask("activity_a", day(1));
    expect(await copyServerCalls(BOOK, server)).toMatchObject({ state: "done", copied: 1 });
    useSettingsStore.setState({ accountIdentity: "workspace:host-b" });
    const store = (await getAiCallStore())!;
    expect((await store.listTasks(BOOK, { limit: 5 })).tasks).toEqual([]);
    expect(await copyServerCalls(BOOK, server)).toMatchObject({ state: "done", copied: 1 });
    expect((await store.listTasks(BOOK, { limit: 5 })).tasks).toHaveLength(1);
  });
});

describe("the deletion of the records of a book", () => {
  const seed = async () => {
    const store = (await getAiCallStore())!.bind(ME);
    await store.saveTask({ bookId: BOOK, activityId: "a1", title: "t", kind: "write", chapter: 1, scene: null, status: "done", startedAt: T0, endedAt: T0 });
    await store.begin(begin("a1-0001", "a1"));
    return store;
  };

  it("deletes on this device for a book of this browser, and asks the server nothing", async () => {
    const store = await seed();
    await deleteBookRecords(BOOK, "browser");
    expect((await store.listTasks(BOOK, { limit: 5 })).tasks).toEqual([]);
    expect(identity.client.deleteCalls).not.toHaveBeenCalled();
  });

  it("deletes on the server and on this device for a book that runs there, the server first", async () => {
    const store = await seed();
    const order: string[] = [];
    identity.client.deleteCalls = vi.fn(async () => { order.push("server"); expect((await store.listTasks(BOOK, { limit: 5 })).tasks, "this device is still whole while the server deletes").toHaveLength(1); });
    await deleteBookRecords(BOOK, "server");
    order.push("done");
    expect(order).toEqual(["server", "done"]);
    expect((await store.listTasks(BOOK, { limit: 5 })).tasks).toEqual([]);
  });

  it("leaves both as they are when the server cannot delete, and says why", async () => {
    const store = await seed();
    identity.client.deleteCalls = vi.fn(async () => { throw new ServerRequestError("The server is down.", 503, "maintenance"); });
    await expect(deleteBookRecords(BOOK, "server")).rejects.toMatchObject({ status: 503 });
    expect((await store.listTasks(BOOK, { limit: 5 })).tasks).toHaveLength(1);
  });

  it("takes a server that does not keep the records, or does not know the book, for one with nothing to delete there", async () => {
    for (const status of [501, 404]) {
      const store = await seed();
      identity.client.deleteCalls = vi.fn(async () => { throw new ServerRequestError("none", status, "feature_unavailable"); });
      await deleteBookRecords(BOOK, "server");
      expect((await store.listTasks(BOOK, { limit: 5 })).tasks, String(status)).toEqual([]);
    }
  });

  it("is what the copies call for «Delete the records»: configured by the host", async () => {
    const store = await seed();
    await ensureCallsHost();
    await copyServices().deleteRecords!(BOOK, "browser");
    expect((await store.listTasks(BOOK, { limit: 5 })).tasks).toEqual([]);
  });
});
