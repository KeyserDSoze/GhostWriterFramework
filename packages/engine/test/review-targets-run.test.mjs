import test from "node:test";
import assert from "node:assert/strict";
import * as engine from "../dist/index.js";
import { MemoryBookStore, seedBookFiles } from "../dist/testing/index.js";
import { FAST, brief, finishedBook, insights, newSession, run, stateOf } from "./review-fakes.mjs";
import { readersAfter, readingAi, stepsAfter } from "./review-targets-fakes.mjs";

// A chapter that is not closed until the readers say what the author asked of them: they read it again after the director's corrections, the director gets their corrections
// when a target is missed, and the review stops on the rounds allowed, on a plateau, or (in a review of the book) on what the chapters keep from the targets. A book with no
// target for the readers is reviewed as it always was: the other tests of the engine are its proof, and the first one here says the calls.

const { defaultDirector, serializeDirector } = engine;

const GENERAL = "standard-general";
const EMOTIONAL = "standard-emotional";
const CRITICAL = "standard-critical";
const READERS = { readers: true, maxReaders: 2 };

const bookOf = (chapters) => new MemoryBookStore({ ...seedBookFiles({ chapters }), "director.md": serializeDirector(defaultDirector("en")) });
/** The steps that matter of a chapter's review: the readers, their summary, the specialists, the director, the repairs, the closing and the judgement of the book. */
const reviewSteps = (ai, mark = 0) => stepsAfter(ai, mark).filter((step) => !/scene-summary|autopilot:(concept|plan|scenes|write|plan-review)/.test(step) && !step.startsWith("autopilot:plan"));
const roundsOf = (state, index = 0) => state.plan.chapters[index].rounds;

test("a book with readers and no target for them is reviewed as it always was: the readers read in the first round, and nothing asks them again, whatever they said", async () => {
  // The readers' vote is low (3) and the director's is 9: the chapter is closed all the same, with the first reading only.
  const ai = readingAi({ chapters: { 1: [["approve", 9, true]] }, books: [9], votes: { [GENERAL]: [3], [EMOTIONAL]: [3] } });
  const { state } = await run(bookOf(1), ai, { brief: brief(1), options: { ...FAST, ...READERS } });
  assert.equal(state.status, "completed", state.lastError?.message);
  assert.deepEqual(reviewSteps(ai), ["reader", "reader", "summary", "autopilot:specialists", "autopilot:director-review", "autopilot:repair", "autopilot:consolidate", "director:book"]);
  const [only, ...others] = roundsOf(state);
  assert.deepEqual([others.length, only.director, only.readers, only.verdict, only.accepted, Object.keys(only).sort()], [0, 9, 3, "approve", 1, ["accepted", "director", "readers", "rejected", "verdict"]], "the round is the one it always was: no round number, no vote of each reader, no reading of its own");
  assert.equal(state.review, null);
  assert.doesNotMatch(ai.decided[0].user, /READERS' TARGETS|readers' targets/, "the director's prompt is the one it always was");
});

test("a policy that only leaves readers out asks nothing more: the same calls, and the average and the votes say who counts", async () => {
  const votes = { [GENERAL]: [7], [EMOTIONAL]: [6], [CRITICAL]: [3] };
  const chapters = { 1: [["approve", 8, true]] };
  const plain = readingAi({ chapters, books: [8], votes });
  const left = readingAi({ chapters, books: [8], votes });
  const options = { ...FAST, readers: true, maxReaders: 3 };
  const first = await run(bookOf(1), plain, { brief: brief(1), options });
  const second = await run(bookOf(1), left, { brief: brief(1), options: { ...options, review: { readersExcluded: [CRITICAL] } } });
  assert.equal(second.state.status, "completed", second.state.lastError?.message);
  assert.deepEqual(reviewSteps(left), reviewSteps(plain), "the same steps, in the same order");
  assert.equal(left.readings.length, 3, "the reader that does not count is still read");
  assert.equal(roundsOf(first.state)[0].readers, 5.3, "the average of all three, as it was");
  assert.deepEqual(roundsOf(second.state)[0], { ...roundsOf(first.state)[0], readers: 6.5, readerVotes: { [GENERAL]: 7, [EMOTIONAL]: 6, [CRITICAL]: 3 }, round: 1 }, "the average of the two that count; every vote is kept, with the round");
  assert.deepEqual(second.state.options.review, { readersExcluded: [CRITICAL] });
});

test("the readers read the chapter again after the director's corrections, and it is closed when their average is reached: the first-draft vote stays in the history", async () => {
  // First draft 6; the director approves with a fix (so the text changed); they read it again: 8 over the 7.5 asked. Nobody else is asked.
  const ai = readingAi({ chapters: { 1: [["approve", 8, true]] }, books: [8], votes: { [GENERAL]: [6, 8], [EMOTIONAL]: [6, 8] } });
  const { state, events } = await run(bookOf(1), ai, { brief: brief(1), options: { ...FAST, ...READERS, review: { readersTarget: 7.5 } } });
  assert.equal(state.status, "completed", state.lastError?.message);
  assert.deepEqual(reviewSteps(ai), ["reader", "reader", "summary", "autopilot:specialists", "autopilot:director-review", "autopilot:repair", "reader", "reader", "summary", "autopilot:consolidate", "director:book"]);
  const rounds = roundsOf(state);
  assert.deepEqual(rounds.map((round) => [round.director, round.readers, round.round, round.reading]), [[8, 6, 1, undefined], [undefined, 8, 1, "end"]], "the first reading is in the round of the director, the second is a round of its own with its round number");
  assert.deepEqual(rounds[1], { readers: 8, readerVotes: { [GENERAL]: 8, [EMOTIONAL]: 8 }, round: 1, reading: "end" });
  assert.equal(state.plan.chapters[0].score, 8, "the director's vote is the chapter's");
  assert.equal(insights(events, "readersTargetMissed").length, 0, "nothing stood in the way");
  assert.equal(ai.decided.length, 1, "one round of the director");
  assert.match(ai.decided[0].user, /READERS' TARGETS[^\n]*\n- the average of the readers that count: 6\/10 now, target 7\.5\/10/, "the director is told the targets are rules, and where the readers stand");
  assert.match(ai.decided[0].user, /The readers' targets in the data are rules too/);
});

test("a chapter whose text did not change after the readers read it is not read again", async () => {
  // The director approves with no fix: what the readers said is of the text as it is.
  const ai = readingAi({ chapters: { 1: [["approve", 8, false]] }, books: [8], votes: { [GENERAL]: [8], [EMOTIONAL]: [8] } });
  const { state } = await run(bookOf(1), ai, { brief: brief(1), options: { ...FAST, ...READERS, review: { readersTarget: 7.5 } } });
  assert.deepEqual(reviewSteps(ai), ["reader", "reader", "summary", "autopilot:specialists", "autopilot:director-review", "autopilot:consolidate", "director:book"], "read once");
  assert.deepEqual(roundsOf(state).map((round) => [round.director, round.readers, round.round]), [[8, 8, 1]]);
});

test("a chapter under the readers' target gets another round with their corrections for the director, until the target is reached", async () => {
  const ai = readingAi({ chapters: { 1: [["approve", 8, true], ["approve", 8.5, true]] }, books: [8], votes: { [GENERAL]: [5, 6, 8], [EMOTIONAL]: [5, 6, 8] } });
  const { state, events } = await run(bookOf(1), ai, { brief: brief(1), options: { ...FAST, ...READERS, review: { targetScore: 8, maxRounds: 3, readersTarget: 7.5 } } });
  assert.equal(state.status, "completed", state.lastError?.message);
  assert.deepEqual(reviewSteps(ai), [
    "reader", "reader", "summary", "autopilot:specialists", "autopilot:director-review", "autopilot:repair",
    "reader", "reader", "summary", "autopilot:specialists", "autopilot:director-review", "autopilot:repair",
    "reader", "reader", "summary", "autopilot:consolidate", "director:book",
  ]);
  assert.deepEqual(ai.decided.map((entry) => [entry.round, entry.score]), [[1, 8], [2, 8.5]], "the director approved at the first round, and judged again because the readers were not there");
  assert.match(ai.decided[1].user, /review round 2 of 3/);
  assert.match(ai.decided[1].user, /the average of the readers that count: 6\/10 now, target 7\.5\/10/, "it is told where the readers stand");
  assert.match(ai.decided[1].user, /\[R1-1\] reader/, "and has their corrections to decide");
  assert.ok(ai.decided[1].user.includes("FIXES APPLIED AFTER THE PREVIOUS ROUND"), "with what it fixed before");
  assert.deepEqual(roundsOf(state).map((round) => [round.director, round.readers, round.round, round.reading]), [[8, 5, 1, undefined], [undefined, 6, 1, "end"], [8.5, undefined, undefined, undefined], [undefined, 8, 2, "end"]], "each vote is in the history, with the round it follows");
  assert.deepEqual(ai.readings.map((reading) => [reading.slug, reading.number]), [[GENERAL, 1], [EMOTIONAL, 1], [GENERAL, 2], [EMOTIONAL, 2], [GENERAL, 3], [EMOTIONAL, 3]]);
  const info = events.filter((event) => event.type === "insight" && /Another round of corrections/.test(event.title));
  assert.equal(info.length, 1);
  assert.match(info[0].title, /Chapter 1 is not there yet for the readers: the readers' average 6\/10 is under 7\.5\/10/);
  assert.equal(insights(events, "readersTargetMissed").length, 0);
});

test("the rounds allowed stop a chapter the readers do not like, and the stop says which target was missed", async () => {
  const ai = readingAi({ chapters: { 1: [["approve", 8, true]] }, books: [8], votes: { [GENERAL]: [5], [EMOTIONAL]: [5] } });
  const { state, events } = await run(bookOf(1), ai, { brief: brief(1), options: { ...FAST, ...READERS, review: { maxRounds: 2, readersTarget: 7.5 } } });
  assert.equal(state.status, "completed", state.lastError?.message);
  assert.equal(ai.decided.length, 2, "the two rounds allowed");
  assert.deepEqual(reviewSteps(ai).filter((step) => step === "reader").length, 6, "the first reading, and one after each round");
  assert.equal(state.plan.chapters[0].status, "done", "the chapter is closed all the same");
  const missed = insights(events, "readersTargetMissed");
  assert.equal(missed.length, 1);
  assert.deepEqual([missed[0].tone, missed[0].chapterNumber, missed[0].figures], ["warning", 1, { round: 2, readers: 5, readersTarget: 7.5 }]);
  assert.match(missed[0].title, /Chapter 1 closed under the readers' target: the readers' average 5\/10 is under 7\.5\/10/);
  assert.match(missed[0].detail, /rounds of review allowed \(2\) are used/);
  assert.equal(roundsOf(state).at(-1).reading, "end", "the column has the vote of the text as it is");
});

test("a plateau stops a chapter before the rounds do: the corrections did not bring the readers closer", async () => {
  const ai = readingAi({ chapters: { 1: [["approve", 8, true]] }, books: [8], votes: { [GENERAL]: [5], [EMOTIONAL]: [5] } });
  const { state, events } = await run(bookOf(1), ai, { brief: brief(1), options: { ...FAST, ...READERS, review: { maxRounds: 5, readersTarget: 7.5 } } });
  assert.equal(state.status, "completed", state.lastError?.message);
  assert.equal(ai.decided.length, 2, "the second reading was no closer than the first: no third round");
  const missed = insights(events, "readersTargetMissed");
  assert.equal(missed.length, 1);
  assert.match(missed[0].detail, /did not bring the readers closer to their target/);
  assert.equal(state.plan.chapters[0].status, "done");
});

test("a target for each reader, and a reader that does not count: it is read and shown, and has no say in the average or in the gate", async () => {
  // The critical reader gives 3 and asks 9, and does not count; the emotional one gives 6 and is asked 8; the average of the two that count is 6.5.
  const votes = { [GENERAL]: [7], [EMOTIONAL]: [6], [CRITICAL]: [3] };
  const ai = readingAi({ chapters: { 1: [["approve", 8, true]] }, books: [8], votes });
  const review = { maxRounds: 2, readersTarget: 6, readerTargets: { [EMOTIONAL]: 8, [CRITICAL]: 9 }, readersExcluded: [CRITICAL] };
  const { state, events } = await run(bookOf(1), ai, { brief: brief(1), options: { ...FAST, readers: true, maxReaders: 3, review } });
  assert.equal(state.status, "completed", state.lastError?.message);
  assert.equal(ai.readings.filter((reading) => reading.slug === CRITICAL).length, 3, "the reader that does not count reads every time: at the start, and after each round");
  const first = roundsOf(state)[0];
  assert.deepEqual([first.readers, first.readerVotes], [6.5, { [GENERAL]: 7, [EMOTIONAL]: 6, [CRITICAL]: 3 }], "the average is of the readers that count, the votes are all there");
  assert.match(ai.decided[1].user, /- Emotional Reader: 6\/10 now, target 8\/10/);
  assert.match(ai.decided[1].user, /- Critical Reader: does not count \(left out of the average and of the targets\)/);
  assert.doesNotMatch(ai.decided[1].user, /Critical Reader: [0-9]+\/10 now, target/, "its target is not asked of it");
  assert.match(ai.decided[1].user, /Critical Reader \(weight 1\): 3\/10/, "the director still sees what it said");
  const missed = insights(events, "readersTargetMissed");
  assert.equal(missed.length, 1);
  assert.match(missed[0].title, /^Chapter 1 closed under the readers' target: Emotional Reader gives 6\/10, under the 8\/10 asked of this reader$/, "the average (6.5 over 6) is met: it is the reader that stands in the way, by name");
  assert.deepEqual(missed[0].figures, { round: 2, readersUnder: 1 }, "the figures say how many readers were under their own target, and the average only when it stood in the way");
});

test("a chapter is closed at the director's target and the readers' average together, and the director's own target is not given up for the readers'", async () => {
  // The readers are content at once (9 over 7.5), the director is not (7 under 8): the director's rule is the one it always was.
  const ai = readingAi({ chapters: { 1: [["approve", 7, true], ["approve", 8.5, true]] }, books: [8.5], votes: { [GENERAL]: [9], [EMOTIONAL]: [9] } });
  const { state } = await run(bookOf(1), ai, { brief: brief(1), options: { ...FAST, ...READERS, review: { targetScore: 8, maxRounds: 3, readersTarget: 7.5 } } });
  assert.deepEqual(ai.decided.map((entry) => [entry.round, entry.score]), [[1, 7], [2, 8.5]]);
  assert.deepEqual(roundsOf(state).map((round) => round.verdict), ["revise", "approve", undefined], "7 under the target 8 is withheld, as it always was; the closing reading is a round without a verdict");
  assert.equal(state.plan.chapters[0].score, 8.5);
});

test("the readers' targets do not touch a run in which the readers do not read, or whose only readers do not count", async () => {
  const off = readingAi({ chapters: { 1: [["approve", 8, true]] }, books: [8] });
  const first = await run(bookOf(1), off, { brief: brief(1), options: { ...FAST, readers: false, review: { readersTarget: 9 } } });
  assert.equal(first.state.status, "completed", first.state.lastError?.message);
  assert.equal(off.readings.length, 0);
  assert.deepEqual(reviewSteps(off), ["autopilot:specialists", "autopilot:director-review", "autopilot:repair", "autopilot:consolidate", "director:book"]);

  const lonely = readingAi({ chapters: { 1: [["approve", 8, true]] }, books: [8], votes: { [GENERAL]: [2] } });
  const second = await run(bookOf(1), lonely, { brief: brief(1), options: { ...FAST, readers: true, maxReaders: 1, review: { readersTarget: 9, readersExcluded: [GENERAL] } } });
  assert.equal(second.state.status, "completed", second.state.lastError?.message);
  assert.deepEqual(reviewSteps(lonely), ["reader", "summary", "autopilot:specialists", "autopilot:director-review", "autopilot:repair", "autopilot:consolidate", "director:book"], "the only reader does not count: there is nothing to reach, and no reading again");
});

test("the readers that read at the start of a round in which the director sends the chapter back are recorded with that round, after a closing reading of their own", async () => {
  // Round 1: read (5), approved with a fix, read again (6, not enough); round 2: sent back (7 under 8); round 3: read at its start (6), approved with a fix, read again (8).
  const ai = readingAi({
    chapters: { 1: [["approve", 9, true], ["revise", 7], ["approve", 9, true]] },
    books: [9],
    votes: { [GENERAL]: [5, 6, 6, 8], [EMOTIONAL]: [5, 6, 6, 8] },
  });
  const { state } = await run(bookOf(1), ai, { brief: brief(1), options: { ...FAST, ...READERS, review: { targetScore: 8, maxRounds: 5, readerRounds: 4, readersTarget: 7.5 } } });
  assert.equal(state.status, "completed", state.lastError?.message);
  assert.deepEqual(roundsOf(state).map((round) => [round.director, round.readers, round.round, round.reading, round.verdict]), [
    [9, 5, 1, undefined, "approve"],
    [undefined, 6, 1, "end", undefined],
    [7, undefined, undefined, undefined, "revise"],
    [9, 6, 3, undefined, "approve"],
    [undefined, 8, 3, "end", undefined],
  ]);
  assert.deepEqual(ai.readings.map((reading) => reading.number).filter((number, index) => index % 2 === 0), [1, 2, 3, 4], "four readings by each reader");
});

test("a reading that nobody answers does not hold the chapter up, and says so", async () => {
  const ai = readingAi({ chapters: { 1: [["approve", 8, true]] }, books: [8], votes: { [GENERAL]: [6, 6], [EMOTIONAL]: [6, 6] } });
  const failing = { calls: ai.calls, decided: ai.decided, judged: ai.judged, readings: ai.readings, async complete(request) {
    // From the second reading of the chapter on the readers' answers are broken (no score): they are skipped, as a reader whose reply stays incomplete always was.
    if (request.label.startsWith("reader-evaluation:") && request.json?.name === "reader_evaluation" && ai.readings.length >= 2) {
      ai.calls.push(request);
      return { text: "{}", json: { generalImpression: "" }, usage: { inputTokens: 1, outputTokens: 1, cachedInputTokens: 0 }, model: "fake-model", provider: "fake", cost: 0, currency: "USD" };
    }
    return ai.complete(request);
  } };
  const { state, events } = await run(bookOf(1), failing, { brief: brief(1), options: { ...FAST, ...READERS, review: { readersTarget: 7.5 } } });
  assert.equal(state.status, "completed", state.lastError?.message);
  assert.equal(state.plan.chapters[0].status, "done");
  assert.ok(events.some((event) => event.type === "insight" && /No simulated reader gave a vote on chapter 1/.test(event.title)), "the targets could not be checked, and it says so");
});

test("a restart at any step of a review that waits for the readers goes on as the run that was not stopped", async () => {
  const script = () => readingAi({ chapters: { 1: [["approve", 8, true], ["approve", 8.5, true]] }, books: [8], votes: { [GENERAL]: [5, 6, 8], [EMOTIONAL]: [5, 6, 8] } });
  const options = { ...FAST, ...READERS, review: { targetScore: 8, maxRounds: 3, readersTarget: 7.5 } };
  const whole = script();
  const base = await run(bookOf(1), whole, { brief: brief(1), options });
  assert.equal(base.state.status, "completed", base.state.lastError?.message);
  const steps = base.events.filter((event) => event.type === "task-finished").length;
  assert.ok(steps > 15, `a run of ${steps} steps`);
  for (let stop = 1; stop < steps; stop += 1) {
    const ai = script();
    const store = bookOf(1);
    const first = await run(store, ai, { brief: brief(1), options, limits: { steps: stop } });
    assert.equal(first.state.status, "paused", `stopped after ${stop} steps`);
    // A new session over the same files: the host that started again.
    const second = await run(store, ai);
    assert.equal(second.state.status, "completed", `${stop}: ${second.state.lastError?.message}`);
    assert.deepEqual(reviewSteps(ai), reviewSteps(whole), `restarted after step ${stop}`);
    assert.deepEqual(roundsOf(second.state), roundsOf(base.state), `restarted after step ${stop}`);
    assert.equal(second.state.plan.chapters[0].score, base.state.plan.chapters[0].score);
  }
});

test("the money cap of the book stops a review that waits for the readers where it is, and raising it goes on as the run that was not stopped", async () => {
  const script = () => readingAi({ chapters: { 1: [["approve", 8, true], ["approve", 8.5, true]] }, books: [8], votes: { [GENERAL]: [5, 6, 8], [EMOTIONAL]: [5, 6, 8] } });
  const options = { ...FAST, ...READERS, review: { targetScore: 8, maxRounds: 3, readersTarget: 7.5 } };
  const whole = script();
  const base = await run(bookOf(1), whole, { brief: brief(1), options });
  const total = base.state.stats.cost;
  assert.ok(total > 0.02, `the run costs ${total}`);
  for (const share of [0.35, 0.5, 0.65, 0.8, 0.95]) {
    const ai = script();
    const store = bookOf(1);
    const first = await run(store, ai, { brief: brief(1), options: { ...options, budgetLimit: total * share } });
    assert.equal(first.state.status, "paused", `a cap at ${share} of the cost`);
    assert.equal(first.state.limitReached?.kind, "money");
    if (share <= 0.65) assert.notEqual(first.state.plan.chapters[0].status, "done", `a cap at ${share} of the cost stops inside the review`);
    const second = await run(store, ai, { options: { budgetLimit: 0 } });
    assert.equal(second.state.status, "completed", `${share}: ${second.state.lastError?.message}`);
    assert.deepEqual(reviewSteps(ai), reviewSteps(whole), `a cap at ${share} of the cost`);
    assert.deepEqual(roundsOf(second.state), roundsOf(base.state));
  }
});
