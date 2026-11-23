import test from "node:test";
import assert from "node:assert/strict";
import { createFakeAutopilotAi } from "narrarium-engine/testing";
import * as testing from "../dist/testing.mjs";
import { adminLogin, until, withServer } from "./helpers.mjs";
import { ONE_CHAPTER, seededBook } from "./fake-provider.mjs";
import { HELD, startOf } from "./hold.mjs";

// The books in progress (P12): for every book, the state of its autopilot in words a person can act on (running, waiting for a new attempt, waiting for an answer, looks stalled,
// stopped by an error…), which chapter of how many, the step, since when, what the run spent, who runs it, and for the other books the last state that is known. It comes from the
// engine's summary and its live session, never from reading a whole book. `describeRun` is the pure part, tried on its own; the rest goes through the server with the real engine.

const { describeRun } = testing;
const SERVER_ID = "5b1f6f5e-7a53-4c3e-9b6e-0d6a6f4f0a11";
const NOW = Date.parse("2026-11-22T10:00:00.000Z");
const ago = (ms) => new Date(NOW - ms).toISOString();
const MINUTE = 60_000;

/** The summary a session gives, with what a test changes. */
const summary = (extra = {}) => ({
  status: "running",
  phase: "write",
  message: "SECRET-MESSAGE-OF-THE-RUN: chapter title text",
  progress: { chapters: 12, chaptersDone: 3, scenes: 36, scenesWritten: 10, words: 12000 },
  question: null,
  lastError: null,
  runner: { host: "server", label: "Studio", hostId: SERVER_ID, runId: "run-1", startedAt: ago(90 * MINUTE), heartbeatAt: ago(10_000) },
  stats: { tasks: 40, aiCalls: 41, inputTokens: 1000, outputTokens: 500, cost: 1.2, currency: "USD", failures: 0 },
  pendingNotes: 0,
  constraints: 0,
  updatedAt: ago(20_000),
  ...extra,
});
const snapshotOf = (extra = {}, over = {}) => ({ bookId: "b", state: {}, summary: summary(extra), activities: [], live: null, running: false, host: null, ...over });
const input = (extra = {}) => ({ bookId: "b", title: "The Glass Harbor", storage: "local", nowMs: NOW, stalledAfterMs: 10 * MINUTE, serverId: SERVER_ID, ...extra });
const live = (task = "write", chapterNumber = 4, sceneNumber = 2) => ({ activity: { id: "a1", runId: "run-1", task, phase: "write", title: "SECRET-ACTIVITY-TITLE", reason: "SECRET-REASON", next: "SECRET-NEXT", chapterNumber, sceneNumber, status: "running", startedAt: ago(30_000) }, characters: 120, preview: "SECRET-PREVIEW-OF-THE-PROSE" });

test("P12 runs: a run that this server is doing says the chapter it is at of how many, the step, since when and that it is this server's", () => {
  const view = describeRun(input({ snapshot: snapshotOf({}, { running: true, live: live("write", 4, 2), host: "server" }), spend: { tokens: 1500, calls: 41, cost: 1.2, currency: "USD", costUnknownCalls: 0, startedAt: ago(90 * MINUTE), active: true } }));
  assert.equal(view.state, "running");
  assert.deepEqual([view.live, view.status, view.phase], [true, "running", "write"]);
  assert.deepEqual(view.chapter, { current: 4, total: 12, done: 3 });
  assert.deepEqual([view.step, view.stepChapter, view.stepScene], ["write", 4, 2]);
  assert.equal(view.stepSinceMs, 30_000);
  assert.equal(view.sinceMs, 90 * MINUTE);
  assert.equal(view.heartbeatAgeMs, 10_000);
  assert.deepEqual(view.runner, { host: "server", label: "Studio", thisServer: true });
  assert.deepEqual(view.spend, { tokens: 1500, calls: 41, cost: 1.2, currency: "USD", costUnknownCalls: 0, startedAt: ago(90 * MINUTE), active: true });
  assert.deepEqual([view.bookId, view.title, view.storage, view.question, view.retry, view.error], ["b", "The Glass Harbor", "local", false, null, null]);
});

test("P12 runs: the states a person acts on: waiting for a new attempt, waiting for an answer, looks stalled, stopped by an error, paused, finished, never run, unreadable", () => {
  const state = (extra, over, more) => describeRun(input({ ...more, snapshot: snapshotOf(extra, over) })).state;
  assert.equal(state({ retry: { at: new Date(NOW + 25_000).toISOString(), attempt: 1, retries: 3 } }, { running: true, live: live() }), "retrying");
  assert.equal(state({ status: "waiting-author", runner: null, question: { id: "q", question: "SECRET-QUESTION?", options: ["Yes", "No"] } }), "waiting");
  assert.equal(state({ status: "waiting-author", runner: null, question: null }), "waiting", "the plan waits for the author too");
  assert.equal(state({ runner: { host: "browser", label: "MacBook", hostId: "dev", runId: "r", startedAt: ago(40 * MINUTE), heartbeatAt: ago(12 * MINUTE) } }), "stalled", "a heartbeat that is twelve minutes old");
  assert.equal(state({ runner: { host: "browser", label: "MacBook", hostId: "dev", runId: "r", startedAt: ago(40 * MINUTE), heartbeatAt: ago(9 * MINUTE) } }), "running", "and one that is nine minutes old is a run that is slow, not one that is stuck");
  assert.equal(state({}, { running: true, live: live() }, { stalledAfterMs: 5_000 }), "stalled", "also a run of this server, when its own beat has stopped");
  assert.equal(state({ status: "error", runner: null, lastError: { message: "x", at: ago(MINUTE), kind: "network" } }), "error");
  assert.equal(state({ status: "paused", runner: null }), "paused");
  assert.equal(state({ status: "completed", phase: "completed", runner: null }), "completed");
  assert.equal(state({ status: "idle", phase: "concept", runner: null, progress: { chapters: 0, chaptersDone: 0, scenes: 0, scenesWritten: 0, words: 0 } }), "idle");
  assert.equal(describeRun(input({ snapshot: { bookId: "b", state: null, summary: null, activities: [], live: null, running: false, host: null } })).state, "none");
  assert.equal(describeRun(input({ snapshot: { bookId: "b", state: null, summary: null, activities: [], live: null, running: false, host: null, stateError: { code: "state_corrupt", message: "autopilot/state.json cannot be read" } } })).state, "unreadable");
  assert.equal(describeRun(input({ snapshot: snapshotOf(), problem: "The repository is not available." })).state, "unreadable", "a book whose repository failed");
});

test("P12 runs: a book that waits, or is elsewhere, has the last state that is known: who runs it, when it changed, and what the last run spent", () => {
  const asked = describeRun(input({ snapshot: snapshotOf({ status: "waiting-author", runner: null, question: { id: "q", question: "SECRET-QUESTION?" } }), spend: { tokens: 90_000, calls: 400, cost: 3.5, currency: "USD", costUnknownCalls: 2, startedAt: ago(5 * 60 * MINUTE), active: false } }));
  assert.deepEqual([asked.state, asked.question, asked.live, asked.runner, asked.step], ["waiting", true, false, null, null]);
  assert.equal(asked.updatedAt, ago(20_000));
  assert.deepEqual([asked.spend.tokens, asked.spend.active, asked.spend.cost, asked.spend.costUnknownCalls], [90_000, false, 3.5, 2]);
  const elsewhere = describeRun(input({ snapshot: snapshotOf({ runner: { host: "browser", label: "Alessandro's MacBook", hostId: "device-1", runId: "r", startedAt: ago(5 * MINUTE), heartbeatAt: ago(20_000) } }) }));
  assert.deepEqual([elsewhere.state, elsewhere.live, elsewhere.runner], ["running", false, { host: "browser", label: "Alessandro's MacBook", thisServer: false }]);
  const another = describeRun(input({ snapshot: snapshotOf({ runner: { host: "server", label: "Other server", hostId: "another-server", runId: "r", startedAt: ago(MINUTE), heartbeatAt: ago(1000) } }) }));
  assert.equal(another.runner.thisServer, false, "a server that is not this one");
});

test("P12 runs: the chapter is the one the live step is at, or the next one to do, and all of them when the book is finished; a book with no plan has none", () => {
  const chapter = (extra, over) => describeRun(input({ snapshot: snapshotOf(extra, over) })).chapter;
  assert.deepEqual(chapter({}, { running: true, live: live("director-review", 4, undefined) }), { current: 4, total: 12, done: 3 });
  assert.deepEqual(chapter({ status: "paused", runner: null }), { current: 4, total: 12, done: 3 }, "paused after three: the fourth is next");
  assert.deepEqual(chapter({ status: "completed", phase: "completed", runner: null, progress: { chapters: 12, chaptersDone: 12, scenes: 36, scenesWritten: 36, words: 40000 } }), { current: 12, total: 12, done: 12 });
  assert.deepEqual(chapter({ status: "paused", runner: null, progress: { chapters: 12, chaptersDone: 14, scenes: 0, scenesWritten: 0, words: 0 } }), { current: 12, total: 12, done: 12 }, "never past the end");
  assert.equal(chapter({ phase: "plan", progress: { chapters: 0, chaptersDone: 0, scenes: 0, scenesWritten: 0, words: 0 } }), null, "no plan, no chapters");
  assert.equal(chapter({ progress: undefined }), null, "an engine that did not say");
});

test("P12 runs: what the page needs of a wait for a new attempt and of the last error is counted for it, and nothing of what the engine wrote in words is passed on", () => {
  const view = describeRun(input({
    snapshot: snapshotOf({
      retry: { at: new Date(NOW + 25_000).toISOString(), attempt: 2, retries: 3 },
      question: { id: "q", question: "SECRET-QUESTION?", options: ["a"] },
      pausePending: "after-chapter",
      lastError: { message: "SECRET-ERROR-MESSAGE with key sk-123", at: ago(40_000), task: "write", kind: "rate_limit", errorKind: "rate_limit", detail: { status: 429, endpoint: "https://api.example", model: "SECRET-MODEL" } },
    }, { running: true, live: live() }),
  }));
  assert.deepEqual(view.retry, { at: new Date(NOW + 25_000).toISOString(), attempt: 2, retries: 3, inMs: 25_000 });
  assert.equal(view.pausePending, "after-chapter");
  assert.deepEqual(view.lastError, { kind: "rate_limit", at: ago(40_000), task: "write", status: 429 });
  const text = JSON.stringify(view);
  for (const secret of ["SECRET-MESSAGE", "SECRET-ACTIVITY-TITLE", "SECRET-REASON", "SECRET-NEXT", "SECRET-PREVIEW", "SECRET-QUESTION", "SECRET-ERROR-MESSAGE", "sk-123", "SECRET-MODEL", "api.example"]) assert.equal(text.includes(secret), false, secret);
});

test("P12 runs: a summary that lacks what a newer engine says, or says something else, is read as far as it goes and never breaks the list", () => {
  assert.doesNotThrow(() => describeRun(input({ snapshot: { bookId: "b", state: {}, summary: { status: "running", phase: "write" }, activities: [], live: null, running: false, host: null } })));
  const odd = describeRun(input({ snapshot: snapshotOf({ status: "something-new", runner: { host: "browser", heartbeatAt: "not a time", startedAt: 12 }, progress: { chapters: "many" }, retry: { at: "never", attempt: "x" }, lastError: "text" }) }));
  assert.equal(typeof odd.state, "string");
  assert.equal(odd.heartbeatAgeMs, null);
  assert.equal(odd.sinceMs, null);
  assert.equal(odd.chapter, null);
  assert.equal(describeRun(input({ snapshot: undefined, problem: "It could not be read." })).state, "unreadable");
});

// ---------------------------------------------------------------------------------------------
// Through the server, with the real engine
// ---------------------------------------------------------------------------------------------

/**
 * The fake AI of the engine, with two switches: the director of the plan asks the author a question (`asking`: the run then waits for the answer), and the first request called
 * `label` is held once it is armed (the run it belongs to stays where it is, in the middle of a step).
 */
function armedAi(chapters = 3) {
  const base = createFakeAutopilotAi({ chapters, scenes: 1, reviewVerdict: () => "approve" });
  let armed;
  let held = false;
  let open = () => undefined;
  const gate = new Promise((resolve) => {
    open = resolve;
  });
  const ai = {
    asking: false,
    arm: (label = HELD) => void (armed = label),
    isHeld: () => held,
    release: () => open(),
    async complete(request) {
      if (ai.asking && request.json?.name === "plan_review") {
        const json = { verdict: "approve", score: 8, summary: "Good plan.", strengths: [], changes: [], guidance: [], questionForAuthor: { question: "Should Orrin be redeemed?", options: ["Yes", "No"] } };
        return { text: JSON.stringify(json), json, usage: { inputTokens: 100, outputTokens: 50, cachedInputTokens: 0 }, model: "fake-model", provider: "fake", cost: 0.001, currency: "USD" };
      }
      if (armed && !held && request.label === armed) {
        held = true;
        await new Promise((resolve, reject) => {
          gate.then(resolve);
          request.signal?.addEventListener("abort", () => reject(request.signal.reason), { once: true });
        });
      }
      return base.complete(request);
    },
  };
  return ai;
}

const runs = async (owner, query = "") => {
  const answer = await owner.call("GET", `/admin/api/runs${query}`);
  assert.equal(answer.status, 200, JSON.stringify(answer.body));
  return answer.body;
};
const viewOf = (body, bookId) => body.books.find((book) => book.bookId === bookId);

/** Change the autopilot's state of a book the way another host would have left it: read it, let `edit` change it, commit it. */
async function editState(client, bookId, edit) {
  const [file] = await client.readFiles(bookId, ["autopilot/state.json"]);
  const state = JSON.parse(file.content);
  edit(state);
  await client.commitFiles(bookId, [{ path: "autopilot/state.json", content: JSON.stringify(state, null, 2), expectedHash: file.hash }], "edit the state");
}
const finishedRun = (client, bookId) => until(async () => !(await client.autopilot(bookId)).running, 60_000);

test("P12 runs: every book is in the list with its own state: held mid-step, asking a question, paused, run elsewhere, silent for too long, never run, damaged", async () => {
  const ai = armedAi(3);
  await withServer(async (server, client) => {
    const owner = await adminLogin(server);
    // A book whose plan the director answers with a question: the run waits for the author.
    await seededBook(client, "asks", { chapters: 3 });
    ai.asking = true;
    await client.startAutopilot("asks", ONE_CHAPTER);
    await finishedRun(client, "asks");
    ai.asking = false;
    // A book that stops after its plan.
    await seededBook(client, "stops", { chapters: 3 });
    await client.startAutopilot("stops", { ...startOf(3), limits: { steps: 3 } });
    await finishedRun(client, "stops");
    // The same state, as other hosts left it.
    const [planned] = await client.readFiles("stops", ["autopilot/state.json"]);
    const now = Date.now();
    for (const [bookId, heartbeat] of [["away", 20_000], ["silent", 12 * MINUTE]]) {
      await seededBook(client, bookId, { chapters: 3 });
      await client.commitFiles(bookId, [{ path: "autopilot/state.json", content: planned.content }], "state");
      await editState(client, bookId, (state) => {
        state.status = "running";
        state.runner = { host: "browser", label: "Alessandro's MacBook", hostId: "device-1", runId: "run-elsewhere", startedAt: new Date(now - 5 * MINUTE).toISOString(), heartbeatAt: new Date(now - heartbeat).toISOString() };
      });
    }
    await seededBook(client, "never", { chapters: 3 });
    await client.registerBook("empty", { title: "Empty", storage: { kind: "local" } });
    await seededBook(client, "broken", { chapters: 3 });
    await client.commitFiles("broken", [{ path: "autopilot/state.json", content: "{ not json" }], "damage");
    // And one that this server is writing right now, held in the middle of a step.
    await seededBook(client, "live", { chapters: 3 });
    ai.arm();
    await client.startAutopilot("live", startOf(3));
    await until(() => ai.isHeld());
    const runId = server.spend.activeRun("live");
    server.spend.record({ usage: { inputTokens: 100, outputTokens: 50 }, usageKnown: true, cost: 0.12, costKnown: true, currency: "USD" }, { bookId: "live", runId });

    const body = await runs(owner, "?limit=50");
    assert.equal(body.total, 8);
    assert.equal(typeof body.now, "string");
    assert.deepEqual([body.maxConcurrentRuns, body.running], [2, 1]);
    assert.deepEqual(body.counts, { running: 2, waiting: 1, stalled: 1, paused: 1, none: 2, unreadable: 1 });
    assert.deepEqual(body.books.map((book) => book.bookId).slice(0, 4).sort(), ["asks", "away", "live", "silent"].sort(), "what is going on comes first");
    assert.equal(body.books[0].bookId, "silent", "and what looks stuck comes before all");
    assert.ok(["live", "away"].includes(body.books[1].bookId) && ["live", "away"].includes(body.books[2].bookId));
    assert.equal(body.books[3].bookId, "asks", "a book that waits for an answer is next");

    const live = viewOf(body, "live");
    assert.deepEqual([live.state, live.live, live.status, live.phase], ["running", true, "running", "write"]);
    assert.deepEqual(live.chapter, { current: 1, total: 3, done: 0 });
    assert.deepEqual([live.step, live.stepChapter, live.stepScene], ["write", 1, 1]);
    assert.equal(live.runner.thisServer, true);
    assert.equal(live.runner.host, "server");
    assert.ok(live.sinceMs >= 0 && live.sinceMs < 60_000);
    assert.ok(live.heartbeatAgeMs >= 0 && live.heartbeatAgeMs < 60_000);
    assert.deepEqual([live.spend.tokens, live.spend.calls, live.spend.cost, live.spend.currency, live.spend.active], [150, 1, 0.12, "USD", true], "what the run spent, from the server's own count");
    assert.deepEqual(body.spendToday, { day: new Date().toISOString().slice(0, 10), tokens: 150, calls: 1, cost: 0.12, currency: "USD" }, "and what the server spent today, all books together");

    // How far the plan is, as the book's own state says it (the chapter that is next, or the last one).
    const chaptersOf = async (bookId) => {
      const [file] = await client.readFiles(bookId, ["autopilot/state.json"]);
      const planned = JSON.parse(file.content).plan.chapters;
      const done = planned.filter((entry) => entry.status === "done").length;
      return { current: Math.min(planned.length, done + 1), total: planned.length, done };
    };
    const asks = viewOf(body, "asks");
    assert.deepEqual([asks.state, asks.status, asks.live, asks.question, asks.runner, asks.step], ["waiting", "waiting-author", false, true, null, null]);
    assert.deepEqual(asks.chapter, await chaptersOf("asks"));
    const stops = viewOf(body, "stops");
    assert.deepEqual([stops.state, stops.live, stops.chapter, stops.runner], ["paused", false, await chaptersOf("stops"), null]);
    assert.equal(stops.chapter.total, 3);
    const away = viewOf(body, "away");
    assert.deepEqual([away.state, away.live, away.runner, away.chapter], ["running", false, { host: "browser", label: "Alessandro's MacBook", thisServer: false }, await chaptersOf("away")]);
    assert.ok(away.heartbeatAgeMs < 5 * MINUTE && away.sinceMs >= 5 * MINUTE - 1000);
    assert.equal(viewOf(body, "silent").state, "stalled");
    assert.ok(viewOf(body, "silent").heartbeatAgeMs >= 12 * MINUTE);
    for (const id of ["never", "empty"]) assert.deepEqual([viewOf(body, id).state, viewOf(body, id).status, viewOf(body, id).chapter, viewOf(body, id).runner], ["none", null, null, null], id);
    const broken = viewOf(body, "broken");
    assert.equal(broken.state, "unreadable");
    assert.match(broken.error, /state/i, "the book's own problem, as the panel shows it today");

    // Not a word of the book, of what the run says in words, or of its question is passed on.
    const [asked] = await client.readFiles("asks", ["autopilot/state.json"]);
    const state = JSON.parse(asked.content);
    const wordsOfTheBook = [state.question?.question, state.message, state.plan?.chapters?.[0]?.title, state.plan?.chapters?.[0]?.summary, state.concept?.logline, state.brief?.idea].filter((text) => typeof text === "string" && text.length > 8);
    assert.ok(wordsOfTheBook.length >= 2, "there is something to look for");
    const wire = JSON.stringify(body);
    for (const text of wordsOfTheBook) assert.equal(wire.includes(text), false, `not passed on: ${text.slice(0, 40)}`);

    ai.release();
    await client.pauseAutopilot("live", "now");
    await finishedRun(client, "live");
  }, { ai });
});

test("P12 runs: a run of this server whose own beat has stopped looks stalled, and a book is never listed by reading the book: nothing of it is listed, hashed or asked of git", async () => {
  const ai = armedAi(2);
  await withServer(async (server, client) => {
    const owner = await adminLogin(server);
    await seededBook(client, "slow", { chapters: 2 });
    ai.arm();
    await client.startAutopilot("slow", startOf(2));
    await until(() => ai.isHeld());
    // Whatever would read the whole book is made to fail: the panel must not need it.
    const runtime = server.books.get("slow");
    runtime.store.list = async () => {
      throw new Error("the whole book was listed");
    };
    runtime.store.contentRevision = async () => {
      throw new Error("the whole book was hashed");
    };
    if (runtime.git) runtime.git.head = async () => {
      throw new Error("git was asked");
    };
    await until(async () => viewOf(await runs(owner), "slow")?.state === "stalled", 20_000);
    const status = await owner.call("GET", "/admin/api/status");
    assert.equal(status.status, 200, "the page that is polled every few seconds does not read the book either");
    assert.deepEqual(status.body.books.map((book) => [book.bookId, book.running, book.status, book.phase, book.storage]), [["slow", true, "running", "write", "local"]]);
    ai.release();
    await client.pauseAutopilot("slow", "now");
  }, { ai, autopilot: { heartbeatMs: 0, persistHeartbeatMs: 0 }, admin: { stalledAfterMs: 150 } });
});

test("P12 runs: a run that waits to try a failed step again says so, with which retry and when", async () => {
  const flaky = { async complete() { throw Object.assign(new Error("The provider is busy: SECRET-PROVIDER-TEXT"), { retryable: true }); } };
  await withServer(async (server, client) => {
    const owner = await adminLogin(server);
    await seededBook(client, "b", { chapters: 1 });
    await client.startAutopilot("b", startOf(1));
    const view = await until(async () => {
      const found = viewOf(await runs(owner), "b");
      return found?.state === "retrying" ? found : undefined;
    });
    assert.deepEqual([view.live, view.status, view.retry.attempt, view.retry.retries], [true, "running", 1, 1]);
    // About the delay that was set: a retry scheduled while the board is being read is a few milliseconds after the moment the board took as "now".
    assert.ok(view.retry.inMs > 0 && view.retry.inMs <= 31_000, `${view.retry.inMs} ms to the next attempt`);
    assert.equal(new Date(view.retry.at).toISOString(), view.retry.at);
    assert.equal(JSON.stringify(await runs(owner)).includes("SECRET-PROVIDER-TEXT"), false);
    await client.pauseAutopilot("b", "now");
    await finishedRun(client, "b");
    const after = viewOf(await runs(owner), "b");
    assert.deepEqual([after.state, after.retry, after.live], ["paused", null, false]);
  }, { ai: flaky, autopilot: { retryDelayMs: 30_000, random: () => 0 } });
});

test("P12 runs: with many books the list is a page: what is going on first, a number to ask for more, and the totals of all", async () => {
  const ai = armedAi(2);
  await withServer(async (server, client) => {
    const owner = await adminLogin(server);
    for (let index = 0; index < 29; index += 1) await client.registerBook(`book-${String(index).padStart(2, "0")}`, { title: `Book ${index}`, storage: { kind: "local" } });
    await seededBook(client, "going", { chapters: 2 });
    ai.arm();
    await client.startAutopilot("going", startOf(2));
    await until(() => ai.isHeld());

    const first = await runs(owner);
    assert.equal(first.books.length, 10, "ten at first");
    assert.equal(first.books[0].bookId, "going", "the one that is going on is on it");
    assert.equal(first.total, 30);
    assert.equal(first.nextOffset, 10);
    assert.deepEqual([first.counts.running, first.counts.none], [1, 29], "the totals are those of all the books, not of the page");
    const second = await runs(owner, "?limit=10&offset=10");
    assert.equal(second.books.length, 10);
    assert.equal(second.nextOffset, 20);
    const last = await runs(owner, "?limit=10&offset=20");
    assert.equal(last.books.length, 10);
    assert.equal(last.nextOffset, null);
    const ids = [...first.books, ...second.books, ...last.books].map((book) => book.bookId);
    assert.equal(new Set(ids).size, 30, "each book once");
    const all = await runs(owner, "?limit=200");
    assert.equal(all.books.length, 30);
    assert.equal(all.nextOffset, null);
    assert.equal((await runs(owner, "?limit=1000")).books.length, 30, "a limit that is too high is the highest there is");
    for (const query of ["?limit=0", "?limit=abc", "?offset=abc", "?offset=-1", "?limit=10&offset=1.5"]) assert.equal((await owner.call("GET", `/admin/api/runs${query}`)).status, 400, query);
    assert.deepEqual((await runs(owner, "?offset=500")).books, [], "past the end there is nothing, and no error");
    ai.release();
    await client.pauseAutopilot("going", "now");
  }, { ai });
});

test("P12 runs: a server with no books says so, and the route needs the admin session like every other", async () => {
  await withServer(async (server) => {
    const owner = await adminLogin(server);
    assert.deepEqual(await runs(owner).then((body) => [body.books, body.total, body.running, body.nextOffset]), [[], 0, 0, null]);
    const origin = server.adminUrl;
    assert.equal((await fetch(`${origin}/admin/api/runs`, { headers: { origin } })).status, 401);
    assert.equal((await fetch(`${origin}/admin/api/runs`, { headers: { origin: "https://evil.example" } })).status, 403);
    const clientToken = (await server.auth.issue("c", ["read", "write", "run", "update"])).token;
    assert.equal((await fetch(`${origin}/admin/api/runs`, { headers: { origin, authorization: `Bearer ${clientToken}` } })).status, 401);
    assert.equal((await fetch(`${server.url}/api/v1/runs`, { headers: { authorization: `Bearer ${clientToken}` } })).status, 404);
  });
});

test("P12 runs: the engine's own fake AI, run to the end, leaves a book that is finished, with all its chapters done", async () => {
  await withServer(async (server, client) => {
    const owner = await adminLogin(server);
    await seededBook(client, "done", { chapters: 2 });
    await client.startAutopilot("done", { ...startOf(2), options: { readers: false, readersOnPlan: false, specialists: false, pauseAfterPlan: false } });
    await finishedRun(client, "done");
    const view = viewOf(await runs(owner), "done");
    assert.ok(["completed", "waiting"].includes(view.state), view.state);
    assert.deepEqual(view.chapter, { current: 2, total: 2, done: 2 });
    assert.equal(view.live, false);
  }, { ai: createFakeAutopilotAi({ chapters: 2, scenes: 1, reviewVerdict: () => "approve" }) });
});
