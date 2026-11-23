import "fake-indexeddb/auto";
import { IDBFactory, IDBKeyRange } from "fake-indexeddb";
import { describe, expect, it, vi } from "vitest";
import { ServerCallsCopier, type ServerCallsCopierOptions } from "@/autopilot/calls/copier";
import { IndexedDbAiCallStore } from "@/autopilot/calls/store";
import { BOOK, FakeServer, IDENTITY, day, keyOf, recordOf } from "./helpers/fakeServerCalls";

// The copier of the server's records, against a fake `ServerCallsApi`: a memory store plays the server, and the API cuts what it reads into small pieces, as a server that
// limits what one answer carries does.

/** The browser: a database of its own, and the account the page is in. */
function browser(more: Partial<ServerCallsCopierOptions> = {}, budgets: { perBookBytes?: number; perDeviceBytes?: number } = {}) {
  const factory = new IDBFactory();
  const account = { value: IDENTITY };
  const open = () => IndexedDbAiCallStore.open({ factory, keyRange: IDBKeyRange, scope: () => account.value, storage: null, budgets });
  return { factory, account, open, copier: async (server: FakeServer, store?: IndexedDbAiCallStore) => new ServerCallsCopier({ store: store ?? await open(), api: server, identity: IDENTITY, currentIdentity: () => account.value, pageSize: 2, yieldToUi: async () => undefined, ...more }) };
}

async function same(local: IndexedDbAiCallStore, server: FakeServer, activityId: string): Promise<void> {
  const [mine, theirs] = [await local.readTask(BOOK, activityId), await server.store.readTask(BOOK, activityId)];
  expect(mine, activityId).not.toBeNull();
  expect(mine?.header, activityId).toEqual({ ...theirs!.header, pinned: false });
  expect(mine?.calls, activityId).toEqual(theirs!.calls);
  for (const call of theirs!.calls) {
    for (const field of ["system", "user"] as const) expect((await local.readText(BOOK, call.callId, field, 0))?.text, `${call.callId} ${field}`).toBe((await server.store.readText(BOOK, call.callId, field, 0))?.text);
    for (const attempt of [1, 2]) expect((await local.readText(BOOK, call.callId, "response", 0, attempt))?.text, `${call.callId} response ${attempt}`).toBe((await server.store.readText(BOOK, call.callId, "response", 0, attempt))?.text);
  }
}

describe("the copy of a server's records", () => {
  it("copies the finished tasks with their calls and texts exactly as the server has them, however small the pieces it reads", async () => {
    const server = new FakeServer();
    await server.addTask("activity_a", day(1), { calls: [{ system: "Sei lo scrittore. è già ", user: "Scrivi 你好 😀 — ora", responses: { 1: "Il gabbiano è già volato via — 𝄞 fine." } }, { system: "second", user: "", responses: { 1: "first try", 2: "Il gabbiano è già volato — second try" } }] });
    await server.addTask("activity_b", day(2));
    const { open, copier } = browser();
    const local = await open();
    const report = await (await copier(server, local)).catchUp(BOOK);
    expect(report).toMatchObject({ state: "done", copied: 2, skipped: 0, marker: `${day(2)}|activity_b` });
    await same(local, server, "activity_a");
    await same(local, server, "activity_b");
    expect((await local.readTask(BOOK, "activity_a"))?.calls[1].attempts).toHaveLength(2);
    expect((await local.readTask(BOOK, "activity_a"))?.calls[0].host, "a copy says where the call ran").toBe("server");
    expect(await local.totals(BOOK)).toEqual(await server.store.totals(BOOK));
    expect(await local.audit(BOOK)).toMatchObject({ bytes: (await server.store.totals(BOOK)).bytes, tasks: 2, calls: 3 });
    expect(server.counts.text, "the texts came in pieces").toBeGreaterThan(10);
  });

  it("copies only finished tasks, and a task that runs is copied when it has finished, whether it is the newest or the oldest", async () => {
    const server = new FakeServer();
    await server.addTask("activity_old_running", day(1), { status: "running", calls: [{ system: "s", user: "u", responses: { 1: "so far" } }] });
    await server.addTask("activity_done", day(2));
    await server.addTask("activity_new_running", day(3), { status: "running", calls: [{ system: "s", user: "u", responses: { 1: "so far" } }] });
    const { open, copier } = browser();
    const local = await open();
    const run = await copier(server, local);
    const first = await run.catchUp(BOOK, "open");
    expect(first).toMatchObject({ state: "done", copied: 1 });
    expect(first.marker, "a finished task above the oldest that still runs settles nothing").toBeNull();
    expect(await local.readTask(BOOK, "activity_old_running")).toBeNull();
    expect(await local.readTask(BOOK, "activity_new_running")).toBeNull();
    await same(local, server, "activity_done");

    await server.finish("activity_old_running", day(1), 1);
    const second = await run.catchUp(BOOK, "run-ended");
    expect(second).toMatchObject({ state: "done", copied: 1, skipped: 1, marker: `${day(2)}|activity_done` });
    await same(local, server, "activity_old_running");
    expect(await local.readTask(BOOK, "activity_new_running"), "the one that still runs is not copied").toBeNull();

    await server.finish("activity_new_running", day(3), 1);
    const third = await run.catchUp(BOOK, "run-ended");
    expect(third).toMatchObject({ state: "done", copied: 1, marker: `${day(3)}|activity_new_running` });
    await same(local, server, "activity_new_running");
  });

  it("is incremental: a pass reads only what is new, and stops listing at what it has settled", async () => {
    const server = new FakeServer();
    for (let n = 1; n <= 5; n += 1) await server.addTask(`activity_${n}`, day(n));
    const { open, copier } = browser();
    const local = await open();
    const run = await copier(server, local);
    await run.catchUp(BOOK);
    expect(server.counts.task).toBe(5);
    Object.assign(server.counts, { list: 0, task: 0, text: 0 });
    expect(await run.catchUp(BOOK)).toMatchObject({ state: "done", copied: 0 });
    expect(server.counts, "nothing new: one page of the list, no task, no text").toEqual({ list: 1, task: 0, text: 0 });
    await server.addTask("activity_6", day(6));
    await server.addTask("activity_7", day(7));
    expect(await run.catchUp(BOOK)).toMatchObject({ state: "done", copied: 2, marker: `${day(7)}|activity_7` });
    expect(server.counts.task, "only the two new tasks were read").toBe(2);
    expect((await local.listTasks(BOOK, { limit: 50 })).tasks).toHaveLength(7);
  });

  it("goes on after a failure and after a reload: what was copied is not read again, and a copy that was cut is done again from its start", async () => {
    const server = new FakeServer();
    for (let n = 1; n <= 3; n += 1) await server.addTask(`activity_${n}`, day(n), { calls: [{ system: "sys ".repeat(30), user: "usr", responses: { 1: "Il gabbiano è già volato via. ".repeat(6) } }] });
    const { factory, account, open, copier } = browser();
    const first = await open();
    // The server fails in the middle of the response of the second task that is copied (the newest first: activity_3, then activity_2): its call has begun, its task has no header.
    server.onText = (_count, read) => {
      if (read.callId.startsWith("activity_2") && read.field === "response" && read.from > 0) throw new Error("The server went away.");
    };
    const failed = await (await copier(server, first)).catchUp(BOOK);
    expect(failed.state).toBe("failed");
    expect(failed.error).toMatch(/went away/);
    expect(failed.marker, "nothing is settled by a pass that failed").toBeNull();
    expect((await first.readTask(BOOK, "activity_3"))?.header.status).toBe("done");
    expect((await first.readTask(BOOK, "activity_2"))?.header.status, "a copy that was cut has no header yet: it still says running").toBe("running");

    // The page is reloaded: a new store on the same database, a new copier, the server back.
    first.close();
    server.onText = null;
    Object.assign(server.counts, { list: 0, task: 0, text: 0 });
    const second = await IndexedDbAiCallStore.open({ factory, keyRange: IDBKeyRange, scope: () => account.value, storage: null });
    const done = await (await copier(server, second)).catchUp(BOOK);
    expect(done).toMatchObject({ state: "done", copied: 2, skipped: 1, marker: `${day(3)}|activity_3` });
    expect(server.counts.task, "the task that was copied is not read again").toBe(2);
    for (const id of ["activity_1", "activity_2", "activity_3"]) await same(second, server, id);
    expect(await second.totals(BOOK)).toEqual(await server.store.totals(BOOK));
    expect(await second.audit(BOOK)).toMatchObject({ bytes: (await server.store.totals(BOOK)).bytes });
  });

  it("stays within the budget of the device: the newest tasks come first, it stops where the retention drops what it copied, and it never copies what the budget could not hold", async () => {
    const server = new FakeServer();
    for (let n = 1; n <= 5; n += 1) await server.addTask(`activity_${n}`, day(n), { calls: [{ system: "x".repeat(400), user: "", responses: {} }] });
    await server.addTask("activity_huge", day(6), { calls: [{ system: "y".repeat(2000), user: "", responses: {} }] });
    const { open, copier } = browser({}, { perBookBytes: 1000, perDeviceBytes: 100_000 });
    const local = await open();
    const run = await copier(server, local);
    const report = await run.catchUp(BOOK);
    expect(report.state).toBe("done");
    const kept = (await local.listTasks(BOOK, { limit: 50 })).tasks.map((task) => task.activityId);
    expect(kept, "the newest two that fit, and the huge one is not here").toEqual(["activity_5", "activity_4"]);
    expect((await local.totals(BOOK)).bytes).toBeLessThanOrEqual(1000);
    expect(report.skipped, "the huge one").toBe(1);
    expect(report.marker).toBe(`${day(6)}|activity_huge`);
    Object.assign(server.counts, { task: 0 });
    expect(await run.catchUp(BOOK)).toMatchObject({ state: "done", copied: 0 });
    expect(server.counts.task, "what the budget did not keep is not copied again").toBe(0);
  });

  it("never drops a task that was pinned here to make room for a copy", async () => {
    const server = new FakeServer();
    await server.addTask("activity_old", day(1), { calls: [{ system: "o".repeat(500), user: "", responses: {} }] });
    await server.addTask("activity_new", day(5), { calls: [{ system: "n".repeat(400), user: "", responses: {} }] });
    const { open, copier } = browser({}, { perBookBytes: 900, perDeviceBytes: 100_000 });
    const local = await open();
    await local.saveTask({ bookId: BOOK, activityId: "activity_mine", title: "mine", kind: "write", chapter: 1, scene: null, status: "done", startedAt: day(0), endedAt: day(0) });
    await local.begin({ record: recordOf("activity_mine-0001", "activity_mine", 1, BOOK, day(0)), system: "m".repeat(300), user: "" });
    await local.keep(BOOK, "activity_mine", true);
    await (await copier(server, local)).catchUp(BOOK);
    const kept = (await local.listTasks(BOOK, { limit: 50 })).tasks.map((task) => task.activityId);
    expect(kept).toContain("activity_mine");
    expect(kept).toContain("activity_new");
    expect(kept, "the old one did not fit beside the pin (300) and the new one (400): 1200 is over 900").not.toContain("activity_old");
  });

  it("gives the page its turn between the tasks, the calls and the pages of the list", async () => {
    const server = new FakeServer();
    for (let n = 1; n <= 4; n += 1) await server.addTask(`activity_${n}`, day(n), { calls: [{ system: "a", user: "b", responses: { 1: "c" } }, { system: "d", user: "e", responses: { 1: "f" } }] });
    const turns = vi.fn(async () => undefined);
    const { open, copier } = browser({ yieldToUi: turns });
    await (await copier(server, await open())).catchUp(BOOK);
    // Four tasks of two calls each, and a list of two pages of two.
    expect(turns.mock.calls.length).toBeGreaterThanOrEqual(4 * 2 + 4 + 1);
  });

  it("is told by the server, before anything is read, that the records are not there: unsupported, and nothing is asked", async () => {
    const server = new FakeServer();
    server.supported = false;
    const { open, copier } = browser();
    expect(await (await copier(server, await open())).catchUp(BOOK)).toMatchObject({ state: "unsupported", copied: 0 });
    expect(server.counts).toEqual({ list: 0, task: 0, text: 0 });
  });

  it("stops when the account changes, copies nothing for the account that came, and leaves what it had written for the one that went", async () => {
    const server = new FakeServer();
    for (let n = 1; n <= 3; n += 1) await server.addTask(`activity_${n}`, day(n));
    const { account, open, copier } = browser();
    const local = await open();
    server.onText = (count) => {
      if (count === 6) account.value = "google:other";
    };
    const report = await (await copier(server, local)).catchUp(BOOK);
    expect(report.state).toBe("fenced");
    expect(report.marker).toBeNull();
    expect((await local.listTasks(BOOK, { limit: 10 })).tasks, "the account that came sees nothing").toEqual([]);
    const readsAtStop = server.counts.text;
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(server.counts.text, "nothing was read after it stopped").toBe(readsAtStop);
    account.value = IDENTITY;
    expect((await local.listTasks(BOOK, { limit: 10 })).tasks.map((task) => task.activityId)).toContain("activity_3");
    // Back in the account it was made for, a pass finishes the work.
    server.onText = null;
    expect(await (await copier(server, local)).catchUp(BOOK)).toMatchObject({ state: "done", marker: `${day(3)}|activity_3` });
    for (const id of ["activity_1", "activity_2", "activity_3"]) await same(local, server, id);
  });

  it("does not start a second pass beside one that is going on: the call that comes is answered by that pass, and what finished meanwhile is copied by one more", async () => {
    const server = new FakeServer();
    await server.addTask("activity_1", day(1));
    const { open, copier } = browser();
    const local = await open();
    const run = await copier(server, local);
    let triggered: Promise<unknown> | null = null;
    server.onList = async () => {
      server.onList = null;
      // A run ends while the pass lists the server: its task is not in the list this pass reads.
      await server.addTask("activity_2", day(2));
      triggered = run.catchUp(BOOK, "run-ended");
    };
    const first = run.catchUp(BOOK, "open");
    const second = run.catchUp(BOOK, "open");
    expect(second, "the same pass").toBe(first);
    const report = await first;
    await triggered;
    expect(report.state).toBe("done");
    await same(local, server, "activity_1");
    await same(local, server, "activity_2");
    expect(server.counts.task, "each task was read once").toBe(2);
  });

  it("tells a failure of the server in its report and does not throw: the next pass starts from what it has", async () => {
    const server = new FakeServer();
    await server.addTask("activity_1", day(1));
    server.failList = new Error("503 Service Unavailable");
    const { open, copier } = browser();
    const run = await copier(server, await open());
    expect(await run.catchUp(BOOK)).toMatchObject({ state: "failed", copied: 0, error: "503 Service Unavailable" });
    server.failList = null;
    expect(await run.catchUp(BOOK)).toMatchObject({ state: "done", copied: 1 });
  });

  it("ends at its next step when it is stopped, and refuses the passes that follow", async () => {
    const server = new FakeServer();
    for (let n = 1; n <= 3; n += 1) await server.addTask(`activity_${n}`, day(n));
    const { open, copier } = browser();
    const run = await copier(server, await open());
    server.onText = (count) => {
      if (count === 3) run.stop();
    };
    expect((await run.catchUp(BOOK)).state).toBe("stopped");
    expect((await run.catchUp(BOOK)).state).toBe("stopped");
  });

  it("copies the books of the author one after the other", async () => {
    const server = new FakeServer();
    await server.addTask("activity_1", day(1));
    await server.addTask("activity_2", day(2), { bookId: "book-2" });
    const { open, copier } = browser();
    const local = await open();
    const reports = await (await copier(server, local)).catchUpBooks([BOOK, "book-2"], "open");
    expect([...reports.entries()].map(([book, report]) => [book, report.state, report.copied])).toEqual([[BOOK, "done", 1], ["book-2", "done", 1]]);
    expect((await local.listTasks("book-2", { limit: 5 })).tasks.map((task) => keyOf(task))).toEqual([`${day(2)}|activity_2`]);
  });
});
