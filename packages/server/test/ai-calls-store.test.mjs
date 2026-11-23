import test from "node:test";
import assert from "node:assert/strict";
import { gunzipSync } from "node:zlib";
import { lstat, mkdir, mkdtemp, readFile, readdir, rename, rm, stat, symlink, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import * as engine from "narrarium-engine";
import * as testing from "../dist/testing.mjs";
import { BOOK, defineContract, finalOf, headerOf, recordOf, writeCall } from "./ai-calls-contract.mjs";

const { FileAiCallStore, AI_CALLS_DIRECTORY } = testing;
const posix = process.platform !== "win32";

// The AI call records of a personal server (`FileAiCallStore`): what every store does (the shared contract, also run on the engine's reference), and what the files add: where they are and who may
// read them, a server that stopped in the middle of a call, a disk that is full, ids and links that try to leave the folder, texts cut in pieces at the edge of a character, the budget, the
// secrets this server knows, and what the files cost. A test never writes more than a few dozen files: the cost of a thousand of them is the disk's.

async function fileStore(extra = {}) {
  const root = await mkdtemp(path.join(os.tmpdir(), "narrarium-ai-calls-"));
  const directory = (bookId) => {
    if (!/^[A-Za-z0-9._-]{1,120}$/.test(bookId) || bookId === "." || bookId === "..") throw new Error("Invalid book id.");
    return path.join(root, "books", bookId, AI_CALLS_DIRECTORY);
  };
  const options = { directory, minFreeDiskBytes: 0, ...extra };
  const stores = [];
  const open = () => {
    const store = new FileAiCallStore(options);
    stores.push(store);
    return store;
  };
  const store = open();
  return {
    store,
    root,
    directory,
    open,
    dir: directory(BOOK),
    cleanup: async () => {
      for (const each of stores) await each.close();
      await rm(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
    },
  };
}

const names = async (directory) => (await readdir(directory).catch(() => [])).sort();
const walk = async (directory) => {
  const found = [];
  for (const entry of await readdir(directory, { withFileTypes: true }).catch(() => [])) {
    const full = path.join(directory, entry.name);
    if (entry.isDirectory()) found.push(...(await walk(full)));
    else found.push(full);
  }
  return found.sort();
};

// ---- the contract, on the reference and on the files

defineContract("ai calls (memory, the reference)", async () => ({ store: new engine.MemoryAiCallStore() }));
defineContract("ai calls (files)", async () => {
  const made = await fileStore({ maxCallsPerTask: 4 });
  return { store: made.store, cleanup: made.cleanup, maxCallsPerTask: 4 };
});

test("ai calls (files): the default is the engine's: 64 calls to a task, 2 GiB to a book, 1 GiB of free disk kept", async () => {
  assert.equal(engine.AI_CALL_LIMITS.maxCallsPerTask, 64);
  assert.equal(engine.AI_CALL_BUDGETS.serverPerBookBytes, 2048 * 1024 * 1024);
  assert.equal(engine.AI_CALL_BUDGETS.minFreeDiskBytes, 1024 * 1024 * 1024);
  const made = await fileStore({ maxCallsPerTask: undefined });
  try {
    for (let seq = 1; seq <= 65; seq += 1) await made.store.begin({ record: recordOf(engine.aiCallIdOf("activity_cap", seq), "activity_cap", seq), system: "s", user: "" });
    assert.equal((await made.store.readTask(BOOK, "activity_cap")).calls.length, 64);
  } finally {
    await made.cleanup();
  }
});

// ---- the files

test("ai calls (files): a call leaves its task, three gzipped texts and the totals; nothing is left in live/, nothing is writable by others, and the folder is where the book's records go", async () => {
  const made = await fileStore();
  try {
    const { store, dir } = made;
    const callId = await writeCall(store, "activity_a", 1, { system: "S".repeat(2000), user: "U".repeat(2000), pieces: ["first ", "second "] });
    await store.saveTask(headerOf("activity_a", "2026-11-20T10:00:00.000Z"));
    await store.close();
    assert.equal(AI_CALLS_DIRECTORY, "ai-calls");
    assert.equal(dir, path.join(made.root, "books", BOOK, "ai-calls"));
    assert.deepEqual(await names(dir), ["live", "tasks", "texts", "totals.json"]);
    assert.deepEqual(await walk(path.join(dir, "tasks")), [path.join(dir, "tasks", "2026", "11", "20", "activity_a.json")]);
    assert.deepEqual(await names(path.join(dir, "texts")), [`${callId}.0.system.txt.gz`, `${callId}.0.user.txt.gz`, `${callId}.1.response.txt.gz`]);
    assert.deepEqual(await names(path.join(dir, "live")), [], "a call that ended has nothing left in live/");
    const gz = await readFile(path.join(dir, "texts", `${callId}.1.response.txt.gz`));
    assert.deepEqual([gz[0], gz[1]], [0x1f, 0x8b], "gzip");
    assert.equal(gunzipSync(gz).toString("utf8"), "first second ");
    assert.ok((await stat(path.join(dir, "texts", `${callId}.0.system.txt.gz`))).size < 200, "two thousand letters in a few dozen bytes");
    const totals = JSON.parse(await readFile(path.join(dir, "totals.json"), "utf8"));
    assert.deepEqual({ ...totals, updatedAt: undefined }, { version: 1, bytes: 2000 + 2000 + 13, tasks: 1, calls: 1, pinnedTasks: 0, pinnedBytes: 0, updatedAt: undefined });
    const task = JSON.parse(await readFile(path.join(dir, "tasks", "2026", "11", "20", "activity_a.json"), "utf8"));
    assert.equal(task.calls[0].callId, callId);
    assert.deepEqual(task.sizes[callId], { system: 2000, user: 2000, responses: { 1: 13 } });
    if (posix) {
      for (const folder of [dir, ...(await walk(dir)).map((file) => path.dirname(file))]) assert.equal((await lstat(folder)).mode & 0o777, 0o700, `${path.relative(made.root, folder)} is private`);
      for (const file of await walk(dir)) assert.equal((await lstat(file)).mode & 0o777, 0o600, `${path.relative(made.root, file)} is private`);
    }
  } finally {
    await made.cleanup();
  }
});

test("ai calls (files): while a call streams its text is in live/ as the bytes at their offsets, and it is read from there", async () => {
  const made = await fileStore();
  try {
    const { store, dir } = made;
    const callId = engine.aiCallIdOf("activity_l", 1);
    await store.begin({ record: recordOf(callId, "activity_l", 1), system: "s", user: "u" });
    await store.append(callId, 1, 0, "The harbor ");
    await store.append(callId, 1, 15, "later");
    assert.deepEqual(await names(path.join(dir, "live")), [`${callId}.1.response.txt`]);
    const bytes = await readFile(path.join(dir, "live", `${callId}.1.response.txt`));
    assert.equal(bytes.length, 20);
    assert.equal(bytes.subarray(0, 11).toString(), "The harbor ");
    assert.deepEqual([...bytes.subarray(11, 15)], [0, 0, 0, 0], "what has not come yet is empty");
    assert.equal((await store.readText(BOOK, callId, "response", 0)).size, 20);
    await store.append(callId, 1, 11, "woke");
    assert.equal((await store.readText(BOOK, callId, "response", 0)).text, "The harbor wokelater");
    await store.end(callId, finalOf());
    assert.deepEqual(await names(path.join(dir, "live")), []);
    assert.equal((await store.readText(BOOK, callId, "response", 0)).text, "The harbor wokelater");
  } finally {
    await made.cleanup();
  }
});

test("ai calls (files): the folder of a book is outside its working copy, and git never sees a record", async () => {
  const made = await fileStore();
  try {
    await writeCall(made.store, "activity_g", 1, { pieces: ["x"] });
    const repo = path.join(made.root, "books", BOOK, "repo");
    assert.equal(made.dir.startsWith(repo + path.sep), false);
    assert.equal(path.dirname(made.dir), path.dirname(repo), "beside it");
  } finally {
    await made.cleanup();
  }
});

// ---- a server that stopped

test("ai calls (files): a server that stopped in the middle of a call leaves its text readable and partial, the call interrupted and its task stopped, and settles it once", async () => {
  const made = await fileStore({ now: () => new Date("2026-11-21T08:00:00.000Z") });
  try {
    const { store, dir } = made;
    await store.saveTask(headerOf("activity_c", "2026-11-20T10:00:00.000Z", { title: "Write chapter 3", status: "running", endedAt: null }));
    await writeCall(store, "activity_c", 1, { pieces: ["done before"], status: "ok" });
    const callId = engine.aiCallIdOf("activity_c", 2);
    await store.begin({ record: recordOf(callId, "activity_c", 2, { label: "Second" }), system: "sys2", user: "usr2" });
    await store.append(callId, 1, 0, "Half an ans");
    await store.append(callId, 1, 11, "wér…");
    // The process ends here: nothing is finished, nothing is told.
    const after = made.open();
    const task = await after.readTask(BOOK, "activity_c");
    assert.equal(task.header.status, "stopped");
    assert.equal(task.header.title, "Write chapter 3", "what the header said is kept");
    assert.equal(task.header.endedAt === null, false, "and it says when it stopped, as well as it can");
    const [done, cut] = task.calls;
    assert.equal(done.status, "ok", "a call that ended before is as it was");
    assert.equal(cut.status, "interrupted");
    assert.equal(cut.response.partial, true);
    assert.deepEqual(cut.response.text, { characters: 15, bytes: 18, storedBytes: 18, truncated: false });
    assert.equal(cut.storedBytes, 4 + 4 + 18);
    assert.equal(cut.timing.endedAt === null, false);
    const text = await after.readText(BOOK, callId, "response", 0);
    assert.deepEqual([text.text, text.complete, text.size], ["Half an answér…", true, 18]);
    assert.deepEqual(await names(path.join(dir, "live")), [], "folded into texts/");
    assert.ok((await names(path.join(dir, "texts"))).includes(`${callId}.1.response.txt.gz`));
    assert.deepEqual(await after.totals(BOOK), { bytes: 3 + 3 + 11 + 4 + 4 + 18, tasks: 1, calls: 2, pinnedTasks: 0, pinnedBytes: 0 });
    // Once: another start finds it as it was left, and the task can be pruned now (it is not running).
    const third = made.open();
    assert.equal((await third.readTask(BOOK, "activity_c")).header.status, "stopped");
    assert.deepEqual((await third.prune(BOOK, 0)).dropped, ["activity_c"]);
    // The book goes on: a new run records new calls.
    await writeCall(third, "activity_d", 1, { pieces: ["fresh"], startedAt: "2026-11-22T10:00:00.000Z" });
    assert.equal((await third.readTask(BOOK, "activity_d")).calls[0].status, "ok");
  } finally {
    await made.cleanup();
  }
});

test("ai calls (files): a task whose header never arrived is stopped by the next start (it would run forever, and could never be pruned), titled by its first call", async () => {
  const made = await fileStore();
  try {
    await writeCall(made.store, "activity_h", 1, { pieces: ["x"], status: "ok" });
    const after = made.open();
    const task = await after.readTask(BOOK, "activity_h");
    assert.deepEqual([task.header.status, task.header.title, task.header.kind], ["stopped", "Write", "write"]);
    assert.deepEqual((await after.prune(BOOK, 0)).dropped, ["activity_h"]);
  } finally {
    await made.cleanup();
  }
});

test("ai calls (files): a response that was not packed yet (a stop between the end and the fold) is packed at the next start, and what no task owns is removed", async () => {
  const made = await fileStore();
  try {
    const { store, dir } = made;
    const callId = await writeCall(store, "activity_f", 1, { pieces: ["packed"] });
    await store.saveTask(headerOf("activity_f", "2026-11-20T10:00:00.000Z"));
    // The state a stop between the end and the fold leaves: the call ended, its response is in live/ (and the old gzip too).
    await writeFile(path.join(dir, "live", `${callId}.1.response.txt`), "packed and a little more");
    await writeFile(path.join(dir, "live", "activity_ghost-0001.1.response.txt"), "nobody's");
    await writeFile(path.join(dir, "texts", "activity_ghost-0001.0.system.txt.gz"), "nobody's");
    await writeFile(path.join(dir, "texts", `${callId}.0.user.txt.gz.new-1234abcd`), "a temporary file");
    const after = made.open();
    assert.equal((await after.readText(BOOK, callId, "response", 0)).text, "packed and a little more");
    assert.deepEqual(await names(path.join(dir, "live")), []);
    assert.deepEqual(await names(path.join(dir, "texts")), [`${callId}.0.system.txt.gz`, `${callId}.0.user.txt.gz`, `${callId}.1.response.txt.gz`]);
    assert.equal(gunzipSync(await readFile(path.join(dir, "texts", `${callId}.1.response.txt.gz`))).toString(), "packed and a little more");
    assert.equal((await after.totals(BOOK)).bytes, 3 + 3 + 24);
  } finally {
    await made.cleanup();
  }
});

test("ai calls (files): the same writes again after a restart change nothing", async () => {
  const made = await fileStore();
  try {
    const { store } = made;
    const callId = await writeCall(store, "activity_r", 1, { pieces: ["héllo ", "wörld"] });
    await store.saveTask(headerOf("activity_r", "2026-11-20T10:00:00.000Z"));
    const before = await store.totals(BOOK);
    const after = made.open();
    await after.begin({ record: recordOf(callId, "activity_r", 1), system: "other", user: "other" });
    await after.append(callId, 1, 0, "héllo ");
    await after.append(callId, 1, 7, "wörld");
    await after.end(callId, finalOf());
    await after.saveTask(headerOf("activity_r", "2026-11-20T10:00:00.000Z"));
    assert.deepEqual(await after.totals(BOOK), before);
    assert.equal((await after.readText(BOOK, callId, "response", 0)).text, "héllo wörld");
    assert.equal((await after.readText(BOOK, callId, "system", 0)).text, "sys", "the first begin is the one kept");
  } finally {
    await made.cleanup();
  }
});

test("ai calls (files): a task file that is damaged is left alone, the others are read, and nothing is swept while a file could not be understood", async () => {
  const lines = [];
  const made = await fileStore({ log: (line) => lines.push(line) });
  try {
    const { store, dir } = made;
    const good = await writeCall(store, "activity_ok", 1, { pieces: ["good"] });
    await store.saveTask(headerOf("activity_ok", "2026-11-20T10:00:00.000Z"));
    const bad = await writeCall(store, "activity_bad", 1, { pieces: ["bad"], startedAt: "2026-11-20T11:00:00.000Z" });
    await store.saveTask(headerOf("activity_bad", "2026-11-20T11:00:00.000Z"));
    await writeFile(path.join(dir, "tasks", "2026", "11", "20", "activity_bad.json"), "{ not json");
    await writeFile(path.join(dir, "tasks", "2026", "11", "20", "not-a-task.txt"), "ignored");
    const after = made.open();
    assert.deepEqual((await after.listTasks(BOOK, { limit: 10 })).tasks.map((task) => task.activityId), ["activity_ok"]);
    assert.equal((await after.readText(BOOK, good, "response", 0)).text, "good");
    assert.equal((await after.readText(BOOK, bad, "response", 0)), null, "a call whose task cannot be read is not kept");
    assert.ok((await names(path.join(dir, "texts"))).includes(`${bad}.1.response.txt.gz`), "its texts are not swept: a file that could not be understood is no reason to delete");
    assert.ok(lines.some((line) => /activity_bad\.json/.test(line)), "and the server says so");
    assert.equal(await readFile(path.join(dir, "tasks", "2026", "11", "20", "activity_bad.json"), "utf8"), "{ not json", "it is left as it is");
  } finally {
    await made.cleanup();
  }
});

// ---- a disk that is full

test("ai calls (files): under the free disk it keeps, nothing is written (AiCallDiskFullError), what it has is read, and the books can still be pruned and deleted; it says so once", async () => {
  let free = 5_000;
  const lines = [];
  const made = await fileStore({ minFreeDiskBytes: 1_000, freeDiskBytes: () => free, log: (line) => lines.push(line) });
  try {
    const { store, dir } = made;
    const callId = await writeCall(store, "activity_ok", 1, { pieces: ["kept"], status: null });
    free = 500;
    // The end of a call and the header of a task are a few bytes: they are let through (a call that cannot end would stay open for ever), and a task that ends prunes.
    await store.end(callId, finalOf("ok"));
    await store.saveTask(headerOf("activity_ok", "2026-11-20T10:00:00.000Z"));
    assert.equal((await store.readTask(BOOK, "activity_ok")).calls[0].status, "ok");
    await assert.rejects(store.begin({ record: recordOf("activity_no-0001", "activity_no", 1), system: "s", user: "u" }), (error) => error instanceof testing.AiCallDiskFullError && error.name === "AiCallDiskFullError");
    await assert.rejects(store.append(callId, 1, 4, " more"), testing.AiCallDiskFullError);
    await assert.rejects(store.append(callId, 1, 4, " again"), testing.AiCallDiskFullError);
    assert.equal(lines.filter((line) => /not recorded/.test(line)).length, 1, "said once, not for every refusal");
    assert.match(lines[0], /MiB/);
    assert.equal(await store.readTask(BOOK, "activity_no"), null, "the call that was refused left nothing");
    assert.equal((await store.readText(BOOK, callId, "response", 0)).text, "kept", "what was written stays readable");
    assert.deepEqual((await store.prune(BOOK, 0)).dropped, ["activity_ok"]);
    free = 5_000;
    await store.begin({ record: recordOf("activity_yes-0001", "activity_yes", 1), system: "s", user: "u" });
    assert.ok(await store.readTask(BOOK, "activity_yes"), "room again: it records again");
    free = 10;
    await store.deleteBook(BOOK);
    assert.equal(await lstat(dir).then(() => true, () => false), false, "deleting needs no room");
  } finally {
    await made.cleanup();
  }
});

test("ai calls (files): a book that was never written to is not given a folder by a refused write, a read or a prune", async () => {
  const made = await fileStore({ minFreeDiskBytes: 1_000, freeDiskBytes: () => 0 });
  try {
    await assert.rejects(made.store.begin({ record: recordOf("activity_z-0001", "activity_z", 1), system: "s", user: "u" }), testing.AiCallDiskFullError);
    await made.store.readTask(BOOK, "activity_z");
    await made.store.listTasks(BOOK, { limit: 5 });
    await made.store.prune(BOOK, 10);
    await made.store.totals(BOOK);
    await made.store.close();
    assert.equal(await lstat(path.join(made.root, "books")).then(() => true, () => false), false, "nothing was made");
  } finally {
    await made.cleanup();
  }
});

// ---- ids and links

test("ai calls (files): an id that is not a safe name is refused where it would be one, and is nothing where it is only asked for", async () => {
  const made = await fileStore();
  try {
    const { store } = made;
    const bad = ["../../etc/passwd", "a/b", "a\\b", "/abs", "..", "a b", "a.b", "x".repeat(161), "", "é", "a\u0000b", "..\\..\\x"];
    for (const id of bad) {
      await assert.rejects(store.begin({ record: recordOf(id, "activity_ok", 1), system: "s", user: "u" }), TypeError, `call ${JSON.stringify(id).slice(0, 30)}`);
      await assert.rejects(store.begin({ record: recordOf("activity_ok-0001", id, 1), system: "s", user: "u" }), TypeError, `task ${JSON.stringify(id).slice(0, 30)}`);
      await assert.rejects(store.append(id, 1, 0, "x"), TypeError);
      await assert.rejects(store.end(id, finalOf()), TypeError);
      await assert.rejects(store.saveTask(headerOf(id, "2026-11-20T10:00:00.000Z")), TypeError);
      await assert.rejects(store.keep(BOOK, id, true), TypeError);
      assert.equal(await store.readText(BOOK, id, "system", 0), null);
      assert.equal(await store.readTask(BOOK, id), null);
    }
    assert.equal(await store.readText(BOOK, "activity_ok-0001", "../system", 0), null, "nor is a field that is not one");
    assert.equal(await lstat(path.join(made.root, "books")).then(() => true, () => false), false, "nothing was written for any of them");
    // The book is the host's to name: an id that is not a book's makes no folder, and no folder is made outside the data folder.
    await assert.rejects(store.begin({ record: recordOf("activity_ok-0001", "activity_ok", 1, { bookId: "../evil" }), system: "s", user: "u" }), /Invalid book id/);
    await assert.rejects(store.totals("../evil"), /Invalid book id/);
    assert.deepEqual(await readdir(made.root), [], "nothing at all");
  } finally {
    await made.cleanup();
  }
});

test("ai calls (files): an offset or an attempt that would make a huge or a nonsense file is refused, and a text is never more than its limit", async () => {
  const made = await fileStore();
  try {
    const { store, dir } = made;
    const callId = engine.aiCallIdOf("activity_big", 1);
    await store.begin({ record: recordOf(callId, "activity_big", 1), system: "", user: "" });
    await assert.rejects(store.append(callId, 1, 2 ** 40, "x"), RangeError);
    await assert.rejects(store.append(callId, 1, testing.AI_CALL_FIELD_MAX_BYTES, "x"), RangeError);
    await assert.rejects(store.append(callId, 257, 0, "x"), RangeError);
    await assert.rejects(store.append(callId, Number.NaN, 0, "x"), RangeError);
    await assert.rejects(store.append(callId, 1, Number.POSITIVE_INFINITY, "x"), RangeError);
    assert.deepEqual(await names(path.join(dir, "live")), [], "no file was made for any of them");
    await store.append(callId, 1, testing.AI_CALL_FIELD_MAX_BYTES - 1, "x");
    assert.equal((await store.readText(BOOK, callId, "response", 0, 1, 10)).size, testing.AI_CALL_FIELD_MAX_BYTES);
  } finally {
    await made.cleanup();
  }
});

test("ai calls (files): a link in the place of a folder or a file is never followed", { skip: !posix }, async () => {
  const lines = [];
  const made = await fileStore({ log: (line) => lines.push(line) });
  try {
    const outside = await mkdtemp(path.join(os.tmpdir(), "narrarium-outside-"));
    try {
      // A link where texts/ should be: the first write refuses, and nothing is written through it.
      await mkdir(made.dir, { recursive: true });
      await symlink(outside, path.join(made.dir, "texts"));
      await assert.rejects(made.store.begin({ record: recordOf("activity_ln-0001", "activity_ln", 1), system: "s", user: "u" }), (error) => error instanceof testing.AiCallStoreError && !error.message.includes(made.root), "what is said does not say where");
      assert.ok(lines.some((line) => /not a folder/.test(line) && line.includes("activity_ln") === false), "the log has the cause");
      assert.deepEqual(await readdir(outside), []);
      await rm(path.join(made.dir, "texts"));
      // A link where a live file should be: it is not opened.
      const callId = engine.aiCallIdOf("activity_ln2", 1);
      await made.store.begin({ record: recordOf(callId, "activity_ln2", 1), system: "s", user: "u" });
      await writeFile(path.join(outside, "target.txt"), "outside");
      await symlink(path.join(outside, "target.txt"), path.join(made.dir, "live", `${callId}.1.response.txt`));
      await assert.rejects(made.store.append(callId, 1, 0, "overwrite"));
      assert.equal(await readFile(path.join(outside, "target.txt"), "utf8"), "outside", "the file the link names is untouched");
      assert.equal((await made.store.readText(BOOK, callId, "response", 0)).text, "", "and it is not read");
    } finally {
      await rm(outside, { recursive: true, force: true });
    }
  } finally {
    await made.cleanup();
  }
});

// ---- text in pieces

test("ai calls (files): a text read in pieces is the text, whatever the size of the piece, with every piece cut at the end of a character, while it streams and after", async () => {
  const made = await fileStore();
  try {
    const { store } = made;
    const text = "a é € 😀 日本語 — “quoted”\n".repeat(6);
    const total = Buffer.byteLength(text);
    const callId = engine.aiCallIdOf("activity_pieces", 1);
    await store.begin({ record: recordOf(callId, "activity_pieces", 1), system: text, user: text });
    await store.append(callId, 1, 0, text);
    const follow = async (field, limit) => {
      const pieces = [];
      let from = 0;
      for (let guard = 0; guard < 1000; guard += 1) {
        const piece = await store.readText(BOOK, callId, field, from, field === "response" ? 1 : undefined, limit);
        assert.equal(piece.from, from, `the piece starts where the reader is (limit ${limit})`);
        assert.ok(piece.next > piece.from || piece.next === piece.size, `it moves on (limit ${limit})`);
        assert.equal(piece.text.includes("\ufffd"), false, `no half character (limit ${limit}, from ${from})`);
        assert.ok(Buffer.byteLength(piece.text) <= Math.max(limit, 4), `at most the limit (limit ${limit})`);
        assert.equal(Buffer.byteLength(piece.text), piece.next - piece.from);
        pieces.push(piece.text);
        if (piece.next >= piece.size) break;
        from = piece.next;
      }
      return pieces.join("");
    };
    for (const limit of [1, 2, 3, 4, 5, 7, 16, 64, 1000]) {
      assert.equal(await follow("response", limit), text, `streaming, in pieces of ${limit}`);
      assert.equal(await follow("system", limit), text);
    }
    await store.end(callId, finalOf());
    for (const limit of [1, 3, 5, 64]) {
      assert.equal(await follow("response", limit), text, `ended, in pieces of ${limit}`);
      assert.equal(await follow("user", limit), text);
    }
    // From the middle of a character it starts at the character.
    const emoji = Buffer.from(text).indexOf(Buffer.from("😀"));
    for (const middle of [1, 2, 3]) {
      const piece = await store.readText(BOOK, callId, "response", emoji + middle, 1, 8);
      assert.equal(piece.from, emoji);
      assert.ok(piece.text.startsWith("😀"));
    }
    assert.equal((await store.readText(BOOK, callId, "response", 0, 1, 5)).size, total);
  } finally {
    await made.cleanup();
  }
});

test("ai calls (files): a long response is read in pieces of a quarter of a megabyte and joins back to the very same bytes", async () => {
  const made = await fileStore();
  try {
    const { store } = made;
    const text = "Là, sul molo, il faro 💡 si accese. ".repeat(20_000);
    const callId = engine.aiCallIdOf("activity_long", 1);
    await store.begin({ record: recordOf(callId, "activity_long", 1), system: "", user: "" });
    for (let offset = 0, bytes = 0; offset < text.length; offset += 16_384) {
      const piece = text.slice(offset, offset + 16_384);
      await store.append(callId, 1, bytes, piece);
      bytes += Buffer.byteLength(piece);
    }
    await store.end(callId, finalOf());
    const joined = [];
    let from = 0;
    for (;;) {
      const piece = await store.readText(BOOK, callId, "response", from, 1, 256 * 1024);
      joined.push(piece.text);
      if (piece.next >= piece.size) break;
      from = piece.next;
    }
    assert.ok(joined.length >= 3 && joined.length <= 6, `${joined.length} pieces`);
    assert.equal(joined.join(""), text);
  } finally {
    await made.cleanup();
  }
});

// ---- the totals

test("ai calls (files): the totals of a book nobody has written to since the start come from totals.json, without reading its tasks; a missing or damaged file is rebuilt from the tasks", async () => {
  const made = await fileStore();
  try {
    const { store, dir } = made;
    await writeCall(store, "activity_t", 1, { pieces: ["0123456789"] });
    await store.saveTask(headerOf("activity_t", "2026-11-20T10:00:00.000Z"));
    await store.keep(BOOK, "activity_t", true);
    await store.close();
    const expected = { bytes: 3 + 3 + 10, tasks: 1, calls: 1, pinnedTasks: 1, pinnedBytes: 16 };
    // The tasks are put out of sight: only a file that says the totals can answer.
    await rename(path.join(dir, "tasks"), path.join(dir, "tasks.away"));
    const lazy = made.open();
    assert.deepEqual(await lazy.totals(BOOK), expected, "told from totals.json");
    assert.deepEqual(await lazy.totals(BOOK), expected);
    await rename(path.join(dir, "tasks.away"), path.join(dir, "tasks"));
    for (const damage of [async () => rm(path.join(dir, "totals.json")), async () => writeFile(path.join(dir, "totals.json"), "{ nope"), async () => writeFile(path.join(dir, "totals.json"), JSON.stringify({ version: 1, bytes: -4 }))]) {
      await damage();
      assert.deepEqual(await made.open().totals(BOOK), expected, "rebuilt from the tasks");
    }
    assert.deepEqual(await made.open().totals("nobody"), { bytes: 0, tasks: 0, calls: 0, pinnedTasks: 0, pinnedBytes: 0 });
  } finally {
    await made.cleanup();
  }
});

test("ai calls (files): the totals are written again after a change (not after every append), and always when a task ends, a pin changes or a book is pruned", async () => {
  const made = await fileStore();
  try {
    const { store, dir } = made;
    const read = async () => JSON.parse(await readFile(path.join(dir, "totals.json"), "utf8"));
    await writeCall(store, "activity_w", 1, { pieces: ["abc"] });
    await store.saveTask(headerOf("activity_w", "2026-11-20T10:00:00.000Z"));
    assert.equal((await read()).bytes, 9, "a task that ends writes them");
    await store.keep(BOOK, "activity_w", true);
    assert.equal((await read()).pinnedTasks, 1);
    await store.prune(BOOK, 0);
    assert.equal((await read()).bytes, 9, "a prune that drops nothing changes nothing");
    await store.keep(BOOK, "activity_w", false);
    await store.prune(BOOK, 0);
    assert.deepEqual({ ...(await read()), updatedAt: undefined }, { version: 1, bytes: 0, tasks: 0, calls: 0, pinnedTasks: 0, pinnedBytes: 0, updatedAt: undefined });
  } finally {
    await made.cleanup();
  }
});

// ---- the budget

test("ai calls (files): when a task ends the book is brought back to its budget: whole tasks, oldest first, never a pinned or a running one, and their files go", async () => {
  const made = await fileStore({ budgetBytes: 1_000 });
  try {
    const { store, dir } = made;
    const calls = {};
    for (let index = 0; index < 5; index += 1) {
      const activityId = `activity_b${index}`;
      const startedAt = `2026-11-2${index}T10:00:00.000Z`;
      await store.saveTask(headerOf(activityId, startedAt, { status: "running", endedAt: null }));
      calls[activityId] = await writeCall(store, activityId, 1, { system: "s".repeat(100), user: "u".repeat(100), pieces: ["r".repeat(100)], startedAt });
      if (index === 0) await store.keep(BOOK, activityId, true);
      if (index < 4) await store.saveTask(headerOf(activityId, startedAt));
    }
    // 300 bytes each: after the fourth task ended the book kept 1200 (over 1000): the oldest that is not pinned went. The fifth still runs.
    assert.deepEqual((await store.listTasks(BOOK, { limit: 10 })).tasks.map((task) => task.activityId), ["activity_b4", "activity_b3", "activity_b2", "activity_b0"]);
    assert.equal((await store.totals(BOOK)).bytes, 1_200, "the pinned one, three more, and the one that runs: four tasks of 300");
    assert.equal(await store.readText(BOOK, calls.activity_b1, "system", 0), null);
    assert.ok(await store.readText(BOOK, calls.activity_b0, "system", 0), "the pinned one stays");
    assert.ok(await store.readText(BOOK, calls.activity_b4, "system", 0), "and the running one");
    const files = (await walk(dir)).map((file) => path.basename(file));
    assert.equal(files.some((file) => file.startsWith(calls.activity_b1)), false, "no text of the dropped task is on the disk");
    assert.equal(files.includes("activity_b1.json"), false, "nor its file");
    assert.deepEqual(await names(path.join(dir, "tasks", "2026", "11")), ["20", "22", "23", "24"], "and the folder of a day with nothing left is gone");
    // The fifth ends: the book is over its budget again (1200), and the oldest that is not pinned goes (the one that ended is not safe because it was the last).
    await store.saveTask(headerOf("activity_b4", "2026-11-24T10:00:00.000Z"));
    assert.deepEqual((await store.listTasks(BOOK, { limit: 10 })).tasks.map((task) => task.activityId), ["activity_b4", "activity_b3", "activity_b0"]);
    assert.equal((await store.totals(BOOK)).bytes, 900);
    // Pins alone over the budget: nothing else can go, and it says so.
    await store.keep(BOOK, "activity_b3", true);
    await store.keep(BOOK, "activity_b4", true);
    const result = await store.prune(BOOK, 100);
    assert.deepEqual([result.dropped, result.overBudget, result.pinnedTasks, result.bytes], [[], true, 3, 900]);
  } finally {
    await made.cleanup();
  }
});

test("ai calls (files): pruning a book of a few hundred tasks is a matter of its index, not of its texts: it reads no text and no task file", async () => {
  const made = await fileStore({ budgetBytes: 0 });
  try {
    const { store } = made;
    // Three dozen tasks are written (each a task file and a few texts); the budget is nothing, so the last that ends prunes all the others.
    for (let index = 0; index < 12; index += 1) {
      const activityId = `activity_n${String(index).padStart(2, "0")}`;
      await store.saveTask(headerOf(activityId, `2026-11-20T10:${String(index).padStart(2, "0")}:00.000Z`, { status: "running", endedAt: null }));
      await writeCall(store, activityId, 1, { pieces: ["x"], startedAt: `2026-11-20T10:${String(index).padStart(2, "0")}:00.000Z` });
    }
    const result = await store.prune(BOOK, 10);
    assert.equal(result.dropped.length, 0, "every task still runs: none can go");
    for (let index = 0; index < 12; index += 1) await store.saveTask(headerOf(`activity_n${String(index).padStart(2, "0")}`, `2026-11-20T10:${String(index).padStart(2, "0")}:00.000Z`));
    assert.equal((await store.listTasks(BOOK, { limit: 50 })).tasks.length, 0, "each ended task was dropped when it ended: the budget is nothing");
    assert.deepEqual(await store.totals(BOOK), { bytes: 0, tasks: 0, calls: 0, pinnedTasks: 0, pinnedBytes: 0 });
  } finally {
    await made.cleanup();
  }
});

// ---- secrets

test("ai calls (files): the secrets this server knows are kept out of the texts and the records, and a text keeps the length the recorder counted, so the pieces after it still fit", async () => {
  const key = "plain-key-0123456789abcdefghij";
  const token = "tok_ABCDEFGHIJKLMNOPQRSTUVWXYZ012345";
  const made = await fileStore({ secrets: (bookId) => (bookId === BOOK ? [key, token, "short"] : []) });
  try {
    const { store, root } = made;
    const callId = engine.aiCallIdOf("activity_s", 1);
    await store.saveTask(headerOf("activity_s", "2026-11-20T10:00:00.000Z", { title: `Write with ${key}` }));
    await store.begin({ record: recordOf(callId, "activity_s", 1, { label: `Call using ${token}` }), system: `You hold ${key} and ${encodeURIComponent(key)}`, user: `Token ${token}` });
    const first = `The key was ${key}, `;
    const second = "and the next piece goes on.";
    await store.append(callId, 1, 0, first);
    await store.append(callId, 1, Buffer.byteLength(first), second);
    await store.end(callId, finalOf("failed", { attempts: [{ index: 1, error: { name: "Error", message: `Rejected ${key}`, status: 401, transient: false, timedOut: false } }] }));
    const text = (await store.readText(BOOK, callId, "response", 0)).text;
    assert.equal(Buffer.byteLength(text), Buffer.byteLength(first) + Buffer.byteLength(second), "the same length");
    assert.match(text, /^The key was \[redacted\]\*+, and the next piece goes on\.$/);
    assert.match((await store.readText(BOOK, callId, "system", 0)).text, /^You hold \[redacted\] and \[redacted\]$/);
    assert.equal((await store.readText(BOOK, callId, "user", 0)).text, "Token [redacted]");
    const task = await store.readTask(BOOK, "activity_s");
    assert.equal(task.header.title, "Write with [redacted]");
    assert.equal(task.calls[0].label, "Call using [redacted]");
    assert.equal(task.calls[0].attempts[0].error.message, "Rejected [redacted]");
    // Nothing on the disk holds either of them, in a file or in a gzip.
    for (const file of await walk(root)) {
      const bytes = await readFile(file);
      const content = file.endsWith(".gz") ? gunzipSync(bytes).toString("utf8") : bytes.toString("utf8");
      assert.equal(content.includes(key) || content.includes(token) || content.includes(encodeURIComponent(key)), false, path.relative(root, file));
    }
    // And one that is a book's own (the secrets are asked for by book) is asked for that book.
    await store.begin({ record: recordOf("activity_o-0001", "activity_o", 1, { bookId: "other" }), system: `Another book says ${key}`, user: "" });
    assert.equal((await store.readText("other", "activity_o-0001", "system", 0)).text, `Another book says ${key}`, "a secret of another book is not this book's to hide");
  } finally {
    await made.cleanup();
  }
});

test("ai calls (files): a function that gives the secrets and fails is not a reason to lose a record", async () => {
  const made = await fileStore({ secrets: () => { throw new Error("the vault is locked"); } });
  try {
    await writeCall(made.store, "activity_v", 1, { pieces: ["fine"] });
    assert.equal((await made.store.readText(BOOK, "activity_v-0001", "response", 0)).text, "fine");
  } finally {
    await made.cleanup();
  }
});

// ---- what happens around

test("ai calls (files): deleting a book while a call is open lets that call go, and the next call of the task begins afresh; nothing is made again by what the lost call writes", async () => {
  const made = await fileStore();
  try {
    const { store, dir } = made;
    const lost = engine.aiCallIdOf("activity_x", 1);
    await store.begin({ record: recordOf(lost, "activity_x", 1), system: "s", user: "u" });
    await store.append(lost, 1, 0, "before");
    await store.deleteBook(BOOK);
    await store.append(lost, 1, 6, " after");
    await store.end(lost, finalOf());
    assert.equal(await lstat(dir).then(() => true, () => false), false, "what the lost call wrote made no folder");
    const next = engine.aiCallIdOf("activity_x", 2);
    await store.begin({ record: recordOf(next, "activity_x", 2), system: "new", user: "u" });
    await store.append(next, 1, 0, "text");
    assert.deepEqual((await store.readTask(BOOK, "activity_x")).calls.map((call) => call.callId), [next]);
    assert.equal((await store.readText(BOOK, lost, "system", 0)), null);
  } finally {
    await made.cleanup();
  }
});

test("ai calls (files): a book that moved away (to the trash with its folder) is forgotten without touching a file, and the next write finds an empty folder", async () => {
  const made = await fileStore();
  try {
    const { store, dir } = made;
    await writeCall(store, "activity_m", 1, { pieces: ["old"] });
    await store.saveTask(headerOf("activity_m", "2026-11-20T10:00:00.000Z"));
    await store.close();
    const away = path.join(made.root, "away");
    await rename(dir, away);
    await store.forget(BOOK);
    assert.deepEqual(await store.totals(BOOK), { bytes: 0, tasks: 0, calls: 0, pinnedTasks: 0, pinnedBytes: 0 });
    assert.equal(await store.readTask(BOOK, "activity_m"), null);
    await writeCall(store, "activity_n", 1, { pieces: ["new"] });
    assert.deepEqual((await store.listTasks(BOOK, { limit: 5 })).tasks.map((task) => task.activityId), ["activity_n"]);
    assert.ok(await lstat(path.join(away, "tasks")).then(() => true, () => false), "what moved away is as it was");
    await store.forget("never-there");
  } finally {
    await made.cleanup();
  }
});

test("ai calls (files): two books and many calls at once leave every text as written and the totals as the sum", async () => {
  const made = await fileStore();
  try {
    const { store } = made;
    const work = [];
    for (const book of ["book-a", "book-b"]) {
      for (let task = 0; task < 3; task += 1) {
        work.push((async () => {
          const activityId = `activity_${book.replace("-", "")}_${task}`;
          for (let seq = 1; seq <= 3; seq += 1) {
            const callId = engine.aiCallIdOf(activityId, seq);
            await store.begin({ record: recordOf(callId, activityId, seq, { bookId: book }), system: `sys ${book} ${task} ${seq}`, user: "u" });
            await Promise.all([0, 1, 2, 3].map((piece) => store.append(callId, 1, piece * 5, `p${piece}...`.slice(0, 5))));
            await store.end(callId, finalOf());
          }
        })());
      }
    }
    await Promise.all(work);
    for (const book of ["book-a", "book-b"]) {
      const totals = await store.totals(book);
      assert.deepEqual([totals.calls, totals.tasks], [9, 3]);
      assert.equal(totals.bytes, 9 * (20 + 1 + `sys ${book} 0 1`.length), "the response, the user and the system message of each call");
      const callId = engine.aiCallIdOf(`activity_${book.replace("-", "")}_1`, 2);
      assert.equal((await store.readText(book, callId, "response", 0)).text, "p0...p1...p2...p3...");
    }
  } finally {
    await made.cleanup();
  }
});

test("ai calls (files): a task and its calls are found again by a new store with the same order and paging, whatever the days they were made on", async () => {
  const made = await fileStore();
  try {
    const { store } = made;
    const ids = [];
    for (let index = 0; index < 9; index += 1) {
      const activityId = `activity_pg${index}`;
      const day = String(18 + Math.floor(index / 3));
      const startedAt = `2026-11-${day}T1${index % 3}:00:00.000Z`;
      await store.saveTask(headerOf(activityId, startedAt));
      ids.push([startedAt, activityId]);
    }
    const expected = ids.sort().reverse().map(([, id]) => id);
    const reopened = made.open();
    const seen = [];
    let before;
    for (let guard = 0; guard < 10; guard += 1) {
      const page = await reopened.listTasks(BOOK, { before, limit: 4 });
      seen.push(...page.tasks.map((task) => task.activityId));
      if (page.next === null) break;
      before = page.next;
    }
    assert.deepEqual(seen, expected);
    assert.deepEqual(await names(path.join(made.dir, "tasks", "2026", "11")), ["18", "19", "20"], "a folder for each day");
  } finally {
    await made.cleanup();
  }
});

// ---- the owner's switch, a write that fails, a disk under the floor

test("ai calls (files): while the switch says no nothing is written and nothing is kept for later (begin, append, end and saveTask do nothing), what is there is still read, kept, pruned and deleted, and on again it writes", async () => {
  let on = true;
  const made = await fileStore({ enabled: () => on });
  try {
    const { store, dir } = made;
    const kept = await writeCall(store, "activity_k", 1, { pieces: ["kept"] });
    await store.saveTask(headerOf("activity_k", "2026-11-20T10:00:00.000Z"));
    await store.close();
    const totals = await store.totals(BOOK);
    const files = await walk(dir);

    on = false;
    const off = engine.aiCallIdOf("activity_off", 1);
    await store.saveTask(headerOf("activity_off", "2026-11-21T10:00:00.000Z", { status: "running", endedAt: null }));
    await store.begin({ record: recordOf(off, "activity_off", 1, { timing: { startedAt: "2026-11-21T10:00:00.000Z", firstTextAt: null, endedAt: null } }), system: "s", user: "u" });
    await store.append(off, 1, 0, "text");
    await store.end(off, finalOf());
    await store.saveTask(headerOf("activity_off", "2026-11-21T10:00:00.000Z"));
    assert.equal(await store.readTask(BOOK, "activity_off"), null);
    assert.equal(await store.readText(BOOK, off, "response", 0), null);
    assert.deepEqual(await store.totals(BOOK), totals);
    assert.deepEqual(await walk(dir), files, "not a file was written");
    assert.equal((await store.readText(BOOK, kept, "response", 0)).text, "kept", "what is kept is read");
    await store.keep(BOOK, "activity_k", true);
    assert.equal((await store.readTask(BOOK, "activity_k")).header.pinned, true, "and kept");
    await store.keep(BOOK, "activity_k", false);
    assert.deepEqual((await store.prune(BOOK, 0)).dropped, ["activity_k"], "and pruned");

    // A call that began while it was off never comes back: what it writes after the switch is on again waits for a `begin` that was not made, and is never a record.
    on = true;
    await store.append(off, 1, 4, " more");
    await store.end(off, finalOf());
    assert.equal(await store.readText(BOOK, off, "response", 0), null);
    await writeCall(store, "activity_on", 1, { pieces: ["again"], startedAt: "2026-11-22T10:00:00.000Z" });
    assert.equal((await store.readText(BOOK, engine.aiCallIdOf("activity_on", 1), "response", 0)).text, "again");
    on = false;
    await store.deleteBook(BOOK);
    assert.equal(await lstat(dir).then(() => true, () => false), false, "and deleted");
  } finally {
    await made.cleanup();
  }
});

test("ai calls (files): a switch that cannot answer is on, and one that says no also holds for a request that is wrong in itself (it is refused first)", async () => {
  const made = await fileStore({ enabled: () => { throw new Error("no answer"); } });
  try {
    await writeCall(made.store, "activity_s", 1, { pieces: ["fine"] });
    assert.equal((await made.store.readText(BOOK, "activity_s-0001", "response", 0)).text, "fine");
    const off = await fileStore({ enabled: () => false });
    try {
      await assert.rejects(off.store.begin({ record: recordOf("../x", "activity_s", 1), system: "", user: "" }), TypeError);
      await assert.rejects(off.store.append("activity_s-0001", 0, 0, "x"), RangeError);
    } finally {
      await off.cleanup();
    }
  } finally {
    await made.cleanup();
  }
});

test("ai calls (files): when the owner turns recording off the calls that are open are cut where they are: interrupted, their text so far packed and readable, their tasks stopped, and what they write next is let go, also when it is turned on again", async () => {
  let on = true;
  const made = await fileStore({ enabled: () => on, now: () => new Date("2026-11-21T08:00:00.000Z") });
  try {
    const { store, dir } = made;
    await store.saveTask(headerOf("activity_c", "2026-11-20T10:00:00.000Z", { title: "Write chapter 3", status: "running", endedAt: null }));
    await writeCall(store, "activity_c", 1, { pieces: ["finished before"], status: "ok" });
    const cut = engine.aiCallIdOf("activity_c", 2);
    await store.begin({ record: recordOf(cut, "activity_c", 2), system: "sys", user: "usr" });
    await store.append(cut, 1, 0, "Half an ans");
    await store.append(cut, 2, 0, "Retry");
    await store.saveTask(headerOf("activity_idle", "2026-11-20T11:00:00.000Z", { status: "running", endedAt: null }));
    assert.deepEqual(await names(path.join(dir, "live")), [`${cut}.1.response.txt`, `${cut}.2.response.txt`]);

    on = false;
    await store.interruptOpen();
    const task = await store.readTask(BOOK, "activity_c");
    assert.deepEqual([task.header.status, task.header.title], ["stopped", "Write chapter 3"]);
    assert.equal(task.header.endedAt === null, false);
    const [done, interrupted] = task.calls;
    assert.equal(done.status, "ok", "a call that had ended is as it was");
    assert.deepEqual([interrupted.status, interrupted.response.partial], ["interrupted", true]);
    assert.deepEqual(interrupted.response.text, { characters: 5, bytes: 5, storedBytes: 5, truncated: false }, "the last response that has text");
    assert.equal((await store.readTask(BOOK, "activity_idle")).header.status, "stopped", "a task that runs and has no call open is stopped too");
    const text = await store.readText(BOOK, cut, "response", 0, 1);
    assert.deepEqual([text.text, text.complete], ["Half an ans", true], "the text is there, and nothing more will come");
    assert.deepEqual(await names(path.join(dir, "live")), [], "packed into texts/");
    const before = await walk(dir);

    on = true;
    await store.append(cut, 1, 11, "wer that must not be written");
    await store.end(cut, finalOf("ok"));
    assert.equal((await store.readText(BOOK, cut, "response", 0, 1)).text, "Half an ans", "what a call that was cut writes later is let go");
    assert.equal((await store.readTask(BOOK, "activity_c")).calls[1].status, "interrupted");
    assert.deepEqual((await walk(dir)).filter((file) => !file.endsWith(".json") && !file.endsWith("totals.json")), before.filter((file) => !file.endsWith(".json") && !file.endsWith("totals.json")), "no text was written");
    await store.interruptOpen();
    assert.equal((await store.readTask(BOOK, "activity_c")).header.status, "stopped", "cutting what is cut is nothing");
  } finally {
    await made.cleanup();
  }
});

test("ai calls (files): when a write fails what the book had open is cut (the engine stops recording a run at the first failure and finishes nothing), the failure is told with its kind, and a write that works clears it", async () => {
  let free = 5_000;
  const made = await fileStore({ minFreeDiskBytes: 1_000, freeDiskBytes: () => free, now: () => new Date("2026-11-21T08:00:00.000Z") });
  try {
    const { store, dir } = made;
    assert.deepEqual(store.failures(), []);
    const callId = engine.aiCallIdOf("activity_f", 1);
    await store.saveTask(headerOf("activity_f", "2026-11-20T10:00:00.000Z", { status: "running", endedAt: null }));
    await store.begin({ record: recordOf(callId, "activity_f", 1), system: "s", user: "u" });
    await store.append(callId, 1, 0, "before the room went");
    free = 500;
    await assert.rejects(store.append(callId, 1, 20, " and after"), testing.AiCallDiskFullError);
    await store.close();
    assert.deepEqual(store.failures(), [{ bookId: BOOK, kind: "disk", at: "2026-11-21T08:00:00.000Z" }]);
    const task = await store.readTask(BOOK, "activity_f");
    assert.deepEqual([task.header.status, task.calls[0].status, task.calls[0].response.partial], ["stopped", "interrupted", true], "nothing is left saying that it runs");
    assert.equal((await store.readText(BOOK, callId, "response", 0)).text, "before the room went");
    await store.end(callId, finalOf("ok"));
    assert.equal((await store.readTask(BOOK, "activity_f")).calls[0].status, "interrupted", "and what the call writes after that is let go");

    // The other kind of failure: the folder of the records is a file.
    free = 5_000;
    const other = made.open();
    await mkdir(path.join(made.root, "books", "book-2"), { recursive: true });
    await writeFile(made.directory("book-2"), "in the way");
    await assert.rejects(other.begin({ record: recordOf("activity_x-0001", "activity_x", 1, { bookId: "book-2" }), system: "s", user: "u" }));
    assert.deepEqual(other.failures().map((failure) => [failure.bookId, failure.kind]), [["book-2", "error"]]);
    await assert.rejects(other.begin({ record: recordOf("../bad", "activity_x", 1, { bookId: "book-2" }), system: "s", user: "u" }), TypeError);
    assert.equal(other.failures().length, 1, "a request that is wrong in itself is not a failure of the store");
    await rm(made.directory("book-2"));

    // A write that works clears the failure.
    await writeCall(store, "activity_g", 1, { pieces: ["fine"], startedAt: "2026-11-22T10:00:00.000Z" });
    assert.deepEqual(store.failures(), [], "the next call that is written clears it");
    assert.equal(await lstat(dir).then(() => true, () => false), true);
  } finally {
    await made.cleanup();
  }
});

test("ai calls (files): a task that is not kept yet is not started under the free disk (nothing is written then), one that is can still be updated and ended, and the disk says how much is free and how much must be", async () => {
  let free = 5_000;
  const made = await fileStore({ minFreeDiskBytes: 1_000, freeDiskBytes: () => free });
  try {
    const { store } = made;
    assert.equal(await store.diskHold(made.dir), undefined, "room: nothing holds the records back");
    await store.saveTask(headerOf("activity_old", "2026-11-20T10:00:00.000Z", { status: "running", endedAt: null }));
    free = 999;
    assert.deepEqual(await store.diskHold(made.dir), { freeBytes: 999, minFreeBytes: 1_000 });
    await assert.rejects(store.saveTask(headerOf("activity_new", "2026-11-21T10:00:00.000Z", { status: "running", endedAt: null })), testing.AiCallDiskFullError);
    assert.equal(await store.readTask(BOOK, "activity_new"), null, "the task that was refused is not there");
    await store.close();
    await store.saveTask(headerOf("activity_old", "2026-11-20T10:00:00.000Z"));
    assert.equal((await store.readTask(BOOK, "activity_old")).header.status, "done", "the task that is kept is ended: a few bytes");
    free = undefined;
    assert.equal(await store.diskHold(made.dir), undefined, "a disk that does not say is not a disk that is full");
    const off = await fileStore({ minFreeDiskBytes: 0, freeDiskBytes: () => 0 });
    try {
      assert.equal(await off.store.diskHold(off.dir), undefined, "a floor of nothing holds nothing back");
    } finally {
      await off.cleanup();
    }
  } finally {
    await made.cleanup();
  }
});

test("ai calls (files): closing waits for the writes that are on their way, and for the ones those queue (what a run that ends leaves behind: the end of its last call, the header of its task)", async () => {
  const made = await fileStore();
  try {
    const { store } = made;
    const callId = engine.aiCallIdOf("activity_w", 1);
    await store.saveTask(headerOf("activity_w", "2026-11-20T10:00:00.000Z", { status: "running", endedAt: null }));
    await store.begin({ record: recordOf(callId, "activity_w", 1), system: "s", user: "u" });
    // Each write is queued when the one before has landed, and nobody waits for the chain: the engine does not.
    const chain = (async () => {
      await store.append(callId, 1, 0, "one");
      await store.append(callId, 1, 3, "two");
      await store.end(callId, finalOf("ok"));
      await store.saveTask(headerOf("activity_w", "2026-11-20T10:00:00.000Z"));
    })();
    await store.close();
    const reading = made.open();
    assert.equal((await reading.readText(BOOK, callId, "response", 0, 1)).text, "onetwo");
    const task = await reading.readTask(BOOK, "activity_w");
    assert.deepEqual([task.header.status, task.calls[0].status], ["done", "ok"], "everything the chain wrote is on the disk when close is over");
    await chain;
    await store.close();
  } finally {
    await made.cleanup();
  }
});

test("ai calls (files): a write that fails is told by its code and never by its path (the run's feed carries it), the cause with the path is in the log once in a while, and the failure is kept for the health", async () => {
  const lines = [];
  const made = await fileStore({ log: (line) => lines.push(line), now: () => new Date("2026-11-21T08:00:00.000Z") });
  try {
    await mkdir(path.join(made.root, "books", BOOK), { recursive: true });
    await writeFile(made.dir, "in the way");
    for (let attempt = 0; attempt < 3; attempt += 1) {
      await assert.rejects(made.store.begin({ record: recordOf(`activity_e-000${attempt + 1}`, "activity_e", attempt + 1), system: "s", user: "u" }), (error) => {
        assert.equal(error instanceof testing.AiCallStoreError, true);
        assert.equal(error.name, "AiCallStoreError");
        assert.match(error.message, /^The AI call records could not be written \(E[A-Z]+\)\.$/);
        assert.equal(error.message.includes(made.root), false, "it does not say where");
        return /^E[A-Z]+$/.test(error.code);
      });
    }
    assert.deepEqual(made.store.failures().map((failure) => [failure.bookId, failure.kind]), [[BOOK, "error"]]);
    const said = lines.filter((line) => /could not be written/.test(line));
    assert.equal(said.length, 1, "once in a while, not for every write that fails");
    assert.ok(said[0].includes(made.dir), "with the cause, and where");
    // A request that is wrong in itself is not a failure of the files.
    await assert.rejects(made.store.begin({ record: recordOf("../x", "activity_e", 1), system: "", user: "" }), TypeError);
    assert.equal(made.store.failures().length, 1);
    assert.equal(lines.filter((line) => /could not be written/.test(line)).length, 1);
    // The records of the book are deleted (or the book is gone): what failed for them is no longer a thing to tell.
    await made.store.deleteBook(BOOK);
    assert.deepEqual(made.store.failures(), []);
  } finally {
    await made.cleanup();
  }
});
