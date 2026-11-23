import test from "node:test";
import assert from "node:assert/strict";
import { lstat, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import util from "node:util";
import { gunzipSync } from "node:zlib";
import * as engine from "narrarium-engine";
import { DataDirectory, aiCallsSettingsOf, parseAiCallsSettings, startNarrariumServer } from "../dist/testing.mjs";
import { rawApi } from "./api-helpers.mjs";
import { adminLogin, noRelease, until, withServer } from "./helpers.mjs";
import { aiConfigFor, approve, fakeProvider, finished, seedChanges, seededBook } from "./fake-provider.mjs";
import { FAST, HELD, brief, fakeAi, holdingAi, startOf } from "./hold.mjs";
import { mcpFixture } from "./mcp-helpers.mjs";
import { connectApp } from "./oauth-helpers.mjs";

// The records of the AI calls of a personal server, with the autopilot wired to them: a real run with the engine's fake AI (and one that streams, held in the middle) on a real throwaway server. What a run
// records, how it is read while it streams, what a stop leaves, the budget, the trash, who may do what, the secrets that must never be in any file, the owner's switch, the disk and a failing store (told
// in the log once and in the health with its reason), and a run that the server resumed by itself after a restart. The store, the routes and the panel are tested on their own in the other files.

const MIB = 1024 ** 2;
const GIB = 1024 ** 3;
const FAST_CALLS = { aiCalls: { minFreeDiskBytes: 0 } };
const SENTENCE = "La nebbia sul molo si alzava piano, e il faro 💡 contava i battiti del mare. ";
/** More than the 16 KiB at which the recorder writes what it has, so that the first part of a stream is readable at once. */
const FIRST = SENTENCE.repeat(260);
const REST = "E poi il silenzio. ".repeat(6);
const bookRoute = (bookId) => `/api/v1/books/${bookId}/autopilot/calls`;

const temporary = () => mkdtemp(path.join(os.tmpdir(), "narrarium-calls-wired-"));
const remove = (directory) => rm(directory, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
const exists = (file) => lstat(file).then(() => true, () => false);

/** A server on `dataDir` with a client of every permission, and what it logged. */
async function boot(dataDir, extra = {}) {
  const lines = [];
  const server = await startNarrariumServer({
    dataDir, port: 0, adminPort: 0, supervised: false, checkRelease: noRelease, tunnel: { findBinary: () => undefined, detectOtherConnectors: async () => [] },
    autoResumeGapMs: 0, log: (line) => lines.push(line), ...FAST_CALLS, ...extra,
  });
  const { token } = await server.auth.issue("test client", ["read", "write", "run"]);
  return { server, lines, client: new engine.NarrariumServerClient({ baseUrl: server.url, token }) };
}

/**
 * The fake AI, with one prose request (the first scene's) that streams in two parts and waits between them: `phase()` says where it is, `release()` lets it go on. A request that the run abandons ends,
 * as the call to a provider does. `leak` is what the first part says before the call tries again with a clean text (what a model that echoes a key does).
 */
function streamingAi({ label = HELD, first = FIRST, rest = REST, leak } = {}) {
  const base = fakeAi(1);
  let phase = "idle";
  let open = () => undefined;
  const gate = new Promise((resolve) => {
    open = resolve;
  });
  return {
    calls: base.calls,
    phase: () => phase,
    release: () => open(),
    async complete(request) {
      if (phase !== "idle" || request.label !== label) return base.complete(request);
      phase = "streaming";
      let text = leak ?? first;
      request.onText?.(text);
      await new Promise((resolve, reject) => {
        gate.then(resolve);
        request.signal?.addEventListener("abort", () => reject(request.signal.reason), { once: true });
      });
      text = leak === undefined ? first + rest : "A quiet scene at the harbor, and nothing else.";
      request.onText?.(text);
      phase = "finished";
      return { text, usage: { inputTokens: 100, outputTokens: 50, cachedInputTokens: 0 }, model: "fake-model", provider: "fake" };
    },
  };
}

/** The tasks of a book once the run is over and every record is settled (nothing that still runs): newest first. */
async function recorded(client, bookId) {
  let tasks = [];
  await until(async () => {
    tasks = (await client.listCalls(bookId, { limit: 100 })).tasks;
    if (!tasks.length || tasks.some((task) => task.status === "running")) return false;
    for (const task of tasks) if ((await client.readCallTask(bookId, task.activityId)).calls.some((call) => call.status === "running")) return false;
    return true;
  });
  return tasks;
}

/** The running task that holds a call labelled `label`, with that call, found through the routes. */
async function runningCall(client, bookId, label) {
  let found;
  await until(async () => {
    for (const task of (await client.listCalls(bookId, { limit: 5 })).tasks) {
      if (task.status !== "running") continue;
      const call = (await client.readCallTask(bookId, task.activityId)).calls.find((entry) => entry.label === label);
      if (call) {
        found = { task, call };
        return true;
      }
    }
    return false;
  });
  return found;
}

/** The ids of the tasks a book's autopilot started, in order (what its session said). */
const startedIn = (server, bookId) => server.books.get(bookId).session.recentEvents().filter((event) => event.type === "task-started").map((event) => event.activity.id);
const eventsOf = (server, bookId, type) => server.books.get(bookId).session.recentEvents().filter((event) => event.type === type);

async function filesUnder(directory) {
  const found = [];
  for (const entry of await readdir(directory, { withFileTypes: true }).catch(() => [])) {
    const full = path.join(directory, entry.name);
    if (entry.isDirectory()) found.push(...(await filesUnder(full)));
    else if (entry.isFile()) found.push(full);
  }
  return found;
}

/** The files under `root` that hold any of `needles` (a gzip is looked into): nothing secret may be in any of them. */
async function holders(root, needles) {
  const found = [];
  for (const file of await filesUnder(root)) {
    const bytes = await readFile(file).catch(() => undefined);
    if (!bytes) continue;
    const views = [bytes];
    if (file.endsWith(".gz")) {
      try {
        views.push(gunzipSync(bytes));
      } catch {
        // Not a gzip after all: its own bytes were looked at.
      }
    }
    for (const view of views) for (const needle of needles) if (view.includes(needle)) found.push(`${path.relative(root, file)} holds ${needle.slice(0, 6)}…`);
  }
  return found;
}

// ---- what a run records

test("AI calls (wired): through a provider each call says which endpoint answered, with which model, how long and how many tokens, and the key that was sent to it is in no file", async () => {
  const KEY = "zq-provider-0123456789abcdefghij";
  const provider = await fakeProvider();
  try {
    await withServer(async (server, client, dataDir) => {
      const owner = await adminLogin(server);
      await approve(owner, provider.origin);
      await client.putAiConfig(aiConfigFor(provider, { apiKey: KEY }));
      await seededBook(client, "b");
      await client.startAutopilot("b", startOf(1));
      await finished(client, "b");
      const tasks = await recorded(client, "b");
      assert.ok(tasks.length >= 6);
      assert.ok(provider.requests.length >= 6 && provider.requests.every((request) => request.headers.authorization === `Bearer ${KEY}`), "the key went to the provider, as it must");
      let streamed = 0;
      for (const task of tasks) {
        for (const call of (await client.readCallTask("b", task.activityId)).calls) {
          assert.equal(call.attempts.length, 1, call.label);
          const [attempt] = call.attempts;
          assert.deepEqual([attempt.provider, attempt.endpoint, attempt.model, attempt.outcome, attempt.error], ["openai", provider.origin, "gpt-test", "ok", null], call.label);
          assert.deepEqual([attempt.usage.inputTokens, attempt.usage.outputTokens, attempt.usageKnown], [100, 50, true]);
          assert.ok(attempt.durationMs >= 0 && attempt.firstByteMs >= 0);
          if (attempt.stream) streamed += 1;
          assert.equal(JSON.stringify(call).includes(KEY), false);
        }
      }
      assert.ok(streamed >= 1, "a reply that streamed says so");
      const writing = (await client.readCallTask("b", tasks.find((task) => task.kind === "write").activityId)).calls[0];
      assert.equal((await client.readCallText("b", writing.callId, { field: "response" })).text.length > 100, true, "the text came through the provider's stream");
      assert.deepEqual(await holders(dataDir, [KEY]), [], "the key is in no file");
    }, { ai: undefined, ...FAST_CALLS });
  } finally {
    await provider.close();
  }
});

test("AI calls (wired): a run records every call of every task: what was sent, what came back, its attempt, who made it; the routes list the tasks and read the texts, and the events say it", async () => {
  await withServer(async (server, client) => {
    await seededBook(client, "b");
    await client.startAutopilot("b", startOf(1));
    await finished(client, "b");
    const tasks = await recorded(client, "b");
    assert.ok(tasks.length >= 6, `${tasks.length} tasks`);
    const kinds = new Set(tasks.map((task) => task.kind));
    for (const kind of ["concept", "plan", "write", "consolidate", "final"]) assert.ok(kinds.has(kind), `a task of kind ${kind} was recorded: ${[...kinds].join(", ")}`);
    assert.ok(tasks.every((task) => task.status === "done" && task.calls >= 1 && task.bytes > 0 && task.pinned === false && task.bookId === "b"));
    assert.deepEqual(tasks.map((task) => task.activityId), startedIn(server, "b").reverse(), "newest first, as the run started them");

    const runIds = new Set();
    let calls = 0;
    for (const task of tasks) {
      const detail = await client.readCallTask("b", task.activityId);
      assert.equal(detail.header.calls, detail.calls.length);
      for (const call of detail.calls) {
        calls += 1;
        runIds.add(call.runId);
        assert.deepEqual([call.host, call.bookId, call.status, call.accountScope, call.activityId], ["server", "b", "ok", null, task.activityId]);
        assert.match(call.callId, /^activity_[0-9a-f-]{36}-\d{4}$/);
        assert.ok(call.attempts.length >= 1 && call.attempts[0].outcome === "ok", "the attempt the call made");
        assert.ok(call.request.system.bytes > 0 && call.request.user.bytes > 0);
        const system = await client.readCallText("b", call.callId, { field: "system" });
        const user = await client.readCallText("b", call.callId, { field: "user" });
        assert.deepEqual([system.size, system.done, user.size, user.done], [call.request.system.storedBytes, true, call.request.user.storedBytes, true], "the texts are what the record says they are");
        if (call.response.text) {
          const response = await client.readCallText("b", call.callId, { field: "response" });
          assert.deepEqual([response.size, response.done], [call.response.text.storedBytes, true]);
          assert.ok(response.text.length > 100);
        }
      }
    }
    assert.equal(runIds.size, 1, "one run, one id on every call");
    assert.equal((await server.calls.totals("b")).calls, calls);
    const writing = (await client.readCallTask("b", tasks.find((task) => task.kind === "write").activityId)).calls.find((call) => call.label.startsWith("autopilot:write"));
    assert.match((await client.readCallText("b", writing.callId, { field: "user" })).text, /harbor/i, "what the author asked for is in what was sent");
    assert.ok(writing.response.text.bytes > 500, "and the scene that came back is kept");
    assert.equal(eventsOf(server, "b", "call-started").length, calls);
    assert.equal(eventsOf(server, "b", "call-ended").length, calls);
    assert.equal(JSON.stringify(eventsOf(server, "b", "call-started")).includes("harbor"), false, "the events say ids, sizes and times: never a text");
  }, FAST_CALLS);
});

test("AI calls (wired): while a call streams its text is read through the routes from any offset, the task and the call say they run, a pin holds, and the end makes the last answer done", async () => {
  const ai = streamingAi();
  await withServer(async (server, client) => {
    await seededBook(client, "b");
    await client.startAutopilot("b", startOf(1));
    const { task, call } = await runningCall(client, "b", HELD);
    await until(async () => (await client.readCallText("b", call.callId, { field: "response" })).size > 0);
    const early = await client.readCallText("b", call.callId, { field: "response" });
    assert.equal(ai.phase(), "streaming", "the AI is still answering");
    assert.deepEqual([early.done, early.from, early.attempt, early.next, early.size === early.next], [false, 0, 1, early.size, true]);
    assert.ok(early.size > 16 * 1024 && FIRST.startsWith(early.text), "what has come, a little less than what was said (the recorder holds back its last words)");
    assert.ok(FIRST.length - early.text.length < 300, "by a few words");
    assert.equal((await client.readCallTask("b", task.activityId)).calls.find((entry) => entry.callId === call.callId).status, "running");
    assert.equal((await client.listCalls("b", { limit: 1 })).tasks[0].status, "running");
    assert.deepEqual(await client.readCallText("b", call.callId, { field: "response", from: early.next }), { text: "", from: early.next, next: early.next, size: early.size, attempt: 1, done: false }, "nothing new yet");
    assert.equal((await client.readCallText("b", call.callId, { field: "system" })).done, false, "the call has not ended: nothing is said to be over");

    // A reader that starts in the middle of a letter that takes more than one byte gets the letter whole.
    const middle = Buffer.from(FIRST).indexOf(Buffer.from("💡")) + 2;
    const cut = await client.readCallText("b", call.callId, { field: "response", from: middle, limit: 12 });
    assert.ok(cut.from < middle && cut.text.startsWith("💡"), "from the middle of a character it starts at the character");

    assert.equal((await client.keepCallTask("b", task.activityId, true)).pinned, true, "a task that runs can be kept");
    ai.release();
    await finished(client, "b");
    await recorded(client, "b");
    const rest = await client.readCallText("b", call.callId, { field: "response", from: early.next });
    assert.equal(rest.done, true);
    assert.equal(early.text + rest.text, FIRST + REST, "what came before and after the wait is the whole text");
    const ended = (await client.readCallTask("b", task.activityId)).calls.find((entry) => entry.callId === call.callId);
    assert.deepEqual([ended.status, ended.response.partial, ended.response.text.bytes], ["ok", false, Buffer.byteLength(FIRST + REST)]);
    assert.equal((await client.readCallTask("b", task.activityId)).header.pinned, true, "and the pin is still there");
  }, { ...FAST_CALLS, ai });
});

// ---- a server that stops

test("AI calls (wired): a server that stops in the middle of a stream leaves a record that reads, the call cut (aborted) with the text it had and its task stopped, and the one that starts again finds it so", async () => {
  const dataDir = await temporary();
  try {
    const ai = streamingAi();
    const first = await boot(dataDir, { ai });
    await seededBook(first.client, "b");
    await first.client.startAutopilot("b", startOf(1));
    const { task, call } = await runningCall(first.client, "b", HELD);
    await until(async () => (await first.client.readCallText("b", call.callId, { field: "response" })).size > 0);
    const early = await first.client.readCallText("b", call.callId, { field: "response" });
    await first.server.close();

    const second = await boot(dataDir, { ai: fakeAi(1) });
    try {
      const tasks = (await second.client.listCalls("b", { limit: 100 })).tasks;
      assert.equal(tasks.some((entry) => entry.status === "running"), false, "nothing is left saying that it runs");
      assert.equal(tasks.find((entry) => entry.activityId === task.activityId).status, "stopped", "the task that was cut says it was stopped");
      const detail = (await second.client.readCallTask("b", task.activityId)).calls.find((entry) => entry.callId === call.callId);
      assert.deepEqual([detail.status, detail.response.partial], ["aborted", true], "the call says it was cut, and that its text is not the whole answer");
      const text = await second.client.readCallText("b", call.callId, { field: "response" });
      assert.deepEqual([text.done, text.size], [true, Buffer.byteLength(FIRST)], "everything the call had said when it was stopped is there, and nothing more will come");
      assert.equal(text.text, FIRST);
      const tail = await second.client.readCallText("b", call.callId, { field: "response", from: early.next });
      assert.equal(early.text + tail.text, FIRST, "a reader that was following it goes on from where it was, and reaches the end");
      assert.equal(tail.done, true);
      assert.equal((await second.client.readCallText("b", call.callId, { field: "system" })).done, true);
      const earlier = tasks.filter((entry) => entry.activityId !== task.activityId);
      assert.ok(earlier.length >= 3 && earlier.every((entry) => entry.status === "done"), "the tasks that ended before the stop are as they were");
    } finally {
      await second.server.close();
    }
  } finally {
    await remove(dataDir);
  }
});

test("AI calls (wired): a run that the server resumes by itself after a restart records like any other: its own tasks and calls, under its own run, beside those of the run that stopped", async () => {
  const dataDir = await temporary();
  try {
    const options = { ...FAST, resumeAfterRestart: true };
    const first = await boot(dataDir, { ai: holdingAi(HELD, 1) });
    await seededBook(first.client, "b");
    await first.client.startAutopilot("b", { brief: brief(1), options });
    await runningCall(first.client, "b", HELD);
    await first.server.close();

    const ai = holdingAi(HELD, 1);
    const second = await boot(dataDir, { ai });
    try {
      assert.deepEqual((await second.server.autoResumed).map((entry) => entry.result), ["resumed"]);
      await until(() => ai.isHeld());
      const resumed = await runningCall(second.client, "b", HELD);
      assert.equal(resumed.call.host, "server");
      ai.release();
      await finished(second.client, "b");
      const tasks = await recorded(second.client, "b");
      const runs = new Set();
      for (const task of tasks) for (const call of (await second.client.readCallTask("b", task.activityId)).calls) runs.add(call.runId);
      assert.equal(runs.size, 2, "the run that stopped and the run that the server resumed");
      assert.equal(runs.has(resumed.call.runId), true);
      const later = tasks.filter((task) => task.startedAt >= resumed.task.startedAt);
      assert.ok(later.length >= 3 && later.every((task) => task.status === "done"), "the resumed run recorded its tasks to the end");
      assert.ok((await second.client.readCallText("b", resumed.call.callId, { field: "user" })).size > 0);
    } finally {
      await second.server.close();
    }
  } finally {
    await remove(dataDir);
  }
});

// ---- the budget, the pin, the deletion and the trash

test("AI calls (wired): a budget of a few tens of kilobytes keeps the newest whole tasks and the pinned one, drops the oldest with their files, and counts what it keeps", async () => {
  const budget = 20_000;
  const ai = holdingAi(HELD, 1);
  await withServer(async (server, client) => {
    await seededBook(client, "b");
    await client.startAutopilot("b", startOf(1));
    // Held in the fifth task: the four before it are kept (they are far under the budget), and the oldest of them is pinned.
    const held = await runningCall(client, "b", HELD);
    const before = (await client.listCalls("b", { limit: 100 })).tasks;
    assert.ok(before.length >= 4 && before.reduce((total, task) => total + task.bytes, 0) < budget, "nothing was dropped yet");
    const oldest = before.at(-1);
    assert.equal((await client.keepCallTask("b", oldest.activityId, true)).pinned, true);
    ai.release();
    await finished(client, "b");
    await server.calls.close();
    const started = startedIn(server, "b");
    const kept = (await client.listCalls("b", { limit: 100 })).tasks;
    assert.ok(kept.length >= 3 && kept.length < started.length, `${kept.length} of ${started.length} tasks are kept`);
    assert.equal(kept.some((task) => task.activityId === oldest.activityId && task.pinned), true, "the task that was pinned is still there, though it is the oldest");
    const others = kept.filter((task) => !task.pinned).map((task) => task.activityId);
    assert.deepEqual(others, started.slice(-others.length).reverse(), "the rest are the newest the run made, with nothing missing between them");
    assert.ok(others.includes(started.at(-1)), "the last task of the run is there");
    const totals = await server.calls.totals("b");
    assert.equal(totals.bytes, kept.reduce((total, task) => total + task.bytes, 0));
    assert.ok(totals.bytes <= budget, `${totals.bytes} bytes kept of ${budget}`);
    assert.deepEqual([totals.pinnedTasks, totals.tasks], [1, kept.length]);
    for (const task of kept) {
      const detail = await client.readCallTask("b", task.activityId);
      assert.equal(detail.calls.length, task.calls, "a task is whole or it is not there");
      for (const call of detail.calls) assert.ok((await client.readCallText("b", call.callId, { field: "user" })).size > 0);
    }
    const dropped = started.filter((id) => !kept.some((task) => task.activityId === id));
    assert.ok(dropped.length >= 2, `${dropped.length} tasks were dropped`);
    const files = (await filesUnder(server.data.aiCallsDirectory("b"))).map((file) => path.basename(file));
    for (const id of dropped) assert.equal(files.some((name) => name.startsWith(id)), false, `no file of the dropped task ${id.slice(9, 17)}`);
    assert.equal((await client.readCallTask("b", dropped[0]).catch((error) => error.code)), "call_task_not_found");
    assert.equal(files.filter((name) => name.endsWith(".json") && name.startsWith("activity_")).length, kept.length, "a task file for each task that is kept, and no other");
  }, { aiCalls: { minFreeDiskBytes: 0, budgetBytes: budget }, ai });
});

test("AI calls (wired): the records of a book are deleted at once, also those that were pinned, the book and its run stay, and a book that is removed takes its records to the trash with it", async () => {
  await withServer(async (server, client) => {
    await seededBook(client, "b");
    await seededBook(client, "gone");
    for (const id of ["b", "gone"]) await client.startAutopilot(id, startOf(1));
    await finished(client, "b");
    await finished(client, "gone");
    const tasks = await recorded(client, "b");
    await recorded(client, "gone");
    await client.keepCallTask("b", tasks[0].activityId, true);
    const total = await server.calls.totals("b");
    const deleted = await client.deleteCalls("b");
    assert.deepEqual(deleted, { deleted: true, tasks: tasks.length, calls: total.calls, bytes: total.bytes });
    assert.deepEqual(await client.listCalls("b"), { tasks: [], next: null });
    assert.equal(await exists(server.data.aiCallsDirectory("b")), false);
    assert.equal((await client.autopilot("b")).summary.status, "completed", "the book and its run are as they were");

    const kept = (await server.calls.totals("gone")).tasks;
    assert.ok(kept >= 6);
    assert.deepEqual(await client.removeBook("gone"), { removed: true });
    const trash = path.join(server.data.root, "books", ".trash");
    const [copy, records] = (await readdir(trash)).sort();
    assert.equal(records, `${copy}.ai-calls`, "the records are beside the working copy that went with them");
    const files = (await filesUnder(path.join(trash, records, "tasks"))).filter((file) => file.endsWith(".json"));
    assert.equal(files.length, kept, "every task of the run is in the trash");
    assert.equal(await exists(server.data.aiCallsDirectory("gone")), false);
    assert.equal((await rawApi(server).then((api) => api("GET", bookRoute("gone")))).status, 404, "and the server serves them no more");
  }, FAST_CALLS);
});

test("AI calls (wired): a client that only reads reads the records of a real run and cannot keep or delete, and an app that connected through MCP is refused every route", async () => {
  await withServer(async (server, client) => {
    const { slug } = await mcpFixture(server, client, { bookId: "glass" });
    await client.startAutopilot("glass", startOf(1));
    await finished(client, "glass");
    const tasks = await recorded(client, "glass");
    const callId = (await client.readCallTask("glass", tasks[0].activityId)).calls[0].callId;
    const reading = new engine.NarrariumServerClient({ baseUrl: server.url, token: (await server.auth.issue("reader", ["read"])).token });
    assert.equal((await reading.listCalls("glass")).tasks.length, tasks.length);
    assert.ok((await reading.readCallText("glass", callId, { field: "user" })).size > 0);
    for (const attempt of [() => reading.keepCallTask("glass", tasks[0].activityId, true), () => reading.deleteCalls("glass")]) {
      await assert.rejects(attempt(), (error) => error.status === 403 && error.code === "scope");
    }
    assert.equal((await server.calls.totals("glass")).tasks, tasks.length, "nothing was deleted");

    const access = (await connectApp(server, { slug, scopes: ["read", "write", "run"] })).tokens.access_token;
    const route = bookRoute("glass");
    for (const [method, address, body] of [["GET", route], ["GET", `${route}/tasks/${tasks[0].activityId}`], ["GET", `${route}/${callId}/text?field=user`], ["PUT", `${route}/tasks/${tasks[0].activityId}/keep`, { pinned: true }], ["DELETE", route]]) {
      const answer = await fetch(`${server.url}${address}`, { method, headers: { authorization: `Bearer ${access}`, "content-type": "application/json" }, body: body === undefined ? undefined : JSON.stringify(body) });
      assert.equal(answer.status, 401, `${method} ${address.slice(0, 60)}`);
    }
    assert.equal((await server.calls.totals("glass")).tasks, tasks.length);
  }, FAST_CALLS);
});

// ---- what must never be written

test("AI calls (wired): the key of an AI integration and the book's GitHub token that a model says are in no file of the data folder and in no answer, whether they were saved by this server or by the one before it", async () => {
  const KEY = "zq-live-0123456789abcdefghij";
  const TOKEN = "zt_0123456789abcdefghijklmnopqrstuvwx";
  const leak = `Draft: the key is ${KEY} and the token ${TOKEN}, and encoded ${encodeURIComponent(KEY)}. ${"x".repeat(300)}`;
  const secrets = [KEY, TOKEN, encodeURIComponent(KEY)];
  const dataDir = await temporary();

  /** A run in which the model says the secrets in its first try and something clean in its second, and everything that can show them: the routes, the log of the server and of the panel, every file. */
  async function leakyRun({ server, client, lines }, bookId, ai) {
    await client.startAutopilot(bookId, startOf(1));
    const { call } = await runningCall(client, bookId, HELD);
    await until(async () => ai.phase() === "streaming");
    ai.release();
    await finished(client, bookId);
    const tasks = await recorded(client, bookId);
    const shown = [];
    let redacted = 0;
    for (const entry of tasks) {
      const detail = await client.readCallTask(bookId, entry.activityId);
      shown.push(JSON.stringify(detail));
      for (const each of detail.calls) {
        for (const field of ["system", "user"]) shown.push((await client.readCallText(bookId, each.callId, { field })).text);
        for (let attempt = 1; attempt <= 3; attempt += 1) {
          const piece = await client.readCallText(bookId, each.callId, { field: "response", attempt });
          shown.push(piece.text);
          if (piece.text.includes("[redacted]")) redacted += 1;
        }
      }
    }
    assert.ok(redacted >= 1, "the places where a secret was are said");
    const tried = (await client.readCallText(bookId, call.callId, { field: "response", attempt: 1 })).text;
    assert.match(tried, /^Draft: the key is \[redacted\].*and the token \[redacted\]/, "what the model said is kept, without what it must not say");
    const answer = await client.readCallText(bookId, call.callId, { field: "response" });
    assert.deepEqual([answer.attempt, answer.text], [2, "A quiet scene at the harbor, and nothing else."], "and what it said when it tried again");
    shown.push(...lines, JSON.stringify((await (await adminLogin(server)).call("GET", "/admin/api/log?limit=200")).body));
    for (const text of shown) for (const secret of secrets) assert.equal(text.includes(secret), false, "no answer and no log line holds a secret");
    assert.deepEqual(await holders(dataDir, secrets), [], "and no file of the data folder does, whatever it is (a gzip is read too)");
  }

  try {
    // The key and the token are saved by the server that runs the book.
    const ai = streamingAi({ leak });
    const first = await boot(dataDir, { ai });
    try {
      await first.client.registerBook("b", { title: "Secrets", storage: { kind: "local" }, githubToken: TOKEN });
      await first.client.commitFiles("b", seedChanges(1), "seed");
      await first.client.putAiConfig({ aiIntegrations: [{ id: "a", name: "OpenAI", provider: "openai", apiKey: KEY, chatModels: [{ id: "m", name: "gpt-4o", capabilities: ["default"] }] }] });
      assert.deepEqual(first.server.data.knownSecrets().sort(), [KEY, TOKEN].sort(), "known at once, from the moment they were saved");
      await leakyRun(first, "b", ai);
    } finally {
      await first.server.close();
    }

    // The next server finds them saved: it read them when it started, and nobody saved them in this process.
    const again = streamingAi({ leak });
    const second = await boot(dataDir, { ai: again });
    try {
      assert.deepEqual(second.server.data.knownSecrets().sort(), [KEY, TOKEN].sort(), "read once, when the folder was opened");
      await seededBook(second.client, "next");
      await leakyRun(second, "next", again);
    } finally {
      await second.server.close();
    }
  } finally {
    await remove(dataDir);
  }
});

test("AI calls (wired): the secrets the server holds are asked from memory, a copy each time, and follow what is saved: the keys with the configuration, a token with its book; nothing that prints a data folder shows them", async () => {
  const dataDir = await temporary();
  try {
    const data = await DataDirectory.open(dataDir);
    assert.deepEqual(data.knownSecrets(), [], "a new folder knows none");
    const config = (...keys) => ({ aiIntegrations: keys.map((apiKey, index) => ({ id: `i${index}`, name: `I${index}`, provider: "openai", apiKey, chatModels: [{ id: "m", name: "gpt-4o", capabilities: ["default"] }] })) });
    await data.saveAiConfig(config("key-aaaaaaaa", "key-bbbbbbbb"));
    await data.setBookToken("one", "tok-1111111111");
    await data.setBookToken("two", "  tok-2222222222  ");
    assert.deepEqual(data.knownSecrets().sort(), ["key-aaaaaaaa", "key-bbbbbbbb", "tok-1111111111", "tok-2222222222"]);
    const copy = data.knownSecrets();
    copy.push("changed");
    assert.equal(data.knownSecrets().includes("changed"), false, "the list is the caller's: nobody changes what the next call is given");
    await data.saveAiConfig(config("key-bbbbbbbb", "key-cccccccc"));
    await data.setBookToken("one", null);
    assert.deepEqual(data.knownSecrets().sort(), ["key-bbbbbbbb", "key-cccccccc", "tok-2222222222"], "a key that was taken away, and a token that was cleared, are no longer asked for");
    await data.setBookToken("two", "   ");
    assert.deepEqual(data.knownSecrets().sort(), ["key-bbbbbbbb", "key-cccccccc"]);
    await data.setBookToken("three", "tok-3333333333");

    for (const shown of [JSON.stringify(data), util.inspect(data, { depth: 6, showHidden: true }), String(data), JSON.stringify(Object.entries(data))]) {
      for (const secret of ["key-bbbbbbbb", "key-cccccccc", "tok-3333333333"]) assert.equal(shown.includes(secret), false, "a data folder shows no secret");
    }
    const reopened = await DataDirectory.open(dataDir);
    assert.deepEqual(reopened.knownSecrets().sort(), ["key-bbbbbbbb", "key-cccccccc", "tok-3333333333"], "read once from the files when it is opened");
    await data.removeBook("three");
    assert.deepEqual(data.knownSecrets().sort(), ["key-bbbbbbbb", "key-cccccccc"], "a book that is removed takes its token with it");

    // A damaged file does not stop the folder from opening, and does not hide the other.
    await writeFile(path.join(dataDir, "private", "book-tokens.json"), "{ not json");
    const damaged = await DataDirectory.open(dataDir);
    assert.deepEqual(damaged.knownSecrets().sort(), ["key-bbbbbbbb", "key-cccccccc"]);
  } finally {
    await remove(dataDir);
  }
});

// ---- the owner's switch

test("AI calls (wired): the switch is on until the owner turns it off: a run that starts then records nothing, the list says so, what was kept stays and can be deleted, and turned on again the next run records", async () => {
  await withServer(async (server, client, dataDir) => {
    const owner = await adminLogin(server);
    const status = async () => (await owner.call("GET", "/admin/api/status")).body.aiCalls;
    assert.deepEqual(await status(), { enabled: true, budgetBytes: engine.AI_CALL_BUDGETS.serverPerBookBytes, minFreeBytes: 0 });
    assert.equal(JSON.parse(await readFile(path.join(dataDir, "config.json"), "utf8")).aiCalls, undefined, "a server that never touched it has nothing about it in its configuration");

    await seededBook(client, "b");
    await client.startAutopilot("b", startOf(1));
    await finished(client, "b");
    const before = await recorded(client, "b");
    assert.equal((await client.listCalls("b")).recording, undefined, "recording is on: the list is the engine's page and nothing more");

    assert.equal((await owner.call("POST", "/admin/api/ai-calls", { enabled: "no" })).status, 400, "a switch is true or false");
    assert.equal((await owner.call("POST", "/admin/api/ai-calls", {})).status, 400);
    assert.equal((await status()).enabled, true, "and a request that is refused changes nothing");
    const off = await owner.call("POST", "/admin/api/ai-calls", { enabled: false });
    assert.deepEqual([off.status, off.body.enabled], [200, false]);
    assert.deepEqual((await owner.call("GET", "/admin/api/ai-calls")).body, off.body, "the same address says it too");
    assert.deepEqual((await status()).enabled, false);
    assert.deepEqual(JSON.parse(await readFile(path.join(dataDir, "config.json"), "utf8")).aiCalls, { enabled: false }, "it is in the server's configuration");
    assert.equal(aiCallsSettingsOf(server.data.config).enabled, false);
    const log = async () => (await owner.call("GET", "/admin/api/log?limit=200")).body.entries.filter((entry) => entry.action === "ai-calls.toggle");
    assert.deepEqual((await log()).map((entry) => [entry.detail, entry.actor.kind, entry.ok]), [["off", "admin", true]]);
    await owner.call("POST", "/admin/api/ai-calls", { enabled: false });
    assert.equal((await log()).length, 1, "the same answer again is not a change");

    await seededBook(client, "c");
    await client.startAutopilot("c", startOf(1));
    await finished(client, "c");
    assert.ok(eventsOf(server, "c", "task-started").length >= 6, "the run did its work");
    assert.equal(eventsOf(server, "c", "call-started").length, 0, "and made no record, so it said none");
    assert.deepEqual(await client.listCalls("c"), { tasks: [], next: null, recording: false }, "the list says that the server does not record: it is not the list of a book that has had no run");
    assert.equal(await exists(server.data.aiCallsDirectory("c")), false, "a switch that is off makes no folder");
    assert.deepEqual((await client.listCalls("b", { limit: 100 })).tasks.map((task) => task.activityId).sort(), before.map((task) => task.activityId).sort(), "what was kept is what was");
    const kept = before[0];
    assert.ok((await client.readCallText("b", (await client.readCallTask("b", kept.activityId)).calls[0].callId, { field: "user" })).size > 0, "what was kept is read");
    assert.equal((await client.keepCallTask("b", kept.activityId, true)).pinned, true, "and kept");
    assert.equal((await client.deleteCalls("b")).deleted, true, "and deleted");
    assert.equal(await exists(server.data.aiCallsDirectory("b")), false);

    const on = await owner.call("POST", "/admin/api/ai-calls", { enabled: true });
    assert.deepEqual([on.status, on.body.enabled], [200, true]);
    assert.deepEqual((await log()).map((entry) => entry.detail), ["on", "off"]);
    await seededBook(client, "d");
    await client.startAutopilot("d", startOf(1));
    await finished(client, "d");
    assert.ok((await recorded(client, "d")).length >= 6, "turned on again, the next run records");
    assert.ok(eventsOf(server, "d", "call-started").length >= 6);
    assert.equal((await client.listCalls("d")).recording, undefined);
  }, FAST_CALLS);
});

test("AI calls (wired): the switch turned off in the middle of a stream cuts that call where it is (its text so far kept and readable), writes nothing more for the run that goes on, and is kept across a restart", async () => {
  const dataDir = await temporary();
  try {
    const ai = streamingAi();
    const first = await boot(dataDir, { ai });
    const owner = await adminLogin(first.server);
    await seededBook(first.client, "b");
    await first.client.startAutopilot("b", startOf(1));
    const { task, call } = await runningCall(first.client, "b", HELD);
    await until(async () => (await first.client.readCallText("b", call.callId, { field: "response" })).size > 0);
    const early = await first.client.readCallText("b", call.callId, { field: "response" });

    assert.equal((await owner.call("POST", "/admin/api/ai-calls", { enabled: false })).status, 200);
    const cut = (await first.client.readCallTask("b", task.activityId)).calls.find((entry) => entry.callId === call.callId);
    assert.deepEqual([cut.status, cut.response.partial], ["interrupted", true]);
    assert.equal((await first.client.listCalls("b", { limit: 100 })).tasks.some((entry) => entry.status === "running"), false, "no task says that it runs");
    const text = await first.client.readCallText("b", call.callId, { field: "response" });
    assert.deepEqual([text.done, text.text], [true, early.text], "what it had said is kept, and nothing more will come");
    const folder = first.server.data.aiCallsDirectory("b");
    const listed = async () => (await filesUnder(folder)).sort();
    const before = await listed();

    ai.release();
    await finished(first.client, "b");
    await first.server.calls.close();
    assert.deepEqual(await listed(), before, "the run went on to its end and wrote nothing: not a file more, not a file less");
    assert.equal((await first.client.readCallText("b", call.callId, { field: "response" })).text, early.text, "and what was cut stays as it was");
    await first.server.close();

    const second = await boot(dataDir, { ai: fakeAi(1) });
    try {
      assert.equal(aiCallsSettingsOf(second.server.data.config).enabled, false, "the owner's choice outlives the server");
      assert.equal((await adminLogin(second.server).then((panel) => panel.call("GET", "/admin/api/status"))).body.aiCalls.enabled, false);
      const kept = (await second.client.listCalls("b", { limit: 100 })).tasks.map((entry) => entry.activityId);
      await seededBook(second.client, "c");
      await second.client.startAutopilot("c", startOf(1));
      await finished(second.client, "c");
      assert.ok(eventsOf(second.server, "c", "task-started").length >= 6, "the run did its work");
      assert.deepEqual(await second.client.listCalls("c"), { tasks: [], next: null, recording: false }, "a run that starts while it is off adds nothing");
      assert.equal(eventsOf(second.server, "c", "call-started").length, 0);
      assert.deepEqual((await second.client.listCalls("b", { limit: 100 })).tasks.map((entry) => entry.activityId), kept, "and what was kept is as it was");
    } finally {
      await second.server.close();
    }
  } finally {
    await remove(dataDir);
  }
});

test("AI calls (wired): the settings read from config.json are believed only as far as they can be: a bad value is the default, and a budget the owner wrote is the budget of the store and of the runs", async () => {
  assert.equal(parseAiCallsSettings(undefined), undefined);
  for (const nothing of [null, "x", 7, [], {}, { enabled: "yes" }, { budgetBytes: "big" }, { budgetBytes: 10 }, { budgetBytes: 1024 ** 5 }, { budgetBytes: 1024 * 1024 + 0.5 }]) assert.equal(parseAiCallsSettings(nothing), undefined, JSON.stringify(nothing));
  assert.deepEqual(parseAiCallsSettings({ enabled: false }), { enabled: false });
  assert.deepEqual(parseAiCallsSettings({ enabled: true, extra: 1 }), { enabled: true });
  assert.deepEqual(parseAiCallsSettings({ budgetBytes: 5 * MIB }), { enabled: true, budgetBytes: 5 * MIB });
  assert.deepEqual(aiCallsSettingsOf({}), { enabled: true, budgetBytes: 2 * GIB });
  assert.deepEqual(aiCallsSettingsOf({ aiCalls: { enabled: false, budgetBytes: 7 * MIB } }), { enabled: false, budgetBytes: 7 * MIB });

  const dataDir = await temporary();
  try {
    await writeFile(path.join(dataDir, "config.json"), JSON.stringify({ version: 2, aiCalls: { enabled: true, budgetBytes: 3 * MIB } }));
    const { server } = await boot(dataDir, { aiCalls: {} });
    try {
      assert.equal((await adminLogin(server).then((panel) => panel.call("GET", "/admin/api/status"))).body.aiCalls.budgetBytes, 3 * MIB, "a budget in the configuration is told");
    } finally {
      await server.close();
    }
  } finally {
    await remove(dataDir);
  }
});

// ---- the disk and a store that fails

test("AI calls (wired): short of disk nothing is recorded and the run goes on; the engine says so once, the server logs it once, and the health says why until there is room again", async () => {
  let free = 500 * MIB;
  const lines = [];
  await withServer(async (server, client) => {
    const owner = await adminLogin(server);
    const disk = async () => (await owner.call("GET", "/admin/api/health")).body.checks.find((check) => check.id === "disk");
    await seededBook(client, "b");
    await client.startAutopilot("b", startOf(1));
    const snapshot = await finished(client, "b");
    assert.equal(snapshot.summary.status, "completed", "the run went on without records, and finished");
    assert.deepEqual(await client.listCalls("b"), { tasks: [], next: null }, "and nothing of it was written");
    assert.equal(await exists(server.data.aiCallsDirectory("b")), false, "not even a folder");
    const insights = eventsOf(server, "b", "insight").filter((event) => event.code === "callsStoreFailed");
    assert.equal(insights.length, 1, "the engine says it once for the run");
    assert.match(insights[0].title, /no room to keep the AI call records/);
    assert.equal(eventsOf(server, "b", "call-started").length, 0);
    const said = lines.filter((line) => /AI call records stopped for this run/.test(line));
    assert.equal(said.length, 1, `the server says it once: ${said.join(" | ")}`);
    assert.match(said[0], /^Book b: .* and it goes on without them \(.*free disk space.*\)\.$/);

    const row = await disk();
    assert.equal(row.status, "warn");
    assert.deepEqual([row.facts.aiCallsMinFreeBytes, row.facts.aiCallsFailedBooks, row.facts.aiCallsFailedKind], [GIB, 1, "disk"]);
    assert.ok(Number.isFinite(Date.parse(row.facts.aiCallsFailedAt)));
    assert.equal(row.facts.aiCallBytes, undefined, "nothing is kept");
    assert.deepEqual((await owner.call("GET", "/admin/api/health")).body.attention, ["disk"]);

    free = 5 * GIB;
    await client.resetAutopilot("b");
    await client.startAutopilot("b", startOf(1));
    await finished(client, "b");
    assert.ok((await recorded(client, "b")).length >= 1, "room again: the next run records");
    const after = await disk();
    assert.deepEqual([after.facts.aiCallsMinFreeBytes, after.facts.aiCallsFailedBooks, after.status], [undefined, undefined, "ok"], "and the health has nothing more to say about it");
    assert.ok(after.facts.aiCallBytes > 0);
  }, { aiCalls: { minFreeDiskBytes: GIB, freeDiskBytes: () => free }, admin: { disk: async () => ({ free, total: 100 * GIB }) }, log: (line) => lines.push(line) });
});

test("AI calls (wired): a stream that loses its room in the middle is cut where it was (its text so far kept), no task is left saying that it runs, the run goes on, and the next run records again", async () => {
  let free = 5 * GIB;
  const lines = [];
  const ai = streamingAi();
  await withServer(async (server, client) => {
    await seededBook(client, "b");
    await client.startAutopilot("b", startOf(1));
    const { task, call } = await runningCall(client, "b", HELD);
    await until(async () => (await client.readCallText("b", call.callId, { field: "response" })).size > 0);
    const early = await client.readCallText("b", call.callId, { field: "response" });
    free = 100 * MIB;
    ai.release();
    const snapshot = await finished(client, "b");
    assert.equal(snapshot.summary.status, "completed", "the run goes on to its end");
    await server.calls.close();
    const tasks = (await client.listCalls("b", { limit: 100 })).tasks;
    assert.equal(tasks.some((entry) => entry.status === "running"), false, "nothing is left saying that it runs");
    assert.ok(tasks.length >= 4 && tasks.length < startedIn(server, "b").length, "the tasks before the cut are kept, and the run's other tasks are not");
    const cut = (await client.readCallTask("b", task.activityId)).calls.find((entry) => entry.callId === call.callId);
    assert.deepEqual([cut.status, cut.response.partial], ["interrupted", true]);
    const text = await client.readCallText("b", call.callId, { field: "response" });
    assert.deepEqual([text.done, text.text], [true, early.text], "its text up to the room it had");
    assert.equal(eventsOf(server, "b", "insight").filter((event) => event.code === "callsStoreFailed").length, 1);
    assert.equal(lines.filter((line) => /AI call records stopped for this run/.test(line)).length, 1);

    free = 5 * GIB;
    const before = tasks.length;
    await client.resetAutopilot("b");
    await client.startAutopilot("b", startOf(1));
    await finished(client, "b");
    assert.ok((await recorded(client, "b")).length > before, "room again: the next run records, beside what was kept");
  }, { aiCalls: { minFreeDiskBytes: GIB, freeDiskBytes: () => free }, ai, log: (line) => lines.push(line) });
});

test("AI calls (wired): a store that fails (its folder is a file) is said once in the log, with the run going on, and the health says that a write failed", async () => {
  const lines = [];
  await withServer(async (server, client, dataDir) => {
    const owner = await adminLogin(server);
    await seededBook(client, "b");
    await writeFile(server.data.aiCallsDirectory("b"), "in the way");
    await client.startAutopilot("b", startOf(1));
    assert.equal((await finished(client, "b")).summary.status, "completed", "the run goes on");
    const insights = eventsOf(server, "b", "insight").filter((event) => event.code === "callsStoreFailed");
    assert.equal(insights.length, 1);
    assert.match(insights[0].title, /could not be kept/);
    assert.match(insights[0].detail, /^The AI call records could not be written \(E[A-Z]+\)\.$/, "what the feed says is the code of the failure");
    assert.equal(JSON.stringify(eventsOf(server, "b", "insight")).includes(dataDir), false, "and never where the files are");
    assert.equal(lines.filter((line) => /AI call records stopped for this run/.test(line)).length, 1);
    assert.equal(lines.filter((line) => line.includes(server.data.aiCallsDirectory("b"))).length >= 1, true, "the server's log has the cause, with the path");
    assert.equal(lines.filter((line) => /could not be written/.test(line) && line.includes(dataDir)).length, 1, "once, not for every write that fails");
    const row = (await owner.call("GET", "/admin/api/health")).body.checks.find((check) => check.id === "disk");
    assert.deepEqual([row.status, row.facts.aiCallsFailedBooks, row.facts.aiCallsFailedKind], ["warn", 1, "error"]);
    assert.equal(row.facts.aiCallsMinFreeBytes, undefined, "there is room: it is not that");
  }, { ...FAST_CALLS, log: (line) => lines.push(line) });
});
