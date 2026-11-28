import test from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { chmod, mkdir, mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { seedBookFiles } from "narrarium-engine/testing";
import { until, withServer } from "./helpers.mjs";
import { rawApi } from "./api-helpers.mjs";
import { finished, seedBookFilesWithChapters } from "./fake-provider.mjs";
import { startOf } from "./hold.mjs";
import { BROKER, CLIENT_ID, fakeWorld, readableFiles, secretsOf } from "./github-connection-fakes.mjs";

// The books that use the server's own GitHub connection: registered with `githubAuth: "connection"`, they keep no token and every git operation of theirs uses the connection's current access
// token. GitHub's git remote is a bare repository on this machine; what GitHub would be shown (the Authorization header of each git command that talks to it) is read from a `git` that stands in
// front of the real one on the PATH and writes the header it was given before it runs.

const GITHUB = { kind: "github", owner: "me", repo: "remote", branch: "main" };
const ROUTE = "/api/v1/github/connection";
const EIGHT_HOURS = 28_800_000;
const MARGIN = 10 * 60_000;
const IDENTITY = ["-c", "user.name=test", "-c", "user.email=test@example.invalid", "-c", "core.hooksPath=/dev/null", "-c", "submodule.recurse=false"];
const ENV = { ...process.env };
const git = (cwd, ...args) => execFileSync("git", [...IDENTITY, "-C", cwd, ...args], { encoding: "utf8", env: ENV, stdio: ["pipe", "pipe", "pipe"] }).trim();
const temporary = (prefix) => mkdtemp(path.join(os.tmpdir(), prefix));
const remove = (...directories) => Promise.all(directories.map((directory) => rm(directory, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 })));
const exists = (file) => stat(file).then(() => true, () => false);
const skipHere = process.platform === "win32" ? "the stand-in for git is a shell script" : false;

/** A bare repository with one commit on `main` that stands in for GitHub. */
async function seedOrigin(files = { ...seedBookFilesWithChapters() }) {
  const origin = await temporary("narrarium-ghconn-origin-");
  const seed = await temporary("narrarium-ghconn-seed-");
  execFileSync("git", ["init", "--quiet", "--bare", "-b", "main", origin], { env: ENV });
  execFileSync("git", ["init", "--quiet", "-b", "main", seed], { env: ENV });
  for (const [file, content] of Object.entries(files)) {
    await mkdir(path.dirname(path.join(seed, file)), { recursive: true });
    await writeFile(path.join(seed, file), content);
  }
  git(seed, "add", "-A");
  git(seed, "commit", "--quiet", "-m", "seed");
  git(seed, "push", "--quiet", origin, "main");
  return { origin, seed };
}

/** A `git` in front of the real one that writes the Authorization header of every command that carries one, and answers the tokens those headers held. */
async function headerSpy() {
  const folder = await temporary("narrarium-ghconn-spy-");
  const log = path.join(folder, "headers.log");
  const script = path.join(folder, "git");
  await writeFile(script, `#!/bin/sh\nif [ -n "$GIT_CONFIG_VALUE_0" ]; then printf '%s\\n' "$GIT_CONFIG_VALUE_0" >> "${log}"; fi\nPATH="\${PATH#${folder}:}"\nexec git "$@"\n`);
  await chmod(script, 0o755);
  const original = process.env.PATH;
  process.env.PATH = `${folder}${path.delimiter}${original}`;
  return {
    /** The tokens git was given, in order. */
    async tokens() {
      const text = await readFile(log, "utf8").catch(() => "");
      return text.split("\n").filter(Boolean).map((line) => Buffer.from(/basic (\S+)/.exec(line)[1], "base64").toString("utf8").replace(/^x-access-token:/, ""));
    },
    async stop() {
      process.env.PATH = original;
      await remove(folder);
    },
  };
}

/** A server with the fake GitHub and broker, a bare remote, and the spy on git. `run({ server, client, api, world, dataDir, seeded, spy })`. */
async function scenario(run, { files, extra = {} } = {}) {
  const seeded = await seedOrigin(files);
  const spy = await headerSpy();
  const world = fakeWorld();
  try {
    await withServer(async (server, client, dataDir) => {
      const api = await rawApi(server);
      await run({ server, client, api, world, dataDir, seeded, spy });
    }, { githubRemoteUrl: () => seeded.origin, githubConnection: world.options, ...extra });
  } finally {
    await spy.stop();
    await remove(seeded.origin, seeded.seed);
  }
}

async function connected({ server, api, world }) {
  world.script.push("tokens");
  assert.equal((await api("POST", ROUTE, { clientId: CLIENT_ID, broker: BROKER })).status, 200);
  await until(() => server.githubConnection.status().state === "connected");
}

const refusal = (action) => action().then(() => null, (error) => ({ status: error.status, code: error.code, message: error.message }));

test("B1: a book on the connection cannot be registered while the server is not connected: 412 github_connection_required, and nothing is left behind", { skip: skipHere }, async () => {
  await scenario(async ({ client, dataDir, server, spy }) => {
    const refused = await refusal(() => client.registerBook("gh", { title: "Remote", storage: GITHUB, githubAuth: "connection" }));
    assert.deepEqual([refused.status, refused.code], [412, "github_connection_required"]);
    assert.match(refused.message, /not connected to GitHub/);
    assert.deepEqual(await client.listBooks(), []);
    assert.equal(await exists(path.join(dataDir, "books", "gh")), false, "no folder");
    assert.deepEqual(await spy.tokens(), [], "nothing was sent to GitHub");
    assert.equal(server.data.knownSecrets().length, 0);
  });
});

test("B2: a book on the connection is cloned with the connection's token, keeps no token of its own, and says how it proves itself", { skip: skipHere }, async () => {
  await scenario(async ({ client, api, server, world, dataDir, spy }) => {
    await connected({ server, api, world });
    const summary = await client.registerBook("gh", { title: "Remote", storage: GITHUB, githubAuth: "connection" });
    assert.equal(summary.githubAuth, "connection");
    assert.equal(summary.hasGithubToken, false, "a copy of a token is what it does not have");
    assert.equal(summary.lastSync.ok, true);
    assert.equal(summary.lastSync.message, "Cloned from GitHub.");
    assert.deepEqual(await spy.tokens(), [world.current.access], "the clone was made with the connection's token");
    assert.equal((await client.listBooks())[0].githubAuth, "connection");
    const stored = JSON.parse(await readFile(path.join(dataDir, "books.json"), "utf8")).books[0];
    assert.equal(stored.githubAuth, "connection");
    const tokens = await readFile(path.join(dataDir, "private", "book-tokens.json"), "utf8").then((text) => JSON.parse(text).tokens, () => ({}));
    assert.deepEqual(Object.keys(tokens), [], "no token copy of the book on disk");
    assert.equal(await server.data.bookToken("gh"), undefined);
    assert.equal(await exists(path.join(dataDir, "books", "gh", "repo", ".git")), true);
  });
});

test("B3: a request that says nothing of githubAuth is what it always was: a token book, whatever else the server can do", { skip: skipHere }, async () => {
  await scenario(async ({ client, server, spy }) => {
    const summary = await client.registerBook("gh", { title: "Remote", storage: GITHUB, githubToken: "ghp_oldStyleBookToken0123456789abcdef" });
    assert.equal(summary.githubAuth, "token");
    assert.equal(summary.hasGithubToken, true);
    assert.deepEqual(await spy.tokens(), ["ghp_oldStyleBookToken0123456789abcdef"]);
    const refused = await refusal(() => client.registerBook("gh2", { title: "Two", storage: GITHUB }));
    assert.deepEqual([refused.status, refused.code], [412, "github_token_required"], "without a token and without the connection, the refusal it always was");
    const local = await client.registerBook("local", { title: "Local", storage: { kind: "local" } });
    assert.equal("githubAuth" in local, false, "a book that is not on GitHub says nothing of it");
    assert.equal(server.githubConnection.status().state, "disconnected", "and it never touched the connection");
  });
});

test("B4: what cannot be asked: an unknown way, a token with the connection, the connection for a book that is not on GitHub", { skip: skipHere }, async () => {
  await scenario(async ({ client, api, server, world, spy }) => {
    await connected({ server, api, world });
    const asks = [
      [{ storage: GITHUB, githubAuth: "bogus" }, /githubAuth/],
      [{ storage: GITHUB, githubAuth: "connection", githubToken: "ghp_both0123456789abcdefghij" }, /not both/],
      [{ storage: { kind: "local" }, githubAuth: "connection" }, /stored on GitHub/],
    ];
    for (const [request, message] of asks) {
      const refused = await refusal(() => client.registerBook("gh", { title: "Remote", ...request }));
      assert.deepEqual([refused.status, refused.code], [400, "invalid_request"], JSON.stringify(request));
      assert.match(refused.message, message);
    }
    assert.deepEqual(await client.listBooks(), []);
    assert.deepEqual(await spy.tokens(), []);
    // A token book may be told it has no token, as before: `null` with the connection only clears.
    const summary = await client.registerBook("gh", { title: "Remote", storage: GITHUB, githubAuth: "connection", githubToken: null });
    assert.equal(summary.githubAuth, "connection");
  });
});

test("B5: a sync and a push use the token the connection has now: renewed first when it ends soon, so the book never meets an ended one", { skip: skipHere }, async () => {
  await scenario(async ({ client, api, server, world, spy, seeded }) => {
    await connected({ server, api, world });
    await client.registerBook("gh", { title: "Remote", storage: GITHUB, githubAuth: "connection" });
    const first = world.current.access;
    await client.syncGitHub("gh");
    assert.equal(world.refreshes, 0);
    world.advance(EIGHT_HOURS - MARGIN + 1000);
    await client.commitFiles("gh", [{ path: "notes.md", content: "A note from the browser.\n" }], "A note");
    await until(async () => git(seeded.origin, "log", "main", "--format=%s").includes("A note"));
    assert.equal(world.refreshes, 1, "the commit's push renewed the token once");
    const tokens = await spy.tokens();
    assert.equal(tokens[0], first);
    assert.equal(tokens.at(-1), world.current.access, "the push went with the renewed token");
    assert.notEqual(world.current.access, first);
    const summary = (await client.listBooks())[0];
    assert.equal(summary.lastSync.ok, true);
    assert.equal(summary.githubAuth, "connection");
  });
});

test("B6: the conflict routes and the sync use the connection too, and a connection that is lost stops them with a clear 412, not a crash", { skip: skipHere }, async () => {
  await scenario(async ({ client, api, server, world, spy }) => {
    await connected({ server, api, world });
    await client.registerBook("gh", { title: "Remote", storage: GITHUB, githubAuth: "connection" });
    const listed = await client.listGithubConflicts("gh");
    assert.equal(listed.total, 0);
    assert.equal((await spy.tokens()).at(-1), world.current.access, "listing the conflicts fetched GitHub with the connection's token");
    await api("DELETE", ROUTE);
    const used = (await spy.tokens()).length;
    for (const call of [() => client.syncGitHub("gh"), () => client.listGithubConflicts("gh"), () => client.resolveGithubConflicts("gh", { default: "server" })]) {
      const refused = await refusal(call);
      assert.deepEqual([refused.status, refused.code], [412, "github_connection_required"]);
      assert.match(refused.message, /not connected to GitHub/);
    }
    assert.equal((await spy.tokens()).length, used, "nothing was sent to GitHub without a token");
    const book = (await client.listBooks())[0];
    assert.equal(book.githubAuth, "connection", "the book stays on the connection: it works again when that is connected");
    await connected({ server, api, world });
    assert.equal((await client.syncGitHub("gh")).lastSync.ok, true);
    assert.equal((await spy.tokens()).at(-1), world.current.access);
  });
});

test("B7: a run publishes with the connection's token, and when the connection is lost the run stops saying so", { skip: skipHere, timeout: 300_000 }, async () => {
  await scenario(async ({ client, api, server, world, spy, seeded }) => {
    await connected({ server, api, world });
    await client.registerBook("gh", { title: "Remote", storage: GITHUB, githubAuth: "connection" });
    const token = world.current.access;
    await client.startAutopilot("gh", startOf(1));
    const done = await finished(client, "gh");
    assert.equal(done.state.status, "completed", JSON.stringify(done.state).slice(0, 300));
    const used = await spy.tokens();
    assert.ok(used.length > 2, "the run pulled and pushed");
    assert.deepEqual([...new Set(used)], [token], "always with the connection's token");
    assert.ok(git(seeded.origin, "log", "main", "--format=%s").split("\n").length > 2, "and what it wrote reached GitHub");
    await api("DELETE", ROUTE);
    await client.startAutopilot("gh", { ...startOf(2), force: true }).catch(() => undefined);
    const stopped = await finished(client, "gh");
    assert.match(JSON.stringify(stopped.state), /connect/i, "the run says that the connection is why it stopped");
    assert.notEqual(stopped.state.status, "completed");
  }, { files: seedBookFilesWithChapters(2) });
});

test("B8: an old client that changes the title of a book on the connection keeps it on the connection, and one that sends a token moves it to a token", { skip: skipHere }, async () => {
  await scenario(async ({ client, api, server, world }) => {
    await connected({ server, api, world });
    await client.registerBook("gh", { title: "Remote", storage: GITHUB, githubAuth: "connection" });
    const renamed = await client.registerBook("gh", { title: "A better title", storage: GITHUB });
    assert.equal(renamed.githubAuth, "connection", "nothing said, nothing changed");
    assert.equal(renamed.title, "A better title");
    const moved = await client.registerBook("gh", { title: "A better title", storage: GITHUB, githubToken: "ghp_nowATokenBook0123456789abcdef" });
    assert.equal(moved.githubAuth, "token");
    assert.equal(moved.hasGithubToken, true);
    const back = await client.registerBook("gh", { title: "A better title", storage: GITHUB, githubAuth: "connection" });
    assert.equal(back.githubAuth, "connection");
    assert.equal(back.hasGithubToken, false, "the copy is dropped when the book goes back to the connection");
    assert.equal(await server.data.bookToken("gh"), undefined);
    assert.equal(server.data.knownSecrets().includes("ghp_nowATokenBook0123456789abcdef"), false);
  });
});

test("B9: a book on the connection that moves to local storage leaves the connection, and the connection is never in the way of removing a book", { skip: skipHere }, async () => {
  await scenario(async ({ client, api, server, world, dataDir }) => {
    await connected({ server, api, world });
    await client.registerBook("gh", { title: "Remote", storage: GITHUB, githubAuth: "connection" });
    const local = await client.registerBook("gh", { title: "Remote", storage: { kind: "local" } });
    assert.equal("githubAuth" in local, false);
    const stored = JSON.parse(await readFile(path.join(dataDir, "books.json"), "utf8")).books[0];
    assert.equal("githubAuth" in stored, false);
    await api("DELETE", ROUTE);
    await client.registerBook("two", { title: "Two", storage: GITHUB, githubAuth: "connection" }).catch(() => undefined);
    assert.equal((await client.listBooks()).some((book) => book.bookId === "two"), false);
    assert.deepEqual(await client.removeBook("gh"), { removed: true });
  });
});

test("B10: what the books do with the connection leaves no token in the books' files, the data folder or the AI call records", { skip: skipHere, timeout: 300_000 }, async () => {
  await scenario(async ({ client, api, server, world, dataDir }) => {
    await connected({ server, api, world });
    await client.registerBook("gh", { title: "Remote", storage: GITHUB, githubAuth: "connection" });
    world.advance(EIGHT_HOURS - MARGIN + 1000);
    await client.syncGitHub("gh");
    await client.startAutopilot("gh", startOf(1));
    await finished(client, "gh");
    for (const secret of secretsOf(world)) {
      const found = (await readableFiles(dataDir)).filter((entry) => entry.text.includes(secret)).map((entry) => entry.file);
      assert.deepEqual(found, [], `${secret.slice(0, 12)}… is in a file`);
    }
    const remote = await readFile(path.join(dataDir, "books", "gh", "repo", ".git", "config"), "utf8");
    assert.equal(remote.includes("ghu_"), false, "the remote's configuration holds no token");
  });
});
