import test from "node:test";
import assert from "node:assert/strict";
import * as engine from "../dist/index.js";
import { MemoryBookStore, createFakeAutopilotAi, seedBookFiles } from "../dist/testing/index.js";
import { integration } from "./transport-fakes.mjs";

const { AiProviderError, AutopilotSession, SYNC_MAX_FILE_BYTES, autopilotErrorFields, classifyAutopilotError, createAutopilotState, createFetchAi, defaultDirector, normalizeErrorDetail, parseAutopilotState, readStoredAutopilot, serializeAutopilotState, serializeDirector, summarizeAutopilotState } = engine;

const STATE = "autopilot/state.json";
const FAST = { readers: false, readersOnPlan: false, specialists: false, pauseAfterPlan: false };
const READERS = { readers: true, maxReaders: 2, readersOnPlan: false, specialists: true, pauseAfterPlan: false };
const brief = (targetChapters) => ({ idea: "x", targetChapters, scenesPerChapter: 1, wordsPerScene: 300 });
const stateOf = (store) => parseAutopilotState(store.files.get(STATE));
const summaries = (events) => events.filter((event) => event.type === "state").map((event) => event.state);

function reply(json) {
  return { text: JSON.stringify(json), json, usage: { inputTokens: 100, outputTokens: 50, cachedInputTokens: 0 }, model: "fake-model", provider: "fake", cost: 0.001, currency: "USD" };
}

// ─── rounds[].verdict ───────────────────────────────────────────────────────

/** A director who judges each chapter as `script[chapter]` says, one [verdict, score, accept] for each review, in the order they are asked. */
function scriptedAi(script) {
  const base = createFakeAutopilotAi();
  const turns = new Map();
  return {
    calls: base.calls,
    async complete(request) {
      const judged = /^autopilot:director-review:(\d+)$/.exec(request.label);
      if (!judged) return base.complete(request);
      base.calls.push(request);
      const chapter = Number(judged[1]);
      const turn = turns.get(chapter) ?? 0;
      turns.set(chapter, turn + 1);
      const [verdict, score, accept] = script[chapter][turn];
      const ids = [...request.user.matchAll(/\[([A-Z]\d+-\d+)\]/g)].map((match) => match[1]);
      return reply({
        verdict,
        score,
        summary: "Judged.",
        strengths: [],
        decisions: ids.map((id, index) => ({ findingId: id, action: accept && index === 0 ? "accept" : "reject", rationale: "Because.", remediation: accept && index === 0 ? "Open with Mira already running." : "", sceneNumber: 1 })),
        extraFixes: [],
        guidance: [],
      });
    },
  };
}

const withDirector = () => ({ ...seedBookFiles(), "director.md": serializeDirector({ ...defaultDirector("en"), approvalScore: 7, maxReviewRounds: 3 }) });

async function run(ai, chapters, options = READERS) {
  const store = new MemoryBookStore(withDirector());
  const session = new AutopilotSession({ bookId: "book", store, ai, host: "server", hostLabel: "test", retryDelayMs: 0 });
  await session.start({ brief: brief(chapters), options });
  await session.waitForIdle();
  return { state: stateOf(store), store, session };
}

test("every round the director judges says its verdict: the one the plan acts on, which is not always the one the model gave", async () => {
  const ai = scriptedAi({
    1: [["revise", 6, true], ["approve", 8, false]],
    // The model approves, but 4 is under the approval score of 7 and a fix applies: the round is a revision.
    2: [["approve", 4, true], ["approve", 8, false]],
    // The model approves a 3 and no fix applies: the approval is withheld, then the chapter is approved as it is.
    3: [["approve", 3, false]],
  });
  const { state } = await run(ai, 3);
  assert.equal(state.status, "completed", state.lastError?.message);
  const verdicts = state.plan.chapters.map((chapter) => chapter.rounds.map((round) => round.verdict));
  assert.deepEqual(verdicts, [["revise", "approve"], ["revise", "approve"], ["approve"]]);
  for (const chapter of state.plan.chapters) for (const round of chapter.rounds) {
    assert.deepEqual(Object.keys(round).filter((key) => !["director", "readers", "verdict", "accepted", "rejected"].includes(key)), [], "nothing but the votes, the verdict and the counters");
  }
  const reviewed = state.plan.chapters.map((chapter) => chapter.rounds.map((round) => round.director));
  assert.deepEqual(reviewed, [[6, 8], [4, 8], [3]], "the votes are the ones the director gave");
});

test("the verdict of a round is in the plan at once, with the round, and survives every save", async () => {
  const ai = scriptedAi({ 1: [["revise", 6, true], ["approve", 8, false]] });
  const { store } = await run(ai, 1);
  const saved = stateOf(store).plan.chapters[0].rounds;
  assert.deepEqual(saved.map((round) => round.verdict), ["revise", "approve"]);
  assert.deepEqual(parseAutopilotState(serializeAutopilotState(stateOf(store))).plan.chapters[0].rounds, saved);
});

const CHAPTER = { number: 1, title: "One", slug: "001-one", summary: "", goal: "", pov: [], keyEvents: [], reveals: [], status: "done", scenes: [] };
const planWith = (chapters) => ({ ...createAutopilotState(new Date(0)), plan: { chapters, approved: true, rounds: 0, revisionNotes: [], readerReactions: [], readersDone: true, awaitingAuthor: false } });
const readRounds = (rounds) => parseAutopilotState(JSON.stringify(planWith([{ ...CHAPTER, rounds }]))).plan.chapters[0];

test("a verdict read from a file is approve or revise (the way the final review's is) and any other value is dropped, never made up", () => {
  assert.deepEqual(readRounds([{ director: 7, verdict: "approve", accepted: 1 }]).rounds, [{ director: 7, verdict: "approve", accepted: 1 }]);
  assert.deepEqual(readRounds([{ director: 5, verdict: "revise" }, { director: 6, verdict: " Approve " }]).rounds, [{ director: 5, verdict: "revise" }, { director: 6, verdict: "approve" }]);
  for (const garbage of ["maybe", "rewrite", "", 1, true, null, {}, []]) {
    assert.deepEqual(readRounds([{ director: 7, verdict: garbage }]).rounds, [{ director: 7 }], JSON.stringify(garbage));
  }
  assert.deepEqual(readRounds([{ director: 7 }]).rounds, [{ director: 7 }], "a round of an older engine has none, and is not given one");
});

test("a verdict alone is no round: a round needs a number, as it always did", () => {
  for (const rounds of [[{ verdict: "approve" }], [{ verdict: "revise" }, null], [{ verdict: "approve", note: "x" }]]) assert.equal("rounds" in readRounds(rounds), false, JSON.stringify(rounds));
  assert.deepEqual(readRounds([{ verdict: "approve" }, { readers: 7, verdict: "revise" }]).rounds, [{ readers: 7, verdict: "revise" }]);
});

test("the state file still writes a round on one line, with its verdict, and what looks like a round in the text of the book stays text", () => {
  const state = planWith([{
    ...CHAPTER,
    title: "A \"rounds\": [ { \"verdict\": \"approve\" } ] title",
    rounds: [{ director: 6.5, readers: 7, verdict: "revise", accepted: 1, rejected: 2 }, { director: 8, verdict: "approve", accepted: 0, rejected: 1 }, { director: 10, accepted: 12, rejected: 0 }],
  }]);
  const text = serializeAutopilotState(state);
  assert.deepEqual(JSON.parse(text), JSON.parse(JSON.stringify(state, null, 2)), "it is the same JSON");
  const lines = text.split("\n").map((line) => line.trim()).filter((line) => /^\{ "(director|readers|verdict|accepted|rejected)"/.test(line));
  assert.deepEqual(lines, [
    "{ \"director\": 6.5, \"readers\": 7, \"verdict\": \"revise\", \"accepted\": 1, \"rejected\": 2 },",
    "{ \"director\": 8, \"verdict\": \"approve\", \"accepted\": 0, \"rejected\": 1 },",
    "{ \"director\": 10, \"accepted\": 12, \"rejected\": 0 }",
  ]);
  assert.ok(text.includes("\"title\": \"A \\\"rounds\\\": [ { \\\"verdict\\\": \\\"approve\\\" } ] title\""));
});

test("with a verdict a round still costs about a hundred bytes: 5000 chapters with three rounds, and eight in every one of them, fit what the server accepts", () => {
  const rounds = [{ director: 6.5, readers: 7.5, verdict: "revise", accepted: 4, rejected: 3 }, { director: 7.5, verdict: "revise", accepted: 2, rejected: 5 }, { director: 8.5, verdict: "approve", accepted: 0, rejected: 6 }];
  const chapter = (number, kept) => ({ number, title: `The Harbor At Night ${number}`, slug: `${String(number).padStart(4, "0")}-the-harbor-at-night-${number}`, summary: `In chapter ${number} the council changes what Mira believes.`, goal: "Mira learns what the keeper hid.", pov: ["Mira Vale"], keyEvents: [`Event ${number}`], reveals: [], status: "done", score: 8, scenes: [], ...(kept ? { rounds: kept } : {}) });
  const book = (kept) => planWith(Array.from({ length: 5000 }, (_, index) => chapter(index + 1, kept)));
  const without = serializeAutopilotState(book(undefined)).length;
  const withRounds = serializeAutopilotState(book(rounds));
  const perRound = (withRounds.length - without) / 5000 / 3;
  assert.ok(perRound < 135, `a round with its verdict costs ${perRound.toFixed(1)} bytes in the file`);
  assert.ok(withRounds.length < SYNC_MAX_FILE_BYTES / 2, `${(withRounds.length / 1024 / 1024).toFixed(2)} MiB`);
  const worst = serializeAutopilotState(book(Array.from({ length: 8 }, () => rounds[0]))).length;
  assert.ok(worst < SYNC_MAX_FILE_BYTES, `${(worst / 1024 / 1024).toFixed(2)} MiB with eight rounds in every chapter`);
  assert.equal(parseAutopilotState(withRounds).plan.chapters[4999].rounds[2].verdict, "approve");
});

// ─── errorDetail.retryAfterMs ───────────────────────────────────────────────

const limited = new AiProviderError("openai m: HTTP 429 — slow down", 429, true, { transient: true, retryAfterMs: 7000, model: "m", provider: "openai", integrationId: "main" });

test("the detail of a failure carries the Retry-After the provider gave, in milliseconds, and only when it gave one", () => {
  assert.equal(classifyAutopilotError(limited).detail.retryAfterMs, 7000);
  assert.deepEqual(classifyAutopilotError(limited).detail, { status: 429, model: "m", provider: "openai", integration: "main", retryAfterMs: 7000 });
  assert.equal(classifyAutopilotError(new AiProviderError("t", 503, true, { transient: true, retryAfterMs: 0 })).detail.retryAfterMs, 0, "a Retry-After of 0 is a value");
  for (const plain of [new AiProviderError("t", 429, true, { transient: true }), new AiProviderError("t", 401, false), new Error("t")]) assert.equal("retryAfterMs" in classifyAutopilotError(plain).detail, false);
  // The client folds the wait of an earlier candidate into the error it ends with: on a status that does not carry a Retry-After it is no part of what that failure says.
  for (const status of [401, 400, 500, 502, undefined]) assert.equal("retryAfterMs" in classifyAutopilotError(new AiProviderError("t", status, false, { retryAfterMs: 5000 })).detail, false, String(status));
  for (const bad of [-1, Number.NaN, Number.POSITIVE_INFINITY, "5000", null, {}, 86_400_001]) {
    const error = Object.assign(new AiProviderError("t", 429, true, { transient: true }), { retryAfterMs: bad });
    assert.equal("retryAfterMs" in classifyAutopilotError(error).detail, false, String(bad));
  }
  assert.equal(autopilotErrorFields(limited, { attempt: 1, retries: 3 }).errorDetail.retryAfterMs, 7000, "in what a failed activity and lastError carry");
});

test("a detail read from a file keeps a valid Retry-After and drops anything else", () => {
  assert.deepEqual(normalizeErrorDetail({ status: 429, retryAfterMs: 5000 }), { status: 429, retryAfterMs: 5000 });
  assert.deepEqual(normalizeErrorDetail({ retryAfterMs: 5000.4 }), { retryAfterMs: 5000 });
  assert.deepEqual(normalizeErrorDetail({ retryAfterMs: 0 }), { retryAfterMs: 0 });
  for (const bad of [-1, "5000", null, Number.NaN, 1e12, {}]) assert.equal(normalizeErrorDetail({ retryAfterMs: bad }), undefined, String(bad));
  assert.deepEqual(normalizeErrorDetail({ status: 429, attempt: 1, retries: 3 }), { status: 429, attempt: 1, retries: 3 }, "a file of an older engine reads as it did");
});

const failBody = (status, headers = {}) => new Response(JSON.stringify({ error: { message: `provider said ${status}` } }), { status, headers: { "content-type": "application/json", ...headers } });
const ONE = { brief: brief(1), options: FAST };

async function failingRun(fetch) {
  const ai = createFetchAi({ aiIntegrations: [integration({ id: "main" })] }, { fetch });
  const store = new MemoryBookStore(seedBookFiles());
  const events = [];
  const session = new AutopilotSession({ bookId: "book", store, ai, host: "server", hostLabel: "test", retryDelayMs: 0 });
  session.subscribe((event) => events.push(event));
  await session.start(ONE);
  await session.waitForIdle();
  const snapshot = await session.snapshot();
  return { state: stateOf(store), snapshot, events, store, activities: (await readStoredAutopilot(store)).activities };
}

test("a run that ends on a rate limit says when the provider said to come back: in the state, the failed step, the events and the summary", async () => {
  const { state, snapshot, events, activities } = await failingRun(async () => failBody(429, { "retry-after": "7" }));
  assert.equal(state.status, "error");
  assert.equal(state.lastError.errorKind, "rate_limit");
  assert.equal(state.lastError.errorDetail.retryAfterMs, 7000);
  assert.equal(snapshot.summary.lastError.detail.retryAfterMs, 7000);
  const failed = activities.filter((activity) => activity.status === "failed").at(-1);
  assert.equal(failed.errorDetail.retryAfterMs, 7000);
  assert.ok(events.some((event) => event.type === "task-finished" && event.activity.errorDetail?.retryAfterMs === 7000));
  const overloaded = await failingRun(async () => failBody(503, { "retry-after": "2" }));
  assert.equal(overloaded.state.lastError.errorDetail.retryAfterMs, 2000);
  const unauthorised = await failingRun(async () => failBody(401));
  assert.equal("retryAfterMs" in unauthorised.state.lastError.errorDetail, false);
});

// ─── lastError.activityId ───────────────────────────────────────────────────

test("lastError says which activity failed: the id of the failed step, in the state, the summary and the events", async () => {
  const { state, snapshot, events, activities } = await failingRun(async () => failBody(401));
  const failed = activities.filter((activity) => activity.status === "failed");
  assert.equal(failed.length, 1);
  assert.equal(typeof state.lastError.activityId, "string");
  assert.equal(state.lastError.activityId, failed[0].id);
  assert.equal(snapshot.summary.lastError.activityId, failed[0].id);
  assert.ok(events.some((event) => event.type === "task-finished" && event.activity.id === state.lastError.activityId && event.activity.status === "failed"));
  assert.equal(snapshot.state.lastError.activityId, failed[0].id);
});

test("after retries it is the activity of the attempt that ended the run, and the activity is in the log", async () => {
  const { state, activities } = await failingRun(async () => failBody(429, { "retry-after": "1" }));
  const failed = activities.filter((activity) => activity.status === "failed");
  assert.ok(failed.length > 1, `${failed.length} attempts`);
  assert.equal(state.lastError.activityId, failed.at(-1).id);
  assert.ok(activities.some((activity) => activity.id === state.lastError.activityId));
});

test("an error that belongs to no step has no activity id, and an older state has none either: nothing is made up", () => {
  const file = (lastError) => ({ ...createAutopilotState(new Date(0)), lastError });
  const read = (lastError) => parseAutopilotState(JSON.stringify(file(lastError))).lastError;
  assert.deepEqual(read({ message: "boom", at: "2026-01-01T00:00:00.000Z" }), { message: "boom", at: "2026-01-01T00:00:00.000Z", task: undefined });
  assert.equal("activityId" in read({ message: "boom", at: "x" }), false);
  assert.equal(read({ message: "boom", at: "x", activityId: "activity_abc-123" }).activityId, "activity_abc-123");
  for (const bad of [5, null, {}, "", "has spaces", "a".repeat(300), "<script>"]) assert.equal("activityId" in read({ message: "boom", at: "x", activityId: bad }), false, JSON.stringify(bad));
  const summary = summarizeAutopilotState(file({ message: "boom", at: "x", activityId: "activity_1", errorKind: "provider" }));
  assert.equal(summary.lastError.activityId, "activity_1");
});

// ─── stats.workedMsSince ────────────────────────────────────────────────────

function fakeClock(start = Date.parse("2026-02-01T08:00:00.000Z")) {
  const clock = { t: start, now: () => new Date(clock.t) };
  return clock;
}

function slowAi(clock, milliseconds) {
  const base = createFakeAutopilotAi({ reviewVerdict: () => "approve", scenes: 1 });
  return {
    calls: base.calls,
    async complete(request) {
      clock.t += milliseconds;
      return base.complete(request);
    },
  };
}

function sessionFor(store, ai, clock) {
  const events = [];
  const session = new AutopilotSession({ bookId: "book", store, ai, host: "server", hostLabel: "test", retryDelayMs: 0, now: clock.now });
  session.subscribe((event) => events.push(event));
  return { session, events };
}

const steps = async (session, count, start = {}) => {
  await session.start({ ...start, limits: { steps: count } });
  await session.waitForIdle();
};

test("the time the worked time started counting is written when it is born, with the first step it counts, and never changes", async () => {
  const clock = fakeClock();
  const store = new MemoryBookStore(seedBookFiles());
  const first = sessionFor(store, slowAi(clock, 1000), clock);
  await steps(first.session, 2, { brief: brief(2), options: FAST });
  const state = stateOf(store);
  assert.equal(state.stats.workedMs, 2000);
  assert.equal(state.stats.workedMsSince, "2026-02-01T08:00:00.000Z", "the moment the first step that counts began");
  assert.equal(summaries(first.events).at(-1).stats.workedMsSince, "2026-02-01T08:00:00.000Z", "in the summary of the live events");
  assert.equal((await first.session.snapshot()).summary.stats.workedMsSince, "2026-02-01T08:00:00.000Z");

  clock.t += 6 * 3_600_000;
  const second = sessionFor(store, slowAi(clock, 500), clock);
  await steps(second.session, 1);
  const later = stateOf(store);
  assert.equal(later.stats.workedMs, 2500);
  assert.equal(later.stats.workedMsSince, "2026-02-01T08:00:00.000Z", "it does not move with the steps that follow, nor with another run");
});

test("a book whose worked time was already counting has no moment to say, and is not given one", async () => {
  const clock = fakeClock();
  const store = new MemoryBookStore(seedBookFiles());
  const first = sessionFor(store, slowAi(clock, 1000), clock);
  await steps(first.session, 1, { brief: brief(2), options: FAST });
  // The state as an engine that counted the time but did not say since when wrote it.
  const earlier = stateOf(store);
  delete earlier.stats.workedMsSince;
  store.files.set(STATE, serializeAutopilotState(earlier));
  assert.equal("workedMsSince" in stateOf(store).stats, false);
  clock.t += 1000;
  const second = sessionFor(store, slowAi(clock, 1000), clock);
  await steps(second.session, 2);
  const later = stateOf(store);
  assert.equal(later.stats.workedMs, 3000, "the time goes on counting");
  assert.equal("workedMsSince" in later.stats, false, "and the moment it began is not known, so it is not said");
});

test("a state that never counted the time is born with both when its next step is saved, at that step's start", async () => {
  const clock = fakeClock(Date.parse("2026-03-05T12:30:00.000Z"));
  const store = new MemoryBookStore(seedBookFiles());
  const first = sessionFor(store, slowAi(clock, 1000), clock);
  await steps(first.session, 1, { brief: brief(2), options: FAST });
  const written = stateOf(store);
  delete written.stats.workedMs;
  delete written.stats.workedMsSince;
  store.files.set(STATE, serializeAutopilotState(written));
  assert.equal("workedMs" in stateOf(store).stats, false);

  clock.t = Date.parse("2026-04-01T09:00:00.000Z");
  const second = sessionFor(store, slowAi(clock, 2500), clock);
  await steps(second.session, 1);
  const state = stateOf(store);
  assert.equal(state.stats.workedMs, 2500);
  assert.equal(state.stats.workedMsSince, "2026-04-01T09:00:00.000Z");
});

test("workedMsSince read from a file is a moment or nothing", () => {
  const read = (value) => parseAutopilotState(JSON.stringify({ ...createAutopilotState(new Date(0)), stats: { tasks: 1, aiCalls: 1, inputTokens: 0, outputTokens: 0, cost: 0, failures: 0, workedMs: 500, workedMsSince: value } })).stats;
  assert.equal(read("2026-02-01T08:00:00.000Z").workedMsSince, "2026-02-01T08:00:00.000Z");
  assert.equal(read("2026-02-01T10:00:00+02:00").workedMsSince, "2026-02-01T08:00:00.000Z", "the same moment, said the usual way");
  assert.equal(read("2026-02-01").workedMsSince, "2026-02-01T00:00:00.000Z");
  for (const bad of ["yesterday", "", "5", "2026-13-45T99:00:00Z", 5, null, {}, [], true]) assert.equal("workedMsSince" in read(bad), false, JSON.stringify(bad));
  assert.equal(read("2026-02-01T08:00:00.000Z").workedMs, 500, "the rest of the statistics are as they were");
});
