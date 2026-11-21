import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile, mkdir } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";
import http from "node:http";
import { NarrariumServerClient, remoteBookStore, syncBookStores } from "narrarium-engine";
import { MemoryBookStore, createFakeAutopilotAi, seedBookFiles } from "narrarium-engine/testing";
import { SERVER_VERSION, startNarrariumServer } from "../dist/index.js";

async function withServer(run, extra = {}) {
  const dataDir = await mkdtemp(path.join(os.tmpdir(), "narrarium-server-test-"));
  const server = await startNarrariumServer({ dataDir, port: 0, ai: createFakeAutopilotAi(), ...extra });
  try {
    await run(server, new NarrariumServerClient({ baseUrl: server.url, token: server.initialToken ?? "" }), dataDir);
  } finally {
    await server.close();
    await rm(dataDir, { recursive: true, force: true });
  }
}

/** Follow the live stream until `done(message)` returns true. */
async function waitForStream(client, done, timeoutMs = 20000) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  const messages = [];
  try {
    await client.stream((message) => {
      messages.push(message);
      if (done(message)) controller.abort();
    }, controller.signal);
  } catch (error) {
    if (error?.name !== "AbortError") throw error;
  } finally {
    clearTimeout(timer);
  }
  return messages;
}

test("package version is exported", async () => {
  const pkg = JSON.parse(await readFile(new URL("../package.json", import.meta.url), "utf8"));
  assert.equal(SERVER_VERSION, pkg.version);
});

test("the API is protected by tokens, origins and host checks", async () => {
  await withServer(async (server, client) => {
    assert.ok(server.initialToken?.startsWith("nrs_"));
    const info = await (await fetch(`${server.url}/api/v1/info`)).json();
    assert.equal(info.name, "narrarium-server");
    assert.equal((await fetch(`${server.url}/api/v1/books`)).status, 401);
    assert.deepEqual(await client.listBooks(), []);

    const foreign = await fetch(`${server.url}/api/v1/info`, { headers: { origin: "https://evil.example" } });
    assert.equal(foreign.status, 403);
    const allowed = await fetch(`${server.url}/api/v1/info`, { headers: { origin: "https://narrarium.net" } });
    assert.equal(allowed.headers.get("access-control-allow-origin"), "https://narrarium.net");
    const preflight = await fetch(`${server.url}/api/v1/books`, { method: "OPTIONS", headers: { origin: "https://narrarium.net", "access-control-request-method": "GET", "access-control-request-private-network": "true" } });
    assert.equal(preflight.status, 204);
    assert.equal(preflight.headers.get("access-control-allow-private-network"), "true");
    const rebinding = await new Promise((resolve, reject) => {
      const request = http.request(`${server.url}/api/v1/info`, { headers: { host: "attacker.example" } }, (response) => {
        response.resume();
        resolve(response.statusCode);
      });
      request.on("error", reject);
      request.end();
    });
    assert.equal(rebinding, 421, "DNS rebinding through a foreign Host header is refused");

    const created = await server.data.createToken("laptop");
    const laptop = new NarrariumServerClient({ baseUrl: server.url, token: created.token });
    assert.equal((await laptop.session()).clientLabel, "laptop");
    await server.data.revokeToken(created.id);
    await assert.rejects(() => laptop.session(), (error) => error.status === 401);
  });
});

test("a second server cannot use the same data folder", async () => {
  await withServer(async (_server, _client, dataDir) => {
    await assert.rejects(() => startNarrariumServer({ dataDir, port: 0 }), /already using/);
  });
});

test("a local book is uploaded, written by the autopilot on the server and synced back", async () => {
  await withServer(async (server, client) => {
    const local = new MemoryBookStore(seedBookFiles());
    const summary = await client.registerBook("book-1", { title: "The Glass Harbor", storage: { kind: "local" } });
    assert.equal(summary.ready, true);
    const remote = remoteBookStore(client, "book-1");
    const first = await syncBookStores({ local, remote, base: new Map() });
    assert.ok(first.uploaded.includes("book.md"));

    await client.startAutopilot("book-1", { brief: { idea: "A harbor of glass", targetChapters: 1, scenesPerChapter: 1 }, options: { readers: false, readersOnPlan: false } });
    const planned = await waitForStream(client, (message) => message.event === "autopilot" && message.data.type === "run-ended");
    assert.ok(planned.some((message) => message.event === "autopilot" && message.data.type === "task-started"));
    let snapshot = await client.autopilot("book-1");
    assert.equal(snapshot.state.status, "paused");
    assert.equal(snapshot.state.plan.awaitingAuthor, true);

    await client.intervene("book-1", { scope: "from_now", text: "Keep the harbor cold." });
    await client.startAutopilot("book-1");
    await waitForStream(client, (message) => message.event === "autopilot" && message.data.type === "run-ended");
    snapshot = await client.autopilot("book-1");
    assert.equal(snapshot.state.status, "completed");
    assert.ok(snapshot.state.constraints.includes("Keep the harbor cold."));
    assert.ok(snapshot.activities.length > 5);
    const events = await client.events("book-1", 0);
    assert.ok(events.events.length > 5);

    const second = await syncBookStores({ local, remote, base: first.base });
    assert.ok(second.downloaded.includes("chapters/001-chapter-title-1/001-scene-1-title.md"));
    assert.ok(local.files.has("autopilot/state.json"));
    assert.deepEqual(second.conflicts, []);

    const opinion = await client.askDirector("book-1", { target: { kind: "chapter", chapter: "001-chapter-title-1" }, question: "Does it work?", save: true });
    assert.equal(opinion.saved, true);
    const files = await client.readFiles("book-1", [opinion.path]);
    assert.match(files[0].content, /type: director-opinion/);
    const history = execFileSync("git", ["log", "--oneline"], { cwd: server.data.bookDirectory("book-1"), encoding: "utf8" });
    assert.match(history, /Autopilot: /, "every step is a commit on the server");
  });
});

test("the autopilot refuses to start without an AI configuration", async () => {
  await withServer(async (_server, client) => {
    await client.registerBook("book-2", { title: "No AI", storage: { kind: "local" } });
    await assert.rejects(() => client.startAutopilot("book-2"), (error) => error.status === 412 && error.code === "ai_not_configured");
    const status = await client.putAiConfig({ aiIntegrations: [{ id: "a", name: "OpenAI", provider: "openai", apiKey: "sk-secret", chatModels: [{ id: "m", name: "gpt-4o", capabilities: ["default"] }] }] });
    assert.equal(status.configured, true);
    assert.equal(status.integrations[0].hasApiKey, true);
    assert.equal(JSON.stringify(status).includes("sk-secret"), false, "keys are never returned");
  }, { ai: undefined });
});

test("a GitHub book is cloned, written step by step and pushed", async () => {
  const origin = await mkdtemp(path.join(os.tmpdir(), "narrarium-origin-"));
  const seed = await mkdtemp(path.join(os.tmpdir(), "narrarium-seed-"));
  try {
    execFileSync("git", ["init", "--quiet", "--bare", origin]);
    execFileSync("git", ["init", "--quiet", "-b", "dev-author", seed]);
    for (const [file, content] of Object.entries(seedBookFiles())) {
      await mkdir(path.dirname(path.join(seed, file)), { recursive: true });
      await writeFile(path.join(seed, file), content);
    }
    execFileSync("git", ["-c", "user.name=t", "-c", "user.email=t@t", "-C", seed, "add", "-A"]);
    execFileSync("git", ["-c", "user.name=t", "-c", "user.email=t@t", "-C", seed, "commit", "--quiet", "-m", "seed"]);
    execFileSync("git", ["-C", seed, "push", "--quiet", origin, "dev-author"]);
    await withServer(async (_server, client) => {
      const summary = await client.registerBook("gh-book", { title: "Remote", storage: { kind: "github", owner: "me", repo: "remote", branch: "dev-author" }, githubToken: "ghp_test" });
      assert.equal(summary.hasGithubToken, true);
      assert.equal(summary.lastSync.ok, true);
      await client.startAutopilot("gh-book", { brief: { idea: "x", targetChapters: 1, scenesPerChapter: 1 }, options: { readers: false, readersOnPlan: false, pauseAfterPlan: false } });
      await waitForStream(client, (message) => message.event === "autopilot" && message.data.type === "run-ended");
      const snapshot = await client.autopilot("gh-book");
      assert.equal(snapshot.state.status, "completed");
      const pushed = execFileSync("git", ["--git-dir", origin, "log", "--oneline", "dev-author"], { encoding: "utf8" });
      assert.match(pushed, /Autopilot: /, "the steps reached the remote");
      const tree = execFileSync("git", ["--git-dir", origin, "ls-tree", "-r", "--name-only", "dev-author"], { encoding: "utf8" });
      assert.match(tree, /chapters\/001-chapter-title-1\/001-scene-1-title\.md/);
    }, { githubRemoteUrl: () => origin });
  } finally {
    await rm(origin, { recursive: true, force: true });
    await rm(seed, { recursive: true, force: true });
  }
});
