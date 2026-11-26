import test from "node:test";
import assert from "node:assert/strict";
import * as engine from "../dist/index.js";
import { MemoryBookStore, seedBookFiles } from "../dist/testing/index.js";
import { FAST, clock, ended, finishedBook, insights, newSession, run, scene, scores, stateOf, stuckAt, votingAi } from "./review-fakes.mjs";

// Review campaigns (`review-target`): the author asks to review the finished book again until it reaches a target score. The chapters under the target are
// reviewed again round after round, in the order of the book, then the director judges the whole book; the review ends on the target, when no chapter is under
// it, or on a plateau (two rounds that raise nothing), waits for the author after the rounds allowed since the run began (a restart allows as many again), and the
// money cap of the book stops it without ever being set back.

const { RevisionCampaignError, parseAutopilotState, summarizeAutopilotState } = engine;

// ─── Asking for a review of the book ────────────────────────────────────────

test("a review is refused for a book that is not finished, a request that is not one, and a book whose chapters all have the target", async () => {
  const ai = votingAi({ chapters: { 1: [["approve", 8]], 2: stuckAt(6) }, books: [6] });
  const empty = newSession(new MemoryBookStore(seedBookFiles({ chapters: 2 })), ai).session;
  await assert.rejects(empty.reviewBook({ targetScore: 8 }), (error) => error instanceof RevisionCampaignError && error.code === "not_finished");

  const store = await finishedBook(ai, 2);
  const { session } = newSession(store, ai);
  for (const input of [{}, { targetScore: 11 }, { targetScore: 0.5 }, { targetScore: 8, maxRounds: 11 }, { targetScore: 8, maxRounds: 1.5 }, { targetScore: 8, readerRounds: -1 }, { targetScore: 8, campaignMaxRounds: 101 }, { targetScore: 8, budgetLimit: -1 }, { targetScore: 8, include: ["2"] }, { targetScore: 8, note: 3 }]) {
    await assert.rejects(session.reviewBook(input), (error) => error instanceof RevisionCampaignError && error.code === "invalid_request", JSON.stringify(input));
  }
  await assert.rejects(session.reviewBook({ targetScore: 6 }), (error) => error instanceof RevisionCampaignError && error.code === "nothing_to_review", "every chapter has 6 or more");
  await assert.rejects(session.reviseChapters({ reason: "review-target", chapters: [{ number: 2, mode: "follow" }] }), (error) => error instanceof RevisionCampaignError && error.code === "invalid_request", "a review is asked with reviewBook");
  assert.equal(stateOf(store).campaign, undefined, "nothing was saved");

  const result = await session.reviewBook({ targetScore: 7.5, maxRounds: 3, readerRounds: 0, campaignMaxRounds: 4, budgetLimit: 2.5, budgetTokens: 900_000, note: "Sharper endings." });
  assert.equal(result.campaign.reason, "review-target");
  assert.deepEqual(result.campaign.chapters.map((item) => [item.number, item.status]), [[2, "waiting"]], "only the chapter under the target");
  assert.deepEqual(
    { ...result.campaign.review, history: undefined },
    { targetScore: 7.5, maxRounds: 3, readerRounds: 0, scope: [1, 2], round: 1, windowStart: 1, phase: "chapters", start: { lowest: 6, book: 6, below: 1 }, history: undefined, stalled: 0 },
  );
  assert.equal(result.campaign.note, "Sharper endings.");
  const state = stateOf(store);
  assert.deepEqual([state.options.budgetLimit, state.options.budgetTokens, state.options.review], [2.5, 900_000, { campaignMaxRounds: 4 }], "the caps are the options' own fields");
  await assert.rejects(session.reviewBook({ targetScore: 9 }), (error) => error instanceof RevisionCampaignError && error.code === "campaign_active");
  const summary = summarizeAutopilotState(state).campaign;
  assert.deepEqual(summary.review, { round: 1, roundsThisRun: 1, maxRounds: 4, targetScore: 7.5, phase: "chapters", lowest: 6, book: 6, budgetLimit: 2.5 });
});

// ─── The stop rules ─────────────────────────────────────────────────────────

test("the target reached: the chapters under it are reviewed again in the order of the book, the book is judged again, and the review ends with its record", async () => {
  // Chapter 2 and 3 closed at 6, chapter 1 at 8; the book at 6. The review to 7.5 reviews 2 and 3 (1 is left as it is), they reach 8, the book 8.
  const ai = votingAi({ chapters: { 1: [["approve", 8]], 2: [...stuckAt(6), ["revise", 7], ["approve", 8]], 3: [...stuckAt(6), ["approve", 8]] }, books: [6, 8] });
  const store = await finishedBook(ai, 3);
  const untouched = store.files.get(scene(1));
  const { session } = newSession(store, ai);
  await session.reviewBook({ targetScore: 7.5 });
  const mark = ai.calls.length;
  const { events, state } = await run(store, ai);
  assert.equal(state.status, "completed", state.lastError?.message);
  const labels = ai.calls.slice(mark).map((call) => call.label);
  assert.ok(labels.indexOf("autopilot:director-review:2") < labels.indexOf("autopilot:director-review:3"), "chapter 2, then chapter 3");
  assert.ok(labels.lastIndexOf("autopilot:director-review:3") < labels.indexOf("director:book"), "then the book");
  assert.ok(!labels.some((label) => /:1$|:1\.\d+$/.test(label)), `chapter 1 is not touched: ${labels.join(", ")}`);
  assert.equal(store.files.get(scene(1)), untouched);
  assert.ok(ai.decided.filter((entry) => entry.chapter === 2).slice(2).every((entry) => /at least 7\.5\/10/.test(entry.user)), "the chapters are judged at the target");
  assert.deepEqual(scores(state), [8, 8, 8]);
  assert.equal(state.finalReview.score, 8);
  assert.equal(state.finalDone, true);
  assert.equal(state.campaign, undefined, "over, and gone");
  assert.equal(state.reviews.length, 1);
  assert.deepEqual({ ...state.reviews[0], startedAt: undefined, endedAt: undefined }, { targetScore: 7.5, rounds: 1, outcome: "target", from: { lowest: 6, book: 6, below: 2 }, to: { lowest: 8, book: 8, below: 0 }, startedAt: undefined, endedAt: undefined });
  assert.deepEqual(insights(events, "reviewChapterDone").map((event) => [event.chapterNumber, event.figures.score, event.figures.target, event.figures.round]), [[2, 8, 7.5, 1], [3, 8, 7.5, 1]]);
  assert.deepEqual(insights(events, "reviewRoundDone").map((event) => event.figures), [{ round: 1, target: 7.5, lowest: 8, book: 8, below: 0 }]);
  const done = insights(events, "reviewDone");
  assert.equal(done.length, 1);
  assert.deepEqual([done[0].figures.outcome, done[0].figures.rounds, done[0].figures.book], ["target", 1, 8]);
  assert.match(done[0].title, /reached the target: 8\/10/);
  assert.equal(engine.frozenChanges(await engine.loadBookSnapshot(store)).length, 0, "every chapter it reviewed is frozen again");
});

test("every chapter at the target but not the book: the review ends there, and says so", async () => {
  const ai = votingAi({ chapters: { 1: [["approve", 8]], 2: [...stuckAt(6), ["approve", 8]] }, books: [6, 6.5] });
  const store = await finishedBook(ai, 2);
  await newSession(store, ai).session.reviewBook({ targetScore: 7.5 });
  const { events, state } = await run(store, ai);
  assert.equal(state.status, "completed", state.lastError?.message);
  assert.deepEqual([state.reviews[0].outcome, state.reviews[0].rounds, state.reviews[0].to.book], ["chapters", 1, 6.5]);
  const stopped = insights(events, "reviewStopped");
  assert.deepEqual([stopped.length, stopped[0].figures.outcome], [1, "chapters"]);
  assert.match(stopped[0].title, /book as a whole got 6\.5\/10/);
});

test("a plateau: two rounds in a row that raise neither the lowest chapter nor the book stop the review, so that it does not spend for nothing", async () => {
  const ai = votingAi({ chapters: { 1: [["approve", 8]], 2: stuckAt(6) }, books: [6] });
  const store = await finishedBook(ai, 2);
  await newSession(store, ai).session.reviewBook({ targetScore: 9 });
  const mark = ai.calls.length;
  const { events, state } = await run(store, ai);
  assert.equal(state.status, "completed", state.lastError?.message);
  assert.equal(ai.calls.slice(mark).filter((call) => call.label === "director:book").length, 2, "two rounds, each judged");
  assert.deepEqual(insights(events, "reviewRoundDone").map((event) => [event.figures.round, event.figures.lowest, event.figures.book]), [[1, 6, 6], [2, 6, 6]]);
  assert.deepEqual([state.reviews[0].outcome, state.reviews[0].rounds], ["plateau", 2]);
  const stopped = insights(events, "reviewStopped");
  assert.deepEqual([stopped.length, stopped[0].tone, stopped[0].figures.outcome], [1, "warning", "plateau"]);
  assert.equal(state.campaign, undefined);
});

test("a round that raises something sets the plateau back: it needs two rounds in a row that raise nothing", async () => {
  // Round 1 raises chapter 2 from 6 to 6.5; round 2 raises nothing; round 3 raises the book; rounds 4 and 5 raise nothing: a plateau after five rounds.
  const ai = votingAi({ chapters: { 1: [["approve", 9]], 2: [...stuckAt(6), ...stuckAt(6.5), ...stuckAt(6.5), ...stuckAt(6.5), ...stuckAt(6.5), ...stuckAt(6.5)] }, books: [6, 6, 6, 7, 7, 7] });
  const store = await finishedBook(ai, 2);
  await newSession(store, ai).session.reviewBook({ targetScore: 9 });
  const { events, state } = await run(store, ai);
  assert.deepEqual(insights(events, "reviewRoundDone").map((event) => [event.figures.lowest, event.figures.book]), [[6.5, 6], [6.5, 6], [6.5, 7], [6.5, 7], [6.5, 7]]);
  assert.deepEqual([state.reviews[0].outcome, state.reviews[0].rounds], ["plateau", 5]);
});

test("the rounds cap: after the rounds allowed the review waits for the author, and a restart allows as many again", async () => {
  // Target 9: round 1 raises both chapters (no plateau) but leaves them under it; the cap of one round holds the review; the restart does round 2, which reaches it.
  const ai = votingAi({ chapters: { 1: [["approve", 8], ["revise", 8.5], ["revise", 8.6], ["approve", 9]], 2: [...stuckAt(6), ["revise", 7], ["revise", 7.5], ["revise", 8.5], ["approve", 9.5]] }, books: [6, 7, 9] });
  const store = await finishedBook(ai, 2);
  await newSession(store, ai).session.reviewBook({ targetScore: 9, campaignMaxRounds: 1 });
  let { events, state } = await run(store, ai);
  assert.equal(state.status, "paused");
  assert.equal(ended(events).code, "reviewHeld");
  assert.match(state.message, /1 round of the review done, as many as you allowed/);
  assert.deepEqual(state.limitReached && { ...state.limitReached, at: undefined }, { kind: "review-rounds", used: 1, limit: 1, at: undefined });
  assert.deepEqual([state.campaign.review.round, state.campaign.review.history.length, Boolean(state.campaign.held)], [2, 1, true]);
  assert.deepEqual(state.campaign.chapters.map((item) => [item.number, item.status]), [[1, "waiting"], [2, "waiting"]], "the next round's chapters wait");
  assert.deepEqual(insights(events, "reviewHeld").map((event) => [event.figures.rounds, event.figures.limit]), [[1, 1]]);
  const summary = summarizeAutopilotState(state);
  assert.deepEqual([summary.campaign.held, summary.campaign.review.roundsThisRun, summary.campaign.review.maxRounds, summary.limitReached.kind], [true, 1, 1, "review-rounds"]);

  // Held, nothing goes on by itself: the same state, the same calls, until the author starts it again.
  const mark = ai.calls.length;
  ({ events, state } = await run(store, ai));
  assert.equal(state.status, "completed", state.lastError?.message);
  assert.ok(ai.calls.length > mark, "the restart reviewed the chapters again");
  assert.equal(state.limitReached, undefined, "the limit went with the start");
  assert.deepEqual([state.reviews[0].outcome, state.reviews[0].rounds], ["target", 2]);
  assert.deepEqual(scores(state), [9, 9.5]);
});

test("the money cap is the book's cumulative cost: the review stops at it, a restart does not set it back (it stops again before any call), and raising it lets the review go on", async () => {
  const ai = votingAi({ chapters: { 1: [["approve", 8]], 2: [...stuckAt(6), ["revise", 7], ["approve", 8]] }, books: [6, 8] });
  const store = await finishedBook(ai, 2);
  const spent = stateOf(store).stats.cost;
  assert.ok(spent > 0.01, "the book cost something already");
  // A cap a few calls over what the book cost: the review spends those and stops.
  await newSession(store, ai).session.reviewBook({ targetScore: 7.5, budgetLimit: Math.round((spent + 0.0035) * 10_000) / 10_000 });
  let { events, state } = await run(store, ai);
  assert.equal(state.status, "paused");
  assert.equal(ended(events).code, "budgetReached");
  assert.equal(state.limitReached.kind, "money");
  assert.equal(state.limitReached.currency, "USD");
  assert.equal(state.limitReached.limit, state.options.budgetLimit);
  assert.ok(state.limitReached.used >= state.limitReached.limit && state.limitReached.used > spent, JSON.stringify(state.limitReached));
  assert.deepEqual(insights(events, "budgetReached").map((event) => [event.figures.limit, event.figures.currency]), [[state.options.budgetLimit, "USD"]]);
  assert.equal(state.campaign.reason, "review-target", "the review waits, not lost");
  assert.equal(summarizeAutopilotState(state).limitReached.kind, "money");

  // A restart does not set the money cap back: the run stops again before it calls anything.
  const calls = ai.calls.length;
  const cost = state.stats.cost;
  ({ events, state } = await run(store, ai));
  assert.equal(state.status, "paused");
  assert.equal(ended(events).code, "budgetReached");
  assert.equal(ai.calls.length, calls, "not one more call");
  assert.equal(state.stats.cost, cost);
  assert.equal(state.limitReached.kind, "money");

  // Raised (to none): the review goes on to its end.
  ({ events, state } = await run(store, ai, { options: { budgetLimit: 0 } }));
  assert.equal(state.status, "completed", state.lastError?.message);
  assert.equal(state.limitReached, undefined);
  assert.equal(state.reviews[0].outcome, "target");
});

test("the token cap stops the review the same way, with its numbers", async () => {
  const ai = votingAi({ chapters: { 1: [["approve", 8]], 2: [...stuckAt(6), ["approve", 8]] }, books: [6, 8] });
  const store = await finishedBook(ai, 2);
  const used = stateOf(store).stats.inputTokens + stateOf(store).stats.outputTokens;
  await newSession(store, ai).session.reviewBook({ targetScore: 7.5, budgetTokens: used + 300 });
  const { events, state } = await run(store, ai);
  assert.equal(state.status, "paused");
  assert.equal(ended(events).code, "tokenBudgetReached");
  assert.deepEqual([state.limitReached.kind, state.limitReached.limit], ["tokens", used + 300]);
  assert.ok(state.limitReached.used >= used + 300);
  assert.equal(state.limitReached.currency, undefined);
});

// ─── The author's chapters ──────────────────────────────────────────────────

test("the author's chapters keep their rules: one the author froze is reviewed only when included, one changed since it was frozen never, and one frozen during the review is left out", async () => {
  const ai = votingAi({ chapters: { 1: [...stuckAt(6), ["approve", 8]], 2: [...stuckAt(6), ["approve", 8]], 3: [...stuckAt(6), ["approve", 8]], 4: [...stuckAt(6), ["approve", 8]] }, books: [6, 8] });
  const store = await finishedBook(ai, 4);
  const { session } = newSession(store, ai);
  // Chapter 3 frozen by the author by hand; chapter 4 changed by the author after the autopilot froze it.
  await session.freezeChapter("003-chapter-title-3");
  store.files.set(scene(4), store.files.get(scene(4)).replace(/\n\n([^\n]+)/, "\n\nThe author's own sentence. $1"));

  let result = await session.reviewBook({ targetScore: 7.5 });
  assert.deepEqual(result.campaign.review.scope, [1, 2], "the author's chapters are not the review's");
  assert.deepEqual(result.campaign.chapters.map((item) => item.number), [1, 2]);
  await session.cancelRevisionCampaign();

  result = await session.reviewBook({ targetScore: 7.5, include: [3, 4] });
  assert.deepEqual(result.campaign.review.scope, [1, 2, 3], "included, the author's frozen chapter is reviewed; the changed one waits for the decision about its change");
  // Before the run, the author freezes chapter 2 too: the review leaves it out when its turn comes.
  await session.freezeChapter("002-chapter-title-2");
  const authorsTwo = store.files.get(scene(2));
  const authorsFour = store.files.get(scene(4));
  const { events, state } = await run(store, ai);
  assert.equal(state.status, "completed", state.lastError?.message);
  assert.deepEqual(insights(events, "reviewChapterDone").map((event) => event.chapterNumber), [1, 3]);
  const skipped = insights(events, "reviewChapterSkipped");
  assert.deepEqual(skipped.map((event) => event.chapterNumber), [2]);
  assert.match(skipped[0].title, /is yours now/);
  assert.equal(store.files.get(scene(2)), authorsTwo, "the chapter the author froze is as the author left it");
  assert.equal(store.files.get(scene(4)), authorsFour, "the author's change is the author's");
  assert.deepEqual(state.reviews.map((record) => record.outcome), ["cancelled", "target"], "the review cancelled before, and this one");
  assert.deepEqual([state.reviews[1].to.below, state.reviews[1].to.lowest], [0, 8]);
  const snapshot = await engine.loadBookSnapshot(store);
  assert.equal(snapshot.chapters.find((chapter) => chapter.number === 3).frozen.by, "author", "reviewed at the author's request, still frozen by the author");
  assert.deepEqual(engine.frozenChanges(snapshot).map((change) => change.number), [4], "the author's change still waits for its decision");
});

test("which chapters are the author's: frozen by the author, or written before the autopilot and not frozen by it (a plan made again counts every written chapter as imported)", () => {
  const { authorChapters, createReviewCampaign } = engine;
  const chapter = (number, extra = {}) => ({ number, slug: `00${number}-c`, title: `C${number}`, summary: "", goal: "", keyEvents: [], reveals: [], status: "done", scenes: [], score: 6, ...extra });
  const state = {
    plan: { approved: true, chapters: [chapter(1, { imported: true }), chapter(2, { imported: true }), chapter(3), chapter(4)] },
    finalDone: true,
    finalReview: { verdict: "revise", score: 6, text: "", at: "" },
    options: {},
  };
  // Frozen as they are: nothing changed since (no scene, the body as it was).
  const frozen = (by) => ({ at: "2026-01-01T00:00:00.000Z", by, digest: "d", files: {} });
  const snapshot = { chapters: [{ slug: "001-c", number: 1 }, { slug: "002-c", number: 2, frozen: frozen("autopilot") }, { slug: "003-c", number: 3, frozen: frozen("author") }, { slug: "004-c", number: 4, frozen: frozen("autopilot") }].map((entry) => ({ ...entry, paragraphs: [] })) };
  assert.deepEqual([...authorChapters(state, snapshot)].sort(), [1, 3]);
  const campaign = createReviewCampaign({ targetScore: 7 }, state, snapshot, clock(), "review-1");
  assert.deepEqual(campaign.review.scope, [2, 4]);
  const included = createReviewCampaign({ targetScore: 7, include: [1, 3] }, state, snapshot, clock(), "review-2");
  assert.deepEqual(included.review.scope, [1, 2, 3, 4]);
  assert.deepEqual(included.chapters.map((item) => item.number), [1, 2, 3, 4], "a chapter nobody voted counts as under the target");
});

// ─── Restarts, cancels, the readers ─────────────────────────────────────────

test("a review survives a restart: the process stops after its first chapter, another session goes on with the next, and nothing is reviewed twice", async () => {
  const ai = votingAi({ chapters: { 1: [...stuckAt(6), ["approve", 8]], 2: [...stuckAt(6), ["approve", 8]] }, books: [6, 8] });
  const store = await finishedBook(ai, 2);
  await newSession(store, ai).session.reviewBook({ targetScore: 7.5 });
  let { state } = await run(store, ai, { options: { pauseAfterEachChapter: true } });
  assert.equal(state.status, "paused");
  // Chapter 1 is closed; the campaign learns it at the next step, which a restart makes.
  assert.equal(state.plan.chapters[0].status, "done");
  assert.deepEqual(state.campaign.chapters.map((item) => [item.number, item.status]), [[1, "working"], [2, "waiting"]]);
  assert.equal(parseAutopilotState(JSON.stringify(state)).campaign.review.round, 1, "what is saved reads back the same");
  const reviewsOfOne = ai.decided.filter((entry) => entry.chapter === 1).length;
  ({ state } = await run(store, ai, { options: { pauseAfterEachChapter: false } }));
  assert.equal(state.status, "completed", state.lastError?.message);
  assert.equal(ai.decided.filter((entry) => entry.chapter === 1).length, reviewsOfOne, "chapter 1 was not reviewed again");
  assert.deepEqual([state.reviews[0].outcome, state.reviews[0].rounds], ["target", 1]);
});

test("cancelled by the author: what waits is dropped, the chapter being worked finishes, and the review is remembered as cancelled; a held review goes with its limit", async () => {
  const ai = votingAi({ chapters: { 1: [...stuckAt(6), ["revise", 6.5], ["revise", 7]], 2: [...stuckAt(6), ["revise", 6.5], ["revise", 7]] }, books: [6, 6.5] });
  const store = await finishedBook(ai, 2);
  const { session } = newSession(store, ai);
  await session.reviewBook({ targetScore: 9, campaignMaxRounds: 1 });
  let { state } = await run(store, ai);
  assert.equal(state.limitReached.kind, "review-rounds");
  const result = await session.cancelRevisionCampaign();
  assert.equal(result.campaign, null);
  state = stateOf(store);
  assert.equal(state.limitReached, undefined, "the limit of the review went with it");
  assert.deepEqual([state.reviews[0].outcome, state.reviews[0].rounds], ["cancelled", 1]);
  ({ state } = await run(store, ai));
  assert.equal(state.status, "completed", "the book is finished again");
});

test("the readers read again in the rounds of a review the author asks for, and not at all when the review says 0", async () => {
  const twoReads = votingAi({ chapters: { 1: [["approve", 8]], 2: [...stuckAt(6), ["revise", 7], ["approve", 8]] }, books: [6, 8] });
  const store = await finishedBook(twoReads, 2, { ...FAST, readers: true, maxReaders: 2 });
  const readersOf = (ai, mark) => ai.calls.slice(mark).filter((call) => call.label.startsWith("reader-evaluation:") && call.json?.name === "reader_evaluation").length;
  await newSession(store, twoReads).session.reviewBook({ targetScore: 7.5, readerRounds: 2 });
  let mark = twoReads.calls.length;
  let { state } = await run(store, twoReads);
  assert.equal(state.status, "completed", state.lastError?.message);
  assert.equal(readersOf(twoReads, mark), 4, "two readers, in the two rounds of chapter 2");
  assert.deepEqual(state.plan.chapters[1].rounds.slice(-2).map((round) => "readers" in round), [true, true]);

  const noReads = votingAi({ chapters: { 1: [["approve", 8]], 2: [...stuckAt(6), ["revise", 7], ["approve", 8]] }, books: [6, 8] });
  const other = await finishedBook(noReads, 2, { ...FAST, readers: true, maxReaders: 2 });
  await newSession(other, noReads).session.reviewBook({ targetScore: 7.5, readerRounds: 0 });
  mark = noReads.calls.length;
  ({ state } = await run(other, noReads));
  assert.equal(readersOf(noReads, mark), 0);
});

// ─── What is saved ──────────────────────────────────────────────────────────

test("a state with a review in progress, a held review, its limit and the reviews over reads back as it was, and an odd one is none", () => {
  const review = { targetScore: 8.5, maxRounds: 3, readerRounds: 0, include: [4], scope: [1, 2, 4], round: 2, windowStart: 2, phase: "verdict", start: { lowest: 6, book: 6.5, below: 2 }, history: [{ round: 1, chapters: [1, 2], lowest: 7, book: 7, below: 1, endedAt: "2026-01-01T00:00:00.000Z" }], stalled: 0 };
  const campaign = { id: "review_1", reason: "review-target", createdAt: "2026-01-01T00:00:00.000Z", chapters: [{ number: 2, mode: "follow", status: "waiting" }], held: { at: "2026-01-01T00:00:00.000Z", message: "Held." }, review };
  const limitReached = { kind: "money", used: 2.51, limit: 2.5, currency: "USD", at: "2026-01-01T00:00:00.000Z" };
  const reviews = [{ targetScore: 8, rounds: 3, outcome: "plateau", from: { lowest: 5, book: 6, below: 3 }, to: { lowest: 6.5, book: 7, below: 1 }, startedAt: "2026-01-01T00:00:00.000Z", endedAt: "2026-01-02T00:00:00.000Z" }];
  const read = parseAutopilotState(JSON.stringify({ ...engine.createAutopilotState(clock()), campaign, limitReached, reviews }));
  assert.deepEqual([read.campaign, read.limitReached, read.reviews], [campaign, limitReached, reviews]);
  assert.equal(parseAutopilotState(JSON.stringify({ campaign: { ...campaign, review: undefined } })).campaign, undefined, "a review without its review is none");
  assert.equal(parseAutopilotState(JSON.stringify({ campaign: { ...campaign, review: { ...review, targetScore: "high" } } })).campaign, undefined);
  assert.equal(parseAutopilotState(JSON.stringify({ limitReached: { kind: "time", used: 1, limit: 1, at: "2026-01-01T00:00:00.000Z" } })).limitReached, undefined);
  assert.equal(parseAutopilotState(JSON.stringify({ reviews: [{ outcome: "target" }] })).reviews, undefined);
  assert.equal(parseAutopilotState(JSON.stringify({ campaign: { ...campaign, review: { ...review, windowStart: 9 } } })).campaign.review.windowStart, 2, "the window never starts after the round in progress");
});
