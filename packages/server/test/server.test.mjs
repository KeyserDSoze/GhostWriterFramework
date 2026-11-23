import test from "node:test";
import { seedBookFilesWithChapters } from "./fake-provider.mjs";
import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile, mkdir, stat } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";
import http from "node:http";
import { NarrariumServerClient, remoteBookStore, syncBookStores } from "narrarium-engine";
import { MemoryBookStore, seedBookFiles } from "narrarium-engine/testing";
import { SERVER_VERSION, startNarrariumServer } from "../dist/testing.mjs";
import { adminLogin, waitForStream, withServer } from "./helpers.mjs";

function rawRequest(url, headers) {
  return new Promise((resolve, reject) => {
    const request = http.request(url, { headers }, (response) => {
      response.resume();
      resolve(response.statusCode);
    });
    request.on("error", reject);
    request.end();
  });
}

test("the package version is the one the server reports", async () => {
  const pkg = JSON.parse(await readFile(new URL("../package.json", import.meta.url), "utf8"));
  assert.equal(SERVER_VERSION, pkg.version);
});

test("the API is protected by tokens, scopes, origins and host checks, and proves its identity", async () => {
  await withServer(async (server, client) => {
    const { info, identity } = await new NarrariumServerClient({ baseUrl: server.url, token: "" }).verifiedInfo();
    assert.equal(info.name, "narrarium-server");
    assert.equal(identity.verified, true);
    assert.equal(identity.fingerprint, server.data.fingerprint);
    assert.equal((await fetch(`${server.url}/api/v1/books`)).status, 401);
    assert.deepEqual(await client.listBooks(), []);
    assert.deepEqual((await client.session()).scopes, ["read", "write", "run"]);

    const foreign = await fetch(`${server.url}/api/v1/info`, { headers: { origin: "https://evil.example" } });
    assert.equal(foreign.status, 403);
    const allowed = await fetch(`${server.url}/api/v1/info`, { headers: { origin: "https://narrarium.net" } });
    assert.equal(allowed.headers.get("access-control-allow-origin"), "https://narrarium.net");
    const preflight = await fetch(`${server.url}/api/v1/books`, { method: "OPTIONS", headers: { origin: "https://narrarium.net", "access-control-request-method": "GET", "access-control-request-private-network": "true" } });
    assert.equal(preflight.status, 204);
    assert.equal(preflight.headers.get("access-control-allow-private-network"), "true");
    assert.equal(await rawRequest(`${server.url}/api/v1/info`, { host: "attacker.example" }), 421, "DNS rebinding through a foreign Host header is refused");

    const reader = await server.auth.issue("reader", ["read"]);
    const readOnly = new NarrariumServerClient({ baseUrl: server.url, token: reader.token });
    assert.deepEqual(await readOnly.listBooks(), []);
    await assert.rejects(() => readOnly.registerBook("b", { title: "x", storage: { kind: "local" } }), (error) => error.status === 403 && error.code === "scope");
    await server.auth.revoke(reader.clientId);
    await assert.rejects(() => readOnly.session(), (error) => error.status === 401);
  });
});

test("a second server cannot use the same data folder", async () => {
  await withServer(async (_server, _client, dataDir) => {
    await assert.rejects(() => startNarrariumServer({ dataDir, port: 0, adminPort: 0 }), /already using/);
  });
});

test("a local book is uploaded, written by the autopilot on the server and synced back", async () => {
  await withServer(async (server, client) => {
    const local = new MemoryBookStore(seedBookFilesWithChapters());
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

test("AI keys and GitHub tokens are encrypted at rest and new AI endpoints wait for the owner's approval", async () => {
  await withServer(async (server, client) => {
    await client.registerBook("book-2", { title: "No AI", storage: { kind: "local" } });
    await assert.rejects(() => client.startAutopilot("book-2"), (error) => error.status === 412 && error.code === "ai_not_configured");
    const status = await client.putAiConfig({ aiIntegrations: [{ id: "a", name: "OpenAI", provider: "openai", endpoint: "https://api.openai.com/v1", apiKey: "sk-secret-value", chatModels: [{ id: "m", name: "gpt-4o", capabilities: ["default"] }] }] });
    assert.equal(status.configured, true);
    assert.equal(status.integrations[0].hasApiKey, true);
    assert.deepEqual(status.pendingApproval, ["https://api.openai.com/v1"], "what waits is the base requests start with, path included");
    assert.equal(JSON.stringify(status).includes("sk-secret-value"), false, "keys are never returned");
    const stored = await readFile(path.join(server.data.root, "private", "ai.json"), "utf8");
    assert.equal(stored.includes("sk-secret-value"), false, "the AI configuration is encrypted on disk");
    if (process.platform !== "win32") assert.equal((await stat(path.join(server.data.root, "private", "master.key"))).mode & 0o777, 0o600);

    const admin = await adminLogin(server);
    assert.deepEqual((await admin.call("GET", "/admin/api/status")).body.pendingAiBases, ["https://api.openai.com/v1"]);
    assert.equal((await admin.call("POST", "/admin/api/ai/approve", { bases: ["https://api.openai.com"] })).status, 200, "the origin, as the owners of the earlier versions approved it, covers the base");
    assert.equal((await client.aiStatus()).pendingApproval, undefined);
    assert.deepEqual(server.allowedBases(), ["https://api.openai.com"]);
  }, { ai: undefined });
});

test("a GitHub book is cloned, written step by step and pushed; its token stays encrypted", async () => {
  const origin = await mkdtemp(path.join(os.tmpdir(), "narrarium-origin-"));
  const seed = await mkdtemp(path.join(os.tmpdir(), "narrarium-seed-"));
  try {
    execFileSync("git", ["init", "--quiet", "--bare", origin]);
    execFileSync("git", ["init", "--quiet", "-b", "dev-author", seed]);
    for (const [file, content] of Object.entries(seedBookFilesWithChapters())) {
      await mkdir(path.dirname(path.join(seed, file)), { recursive: true });
      await writeFile(path.join(seed, file), content);
    }
    execFileSync("git", ["-c", "user.name=t", "-c", "user.email=t@t", "-C", seed, "add", "-A"]);
    execFileSync("git", ["-c", "user.name=t", "-c", "user.email=t@t", "-C", seed, "commit", "--quiet", "-m", "seed"]);
    execFileSync("git", ["-C", seed, "push", "--quiet", origin, "dev-author"]);
    await withServer(async (server, client) => {
      const summary = await client.registerBook("gh-book", { title: "Remote", storage: { kind: "github", owner: "me", repo: "remote", branch: "dev-author" }, githubToken: "ghp_test_secret" });
      assert.equal(summary.hasGithubToken, true);
      assert.equal(summary.lastSync.ok, true);
      assert.equal((await readFile(path.join(server.data.root, "private", "book-tokens.json"), "utf8")).includes("ghp_test_secret"), false);
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
