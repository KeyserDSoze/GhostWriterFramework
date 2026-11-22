import test from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { seedBookFiles } from "narrarium-engine/testing";
import * as testing from "../dist/testing.mjs";
import { until, withServer } from "./helpers.mjs";
import { finished, seededBook } from "./fake-provider.mjs";
import { HELD, STEPS, fakeAi, holdingAi, startOf } from "./hold.mjs";

// Where a server publishes a GitHub book (S4-2): after every step and again when a chapter is closed, after every chapter, or never; the
// author changes it while a run goes on. The remote is a bare repository on this machine, and every `git push` of the server is counted.

const { GitRepository } = testing;
const remove = (...directories) => Promise.all(directories.map((directory) => rm(directory, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 })));
const temporary = (prefix) => mkdtemp(path.join(os.tmpdir(), prefix));
const git = (cwd, ...args) => execFileSync("git", ["-c", "user.name=test", "-c", "user.email=test@example.invalid", "-C", cwd, ...args], { encoding: "utf8" }).trim();
const GITHUB = { kind: "github", owner: "me", repo: "remote", branch: "main" };
const TOKEN = "ghp_publishEveryTestToken0123456789";
const TUNING = { retryDelayMs: 0 };
/** A book that git writes to at every step takes longer on some systems than one that does not: these waits are for the slowest of them, not for a fast one. */
const settled = (client, bookId = "gh") => finished(client, bookId, 90_000);
const held = (ai) => until(() => ai.isHeld(), 60_000);

/** A bare repository with one commit on `main`, standing in for GitHub, and a clone of it where "the author" works. */
async function seedOrigin(files = seedBookFiles()) {
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
  return { origin, seed, head: git(origin, "rev-parse", "main") };
}

/** Count the pushes of the server's working copies, and keep the subject of the commit each one carried. */
function watchPushes() {
  const original = GitRepository.prototype.push;
  const pushes = [];
  GitRepository.prototype.push = async function (...args) {
    pushes.push(git(this.dir, "log", "-1", "--format=%s"));
    return original.apply(this, args);
  };
  return { pushes, restore: () => {
    GitRepository.prototype.push = original;
  } };
}

/** The chapters that the pushes closed, in order: a push of the commit that closes chapter 2 says so in its subject. */
const closings = (pushes) => pushes.map((subject) => /Closing chapter (\d+)/.exec(subject)?.[1]).filter(Boolean);

/** One scenario: a remote, a server that clones it as the book `gh`, the pushes counted; everything is cleaned up whatever happens. */
async function scenario(run, { ai = fakeAi(1), extra = {} } = {}) {
  const seeded = await seedOrigin();
  const watch = watchPushes();
  try {
    await withServer(async (server, client, dataDir) => {
      const registered = await client.registerBook("gh", { title: "Remote", storage: GITHUB, githubToken: TOKEN });
      assert.equal(registered.lastSync.ok, true);
      watch.pushes.length = 0;
      await run({ server, client, dataDir, seeded, watch, folder: server.data.bookDirectory("gh"), ai });
    }, { ai, githubRemoteUrl: () => seeded.origin, autopilot: TUNING, ...extra });
  } finally {
    ai.release?.();
    watch.restore();
    await remove(seeded.origin, seeded.seed);
  }
}

const originFiles = (origin) => git(origin, "ls-tree", "-r", "--name-only", "main").split("\n");
/** The files that the server's copy has and GitHub has not: what a publish after the last step still has to carry. */
const unpublished = (folder, origin) => git(folder, "diff", "--name-only", git(origin, "rev-parse", "main"), "HEAD").split("\n").filter(Boolean);
const commitsOf = (directory, revision) => Number(git(directory, "rev-list", "--count", revision));
const FIRST_SCENE = "chapters/001-chapter-title-1/001-scene-1-title.md";
const SECOND_SCENE = "chapters/002-chapter-title-2/001-scene-1-title.md";

// ---------------------------------------------------------------------------------------------
// The three ways of publishing
// ---------------------------------------------------------------------------------------------

test("S4-2: by default a server publishes after every step, and again when a chapter is closed; GitHub has everything at the end", async () => {
  await scenario(async ({ client, watch, seeded, folder }) => {
    await client.startAutopilot("gh", startOf(1));
    const done = await settled(client);
    assert.equal(done.state.status, "completed");
    assert.equal(done.summary.publish, "step");
    assert.equal(watch.pushes.length, STEPS(1) + 1, "one push after each of the steps, and one for the chapter that was closed");
    assert.deepEqual(closings(watch.pushes), ["1", "1"], "the step that closes the chapter is pushed, and then the chapter");
    assert.deepEqual(unpublished(folder, seeded.origin), ["autopilot/state.json"], "GitHub has every step; only the commit that records how the run ended waits for the next push");
    assert.match(git(seeded.origin, "log", "-1", "--format=%s", "main"), /reviews the whole book/, "the last step is the one GitHub ends with");
    assert.ok(originFiles(seeded.origin).includes(FIRST_SCENE));
    const summary = (await client.listBooks())[0];
    assert.equal(summary.lastSync.ok, true);
    assert.equal(summary.lastSync.message, "Pushed to GitHub.");
  });
});

test("S4-2: a book whose state is older (no `publishEvery`, `syncAfterChapter` off) is published after every step as it always was", async () => {
  await scenario(async ({ client, watch, seeded, folder }) => {
    await client.configureAutopilot("gh", { brief: startOf(1).brief, options: { ...startOf(1).options, syncAfterChapter: false } });
    const before = await client.autopilot("gh");
    assert.equal(before.state.options.publishEvery, undefined, "the author chose nothing");
    assert.equal(before.state.options.syncAfterChapter, false);
    assert.equal(before.summary.publish, "step", "a server publishes after every step: the option of the browser does not decide for it");
    await client.startAutopilot("gh");
    const done = await settled(client);
    assert.equal(done.state.status, "completed");
    assert.equal(watch.pushes.length, STEPS(1) + 1);
    assert.deepEqual(unpublished(folder, seeded.origin), ["autopilot/state.json"]);
  });
});

test("S4-2: `chapter` publishes once for every chapter that is closed, and what is left after the last chapter stays on the server", async () => {
  await scenario(async ({ client, watch, seeded, folder }) => {
    await client.updateAutopilotOptions("gh", { publishEvery: "chapter" });
    await client.startAutopilot("gh", startOf(2));
    const done = await settled(client);
    assert.equal(done.state.status, "completed");
    assert.equal(done.summary.publish, "chapter");
    assert.deepEqual(closings(watch.pushes), ["1", "2"]);
    assert.equal(watch.pushes.length, 2, "one for each chapter: nothing for the steps in between");
    const files = originFiles(seeded.origin);
    assert.ok(files.includes(FIRST_SCENE) && files.includes(SECOND_SCENE), "both chapters are on GitHub");
    assert.match(git(seeded.origin, "log", "-1", "--format=%s", "main"), /Closing chapter 2/, "GitHub is at the end of the last chapter");
    assert.ok(commitsOf(folder, "HEAD") > commitsOf(seeded.origin, "main"), "the judgement of the whole book is saved on the server, and waits for the next publish");
  }, { ai: fakeAi(2) });
});

test("S4-2: `off` publishes nothing: every commit stays in the server's copy, and GitHub is as the author left it", async () => {
  await scenario(async ({ client, watch, seeded, folder }) => {
    await client.updateAutopilotOptions("gh", { publishEvery: "off" });
    await client.startAutopilot("gh", startOf(1));
    const done = await settled(client);
    assert.equal(done.state.status, "completed");
    assert.equal(done.summary.publish, "off");
    assert.equal(watch.pushes.length, 0);
    assert.equal(git(seeded.origin, "rev-parse", "main"), seeded.head, "GitHub did not move");
    assert.ok(commitsOf(folder, "HEAD") > STEPS(1), "the steps are all committed in the server's copy");
    assert.ok(!originFiles(seeded.origin).includes(FIRST_SCENE));
    assert.equal(git(folder, "status", "--porcelain"), "", "and nothing is left uncommitted");
    const summary = (await client.listBooks())[0];
    assert.equal(summary.lastSync.message, "Cloned from GitHub.", "no publish was attempted, so none is reported");
    // The owner can still publish by hand, as always.
    watch.pushes.length = 0;
    const synced = await client.syncGitHub("gh");
    assert.equal(synced.lastSync.ok, true);
    assert.equal(git(seeded.origin, "rev-parse", "main"), git(folder, "rev-parse", "HEAD"), "a sync publishes everything that waited");
  });
});

test("S4-2: `null` hands the choice back: the book is published after every step again", async () => {
  await scenario(async ({ client, watch }) => {
    await client.updateAutopilotOptions("gh", { publishEvery: "off" });
    assert.equal((await client.autopilot("gh")).summary.publish, "off");
    const back = await client.updateAutopilotOptions("gh", { publishEvery: null });
    assert.equal(back.summary.publish, "step");
    await client.startAutopilot("gh", startOf(1));
    assert.equal((await settled(client)).state.status, "completed");
    assert.equal(watch.pushes.length, STEPS(1) + 1);
  });
});

test("S4-2: a local book is never pushed, whatever `publishEvery` says", async () => {
  const watch = watchPushes();
  try {
    await withServer(async (_server, client) => {
      for (const publishEvery of ["step", "chapter", "off"]) {
        const bookId = `loc-${publishEvery}`;
        await seededBook(client, bookId);
        await client.updateAutopilotOptions(bookId, { publishEvery });
        await client.startAutopilot(bookId, startOf(1));
        const done = await finished(client, bookId);
        assert.equal(done.state.status, "completed", publishEvery);
        assert.equal(done.summary.publish, publishEvery);
      }
      assert.equal(watch.pushes.length, 0, "there is nowhere to push to");
      assert.ok((await client.listBooks()).every((summary) => summary.lastSync === null), "and no sync is reported");
    }, { ai: fakeAi(1) });
  } finally {
    watch.restore();
  }
});

// ---------------------------------------------------------------------------------------------
// Changing it while a run goes on
// ---------------------------------------------------------------------------------------------

test("S4-2: from `step` to `off` in the middle of the run: what was published stays, and the steps after the change are not pushed", async () => {
  const ai = holdingAi(HELD, 1);
  await scenario(async ({ client, watch, seeded, folder }) => {
    await client.startAutopilot("gh", startOf(1));
    await held(ai);
    assert.equal(watch.pushes.length, 4, "the four steps before the one in flight were pushed as they were saved");
    const origin = git(seeded.origin, "rev-parse", "main");
    assert.equal((await client.updateAutopilotOptions("gh", { publishEvery: "off" })).summary.publish, "off");
    ai.release();
    const done = await settled(client);
    assert.equal(done.state.status, "completed");
    assert.equal(watch.pushes.length, 4, "the step that was running when the author changed it, and every one after, stayed on the server");
    assert.equal(git(seeded.origin, "rev-parse", "main"), origin);
    assert.ok(commitsOf(folder, "HEAD") > commitsOf(seeded.origin, "main"));
  }, { ai });
});

test("S4-2: from `off` to `step` in the middle of the run: the next step publishes everything that waited", async () => {
  const ai = holdingAi(HELD, 1);
  await scenario(async ({ client, watch, seeded, folder }) => {
    await client.updateAutopilotOptions("gh", { publishEvery: "off" });
    await client.startAutopilot("gh", startOf(1));
    await held(ai);
    assert.equal(watch.pushes.length, 0);
    assert.equal(git(seeded.origin, "rev-parse", "main"), seeded.head);
    await client.updateAutopilotOptions("gh", { publishEvery: "step" });
    ai.release();
    const done = await settled(client);
    assert.equal(done.state.status, "completed");
    assert.equal(watch.pushes.length, STEPS(1) - 4 + 1, "one push after each step that was left, and one for the chapter");
    assert.deepEqual(unpublished(folder, seeded.origin), ["autopilot/state.json"], "and the first push carried the commits of the steps that were not published before it");
  }, { ai });
});

test("S4-2: from `step` to `chapter` in the middle of the run: the next push is the one that closes the chapter", async () => {
  const ai = holdingAi(HELD, 1);
  await scenario(async ({ client, watch, seeded, folder }) => {
    await client.startAutopilot("gh", startOf(1));
    await held(ai);
    assert.equal(watch.pushes.length, 4);
    await client.updateAutopilotOptions("gh", { publishEvery: "chapter" });
    ai.release();
    const done = await settled(client);
    assert.equal(done.state.status, "completed");
    assert.equal(watch.pushes.length, 5, "four steps, then the chapter, and nothing for the steps between");
    assert.deepEqual(closings(watch.pushes), ["1"]);
    assert.ok(originFiles(seeded.origin).includes(FIRST_SCENE));
    assert.ok(commitsOf(folder, "HEAD") > commitsOf(seeded.origin, "main"), "the judgement of the book is not published");
  }, { ai });
});

test("S4-2: a pause at the end of the chapter publishes the chapter first when the book is published by chapter, and nothing when it is not published", async () => {
  for (const mode of ["chapter", "off"]) {
    const ai = holdingAi(HELD, 2);
    await scenario(async ({ client, watch, seeded }) => {
      await client.updateAutopilotOptions("gh", { publishEvery: mode });
      await client.startAutopilot("gh", startOf(2));
      await held(ai);
      assert.equal((await client.pauseAutopilot("gh", "after-chapter")).summary.pausePending, "after-chapter");
      ai.release();
      const done = await settled(client);
      assert.equal(done.state.status, "paused", mode);
      assert.equal(done.state.message, "Chapter 1 completed: paused, as you asked.");
      if (mode === "chapter") {
        assert.deepEqual(closings(watch.pushes), ["1"], "the chapter was published before the run paused");
        assert.ok(originFiles(seeded.origin).includes(FIRST_SCENE));
        assert.match(git(seeded.origin, "log", "-1", "--format=%s", "main"), /Closing chapter 1/);
      } else {
        assert.equal(watch.pushes.length, 0);
        assert.equal(git(seeded.origin, "rev-parse", "main"), seeded.head);
      }
    }, { ai, extra: {} });
  }
});

// ---------------------------------------------------------------------------------------------
// A publish that fails is a warning, never a stop
// ---------------------------------------------------------------------------------------------

test("S4-2: a push that fails is a warning: the run goes on, `lastSync` says it without the token, and a sync afterwards makes it right", async () => {
  await scenario(async ({ client, seeded, folder }) => {
    const original = GitRepository.prototype.push;
    GitRepository.prototype.push = async function () {
      throw new Error(`git push failed: remote: Invalid username or token ${TOKEN}`);
    };
    try {
      await client.startAutopilot("gh", startOf(1));
      const done = await settled(client);
      assert.equal(done.state.status, "completed", "a push that fails never stops the run");
      const events = (await client.events("gh")).events;
      const warnings = events.filter((event) => event.type === "sync");
      assert.equal(warnings.filter((event) => event.code === "syncFailed").length, STEPS(1), "a warning for every step that could not be published");
      assert.equal(warnings.filter((event) => event.code === "publishFailed").length, 1, "and one for the chapter");
      assert.ok(warnings.every((event) => event.tone === "warning"));
      const summary = (await client.listBooks())[0];
      assert.equal(summary.lastSync.ok, false);
      assert.match(summary.lastSync.message, /Invalid username or token/, "it says what went wrong");
      assert.ok(!JSON.stringify([summary, events]).includes(TOKEN), "and the token is in none of it");
      assert.equal(git(seeded.origin, "rev-parse", "main"), seeded.head, "nothing reached GitHub");
    } finally {
      GitRepository.prototype.push = original;
    }
    const synced = await client.syncGitHub("gh");
    assert.equal(synced.lastSync.ok, true, "once the push works, a sync publishes what waited");
    assert.equal(git(seeded.origin, "rev-parse", "main"), git(folder, "rev-parse", "HEAD"));
    assert.equal((await client.listBooks())[0].lastSync.ok, true);
  });
});

test("S4-2: when the next push works, `lastSync` is right again without a sync", async () => {
  await scenario(async ({ client, seeded, folder }) => {
    const original = GitRepository.prototype.push;
    let failures = 2;
    GitRepository.prototype.push = async function (...args) {
      if (failures > 0) {
        failures -= 1;
        throw new Error("git push failed: network is unreachable");
      }
      return original.apply(this, args);
    };
    try {
      await client.startAutopilot("gh", startOf(1));
      assert.equal((await settled(client)).state.status, "completed");
    } finally {
      GitRepository.prototype.push = original;
    }
    assert.equal((await client.listBooks())[0].lastSync.ok, true, "the later pushes worked");
    assert.deepEqual(unpublished(folder, seeded.origin), ["autopilot/state.json"], "and carried what the first ones could not");
  });
});

// ---------------------------------------------------------------------------------------------
// The risk of not publishing: the author's changes on GitHub meet the server's unpublished commits
// ---------------------------------------------------------------------------------------------

test("S4-2: with `off`, an author's change to another file on GitHub is rebased under the server's commits and the run goes on", async () => {
  const ai = holdingAi(HELD, 1);
  await scenario(async ({ client, seeded, folder }) => {
    await client.updateAutopilotOptions("gh", { publishEvery: "off" });
    await client.startAutopilot("gh", startOf(1));
    await held(ai);
    await writeFile(path.join(seeded.seed, "author-note.md"), "# A note from the author\n");
    git(seeded.seed, "add", "-A");
    git(seeded.seed, "commit", "--quiet", "-m", "author: a note");
    git(seeded.seed, "push", "--quiet", seeded.origin, "main");
    const authorHead = git(seeded.seed, "rev-parse", "HEAD");
    ai.release();
    const done = await settled(client);
    assert.equal(done.state.status, "completed", done.state.message ?? "");
    assert.equal(await readFile(path.join(folder, "author-note.md"), "utf8"), "# A note from the author\n", "the author's file came in");
    assert.doesNotThrow(() => git(folder, "merge-base", "--is-ancestor", authorHead, "HEAD"), "under the server's commits");
    assert.equal(git(folder, "status", "--porcelain"), "");
    assert.equal(git(seeded.origin, "rev-parse", "main"), authorHead, "and the server published nothing");
  }, { ai });
});

test("S4-2: with `off`, a change on GitHub to a file the server also changed stops the run with a message that says what to do; nothing of the server's work is lost, and the run resumes once it is settled", async () => {
  const ai = holdingAi(HELD, 1);
  await scenario(async ({ client, seeded, folder }) => {
    await client.updateAutopilotOptions("gh", { publishEvery: "off" });
    await client.startAutopilot("gh", startOf(1));
    await held(ai);
    await mkdir(path.join(seeded.seed, "autopilot"), { recursive: true });
    await writeFile(path.join(seeded.seed, "autopilot", "state.json"), '{"written":"by another device"}\n');
    git(seeded.seed, "add", "-A");
    git(seeded.seed, "commit", "--quiet", "-m", "another device: state");
    git(seeded.seed, "push", "--quiet", seeded.origin, "main");
    const conflicting = git(seeded.seed, "rev-parse", "HEAD");
    const before = commitsOf(folder, "HEAD");
    const serverHead = git(folder, "rev-parse", "HEAD");
    ai.release();
    const stopped = await settled(client);
    const message = stopped.state.lastError?.message ?? stopped.state.message ?? "";
    assert.equal(stopped.state.status, "error", "the run cannot go on without choosing between two versions of the same file");
    assert.match(message, /changed on GitHub in a way that conflicts with the server's work/);
    assert.match(message, /Resolve it from the web app, then resume/);
    assert.ok(commitsOf(folder, "HEAD") >= before, "no commit of the server was lost");
    assert.doesNotThrow(() => git(folder, "merge-base", "--is-ancestor", serverHead, "HEAD"), "the commits the server had are still the history of its copy");
    assert.equal(git(folder, "status", "--porcelain"), "", "the working copy is clean: the failed rebase was undone");
    assert.throws(() => git(folder, "merge-base", "--is-ancestor", conflicting, "HEAD"), "the other version is not mixed in");
    assert.equal(git(seeded.origin, "rev-parse", "main"), conflicting, "GitHub is as the author left it");
    const synced = await client.syncGitHub("gh").then(() => null, (error) => error);
    assert.equal(synced.status, 409, "a sync says the same");
    assert.equal(synced.code, "sync_failed");
    assert.match(synced.message, /changed on GitHub/);
    assert.equal((await client.listBooks())[0].lastSync.ok, false);

    // The author settles it on GitHub (here: the file that conflicts is taken out again), and the run resumes where it stopped.
    git(seeded.seed, "rm", "--quiet", "autopilot/state.json");
    git(seeded.seed, "commit", "--quiet", "-m", "settled");
    git(seeded.seed, "push", "--quiet", seeded.origin, "main");
    const settledHead = git(seeded.seed, "rev-parse", "HEAD");
    await client.startAutopilot("gh");
    const resumed = await settled(client);
    assert.equal(resumed.state.status, "completed", resumed.state.message ?? "");
    assert.equal(resumed.state.stats.tasks, STEPS(1), "no step was done twice");
    assert.doesNotThrow(() => git(folder, "merge-base", "--is-ancestor", settledHead, "HEAD"), "the settled version is under the server's commits");
    assert.equal(git(folder, "status", "--porcelain"), "");
  }, { ai });
});
