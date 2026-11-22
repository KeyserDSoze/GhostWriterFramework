import test from "node:test";
import assert from "node:assert/strict";
import * as engine from "../dist/index.js";
import { MemoryBookStore } from "../dist/testing/index.js";

// New exports are read from the namespace so that, before they exist, each test fails on its own.
const { NarrariumServerClient, ServerRequestError, remoteBookStore, syncBookStores } = engine;

const MIB = 1024 * 1024;
const bytesOf = (text) => new TextEncoder().encode(text).length;

/** What the personal server accepts: 5000 changes and 64 MiB per commit, 100 paths and 16 MiB per read. */
const SERVER_LIMITS = { commitChanges: 5000, commitBytes: 64 * MIB, readPaths: 100, readBytes: 16 * MIB };

function tooLarge(message) {
  return Object.assign(new Error(message), { status: 413, code: "payload_too_large" });
}

/** A store that refuses what the server refuses, and remembers what it was asked. */
class ServerLikeStore extends MemoryBookStore {
  commitLog = [];
  readLog = [];
  singleReads = 0;
  /** Commits that succeed before every following one fails with a network error. */
  failAfterCommits = Number.POSITIVE_INFINITY;

  async commit(changes, message) {
    if (changes.length > SERVER_LIMITS.commitChanges) throw tooLarge(`A commit may change at most ${SERVER_LIMITS.commitChanges} files.`);
    const bytes = changes.reduce((sum, change) => sum + (change.content === null ? 0 : bytesOf(change.content)), 0);
    if (bytes > SERVER_LIMITS.commitBytes) throw tooLarge("This commit is too large.");
    if (this.commitLog.length >= this.failAfterCommits) throw new Error("The connection was lost.");
    this.commitLog.push({ changes: changes.length, bytes });
    return super.commit(changes, message);
  }

  async readMany(paths) {
    if (new Set(paths).size > SERVER_LIMITS.readPaths) throw Object.assign(new Error("Read at most 100 different files per request."), { status: 400, code: "too_many_paths" });
    this.insideReadMany = true;
    try {
      const files = await super.readMany(paths);
      if (files.reduce((sum, file) => sum + bytesOf(file.content), 0) > SERVER_LIMITS.readBytes) throw tooLarge("These files are too large to be read in one request.");
      this.readLog.push(paths.length);
      return files;
    } finally {
      this.insideReadMany = false;
    }
  }

  async read(path) {
    if (!this.insideReadMany) this.singleReads += 1;
    return super.read(path);
  }
}

function manyFiles(count, prefix = "notes/note", body = (index) => `Note ${index}.`) {
  return Object.fromEntries(Array.from({ length: count }, (_, index) => [`${prefix}-${String(index).padStart(5, "0")}.md`, body(index)]));
}

// ─── readMany on the stores ─────────────────────────────────────────────────

test("MemoryBookStore.readMany returns the files it has, in the order asked, each once", async () => {
  const store = new MemoryBookStore({ "a.md": "A", "b.md": "B", "c.md": "C" });
  assert.equal(typeof store.readMany, "function");
  const files = await store.readMany(["c.md", "missing.md", "a.md", "c.md"]);
  assert.deepEqual(files.map((file) => [file.path, file.content]), [["c.md", "C"], ["a.md", "A"]]);
  assert.equal(files[0].hash, (await store.read("c.md")).hash, "with the same hash as read()");
  assert.deepEqual(await store.readMany([]), []);
});

test("syncBookStores reads in batches through readMany when a store has it, and file by file when it has not", async () => {
  const local = new ServerLikeStore(manyFiles(130));
  const remote = new ServerLikeStore();
  const result = await syncBookStores({ local, remote, base: new Map() });
  assert.equal(result.uploaded.length, 130);
  assert.equal(local.singleReads, 0, "no file was read one by one");
  assert.deepEqual(local.readLog, [50, 50, 30], "batches of at most 50 paths");

  const plain = new MemoryBookStore(manyFiles(7));
  let reads = 0;
  const withoutReadMany = {
    list: () => plain.list(),
    read: async (path) => {
      reads += 1;
      return plain.read(path);
    },
    commit: (changes, message) => plain.commit(changes, message),
  };
  const target = new MemoryBookStore();
  const second = await syncBookStores({ local: withoutReadMany, remote: target, base: new Map() });
  assert.equal(second.uploaded.length, 7);
  assert.equal(reads, 7, "a store without readMany is read as before");
  assert.deepEqual(Object.keys(second).sort(), ["base", "conflicts", "downloaded", "rejected", "skipped", "uploaded"], "the result keeps its shape, and `skipped` is the one field that was added");
});

// ─── sync in chunks ─────────────────────────────────────────────────────────

test("12 000 small files are uploaded to a server-like store in chunks of at most 400 changes", async () => {
  const local = new ServerLikeStore(manyFiles(12_000));
  const remote = new ServerLikeStore();
  const progress = [];
  const result = await syncBookStores({ local, remote, base: new Map(), onProgress: (done, total) => progress.push([done, total]) });
  assert.equal(remote.files.size, 12_000);
  assert.equal(result.uploaded.length, 12_000);
  assert.deepEqual(result.downloaded, []);
  assert.deepEqual(result.conflicts, []);
  assert.equal(result.base.size, 12_000);
  assert.equal(remote.commitLog.length, 30, "12 000 / 400 commits");
  assert.ok(remote.commitLog.every((commit) => commit.changes <= 400), "none above 400 changes");
  assert.deepEqual(progress.at(0), [400, 12_000]);
  assert.deepEqual(progress.at(-1), [12_000, 12_000]);
  assert.equal(progress.length, 30, "called after each chunk");
  assert.ok(progress.every(([done, total], index) => total === 12_000 && done === (index + 1) * 400));
  assert.deepEqual(result.uploaded.slice(0, 3), ["notes/note-00000.md", "notes/note-00001.md", "notes/note-00002.md"], "in path order, as the plan lists them");
});

test("12 000 small files are downloaded in chunks, read through readMany in batches within the server's limits", async () => {
  const remote = new ServerLikeStore(manyFiles(12_000));
  const local = new ServerLikeStore();
  const progress = [];
  const result = await syncBookStores({ local, remote, base: new Map(), onProgress: (done, total) => progress.push([done, total]) });
  assert.equal(local.files.size, 12_000);
  assert.equal(result.downloaded.length, 12_000);
  assert.equal(result.uploaded.length, 0);
  assert.equal(remote.singleReads, 0, "the other side is never read file by file");
  assert.equal(remote.readLog.length, 240, "12 000 / 50 reads");
  assert.ok(remote.readLog.every((count) => count <= 50 && count <= SERVER_LIMITS.readPaths));
  assert.equal(local.commitLog.length, 30);
  assert.ok(local.commitLog.every((commit) => commit.changes <= 400));
  assert.deepEqual(progress.at(-1), [12_000, 12_000]);
});

test("a large book is committed in chunks of about 24 MiB: 75 MiB would be refused as one commit", async () => {
  const big = (index) => `${String(index).padStart(2, "0")}`.repeat(1.5 * MIB);
  const local = new MemoryBookStore(manyFiles(25, "chapters/big", big));
  const remote = new ServerLikeStore();
  assert.ok(Object.values(local.toObject()).reduce((sum, text) => sum + bytesOf(text), 0) > SERVER_LIMITS.commitBytes);
  const result = await syncBookStores({ local, remote, base: new Map() });
  assert.equal(remote.files.size, 25);
  assert.equal(result.uploaded.length, 25);
  assert.ok(remote.commitLog.length >= 4, `${remote.commitLog.length} commits`);
  assert.ok(remote.commitLog.every((commit) => commit.bytes <= 24 * MIB), `no chunk above 24 MiB: ${remote.commitLog.map((commit) => commit.bytes / MIB).join(", ")}`);
  assert.ok(remote.commitLog.every((commit) => commit.bytes > 12 * MIB || commit === remote.commitLog.at(-1)), "and chunks are filled, not one file each");
  assert.equal(remote.commitLog.reduce((sum, commit) => sum + commit.changes, 0), 25);
});

test("a file larger than a chunk travels alone", async () => {
  const local = new MemoryBookStore({ "notes/a.md": "small", "notes/b.md": "x".repeat(30 * MIB), "notes/c.md": "small" });
  const remote = new ServerLikeStore();
  // The file is far over the 8 MiB the sync moves by default (it would be skipped): the limit is raised to test the chunks.
  await syncBookStores({ local, remote, base: new Map(), maxFileBytes: 64 * MIB });
  assert.deepEqual(remote.commitLog.map((commit) => commit.changes), [1, 1, 1]);
  assert.equal(remote.files.get("notes/b.md").length, 30 * MIB);
});

test("a failure after the third chunk leaves a prefix; syncing again with the old base finishes the job, without conflicts or repeated writes", async () => {
  const local = new ServerLikeStore(manyFiles(12_000));
  const remote = new ServerLikeStore();
  remote.failAfterCommits = 3;
  const base = new Map();
  await assert.rejects(() => syncBookStores({ local, remote, base }), /connection was lost/);
  assert.equal(remote.commitLog.length, 3);
  assert.equal(remote.files.size, 1200, "three chunks were applied");
  assert.equal(base.size, 0, "the base the caller keeps is untouched");

  remote.failAfterCommits = Number.POSITIVE_INFINITY;
  const progress = [];
  const result = await syncBookStores({ local, remote, base, onProgress: (done, total) => progress.push([done, total]) });
  assert.deepEqual(result.conflicts, [], "the plan is recomputed from the manifests: files already equal on both sides are skipped");
  assert.equal(result.uploaded.length, 10_800, "only what is left is sent");
  assert.equal(remote.files.size, 12_000);
  assert.deepEqual(progress.at(-1), [10_800, 10_800]);
  const written = remote.commits.flatMap((commit) => commit.paths);
  assert.equal(written.length, 12_000);
  assert.equal(new Set(written).size, 12_000, "no file was written twice");
  assert.equal(result.base.size, 12_000);
  for (const [path, content] of Object.entries(local.toObject())) assert.equal(remote.files.get(path), content, path);

  const again = await syncBookStores({ local, remote, base: result.base });
  assert.deepEqual([again.uploaded.length, again.downloaded.length, again.conflicts.length], [0, 0, 0]);
});

test("the same holds when the failure hits the second side", async () => {
  const local = new ServerLikeStore({ ...manyFiles(900, "mine/m"), "shared.md": "one" });
  const remote = new ServerLikeStore({ ...manyFiles(1500, "theirs/t"), "shared.md": "one" });
  local.failAfterCommits = 2;
  const base = new Map([["shared.md", await engine.sha256Hex("one")]]);
  await assert.rejects(() => syncBookStores({ local, remote, base }), /connection was lost/);
  assert.equal(remote.files.size, 1500 + 1 + 900, "the first side was complete");
  assert.equal(local.files.size, 900 + 1 + 800, "two chunks of the second side were applied");
  local.failAfterCommits = Number.POSITIVE_INFINITY;
  const result = await syncBookStores({ local, remote, base });
  assert.deepEqual(result.conflicts, []);
  assert.equal(local.files.size, 900 + 1 + 1500);
  assert.equal(new Set(local.commits.flatMap((commit) => commit.paths)).size, local.commits.flatMap((commit) => commit.paths).length, "nothing downloaded twice");
});

test("deletions, conflicts and rejected paths behave as before when the changes are chunked", async () => {
  const before = { ...manyFiles(900, "keep/k"), ...manyFiles(450, "gone/g"), "both.md": "base" };
  const baseManifest = new Map(await Promise.all(Object.entries(before).map(async ([path, content]) => [path, await engine.sha256Hex(content)])));
  const local = new ServerLikeStore({ ...manyFiles(900, "keep/k"), "both.md": "mine", ...manyFiles(450, "new/n") });
  const remote = new ServerLikeStore({ ...before, "both.md": "theirs", "../escape.md": "x" });
  const skipped = await syncBookStores({ local, remote, base: baseManifest });
  assert.deepEqual(skipped.conflicts, ["both.md"]);
  assert.deepEqual(skipped.rejected, ["../escape.md"]);
  assert.equal(skipped.uploaded.length, 450 + 450, "450 deletions and 450 new files go to the remote side");
  assert.equal([...remote.files.keys()].filter((path) => path.startsWith("gone/")).length, 0, "deleted files are deleted there too");
  assert.equal(remote.files.get("both.md"), "theirs", "a conflict that is not resolved is left alone");
  assert.equal(skipped.base.get("both.md"), baseManifest.get("both.md"), "and stays in the base as it was");
  assert.equal(skipped.base.has("gone/g-00000.md"), false);
  assert.equal(skipped.base.has("../escape.md"), false);
  assert.ok(remote.commitLog.every((commit) => commit.changes <= 400));

  const resolved = await syncBookStores({ local, remote, base: skipped.base, resolveConflict: () => "local" });
  assert.deepEqual(resolved.uploaded, ["both.md"]);
  assert.equal(remote.files.get("both.md"), "mine");
});

test("a file that vanishes between the listing and the reading is skipped, and stays out of the new base", async () => {
  const local = new ServerLikeStore(manyFiles(10));
  const remote = new ServerLikeStore();
  const original = local.readMany.bind(local);
  local.readMany = async (paths) => (await original(paths)).filter((file) => file.path !== "notes/note-00003.md");
  const progress = [];
  const result = await syncBookStores({ local, remote, base: new Map(), onProgress: (done, total) => progress.push([done, total]) });
  assert.equal(result.uploaded.length, 9);
  assert.equal(result.base.has("notes/note-00003.md"), false);
  assert.equal(remote.files.has("notes/note-00003.md"), false);
  assert.deepEqual(progress, [[10, 10]], "a file that could not be read counts as settled");
});

// ─── remoteBookStore.readMany ───────────────────────────────────────────────

/** The personal server as a `fetch`: manifest, read and commit over a store, with its limits and its request log. */
function fakeServer(store, limits = SERVER_LIMITS) {
  const requests = [];
  const json = (status, payload) => new Response(JSON.stringify(payload), { status, headers: { "content-type": "application/json" } });
  const fetch = async (url, init) => {
    const route = new URL(url).pathname.replace(/^\/api\/v1\/books\/[^/]+/, "");
    const body = init.body ? JSON.parse(init.body) : {};
    requests.push({ route, paths: body.paths, changes: body.changes?.length });
    if (route === "/manifest") return json(200, { revision: "1", files: await store.list() });
    if (route === "/files/read") {
      const paths = [...new Set(body.paths)];
      if (paths.length > limits.readPaths) return json(400, { code: "too_many_paths", message: `Read at most ${limits.readPaths} different files per request.` });
      const files = await store.readMany(paths);
      if (files.reduce((sum, file) => sum + bytesOf(file.content), 0) > limits.readBytes) return json(413, { code: "payload_too_large", message: "These files are too large to be read in one request: ask for fewer of them." });
      return json(200, { files });
    }
    if (route === "/files/commit") {
      if (body.changes.length > limits.commitChanges) return json(413, { code: "too_many_changes", message: "Too many changes." });
      try {
        return json(200, { revision: String((await store.commit(body.changes, body.message)).revision) });
      } catch (error) {
        return json(error.name === "BookConflictError" ? 409 : 500, { code: "x", message: error.message });
      }
    }
    return json(404, { code: "not_found", message: route });
  };
  return { fetch, requests };
}

function remoteOf(store, limits) {
  const server = fakeServer(store, limits);
  const client = new NarrariumServerClient({ baseUrl: "http://127.0.0.1:24242", token: "t", fetch: server.fetch });
  return { remote: remoteBookStore(client, "book-1"), requests: server.requests, server };
}

test("remoteBookStore.readMany reads in chunks of at most 50 paths, keeps the order, omits missing files", async () => {
  const store = new MemoryBookStore(manyFiles(120));
  const { remote, requests } = remoteOf(store);
  assert.equal(typeof remote.readMany, "function");
  const paths = Object.keys(store.toObject()).reverse();
  const files = await remote.readMany([...paths, "notes/missing.md"]);
  assert.deepEqual(files.map((file) => file.path), paths, "in the order asked");
  assert.deepEqual(requests.map((request) => request.paths.length), [50, 50, 21], "three requests instead of 121");
  assert.equal(files[0].content, store.files.get(paths[0]));
  assert.equal(files[0].hash, (await store.read(paths[0])).hash);
  assert.deepEqual(await remote.readMany([]), []);
  assert.equal(requests.length, 3, "nothing to read, no request");
  assert.deepEqual((await remote.readMany(["notes/note-00001.md", "notes/note-00001.md"])).map((file) => file.path), ["notes/note-00001.md"], "a path asked twice is read once");
  assert.equal((await remote.read("notes/note-00002.md")).content, "Note 2.", "read() is unchanged");
  assert.equal(await remote.read("notes/missing.md"), null);
});

test("a chunk the server answers 413 is retried in halves, down to one path, and the order survives", async () => {
  const store = new MemoryBookStore(manyFiles(120, "chapters/big", (index) => `${index % 10}`.repeat(1 * MIB)));
  const { remote, requests } = remoteOf(store);
  const paths = Object.keys(store.toObject());
  const files = await remote.readMany(paths);
  assert.deepEqual(files.map((file) => file.path), paths);
  assert.ok(files.every((file) => file.content.length === 1 * MIB));
  assert.ok(requests.every((request) => request.paths.length <= 50), "never more than 50 paths");
  assert.deepEqual(requests.slice(0, 4).map((request) => request.paths.length), [50, 25, 13, 12], "50 refused, then 25 refused, then 13 and 12 accepted");
  const accepted = requests.filter((request) => request.paths.length <= 16);
  assert.equal(accepted.reduce((sum, request) => sum + request.paths.length, 0) >= 120, true);
  assert.ok(requests.length > 3 && requests.length < 40, `${requests.length} requests`);
});

test("a single path the server still refuses is an error, not a loop; other errors are not retried", async () => {
  const store = new MemoryBookStore({ "chapters/huge.md": "x".repeat(2 * MIB), "notes/a.md": "a" });
  const { remote, requests } = remoteOf(store, { ...SERVER_LIMITS, readBytes: 1 * MIB });
  await assert.rejects(() => remote.readMany(["chapters/huge.md"]), (error) => error instanceof ServerRequestError && error.status === 413);
  assert.equal(requests.length, 1, "one path cannot be split");
  await assert.rejects(() => remote.readMany(["notes/a.md", "chapters/huge.md"]), (error) => error instanceof ServerRequestError && error.status === 413);
  assert.deepEqual(requests.slice(1).map((request) => request.paths.length), [2, 1, 1], "the pair is halved and the large file still fails alone");

  let calls = 0;
  const broken = new NarrariumServerClient({
    baseUrl: "http://127.0.0.1:24242",
    token: "t",
    fetch: async () => {
      calls += 1;
      return new Response(JSON.stringify({ code: "boom", message: "The server broke." }), { status: 500 });
    },
  });
  await assert.rejects(() => remoteBookStore(broken, "book-1").readMany(["a.md", "b.md"]), (error) => error instanceof ServerRequestError && error.status === 500);
  assert.equal(calls, 1);
});

test("a server that accepts fewer paths per request than 50 is handled too", async () => {
  const store = new MemoryBookStore(manyFiles(70));
  const { remote, requests } = remoteOf(store, { ...SERVER_LIMITS, readPaths: 20 });
  const files = await remote.readMany(Object.keys(store.toObject()));
  assert.equal(files.length, 70);
  assert.ok(requests.some((request) => request.paths.length > 20), "the first request was refused");
  assert.deepEqual(files.map((file) => file.path), Object.keys(store.toObject()));
});

test("syncing a book through the server's HTTP API takes a few requests, not one per file", async () => {
  const remoteStore = new MemoryBookStore(manyFiles(1050));
  const { remote, requests } = remoteOf(remoteStore);
  const local = new MemoryBookStore();
  const downloaded = await syncBookStores({ local, remote, base: new Map() });
  assert.equal(downloaded.downloaded.length, 1050);
  assert.equal(local.files.size, 1050);
  assert.equal(requests.filter((request) => request.route === "/files/read").length, 21, "1050 / 50 read requests");
  local.write("notes/new.md", "New.");
  const uploading = new MemoryBookStore();
  const { remote: target, requests: uploads } = remoteOf(uploading);
  await syncBookStores({ local, remote: target, base: new Map() });
  assert.equal(uploading.files.size, 1051);
  assert.deepEqual(uploads.filter((request) => request.route === "/files/commit").map((request) => request.changes), [400, 400, 251], "three commits of at most 400 changes");
});

test("a progress listener that throws does not break the sync", async () => {
  const local = new MemoryBookStore(manyFiles(900));
  const remote = new MemoryBookStore();
  let calls = 0;
  const result = await syncBookStores({
    local,
    remote,
    base: new Map(),
    onProgress: () => {
      calls += 1;
      throw new Error("The listener failed.");
    },
  });
  assert.equal(result.uploaded.length, 900);
  assert.equal(remote.files.size, 900);
  assert.equal(calls, 3, "it was still called after every chunk");
});
