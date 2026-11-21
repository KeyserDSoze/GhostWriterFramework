import test from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { execFileSync, spawn } from "node:child_process";
import { lstat, mkdir, mkdtemp, readFile, readdir, rm, stat, symlink, utimes, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { FileBookStore, GitRepository, KeyedMutex, loadServerConfig, startNarrariumServer } from "../dist/testing.mjs";
import { noRelease, until, withServer } from "./helpers.mjs";

const MIB = 1024 * 1024;
const serverEntry = fileURLToPath(new URL("../dist/server.mjs", import.meta.url));

const temporary = (prefix = "narrarium-hardening-") => mkdtemp(path.join(os.tmpdir(), prefix));
const remove = (...directories) => Promise.all(directories.map((directory) => rm(directory, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 })));
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
/** A deadline that never keeps the test process alive after the test has finished. */
const timeoutAfter = (ms, value) => new Promise((resolve) => setTimeout(() => resolve(value), ms).unref());
const exists = (file) => lstat(file).then(() => true, () => false);
const sha256 = (text) => createHash("sha256").update(text, "utf8").digest("hex");
const git = (cwd, ...args) => execFileSync("git", ["-c", "user.name=test", "-c", "user.email=test@example.invalid", "-C", cwd, ...args], { encoding: "utf8", maxBuffer: 64 * MIB });

/** Node reports an unhandled rejection after the microtask queue drained: give it a moment. */
const settle = () => sleep(80);

function recordUnhandledRejections() {
  const reasons = [];
  const listener = (reason) => {
    reasons.push(reason);
  };
  process.on("unhandledRejection", listener);
  return { reasons, stop: () => process.off("unhandledRejection", listener) };
}

/** Create a symbolic link, or report that this system does not allow it (Windows without privileges). */
async function link(target, location, type) {
  if (process.platform === "win32") return false;
  try {
    await symlink(target, location, type);
    return true;
  } catch (error) {
    if (error.code === "EPERM" || error.code === "EACCES" || error.code === "ENOSYS") return false;
    throw error;
  }
}

/** A bare repository holding one commit on `main`: `files` are text files, `links` symbolic links (name -> target). */
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

/** The data folder of a server that has been started once and closed; returns a client token. */
async function prepareDataFolder(dataDir, scopes) {
  const first = await startNarrariumServer({ dataDir, port: 0, adminPort: 0, supervised: false, checkRelease: noRelease, tunnel: { findBinary: () => undefined, detectOtherConnectors: async () => [] } });
  const { token } = await first.auth.issue("real process", scopes);
  await first.close();
  await loadServerConfig(dataDir, { apiPort: 0, adminPort: 0 });
  return token;
}

/** The server exactly as it is published (`dist/server.mjs`), in a child process. */
async function startServerProcess(dataDir, { nodeArguments = [], env = {} } = {}) {
  const home = await temporary("narrarium-process-home-");
  const child = spawn(process.execPath, [...nodeArguments, serverEntry, "--data-root", dataDir], {
    stdio: ["ignore", "pipe", "pipe"],
    env: { ...process.env, HOME: home, USERPROFILE: home, NARRARIUM_SUPERVISED: "", ...env },
    windowsHide: true,
  });
  let stdout = "";
  let stderr = "";
  child.stdout.on("data", (chunk) => {
    stdout += chunk;
  });
  child.stderr.on("data", (chunk) => {
    stderr += chunk;
  });
  const exited = new Promise((resolve) => child.once("exit", (code, signal) => resolve({ code, signal })));
  const earlyExit = exited.then((result) => {
    throw new Error(`The server exited while starting (${JSON.stringify(result)}):\n${stdout}\n${stderr}`);
  });
  earlyExit.catch(() => undefined);
  const process_ = {
    child,
    exited,
    output: () => ({ stdout, stderr }),
    async stop() {
      if (child.exitCode === null && child.signalCode === null) child.kill();
      await exited;
      await remove(home);
    },
  };
  try {
    process_.api = await Promise.race([until(() => /API:\s+(http:\/\/127\.0\.0\.1:\d+)/.exec(stdout)?.[1], 30_000), earlyExit]);
  } catch (error) {
    await process_.stop();
    throw error;
  }
  return process_;
}

/** A preload for the server process that raises a fault once the test creates the trigger file (after the server is ready). */
async function writeFaultPreload(directory) {
  const file = path.join(directory, "fault.cjs");
  await writeFile(file, [
    "const fs = require('node:fs');",
    "const { NARRARIUM_TEST_FAULT: mode, NARRARIUM_TEST_FAULT_FILE: trigger } = process.env;",
    "const timer = setInterval(() => {",
    "  if (!fs.existsSync(trigger)) return;",
    "  clearInterval(timer);",
    "  if (mode === 'rejection') Promise.reject(new Error('synthetic rejection'));",
    "  if (mode === 'exception') throw new Error('synthetic exception');",
    "}, 25);",
    "",
  ].join("\n"));
  return { preload: file, trigger: path.join(directory, "fault.trigger") };
}

// ---------------------------------------------------------------------------------------------
// C1 / B1: a rejected commit must never end the process
// ---------------------------------------------------------------------------------------------

test("C1: KeyedMutex - a rejected action raises no unhandled rejection and later actions still run in order", async () => {
  const unhandled = recordUnhandledRejections();
  try {
    const mutex = new KeyedMutex();
    const order = [];
    const first = mutex.run("book", async () => {
      order.push("first:start");
      await sleep(20);
      order.push("first:end");
      throw new Error("first fails");
    });
    const second = mutex.run("book", async () => {
      order.push("second");
      return "second result";
    });
    const other = mutex.run("other", async () => "other result");
    await assert.rejects(first, /first fails/);
    assert.equal(await second, "second result");
    assert.equal(await other, "other result");
    assert.deepEqual(order, ["first:start", "first:end", "second"]);

    // An action rejects and nothing is queued behind it for a while: nobody else handles that rejection.
    await assert.rejects(mutex.run("lonely", async () => {
      throw new Error("alone");
    }), /alone/);
    await settle();
    assert.deepEqual(unhandled.reasons.map(String), [], "a rejected action with nothing queued behind it");
    // A synchronous throw is a rejection too.
    await assert.rejects(mutex.run("lonely", () => {
      throw new Error("sync");
    }), /sync/);
    await settle();
    assert.deepEqual(unhandled.reasons.map(String), [], "a synchronous throw");
    assert.equal(await mutex.run("lonely", async () => "still works"), "still works");
    await settle();
    assert.deepEqual(unhandled.reasons.map(String), []);
  } finally {
    unhandled.stop();
  }
});

test("C1: FileBookStore.commit - a conflict, an unsafe path and an oversized file reject without an unhandled rejection", async () => {
  const root = await temporary();
  const unhandled = recordUnhandledRejections();
  try {
    const store = new FileBookStore(root);
    await store.commit([{ path: "notes.md", content: "one\n" }], "one");
    await assert.rejects(store.commit([{ path: "notes.md", content: "two\n", expectedHash: "deadbeef" }], "two"), (error) => error.name === "BookConflictError");
    await assert.rejects(store.commit([{ path: "../outside.md", content: "x" }], "unsafe"), /Unsafe book path/);
    await assert.rejects(store.commit([{ path: "big.md", content: "a".repeat(8 * MIB + 1) }], "big"), /too large/i);
    await settle();
    assert.deepEqual(unhandled.reasons.map(String), []);
    await store.commit([{ path: "notes.md", content: "three\n", expectedHash: sha256("one\n") }], "three");
    assert.equal(await readFile(path.join(root, "notes.md"), "utf8"), "three\n");
  } finally {
    unhandled.stop();
    await remove(root);
  }
});

test("C1: the real server process survives a rejected commit and keeps answering", async () => {
  const dir = await temporary("narrarium-process-");
  let server;
  try {
    const token = await prepareDataFolder(dir, ["read", "write"]);
    server = await startServerProcess(dir);
    const call = (method, route, body) => fetch(`${server.api}${route}`, { method, headers: { authorization: `Bearer ${token}`, "content-type": "application/json" }, body: body === undefined ? undefined : JSON.stringify(body) });
    assert.equal((await call("PUT", "/api/v1/books/b1", { title: "B", storage: { kind: "local" } })).status, 200);
    assert.equal((await call("POST", "/api/v1/books/b1/files/commit", { changes: [{ path: "notes.md", content: "one\n" }], message: "one" })).status, 200);
    const conflict = await call("POST", "/api/v1/books/b1/files/commit", { changes: [{ path: "notes.md", content: "two\n", expectedHash: "deadbeef" }], message: "two" });
    assert.equal(conflict.status, 409);
    assert.equal((await conflict.json()).code, "conflict");
    const unsafe = await call("POST", "/api/v1/books/b1/files/commit", { changes: [{ path: "../escape.md", content: "x" }], message: "unsafe" });
    assert.equal(unsafe.status, 400);
    await sleep(800);
    assert.equal(server.child.exitCode, null, `the server exited after a rejected commit:\n${server.output().stderr}`);
    assert.equal((await fetch(`${server.api}/api/v1/info`)).status, 200);
  } finally {
    await server?.stop();
    await remove(dir);
  }
});

test("C1: an unhandled rejection is logged to stderr and the server keeps serving", async () => {
  const dir = await temporary("narrarium-process-");
  let server;
  try {
    await prepareDataFolder(dir, ["read"]);
    const { preload, trigger } = await writeFaultPreload(dir);
    server = await startServerProcess(dir, { nodeArguments: ["--require", preload], env: { NARRARIUM_TEST_FAULT: "rejection", NARRARIUM_TEST_FAULT_FILE: trigger } });
    await writeFile(trigger, "now");
    await until(() => /synthetic rejection/.test(server.output().stderr), 30_000);
    assert.match(server.output().stderr, /^\[\d{4}-\d{2}-\d{2}T[^\]]+\] Unhandled rejection: .*synthetic rejection/m);
    await sleep(500);
    assert.equal(server.child.exitCode, null, "the process is still alive");
    assert.equal((await fetch(`${server.api}/api/v1/info`)).status, 200);
  } finally {
    await server?.stop();
    await remove(dir);
  }
});

test("C1: an uncaught exception is logged, the server stops and the process exits with code 1 within seconds", async () => {
  const dir = await temporary("narrarium-process-");
  let server;
  try {
    await prepareDataFolder(dir, ["read"]);
    const { preload, trigger } = await writeFaultPreload(dir);
    server = await startServerProcess(dir, { nodeArguments: ["--require", preload], env: { NARRARIUM_TEST_FAULT: "exception", NARRARIUM_TEST_FAULT_FILE: trigger } });
    const started = Date.now();
    await writeFile(trigger, "now");
    const result = await Promise.race([server.exited, timeoutAfter(30_000, "still running")]);
    assert.notEqual(result, "still running", "the process must exit");
    assert.equal(result.code, 1);
    assert.ok(Date.now() - started < 20_000, "the exit follows the exception within a few seconds");
    assert.match(server.output().stderr, /^\[\d{4}-\d{2}-\d{2}T[^\]]+\] Uncaught exception: .*synthetic exception/m);
  } finally {
    await server?.stop();
    await remove(dir);
  }
});

// ---------------------------------------------------------------------------------------------
// C2: symbolic links never give access outside the book
// ---------------------------------------------------------------------------------------------

/** A book folder with links to the outside, to its own content and to nothing; skipped where links are not allowed. */
async function withLinkedBook(t, run) {
  const root = await temporary("narrarium-links-book-");
  const outside = await temporary("narrarium-links-outside-");
  try {
    await mkdir(path.join(outside, "dir"));
    await writeFile(path.join(outside, "dir", "outside.md"), "OUTSIDE\n");
    await writeFile(path.join(outside, "secret.txt"), "SECRET\n");
    await writeFile(path.join(root, "book.md"), "# Book\n");
    await mkdir(path.join(root, "real"));
    await writeFile(path.join(root, "real", "inside.md"), "inside\n");
    const linked = (await link(path.join(outside, "dir"), path.join(root, "x"), "dir"))
      && (await link(path.join(outside, "secret.txt"), path.join(root, "secret.md"), "file"))
      && (await link(path.join(root, "real"), path.join(root, "alias"), "dir"))
      && (await link(path.join(outside, "missing.md"), path.join(root, "dangling.md"), "file"));
    if (!linked) return t.skip("this system does not allow symbolic links");
    await run({ root, outside, store: new FileBookStore(root) });
  } finally {
    await remove(root, outside);
  }
}

test("C2: read, list and hash treat paths through a symbolic link as absent", async (t) => {
  await withLinkedBook(t, async ({ root, store }) => {
    for (const unsafe of ["x/outside.md", "x", "secret.md", "alias/inside.md", "alias", "dangling.md"]) assert.equal(await store.read(unsafe), null, unsafe);
    assert.equal((await store.read("real/inside.md")).content, "inside\n");
    assert.deepEqual((await store.list()).map((entry) => entry.path), ["book.md", "real/inside.md"]);
    assert.match(await store.contentRevision(), /^[0-9a-f]{16}$/);
    // The compare-and-swap of a path behind a link is refused as unsafe, never answered from the target.
    await assert.rejects(store.commit([{ path: "secret.md", content: "x", expectedHash: sha256("SECRET\n") }], "m"), /Unsafe book path/);
    assert.equal(await exists(path.join(root, "x")), true);
  });
});

test("C2: commit refuses to write, delete or roll back through a symbolic link and creates nothing outside", async (t) => {
  await withLinkedBook(t, async ({ root, outside, store }) => {
    for (const change of [
      { path: "x/new.md", content: "pwned" },
      { path: "x/deeper/new.md", content: "pwned" },
      { path: "secret.md", content: "pwned" },
      { path: "x/outside.md", content: null },
      { path: "secret.md", content: null },
      { path: "alias/inside.md", content: "pwned" },
      { path: "dangling.md", content: "pwned" },
    ]) {
      await assert.rejects(store.commit([change], "m"), /Unsafe book path/, JSON.stringify(change));
    }
    await assert.rejects(store.commit([{ path: "ok.md", content: "fine" }, { path: "x/new.md", content: "pwned" }], "m"), /Unsafe book path/);
    assert.equal(await exists(path.join(root, "ok.md")), false, "a valid change next to an unsafe one is not applied");
    assert.deepEqual((await readdir(path.join(outside, "dir"))).sort(), ["outside.md"]);
    assert.equal(await readFile(path.join(outside, "dir", "outside.md"), "utf8"), "OUTSIDE\n");
    assert.equal(await readFile(path.join(outside, "secret.txt"), "utf8"), "SECRET\n");
    assert.equal(await exists(path.join(outside, "missing.md")), false);
    assert.equal(await readFile(path.join(root, "real", "inside.md"), "utf8"), "inside\n");
  });
});

test("C2: a book folder that is itself reached through a link still works", async (t) => {
  const real = await temporary("narrarium-links-real-");
  const holder = await temporary("narrarium-links-holder-");
  try {
    await writeFile(path.join(real, "book.md"), "# Book\n");
    const reached = path.join(holder, "book-folder");
    if (!(await link(real, reached, "dir"))) return t.skip("this system does not allow symbolic links");
    const store = new FileBookStore(reached);
    assert.equal((await store.read("book.md")).content, "# Book\n");
    await store.commit([{ path: "chapters/one.md", content: "one\n" }], "write");
    assert.equal(await readFile(path.join(real, "chapters", "one.md"), "utf8"), "one\n");
    assert.deepEqual((await store.list()).map((entry) => entry.path), ["book.md", "chapters/one.md"]);
  } finally {
    await remove(real, holder);
  }
});

test("C2: a cloned repository full of symbolic links cannot be used to read or write outside the book", async (t) => {
  if (process.platform === "win32") return t.skip("symbolic links need privileges on Windows");
  let origin;
  const leftovers = [];
  try {
    await withServer(async (server, client, dataDir) => {
      const adminFile = path.join(dataDir, "private", "admin-code.txt");
      const secret = (await readFile(adminFile, "utf8")).trim();
      const seeded = await seedOrigin({ "book.md": "---\ntitle: Evil\n---\n" }, { x: dataDir, "stolen.md": adminFile });
      leftovers.push(seeded.origin, seeded.seed);
      if (!seeded.linked) return t.skip("this system does not allow symbolic links");
      origin = seeded.origin;
      await client.registerBook("evil", { title: "Evil", storage: { kind: "github", owner: "a", repo: "b", branch: "main" }, githubToken: "ghp_bogus" });
      const working = server.data.bookDirectory("evil");

      // Layer 1: git itself never creates a link in the working copy.
      assert.equal((await lstat(path.join(working, "x"))).isSymbolicLink(), false);
      assert.equal((await lstat(path.join(working, "stolen.md"))).isSymbolicLink(), false);
      const cloned = await client.readFiles("evil", ["x/private/admin-code.txt", "stolen.md", "book.md"]);
      assert.ok(!cloned.some((file) => file.path === "x/private/admin-code.txt"), "nothing is readable below a former link");
      assert.ok(cloned.every((file) => !file.content.includes(secret)), "the admin code is not readable");

      // Layer 2: a working copy cloned earlier (real links) is protected by the store itself.
      await rm(path.join(working, "x"));
      await rm(path.join(working, "stolen.md"));
      await symlink(dataDir, path.join(working, "x"));
      await symlink(adminFile, path.join(working, "stolen.md"));
      assert.deepEqual((await client.readFiles("evil", ["x/private/admin-code.txt", "stolen.md"])).map((file) => file.path), []);
      const manifest = await client.manifest("evil");
      assert.ok(!manifest.files.some((file) => file.path === "stolen.md" || file.path.startsWith("x/")));
      await assert.rejects(() => client.commitFiles("evil", [{ path: "x/planted.md", content: "planted" }], "m"), (error) => error.status === 400);
      await assert.rejects(() => client.commitFiles("evil", [{ path: "stolen.md", content: "planted" }], "m"), (error) => error.status === 400);
      assert.equal(await exists(path.join(dataDir, "planted.md")), false);
      assert.equal((await readFile(adminFile, "utf8")).trim(), secret);
    }, { githubRemoteUrl: () => origin });
  } finally {
    await remove(...leftovers);
  }
});

// ---------------------------------------------------------------------------------------------
// C4: files/read is bounded; files over the cap are not listed
// ---------------------------------------------------------------------------------------------

test("C4: files/read de-duplicates the paths and refuses more than 100 distinct ones", async () => {
  await withServer(async (_server, client) => {
    await client.registerBook("r", { title: "R", storage: { kind: "local" } });
    await client.commitFiles("r", [{ path: "a.md", content: "alpha\n" }, { path: "b.md", content: "beta\n" }], "seed");
    const names = (files) => files.map((file) => file.path);
    assert.deepEqual(names(await client.readFiles("r", ["a.md", "a.md", "b.md", "a.md"])), ["a.md", "b.md"]);
    assert.deepEqual(names(await client.readFiles("r", Array.from({ length: 1500 }, () => "a.md"))), ["a.md"]);
    const hundred = Array.from({ length: 100 }, (_, index) => `missing-${index}.md`);
    assert.deepEqual(await client.readFiles("r", hundred), []);
    assert.deepEqual(await client.readFiles("r", [...hundred, ...hundred]), [], "duplicates do not count twice");
    await assert.rejects(() => client.readFiles("r", [...hundred, "one-more.md"]), (error) => error.status === 400 && error.code === "too_many_paths");
    assert.deepEqual(names(await client.readFiles("r", ["a.md"])), ["a.md"], "a single file is read as before");
  });
});

test("C4: files/read refuses an unsafe path with 400 instead of failing", async () => {
  await withServer(async (_server, client) => {
    await client.registerBook("r", { title: "R", storage: { kind: "local" } });
    for (const unsafe of ["../outside.md", "/etc/passwd", ".git/config", "a//b.md"]) {
      await assert.rejects(() => client.readFiles("r", [unsafe]), (error) => error.status === 400 && error.code === "invalid_path", unsafe);
    }
  });
});

test("C4: the manifest lists only names the API can address", { skip: process.platform === "win32" && "Windows cannot create these names" }, async () => {
  const root = await temporary();
  try {
    await writeFile(path.join(root, "book.md"), "# Book\n");
    await writeFile(path.join(root, "aux.md"), "a Windows device name\n");
    await writeFile(path.join(root, "a:b.md"), "a colon\n");
    await writeFile(path.join(root, "back\\slash.md"), "a backslash\n");
    assert.deepEqual((await new FileBookStore(root).list()).map((entry) => entry.path), ["book.md"]);
  } finally {
    await remove(root);
  }
});

test("C4: files/read answers 413 as soon as the content would exceed 16 MiB", async () => {
  await withServer(async (server, client) => {
    await client.registerBook("r", { title: "R", storage: { kind: "local" } });
    const folder = server.data.bookDirectory("r");
    const chunk = "x".repeat(Math.floor(5.5 * MIB));
    for (const name of ["one.md", "two.md", "three.md"]) await writeFile(path.join(folder, name), chunk);
    assert.equal((await client.readFiles("r", ["one.md", "two.md"])).length, 2);
    await assert.rejects(() => client.readFiles("r", ["one.md", "two.md", "three.md"]), (error) => error.status === 413 && error.code === "payload_too_large");
    assert.equal((await client.readFiles("r", ["three.md"])).length, 1);
  });
});

test("C4: a file over the 8 MiB cap is neither listed nor read, so syncs cannot loop on it", async () => {
  const root = await temporary();
  try {
    await writeFile(path.join(root, "small.md"), "small\n");
    await writeFile(path.join(root, "exact.md"), "a".repeat(8 * MIB));
    await writeFile(path.join(root, "huge.md"), "a".repeat(8 * MIB + 1));
    const store = new FileBookStore(root);
    assert.deepEqual((await store.list()).map((entry) => entry.path), ["exact.md", "small.md"]);
    assert.equal(await store.read("huge.md"), null);
    assert.equal((await store.read("exact.md")).content.length, 8 * MIB);
    assert.notEqual(await store.contentRevision(), "");
    // Replacing a file that is too big to be rolled back is refused instead of risking the only copy.
    await assert.rejects(store.commit([{ path: "huge.md", content: "small now" }], "m"), (error) => error.status === 413);
    assert.equal((await stat(path.join(root, "huge.md"))).size, 8 * MIB + 1);
  } finally {
    await remove(root);
  }
});

// ---------------------------------------------------------------------------------------------
// C18: files/commit validation, normalisation and rollback
// ---------------------------------------------------------------------------------------------

test("C18: at most 5000 changes per commit, and nothing is written above that", async () => {
  await withServer(async (server, client) => {
    await client.registerBook("many", { title: "Many", storage: { kind: "local" } });
    const changes = Array.from({ length: 5001 }, (_, index) => ({ path: `bulk/${index}.md`, content: "" }));
    await assert.rejects(() => client.commitFiles("many", changes, "bulk"), (error) => error.status === 413 && error.code === "too_many_changes");
    assert.deepEqual((await readdir(server.data.bookDirectory("many"))).filter((name) => name !== ".git"), [], "no file was written");
  });
  const root = await temporary();
  try {
    const store = new FileBookStore(root);
    const exactly = Array.from({ length: 5000 }, (_, index) => ({ path: `bulk/${index}.md`, content: `file ${index}\n` }));
    await store.commit(exactly, "the first upload of a big book");
    assert.equal((await readdir(path.join(root, "bulk"))).length, 5000);
    await assert.rejects(store.commit([...exactly, { path: "one-more.md", content: "x" }], "too many"), (error) => error.status === 413 && error.code === "too_many_changes");
  } finally {
    await remove(root);
  }
});

test("C18: every path is normalised once and the same name reaches the file system, the compare-and-swap and git", async () => {
  const root = await temporary();
  try {
    const seen = [];
    const store = new FileBookStore(root, { afterWrite: async (paths) => {
      seen.push(paths);
      return "revision";
    } });
    await store.commit([{ path: "notes\\x.md", content: "hi\n" }], "backslash");
    assert.deepEqual(seen, [["notes/x.md"]]);
    assert.equal(await readFile(path.join(root, "notes", "x.md"), "utf8"), "hi\n");
    await store.commit([{ path: "notes\\x.md", content: "again\n", expectedHash: sha256("hi\n") }], "compare-and-swap through the other spelling");
    assert.deepEqual(seen[1], ["notes/x.md"]);
    await assert.rejects(store.commit([{ path: "notes\\x.md", content: "stale\n", expectedHash: sha256("hi\n") }], "stale"), (error) => error.name === "BookConflictError" && error.path === "notes/x.md");
  } finally {
    await remove(root);
  }

  await withServer(async (server, client) => {
    await client.registerBook("b", { title: "B", storage: { kind: "local" } });
    const result = await client.commitFiles("b", [{ path: "notes\\x.md", content: "hi\n" }], "backslash");
    assert.ok(result.revision, "the commit succeeded");
    const folder = server.data.bookDirectory("b");
    assert.equal(await readFile(path.join(folder, "notes", "x.md"), "utf8"), "hi\n");
    assert.equal(git(folder, "ls-tree", "-r", "--name-only", "HEAD").trim(), "notes/x.md");
  });
});

test("C18: the same file twice in one commit is refused, compared case-insensitively and after normalisation", async () => {
  await withServer(async (server, client) => {
    await client.registerBook("d", { title: "D", storage: { kind: "local" } });
    const folder = server.data.bookDirectory("d");
    for (const [first, second] of [["a.md", "A.md"], ["notes/x.md", "notes\\x.md"], ["a.md", "a.md"], ["Chapters/One.md", "chapters/one.MD"]]) {
      await assert.rejects(() => client.commitFiles("d", [{ path: first, content: "1" }, { path: second, content: "2" }], "dup"), (error) => error.status === 400 && error.code === "duplicate_path", `${first} / ${second}`);
    }
    assert.deepEqual((await readdir(folder)).filter((name) => name !== ".git"), [], "nothing was written");
    await client.commitFiles("d", [{ path: "a.md", content: "1" }, { path: "b.md", content: "2" }], "distinct names are fine");
  });
});

test("C18: only the text files of a book can be written: git's own files and binaries never travel through the API", async () => {
  await withServer(async (server, client) => {
    await client.registerBook("txt", { title: "Text", storage: { kind: "local" } });
    const folder = server.data.bookDirectory("txt");
    for (const name of [".gitmodules", ".gitattributes", ".gitignore", "cover.png", "Makefile", "run.sh", "notes/script.js"]) {
      await assert.rejects(() => client.commitFiles("txt", [{ path: name, content: "x" }], "no"), (error) => error.status === 400 && error.code === "invalid_path", name);
    }
    assert.deepEqual((await readdir(folder)).filter((name) => name !== ".git"), [], "nothing was written");
    await client.commitFiles("txt", [{ path: "notes.md", content: "1" }, { path: "data/a.json", content: "{}" }, { path: ".github/workflows/x.yml", content: "a: 1\n" }], "text files are fine");
  });
});

test("C18: deleting files commits cleanly, also a file that is not there", async () => {
  await withServer(async (server, client) => {
    await client.registerBook("del", { title: "Del", storage: { kind: "local" } });
    await client.commitFiles("del", [{ path: "a.md", content: "a\n" }, { path: "b.md", content: "b\n" }], "seed");
    const folder = server.data.bookDirectory("del");
    const before = git(folder, "rev-parse", "HEAD").trim();
    const hashOfA = sha256("a\n");
    const result = await client.commitFiles("del", [{ path: "a.md", content: null, expectedHash: hashOfA }, { path: "never-existed.md", content: null }], "delete");
    assert.ok(result.revision);
    assert.notEqual(git(folder, "rev-parse", "HEAD").trim(), before);
    assert.equal(git(folder, "ls-tree", "-r", "--name-only", "HEAD").trim(), "b.md");
    assert.equal(await exists(path.join(folder, "a.md")), false);
    // Only the file that is not there: nothing to commit, and no failure.
    const same = await client.commitFiles("del", [{ path: "never-existed.md", content: null }], "nothing");
    assert.ok(same.revision);
    assert.equal(git(folder, "status", "--porcelain").trim(), "");
  });
});

test("C18: the whole commit is validated before anything is written", async () => {
  const root = await temporary();
  try {
    const store = new FileBookStore(root);
    await store.commit([{ path: "keep.md", content: "keep\n" }], "seed");
    const keep = path.join(root, "keep.md");
    const past = new Date("2020-01-01T00:00:00Z");
    await utimes(keep, past, past);
    const before = await stat(keep);
    const invalid = {
      "an unsafe path": [{ path: "keep.md", content: "changed\n" }, { path: "../escape.md", content: "x" }],
      "a file over the cap": [{ path: "keep.md", content: "changed\n" }, { path: "huge.md", content: "a".repeat(8 * MIB + 1) }],
      "a duplicate": [{ path: "keep.md", content: "changed\n" }, { path: "notes/ok.md", content: "x" }, { path: "NOTES/ok.md", content: "y" }],
      "a file where a folder is needed": [{ path: "keep.md", content: "changed\n" }, { path: "keep.md/inside.md", content: "x" }],
    };
    for (const [label, changes] of Object.entries(invalid)) {
      await assert.rejects(store.commit(changes, "invalid"), undefined, label);
      assert.equal((await stat(keep)).mtimeMs, before.mtimeMs, `${label}: keep.md was not touched, not even to be rolled back`);
      assert.equal(await readFile(keep, "utf8"), "keep\n", label);
    }
    assert.deepEqual((await readdir(root)).sort(), ["keep.md"], "no folder and no temporary file was left");
  } finally {
    await remove(root);
  }
});

test("C18: when the git step fails after the files were written, every file is put back", async () => {
  const root = await temporary();
  try {
    let failing = false;
    const store = new FileBookStore(root, { afterWrite: async () => {
      if (failing) throw new Error("git add failed");
      return "revision";
    } });
    await store.commit([{ path: "a.md", content: "old a\n" }, { path: "gone.md", content: "old gone\n" }], "seed");
    failing = true;
    await assert.rejects(store.commit([
      { path: "a.md", content: "new a\n" },
      { path: "gone.md", content: null },
      { path: "deep/er/new.md", content: "new\n" },
    ], "fails"), /git add failed/);
    assert.equal(await readFile(path.join(root, "a.md"), "utf8"), "old a\n");
    assert.equal(await readFile(path.join(root, "gone.md"), "utf8"), "old gone\n");
    assert.deepEqual((await readdir(root)).sort(), ["a.md", "gone.md"], "the new file, its folders and the temporary files are gone");
    failing = false;
    await store.commit([{ path: "a.md", content: "third\n", expectedHash: sha256("old a\n") }], "the store keeps working");
    assert.equal(await readFile(path.join(root, "a.md"), "utf8"), "third\n");
  } finally {
    await remove(root);
  }
});

test("C18: a failing git commit rolls the files back and leaves the index clean", async () => {
  await withServer(async (server, client) => {
    await client.registerBook("g", { title: "G", storage: { kind: "local" } });
    await client.commitFiles("g", [{ path: "a.md", content: "one\n" }], "one");
    const folder = server.data.bookDirectory("g");
    git(folder, "config", "commit.gpgsign", "true");
    git(folder, "config", "gpg.program", path.join(folder, "no-such-gpg-program"));
    await assert.rejects(() => client.commitFiles("g", [{ path: "a.md", content: "two\n" }, { path: "b.md", content: "new\n" }], "two"), (error) => error.status === 500);
    assert.equal(await readFile(path.join(folder, "a.md"), "utf8"), "one\n");
    assert.equal(await exists(path.join(folder, "b.md")), false);
    assert.equal(git(folder, "diff", "--cached", "--name-only").trim(), "", "nothing stays staged");
    git(folder, "config", "--unset", "commit.gpgsign");
    await client.commitFiles("g", [{ path: "c.md", content: "three\n" }], "three");
    assert.deepEqual(git(folder, "ls-tree", "-r", "--name-only", "HEAD").trim().split("\n"), ["a.md", "c.md"], "the staged leftovers of the failed attempt never reach the history");
    assert.equal(git(folder, "show", "HEAD:a.md"), "one\n");
  });
});

test("C18: git add runs in batches, so a long list of files still commits", async () => {
  const root = await temporary();
  try {
    const folder = path.join(root, "repo");
    const repository = new GitRepository(folder);
    await repository.init();
    const paths = [];
    await mkdir(path.join(folder, "d".repeat(60)), { recursive: true });
    for (let index = 0; index < 600; index += 1) {
      const file = `${"d".repeat(60)}/${String(index).padStart(4, "0")}-${"x".repeat(40)}.md`;
      paths.push(file);
      await writeFile(path.join(folder, file), `file ${index}\n`);
    }
    await repository.commit(paths, "bulk");
    assert.equal(git(folder, "ls-files").split("\n").filter(Boolean).length, 600);
    assert.equal(git(folder, "status", "--porcelain").trim(), "");
  } finally {
    await remove(root);
  }
});

test("C18: git add never gets an argument list larger than the system allows", { skip: process.platform !== "linux" && "the argument limit that failed was Linux's" }, async () => {
  const root = await temporary();
  try {
    const folder = path.join(root, "repo");
    const repository = new GitRepository(folder);
    await repository.init();
    const directory = ["a", "b", "c"].map((letter) => letter.repeat(250)).join("/");
    await mkdir(path.join(folder, directory), { recursive: true });
    const paths = [];
    for (let index = 0; index < 2300; index += 1) {
      const file = `${directory}/${"f".repeat(240)}${String(index).padStart(4, "0")}.md`;
      paths.push(file);
      await writeFile(path.join(folder, file), "x");
    }
    assert.ok(paths.join(" ").length > 2 * MIB, "more than ARG_MAX");
    await repository.commit(paths, "huge list");
    assert.equal(git(folder, "ls-files").split("\n").filter(Boolean).length, 2300);
  } finally {
    await remove(root);
  }
});
