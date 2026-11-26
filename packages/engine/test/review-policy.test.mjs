import test from "node:test";
import assert from "node:assert/strict";
import * as engine from "../dist/index.js";
import { MemoryBookStore, seedBookFiles } from "../dist/testing/index.js";
import { FAST, brief, run, votingAi } from "./review-fakes.mjs";

// The review policy of a run (`options.review`): the vote a chapter and the book must reach, the rounds of a chapter and the rounds the readers read in. The
// director's profile gives the defaults, a review of the book in progress its own; without a policy every prompt is the one it always was.

const { defaultDirector, serializeDirector } = engine;

// ─── The run's review policy ────────────────────────────────────────────────

test("the review policy of the options is kept in its ranges, follows what is sent, and `null` takes it back", () => {
  const { normalizeOptions, normalizeReviewPolicy, DEFAULT_OPTIONS } = engine;
  assert.deepEqual(normalizeReviewPolicy({ targetScore: 12, maxRounds: 0, readerRounds: 99, campaignMaxRounds: 500 }), { targetScore: 10, maxRounds: 1, readerRounds: 10, campaignMaxRounds: 100 });
  assert.deepEqual(normalizeReviewPolicy({ targetScore: "8.46", maxRounds: 4.4 }), { targetScore: 8.5, maxRounds: 4 }, "a vote to one decimal, rounds whole");
  assert.equal(normalizeReviewPolicy({ targetScore: "eight" }), undefined, "nothing usable is no policy");
  assert.equal(normalizeReviewPolicy(null), undefined);
  const options = normalizeOptions({ review: { targetScore: 8, maxRounds: 5 } }, DEFAULT_OPTIONS);
  assert.deepEqual(options.review, { targetScore: 8, maxRounds: 5 });
  assert.deepEqual(normalizeOptions({ review: { readerRounds: 2 } }, options).review, { targetScore: 8, maxRounds: 5, readerRounds: 2 }, "a field sent changes that field only");
  assert.deepEqual(normalizeOptions({ review: { maxRounds: null } }, options).review, { targetScore: 8 }, "a field sent as null goes back to the director's");
  assert.deepEqual(normalizeOptions({ review: { campaignMaxRounds: 0 } }, { ...options, review: { ...options.review, campaignMaxRounds: 3 } }).review, { targetScore: 8, maxRounds: 5 }, "a rounds cap of 0 is no cap");
  assert.equal(normalizeOptions({ review: null }, options).review, undefined, "null takes the whole policy back");
  assert.equal(normalizeOptions({}, options).review, options.review, "nothing sent keeps it");
  assert.equal("review" in normalizeOptions({}, DEFAULT_OPTIONS), false, "a book without a policy has none");
});

test("which value wins: the review of the book in progress, else the run's policy, else the director's profile", () => {
  const { reviewTarget, reviewMaxRounds, reviewReaderRounds } = engine;
  const director = { approvalScore: 7, maxReviewRounds: 2 };
  const none = { options: {} };
  assert.deepEqual([reviewTarget(none, director), reviewMaxRounds(none, director), reviewReaderRounds(none)], [7, 2, 1], "the director's, and the readers in the first round only");
  const run = { options: { review: { targetScore: 8, maxRounds: 4, readerRounds: 2 } } };
  assert.deepEqual([reviewTarget(run, director), reviewMaxRounds(run, director), reviewReaderRounds(run)], [8, 4, 2]);
  const campaign = { ...run, campaign: { reason: "review-target", review: { targetScore: 9, maxRounds: 6, readerRounds: 0 } } };
  assert.deepEqual([reviewTarget(campaign, director), reviewMaxRounds(campaign, director), reviewReaderRounds(campaign)], [9, 6, 0]);
  const other = { ...run, campaign: { reason: "outline-change", chapters: [] } };
  assert.deepEqual([reviewTarget(other, director), reviewMaxRounds(other, director)], [8, 4], "another campaign has no policy of its own");
});

test("a run with a review policy: the director approves at the target, a chapter has the rounds the policy gives, the readers read again in the rounds it says, and the book is judged at the target", async () => {
  // 8 is under the target 8.5: the approval (with a fix) is withheld; 8.2 is a revise; 9 approves, in the third of the four rounds the policy allows (the director's
  // profile has two).
  const ai = votingAi({ chapters: { 1: [["approve", 8, true], ["revise", 8.2], ["approve", 9]] }, books: [8] });
  const store = new MemoryBookStore({ ...seedBookFiles({ chapters: 1 }), "director.md": serializeDirector(defaultDirector("en")) });
  const { state } = await run(store, ai, { brief: brief(1), options: { ...FAST, readers: true, maxReaders: 2, review: { targetScore: 8.5, maxRounds: 4, readerRounds: 2 } } });
  assert.equal(state.status, "completed", state.lastError?.message);
  assert.deepEqual(ai.decided.map((entry) => [entry.round, entry.score]), [[1, 8], [2, 8.2], [3, 9]]);
  assert.match(ai.decided[0].user, /review round 1 of 4/);
  assert.match(ai.decided[0].user, /at least 8\.5\/10/);
  assert.deepEqual(state.plan.chapters[0].rounds.map((round) => round.verdict), ["revise", "revise", "approve"], "the approval under the target was withheld");
  assert.deepEqual(state.plan.chapters[0].rounds.map((round) => "readers" in round), [true, true, false], "the readers read in the first two rounds, as the policy says, and not in the third");
  assert.equal(ai.calls.filter((call) => call.label.startsWith("reader-evaluation:") && call.json?.name === "reader_evaluation").length, 4, "two readers, twice");
  assert.match(ai.judged[0].user, /at least 8\.5\/10/, "the book is judged at the target too");
  assert.deepEqual(state.options.review, { targetScore: 8.5, maxRounds: 4, readerRounds: 2 }, "kept in the options");
});

test("without a policy nothing changes: the director's score and rounds, the readers once", async () => {
  const ai = votingAi({ chapters: { 1: [["revise", 6], ["approve", 8]] }, books: [8] });
  const store = new MemoryBookStore({ ...seedBookFiles({ chapters: 1 }), "director.md": serializeDirector(defaultDirector("en")) });
  const { state } = await run(store, ai, { brief: brief(1), options: { ...FAST, readers: true, maxReaders: 2 } });
  assert.equal(state.status, "completed", state.lastError?.message);
  assert.match(ai.decided[0].user, /review round 1 of 2/);
  assert.match(ai.decided[0].user, /at least 7\/10/);
  assert.deepEqual(state.plan.chapters[0].rounds.map((round) => "readers" in round), [true, false]);
  assert.doesNotMatch(ai.judged[0].user, /Approve the book when/, "the book's prompt is the one it always was");
});

// ─── The estimate of a review ───────────────────────────────────────────────

test("the estimate follows the review policy (the rounds of a chapter, the readers' rounds) and counts only the review of chapters already written", () => {
  const { estimateAutopilotRun } = engine;
  const calls = (result, kind) => result.steps[kind]?.calls ?? { min: 0, max: 0 };
  const base = { brief: brief(4), options: { readers: true, maxReaders: 2, specialists: true }, maxReviewRounds: 2, progress: { chaptersDone: 0, planned: 4, conceptDone: true } };
  const director = estimateAutopilotRun(base);
  const policy = estimateAutopilotRun({ ...base, options: { ...base.options, review: { maxRounds: 5, readerRounds: 2 } } });
  assert.deepEqual(calls(director, "director-review"), { min: 4, max: 8 });
  assert.deepEqual(calls(policy, "director-review"), { min: 4, max: 20 }, "five rounds at the most");
  assert.deepEqual([calls(director, "reader").max, calls(policy, "reader").max], [8, 16], "the readers read in two rounds");
  assert.equal(calls(policy, "reader").min, 8, "in the first only, when a chapter is approved at once");
  const review = estimateAutopilotRun({ ...base, progress: { chaptersDone: 2, planned: 4, conceptDone: true, finalDone: false, reviewOnly: true } });
  assert.deepEqual([calls(review, "write").max, calls(review, "scenes").max], [0, 0], "nothing is written again");
  assert.deepEqual(calls(review, "director-review"), { min: 2, max: 4 }, "the two chapters reviewed");
  assert.deepEqual(calls(review, "final"), { min: 1, max: 1 }, "and the book judged again");
});
