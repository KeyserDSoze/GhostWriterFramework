import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { AUTOPILOT_ERROR_KINDS, AutopilotSession, FINAL_REVIEW_SUMMARY_CHARACTERS, FINAL_REVIEW_TEXT_CHARACTERS, MAX_CHAPTER_ROUNDS, summarizeAutopilotState } from "narrarium-engine";
import { MemoryBookStore, createFakeAutopilotAi, seedBookFiles } from "narrarium-engine/testing";
import { adminLogin, until, withServer } from "./helpers.mjs";
import { ONE_CHAPTER, aiConfigFor, approve, fakeProvider, finished, seedBookFilesWithChapters, seededBook } from "./fake-provider.mjs";
import { autopilotEvents, bookEvents, filesHolding, followStream, historyOf, stateEvents } from "./api-helpers.mjs";

// What the engine's autopilot now says besides what it said (the final verdict, the working time, the kind and the detail of an error, the retry that
// waits, the rounds of the review) goes through the server as it is: not filtered, not rewritten, not made up, and with no secret in it. Two runs
// against a provider on this machine give the data once, and each test reads what it is about.

const BOOK = "b";
/** A key that no pattern of a key would find: only knowing that it is the key tells a text that it must go. */
const KEY = "zzkey-7f3a91c2b8d44e0f9a1b";
/** A quarter of the engine's own pace (4 s for the first retry, 12 s for the second…), with no jitter: the first retry waits 750 ms, and the Retry-After of the provider counts a quarter as well. */
const PACE = { retryDelayMs: 1000, random: () => 0 };
const ALLOWED_DETAIL = ["attempt", "body", "endpoint", "integration", "model", "provider", "retries", "retryAfterMs", "route", "status"];

const stateText = (server, file = "state.json") => readFile(path.join(server.data.bookDirectory(BOOK), "autopilot", file), "utf8");
const succeeded = (activities) => activities.filter((activity) => activity.status === "succeeded");
const failed = (activities) => activities.filter((activity) => activity.status === "failed");
const durationOf = (activity) => Date.parse(activity.endedAt) - Date.parse(activity.startedAt);

/** What the server holds that a secret could be in, and whether it is: every answer it gave, every line it logged, every file and every change git kept. */
async function leaksOf(server, client, answers) {
  const everything = JSON.stringify([...answers, await client.aiStatus()]);
  return {
    answers: everything.includes(KEY),
    files: await filesHolding(server.data.root, KEY),
    history: historyOf(server.data.bookDirectory(BOOK)).includes(KEY),
  };
}

// ---------------------------------------------------------------------------------------------
// Run 1: a book that is written to the end, with a provider that says "slow down" twice
// ---------------------------------------------------------------------------------------------

/**
 * The provider answers 429 to the second request with a Retry-After of 100 s, and to the third without one; the concept step (the first) is done before.
 * The run waits (and the author pauses it in the wait), starts again, waits again (and the wait ends by itself), and writes the book.
 */
async function runWithSlowProvider() {
  const slow = { error: { message: `Rate limit reached for the key ${KEY}: slow down.` } };
  const provider = await fakeProvider({
    respond: (number) => {
      if (number === 2) return { status: 429, body: slow, headers: { "retry-after": "100" } };
      if (number === 3) return { status: 429, body: slow };
      return undefined;
    },
  });
  const lines = [];
  const seen = { origin: provider.origin, url: provider.url };
  try {
    await withServer(async (server, client) => {
      await seededBook(client, BOOK);
      await approve(await adminLogin(server), provider.origin);
      await client.putAiConfig(aiConfigFor(provider, { apiKey: KEY }));
      const stream = await followStream(client);
      try {
        await client.startAutopilot(BOOK, ONE_CHAPTER);
        const waits = () => stateEvents(stream.messages).filter((state) => state.retry).length;
        await until(() => waits() >= 1, 60_000);
        // (A server that left it out of the book events does not stop the run from being read, and the wait for them ends well before the wait of the run does: the test that is about them says so.)
        await until(() => bookEvents(stream.messages).some((summary) => summary.autopilot?.retry), 10_000).catch(() => undefined);
        seen.waiting = { snapshot: await client.autopilot(BOOK), list: await client.listBooks(), stateFile: await stateText(server), activityFile: await stateText(server, "activity.json") };
        await client.pauseAutopilot(BOOK, "now");
        seen.paused = { snapshot: await finished(client, BOOK, 120_000), list: await client.listBooks() };
        await client.startAutopilot(BOOK);
        await until(() => waits() >= 2, 60_000);
        seen.done = { snapshot: await finished(client, BOOK, 180_000), list: await client.listBooks(), events: (await client.events(BOOK)).events, stateFile: await stateText(server), activityFile: await stateText(server, "activity.json") };
        await until(() => stateEvents(stream.messages).at(-1)?.status === "completed", 30_000).catch(() => undefined);
        seen.messages = [...stream.messages];
        seen.leaks = await leaksOf(server, client, [seen.waiting, seen.paused, seen.done, seen.messages]);
      } finally {
        await stream.stop();
      }
    }, { ai: undefined, autopilot: PACE, log: (line) => lines.push(line) });
  } finally {
    await provider.close();
  }
  seen.log = lines;
  seen.provider = { requests: provider.requests.length, withKey: provider.requests.filter((request) => (request.headers.authorization ?? "") === `Bearer ${KEY}`).length };
  return seen;
}

/** The same book written by the engine alone (no server, no provider, no git), for the parts of the state that do not depend on the time or on the files. */
async function runByTheEngine() {
  const store = new MemoryBookStore(seedBookFilesWithChapters());
  const session = new AutopilotSession({ bookId: BOOK, store, ai: createFakeAutopilotAi(), host: "server", hostLabel: "the engine alone", retryDelayMs: 0 });
  await session.start(ONE_CHAPTER);
  await session.waitForIdle();
  return JSON.parse(store.files.get("autopilot/state.json"));
}

let slowRun;
let aloneRun;
const slow = () => (slowRun ??= runWithSlowProvider());
const alone = () => (aloneRun ??= runByTheEngine());

test("S5: while the run waits to try a failed step again, `summary.retry` says when and which retry in the snapshot, the list and the live stream, and the provider's Retry-After sets the wait", async () => {
  const { waiting, messages } = await slow();
  const first = stateEvents(messages).find((state) => state.retry);
  assert.deepEqual(Object.keys(first.retry).sort(), ["at", "attempt", "retries"], "what the engine says, and nothing else");
  assert.deepEqual([first.retry.attempt, first.retry.retries], [1, 3], "retry 1 of 3");
  assert.equal(new Date(first.retry.at).toISOString(), first.retry.at, "a time");
  assert.equal(waiting.snapshot.running, true);
  assert.deepEqual(waiting.snapshot.summary.retry, first.retry, "the snapshot says what the stream said");
  assert.deepEqual(waiting.list[0].autopilot.retry, first.retry, "and so does the list of books");
  assert.deepEqual(bookEvents(messages).find((summary) => summary.autopilot?.retry)?.autopilot.retry, first.retry, "and the book events");

  const insights = autopilotEvents(messages).filter((event) => event.type === "insight" && event.code === "failureRetry");
  assert.equal(insights.length, 2, "one for each time the provider said slow down");
  assert.deepEqual([insights[0].attempt, insights[0].retries], [1, 3]);
  assert.equal(insights[0].waitMs, 25_000, "the Retry-After of 100 s, at a quarter of the engine's pace: not sooner than the provider said");
  const countdown = Date.parse(first.retry.at) - Date.parse(insights[0].at);
  assert.ok(Math.abs(countdown - 25_000) < 2_000, `the time of the next attempt is when the wait ends (${countdown} ms)`);
  assert.equal(insights[1].waitMs, 750, "with no Retry-After the wait is the engine's own");

  assert.ok(!/"retry"\s*:/.test(waiting.stateFile), "it is never saved: not in the state file…");
  assert.ok(!/"retry"\s*:/.test(waiting.activityFile), "…nor in the log of the activities");
});

test("S5: the retry goes away when the wait ends, by the author's pause or by itself: the next state event, the snapshot and the list have none", async () => {
  const { paused, done, messages } = await slow();
  const states = stateEvents(messages);
  const waits = states.map((state, index) => (state.retry ? index : -1)).filter((index) => index >= 0);
  assert.equal(waits.length, 2, "two waits");
  assert.equal(states[waits[0] + 1].retry, undefined, "the pause that ended the first wait");
  assert.equal(states[waits[0] + 1].status, "paused");
  assert.equal(paused.snapshot.running, false);
  assert.equal(paused.snapshot.summary.retry, undefined);
  assert.equal(paused.list[0].autopilot.retry, undefined);

  assert.equal(states[waits[1] + 1].retry, undefined, "the attempt that followed the second wait");
  assert.equal(states[waits[1] + 1].status, "running", "the run went on");
  const events = autopilotEvents(messages);
  const second = events.findIndex((event) => event.type === "state" && event.state === states[waits[1]]);
  const over = events.findIndex((event, index) => index > second && event.type === "state");
  assert.ok(events.slice(over).some((event) => event.type === "task-started"), "and the step was tried again after it");
  assert.equal(done.snapshot.summary.retry, undefined);
  assert.equal(done.list[0].autopilot.retry, undefined);
  assert.equal(done.snapshot.state.status, "completed");

  const replayed = done.events.filter((event) => event.type === "state" && event.state.retry);
  assert.deepEqual(replayed.map((event) => event.state.retry.attempt), [1, 1], "a client that comes later is told as well");
});

test("S5: a failed attempt that is retried says its kind and where it happened, in the activity and in the event; a retried failure is no failure", async () => {
  const { done, messages, origin } = await slow();
  const attempts = failed(done.snapshot.activities);
  assert.equal(attempts.length, 2);
  // The provider asked for 100 s with the first 429 and said nothing with the second: the detail of the first says so, the second has none made up.
  const retryAfter = [100_000, undefined];
  for (const [index, activity] of attempts.entries()) {
    assert.equal(activity.errorKind, "rate_limit");
    // The fields are those of the last candidate the call asked, which here is the only one: the route (engine 0.1.17) says it as the step it was.
    const { route, ...fields } = activity.errorDetail;
    // What the provider answered (engine 0.1.19), in its own words with the key it quoted taken out.
    const body = { status: 429, shape: "openai", message: "Rate limit reached for the key [redacted]: slow down." };
    assert.deepEqual(fields, { status: 429, endpoint: origin, body, model: "gpt-test", provider: "openai", integration: "p", ...(retryAfter[index] === undefined ? {} : { retryAfterMs: retryAfter[index] }), attempt: 1, retries: 3 }, "the retry it belongs to is the first of three, and the Retry-After of the provider is there when it gave one");
    assert.deepEqual(route.map((step) => [step.position, step.integrationId, step.integrationName, step.model, step.outcome, step.status]), [[0, "p", "Local provider", "gpt-test", "failed", 429]], "the one candidate that was asked, as it ended");
    assert.equal(JSON.stringify(route).includes(KEY), false, "no key in the route");
    assert.ok(AUTOPILOT_ERROR_KINDS.includes(activity.errorKind));
    assert.ok(Object.keys(activity.errorDetail).every((key) => ALLOWED_DETAIL.includes(key)));
    assert.match(activity.error, /HTTP 429/);
    assert.ok(activity.error.includes("[redacted]") && !activity.error.includes(KEY), "what the provider said of the key is gone");
    const event = autopilotEvents(messages).find((entry) => entry.type === "task-finished" && entry.activity.id === activity.id);
    assert.equal(event.activity.errorKind, activity.errorKind, "the event carries them too");
    assert.deepEqual(event.activity.errorDetail, activity.errorDetail);
  }
  assert.equal(done.snapshot.state.stats.failures, 0, "a step that was retried is not a failure");
  assert.equal(done.snapshot.state.lastError, null);
  assert.equal(done.snapshot.summary.lastError, null);
  assert.ok(succeeded(done.snapshot.activities).every((activity) => activity.errorKind === undefined && activity.errorDetail === undefined), "a step that worked has neither");
});

test("S5: the final verdict is in the state, in the snapshot's summary, in the list and in the last state event, as the engine summarizes it", async () => {
  const { done, messages } = await slow();
  const { state } = done.snapshot;
  assert.deepEqual(Object.keys(state.finalReview).sort(), ["at", "score", "text", "verdict"]);
  assert.ok(["approve", "revise"].includes(state.finalReview.verdict));
  assert.ok(typeof state.finalReview.score === "number" && state.finalReview.score >= 0 && state.finalReview.score <= 10);
  assert.ok(state.finalReview.text.length > 0 && state.finalReview.text.length <= FINAL_REVIEW_TEXT_CHARACTERS);
  assert.equal(new Date(state.finalReview.at).toISOString(), state.finalReview.at);
  assert.ok(JSON.parse(done.stateFile).finalReview, "it is in the file that the engine saved");
  assert.deepEqual(JSON.parse(done.stateFile).finalReview, state.finalReview, "and the snapshot is that file");

  const expected = summarizeAutopilotState(state, { pausePending: null, limits: null, defaultPublish: "step" });
  assert.ok(expected.finalReview.text.length <= FINAL_REVIEW_SUMMARY_CHARACTERS);
  assert.deepEqual(done.snapshot.summary, expected, "the summary of the snapshot is what the engine makes of the state, field for field");
  assert.deepEqual(done.list[0].autopilot, expected, "the list says the same");
  assert.deepEqual(stateEvents(messages).at(-1), expected, "and so does the last state event of the run");

  const alonest = await alone();
  assert.deepEqual({ verdict: state.finalReview.verdict, score: state.finalReview.score, text: state.finalReview.text }, { verdict: alonest.finalReview.verdict, score: alonest.finalReview.score, text: alonest.finalReview.text }, "the verdict is the one the engine gives with no server around it");
});

test("S5: the working time is the sum of the steps that were saved, over the runs, and is the same in the state, the summary, the list and the last state event", async () => {
  const { done, messages, paused } = await slow();
  const workedMs = done.snapshot.state.stats.workedMs;
  assert.ok(Number.isInteger(workedMs) && workedMs >= 0, String(workedMs));
  const worked = succeeded(done.snapshot.activities);
  assert.equal(workedMs, worked.reduce((total, activity) => total + durationOf(activity), 0), "each step from its start to its end, as its activity shows");
  assert.equal(failed(done.snapshot.activities).length, 2, "(the attempts that failed are in the log, and not in the sum)");
  assert.ok(succeeded(paused.snapshot.activities).length >= 1, "(the first run saved a step before it was paused: the sum is over both runs)");
  assert.equal(paused.snapshot.state.stats.workedMs, succeeded(paused.snapshot.activities).reduce((total, activity) => total + durationOf(activity), 0), "what the first run had worked when it stopped");
  assert.equal(JSON.parse(done.stateFile).stats.workedMs, workedMs, "it is in the file");
  assert.equal(done.snapshot.summary.stats.workedMs, workedMs);
  assert.equal(done.list[0].autopilot.stats.workedMs, workedMs);
  assert.equal(stateEvents(messages).at(-1).stats.workedMs, workedMs);
  assert.ok(paused.snapshot.state.stats.workedMs <= workedMs, "and it only grows");

  // Since when it counts: the start of the first step that was counted, written once and the same everywhere.
  const since = [...worked].sort((left, right) => Date.parse(left.startedAt) - Date.parse(right.startedAt))[0].startedAt;
  assert.equal(done.snapshot.state.stats.workedMsSince, since, "the moment the first counted step began");
  assert.equal(paused.snapshot.state.stats.workedMsSince, since, "the first run said it, and the second did not move it");
  assert.equal(JSON.parse(done.stateFile).stats.workedMsSince, since, "it is in the file");
  assert.equal(done.snapshot.summary.stats.workedMsSince, since);
  assert.equal(done.list[0].autopilot.stats.workedMsSince, since);
  assert.equal(stateEvents(messages).at(-1).stats.workedMsSince, since);
});

test("S5: the rounds of the review of a chapter are in the state as the engine wrote them, and are the rounds the engine gives with no server around it", async () => {
  const { done } = await slow();
  const rounds = done.snapshot.state.plan.chapters.map((chapter) => chapter.rounds);
  assert.ok(rounds.every((list) => Array.isArray(list) && list.length >= 1 && list.length <= MAX_CHAPTER_ROUNDS), JSON.stringify(rounds));
  for (const round of rounds.flat()) {
    assert.ok(Object.keys(round).every((key) => ["director", "readers", "verdict", "accepted", "rejected"].includes(key)), JSON.stringify(round));
    assert.ok(typeof round.director === "number" && round.director >= 0 && round.director <= 10);
    assert.ok(round.verdict === "approve" || round.verdict === "revise", `the verdict of the round: ${JSON.stringify(round)}`);
  }
  assert.deepEqual(JSON.parse(done.stateFile).plan.chapters.map((chapter) => chapter.rounds), rounds, "they are in the file, and the snapshot is that file");
  assert.deepEqual((await alone()).plan.chapters.map((chapter) => chapter.rounds), rounds, "the same rounds as the engine alone writes");
});

test("S5: no key, in any answer, event, log line, file or change of the book, though the provider named it in what it said", async () => {
  const { leaks, log, provider } = await slow();
  assert.ok(provider.requests >= 15 && provider.withKey === provider.requests, "the key was used for every request, so the search below is worth something");
  assert.equal(leaks.answers, false, "answers and events");
  assert.deepEqual(leaks.files, [], "files");
  assert.equal(leaks.history, false, "what git kept");
  assert.ok(log.length > 0, "the server logged what it did");
  assert.deepEqual(log.filter((line) => line.includes(KEY)), [], "the log");
});

// ---------------------------------------------------------------------------------------------
// Run 2: a provider that refuses the key, and says it in full
// ---------------------------------------------------------------------------------------------

async function runWithRefusedKey() {
  const provider = await fakeProvider({
    respond: () => ({ status: 401, body: { error: { message: `Incorrect API key provided: ${KEY}. You can find your API key at https://platform.openai.com/account/api-keys.`, type: "invalid_request_error", code: "invalid_api_key" } } }),
  });
  const lines = [];
  const seen = { origin: provider.origin, url: provider.url };
  try {
    await withServer(async (server, client) => {
      await seededBook(client, BOOK);
      await approve(await adminLogin(server), provider.origin);
      await client.putAiConfig(aiConfigFor(provider, { apiKey: KEY }));
      const stream = await followStream(client);
      try {
        await client.startAutopilot(BOOK, ONE_CHAPTER);
        seen.snapshot = await finished(client, BOOK, 120_000);
        await until(() => stateEvents(stream.messages).at(-1)?.status === "error", 30_000).catch(() => undefined);
        seen.list = await client.listBooks();
        seen.events = (await client.events(BOOK)).events;
        seen.stateFile = await stateText(server);
        seen.messages = [...stream.messages];
        seen.leaks = await leaksOf(server, client, [seen.snapshot, seen.list, seen.events, seen.messages]);
      } finally {
        await stream.stop();
      }
    }, { ai: undefined, autopilot: PACE, log: (line) => lines.push(line) });
  } finally {
    await provider.close();
  }
  seen.log = lines;
  seen.provider = { requests: provider.requests.length, withKey: provider.requests.filter((request) => (request.headers.authorization ?? "") === `Bearer ${KEY}`).length };
  return seen;
}

let refusedRun;
const refused = () => (refusedRun ??= runWithRefusedKey());

test("S5: an error that ends the run puts its kind and detail in `lastError`, in the summary as `kind` and `detail`, and in the failed activity: the same in the snapshot, the list and the stream", async () => {
  const { snapshot, list, messages, origin, url, stateFile } = await refused();
  assert.equal(snapshot.state.status, "error");
  // The fields are the last candidate's, and the route (engine 0.1.17) is every candidate that was asked: here the one, as it ended.
  const { route, ...fields } = snapshot.state.lastError.errorDetail;
  // What the provider answered (engine 0.1.19), in its own words with the key it quoted taken out.
  const body = { status: 401, shape: "openai", message: "Incorrect API key provided: [redacted]. You can find your API key at https://platform.openai.com/account/api-keys.", type: "invalid_request_error", code: "invalid_api_key" };
  assert.deepEqual(fields, { status: 401, endpoint: origin, body, model: "gpt-test", provider: "openai", integration: "p" }, "the detail says only the origin of the address; a failure that is never retried has no retry in it");
  assert.deepEqual(route.map((step) => [step.position, step.integrationId, step.model, step.outcome, step.status, step.endpoint]), [[0, "p", "gpt-test", "failed", 401, origin]], "the route has the only candidate, with the origin too");
  const detail = { ...fields, route };
  assert.notEqual(url, origin, "the provider's address has a path (/v1) …");
  assert.deepEqual(snapshot.state.lastError.errorDetail, detail, "… and the detail says only its origin");
  assert.equal(snapshot.state.lastError.errorKind, "auth");
  assert.ok(AUTOPILOT_ERROR_KINDS.includes(snapshot.state.lastError.errorKind));
  assert.equal(snapshot.state.lastError.task, "concept");
  assert.deepEqual(JSON.parse(stateFile).lastError, snapshot.state.lastError, "it is in the file, and the snapshot is that file");

  const expected = summarizeAutopilotState(snapshot.state, { pausePending: null, limits: null, defaultPublish: "step" });
  assert.equal(expected.lastError.kind, "auth");
  assert.deepEqual(expected.lastError.detail, detail);
  assert.deepEqual(snapshot.summary, expected, "the summary is what the engine makes of the state, with the kind and the detail also under their short names");
  assert.deepEqual(list[0].autopilot, expected);
  assert.deepEqual(stateEvents(messages).at(-1), expected, "and the last state event of the run");

  const activity = failed(snapshot.activities).at(-1);
  assert.equal(activity.errorKind, "auth");
  assert.deepEqual(activity.errorDetail, detail);
  assert.equal(snapshot.state.lastError.activityId, activity.id, "it says which step failed: the one of the log");
  assert.equal(snapshot.summary.lastError.activityId, activity.id);
  assert.equal(list[0].autopilot.lastError.activityId, activity.id);
  const event = autopilotEvents(messages).find((entry) => entry.type === "task-finished" && entry.activity.id === activity.id);
  assert.deepEqual([event.activity.errorKind, event.activity.errorDetail], [activity.errorKind, activity.errorDetail]);
  assert.match(snapshot.state.lastError.message, /HTTP 401/);
  assert.ok(snapshot.state.lastError.message.includes("[redacted]"), "what the provider said of the key is gone");
});

test("S5: no key, in any answer, event, log line, file or change of the book, though the provider answered with it in full", async () => {
  const { leaks, log, provider } = await refused();
  assert.ok(provider.requests >= 1 && provider.withKey === provider.requests, "the key was used, so the search below is worth something");
  assert.equal(leaks.answers, false, "answers and events");
  assert.deepEqual(leaks.files, [], "files");
  assert.equal(leaks.history, false, "what git kept");
  assert.deepEqual(log.filter((line) => line.includes(KEY)), [], "the log");
});

// ---------------------------------------------------------------------------------------------
// What an older file says, and what a book that never ran says
// ---------------------------------------------------------------------------------------------

test("S5: a book that never ran, and a state from an engine that knew none of this, read as they always did: nothing is made up and nothing is added", async () => {
  await withServer(async (server, client) => {
    await seededBook(client, BOOK);
    const fresh = await client.configureAutopilot(BOOK, { options: { pauseAfterPlan: false } });
    assert.equal(fresh.state.finalReview, undefined);
    assert.ok(!("workedMs" in fresh.state.stats), "not zero, not NaN: nothing");
    assert.ok(!("finalReview" in fresh.summary) && !("retry" in fresh.summary) && !("workedMs" in fresh.summary.stats));
    assert.equal(fresh.summary.lastError, null);

    const older = JSON.parse(await stateText(server));
    delete older.stats.workedMs;
    delete older.finalReview;
    older.status = "error";
    older.message = "An older failure.";
    older.lastError = { message: "An older failure.", at: "2026-01-01T00:00:00.000Z", task: "concept" };
    await client.commitFiles(BOOK, [{ path: "autopilot/state.json", content: `${JSON.stringify(older, null, 2)}\n` }], "an older engine's state");
    const snapshot = await client.autopilot(BOOK);
    assert.deepEqual(snapshot.state.lastError, older.lastError, "no kind, no detail: none is added");
    assert.deepEqual(snapshot.summary.lastError, older.lastError, "and the summary has none either");
    assert.ok(!("kind" in snapshot.summary.lastError) && !("detail" in snapshot.summary.lastError));
    assert.deepEqual((await client.listBooks())[0].autopilot.lastError, older.lastError);
    assert.ok(!("workedMs" in snapshot.state.stats) && !("workedMs" in snapshot.summary.stats));
    assert.ok(!("finalReview" in snapshot.summary));
  });
});
