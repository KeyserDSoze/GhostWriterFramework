import test from "node:test";
import assert from "node:assert/strict";
import * as engine from "../dist/index.js";
import { MemoryBookStore } from "../dist/testing/index.js";

// New exports are read from the namespace so that, before they exist, each test fails on its own.
const { SYNC_MAX_FILE_BYTES, planFileSync, syncBookStores } = engine;

const MIB = 1024 * 1024;
const encoder = new TextEncoder();
const bytesOf = (text) => encoder.encode(text).byteLength;

/** A store that refuses a whole commit that carries a file over `limit` bytes, as the personal server does. */
class ServerLikeStore extends MemoryBookStore {
  limit = 8 * MIB;
  commitLog = [];
  async commit(changes, message) {
    const big = changes.find((change) => change.content !== null && bytesOf(change.content) > this.limit);
    if (big) throw new Error(`The file ${big.path} is over the limit of ${this.limit} bytes.`);
    this.commitLog.push(changes.map((change) => change.path));
    return super.commit(changes, message);
  }
}

const huge = (bytes = 9 * MIB) => "y".repeat(bytes);

test("a file over the limit is reported as skipped, the check is made before it goes into a commit, and the rest of the sync goes through", async () => {
  assert.equal(SYNC_MAX_FILE_BYTES, 8 * MIB);
  const local = new MemoryBookStore({ "huge.json": huge(), "small.md": "small", "notes/n.md": "note" });
  const remote = new ServerLikeStore();
  const result = await syncBookStores({ local, remote, base: new Map() });
  assert.deepEqual([...result.uploaded].sort(), ["notes/n.md", "small.md"]);
  assert.deepEqual(result.skipped, [{ path: "huge.json", reason: "too-large", size: 9 * MIB }]);
  assert.equal(remote.files.has("huge.json"), false);
  assert.equal(remote.files.get("small.md"), "small");
  assert.equal(remote.commitLog.flat().includes("huge.json"), false, "no commit ever carried it");
  assert.equal(result.base.has("huge.json"), false, "it is not remembered as synced");
  assert.equal(result.base.has("small.md"), true);

  // The next sync says it again, and still fails nothing.
  local.write("another.md", "another");
  const again = await syncBookStores({ local, remote, base: result.base });
  assert.deepEqual(again.uploaded, ["another.md"]);
  assert.deepEqual(again.skipped, [{ path: "huge.json", reason: "too-large", size: 9 * MIB }]);

  // Once the file is small enough it travels.
  local.write("huge.json", "{}");
  const fixed = await syncBookStores({ local, remote, base: again.base });
  assert.deepEqual(fixed.uploaded, ["huge.json"]);
  assert.deepEqual(fixed.skipped, []);
  assert.equal(remote.files.get("huge.json"), "{}");
});

test("the limit is configurable and counts bytes, not characters", async () => {
  const local = new MemoryBookStore({ "accents.md": "é".repeat(600), "plain.md": "a".repeat(900), "over.md": "b".repeat(1001) });
  const remote = new MemoryBookStore();
  const result = await syncBookStores({ local, remote, base: new Map(), maxFileBytes: 1000 });
  assert.deepEqual([...result.uploaded].sort(), ["plain.md"]);
  assert.deepEqual(result.skipped, [{ path: "accents.md", reason: "too-large", size: 1200 }, { path: "over.md", reason: "too-large", size: 1001 }]);
  const roomy = await syncBookStores({ local, remote, base: result.base, maxFileBytes: 2000 });
  assert.deepEqual([...roomy.uploaded].sort(), ["accents.md", "over.md"]);
  assert.deepEqual(roomy.skipped, []);
});

test("a file that is too large to be moved down is skipped too, and the rest comes down", async () => {
  const remote = new MemoryBookStore({ "big.md": huge(10 * MIB), "ok.md": "fine" });
  const local = new MemoryBookStore();
  const result = await syncBookStores({ local, remote, base: new Map() });
  assert.deepEqual(result.downloaded, ["ok.md"]);
  assert.deepEqual(result.skipped, [{ path: "big.md", reason: "too-large", size: 10 * MIB }]);
  assert.equal(local.files.has("big.md"), false);
});

test("a size listed with the manifest saves reading a file that cannot be moved", async () => {
  const reads = new Set();
  class SizedStore extends MemoryBookStore {
    async list() {
      return (await super.list()).map((entry) => ({ ...entry, size: bytesOf(this.files.get(entry.path)) }));
    }
    async read(path) {
      reads.add(path);
      return super.read(path);
    }
    async readMany(paths) {
      for (const path of paths) reads.add(path);
      return super.readMany(paths);
    }
  }
  const local = new SizedStore({ "huge.json": huge(), "small.md": "small" });
  const result = await syncBookStores({ local, remote: new MemoryBookStore(), base: new Map() });
  assert.deepEqual(result.uploaded, ["small.md"]);
  assert.deepEqual(result.skipped, [{ path: "huge.json", reason: "too-large", size: 9 * MIB }]);
  assert.deepEqual([...reads], ["small.md"], "the big file was never read");
});

test("a store that refuses to send a file because it is too much does not fail the sync: that file is skipped, without a size", async () => {
  class RefusingStore extends MemoryBookStore {
    async readMany(paths) {
      const files = await super.readMany(paths);
      if (files.some((file) => bytesOf(file.content) > 1000)) throw Object.assign(new Error("These files are too large to be read in one request."), { status: 413, code: "payload_too_large" });
      return files;
    }
  }
  const remote = new RefusingStore({ "a.md": "small", "b.md": "x".repeat(5000), "c.md": "small", "d.md": "small" });
  const local = new MemoryBookStore();
  const result = await syncBookStores({ local, remote, base: new Map() });
  assert.deepEqual(result.downloaded.sort(), ["a.md", "c.md", "d.md"]);
  assert.deepEqual(result.skipped, [{ path: "b.md", reason: "too-large" }]);
  assert.equal(local.files.has("b.md"), false);
  assert.equal(result.base.has("b.md"), false);
  const broken = new MemoryBookStore({ "a.md": "x" });
  broken.readMany = async () => { throw Object.assign(new Error("boom"), { status: 500 }); };
  await assert.rejects(() => syncBookStores({ local: new MemoryBookStore(), remote: broken, base: new Map() }), /boom/, "any other failure is still a failure");
});

test("a file that was synced and has grown over the limit is skipped, and the old version stays in the base", async () => {
  const local = new MemoryBookStore({ "notes.md": "short" });
  const remote = new ServerLikeStore();
  const first = await syncBookStores({ local, remote, base: new Map() });
  assert.deepEqual(first.uploaded, ["notes.md"]);
  local.write("notes.md", huge());
  const second = await syncBookStores({ local, remote, base: first.base });
  assert.deepEqual(second.uploaded, []);
  assert.deepEqual(second.skipped, [{ path: "notes.md", reason: "too-large", size: 9 * MIB }]);
  assert.equal(second.base.get("notes.md"), first.base.get("notes.md"), "the version the other side has is the one remembered");
  assert.equal(remote.files.get("notes.md"), "short");
});

test("deleting a file that is too large to be moved is not skipped: nothing has to be read", async () => {
  const local = new MemoryBookStore();
  const remote = new MemoryBookStore({ "huge.json": huge() });
  const base = new Map(await remote.list().then((entries) => entries.map((entry) => [entry.path, entry.hash])));
  const result = await syncBookStores({ local, remote, base });
  assert.deepEqual(result.uploaded, ["huge.json"]);
  assert.deepEqual(result.skipped, []);
  assert.equal(remote.files.has("huge.json"), false);
});

test("progress counts the files that were skipped as settled", async () => {
  const progress = [];
  const local = new MemoryBookStore({ "a.md": "a", "b.md": "b", "z-huge1.json": huge(), "z-huge2.json": huge() });
  const result = await syncBookStores({ local, remote: new MemoryBookStore(), base: new Map(), onProgress: (done, total) => progress.push([done, total]) });
  assert.equal(result.skipped.length, 2);
  assert.deepEqual(progress.at(-1), [4, 4]);
  const onlyHuge = [];
  await syncBookStores({ local: new MemoryBookStore({ "h1.json": huge(), "h2.json": huge() }), remote: new MemoryBookStore(), base: new Map(), onProgress: (done, total) => onlyHuge.push([done, total]) });
  assert.deepEqual(onlyHuge.at(-1), [2, 2], "also when nothing at all could be moved");
});

test("unsafe paths and files that are not text are reported with their reason, and `rejected` says what it always said", async () => {
  const local = new MemoryBookStore({ "cover.png": "png", "same.png": "equal", "notes/a.md": "mine" });
  const remote = new MemoryBookStore({ "../evil.md": "x", ".git/config.json": "{}", "assets/data.bin": "bin", "good.md": "ok", "same.png": "equal" });
  const result = await syncBookStores({ local, remote, base: new Map() });
  assert.deepEqual(result.downloaded, ["good.md"]);
  assert.deepEqual(result.uploaded, ["notes/a.md"]);
  assert.deepEqual([...result.rejected].sort(), ["../evil.md", ".git/config.json"]);
  assert.deepEqual(result.skipped, [
    { path: "../evil.md", reason: "unsafe-path" },
    { path: ".git/config.json", reason: "unsafe-path" },
    { path: "assets/data.bin", reason: "not-text" },
    { path: "cover.png", reason: "not-text" },
  ]);
});

test("the plan says what it leaves out, and its other fields are as they were", () => {
  const plan = planFileSync(new Map([["cover.png", "1"], ["a.md", "2"]]), new Map([["../x.md", "3"], ["b.md", "4"]]), new Map());
  assert.deepEqual(plan.upload, [{ path: "a.md", hash: "2" }]);
  assert.deepEqual(plan.download, [{ path: "b.md", hash: "4" }]);
  assert.deepEqual(plan.rejected, ["../x.md"]);
  assert.deepEqual(plan.skipped, [{ path: "../x.md", reason: "unsafe-path" }, { path: "cover.png", reason: "not-text" }]);
});
