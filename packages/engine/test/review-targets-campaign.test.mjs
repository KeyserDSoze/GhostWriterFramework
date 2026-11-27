import test from "node:test";
import assert from "node:assert/strict";
import * as engine from "../dist/index.js";
import { FAST, finishedBook, insights, newSession, run, stateOf, stuckAt } from "./review-fakes.mjs";
import { readingAi, stepsAfter } from "./review-targets-fakes.mjs";

// A review of the finished book with targets for the readers: the chapters under a target are taken up, a chapter that only needs to know its readers' vote is read by them
// alone (and reviewed whole only if a target is missed), the rounds go on while the targets get closer, and the stop says which target was missed.

const { summarizeAutopilotState } = engine;

const GENERAL = "standard-general";
const EMOTIONAL = "standard-emotional";
const READERS = { ...FAST, readers: true, maxReaders: 2 };
const reviewSteps = (ai, mark = 0) => stepsAfter(ai, mark).filter((step) => !/scene-summary|autopilot:(concept|plan|scenes|write|plan-review)/.test(step) && !step.startsWith("autopilot:plan"));
const tail = (chapter, count = 3) => chapter.rounds.slice(-count);

/** A finished book (`options` say how it was written), then reviewed again with `review`: the session, what its review took up, and the run after it. */
async function reviewed({ votes, chapters, books = [8], review, count = 3, options = READERS, prepare }) {
  const ai = readingAi({ chapters, books, votes });
  const store = await finishedBook(ai, count, options);
  const { session } = newSession(store, ai);
  if (prepare) await prepare(session);
  const mark = ai.calls.length;
  const asked = await session.reviewBook(review);
  const { state, events } = await run(store, ai);
  assert.equal(state.status, "completed", state.lastError?.message);
  return { ai, store, mark, asked, state, events, steps: reviewSteps(ai, mark) };
}

test("a chapter the director is content with is taken up for its readers' vote only, and read by them alone: no director, no closing of the text", async () => {
  // The three chapters closed at 8 with the readers' first vote at 7, which is under the 7.5 asked now: each is read again, and they give 8.
  const { asked, state, steps, events, ai, mark } = await reviewed({
    votes: { [GENERAL]: [7, 7, 7, 8], [EMOTIONAL]: [7, 7, 7, 8] },
    chapters: { 1: [["approve", 8]], 2: [["approve", 8]], 3: [["approve", 8]] },
    review: { targetScore: 7.5, readersTarget: 7.5 },
  });
  assert.deepEqual(asked.campaign.chapters.map((item) => item.number), [1, 2, 3], "all three are under the readers' target");
  assert.deepEqual(asked.campaign.review.start, { lowest: 8, book: 8, below: 3, readers: 7 }, "the lowest average of the readers is among the votes it began with");
  assert.deepEqual(steps, ["reader", "reader", "summary", "reader", "reader", "summary", "reader", "reader", "summary", "director:book"], "the readers, and the book judged: nothing else");
  assert.equal(ai.decided.length, 3, "the director was not asked again (3 reviews of the book that was written)");
  assert.ok(!ai.calls.slice(mark).some((call) => /consolidate|director-review|specialists|repair/.test(call.label)));
  for (const chapter of state.plan.chapters) {
    assert.deepEqual([chapter.status, chapter.score], ["done", 8], "as it was");
    assert.deepEqual(tail(chapter, 2), [{ director: 8, readers: 7, verdict: "approve", accepted: 0, rejected: 3 }, { readers: 8, readerVotes: { [GENERAL]: 8, [EMOTIONAL]: 8 }, round: 1, reading: "check" }], "the first vote stays, and the new one is a round of its own that says what it is");
  }
  assert.deepEqual(insights(events, "reviewChapterDone").map((event) => event.chapterNumber), [1, 2, 3]);
  const done = insights(events, "reviewDone");
  assert.match(done[0].title, /every chapter at 7\.5\/10 or more and with the readers at their targets \(1 round\)/);
  assert.deepEqual({ ...state.reviews[0], startedAt: undefined, endedAt: undefined }, { targetScore: 7.5, rounds: 1, outcome: "target", from: { lowest: 8, book: 8, below: 3, readers: 7 }, to: { lowest: 8, book: 8, below: 0, readers: 8 }, startedAt: undefined, endedAt: undefined });
  const summary = summarizeAutopilotState({ ...state, campaign: asked.campaign }).campaign.review;
  assert.deepEqual([summary.readers, summary.readersTarget], [7, 7.5], "the summary of the review says the readers' vote and its target");
  const titles = events.filter((event) => event.type === "task-started" && event.activity.task === "reader").map((event) => event.activity.title);
  assert.equal(titles.length, 6);
  assert.ok(titles.every((title) => /^(General|Emotional) Reader reads chapter \d+ «.*» again$/.test(title)), `said as a reading again: ${titles.join(" | ")}`);
});

test("only the chapters under a target are taken up: a chapter the readers are content with is left as it is", async () => {
  const { asked, state, steps } = await reviewed({
    votes: { [GENERAL]: [8, 7, 8], [EMOTIONAL]: [8, 7, 8] },
    chapters: { 1: [["approve", 8]], 2: [["approve", 8]] },
    review: { targetScore: 7.5, readersTarget: 7.5 },
    count: 2,
  });
  assert.deepEqual(asked.campaign.chapters.map((item) => item.number), [2]);
  assert.deepEqual(steps, ["reader", "reader", "summary", "director:book"]);
  assert.equal(state.plan.chapters[0].rounds.length, 1, "chapter 1 was not read again");
});

test("a check that finds a target missed becomes a review of the chapter, with the readers' corrections for the director, and a closing reading", async () => {
  const { ai, mark, state, steps, events } = await reviewed({
    votes: { [GENERAL]: [7, 7, 7, 6, 8], [EMOTIONAL]: [7, 7, 7, 6, 8] },
    chapters: { 1: [["approve", 8], ["approve", 8.5, true]], 2: [["approve", 8]], 3: [["approve", 8]] },
    review: { targetScore: 7.5, readersTarget: 7.5 },
  });
  assert.deepEqual(steps, [
    "reader", "reader", "summary", "autopilot:specialists", "autopilot:director-review", "autopilot:repair", "reader", "reader", "summary", "autopilot:consolidate",
    "reader", "reader", "summary", "reader", "reader", "summary", "director:book",
  ], "chapter 1: read, reviewed, corrected, read again, closed; the others only read");
  const [first] = state.plan.chapters;
  assert.deepEqual(first.rounds.slice(-3).map((round) => [round.director, round.readers, round.round, round.reading]), [[undefined, 6, 1, "check"], [8.5, undefined, undefined, undefined], [undefined, 8, 1, "end"]], "the vote that missed, the round of the director, the vote of the text as it is");
  assert.equal(first.score, 8.5);
  const decided = ai.decided.filter((entry) => entry.chapter === 1).at(-1);
  assert.equal(decided.round, 1, "the first round of the director in this review");
  assert.match(decided.user, /the average of the readers that count: 6\/10 now, target 7\.5\/10/);
  assert.match(decided.user, /\[R1-1\] reader/, "the readers' corrections are among what it decides");
  assert.ok(ai.calls.slice(mark).filter((call) => call.label === "autopilot:director-review:1").length === 1, "one round was enough");
  assert.equal(insights(events, "reviewDone").length, 1);
});

test("with `readerRounds: 0` the readers do not read at the start of a review, and still read at its end, and a chapter only checked is read all the same", async () => {
  const { steps, state } = await reviewed({
    votes: { [GENERAL]: [7, 7, 8], [EMOTIONAL]: [7, 7, 8] },
    chapters: { 1: [["approve", 8]], 2: [...stuckAt(6), ["approve", 8, true]] },
    review: { targetScore: 7.5, readersTarget: 7.5, readerRounds: 0 },
    count: 2,
  });
  assert.deepEqual(steps, [
    "reader", "reader", "summary", // chapter 1: the director is content, so it is only read
    "autopilot:specialists", "autopilot:director-review", "autopilot:repair", "reader", "reader", "summary", "autopilot:consolidate", // chapter 2: no reading before the director, one after
    "director:book",
  ]);
  assert.deepEqual(tail(state.plan.chapters[1], 2).map((round) => [round.director, round.readers, round.round, round.reading]), [[8, undefined, undefined, undefined], [undefined, 8, 1, "end"]]);
});

test("a book written without the readers is read by them when they are turned on and the review has a target for them", async () => {
  const { asked, state, steps } = await reviewed({
    votes: { [GENERAL]: [8], [EMOTIONAL]: [8] },
    chapters: { 1: [["approve", 8]], 2: [["approve", 8]] },
    review: { targetScore: 7.5, readersTarget: 7.5 },
    count: 2,
    options: { ...FAST, readers: false },
    prepare: (session) => session.updateOptions({ readers: true, maxReaders: 2 }),
  });
  assert.deepEqual(asked.campaign.review.start, { lowest: 8, book: 8, below: 2, readers: null }, "no chapter has a vote of the readers yet: they have to be asked");
  assert.deepEqual(steps, ["reader", "reader", "summary", "reader", "reader", "summary", "director:book"]);
  assert.deepEqual(state.plan.chapters.map((chapter) => chapter.rounds.at(-1).reading), ["check", "check"]);
});

test("a plateau stops the review of the book, and says which target the chapters kept missing", async () => {
  // The readers never go above 5 (7.5 asked), and a chapter has one round (the cap): two rounds in a row raise nothing.
  const { state, events, steps } = await reviewed({
    votes: { [GENERAL]: [5], [EMOTIONAL]: [5] },
    chapters: { 1: [["approve", 8, false], ["approve", 8, true]] },
    review: { targetScore: 7.5, readersTarget: 7.5, maxRounds: 1 },
    count: 1,
  });
  assert.equal(steps.filter((step) => step === "director:book").length, 2, "two rounds");
  assert.deepEqual([state.reviews[0].outcome, state.reviews[0].rounds], ["plateau", 2]);
  const missed = insights(events, "readersTargetMissed");
  assert.equal(missed.length, 2, "each round says why the chapter was closed under the readers' target");
  const stopped = insights(events, "reviewStopped");
  assert.equal(stopped.length, 1);
  assert.match(stopped[0].title, /two rounds in a row raised neither the lowest chapter \(8\/10\) nor the book \(8\/10\) nor the readers \(5\/10\)/);
  assert.match(stopped[0].detail, /^The readers' average is under 7\.5\/10 in 1 chapter \(the lowest: 5\/10\)\./);
  assert.deepEqual(stopped[0].figures.readersTarget, 7.5);
  assert.deepEqual([state.reviews[0].from.readers, state.reviews[0].to.readers], [5, 5]);
});

test("a round that brings the readers closer is not a plateau", async () => {
  // The readers go from 5 to 6, to 7, to 8 (7.5 asked) while the director's votes and the book's stay where they are: each round raises their lowest average, so the
  // review goes on to a third round, which reaches it.
  const { state, events } = await reviewed({
    votes: { [GENERAL]: [5, 5, 6, 6, 7, 7, 8], [EMOTIONAL]: [5, 5, 6, 6, 7, 7, 8] },
    chapters: { 1: [["approve", 8, false], ["approve", 8, true]] },
    review: { targetScore: 7.5, readersTarget: 7.5, maxRounds: 1 },
    count: 1,
  });
  assert.deepEqual([state.reviews[0].outcome, state.reviews[0].rounds], ["target", 3]);
  assert.deepEqual(insights(events, "reviewRoundDone").map((event) => event.figures.readers), [6, 7, 8]);
  assert.equal(state.plan.chapters[0].rounds.at(-1).readers, 8);
});

test("a round that leaves fewer chapters under a target is not a plateau either, though the lowest average did not rise", async () => {
  // Two chapters at 5. Round 1 brings chapter 1 to 8 and leaves chapter 2 at 5: the lowest average is the same, but one chapter less is under the target. Rounds 2 and 3
  // change nothing: the plateau is the third round, not the second.
  const { state, events } = await reviewed({
    votes: { [GENERAL]: [5, 5, 5, 8, 5, 5, 5, 5, 5, 5], [EMOTIONAL]: [5, 5, 5, 8, 5, 5, 5, 5, 5, 5] },
    chapters: { 1: [["approve", 8, false], ["approve", 8, true]], 2: [["approve", 8, false], ["approve", 8, true]] },
    review: { targetScore: 7.5, readersTarget: 7.5, maxRounds: 1 },
    count: 2,
  });
  assert.deepEqual([state.reviews[0].outcome, state.reviews[0].rounds], ["plateau", 3]);
  assert.deepEqual(insights(events, "reviewRoundDone").map((event) => [event.figures.below, event.figures.readers]), [[1, 5], [1, 5], [1, 5]]);
  assert.deepEqual(state.plan.chapters.map((chapter) => chapter.rounds.at(-1).readers), [8, 5]);
});

test("the review of the book's own targets win over the run's, field by field", async () => {
  const ai = readingAi({ chapters: { 1: [["approve", 8]], 2: [["approve", 8]] }, books: [8], votes: { [GENERAL]: [7], [EMOTIONAL]: [7] } });
  const store = await finishedBook(ai, 2, READERS);
  const { session } = newSession(store, ai);
  // The run asks 9 of the readers' average, which the chapters (7) do not reach; the review asks 6, which they do: its own is the one that counts.
  await session.updateOptions({ review: { readersTarget: 9 } });
  await assert.rejects(session.reviewBook({ targetScore: 7.5, readersTarget: 6 }), (error) => error.code === "nothing_to_review" && /readers' targets are met/.test(error.message));
  // A review that does not say the average keeps the run's, and brings its own target for a reader.
  const asked = await session.reviewBook({ targetScore: 7.5, readerTargets: { [EMOTIONAL]: 8 } });
  assert.deepEqual(asked.campaign.chapters.map((item) => item.number), [1, 2]);
  assert.deepEqual([asked.campaign.review.readersTarget, asked.campaign.review.readerTargets], [undefined, { [EMOTIONAL]: 8 }], "what it does not say is not copied: the run's policy answers for it");
  assert.equal(stateOf(store).options.review.readersTarget, 9, "the run's policy is not changed by a review");
});
