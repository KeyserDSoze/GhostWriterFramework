import test from "node:test";
import assert from "node:assert/strict";
import * as engine from "../dist/index.js";
import { MemoryBookStore, createFakeAutopilotAi, outlineEntryFiles, seedBookFiles } from "../dist/testing/index.js";

// New exports are read from the namespace so that, before they exist, each test fails on its own.
const { AutopilotSession, applyIntervention, clipText, createAutopilotState, parseAutopilotState, parseMarkdown, serializeAutopilotState, summarizeAutopilotState } = engine;

const STATE = "autopilot/state.json";
const FAST = { readers: false, readersOnPlan: false, specialists: false, pauseAfterPlan: false };
const TWO = { brief: { idea: "x", targetChapters: 2, scenesPerChapter: 1, wordsPerScene: 300 }, options: FAST };

function reply(json, extra = {}) {
  return { text: JSON.stringify(json), json, usage: { inputTokens: 100, outputTokens: 50, cachedInputTokens: 0 }, model: "fake-model", provider: "fake", cost: 0.001, currency: "USD", ...extra };
}

/** The fake AI with some replies replaced: `script(request, seen)` returns undefined (default reply), an Error or a response. */
function scripted(script, options = {}) {
  const base = createFakeAutopilotAi(options);
  return {
    calls: base.calls,
    async complete(request) {
      const seen = base.calls.filter((call) => call.label === request.label).length;
      const custom = script(request, seen);
      if (custom === undefined) return base.complete(request);
      base.calls.push(request);
      if (custom instanceof Error) throw custom;
      return custom;
    },
  };
}

const isFinal = (request) => request.json?.name === "director_opinion";
const opinion = (fields) => reply({ verdict: "approve", score: 9, summary: "A book that keeps its promises.", strengths: ["Voice"], concerns: [], decisions: [], nextSteps: [], ...fields });
/** Every chapter is approved at once; the director's judgement of the whole book is `fields`, or the next one of `later` for the calls after the first. */
const finalAi = (fields, later = []) => scripted((request, seen) => (isFinal(request) ? opinion(seen === 0 ? fields : later[seen - 1] ?? later.at(-1) ?? fields) : undefined), { reviewVerdict: () => "approve" });

function fakeClock(start = Date.parse("2026-02-01T08:00:00.000Z")) {
  const clock = { t: start, now: () => new Date(clock.t) };
  return clock;
}

async function run(ai, start = TWO, extra = {}) {
  const store = new MemoryBookStore(seedBookFiles({ chapters: 2 }));
  const events = [];
  const session = new AutopilotSession({ bookId: "book", store, ai, host: "server", hostLabel: "test", retryDelayMs: 0, ...extra });
  session.subscribe((event) => events.push(event));
  await session.start(start);
  await session.waitForIdle();
  return { state: (await session.snapshot()).state, events, store, session };
}

const stateOf = (store) => parseAutopilotState(store.files.get(STATE));
const summaries = (events) => events.filter((event) => event.type === "state").map((event) => event.state);

// ─── The verdict is data, not a line of text ────────────────────────────────

test("when the final step is done the director's judgement is saved as data: the verdict, the score, the text and when it was given", async () => {
  const clock = fakeClock();
  const ai = finalAi({ verdict: "approve", score: 9, summary: "A book that keeps its promises." });
  const { state, store, events, session } = await run(ai, TWO, { now: clock.now });
  assert.equal(state.status, "completed", state.lastError?.message);
  assert.equal(state.finalDone, true);
  assert.deepEqual(Object.keys(state.finalReview ?? {}).sort(), ["at", "score", "text", "verdict"]);
  assert.equal(state.finalReview.verdict, "approve");
  assert.equal(state.finalReview.score, 9);
  assert.equal(state.finalReview.text, "A book that keeps its promises.");
  const saved = parseMarkdown(store.files.get("evaluations/director/book.md")).frontmatter;
  assert.equal(state.finalReview.at, saved.created_at, "the moment the director judged, as its opinion file says");
  assert.deepEqual(stateOf(store).finalReview, state.finalReview, "it is in the file, not only in memory");

  const last = summaries(events).at(-1);
  assert.equal(last.status, "completed");
  assert.deepEqual(last.finalReview, state.finalReview, "and in the summary the live events carry");
  assert.deepEqual((await session.snapshot()).summary.finalReview, state.finalReview, "and in the summary of a client that connects later");
});

test("a book the director does not approve is closed all the same, as it always was, and the verdict says revise", async () => {
  for (const verdict of ["revise", "rewrite"]) {
    const ai = finalAi({ verdict, score: 4, summary: "The middle does not work." });
    const { state, events } = await run(ai);
    assert.equal(state.status, "completed", `${verdict}: ${state.lastError?.message}`);
    assert.equal(state.finalDone, true, verdict);
    assert.equal(state.phase, "completed", verdict);
    assert.equal(ai.calls.filter(isFinal).length, 1, `${verdict}: the book is judged once and the run does not go back to work`);
    assert.deepEqual([state.finalReview?.verdict, state.finalReview?.score, state.finalReview?.text], ["revise", 4, "The middle does not work."], `${verdict}: a rewrite is a revise`);
    assert.equal(events.at(-1).type, "run-ended");
    assert.equal(events.at(-1).status, "completed");
    assert.match(events.at(-1).message, /book is complete/i);
  }
  const standard = await run(createFakeAutopilotAi({ reviewVerdict: () => "approve" }));
  assert.equal(standard.state.finalReview?.verdict, "revise", "the fake director's own opinion: revise, 7/10");
  assert.equal(standard.state.finalReview?.score, 7);
});

test("an approval that is withheld because the score is under the approval score is saved as revise, with the score the director gave", async () => {
  const ai = finalAi({ verdict: "approve", score: 5, summary: "Nearly." });
  const { state } = await run(ai);
  assert.equal(state.status, "completed");
  assert.deepEqual([state.finalReview?.verdict, state.finalReview?.score], ["revise", 5]);
});

test("the score is on the scale of the chapters: a percentage is divided by ten, a decimal comma is read, and the text is trimmed", async () => {
  for (const [given, shown] of [[85, 8.5], ["7,5", 7.5], [250, 10], [6, 6]]) {
    const { state } = await run(finalAi({ verdict: "approve", score: given, summary: "  Well made.  " }));
    assert.equal(state.finalReview?.score, shown, String(given));
    assert.equal(state.finalReview?.text, "Well made.", "the same text the director's opinion has");
  }
});

// ─── The text is short ──────────────────────────────────────────────────────

test("the text saved is at most 1200 characters, cut with clipText, and the summary's at most 400", async () => {
  const long = Array.from({ length: 300 }, (_, index) => `Sentence ${index} of a judgement that goes on.`).join(" ");
  assert.ok(long.length > 6000);
  const { state, events, session } = await run(finalAi({ verdict: "approve", score: 8, summary: long }));
  assert.equal(state.finalReview.text.length <= 1200, true);
  assert.equal(state.finalReview.text, clipText(long, 1200));
  const fromEvent = summaries(events).at(-1).finalReview;
  assert.equal(fromEvent.text, clipText(long, 400));
  assert.ok(fromEvent.text.length <= 400);
  assert.deepEqual([fromEvent.verdict, fromEvent.score, fromEvent.at], [state.finalReview.verdict, state.finalReview.score, state.finalReview.at], "the same fields");
  assert.equal((await session.snapshot()).summary.finalReview.text, clipText(long, 400));
  assert.equal(summarizeAutopilotState(state).finalReview.text, clipText(long, 400), "also for a summary made from the file alone");
  assert.equal(state.finalReview.text.length, 1200, "the state keeps more than the summary");
});

test("the summary of a short text is the text, and a book without a final review has no such field in its summary", () => {
  const state = { ...createAutopilotState(new Date(0)), finalDone: true, finalReview: { verdict: "approve", score: 8, text: "Short.", at: "2026-02-01T08:00:00.000Z" } };
  assert.deepEqual(summarizeAutopilotState(state).finalReview, state.finalReview);
  assert.equal("finalReview" in summarizeAutopilotState(createAutopilotState(new Date(0))), false, "absent, not null or undefined");
});

// ─── A book that is not complete any more has no final review ───────────────

test("raising the number of chapters of a finished book takes the final review away until the book is judged again", async () => {
  const ai = finalAi({ verdict: "approve", score: 9, summary: "First judgement." }, [{ verdict: "revise", score: 6, summary: "Second judgement." }]);
  const first = await run(ai, TWO);
  assert.equal(first.state.finalReview.text, "First judgement.");

  const events = [];
  first.session.subscribe((event) => events.push(event));
  for (const [path, content] of Object.entries(outlineEntryFiles(3))) if (!first.store.files.has(path)) first.store.files.set(path, content);
  await first.session.start({ brief: { targetChapters: 3 }, options: { pauseAfterPlan: true } });
  await first.session.waitForIdle();
  const reopened = stateOf(first.store);
  assert.equal(reopened.status, "paused", reopened.lastError?.message);
  assert.equal(reopened.finalDone, false, "the book is not complete any more");
  assert.equal(reopened.finalReview, undefined, "and nobody judged it as it is now");
  assert.equal("finalReview" in reopened, false);
  assert.equal("finalReview" in summaries(events).at(-1), false, "nor does its summary say so");
  assert.equal(first.store.files.get(STATE).includes("finalReview"), false, "the file has nothing of it");

  await first.session.start({ options: { pauseAfterPlan: false } });
  await first.session.waitForIdle();
  const done = stateOf(first.store);
  assert.equal(done.status, "completed", done.lastError?.message);
  assert.deepEqual([done.finalReview?.verdict, done.finalReview?.score, done.finalReview?.text], ["revise", 6, "Second judgement."], "the new judgement of the whole book");
});

test("a rewrite of what is written reopens the book and takes the final review away, and a note or a rule does not", async () => {
  const written = { ...createAutopilotState(new Date(0)), finalDone: true, finalReview: { verdict: "approve", score: 8, text: "Fine.", at: "2026-02-01T08:00:00.000Z" } };
  written.plan = { chapters: [{ number: 1, title: "One", slug: "001-one", summary: "", goal: "", pov: [], keyEvents: [], reveals: [], status: "done", scenes: [{ number: 1, title: "S", goal: "", beats: [], characters: [], status: "reviewed", revisions: 0 }] }], approved: true, rounds: 0, revisionNotes: [], readerReactions: [], readersDone: true, awaitingAuthor: false };
  const at = new Date("2026-02-02T00:00:00.000Z");
  for (const scope of ["next_step", "from_now"]) {
    const next = applyIntervention(written, { scope, text: "Keep the sea cold." }, at, "paused");
    assert.deepEqual(next.finalReview, written.finalReview, scope);
    assert.equal(next.finalDone, true, scope);
  }
  const rewritten = applyIntervention(written, { scope: "rewrite", text: "Make Orrin kinder." }, at, "paused");
  assert.equal(rewritten.finalDone, false);
  assert.equal(rewritten.finalReview, undefined);
  assert.equal("finalReview" in rewritten, false);

  const ai = finalAi({ verdict: "approve", score: 9, summary: "Judged." });
  const { session, store } = await run(ai, { brief: TWO.brief, options: FAST });
  assert.equal(stateOf(store).finalReview.text, "Judged.");
  const events = [];
  session.subscribe((event) => events.push(event));
  await session.intervene({ scope: "rewrite", text: "Make Orrin kinder." });
  assert.equal(stateOf(store).finalReview, undefined, "saved at once, with the intervention");
  assert.equal("finalReview" in summaries(events).at(-1), false);
});

// ─── Older states, odd states, round trips ──────────────────────────────────

test("a state written before the final review existed is read as it was: complete, with no final review, and its summary has none", () => {
  const old = { ...createAutopilotState(new Date(0)), status: "completed", phase: "completed", finalDone: true };
  const parsed = parseAutopilotState(JSON.stringify(old));
  assert.equal(parsed.finalDone, true);
  assert.equal(parsed.finalReview, undefined);
  assert.equal("finalReview" in parsed, false);
  assert.equal("finalReview" in summarizeAutopilotState(parsed), false);
});

test("the final review survives every save of the state, and a value that is not one is dropped, never made up", () => {
  const base = { ...createAutopilotState(new Date(0)), finalDone: true };
  const review = { verdict: "revise", score: 6.5, text: "Not yet.", at: "2026-02-01T08:00:00.000Z" };
  let current = { ...base, finalReview: review };
  for (let pass = 0; pass < 3; pass += 1) current = parseAutopilotState(serializeAutopilotState(current));
  assert.deepEqual(current.finalReview, review);

  const read = (finalReview) => parseAutopilotState(JSON.stringify({ ...base, finalReview })).finalReview;
  assert.equal(read({ verdict: "maybe", score: 7, text: "x", at: "" }), undefined, "an unknown verdict is no verdict");
  assert.equal(read({ verdict: "approve", text: "x" }), undefined, "no score, no structured verdict");
  assert.equal(read({ verdict: "approve", score: "high" }), undefined);
  assert.equal(read("approve"), undefined);
  assert.equal(read(null), undefined);
  assert.equal(read([]), undefined);
  assert.deepEqual(read({ verdict: "Approve", score: 14, text: "x".repeat(2000), at: "2026-02-01T08:00:00.000Z" }), { verdict: "approve", score: 10, text: "x".repeat(1200), at: "2026-02-01T08:00:00.000Z" }, "case is read, the score is limited to 0-10 and the text to 1200 characters");
  assert.deepEqual(read({ verdict: "revise", score: "7.5" }), { verdict: "revise", score: 7.5, text: "", at: "" }, "a number written as text is a number");
  assert.deepEqual(read({ verdict: "revise", score: 7.26 }), { verdict: "revise", score: 7.3, text: "", at: "" }, "one decimal at most, like every score");
});
