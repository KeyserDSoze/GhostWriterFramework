import test from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { chmod, mkdir, mkdtemp, readFile, readdir, rm, stat, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { NarrariumServerClient } from "narrarium-engine";
import { createFakeAutopilotAi, seedBookFiles } from "narrarium-engine/testing";
import * as testing from "../dist/testing.mjs";
import { noRelease, until, withServer } from "./helpers.mjs";
import { attempt, rawApi } from "./api-helpers.mjs";
import { finished, seedBookFilesWithChapters, seededBook } from "./fake-provider.mjs";
import { HELD, STEPS, holdingAi, startOf } from "./hold.mjs";

// The conflicts of a GitHub book with GitHub (J): the server's commits and GitHub's changed the same files. The book is a working copy of a bare
// repository on this machine, which stands in for GitHub; "the author" works in a clone of it, and the server's own work is committed in its copy as
// the autopilot commits it. Nothing reaches the network.

const { GitRepository } = testing;
const GITHUB = { kind: "github", owner: "me", repo: "remote", branch: "main" };
const TOKEN = "ghp_conflictsTestToken0123456789abcdef";
const ONE = "chapters/001-one/001-scene.md";
const TWO = "chapters/001-one/002-scene.md";
const THREE = "chapters/002-two/001-scene.md";
const NOTES = "notes.md";

const remove = (...directories) => Promise.all(directories.map((directory) => rm(directory, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 })));
const temporary = (prefix) => mkdtemp(path.join(os.tmpdir(), prefix));
const exists = (file) => stat(file).then(() => true, () => false);
const IDENTITY = ["-c", "user.name=test", "-c", "user.email=test@example.invalid", "-c", "core.hooksPath=/dev/null", "-c", "submodule.recurse=false"];
/** The tests' own git, with the environment the tests started with (a test that changes it for the server must not change it for this). */
const ENV = { ...process.env };
const git = (cwd, ...args) => execFileSync("git", [...IDENTITY, "-C", cwd, ...args], { encoding: "utf8", env: ENV, stdio: ["pipe", "pipe", "pipe"] }).trim();
const gitRaw = (cwd, args, input) => execFileSync("git", [...IDENTITY, "-C", cwd, ...args], { encoding: "utf8", env: ENV, input, stdio: ["pipe", "pipe", "pipe"] });
const bytes = (text) => Buffer.byteLength(text, "utf8");
const BASE_FILES = { [ONE]: "The first scene.\n", [TWO]: "The second scene.\n", [THREE]: "The third scene.\n", [NOTES]: "Notes.\n" };

async function writeChanges(directory, changes) {
  for (const [file, content] of Object.entries(changes)) {
    const full = path.join(directory, file);
    if (content === null) await rm(full, { force: true });
    else {
      await mkdir(path.dirname(full), { recursive: true });
      await writeFile(full, content);
    }
  }
}

/** A bare repository with one commit on `main`, standing in for GitHub, and a clone of it where the author works. */
async function seedOrigin(files) {
  const origin = await temporary("narrarium-origin-");
  const seed = await temporary("narrarium-seed-");
  execFileSync("git", ["init", "--quiet", "--bare", "-b", "main", origin], { env: ENV });
  execFileSync("git", ["init", "--quiet", "-b", "main", seed], { env: ENV });
  await writeChanges(seed, files);
  git(seed, "add", "-A");
  git(seed, "commit", "--quiet", "-m", "seed");
  git(seed, "push", "--quiet", origin, "main");
  return { origin, seed };
}

/** The author changes GitHub: the clone catches up first (the server may have pushed), then the change is committed and pushed. Answers GitHub's new head. */
async function onGithub(seeded, changes, message = "author: an edit") {
  git(seeded.seed, "fetch", "--quiet", seeded.origin, "main");
  git(seeded.seed, "merge", "--quiet", "--ff-only", "FETCH_HEAD");
  await writeChanges(seeded.seed, changes);
  git(seeded.seed, "add", "-A");
  git(seeded.seed, "commit", "--quiet", "-m", message);
  git(seeded.seed, "push", "--quiet", seeded.origin, "main");
  return git(seeded.seed, "rev-parse", "HEAD");
}

/** The server's own work, committed in its copy as the autopilot commits a step, and not published. Answers the server's new head. */
async function onServer(folder, changes, message = "Autopilot: a step") {
  await writeChanges(folder, changes);
  git(folder, "add", "-A");
  git(folder, "commit", "--quiet", "-m", message);
  return git(folder, "rev-parse", "HEAD");
}

const parents = (directory, revision = "HEAD") => git(directory, "rev-list", "--parents", "-n", "1", revision).split(" ").slice(1);
const onOrigin = (seeded, file) => gitRaw(seeded.origin, ["show", `main:${file}`]);
const merging = (folder) => exists(path.join(folder, ".git", "MERGE_HEAD"));

/** One book `gh` cloned from a fresh remote, with `files` on it (the seed of a book and four small scenes, unless said otherwise). */
async function scenario(run, { files = { ...seedBookFilesWithChapters(), ...BASE_FILES }, options = {} } = {}) {
  const seeded = await seedOrigin(files);
  try {
    await withServer(async (server, client, dataDir) => {
      const registered = await client.registerBook("gh", { title: "Remote", storage: GITHUB, githubToken: TOKEN });
      assert.equal(registered.lastSync.ok, true);
      await run({ server, client, dataDir, seeded, folder: server.data.bookDirectory("gh") });
    }, { githubRemoteUrl: () => seeded.origin, ...options });
  } finally {
    await remove(seeded.origin, seeded.seed);
  }
}

/** A state of the autopilot saved at `updatedAt`, as a file of the book holds it. */
const stateFile = (updatedAt, note = "") => `${JSON.stringify({ schemaVersion: 1, status: "paused", phase: "write", brief: { idea: note || "x" }, options: {}, runner: null, version: 3, updatedAt, createdAt: "2026-01-01T00:00:00.000Z" }, null, 2)}\n`;

// ---------------------------------------------------------------------------------------------
// The feature, and the conflicts as the server lists them
// ---------------------------------------------------------------------------------------------

test("J5: a server with git announces github-conflicts", async () => {
  await withServer(async (server) => {
    const info = await (await fetch(`${server.url}/api/v1/info`)).json();
    assert.ok(info.features.includes("github-conflicts"), JSON.stringify(info.features));
  });
});

test("J2: the list says which files changed on both sides, with what happened on each and the size of each version; looking changes nothing", async () => {
  await scenario(async ({ client, seeded, folder }) => {
    const nothing = await client.listGithubConflicts("gh");
    assert.deepEqual([nothing.conflicts, nothing.total, nothing.ahead, nothing.behind, nothing.branch], [[], 0, 0, 0, "main"], "a book in step with GitHub");
    const serverText = "The server's own first scene.\n";
    const githubText = "The author rewrote the first scene in the browser.\n";
    const serverHead = await onServer(folder, { [ONE]: serverText });
    const githubHead = await onGithub(seeded, { [ONE]: githubText });
    const listed = await client.listGithubConflicts("gh");
    assert.deepEqual(listed.conflicts, [{ path: ONE, server: "modified", github: "modified", serverBytes: bytes(serverText), githubBytes: bytes(githubText), resolvable: true }]);
    assert.deepEqual([listed.total, listed.offset, listed.limit, listed.ahead, listed.behind, listed.branch], [1, 0, 100, 1, 1, "main"]);
    assert.deepEqual([listed.head, listed.githubHead], [serverHead, githubHead]);
    assert.match(listed.fingerprint, /^[0-9a-f]{32}$/);
    assert.equal(listed.autopilotFiles, undefined, "the autopilot's files did not change on both sides");
    assert.equal(git(folder, "rev-parse", "HEAD"), serverHead, "the trial merge moved nothing");
    assert.equal(git(folder, "status", "--porcelain"), "");
    assert.equal(await merging(folder), false);
    assert.equal(await readFile(path.join(folder, ONE), "utf8"), serverText);
    assert.equal(git(seeded.origin, "rev-parse", "main"), githubHead, "and pushed nothing");
    assert.equal((await client.listGithubConflicts("gh")).fingerprint, listed.fingerprint, "the same conflicts have the same fingerprint");
  });
});

test("J2: a file modified on one side and deleted on the other, and the same path added on both with different words, are conflicts of their own kind", async () => {
  await scenario(async ({ client, seeded, folder }) => {
    await onServer(folder, { [ONE]: "server edit\n", [TWO]: null, "chapters/003-new/001-scene.md": "The server's new scene.\n", "server-only.md": "only here\n" });
    await onGithub(seeded, { [ONE]: null, [TWO]: "github edit\n", "chapters/003-new/001-scene.md": "GitHub's new scene, another one.\n", "github-only.md": "only there\n" });
    const listed = await client.listGithubConflicts("gh");
    assert.deepEqual(listed.conflicts.map(({ path: file, server, github, resolvable }) => [file, server, github, resolvable]), [
      [ONE, "modified", "deleted", true],
      [TWO, "deleted", "modified", true],
      ["chapters/003-new/001-scene.md", "added", "added", true],
    ].sort((left, right) => (left[0] < right[0] ? -1 : 1)));
    const one = listed.conflicts.find((entry) => entry.path === ONE);
    assert.equal(one.githubBytes, undefined, "a deleted version has no size");
    assert.equal(one.serverBytes, bytes("server edit\n"));
  });
});

test("J2: a book that parted from GitHub without touching the same files is no conflict: the list is empty, there is nothing to resolve, and a sync brings them together as it always did", async () => {
  await scenario(async ({ client, seeded, folder }) => {
    const serverHead = await onServer(folder, { [ONE]: "server edit\n" });
    const githubHead = await onGithub(seeded, { [THREE]: "github edit\n" });
    const listed = await client.listGithubConflicts("gh");
    assert.deepEqual([listed.conflicts, listed.total, listed.ahead, listed.behind], [[], 0, 1, 1]);
    const refused = await attempt(() => client.resolveGithubConflicts("gh", { default: "server", fingerprint: listed.fingerprint }));
    assert.deepEqual([refused.status, refused.code], [409, "not_conflicted"]);
    const synced = await client.syncGitHub("gh");
    assert.equal(synced.lastSync.ok, true);
    assert.equal(parents(folder).length, 1, "the server's commit was put on top of GitHub's, as it always was: no merge commit");
    assert.doesNotThrow(() => git(folder, "merge-base", "--is-ancestor", githubHead, "HEAD"));
    assert.notEqual(git(folder, "rev-parse", "HEAD"), serverHead);
    assert.equal(git(seeded.origin, "rev-parse", "main"), git(folder, "rev-parse", "HEAD"));
    assert.equal(await readFile(path.join(folder, THREE), "utf8"), "github edit\n");
  });
});

// ---------------------------------------------------------------------------------------------
// Resolving
// ---------------------------------------------------------------------------------------------

/** Three conflicts: a scene changed on both sides, a scene the server changed and GitHub deleted, a scene both added. Answers the heads. */
async function threeConflicts(seeded, folder) {
  const serverHead = await onServer(folder, { [ONE]: "server one\n", [TWO]: "server two\n", "chapters/003-new/001-scene.md": "server new\n", "server-note.md": "kept\n" });
  const githubHead = await onGithub(seeded, { [ONE]: "github one\n", [TWO]: null, "chapters/003-new/001-scene.md": "github new\n", "github-note.md": "kept too\n" });
  return { serverHead, githubHead };
}

test("J2: a resolution is one merge commit with both histories, pushed: each file is the version chosen, the default for the others, and the book is no longer in conflict", async () => {
  await scenario(async ({ client, seeded, folder }) => {
    const { serverHead, githubHead } = await threeConflicts(seeded, folder);
    const listed = await client.listGithubConflicts("gh");
    assert.equal(listed.total, 3);
    const answer = await client.resolveGithubConflicts("gh", { choices: { [ONE]: "github" }, default: "server", fingerprint: listed.fingerprint, message: "Keep the server's work, and my first scene" });
    assert.equal(answer.pushed, true);
    assert.equal(answer.pushError, undefined);
    assert.equal(answer.head, git(folder, "rev-parse", "HEAD"));
    assert.deepEqual(parents(folder), [serverHead, githubHead], "a merge: the history of both sides stays as it is");
    assert.equal(git(folder, "log", "-1", "--format=%s"), "Keep the server's work, and my first scene");
    assert.equal(git(seeded.origin, "rev-parse", "main"), answer.head, "GitHub has it");
    assert.deepEqual(answer.resolved, [
      { path: ONE, choice: "github" },
      { path: TWO, choice: "server" },
      { path: "chapters/003-new/001-scene.md", choice: "server" },
    ].sort((left, right) => (left.path < right.path ? -1 : 1)));
    assert.deepEqual(answer.counts, { total: 3, server: 2, github: 1, ignored: 0, unresolvable: 0 });
    assert.deepEqual([answer.ignored, answer.unresolvable], [[], []]);
    assert.equal(await readFile(path.join(folder, ONE), "utf8"), "github one\n");
    assert.equal(await readFile(path.join(folder, TWO), "utf8"), "server two\n", "the server kept the scene GitHub had deleted");
    assert.equal(await readFile(path.join(folder, "chapters/003-new/001-scene.md"), "utf8"), "server new\n");
    assert.equal(await readFile(path.join(folder, "server-note.md"), "utf8"), "kept\n", "what did not conflict is merged as git merges it");
    assert.equal(await readFile(path.join(folder, "github-note.md"), "utf8"), "kept too\n");
    assert.equal(onOrigin(seeded, ONE), "github one\n");
    assert.equal(git(folder, "status", "--porcelain"), "");
    assert.equal(await merging(folder), false);
    const after = await client.listGithubConflicts("gh");
    assert.deepEqual([after.conflicts, after.ahead, after.behind], [[], 0, 0], "nothing is in conflict any more");
    const summary = (await client.listBooks()).find((book) => book.bookId === "gh");
    assert.equal(summary.lastSync.ok, true);
    assert.equal(summary.lastSync.head, answer.head);
  });
});

test("J2: «take GitHub's» for everything follows GitHub also where it deleted a file; «keep the server's» for everything keeps the server's work whole", async () => {
  for (const side of ["github", "server"]) {
    await scenario(async ({ client, seeded, folder }) => {
      await threeConflicts(seeded, folder);
      const listed = await client.listGithubConflicts("gh");
      const answer = await client.resolveGithubConflicts("gh", { default: side, fingerprint: listed.fingerprint });
      assert.deepEqual(answer.counts, { total: 3, server: side === "server" ? 3 : 0, github: side === "github" ? 3 : 0, ignored: 0, unresolvable: 0 }, side);
      assert.equal(await readFile(path.join(folder, ONE), "utf8"), `${side} one\n`);
      assert.equal(await exists(path.join(folder, TWO)), side === "server", `${side}: the deleted scene follows the choice`);
      assert.equal(await readFile(path.join(folder, "chapters/003-new/001-scene.md"), "utf8"), `${side} new\n`);
      assert.match(git(folder, "log", "-1", "--format=%s"), /conflicts with GitHub/, "a message of its own when the author gave none");
      assert.equal(git(seeded.origin, "rev-parse", "main"), answer.head);
    });
  }
});

test("J2: a file without a choice and no default is refused with the paths (nothing is chosen at random, nothing is written); a choice for a file that does not conflict is left aside and said", async () => {
  await scenario(async ({ server, client, seeded, folder }) => {
    const { serverHead, githubHead } = await threeConflicts(seeded, folder);
    const { fingerprint } = await client.listGithubConflicts("gh");
    const missing = await client.resolveGithubConflicts("gh", { choices: { [ONE]: "server" }, fingerprint }).then(() => null, (error) => error);
    assert.deepEqual([missing.status, missing.code], [400, "choice_missing"]);
    assert.deepEqual(missing.details.paths, [TWO, "chapters/003-new/001-scene.md"].sort());
    assert.equal(missing.details.missing, 2);
    assert.deepEqual([git(folder, "rev-parse", "HEAD"), git(seeded.origin, "rev-parse", "main")], [serverHead, githubHead], "nothing was written");
    const api = await rawApi(server);
    for (const body of [{ default: "both" }, { choices: { [ONE]: "mine" } }, { choices: [] }, { choices: "server" }, { extra: 1 }, { message: 5 }, { message: "x".repeat(2000) }, { fingerprint: 7 }, { default: null }]) {
      const answer = await api("POST", "/api/v1/books/gh/github-conflicts/resolve", body);
      assert.deepEqual([answer.status, answer.json?.code], [400, "invalid_request"], JSON.stringify(body).slice(0, 80));
    }
    const answer = await client.resolveGithubConflicts("gh", { choices: { [ONE]: "server", [TWO]: "github", "chapters/003-new/001-scene.md": "github", [NOTES]: "github", "nowhere.md": "server" }, fingerprint });
    assert.deepEqual(answer.ignored, ["notes.md", "nowhere.md"], "the choices for files that do not conflict");
    assert.deepEqual(answer.counts, { total: 3, server: 1, github: 2, ignored: 2, unresolvable: 0 });
    assert.equal(await readFile(path.join(folder, NOTES), "utf8"), BASE_FILES[NOTES], "and they changed nothing");
  });
});

test("J2: when the conflicts changed after the author chose (GitHub moved again on those files), nothing is written and the answer is the new list; a move elsewhere changes nothing", async () => {
  await scenario(async ({ client, seeded, folder }) => {
    const { serverHead } = await threeConflicts(seeded, folder);
    const first = await client.listGithubConflicts("gh");
    // The author edits a scene in conflict again, before the resolution arrives.
    const again = await onGithub(seeded, { [ONE]: "github one, rewritten again\n" });
    const changed = await client.resolveGithubConflicts("gh", { default: "server", fingerprint: first.fingerprint }).then(() => null, (error) => error);
    assert.deepEqual([changed.status, changed.code], [409, "conflicts_changed"]);
    assert.equal(changed.details.total, 3);
    assert.notEqual(changed.details.fingerprint, first.fingerprint);
    assert.ok(changed.details.conflicts.some((entry) => entry.path === ONE));
    assert.deepEqual([git(folder, "rev-parse", "HEAD"), git(seeded.origin, "rev-parse", "main")], [serverHead, again], "nothing was written, nothing was pushed");
    // A change to a file that is not in conflict leaves the conflicts as the author saw them.
    const elsewhere = await onGithub(seeded, { [THREE]: "github three\n" });
    const answer = await client.resolveGithubConflicts("gh", { default: "github", fingerprint: changed.details.fingerprint });
    assert.deepEqual(parents(folder), [serverHead, elsewhere]);
    assert.equal(await readFile(path.join(folder, ONE), "utf8"), "github one, rewritten again\n");
    assert.equal(await readFile(path.join(folder, THREE), "utf8"), "github three\n");
    assert.equal(git(seeded.origin, "rev-parse", "main"), answer.head);
  });
});

test("J2: without a fingerprint the server compares with the last list it gave of the book; a book whose conflicts it never listed is refused with the list", async () => {
  await scenario(async ({ client, seeded, folder }) => {
    await threeConflicts(seeded, folder);
    const unseen = await client.resolveGithubConflicts("gh", { default: "server" }).then(() => null, (error) => error);
    assert.deepEqual([unseen.status, unseen.code, unseen.details.total], [409, "conflicts_changed", 3]);
    await client.listGithubConflicts("gh", { limit: 1 });
    const answer = await client.resolveGithubConflicts("gh", { default: "server" });
    assert.equal(answer.counts.total, 3);
  });
});

test("J2: nothing to resolve, a book that is not on GitHub, a book that is not there, and a run that is active are each refused with their own code", async () => {
  const ai = holdingAi(HELD, 1);
  await scenario(async ({ client }) => {
    const calm = await attempt(() => client.resolveGithubConflicts("gh", { default: "server" }));
    assert.deepEqual([calm.status, calm.code], [409, "not_conflicted"]);
    await seededBook(client, "loc");
    for (const call of [() => client.listGithubConflicts("loc"), () => client.resolveGithubConflicts("loc", { default: "server" })]) {
      const local = await attempt(call);
      assert.deepEqual([local.status, local.code], [409, "no_remote"]);
    }
    for (const call of [() => client.listGithubConflicts("nope"), () => client.resolveGithubConflicts("nope", { default: "server" })]) assert.equal((await attempt(call)).status, 404);
    await client.startAutopilot("gh", startOf(1));
    await until(() => ai.isHeld(), 60_000);
    const busy = await attempt(() => client.resolveGithubConflicts("gh", { default: "server" }));
    assert.deepEqual([busy.status, busy.code], [409, "busy"]);
    await client.pauseAutopilot("gh", "now");
    ai.release();
    await finished(client, "gh", 60_000);
  }, { files: seedBookFilesWithChapters(), options: { ai, autopilot: { retryDelayMs: 0 } } });
});

test("J2: a push that GitHub refuses because it moved meanwhile is tried once more on the new GitHub; a move onto the files in conflict is refused, and nothing is written", async () => {
  // Tried again: the author pushed a note while the resolution was on its way.
  await scenario(async ({ client, seeded, folder }) => {
    const { serverHead } = await threeConflicts(seeded, folder);
    const { fingerprint } = await client.listGithubConflicts("gh");
    const original = GitRepository.prototype.pushCommit;
    let pushes = 0;
    let moved;
    GitRepository.prototype.pushCommit = async function (...args) {
      pushes += 1;
      if (pushes === 1) moved = await onGithub(seeded, { [NOTES]: "a note pushed meanwhile\n" });
      return original.apply(this, args);
    };
    try {
      const answer = await client.resolveGithubConflicts("gh", { default: "github", fingerprint });
      assert.equal(pushes, 2, "one more push, once");
      assert.equal(answer.pushed, true);
      assert.deepEqual(parents(folder), [serverHead, moved], "merged with GitHub as it is now");
      assert.equal(git(seeded.origin, "rev-parse", "main"), answer.head);
      assert.equal(await readFile(path.join(folder, NOTES), "utf8"), "a note pushed meanwhile\n");
    } finally {
      GitRepository.prototype.pushCommit = original;
    }
  });
  // Refused: the author changed a scene in conflict while the resolution was on its way.
  await scenario(async ({ client, seeded, folder }) => {
    const { serverHead } = await threeConflicts(seeded, folder);
    const { fingerprint } = await client.listGithubConflicts("gh");
    const original = GitRepository.prototype.pushCommit;
    let moved;
    GitRepository.prototype.pushCommit = async function (...args) {
      if (!moved) moved = await onGithub(seeded, { [ONE]: "the author, faster\n" });
      return original.apply(this, args);
    };
    try {
      const changed = await attempt(() => client.resolveGithubConflicts("gh", { default: "github", fingerprint }));
      assert.deepEqual([changed.status, changed.code], [409, "conflicts_changed"]);
      assert.deepEqual([git(folder, "rev-parse", "HEAD"), git(seeded.origin, "rev-parse", "main")], [serverHead, moved], "nothing was written");
      assert.equal(git(folder, "status", "--porcelain"), "");
    } finally {
      GitRepository.prototype.pushCommit = original;
    }
  });
});

test("J2: a push that fails for another reason leaves the resolution on the server, says why without the token, and the next sync publishes it", async () => {
  const lines = [];
  await scenario(async ({ client, seeded, folder }) => {
    const { githubHead } = await threeConflicts(seeded, folder);
    const { fingerprint } = await client.listGithubConflicts("gh");
    const original = GitRepository.prototype.pushCommit;
    GitRepository.prototype.pushCommit = async function () {
      throw new Error(`git push failed: remote: Invalid username or token ${TOKEN}`);
    };
    let answer;
    try {
      answer = await client.resolveGithubConflicts("gh", { default: "server", fingerprint });
    } finally {
      GitRepository.prototype.pushCommit = original;
    }
    assert.equal(answer.pushed, false);
    assert.match(answer.pushError, /Invalid username or token/);
    assert.equal(answer.head, git(folder, "rev-parse", "HEAD"), "resolved on the server");
    assert.equal(git(seeded.origin, "rev-parse", "main"), githubHead, "not on GitHub yet");
    const summary = (await client.listBooks()).find((book) => book.bookId === "gh");
    assert.equal(summary.lastSync.ok, false);
    assert.ok(!JSON.stringify([answer, summary]).includes(TOKEN), "the token is in none of it");
    assert.deepEqual((await client.listGithubConflicts("gh")).conflicts, [], "the book is no longer in conflict");
    await client.syncGitHub("gh");
    assert.equal(git(seeded.origin, "rev-parse", "main"), answer.head, "a sync publishes the resolution");
  }, { options: { log: (line) => lines.push(line) } });
  assert.ok(!lines.join("\n").includes(TOKEN));
});

// Every file is a git operation: on Windows each costs about a fifth of a second more (a thousand of them took this one test more than two minutes and the whole file
// past its five), and on a macOS runner `git merge-tree` has failed to create a temporary file under that many. Three hundred still make three pages of a hundred, and
// the paging, the default and the exceptions are what is under test; Linux runs the thousand.
const MANY = process.platform === "linux" ? 1000 : 300;

test("J2: many conflicts are listed a page at a time, and resolved with a default and a few exceptions; no answer grows with them", async () => {
  const name = (index) => `notes/n${String(index).padStart(4, "0")}.md`;
  const many = Object.fromEntries(Array.from({ length: MANY }, (_, index) => [name(index), `base ${index}\n`]));
  const middle = Math.floor(MANY / 2);
  await scenario(async ({ server, client, seeded, folder }) => {
    await onServer(folder, Object.fromEntries(Object.keys(many).map((file, index) => [file, `server ${index}\n`])));
    await onGithub(seeded, Object.fromEntries(Object.keys(many).map((file, index) => [file, `github ${index}\n`])));
    const first = await client.listGithubConflicts("gh");
    assert.deepEqual([first.total, first.conflicts.length, first.limit], [MANY, 100, 100]);
    const pages = [];
    for (let offset = 0; offset < MANY; offset += 250) pages.push(...(await client.listGithubConflicts("gh", { offset, limit: 250 })).conflicts.map((entry) => entry.path));
    assert.deepEqual(pages, Object.keys(many).sort(), "every conflict once, in the order of the paths");
    assert.equal((await client.listGithubConflicts("gh", { offset: MANY })).conflicts.length, 0);
    assert.equal((await client.listGithubConflicts("gh", { limit: 500 })).conflicts.length, Math.min(500, MANY));
    for (const query of ["limit=501", "limit=0", "offset=-1", "offset=x", "limit=1.5"]) {
      const api = await rawApi(server);
      assert.equal((await api("GET", `/api/v1/books/gh/github-conflicts?${query}`)).status, 400, query);
    }
    const exceptions = { [name(0)]: "server", [name(middle)]: "server", [name(MANY - 1)]: "server" };
    const answer = await client.resolveGithubConflicts("gh", { default: "github", choices: exceptions, fingerprint: first.fingerprint });
    assert.deepEqual(answer.counts, { total: MANY, server: 3, github: MANY - 3, ignored: 0, unresolvable: 0 });
    assert.ok(answer.resolved.length <= 100, `the answer lists the first files only: ${answer.resolved.length}`);
    assert.ok(JSON.stringify(answer).length < 32 * 1024);
    assert.equal(await readFile(path.join(folder, name(middle)), "utf8"), `server ${middle}\n`);
    assert.equal(await readFile(path.join(folder, name(middle + 1)), "utf8"), `github ${middle + 1}\n`);
    assert.equal(git(seeded.origin, "rev-parse", "main"), answer.head);
  }, { files: { ...seedBookFilesWithChapters(), ...many } });
});

// ---------------------------------------------------------------------------------------------
// The autopilot's own files
// ---------------------------------------------------------------------------------------------

const AUTOPILOT = { "autopilot/state.json": stateFile("2026-03-01T10:00:00.000Z", "base"), "autopilot/activity.json": "{\"schemaVersion\":1,\"activities\":[]}\n", "autopilot/plan.md": "# Plan\n" };

test("J3: the autopilot's files are never asked about: with no run on the server the newer state wins, and the state, its log and its plan come from the same side", async () => {
  for (const newer of ["server", "github"]) {
    await scenario(async ({ client, seeded, folder }) => {
      const serverState = stateFile(newer === "server" ? "2026-03-03T10:00:00.000Z" : "2026-03-02T10:00:00.000Z", "server");
      const githubState = stateFile(newer === "github" ? "2026-03-03T10:00:00.000Z" : "2026-03-02T10:00:00.000Z", "github");
      await onServer(folder, { "autopilot/state.json": serverState, "autopilot/activity.json": "{\"schemaVersion\":1,\"activities\":[\"server\"]}\n", [ONE]: "server one\n" });
      await onGithub(seeded, { "autopilot/state.json": githubState, "autopilot/plan.md": "# Plan of GitHub\n", [ONE]: "github one\n" });
      const listed = await client.listGithubConflicts("gh");
      assert.deepEqual(listed.conflicts.map((entry) => entry.path), [ONE], `${newer}: only the scene is asked about`);
      assert.equal(listed.autopilotFiles, newer);
      const answer = await client.resolveGithubConflicts("gh", { default: "github", fingerprint: listed.fingerprint });
      assert.equal(answer.autopilotFiles, newer);
      assert.equal(await readFile(path.join(folder, ONE), "utf8"), "github one\n");
      const state = await readFile(path.join(folder, "autopilot/state.json"), "utf8");
      const activity = await readFile(path.join(folder, "autopilot/activity.json"), "utf8");
      const plan = await readFile(path.join(folder, "autopilot/plan.md"), "utf8");
      if (newer === "server") {
        assert.deepEqual([state, activity, plan], [serverState, "{\"schemaVersion\":1,\"activities\":[\"server\"]}\n", AUTOPILOT["autopilot/plan.md"]], "the server's three files");
      } else {
        assert.deepEqual([state, activity, plan], [githubState, AUTOPILOT["autopilot/activity.json"], "# Plan of GitHub\n"], "GitHub's three files");
      }
    }, { files: { ...seedBookFilesWithChapters(), ...BASE_FILES, ...AUTOPILOT } });
  }
});

test("J3: a book whose only conflict is in the autopilot's files has nothing to resolve: a sync merges it by itself, with the newer state", async () => {
  await scenario(async ({ client, seeded, folder }) => {
    const serverState = stateFile("2026-03-05T10:00:00.000Z", "server");
    await onServer(folder, { "autopilot/state.json": serverState });
    const githubHead = await onGithub(seeded, { "autopilot/state.json": stateFile("2026-03-04T10:00:00.000Z", "github") });
    const listed = await client.listGithubConflicts("gh");
    assert.deepEqual([listed.conflicts, listed.total, listed.autopilotFiles], [[], 0, "server"]);
    assert.equal((await attempt(() => client.resolveGithubConflicts("gh", { default: "github", fingerprint: listed.fingerprint }))).code, "not_conflicted");
    const synced = await client.syncGitHub("gh");
    assert.equal(synced.lastSync.ok, true);
    assert.equal(await readFile(path.join(folder, "autopilot/state.json"), "utf8"), serverState);
    assert.equal(parents(folder).length, 2, "merged, not rebased: the state is taken whole");
    assert.doesNotThrow(() => git(folder, "merge-base", "--is-ancestor", githubHead, "HEAD"));
    assert.equal(git(seeded.origin, "rev-parse", "main"), git(folder, "rev-parse", "HEAD"));
  }, { files: { ...seedBookFilesWithChapters(), ...BASE_FILES, ...AUTOPILOT } });
});

// ---------------------------------------------------------------------------------------------
// The run
// ---------------------------------------------------------------------------------------------

test("J1+J4: a run whose step conflicts with GitHub stops with a conflict that says how many files; the conflict is resolved from the list, and the run resumes with the usual Resume", async () => {
  const ai = holdingAi(HELD, 1);
  await scenario(async ({ client, seeded, folder }) => {
    await client.updateAutopilotOptions("gh", { publishEvery: "off" });
    await client.startAutopilot("gh", startOf(1));
    await until(() => ai.isHeld(), 60_000);
    // The concept is saved on the server and not published; the author rewrites the same file on GitHub.
    const githubHead = await onGithub(seeded, { "story-design.md": "# Story Design\n\nThe author's own design.\n" });
    ai.release();
    const stopped = await finished(client, "gh", 90_000);
    assert.equal(stopped.state.status, "error");
    const { lastError } = stopped.state;
    assert.equal(lastError.errorKind, "conflict");
    assert.deepEqual(lastError.errorDetail, { githubConflicts: 1 });
    assert.match(lastError.message, /changed on GitHub in a way that conflicts with the server's work/);
    assert.match(lastError.message, /1 file\b/);
    assert.match(lastError.message, /Where it runs|error panel/);
    assert.doesNotMatch(lastError.message, /admin panel/, "the resolver is in the app: the admin panel has none");
    assert.match(lastError.message, /then resume/);
    assert.doesNotMatch(lastError.message, /from the web app/);
    const synced = await attempt(() => client.syncGitHub("gh"));
    assert.deepEqual([synced.status, synced.code], [409, "github_conflict"]);
    const summary = (await client.listBooks()).find((book) => book.bookId === "gh");
    assert.deepEqual([summary.lastSync.ok, summary.lastSync.conflicts], [false, 1]);
    const listed = await client.listGithubConflicts("gh");
    assert.deepEqual(listed.conflicts.map((entry) => entry.path), ["story-design.md"]);
    const answer = await client.resolveGithubConflicts("gh", { default: "server", fingerprint: listed.fingerprint });
    assert.equal(answer.pushed, false, "the book is not published (publishEvery: off), and neither is the resolution");
    assert.equal(answer.pushError, undefined);
    assert.equal(git(seeded.origin, "rev-parse", "main"), githubHead);
    assert.equal((await client.autopilot("gh")).running, false, "a resolution does not start the run");
    await client.startAutopilot("gh");
    const resumed = await finished(client, "gh", 90_000);
    assert.equal(resumed.state.status, "completed", resumed.state.message ?? "");
    assert.equal(resumed.state.stats.tasks, STEPS(1), "no step was done twice");
    assert.doesNotThrow(() => git(folder, "merge-base", "--is-ancestor", githubHead, "HEAD"));
    assert.equal(git(folder, "status", "--porcelain"), "");
  }, { files: seedBookFilesWithChapters(), options: { ai, autopilot: { retryDelayMs: 0 } } });
});

test("J3: during a run the server's autopilot files win without asking: a state another device pushed does not stop the run", async () => {
  const ai = holdingAi(HELD, 1);
  await scenario(async ({ client, seeded, folder }) => {
    await client.updateAutopilotOptions("gh", { publishEvery: "off" });
    await client.startAutopilot("gh", startOf(1));
    await until(() => ai.isHeld(), 60_000);
    const other = await onGithub(seeded, { "autopilot/state.json": stateFile("2099-01-01T00:00:00.000Z", "another device"), "autopilot/plan.md": "# Another device's plan\n" });
    ai.release();
    const done = await finished(client, "gh", 90_000);
    assert.equal(done.state.status, "completed", done.state.message ?? "");
    assert.doesNotThrow(() => git(folder, "merge-base", "--is-ancestor", other, "HEAD"), "GitHub's commit is in the server's history");
    assert.doesNotMatch(await readFile(path.join(folder, "autopilot/plan.md"), "utf8"), /Another device/, "the server's plan, not the other device's");
    assert.notEqual(JSON.parse(await readFile(path.join(folder, "autopilot/state.json"), "utf8")).brief.idea, "another device");
    assert.equal(git(folder, "status", "--porcelain"), "");
  }, { files: seedBookFilesWithChapters(), options: { ai, autopilot: { retryDelayMs: 0 } } });
});

// ---------------------------------------------------------------------------------------------
// Safety
// ---------------------------------------------------------------------------------------------

test("J6: a file whose name the server does not read or write is listed as not resolvable here, cleaned, and kept as the server has it; the others are resolved", { skip: process.platform === "win32" && "Windows cannot hold these names" }, async () => {
  const odd = { "notes/aux.md": "base aux\n", "a?b.md": "base ab\n", "bad\nname.md": "base bad\n" };
  await scenario(async ({ client, seeded, folder }) => {
    await onServer(folder, { [ONE]: "server one\n", "notes/aux.md": "server aux\n", "a?b.md": "server ab\n", "bad\nname.md": "server bad\n" });
    await onGithub(seeded, { [ONE]: "github one\n", "notes/aux.md": "github aux\n", "a?b.md": "github ab\n", "bad\nname.md": "github bad\n" });
    const listed = await client.listGithubConflicts("gh");
    assert.equal(listed.total, 4);
    const byPath = Object.fromEntries(listed.conflicts.map((entry) => [entry.path, entry]));
    assert.equal(byPath[ONE].resolvable, true);
    for (const name of ["notes/aux.md", "a?b.md"]) assert.deepEqual([byPath[name].resolvable, byPath[name].reason], [false, "unsafe-path"], name);
    const cleaned = listed.conflicts.find((entry) => entry.path.startsWith("bad"));
    assert.ok(cleaned && !/[\n\r]/.test(cleaned.path), JSON.stringify(cleaned?.path));
    assert.deepEqual([cleaned.resolvable, cleaned.reason], [false, "unsafe-path"]);
    const answer = await client.resolveGithubConflicts("gh", { default: "github", choices: { "notes/aux.md": "github" }, fingerprint: listed.fingerprint });
    assert.deepEqual(answer.counts, { total: 4, server: 0, github: 1, ignored: 1, unresolvable: 3 });
    assert.deepEqual(answer.ignored, ["notes/aux.md"], "a choice for a file that cannot be chosen for is left aside");
    assert.equal(await readFile(path.join(folder, ONE), "utf8"), "github one\n");
    assert.equal(await readFile(path.join(folder, "notes/aux.md"), "utf8"), "server aux\n");
    assert.equal(await readFile(path.join(folder, "a?b.md"), "utf8"), "server ab\n");
    assert.equal(await readFile(path.join(folder, "bad\nname.md"), "utf8"), "server bad\n");
    assert.equal(git(seeded.origin, "rev-parse", "main"), answer.head);
  }, { files: { ...seedBookFilesWithChapters(), ...BASE_FILES, ...odd } });
});

test("J6: a hostile repository runs nothing: attributes that name filters and merge drivers, a .gitmodules with commands, hooks in the copy and a configuration outside the server's", async (t) => {
  if (process.platform === "win32") return t.skip("the commands of this test are POSIX ones");
  const markers = await temporary("narrarium-markers-");
  const evil = await temporary("narrarium-evil-home-");
  const touch = (name) => `touch ${path.join(markers, name)}`;
  const hooks = path.join(evil, "hooks");
  await mkdir(hooks, { recursive: true });
  const hookNames = ["pre-commit", "post-commit", "pre-merge-commit", "post-merge", "post-checkout", "pre-push", "reference-transaction", "post-rewrite", "prepare-commit-msg", "commit-msg"];
  for (const name of hookNames) {
    await writeFile(path.join(hooks, name), `#!/bin/sh\n${touch(`global-${name}`)}\n`);
    await chmod(path.join(hooks, name), 0o755);
  }
  const config = [
    "[filter \"pwn\"]", `\tclean = ${touch("filter-clean")}`, `\tsmudge = ${touch("filter-smudge")}`, `\tprocess = ${touch("filter-process")}`, "\trequired = true",
    "[merge \"pwn\"]", `\tdriver = ${touch("merge-driver")}`,
    "[diff \"pwn\"]", `\tcommand = ${touch("diff-command")}`, `\ttextconv = ${touch("diff-textconv")}`,
    "[core]", `\thooksPath = ${hooks}`, `\tfsmonitor = ${touch("fsmonitor")}`, `\tsshCommand = ${touch("ssh")}`,
  ].join("\n");
  await writeFile(path.join(evil, ".gitconfig"), `${config}\n`);
  await writeFile(path.join(evil, "config"), `${config}\n`);
  const hostile = {
    ".gitattributes": "* filter=pwn diff=pwn merge=pwn\n",
    ".gitmodules": `[submodule "evil"]\n\tpath = evil\n\turl = ext::sh -c ${touch("submodule-url").replace(/ /g, "% ")}\n\tupdate = !${touch("submodule-update")}\n`,
  };
  try {
    await scenario(async ({ client, seeded, folder }) => {
      for (const name of hookNames) {
        await writeFile(path.join(folder, ".git", "hooks", name), `#!/bin/sh\n${touch(`copy-${name}`)}\n`);
        await chmod(path.join(folder, ".git", "hooks", name), 0o755);
      }
      await onServer(folder, { [ONE]: "server one\n" });
      await onGithub(seeded, { [ONE]: "github one\n", ".gitattributes": "* filter=pwn diff=pwn merge=pwn\n*.md merge=pwn\n" });
      const saved = { HOME: process.env.HOME, XDG_CONFIG_HOME: process.env.XDG_CONFIG_HOME, GIT_CONFIG_GLOBAL: process.env.GIT_CONFIG_GLOBAL, GIT_CONFIG_SYSTEM: process.env.GIT_CONFIG_SYSTEM };
      Object.assign(process.env, { HOME: evil, XDG_CONFIG_HOME: evil, GIT_CONFIG_GLOBAL: path.join(evil, ".gitconfig"), GIT_CONFIG_SYSTEM: path.join(evil, "config") });
      let answer;
      try {
        const listed = await client.listGithubConflicts("gh");
        assert.deepEqual(listed.conflicts.map((entry) => entry.path), [ONE]);
        answer = await client.resolveGithubConflicts("gh", { default: "github", fingerprint: listed.fingerprint });
        await client.syncGitHub("gh");
      } finally {
        for (const [key, value] of Object.entries(saved)) {
          if (value === undefined) delete process.env[key];
          else process.env[key] = value;
        }
      }
      assert.equal(answer.pushed, true);
      assert.equal(await readFile(path.join(folder, ONE), "utf8"), "github one\n");
      assert.deepEqual(await readdir(markers), [], "nothing ran");
      assert.equal(await exists(path.join(folder, "evil", ".git")), false, "no submodule was fetched");
    }, { files: { ...seedBookFilesWithChapters(), ...BASE_FILES, ...hostile } });
  } finally {
    await remove(markers, evil);
  }
});

test("J6: a GitHub tree that holds a name git cannot write ('..', '.git') is refused before anything is pushed or written; nothing lands outside the book", async () => {
  await scenario(async ({ client, seeded, folder }) => {
    const serverHead = await onServer(folder, { [ONE]: "server one\n" });
    const githubHead = await onGithub(seeded, { [ONE]: "github one\n" });
    // A commit no GitHub would take (its own checks refuse such trees): crafted with git's plumbing, pushed to the stand-in.
    const blob = gitRaw(seeded.seed, ["hash-object", "-w", "--stdin"], "escaped\n").trim();
    const listing = gitRaw(seeded.seed, ["ls-tree", "HEAD"]);
    const tree = gitRaw(seeded.seed, ["mktree"], `${listing}100644 blob ${blob}\t..\n100644 blob ${blob}\t.GIT\n`).trim();
    const hostile = gitRaw(seeded.seed, ["commit-tree", tree, "-p", githubHead, "-m", "hostile"]).trim();
    git(seeded.seed, "push", "--quiet", seeded.origin, `${hostile}:refs/heads/main`);
    const listed = await client.listGithubConflicts("gh");
    assert.deepEqual(listed.conflicts.map((entry) => entry.path), [ONE]);
    const refused = await client.resolveGithubConflicts("gh", { default: "github", fingerprint: listed.fingerprint }).then(() => null, (error) => error);
    assert.deepEqual([refused.status, refused.code], [422, "invalid_github_path"]);
    assert.deepEqual([git(folder, "rev-parse", "HEAD"), git(seeded.origin, "rev-parse", "main")], [serverHead, hostile], "nothing was written or pushed");
    assert.equal(git(folder, "status", "--porcelain"), "");
    assert.equal(await exists(path.join(path.dirname(folder), ".GIT")), false);
  });
});

test("J6: a server that stopped in the middle of a trial merge finds its copy as it left it: no merge in progress, no lock left behind, and every command works", async () => {
  const seeded = await seedOrigin({ ...seedBookFilesWithChapters(), ...BASE_FILES });
  const dataDir = await temporary("narrarium-crash-");
  const start = () => testing.startNarrariumServer({ dataDir, port: 0, adminPort: 0, ai: createFakeAutopilotAi(), supervised: false, checkRelease: noRelease, tunnel: { findBinary: () => undefined, detectOtherConnectors: async () => [] }, githubRemoteUrl: () => seeded.origin });
  const connect = async (server) => new NarrariumServerClient({ baseUrl: server.url, token: (await server.auth.issue("test client", ["read", "write", "run"])).token });
  try {
    let server = await start();
    let serverHead;
    let folder;
    try {
      const client = await connect(server);
      await client.registerBook("gh", { title: "Remote", storage: GITHUB, githubToken: TOKEN });
      folder = server.data.bookDirectory("gh");
      serverHead = await onServer(folder, { [ONE]: "server one\n" });
      await onGithub(seeded, { [ONE]: "github one\n" });
    } finally {
      await server.close();
    }
    // What a server killed in the middle of the trial merge of an older git leaves: its mark, a merge in progress, and git's lock.
    git(folder, "fetch", "--quiet", seeded.origin, "main");
    await writeFile(path.join(folder, ".git", testing.GIT_OPERATION_MARKER), "trial-merge\n");
    assert.throws(() => git(folder, "merge", "--no-commit", "--no-ff", "-X", "no-renames", "FETCH_HEAD"), "the merge stops on the conflict");
    await writeFile(path.join(folder, ".git", "index.lock"), "");
    assert.equal(await merging(folder), true);
    server = await start();
    try {
      const client = await connect(server);
      assert.equal(await merging(folder), false, "no merge in progress");
      assert.equal(await exists(path.join(folder, ".git", "index.lock")), false, "no lock left");
      assert.equal(await exists(path.join(folder, ".git", testing.GIT_OPERATION_MARKER)), false);
      assert.equal(git(folder, "rev-parse", "HEAD"), serverHead);
      assert.equal(git(folder, "status", "--porcelain"), "", "the copy is as the server left it");
      assert.equal(await readFile(path.join(folder, ONE), "utf8"), "server one\n");
      const listed = await client.listGithubConflicts("gh");
      assert.equal(listed.total, 1);
      await client.resolveGithubConflicts("gh", { default: "github", fingerprint: listed.fingerprint });
      await client.commitFiles("gh", [{ path: NOTES, content: "after the crash\n" }], "a commit works");
      assert.equal(git(folder, "log", "-1", "--format=%s"), "a commit works");
    } finally {
      await server.close();
    }
  } finally {
    await remove(dataDir, seeded.origin, seeded.seed);
  }
});

test("J6: a rebase that a stopped process left in the middle is undone by the recovery, and the copy is back on the server's commit", async () => {
  const seeded = await seedOrigin({ ...BASE_FILES });
  const work = await temporary("narrarium-gitrepo-");
  const home = await temporary("narrarium-githome-");
  try {
    const folder = path.join(work, "repo");
    const repository = new GitRepository(folder, { owner: "me", repo: "remote", branch: "main", token: () => undefined, url: seeded.origin }, { home });
    await repository.clone();
    const serverHead = await onServer(folder, { [ONE]: "server one\n" });
    await onGithub(seeded, { [ONE]: "github one\n" });
    git(folder, "fetch", "--quiet", seeded.origin, "main");
    await writeFile(path.join(folder, ".git", testing.GIT_OPERATION_MARKER), "rebase\n");
    assert.throws(() => git(folder, "rebase", "--quiet", "FETCH_HEAD"), "the rebase stops on the conflict");
    assert.equal(await exists(path.join(folder, ".git", "rebase-merge")), true);
    assert.equal(await repository.recover(), true, "there was something to undo");
    assert.equal(await exists(path.join(folder, ".git", "rebase-merge")), false);
    assert.equal(git(folder, "rev-parse", "HEAD"), serverHead);
    assert.equal(git(folder, "status", "--porcelain"), "");
    assert.equal(await repository.recover(), false, "and nothing more the second time");
    // Without the mark, a merge or a rebase is not the server's: it is left alone (only git's lock goes).
    assert.throws(() => git(folder, "merge", "--no-commit", "--no-ff", "FETCH_HEAD"));
    await repository.recover();
    assert.equal(await merging(folder), true);
    git(folder, "merge", "--abort");
  } finally {
    await remove(work, home, seeded.origin, seeded.seed);
  }
});

test("J2: a GitHub that cannot be reached is a 502 that says what git said, without the token", async () => {
  await scenario(async ({ client, seeded }) => {
    await remove(seeded.origin);
    for (const call of [() => client.listGithubConflicts("gh"), () => client.resolveGithubConflicts("gh", { default: "server" })]) {
      const failed = await attempt(call);
      assert.deepEqual([failed.status, failed.code], [502, "git_failed"]);
      assert.match(failed.message, /git fetch failed/);
      assert.ok(!failed.message.includes(TOKEN));
    }
  });
});

test("J6: the list needs read and the resolution write; the resolution waits for an update like every write; no answer and no log line holds the token or what a file says", async () => {
  const lines = [];
  await scenario(async ({ server, client, seeded, folder }) => {
    await onServer(folder, { [ONE]: "SERVER-WORDS-71x9\n" });
    await onGithub(seeded, { [ONE]: "GITHUB-WORDS-52k3\n" });
    const route = "/api/v1/books/gh/github-conflicts";
    const anonymous = await fetch(`${server.url}${route}`);
    assert.equal(anonymous.status, 401);
    const writer = await rawApi(server, ["write"]);
    assert.deepEqual([(await writer("GET", route)).status, (await writer("GET", route)).json.code], [403, "scope"]);
    const reader = await rawApi(server, ["read"]);
    const listed = await reader("GET", route);
    assert.equal(listed.status, 200);
    const refused = await reader("POST", `${route}/resolve`, { default: "server", fingerprint: listed.json.fingerprint });
    assert.deepEqual([refused.status, refused.json.code], [403, "scope"]);
    const both = await rawApi(server, ["read", "write"]);
    await server.books.requestUpdate(async () => undefined);
    const maintenance = await both("POST", `${route}/resolve`, { default: "server", fingerprint: listed.json.fingerprint });
    assert.deepEqual([maintenance.status, maintenance.json.code], [503, "maintenance"]);
    server.books.leaveMaintenance();
    const resolved = await both("POST", `${route}/resolve`, { default: "server", fingerprint: listed.json.fingerprint });
    assert.equal(resolved.status, 200, resolved.text);
    const said = [listed.text, refused.text, maintenance.text, resolved.text, JSON.stringify(await client.listBooks()), lines.join("\n")].join("\n");
    for (const secret of [TOKEN, "SERVER-WORDS-71x9", "GITHUB-WORDS-52k3"]) assert.ok(!said.includes(secret), `nothing says ${secret}`);
    assert.ok(lines.some((line) => /conflicts with GitHub were resolved/.test(line) && /1 file/.test(line)), "the log says that it happened, with the count");
  }, { options: { log: (line) => lines.push(line) } });
});

// ---------------------------------------------------------------------------------------------
// Without git's merge-tree (git older than 2.38): the same answers, from a merge in the copy that is always undone
// ---------------------------------------------------------------------------------------------

test("J2: with git's merge-tree and without it, the conflicts and their resolution are the same, a file that became a folder included, and the copy is left clean", async () => {
  for (const mergeTree of [true, false]) {
    const seeded = await seedOrigin({ ...BASE_FILES, notes: "a file\n" });
    const work = await temporary("narrarium-gitrepo-");
    const home = await temporary("narrarium-githome-");
    try {
      const folder = path.join(work, "repo");
      const repository = new GitRepository(folder, { owner: "me", repo: "remote", branch: "main", token: () => undefined, url: seeded.origin }, { home, mergeTree });
      await repository.clone();
      const serverHead = await onServer(folder, { [ONE]: "server one\n", [TWO]: null, notes: null, "notes/inside.md": "a folder now\n" });
      const githubHead = await onGithub(seeded, { [ONE]: "github one\n", [TWO]: "github two\n", notes: "the file, changed\n" });
      const listed = await repository.githubConflicts({ offset: 0, limit: 100 }, { runActive: false });
      assert.deepEqual(listed.conflicts.map(({ path: file, server, github, resolvable, reason }) => [file, server, github, resolvable, reason]), [
        [ONE, "modified", "modified", true, undefined],
        [TWO, "deleted", "modified", true, undefined],
        ["notes", "deleted", "modified", false, "file-directory"],
      ].sort((left, right) => (left[0] < right[0] ? -1 : 1)), `merge-tree: ${mergeTree}`);
      assert.equal(git(folder, "status", "--porcelain"), "", `merge-tree: ${mergeTree}: the trial left the copy clean`);
      assert.equal(await merging(folder), false);
      const answer = await repository.resolveGithubConflicts({ default: "github", fingerprint: listed.fingerprint }, { runActive: false, push: true });
      assert.deepEqual(answer.counts, { total: 3, server: 0, github: 2, ignored: 0, unresolvable: 1 });
      assert.deepEqual(parents(folder), [serverHead, githubHead]);
      assert.equal(await readFile(path.join(folder, ONE), "utf8"), "github one\n");
      assert.equal(await readFile(path.join(folder, TWO), "utf8"), "github two\n");
      assert.equal(await readFile(path.join(folder, "notes", "inside.md"), "utf8"), "a folder now\n", "the folder is the server's");
      assert.ok(!(await readdir(folder)).some((name) => name.includes("~")), "and no file moved aside by git is left");
      assert.equal(git(folder, "status", "--porcelain"), "");
      assert.equal(git(seeded.origin, "rev-parse", "main"), answer.head);
      assert.equal(await exists(path.join(folder, ".git", testing.GIT_OPERATION_MARKER)), false);
    } finally {
      await remove(work, home, seeded.origin, seeded.seed);
    }
  }
});
