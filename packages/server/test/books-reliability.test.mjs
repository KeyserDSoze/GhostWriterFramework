import test from "node:test";
import { seedBookFilesWithChapters } from "./fake-provider.mjs";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdir, mkdtemp, readdir, readFile, rm, stat, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { seedBookFiles } from "narrarium-engine/testing";
import * as testing from "../dist/testing.mjs";
import { gatedAi, until, withServer } from "./helpers.mjs";

const { DataDirectory, GitRepository } = testing;
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const remove = (...directories) => Promise.all(directories.map((directory) => rm(directory, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 })));
const temporary = (prefix = "narrarium-books-") => mkdtemp(path.join(os.tmpdir(), prefix));
const exists = (file) => stat(file).then(() => true, () => false);
const git = (cwd, ...args) => execFileSync("git", ["-c", "user.name=test", "-c", "user.email=test@example.invalid", "-C", cwd, ...args], { encoding: "utf8" });
const GITHUB = { kind: "github", owner: "me", repo: "remote", branch: "main" };

/** A bare repository with one commit on `main`, standing in for GitHub. */
async function seedOrigin(files = seedBookFilesWithChapters()) {
  const origin = await temporary("narrarium-origin-");
  const seed = await temporary("narrarium-seed-");
  execFileSync("git", ["init", "--quiet", "--bare", origin]);
  execFileSync("git", ["init", "--quiet", "-b", "main", seed]);
  for (const [file, content] of Object.entries(files)) {
    await mkdir(path.dirname(path.join(seed, file)), { recursive: true });
    await writeFile(path.join(seed, file), content);
  }
  git(seed, "add", "-A");
  git(seed, "commit", "--quiet", "-m", "seed");
  git(seed, "push", "--quiet", origin, "main");
  return { origin, seed };
}

/** Count what is running at the same time among the methods of `GitRepository` that change a working copy (and run them slowly). */
function watchGit(methods, delayMs = 60) {
  const originals = new Map();
  const state = { active: 0, max: 0, calls: [] };
  for (const method of methods) {
    const original = GitRepository.prototype[method];
    originals.set(method, original);
    GitRepository.prototype[method] = async function (...args) {
      state.active += 1;
      state.max = Math.max(state.max, state.active);
      state.calls.push(method);
      try {
        await sleep(delayMs);
        return await original.apply(this, args);
      } finally {
        state.active -= 1;
      }
    };
  }
  return { state, restore: () => originals.forEach((original, method) => {
    GitRepository.prototype[method] = original;
  }) };
}

// ---------------------------------------------------------------------------------------------
// R5: one thing at a time in a book's working copy
// ---------------------------------------------------------------------------------------------

test("R5: two syncs of one book never run git at the same time (they used to collide on index.lock)", async () => {
  const seeded = await seedOrigin();
  const watch = watchGit(["pull", "push"]);
  try {
    await withServer(async (server, client) => {
      await client.registerBook("gh", { title: "Remote", storage: GITHUB, githubToken: "ghp_x" });
      watch.state.calls.length = 0;
      watch.state.max = 0;
      const results = await Promise.all([client.syncGitHub("gh"), client.syncGitHub("gh"), client.syncGitHub("gh")]);
      assert.equal(results.length, 3);
      assert.equal(watch.state.max, 1, `${watch.state.calls.join(",")}: at most one git operation at a time`);
      assert.ok(watch.state.calls.filter((call) => call === "pull").length >= 3, "all three really ran");
    }, { githubRemoteUrl: () => seeded.origin });
  } finally {
    watch.restore();
    await remove(seeded.origin, seeded.seed);
  }
});

test("R5: a sync waits for a commit in progress, and a commit for a sync (the working copy has one writer)", async () => {
  const seeded = await seedOrigin();
  const watch = watchGit(["pull", "push", "commit"], 80);
  try {
    await withServer(async (server, client) => {
      await client.registerBook("gh", { title: "Remote", storage: GITHUB, githubToken: "ghp_x" });
      watch.state.max = 0;
      watch.state.calls.length = 0;
      await Promise.all([
        client.commitFiles("gh", [{ path: "notes/one.md", content: "one\n" }], "one"),
        client.syncGitHub("gh"),
        client.commitFiles("gh", [{ path: "notes/two.md", content: "two\n" }], "two"),
        client.syncGitHub("gh"),
      ]);
      assert.equal(watch.state.max, 1, watch.state.calls.join(","));
      const files = (await client.manifest("gh")).files.map((file) => file.path);
      assert.ok(files.includes("notes/one.md") && files.includes("notes/two.md"), "both commits are there");
    }, { githubRemoteUrl: () => seeded.origin });
  } finally {
    watch.restore();
    await remove(seeded.origin, seeded.seed);
  }
});

test("R5: the autopilot's own pull before a step is serialized with a manual sync too", async () => {
  const seeded = await seedOrigin();
  const slow = gatedAi();
  const watch = watchGit(["pull", "push"], 150);
  try {
    await withServer(async (server, client) => {
      await client.registerBook("gh", { title: "Remote", storage: GITHUB, githubToken: "ghp_x" });
      watch.state.max = 0;
      watch.state.calls.length = 0;
      const syncs = [];
      await client.startAutopilot("gh", { brief: { idea: "A harbor", targetChapters: 1, scenesPerChapter: 1 }, options: { readers: false, readersOnPlan: false } });
      for (let index = 0; index < 4; index += 1) syncs.push(client.syncGitHub("gh").catch((error) => error));
      await slow.started;
      await Promise.all(syncs);
      assert.equal(watch.state.max, 1, `pull/push of the run and of the syncs: ${watch.state.calls.join(",")}`);
      await client.pauseAutopilot("gh", "now");
      slow.release();
      await until(async () => !(await client.autopilot("gh")).running);
    }, { githubRemoteUrl: () => seeded.origin, ai: slow.ai });
  } finally {
    slow.release();
    watch.restore();
    await remove(seeded.origin, seeded.seed);
  }
});

// ---------------------------------------------------------------------------------------------
// R12: the revision of a book is not asked of git every time somebody lists the books
// ---------------------------------------------------------------------------------------------

/** Count the `git rev-parse` processes the server starts. */
function countRevParse() {
  const original = GitRepository.prototype.git;
  const state = { count: 0 };
  GitRepository.prototype.git = function (args, ...rest) {
    if (Array.isArray(args) && args[0] === "rev-parse") state.count += 1;
    return original.call(this, args, ...rest);
  };
  return { state, restore: () => {
    GitRepository.prototype.git = original;
  } };
}

test("R12: listing the books many times asks git about each book once, and a change shows at once", async () => {
  const counter = countRevParse();
  try {
    await withServer(async (server, client) => {
      const ids = ["a", "b", "c", "d", "e"];
      for (const id of ids) await client.registerBook(id, { title: id, storage: { kind: "local" } });
      await client.commitFiles("a", [{ path: "notes.md", content: "one\n" }], "one");
      const first = await client.listBooks();
      const settled = counter.state.count;
      for (let index = 0; index < 20; index += 1) await client.listBooks();
      assert.equal(counter.state.count, settled, `no git process for 20 more listings (${counter.state.count - settled} started)`);
      assert.equal((await server.books.summaries()).length, 5, "the admin panel's listing too");
      assert.equal(counter.state.count, settled);

      // A commit through the API changes the revision at once.
      const before = first.find((book) => book.bookId === "a").revision;
      const committed = await client.commitFiles("a", [{ path: "notes.md", content: "two\n", expectedHash: undefined }], "two");
      const after = (await client.listBooks()).find((book) => book.bookId === "a").revision;
      assert.notEqual(after, before);
      assert.equal(after, committed.revision, "the revision the commit answered is the one that is listed");
      assert.equal((await client.listBooks()).find((book) => book.bookId === "b").revision, first.find((book) => book.bookId === "b").revision, "another book is untouched");

      // Somebody commits in the working copy with git itself: the listing sees that too.
      git(server.data.bookDirectory("c"), "commit", "--allow-empty", "--quiet", "-m", "by hand");
      const byHand = (await client.listBooks()).find((book) => book.bookId === "c").revision;
      assert.equal(byHand, git(server.data.bookDirectory("c"), "rev-parse", "HEAD").trim());
      assert.notEqual(byHand, first.find((book) => book.bookId === "c").revision);
    });
  } finally {
    counter.restore();
  }
});

test("R12: a book that has no commit yet is listed with a content revision, and gets its git revision with its first commit", async () => {
  await withServer(async (server, client) => {
    const empty = await client.registerBook("fresh", { title: "Fresh", storage: { kind: "local" } });
    assert.match(empty.revision, /^[0-9a-f]{16}$/, "no commit yet: the content hash");
    assert.equal((await client.listBooks())[0].revision, empty.revision);
    const committed = await client.commitFiles("fresh", [{ path: "notes.md", content: "x\n" }], "first");
    assert.match(committed.revision, /^[0-9a-f]{40}$/);
    assert.equal((await client.listBooks())[0].revision, committed.revision);
  });
});

// ---------------------------------------------------------------------------------------------
// R13: registering a book works, or changes nothing
// ---------------------------------------------------------------------------------------------

async function snapshotOf(server, bookId) {
  return {
    books: (await server.data.books()).map((book) => book.bookId),
    token: await server.data.bookToken(bookId),
    folder: await exists(server.data.bookDirectory(bookId)),
    parent: await exists(path.dirname(server.data.bookDirectory(bookId))),
    listed: (await server.books.summaries()).map((book) => book.bookId),
  };
}

test("R13: a new book whose first clone fails leaves nothing behind: no registration, no token, no folder, no runtime", async () => {
  const missing = path.join(await temporary("narrarium-missing-"), "no-such-remote.git");
  try {
    await withServer(async (server, client) => {
      await assert.rejects(() => client.registerBook("late", { title: "Late", storage: GITHUB, githubToken: "ghp_kept_for_nothing" }), (error) => error.status === 502 && error.code === "repository_unavailable");
      const after = await snapshotOf(server, "late");
      assert.deepEqual(after.books, []);
      assert.equal(after.token, undefined, "the token of a registration that did not happen is not kept");
      assert.equal(after.folder, false);
      assert.equal(after.parent, false, "not even the empty folder around it");
      assert.deepEqual(after.listed, []);
      assert.deepEqual(await client.listBooks(), []);
      await assert.rejects(() => client.autopilot("late"), (error) => error.status === 404);
    }, { githubRemoteUrl: () => missing });
  } finally {
    await remove(path.dirname(missing));
  }
});

test("R13: the registration is undone when storing it fails halfway: a stored token is put back, no entry and no folder remain, and a retry works", async () => {
  await withServer(async (server, client) => {
    const realSave = server.data.saveBook.bind(server.data);
    let failures = 1;
    server.data.saveBook = async (book) => {
      if (failures-- > 0) throw new Error("disk full");
      return realSave(book);
    };
    await assert.rejects(() => client.registerBook("half", { title: "Half", storage: { kind: "local" }, githubToken: "ghp_first" }), (error) => error.status === 500);
    const after = await snapshotOf(server, "half");
    assert.deepEqual(after.books, [], "no entry");
    assert.equal(after.token, undefined, "the token that was written first is gone again");
    assert.equal(after.folder, false, "no working copy");
    assert.deepEqual(after.listed, [], "no runtime");
    const retried = await client.registerBook("half", { title: "Half", storage: { kind: "local" }, githubToken: "ghp_first" });
    assert.equal(retried.hasGithubToken, true);
    assert.deepEqual((await client.listBooks()).map((book) => book.bookId), ["half"]);
  });

  await withServer(async (server, client) => {
    const real = server.data.setBookToken.bind(server.data);
    server.data.setBookToken = async () => {
      throw new Error("vault locked");
    };
    await assert.rejects(() => client.registerBook("tok", { title: "T", storage: { kind: "local" }, githubToken: "ghp_x" }), (error) => error.status === 500);
    server.data.setBookToken = real;
    const after = await snapshotOf(server, "tok");
    assert.deepEqual(after.books, []);
    assert.equal(after.folder, false);
  });
});

test("R13: re-registering a book whose entry cannot be stored keeps the token it had", async () => {
  await withServer(async (server, client) => {
    await client.registerBook("kept", { title: "Kept", storage: { kind: "local" }, githubToken: "ghp_original" });
    const realSave = server.data.saveBook.bind(server.data);
    server.data.saveBook = async () => {
      throw new Error("disk full");
    };
    await assert.rejects(() => client.registerBook("kept", { title: "Renamed", storage: { kind: "local" }, githubToken: "ghp_replacement" }), (error) => error.status === 500);
    server.data.saveBook = realSave;
    assert.equal(await server.data.bookToken("kept"), "ghp_original", "the earlier token is back");
    assert.equal((await client.listBooks())[0].title, "Kept");
  });
});

test("R13: a move to another storage that cannot be stored leaves the working copy, the registration and the token as they were", async () => {
  const seeded = await seedOrigin();
  try {
    await withServer(async (server, client) => {
      await client.registerBook("m", { title: "M", storage: { kind: "local" }, githubToken: "ghp_before" });
      await client.commitFiles("m", [{ path: "mine.md", content: "only here\n" }], "mine");
      const folder = server.data.bookDirectory("m");
      const head = git(folder, "rev-parse", "HEAD");
      const realSave = server.data.saveBook.bind(server.data);
      server.data.saveBook = async () => {
        throw new Error("disk full");
      };
      await assert.rejects(() => client.registerBook("m", { title: "M", storage: GITHUB, githubToken: "ghp_after" }), (error) => error.status === 500);
      server.data.saveBook = realSave;
      assert.equal(await readFile(path.join(folder, "mine.md"), "utf8"), "only here\n", "the old working copy is in place");
      assert.equal(git(folder, "rev-parse", "HEAD"), head);
      assert.equal(await server.data.bookToken("m"), "ghp_before");
      assert.equal((await client.listBooks())[0].storage.kind, "local");
      assert.deepEqual((await readdir(path.dirname(folder))).sort(), ["repo"], "no half-built clone is left");
      assert.equal(await exists(path.join(server.data.root, "books", ".trash")), false, "and nothing was thrown away");
      // The move still works afterwards.
      const moved = await client.registerBook("m", { title: "M", storage: GITHUB, githubToken: "ghp_after" });
      assert.equal(moved.storage.kind, "github");
    }, { githubRemoteUrl: () => seeded.origin });
  } finally {
    await remove(seeded.origin, seeded.seed);
  }
});

test("R13: a retry after a failed first clone starts clean and works", async () => {
  const seeded = await seedOrigin({ "book.md": "---\ntitle: T\n---\n" });
  const missing = await temporary("narrarium-missing-");
  let remote = path.join(missing, "not-yet.git");
  try {
    await withServer(async (server, client) => {
      await assert.rejects(() => client.registerBook("late", { title: "Late", storage: GITHUB, githubToken: "ghp_x" }), (error) => error.status === 502);
      assert.deepEqual(await client.listBooks(), []);
      remote = seeded.origin;
      const retried = await client.registerBook("late", { title: "Late", storage: GITHUB, githubToken: "ghp_x" });
      assert.equal(retried.lastSync.ok, true);
      assert.equal(await exists(path.join(server.data.bookDirectory("late"), "book.md")), true);
      assert.deepEqual((await readdir(path.dirname(server.data.bookDirectory("late")))).sort(), ["repo"]);
    }, { githubRemoteUrl: () => remote });
  } finally {
    await remove(seeded.origin, seeded.seed, missing);
  }
});

// ---------------------------------------------------------------------------------------------
// R14: ids that a Windows computer cannot keep
// ---------------------------------------------------------------------------------------------

const RESERVED = ["con", "CON", "prn", "aux", "nul", "NUL", "com0", "com1", "COM9", "lpt0", "lpt1", "LPT9", "con.txt", "NUL.md", "aux.tar.gz", "com1.x", "Lpt3.backup", "LPT0.log"];
const BAD_ENDINGS = ["a.", "book..", "...", "x.y."];
const FINE = ["console", "auxiliary", "nullable", "com10", "lpt10", "com", "con-x", "my.book", "book_1", "a-b.c", "1984", "Z", "constructors", "Constructor"];

test("R14: a new book id may not be a reserved device name, end with a dot, or start with one", async () => {
  await withServer(async (server, client) => {
    // `__proto__`, `constructor` and `prototype` are keys that the files of the data folder refuse: a book called so would make the stored GitHub tokens of every book unreadable.
    for (const id of [...RESERVED, ...BAD_ENDINGS, ".git", ".GIT", ".hidden", ".trash", "__proto__", "constructor", "prototype"]) {
      await assert.rejects(() => client.registerBook(id, { title: "T", storage: { kind: "local" } }), (error) => error.status === 400 && error.code === "invalid_book", `${id} is refused`);
    }
    assert.deepEqual(await client.listBooks(), [], "and none of them was registered");
    for (const id of FINE) {
      const summary = await client.registerBook(id, { title: id, storage: { kind: "local" } });
      assert.equal(summary.bookId, id, `${id} is fine`);
    }
    assert.equal((await client.listBooks()).length, FINE.length);
  });
});

test("R14: books that were registered under such an id before keep working: listed, changed, removed", { skip: process.platform === "win32" && "Windows never let such a book be made, so none can be there from before" }, async () => {
  const dataDir = await temporary("narrarium-old-ids-");
  try {
    const now = new Date().toISOString();
    const old = ["nul", "a.", "aux.md"].map((bookId) => ({ bookId, title: `Old ${bookId}`, storage: { kind: "local" }, createdAt: now, updatedAt: now }));
    await writeFile(path.join(dataDir, "books.json"), JSON.stringify({ books: old }));
    const server = await testing.startNarrariumServer({ dataDir, port: 0, adminPort: 0, supervised: false, checkRelease: async (v) => ({ packageName: "narrarium-server", installedVersion: v, available: false, signed: false, reason: "not_published", message: "x" }), tunnel: { findBinary: () => undefined, detectOtherConnectors: async () => [] } });
    try {
      const { token } = await server.auth.issue("writer", ["read", "write"]);
      const call = (method, route, body) => fetch(`${server.url}${route}`, { method, headers: { authorization: `Bearer ${token}`, "content-type": "application/json" }, body: body === undefined ? undefined : JSON.stringify(body) });
      const listed = await (await call("GET", "/api/v1/books")).json();
      assert.deepEqual(listed.books.map((book) => book.bookId).sort(), ["a.", "aux.md", "nul"]);
      assert.equal((await call("PUT", "/api/v1/books/nul", { title: "Renamed", storage: { kind: "local" } })).status, 200, "an existing book can be updated");
      assert.equal((await call("DELETE", "/api/v1/books/aux.md")).status, 200, "and removed");
      assert.equal((await call("PUT", "/api/v1/books/con", { title: "New", storage: { kind: "local" } })).status, 400, "while a new one with such an id is refused");
    } finally {
      await server.close();
    }
  } finally {
    await remove(dataDir);
  }
});
