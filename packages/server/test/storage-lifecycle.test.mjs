import test from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { chmod, lstat, mkdir, mkdtemp, readFile, readdir, rm, symlink, utimes, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { remoteBookStore, syncBookStores } from "narrarium-engine";
import { MemoryBookStore, seedBookFiles } from "narrarium-engine/testing";
import { DataDirectory, GitError, GitRepository, runGit, startNarrariumServer } from "../dist/testing.mjs";
import { gatedAi, noRelease, until, withServer } from "./helpers.mjs";

const posix = process.platform !== "win32";
const DAY = 24 * 60 * 60 * 1000;

const temporary = (prefix = "narrarium-lifecycle-") => mkdtemp(path.join(os.tmpdir(), prefix));
const remove = (...directories) => Promise.all(directories.map((directory) => rm(directory, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 })));
const exists = (file) => lstat(file).then(() => true, () => false);
const git = (cwd, ...args) => execFileSync("git", ["-c", "user.name=test", "-c", "user.email=test@example.invalid", "-C", cwd, ...args], { encoding: "utf8" });

async function link(target, location) {
  if (!posix) return false;
  try {
    await symlink(target, location);
    return true;
  } catch (error) {
    if (error.code === "EPERM" || error.code === "EACCES" || error.code === "ENOSYS") return false;
    throw error;
  }
}

/** A bare repository holding one commit on `main`; `links` (name -> target) are symbolic links in that commit. */
async function seedOrigin(files, links = {}) {
  const origin = await temporary("narrarium-origin-");
  const seed = await temporary("narrarium-seed-");
  execFileSync("git", ["init", "--quiet", "--bare", origin]);
  execFileSync("git", ["init", "--quiet", "-b", "main", seed]);
  for (const [file, content] of Object.entries(files)) {
    await mkdir(path.dirname(path.join(seed, file)), { recursive: true });
    await writeFile(path.join(seed, file), content);
  }
  let linked = true;
  for (const [name, target] of Object.entries(links)) linked = (await link(target, path.join(seed, name))) && linked;
  git(seed, "add", "-A");
  git(seed, "commit", "--quiet", "-m", "seed");
  git(seed, "push", "--quiet", origin, "main");
  return { origin, seed, linked };
}

const GITHUB = { kind: "github", owner: "me", repo: "remote", branch: "main" };
/** A remote that does not exist: a test that must never clone points GitHub books here, so it cannot reach the network. */
const NO_REMOTE = () => path.join(os.tmpdir(), "narrarium-no-such-remote", "remote.git");

// ---------------------------------------------------------------------------------------------
// C5: registering a running book again must not detach its autopilot
// ---------------------------------------------------------------------------------------------

test("C5: re-registering a running book keeps its run, its count and its pause button", async () => {
  const slow = gatedAi();
  try {
    await withServer(async (server, client) => {
      await client.registerBook("busy", { title: "Busy", storage: { kind: "local" } });
      await syncBookStores({ local: new MemoryBookStore(seedBookFiles()), remote: remoteBookStore(client, "busy"), base: new Map() });
      await client.startAutopilot("busy", { brief: { idea: "A busy harbor", targetChapters: 1, scenesPerChapter: 1 }, options: { readers: false, readersOnPlan: false } });
      await slow.started;
      assert.equal(server.books.runningCount(), 1);

      const again = await client.registerBook("busy", { title: "Busy (renamed)", storage: { kind: "local" }, githubToken: "ghp_new_token" });
      assert.equal(again.running, true, "the summary still shows the run");
      assert.equal(again.title, "Busy (renamed)", "the metadata is updated");
      assert.equal(again.hasGithubToken, true, "a newly sent token is stored");
      const listed = (await client.listBooks()).find((book) => book.bookId === "busy");
      assert.equal(listed.running, true);
      assert.equal(listed.title, "Busy (renamed)");
      assert.equal(server.books.runningCount(), 1, "the update guard and the run limit still see it");
      assert.equal((await client.autopilot("busy")).running, true);

      await assert.rejects(() => client.startAutopilot("busy"), (error) => error.status === 409, "a second run on the same folder is refused");
      assert.equal(server.books.runningCount(), 1);

      const paused = await client.pauseAutopilot("busy", "now");
      assert.ok(paused);
      slow.release();
      await until(async () => !(await client.autopilot("busy")).running);
      assert.equal(server.books.runningCount(), 0);
      assert.equal((await client.listBooks())[0].running, false);
    }, { ai: slow.ai });
  } finally {
    slow.release();
  }
});

test("C5: moving a running book to another storage is still refused", async () => {
  const slow = gatedAi();
  try {
    await withServer(async (server, client) => {
      await client.registerBook("busy", { title: "Busy", storage: { kind: "local" } });
      await syncBookStores({ local: new MemoryBookStore(seedBookFiles()), remote: remoteBookStore(client, "busy"), base: new Map() });
      await client.startAutopilot("busy", { brief: { idea: "A busy harbor", targetChapters: 1, scenesPerChapter: 1 }, options: { readers: false, readersOnPlan: false } });
      await slow.started;
      await assert.rejects(() => client.registerBook("busy", { title: "Busy", storage: GITHUB, githubToken: "ghp_x" }), (error) => error.status === 409 && error.code === "busy");
      assert.equal((await client.listBooks())[0].storage.kind, "local");
      assert.equal(server.books.runningCount(), 1);
      await client.pauseAutopilot("busy", "now");
      slow.release();
      await until(async () => !(await client.autopilot("busy")).running);
    }, { ai: slow.ai, githubRemoteUrl: NO_REMOTE });
  } finally {
    slow.release();
  }
});

test("C5: a running GitHub book is not cloned or synced again when it is re-registered", async () => {
  const slow = gatedAi();
  const seeded = await seedOrigin(seedBookFiles());
  try {
    await withServer(async (server, client) => {
      await client.registerBook("gh", { title: "Remote", storage: GITHUB, githubToken: "ghp_first" });
      await client.startAutopilot("gh", { brief: { idea: "x", targetChapters: 1, scenesPerChapter: 1 }, options: { readers: false, readersOnPlan: false, pauseAfterPlan: false } });
      await slow.started;
      // The remote disappears: a pull would now fail, so a re-registration that synced would be refused.
      await remove(seeded.origin);
      const again = await client.registerBook("gh", { title: "Remote (renamed)", storage: GITHUB, githubToken: "ghp_second" });
      assert.equal(again.running, true);
      assert.equal(again.title, "Remote (renamed)");
      assert.equal(again.error, undefined);
      assert.equal(server.books.runningCount(), 1);
      await client.pauseAutopilot("gh", "now");
      slow.release();
      await until(async () => !(await client.autopilot("gh")).running);
    }, { ai: slow.ai, githubRemoteUrl: () => seeded.origin });
  } finally {
    slow.release();
    await remove(seeded.origin, seeded.seed);
  }
});

// ---------------------------------------------------------------------------------------------
// C12: git runs in a private environment
// ---------------------------------------------------------------------------------------------

test("C12: git ignores the owner's global configuration: hooks, URL rewrites and credentials", async () => {
  const owner = await temporary("narrarium-owner-home-");
  const work = await temporary();
  const seeded = await seedOrigin({ "a.md": "from the rewritten remote\n" });
  const saved = Object.fromEntries(["HOME", "USERPROFILE", "XDG_CONFIG_HOME", "GIT_CONFIG_GLOBAL"].map((name) => [name, process.env[name]]));
  try {
    const hooks = path.join(owner, "hooks");
    const marker = path.join(owner, "hook-ran.txt");
    await mkdir(hooks);
    const slashes = (value) => value.replace(/\\/g, "/");
    if (posix) {
      await writeFile(path.join(hooks, "post-commit"), `#!${process.execPath}\nrequire("node:fs").writeFileSync(${JSON.stringify(marker)}, "ran");\n`);
      await chmod(path.join(hooks, "post-commit"), 0o755);
    }
    const globalConfig = path.join(owner, ".gitconfig");
    await writeFile(globalConfig, `[core]\n\thooksPath = ${slashes(hooks)}\n[url "${slashes(seeded.origin)}"]\n\tinsteadOf = https://127.0.0.1:1/attacker/evil.git\n`);
    Object.assign(process.env, { HOME: owner, USERPROFILE: owner, XDG_CONFIG_HOME: owner, GIT_CONFIG_GLOBAL: globalConfig });

    // The rewrite would turn this unreachable address into the local repository.
    const cloned = new GitRepository(path.join(work, "clone"), { owner: "attacker", repo: "evil", branch: "main", token: () => "ghp_THE_TOKEN", url: "https://127.0.0.1:1/attacker/evil.git" });
    await assert.rejects(() => cloned.clone(), GitError);
    assert.equal(await exists(path.join(work, "clone", "a.md")), false, "the owner's url.insteadOf rewrite was ignored");

    const local = new GitRepository(path.join(work, "local"));
    await local.init();
    await writeFile(path.join(work, "local", "a.md"), "x\n");
    assert.ok(await local.commit(["a.md"], "first"));
    assert.equal(await exists(marker), false, "the owner's post-commit hook never ran");

    await assert.rejects(() => runGit(["config", "--get-regexp", "^url\\."], { cwd: path.join(work, "local") }), GitError, "no URL rewrite is configured");
    const origins = (await runGit(["config", "--show-origin", "--get-all", "core.hooksPath"], { cwd: path.join(work, "local") })).stdout;
    assert.ok(!origins.includes(".gitconfig"), `the hooks path does not come from the owner's configuration: ${origins}`);
    assert.ok(!origins.includes(slashes(hooks)));
  } finally {
    for (const [name, value] of Object.entries(saved)) {
      if (value === undefined) delete process.env[name];
      else process.env[name] = value;
    }
    await remove(owner, work, seeded.origin, seeded.seed);
  }
});

test("C12: the registry gives git a private home inside the data folder", async () => {
  const seeded = await seedOrigin({ "book.md": "---\ntitle: T\n---\n" });
  try {
    await withServer(async (server, client, dataDir) => {
      await client.registerBook("gh", { title: "Remote", storage: GITHUB, githubToken: "ghp_secret_token" });
      const home = path.join(dataDir, "private", "git-home");
      assert.equal((await lstat(home)).isDirectory(), true, "created on demand");
      assert.equal(await readFile(path.join(home, "gitconfig"), "utf8"), "", "an empty global configuration");
      assert.deepEqual(await readdir(path.join(home, "hooks")), [], "an empty hooks directory");
      if (posix) assert.equal((await lstat(home)).mode & 0o777, 0o700);
      const config = await readFile(path.join(server.data.bookDirectory("gh"), ".git", "config"), "utf8");
      assert.ok(!config.includes("ghp_secret_token"), "the token never reaches the repository configuration");
      assert.match(config, /symlinks\s*=\s*false/);
    }, { githubRemoteUrl: () => seeded.origin });
  } finally {
    await remove(seeded.origin, seeded.seed);
  }
});

test("C12: a clone never creates symbolic links, and a new repository is told not to", async (t) => {
  const work = await temporary();
  const seeded = await seedOrigin({ "book.md": "---\ntitle: T\n---\n" }, { "link.md": "/etc/hostname", x: "../../.." });
  try {
    if (!seeded.linked) return t.skip("this system does not allow symbolic links");
    const repository = new GitRepository(path.join(work, "clone"), { owner: "o", repo: "r", branch: "main", token: () => undefined, url: seeded.origin });
    await repository.clone();
    for (const name of ["link.md", "x"]) {
      const info = await lstat(path.join(work, "clone", name));
      assert.equal(info.isSymbolicLink(), false, `${name} is a plain file`);
      assert.equal(info.isFile(), true);
    }
    assert.equal((await runGit(["config", "--local", "--get", "core.symlinks"], { cwd: path.join(work, "clone") })).stdout.trim(), "false");

    const fresh = new GitRepository(path.join(work, "fresh"));
    await fresh.init();
    assert.equal((await runGit(["config", "--local", "--get", "core.symlinks"], { cwd: path.join(work, "fresh") })).stdout.trim(), "false");
  } finally {
    await remove(work, seeded.origin, seeded.seed);
  }
});

test("C12: a branch that could be read as a git option is refused", async () => {
  const unreachable = path.join(await temporary("narrarium-missing-"), "no-such-remote.git");
  try {
    await withServer(async (_server, client) => {
      for (const branch of ["-x", "--no-tags", "-", "--upload-pack"]) {
        await assert.rejects(() => client.registerBook("b", { title: "B", storage: { kind: "github", owner: "o", repo: "r", branch }, githubToken: "ghp_x" }), (error) => error.status === 400 && error.code === "invalid_storage", branch);
      }
      assert.deepEqual(await client.listBooks(), []);
    }, { githubRemoteUrl: () => unreachable });
  } finally {
    await remove(path.dirname(unreachable));
  }
});

// ---------------------------------------------------------------------------------------------
// R1 / R2: the data folder's files are updated one writer at a time
// ---------------------------------------------------------------------------------------------

test("R1: ten parallel registrations are all kept, with their GitHub tokens, after reopening the data folder", async () => {
  await withServer(async (server, client) => {
    const ids = Array.from({ length: 10 }, (_, index) => `book-${index}`);
    await Promise.all(ids.map((id, index) => client.registerBook(id, { title: `Book ${index}`, storage: { kind: "local" }, githubToken: `ghp_token_${index}` })));
    assert.equal((await client.listBooks()).length, 10);
    const reopened = await DataDirectory.open(server.data.root);
    assert.deepEqual((await reopened.books()).map((book) => book.bookId).sort(), [...ids].sort());
    for (const [index, id] of ids.entries()) assert.equal(await reopened.bookToken(id), `ghp_token_${index}`, id);
  });
});

test("R1: parallel saveBook, setBookToken and removeBook never lose each other's update", async () => {
  await withServer(async (server) => {
    const data = server.data;
    const now = new Date().toISOString();
    const book = (index) => ({ bookId: `parallel-${index}`, title: `Parallel ${index}`, storage: { kind: "local" }, createdAt: now, updatedAt: now });
    await Promise.all([
      ...Array.from({ length: 12 }, (_, index) => data.saveBook(book(index))),
      ...Array.from({ length: 12 }, (_, index) => data.setBookToken(`parallel-${index}`, `ghp_${index}`)),
    ]);
    await Promise.all([data.removeBook("parallel-3"), data.removeBook("parallel-7"), data.saveBook(book(20)), data.setBookToken("parallel-20", "ghp_20")]);
    const reopened = await DataDirectory.open(data.root);
    const kept = (await reopened.books()).map((entry) => entry.bookId);
    assert.deepEqual(kept.sort(), [...Array.from({ length: 12 }, (_, index) => index).filter((index) => index !== 3 && index !== 7), 20].map((index) => `parallel-${index}`).sort());
    assert.equal(await reopened.bookToken("parallel-3"), undefined);
    assert.equal(await reopened.bookToken("parallel-7"), undefined);
    assert.equal(await reopened.bookToken("parallel-5"), "ghp_5");
    assert.equal(await reopened.bookToken("parallel-20"), "ghp_20");
  });
});

test("R2: concurrent configuration updates all survive in memory and on disk", async () => {
  await withServer(async (server) => {
    const data = server.data;
    await Promise.all([
      data.updateConfig((config) => {
        config.origins = [...config.origins, "https://one.example"];
      }),
      data.updateConfig((config) => {
        config.allowedAiBases = [...config.allowedAiBases, "https://two.example"];
      }),
      data.updateConfig((config) => {
        config.pendingAiBases = [...config.pendingAiBases, "https://three.example"];
      }),
      data.updateConfig((config) => {
        config.label = "renamed";
      }),
    ]);
    for (const config of [data.config, (await DataDirectory.open(data.root)).config]) {
      assert.deepEqual(config.origins, ["https://one.example"]);
      assert.deepEqual(config.allowedAiBases, ["https://two.example"]);
      assert.deepEqual(config.pendingAiBases, ["https://three.example"]);
      assert.equal(config.label, "renamed");
    }
    // A change that throws changes nothing, and the next one still applies.
    await assert.rejects(data.updateConfig(() => {
      throw new Error("refused");
    }), /refused/);
    await data.updateConfig((config) => {
      config.origins = [...config.origins, "https://four.example"];
    });
    assert.deepEqual(data.config.origins, ["https://one.example", "https://four.example"]);
  });
});

// ---------------------------------------------------------------------------------------------
// C14: never destroy the only copy of a book
// ---------------------------------------------------------------------------------------------

test("C14: a failed move to GitHub leaves the working copy, its history and the registration untouched", async () => {
  const missing = path.join(await temporary("narrarium-missing-"), "no-such-remote.git");
  try {
    await withServer(async (server, client) => {
      await client.registerBook("m", { title: "M", storage: { kind: "local" } });
      await client.commitFiles("m", [{ path: "chapters/001/chapter.md", content: "AI-written chapter that only exists on the server\n" }], "Autopilot: chapter");
      const folder = server.data.bookDirectory("m");
      await assert.rejects(() => client.registerBook("m", { title: "M", storage: GITHUB, githubToken: "ghp_x" }), (error) => error.status === 502 && error.code === "repository_unavailable");
      assert.equal(await readFile(path.join(folder, "chapters", "001", "chapter.md"), "utf8"), "AI-written chapter that only exists on the server\n");
      assert.match(git(folder, "log", "--oneline"), /Autopilot: chapter/);
      const [summary] = await client.listBooks();
      assert.equal(summary.storage.kind, "local", "the book is still local");
      assert.equal(summary.hasGithubToken, false, "the token of the failed move was not kept");
      assert.equal(summary.error, undefined);
      assert.deepEqual((await readdir(path.dirname(folder))).sort(), ["repo"], "no half-built clone is left next to the copy");
      assert.deepEqual((await (await DataDirectory.open(server.data.root)).books()).map((book) => book.storage.kind), ["local"]);
      assert.equal(await exists(path.join(server.data.root, "books", ".trash")), false, "nothing was thrown away");
      // The book still works.
      await client.commitFiles("m", [{ path: "notes.md", content: "still here\n" }], "after");
    }, { githubRemoteUrl: () => missing });
  } finally {
    await remove(path.dirname(missing));
  }
});

test("C14: a successful move builds the new copy first and puts the old one in the trash", async () => {
  const seeded = await seedOrigin({ "book.md": "---\ntitle: T\n---\n" });
  try {
    await withServer(async (server, client) => {
      await client.registerBook("m", { title: "M", storage: { kind: "local" } });
      await client.commitFiles("m", [{ path: "local-only.md", content: "only on the server\n" }], "local work");
      const moved = await client.registerBook("m", { title: "M", storage: GITHUB, githubToken: "ghp_x" });
      assert.equal(moved.storage.kind, "github");
      assert.equal(moved.lastSync.ok, true);
      const folder = server.data.bookDirectory("m");
      assert.equal(await exists(path.join(folder, "book.md")), true);
      assert.equal(await exists(path.join(folder, "local-only.md")), false);
      const trash = path.join(server.data.root, "books", ".trash");
      const entries = await readdir(trash);
      assert.equal(entries.length, 1);
      assert.match(entries[0], /^m-\d{13}$/);
      assert.equal(await readFile(path.join(trash, entries[0], "local-only.md"), "utf8"), "only on the server\n");
      assert.deepEqual((await readdir(path.dirname(folder))).sort(), ["repo"]);
      if (posix) {
        assert.equal((await lstat(trash)).mode & 0o777, 0o700);
        assert.equal((await lstat(path.join(trash, entries[0]))).mode & 0o777, 0o700);
      }
    }, { githubRemoteUrl: () => seeded.origin });
  } finally {
    await remove(seeded.origin, seeded.seed);
  }
});

test("C14: removing a book moves its working copy to the trash instead of deleting it", async () => {
  await withServer(async (server, client) => {
    await client.registerBook("n", { title: "N", storage: { kind: "local" }, githubToken: "ghp_x" });
    await client.commitFiles("n", [{ path: "notes.md", content: "my notes\n" }], "notes");
    assert.deepEqual(await client.removeBook("n"), { removed: true });
    assert.deepEqual(await client.listBooks(), []);
    const books = path.join(server.data.root, "books");
    assert.equal(await exists(path.join(books, "n")), false, "the book folder is gone");
    const trash = path.join(books, ".trash");
    const entries = await readdir(trash);
    assert.equal(entries.length, 1);
    assert.match(entries[0], /^n-\d{13}$/);
    assert.equal(await readFile(path.join(trash, entries[0], "notes.md"), "utf8"), "my notes\n");
    assert.match(git(path.join(trash, entries[0]), "log", "--oneline"), /notes/, "with its history");
    const reopened = await DataDirectory.open(server.data.root);
    assert.deepEqual(await reopened.books(), []);
    assert.equal(await reopened.bookToken("n"), undefined, "the stored GitHub token is deleted");
    // The id can be registered again.
    await client.registerBook("n", { title: "N again", storage: { kind: "local" } });
    assert.equal((await client.listBooks()).length, 1);
  });
});

test("C14: a failed first clone leaves no half-built folder, and nothing else (R13: the registration is all or nothing); the next registration retries it", async () => {
  const seeded = await seedOrigin({ "book.md": "---\ntitle: T\n---\n" });
  const missing = await temporary("narrarium-missing-");
  let remote = path.join(missing, "not-yet.git");
  try {
    await withServer(async (server, client) => {
      await assert.rejects(() => client.registerBook("late", { title: "Late", storage: GITHUB, githubToken: "ghp_x" }), (error) => error.status === 502 && error.code === "repository_unavailable");
      const booksFolder = path.join(server.data.root, "books");
      assert.equal(await exists(path.join(booksFolder, "late")), false, "nothing is left of the failed clone, not even its folder");
      assert.deepEqual(await client.listBooks(), [], "the book is not registered");
      assert.equal(await server.data.bookToken("late"), undefined, "and the token of the failed attempt is not kept");
      remote = seeded.origin;
      const retried = await client.registerBook("late", { title: "Late", storage: GITHUB, githubToken: "ghp_x" });
      assert.equal(retried.lastSync.ok, true);
      assert.equal(retried.error, undefined);
      assert.equal(await exists(path.join(server.data.bookDirectory("late"), "book.md")), true);
      assert.deepEqual(await readdir(path.dirname(server.data.bookDirectory("late"))), ["repo"]);
    }, { githubRemoteUrl: () => remote });
  } finally {
    await remove(seeded.origin, seeded.seed, missing);
  }
});

test("C5: registering and removing the same book at the same time never leaves the registry and the data folder disagreeing", async () => {
  await withServer(async (server, client) => {
    for (let round = 0; round < 8; round += 1) {
      const id = `race-${round}`;
      await client.registerBook(id, { title: `Race ${round}`, storage: { kind: "local" } });
      await Promise.allSettled([
        client.registerBook(id, { title: "again", storage: { kind: "local" }, githubToken: "ghp_token" }),
        client.removeBook(id),
        client.registerBook(id, { title: "once more", storage: { kind: "local" } }),
        client.removeBook(id),
      ]);
    }
    const live = (await client.listBooks()).map((book) => book.bookId).sort();
    const stored = (await (await DataDirectory.open(server.data.root)).books()).map((book) => book.bookId).sort();
    assert.deepEqual(live, stored);
    for (const id of live) assert.equal(await exists(server.data.bookDirectory(id)), true, `${id} has its working copy`);
  });
});

test("C14: a book cannot be called .trash, and a removed unknown book is still a 404", async () => {
  await withServer(async (_server, client) => {
    await assert.rejects(() => client.registerBook(".trash", { title: "T", storage: { kind: "local" } }), (error) => error.status === 400 && error.code === "invalid_book");
    await assert.rejects(() => client.removeBook("never-registered"), (error) => error.status === 404);
  });
});

test("C14: trash entries older than 14 days are deleted when the server starts", async () => {
  const dataDir = await temporary("narrarium-trash-");
  try {
    const data = await DataDirectory.open(dataDir);
    const trash = path.join(data.root, "books", ".trash");
    const now = Date.now();
    const entries = {
      old: `old-book-${now - 15 * DAY}`,
      fresh: `fresh-book-${now - 1 * DAY}`,
      edge: `edge-book-${now - 13 * DAY}`,
      // A name with no time in it is judged by its modification time.
      foreignNew: "somebody-put-this-here",
      foreignOld: "left-over-long-ago",
      // A moved folder keeps its old modification time: the time in its name decides, not that one.
      freshButOldFolder: `moved-book-${now - 1 * DAY}`,
    };
    for (const name of Object.values(entries)) {
      await mkdir(path.join(trash, name), { recursive: true });
      await writeFile(path.join(trash, name, "chapter.md"), "kept or not\n");
    }
    const longAgo = new Date(now - 40 * DAY);
    await utimes(path.join(trash, entries.foreignOld), longAgo, longAgo);
    await utimes(path.join(trash, entries.freshButOldFolder), longAgo, longAgo);
    const server = await startNarrariumServer({ dataDir, port: 0, adminPort: 0, supervised: false, checkRelease: noRelease, tunnel: { findBinary: () => undefined, detectOtherConnectors: async () => [] } });
    try {
      assert.deepEqual((await readdir(trash)).sort(), [entries.edge, entries.foreignNew, entries.fresh, entries.freshButOldFolder].sort());
    } finally {
      await server.close();
    }
  } finally {
    await remove(dataDir);
  }
});
