import test from "node:test";
import assert from "node:assert/strict";
import * as engine from "../dist/index.js";
import { bookRoundAi, oneCorrection } from "./book-round-fakes.mjs";
import { FAST, finishedBook, newSession, run, stateOf } from "./review-fakes.mjs";

// The pieces of the book-level round (#113) that need no run: the points of a judgement, the corrections as the director gave them, the words of a revision, the policy, the state a
// file keeps, what a client sees of it, the decision of the author, and the plateau breakers (the extension point).

const {
  BOOK_CORRECTIONS_MAX,
  BOOK_POINTS_MAX,
  BOOK_POINT_CHARACTERS,
  PLATEAU_BREAKS_MAX,
  RevisionCampaignError,
  bookCorrectionInstruction,
  consultPlateauBreakers,
  decideBookCorrections,
  normalizeFinalReview,
  normalizeReviewPolicy,
  parseAutopilotState,
  plateauBreakers,
  readBookCorrections,
  registerPlateauBreaker,
  serializeAutopilotState,
  summarizeAutopilotState,
  verdictPoints,
} = engine;

const access = (entries) => new Map(Object.entries(entries).map(([number, kind]) => [Number(number), kind]));

test("the points of a judgement are its concerns and its next steps, in one line each, cut, at most as many as a correction can cite", () => {
  const points = verdictPoints({
    concerns: [{ severity: "major", issue: "The ending is not earned", suggestion: "Plant\nits setup\n earlier" }, { severity: "minor", issue: "  " }, { severity: "critical", issue: "x".repeat(900) }],
    nextSteps: ["Tighten the middle", ""],
  });
  assert.equal(points[0], "major: The ending is not earned — Plant its setup earlier");
  assert.equal(points[1], "minor:", "a concern is a line even without words after it");
  assert.equal(points[2].length, BOOK_POINT_CHARACTERS);
  assert.equal(points[3], "next step: Tighten the middle");
  assert.equal(verdictPoints({ concerns: Array.from({ length: 40 }, (_, index) => ({ severity: "minor", issue: `issue ${index}` })), nextSteps: [] }).length, BOOK_POINTS_MAX);
  assert.deepEqual(verdictPoints({ concerns: [], nextSteps: [] }), []);
});

test("the corrections are read against the chapters of the book and the points of the judgement: what does not name a chapter, say what and why, or cite a point, is left out and said", () => {
  const chapters = access({ 1: "open", 2: "open", 3: "author" });
  const read = readBookCorrections({
    summary: "  What keeps\nthe book down. ",
    corrections: [
      { chapterNumber: 3, change: "Cut the flashback.", reason: "It stops the book.", cites: [2, 2] },
      { chapterNumber: 1, change: "Plant the setup.", reason: "The ending is not earned.", cites: [1] },
      { chapterNumber: 9, change: "Cut.", reason: "Because.", cites: [1] },
      { chapterNumber: 2, change: "", reason: "Because.", cites: [1] },
      { chapterNumber: 2, change: "Cut.", reason: "", cites: [1] },
      { chapterNumber: 2, change: "Cut.", reason: "Because.", cites: [7] },
      { chapterNumber: 1, change: "And the middle too.", reason: "It drags.", cites: [2] },
    ],
  }, chapters, 2);
  assert.equal(read.summary, "What keeps the book down.");
  assert.deepEqual(read.corrections.map((correction) => [correction.chapter, correction.cites, correction.held, correction.status]), [[1, [1], undefined, "waiting"], [1, [2], undefined, "waiting"], [3, [2], "author", "waiting"]], "in the order of the book, a chapter may have several, the author's is held");
  assert.equal(read.problems.length, 4);
  assert.match(read.problems[0], /chapter 9, which is not a chapter of the book/);
  assert.match(read.problems[1], /does not say what to change/);
  assert.match(read.problems[2], /does not say why/);
  assert.match(read.problems[3], /does not cite a point of the judgement: give the number of at least one of the 2 points/);
  // A judgement of an older engine has no points: nothing is required to be cited.
  assert.equal(readBookCorrections({ summary: "", corrections: [{ chapterNumber: 1, change: "Cut.", reason: "Because." }] }, chapters, 0).corrections.length, 1);
  // At most as many as a round keeps.
  const many = Array.from({ length: BOOK_CORRECTIONS_MAX + 5 }, (_, index) => ({ chapterNumber: 1, change: `Change ${index}.`, reason: "Because.", cites: [1] }));
  assert.equal(readBookCorrections({ summary: "", corrections: many }, chapters, 1).corrections.length, BOOK_CORRECTIONS_MAX);
});

test("a chapter is told what the director asks of it for the whole book, why, and the points of the judgement it answers", () => {
  const round = {
    verdict: { score: 7.4, points: ["major: The ending is not earned", "next step: Tighten the middle"] },
    corrections: [
      { chapter: 2, change: "Plant the setup.", reason: "The ending is not earned.", cites: [1], status: "waiting" },
      { chapter: 2, change: "Cut the detour.", reason: "The middle drags.", cites: [2], status: "waiting" },
      { chapter: 2, change: "Already done.", reason: "x", cites: [1], status: "applied" },
      { chapter: 3, change: "Not this chapter.", reason: "x", cites: [1], status: "waiting" },
    ],
  };
  assert.equal(bookCorrectionInstruction(round, 2), [
    "The director's judgement of the whole book (7.4/10) asks for changes to chapter 2, because the book as a whole needs them:",
    "1. Plant the setup.",
    "   Why: The ending is not earned.",
    "   Answers: «major: The ending is not earned»",
    "2. Cut the detour.",
    "   Why: The middle drags.",
    "   Answers: «next step: Tighten the middle»",
  ].join("\n"));
});

test("the policy keeps the book-level round as apply or ask, takes it back with off or null, and reads anything else softly", () => {
  assert.deepEqual(normalizeReviewPolicy({ bookRound: "apply" }), { bookRound: "apply" });
  assert.deepEqual(normalizeReviewPolicy({ bookRound: "ask", targetScore: 8 }), { targetScore: 8, bookRound: "ask" });
  assert.equal(normalizeReviewPolicy({ bookRound: "off" }), undefined, "off is no policy");
  assert.equal(normalizeReviewPolicy({ bookRound: "sometimes" }), undefined, "a word that is not a mode is left out");
  assert.deepEqual(normalizeReviewPolicy({ targetScore: 9 }, { bookRound: "ask" }), { targetScore: 9, bookRound: "ask" }, "what is not said stays");
  assert.deepEqual(normalizeReviewPolicy({ bookRound: null, targetScore: 9 }, { bookRound: "ask" }), { targetScore: 9 }, "null takes it back");
  assert.deepEqual(normalizeReviewPolicy({ bookRound: "off", targetScore: 9 }, { bookRound: "ask" }), { targetScore: 9 }, "so does off");
});

test("the final judgement keeps the points a correction can cite, and the summary a client gets does not carry them", () => {
  const review = normalizeFinalReview({ verdict: "revise", score: 7, text: "Good.", at: "2026-01-01T00:00:00.000Z", points: ["major: a ", "", "  next step: b", 7, ...Array.from({ length: 40 }, (_, index) => `p${index}`)] });
  assert.equal(review.points.length, BOOK_POINTS_MAX);
  assert.deepEqual(review.points.slice(0, 2), ["major: a", "next step: b"]);
  assert.equal(normalizeFinalReview({ verdict: "revise", score: 7, text: "", at: "" }).points, undefined, "an older judgement has none");
});

test("the state keeps a book-level round across a save, drops what is not one, and tells a client how far it is", async () => {
  const ai = bookRoundAi({ chapters: { 1: [["approve", 8]], 2: [["approve", 8]] }, books: [6, 8] });
  const store = await finishedBook(ai, 2);
  await newSession(store, ai).session.reviewBook({ targetScore: 7.5, bookRound: "ask" });
  await run(store, ai);
  const state = stateOf(store);
  const again = parseAutopilotState(serializeAutopilotState(state));
  assert.deepEqual(again.campaign.review.book, state.campaign.review.book, "saved and read again");
  assert.deepEqual([again.campaign.review.phase, again.campaign.review.bookRound], ["book", "ask"]);
  const summary = summarizeAutopilotState(state);
  assert.deepEqual(summary.campaign.review.bookRound, { status: "proposed", corrections: 1, applied: 0 });
  assert.equal(summary.campaign.review.phase, "book");
  assert.equal(summary.finalReview.points, undefined, "the points stay in the state");
  assert.ok(state.finalReview.points.length >= 2);

  // A round of the book without its record is a round of the verdict (the book is judged again); with no chapter either, as when the review began in the round, it is no campaign at all.
  // A correction that says nothing is no correction.
  const broken = JSON.parse(serializeAutopilotState(state));
  delete broken.campaign.review.book;
  assert.equal(parseAutopilotState(JSON.stringify(broken)).campaign, undefined);
  broken.campaign.chapters = [{ number: 1, mode: "follow", status: "done" }];
  assert.equal(parseAutopilotState(JSON.stringify(broken)).campaign.review.phase, "verdict");
  const hollow = JSON.parse(serializeAutopilotState(state));
  hollow.campaign.review.book.corrections.push({ chapter: 2, change: "", reason: "x", cites: [1] }, "nonsense", { chapter: 0, change: "a", reason: "b" });
  assert.equal(parseAutopilotState(JSON.stringify(hollow)).campaign.review.book.corrections.length, 1);
});

test("the decision of the author about the corrections of the book: refused when it is not one, when nothing waits, or when the round changed; else the chosen ones are carried out", async () => {
  const ai = bookRoundAi({ chapters: { 1: [["approve", 8]], 2: [["approve", 8]] }, books: [6, 8], corrections: () => ({ summary: "s", corrections: [
    { chapterNumber: 1, change: "One.", reason: "a", cites: [1] },
    { chapterNumber: 2, change: "Two.", reason: "b", cites: [2] },
  ] }) });
  const store = await finishedBook(ai, 2);
  await newSession(store, ai).session.reviewBook({ targetScore: 7.5, bookRound: "ask" });
  const { state } = await run(store, ai);
  for (const input of [null, {}, { round: 0, action: "apply" }, { round: 1, action: "maybe" }, { round: 1, action: "apply", chosen: "all" }, { round: 1, action: "apply", chosen: [0] }, { round: 1, action: "apply", chosen: [3] }, { round: 1, action: "apply", chosen: [1.5] }]) {
    assert.throws(() => decideBookCorrections(state, input), (error) => error instanceof RevisionCampaignError && error.code === "invalid_request", JSON.stringify(input));
  }
  assert.throws(() => decideBookCorrections(state, { round: 4, action: "apply" }), (error) => error.code === "stale");
  assert.throws(() => decideBookCorrections({ ...state, campaign: undefined }, { round: 1, action: "apply" }), (error) => error.code === "no_proposal");
  const all = decideBookCorrections(state, { round: 1, action: "apply" });
  assert.deepEqual(all.campaign.chapters.map((item) => [item.number, item.mode, item.status]), [[1, "follow", "waiting"], [2, "follow", "waiting"]], "all of them, when none is chosen");
  assert.notEqual(all, state, "the state it was given is not changed");
  assert.equal(state.campaign.review.book.status, "proposed");
  const second = decideBookCorrections(state, { round: 1, action: "apply", chosen: [2] });
  assert.deepEqual([second.campaign.review.book.status, second.campaign.chapters.map((item) => item.number)], ["applying", [2]]);
  const none = decideBookCorrections(state, { round: 1, action: "apply", chosen: [] });
  assert.equal(none.campaign.review.book.status, "declined", "choosing none is declining");
});

test("the plateau breakers are the extension point of a plateau: asked in the order they were registered, the first to continue wins, one that throws or says nothing is left out", async () => {
  const said = [];
  const context = { bookId: "b", state: {}, store: {}, snapshot: {}, signal: new AbortController().signal, ai: async () => ({}), insight: (tone, title) => said.push([tone, title]) };
  const plateau = { campaignId: "c", round: 3, target: 8, votes: { lowest: 8, book: 7, below: 0 }, history: [], kind: "book", broken: 0, language: "en" };
  assert.deepEqual(await consultPlateauBreakers(plateau, context), { action: "stop" }, "no breaker: the review ends as it always did");
  const off = [
    registerPlateauBreaker(() => { throw new Error("it broke"); }),
    registerPlateauBreaker(() => ({ action: "continue", material: "   " })),
    registerPlateauBreaker(async () => ({ action: "stop" })),
    registerPlateauBreaker(async (seen) => ({ action: "continue", material: `${"idea ".repeat(5000)}${seen.round}` })),
    registerPlateauBreaker(() => ({ action: "continue", material: "never asked" })),
  ];
  try {
    assert.equal(plateauBreakers().length, 5);
    const answer = await consultPlateauBreakers(plateau, context);
    assert.equal(answer.action, "continue");
    assert.equal(answer.material.length, engine.BOOK_MATERIAL_CHARACTERS, "what it found is cut");
    assert.deepEqual(said.map(([tone, title]) => [tone, /it broke/.test(title)]), [["warning", true]], "the one that failed is said, once");
    off[3]();
    off[4]();
    assert.deepEqual(await consultPlateauBreakers(plateau, context), { action: "stop" });
    // A step that is aborted is not swallowed by a breaker that fails.
    const controller = new AbortController();
    const off2 = registerPlateauBreaker(() => { controller.abort(); throw new Error("aborted"); });
    await assert.rejects(consultPlateauBreakers(plateau, { ...context, signal: controller.signal }), /aborted/);
    off2();
  } finally {
    for (const remove of off) remove();
  }
  assert.equal(plateauBreakers().length, 0);
  assert.ok(PLATEAU_BREAKS_MAX >= 1);
});
