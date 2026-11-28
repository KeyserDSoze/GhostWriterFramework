import test from "node:test";
import assert from "node:assert/strict";
import * as engine from "../dist/index.js";
import { FAST, ended, finishedBook, insights, newSession, run, stateOf } from "./review-fakes.mjs";
import { bookRoundAi, oneCorrection } from "./book-round-fakes.mjs";

// The book-level round of a review (#113): every chapter has its targets and the director's vote of the whole book does not, so the director lists the corrections of the whole
// book, they are carried out in the chapters they name (a revision of the chapter, which is reviewed again), and the book is judged again, until the target, a plateau, the rounds
// allowed or the money cap say stop. A review without it ends where it always did.

const { RevisionCampaignError, plateauBreakers, registerPlateauBreaker } = engine;

/** Two chapters closed at 8 and a book judged `books[0]`: the review to 7.5 has no chapter under the target, only the book. */
const book = (books, extra = {}) => bookRoundAi({ chapters: { 1: [["approve", 8]], 2: [["approve", 8]] }, books, ...extra });
const labels = (ai, mark) => ai.calls.slice(mark).map((call) => call.label);

test("a review that ends with every chapter at the target and the book under it, and no book-level round, ends where it always did: nothing more is asked", async () => {
  const ai = book([6, 6.5]);
  const store = await finishedBook(ai, 2);
  await assert.rejects(newSession(store, ai).session.reviewBook({ targetScore: 7.5 }), (error) => error instanceof RevisionCampaignError && error.code === "nothing_to_review" && /book-level round/.test(error.message));
  await assert.rejects(newSession(store, ai).session.reviewBook({ targetScore: 7.5, bookRound: "off" }), (error) => error.code === "nothing_to_review");
  assert.equal(ai.asked.length, 0);
});

test("a review of a finished book whose chapters have the target and whose book does not begins with the director's corrections of the book, and carries them out", async () => {
  // The book is judged 6, then 7 after the correction (target 7.5 not yet: another round), then 8.
  const ai = book([6, 7, 8]);
  const store = await finishedBook(ai, 2);
  const untouched = store.files.get("chapters/002-chapter-title-2/001-scene-1-title.md");
  const { session } = newSession(store, ai);
  const asked = await session.reviewBook({ targetScore: 7.5, bookRound: "apply" });
  assert.equal(asked.campaign.review.phase, "book");
  assert.deepEqual(asked.campaign.chapters, [], "no chapter is under a target: the director is asked first");
  assert.deepEqual([asked.campaign.review.book.status, asked.campaign.review.book.verdict.score, asked.campaign.review.bookRound], ["asking", 6, "apply"]);
  assert.deepEqual(asked.campaign.review.book.verdict.points, ["major: The ending is not earned — Plant its setup earlier", "next step: Tighten the middle chapters"]);
  const mark = ai.calls.length;
  const { events, state } = await run(store, ai);
  assert.equal(state.status, "completed", state.lastError?.message);
  assert.equal(ai.asked.length, 2, "the director was asked twice: after 6 and after 7");
  assert.match(ai.asked[0].user, /POINTS OF YOUR JUDGEMENT \(cite them by number\):\n1\. major: The ending is not earned/, "it reads the points it can cite");
  assert.match(ai.asked[0].user, /CHAPTERS:\nChapter 1[^\n]*the director's vote 8\/10/);
  assert.ok(labels(ai, mark).indexOf("autopilot:book-corrections") < labels(ai, mark).indexOf("autopilot:impact"), "the corrections come first, then the revision of the chapter they name");
  assert.deepEqual(ai.revised.map((entry) => entry.chapter), [1, 1], "the chapter the director named is revised in each round");
  assert.match(ai.revised[0].user, /Plant the setup of the ending in the first scene/);
  assert.match(ai.revised[0].user, /Answers: «major: The ending is not earned — Plant its setup earlier»/, "with the point of the verdict it answers");
  assert.equal(store.files.get("chapters/002-chapter-title-2/001-scene-1-title.md"), untouched, "the chapter nobody named is not touched");
  assert.equal(state.finalReview.score, 8);
  assert.equal(state.campaign, undefined, "over, and gone");
  const record = state.reviews.at(-1);
  assert.deepEqual([record.outcome, record.rounds, record.to.book], ["target", 2, 8]);
  assert.deepEqual(record.bookRounds.map((entry) => [entry.round, entry.score, entry.corrections.map((correction) => [correction.chapter, correction.status])]), [[1, 6, [[1, "applied"]]], [2, 7, [[1, "applied"]]]]);
  assert.deepEqual(insights(events, "bookRoundAsked").map((event) => event.figures.round), [2], "the first round began with the review; the second is told when it begins");
  assert.deepEqual(insights(events, "bookRoundApplied").map((event) => event.figures.round), [1, 2]);
  assert.deepEqual(insights(events, "bookRoundApplied").map((event) => [event.figures.corrections, event.figures.chapters, event.figures.book, event.figures.target]), [[1, 1, 6, 7.5], [1, 1, 7, 7.5]], "the numbers a client says it in its own words");
  assert.equal(insights(events, "reviewDone").length, 1);
  assert.equal(ended(events).status, "completed");
});

test("the corrections the author is asked about wait for them: the run stops, the author chooses, and only what is chosen is carried out", async () => {
  const ai = book([6, 8], { corrections: () => ({ summary: "Two things.", corrections: [
    { chapterNumber: 1, change: "Plant the setup of the ending.", reason: "The ending is not earned.", cites: [1] },
    { chapterNumber: 2, change: "Cut the second scene's detour.", reason: "The middle drags.", cites: [2] },
  ] }) });
  const store = await finishedBook(ai, 2);
  const { session } = newSession(store, ai);
  await session.reviewBook({ targetScore: 7.5, bookRound: "ask" });
  const stopped = await run(store, ai);
  assert.equal(stopped.state.status, "paused", stopped.state.lastError?.message);
  assert.equal(stopped.state.message?.includes("2 corrections"), true, stopped.state.message);
  assert.equal(insights(stopped.events, "bookRoundProposed").length, 1);
  assert.deepEqual([insights(stopped.events, "bookRoundProposed")[0].figures.corrections, insights(stopped.events, "bookRoundProposed")[0].figures.chapters], [2, 2], "two corrections in two chapters");
  const round = stopped.state.campaign.review.book;
  assert.deepEqual([round.status, round.corrections.map((correction) => [correction.chapter, correction.status])], ["proposed", [[1, "waiting"], [2, "waiting"]]]);
  assert.equal(ai.revised.length, 0, "nothing was changed yet");

  // A decision about another round, or from nothing that waits, is refused; the right one is recorded at once.
  const decider = newSession(store, ai).session;
  await assert.rejects(decider.decideBookCorrections({ round: 9, action: "apply" }), (error) => error instanceof RevisionCampaignError && error.code === "stale");
  await assert.rejects(decider.decideBookCorrections({ round: 1, action: "apply", chosen: [3] }), (error) => error.code === "invalid_request");
  const decided = await decider.decideBookCorrections({ round: 1, action: "apply", chosen: [2] });
  assert.deepEqual(decided.campaign.review.book.corrections.map((correction) => [correction.chapter, correction.status, correction.why]), [[1, "left-out", "declined"], [2, "waiting", undefined]]);
  assert.deepEqual([decided.campaign.review.phase, decided.campaign.review.book.status, decided.campaign.chapters.map((item) => item.number)], ["chapters", "applying", [2]]);
  await assert.rejects(decider.decideBookCorrections({ round: 1, action: "apply" }), (error) => error.code === "no_proposal");

  const { state } = await run(store, ai);
  assert.equal(state.status, "completed", state.lastError?.message);
  assert.deepEqual(ai.revised.map((entry) => entry.chapter), [2], "only the chapter whose correction was chosen");
  const record = state.reviews.at(-1);
  assert.deepEqual([record.outcome, record.to.book], ["target", 8]);
  assert.deepEqual(record.bookRounds[0].corrections.map((correction) => [correction.chapter, correction.status, correction.why]), [[1, "left-out", "declined"], [2, "applied", undefined]]);
});

test("the author declines every correction: the review ends there, and nothing was changed", async () => {
  const ai = book([6]);
  const store = await finishedBook(ai, 2);
  await newSession(store, ai).session.reviewBook({ targetScore: 7.5, bookRound: "ask" });
  await run(store, ai);
  await newSession(store, ai).session.decideBookCorrections({ round: 1, action: "decline" });
  const { events, state } = await run(store, ai);
  assert.equal(state.status, "completed", state.lastError?.message);
  assert.equal(ai.revised.length, 0);
  assert.equal(state.campaign, undefined);
  assert.deepEqual([state.reviews.at(-1).outcome, state.reviews.at(-1).bookRounds[0].corrections[0].why], ["chapters", "declined"]);
  assert.equal(insights(events, "reviewStopped").length, 1);
});

test("two rounds that raise neither the lowest chapter nor the book are a plateau, with the corrections asked in each, and the review ends", async () => {
  const ai = book([6]);
  const store = await finishedBook(ai, 2);
  await newSession(store, ai).session.reviewBook({ targetScore: 7.5, bookRound: "apply" });
  const { events, state } = await run(store, ai);
  assert.equal(state.status, "completed", state.lastError?.message);
  assert.equal(ai.asked.length, 2, "two rounds, then the stall ends it");
  const record = state.reviews.at(-1);
  assert.deepEqual([record.outcome, record.rounds], ["plateau", 2]);
  assert.match(ai.asked[1].user, /WHAT EARLIER ROUNDS ASKED OF THE BOOK:\nRound 1: asked chapter 1: Plant the setup of the ending in the first scene\. \[applied\]\. The book went from 6\/10 to 6\/10\./, "the second round knows what the first did");
  assert.equal(insights(events, "reviewStopped").length, 1);
});

test("a correction that asks a change of a chapter the author froze is never carried out by the review: it is left out, and said", async () => {
  const ai = book([6, 6], { corrections: () => oneCorrection(2) });
  const store = await finishedBook(ai, 2);
  const { session } = newSession(store, ai);
  await session.freezeChapter("002-chapter-title-2");
  const before = store.files.get("chapters/002-chapter-title-2/001-scene-1-title.md");
  await session.reviewBook({ targetScore: 7.5, bookRound: "apply" });
  const { events, state } = await run(store, ai);
  assert.equal(state.status, "completed", state.lastError?.message);
  assert.equal(store.files.get("chapters/002-chapter-title-2/001-scene-1-title.md"), before, "the author's chapter is as it was");
  assert.equal(ai.revised.length, 0);
  assert.match(ai.asked[0].user, /Chapter 2[^\n]*THE AUTHOR'S/, "the director is told which chapters are the author's");
  const record = state.reviews.at(-1);
  assert.deepEqual(record.bookRounds[0].corrections.map((correction) => [correction.chapter, correction.held, correction.status, correction.why]), [[2, "author", "left-out", "author"]]);
  assert.equal(insights(events, "bookRoundNone").length, 0, "the director had something to ask");
  assert.equal(insights(events, "bookRoundAuthor").length, 1);
  assert.match(insights(events, "bookRoundAuthor")[0].title, /chapters that are yours/);
});

test("a chapter of the author's is changed when the author chooses its correction, and then it is part of the review", async () => {
  const ai = book([6, 8], { corrections: () => oneCorrection(2) });
  const store = await finishedBook(ai, 2);
  const { session } = newSession(store, ai);
  await session.freezeChapter("002-chapter-title-2");
  await session.reviewBook({ targetScore: 7.5, bookRound: "ask" });
  await run(store, ai);
  const proposed = stateOf(store).campaign.review.book;
  assert.deepEqual([proposed.status, proposed.corrections[0].held], ["proposed", "author"]);
  const decided = await newSession(store, ai).session.decideBookCorrections({ round: 1, action: "apply", chosen: [1] });
  assert.deepEqual([decided.campaign.review.include, decided.campaign.review.scope], [[2], [1, 2]]);
  const { state } = await run(store, ai);
  assert.equal(state.status, "completed", state.lastError?.message);
  assert.deepEqual(ai.revised.map((entry) => entry.chapter), [2]);
  assert.equal(state.reviews.at(-1).outcome, "target");
});

test("a director with no correction across the chapters ends the review there, and says so", async () => {
  const ai = book([6], { corrections: () => ({ summary: "It is for the author to decide.", corrections: [] }) });
  const store = await finishedBook(ai, 2);
  await newSession(store, ai).session.reviewBook({ targetScore: 7.5, bookRound: "apply" });
  const { events, state } = await run(store, ai);
  assert.equal(state.status, "completed", state.lastError?.message);
  assert.deepEqual([state.reviews.at(-1).outcome, state.reviews.at(-1).rounds], ["chapters", 0]);
  const none = insights(events, "bookRoundNone");
  assert.equal(none.length, 1);
  assert.match(none[0].title, /no correction across the chapters/);
});

test("corrections that cite no point of the judgement, or name no chapter of the book, are refused and asked again", async () => {
  let call = 0;
  const ai = book([6, 8], { corrections: () => {
    call += 1;
    return call === 1
      ? { summary: "x", corrections: [{ chapterNumber: 9, change: "Cut.", reason: "Because.", cites: [1] }, { chapterNumber: 1, change: "Cut.", reason: "Because.", cites: [7] }] }
      : oneCorrection(1);
  } });
  const store = await finishedBook(ai, 2);
  await newSession(store, ai).session.reviewBook({ targetScore: 7.5, bookRound: "apply" });
  const { state } = await run(store, ai);
  assert.equal(state.status, "completed", state.lastError?.message);
  assert.ok(ai.asked.length >= 2, "the reply was refused once");
  assert.deepEqual(state.reviews.at(-1).bookRounds[0].corrections.map((correction) => correction.cites), [[1]]);
});

test("the rounds allowed since the run began count the book-level rounds: the review waits for the author after them, and a start allows as many again", async () => {
  const ai = book([6, 6.2, 8]);
  const store = await finishedBook(ai, 2);
  await newSession(store, ai).session.configure({ options: { ...FAST, review: { campaignMaxRounds: 1 } } });
  await newSession(store, ai).session.reviewBook({ targetScore: 7.5, bookRound: "apply" });
  const first = await run(store, ai);
  assert.equal(first.state.status, "paused", first.state.lastError?.message);
  assert.deepEqual([first.state.limitReached?.kind, first.state.campaign.held !== undefined, first.state.campaign.review.round], ["review-rounds", true, 2]);
  assert.equal(ai.asked.length, 1, "one round, then the cap holds the second");
  const second = await run(store, ai);
  assert.equal(ai.asked.length, 2, "the second round is asked after the start");
  assert.deepEqual([second.state.campaign, second.state.reviews.at(-1).outcome, second.state.reviews.at(-1).rounds], [undefined, "target", 2]);
});

// ─── The plateau breakers ───────────────────────────────────────────────────

test("a plateau breaker is asked when the review stalls, and what it found is read by the director with the corrections; a breaker that stops ends the review", async () => {
  const seen = [];
  const off = registerPlateauBreaker((plateau, context) => {
    seen.push(plateau);
    assert.equal(typeof context.ai, "function");
    return seen.length === 1 ? { action: "continue", material: "A wild idea: the harbor master is the narrator." } : { action: "stop" };
  });
  try {
    assert.equal(plateauBreakers().length >= 1, true);
    const ai = book([6]);
    const store = await finishedBook(ai, 2);
    await newSession(store, ai).session.reviewBook({ targetScore: 7.5, bookRound: "apply" });
    const { events, state } = await run(store, ai);
    assert.equal(state.status, "completed", state.lastError?.message);
    // Round 1 and 2 raise nothing: the plateau. The breaker continues once (round 3 has its material); two more rounds raise nothing and it stops.
    assert.equal(seen.length >= 1, true);
    assert.deepEqual([seen[0].kind, seen[0].target, seen[0].broken, seen[0].votes.book], ["book", 7.5, 0, 6]);
    const withMaterial = ai.asked.filter((entry) => /WHAT THE ROOM FOUND/.test(entry.user));
    assert.equal(withMaterial.length >= 1, true);
    assert.match(withMaterial[0].user, /the harbor master is the narrator/);
    assert.equal(insights(events, "plateauBroken").length, 1);
    assert.equal(state.reviews.at(-1).outcome, "plateau");
  } finally {
    off();
  }
  assert.equal(plateauBreakers().length, 0, "taken away");
});
