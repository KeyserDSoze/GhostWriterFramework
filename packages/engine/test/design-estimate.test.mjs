import test from "node:test";
import assert from "node:assert/strict";
import * as engine from "../dist/index.js";
import { MemoryBookStore, createFakeAutopilotAi, seedBookFiles } from "../dist/testing/index.js";
import { estimateTexts } from "../dist/autopilot/estimate-texts.js";
import { CAPABILITIES, KINDS, countByKind, uniform } from "./estimate-fakes.mjs";

// The estimate of a design that does more than the plain design (`EstimateDesign.workflow`): the pitches, what each reader and the director think of them, the review of every
// chapter, the analysis of the structure and the rubric of the director and the readers are calls, and the estimate counts them as the pipeline makes them.

const { AutopilotSession, DESIGN_REVIEW_BATCH_CHAPTERS, ESTIMATE_CALL_KINDS, estimateAutopilotRun, parseAutopilotState, writeOutlineBrief } = engine;

const WORKFLOW = { rubric: true, chapterReview: true, coherence: true, alternatives: 3 };
const OPTIONS = { readersOnPlan: true, maxReaders: 2, pauseAfterPlan: false };
const NEW_KINDS = ["design-pitches", "design-pitch-reader", "design-pitch-review", "design-chapter-review", "design-coherence"];

const estimate = (design = {}, extra = {}) => estimateAutopilotRun({ design: { maxRounds: 3, readerRounds: 1, ...design }, outline: { lastChapter: 12 }, options: { readersOnPlan: true, maxReaders: 2 }, models: uniform(), ...extra });

test("the kinds of call are the ones the pipeline makes, in its order, and each has its words in both languages", () => {
  assert.deepEqual([...ESTIMATE_CALL_KINDS], KINDS);
  for (const kind of NEW_KINDS) assert.ok(ESTIMATE_CALL_KINDS.includes(kind), kind);
  const said = (italian, kind) => estimateTexts(italian).smallWindow("director", "m", 1000, 500, 600, kind, false);
  for (const kind of NEW_KINDS) assert.notEqual(said(false, kind).match(/«([^«»]+)»[^«»]*$/)?.[1], said(true, kind).match(/«([^«»]+)»[^«»]*$/)?.[1], kind);
  assert.match(said(false, "design-coherence"), /in the step «analysis of the structure of the design»/);
  assert.match(said(true, "design-chapter-review"), /nel passo «revisione dei capitoli del progetto»/);
  assert.match(said(false, "design-pitch-reader"), /«reader's reaction to the pitches»/);
});

test("a design with the reviews asks for their calls: the pitches, the readers' reactions to them, the director's choice, the chapters in batches, the analysis, each again in every round", () => {
  const plain = estimate();
  const full = estimate({ workflow: WORKFLOW });
  for (const kind of NEW_KINDS) assert.equal(plain.steps[kind].calls.max, 0, `${kind} is not asked for by a plain design`);
  assert.deepEqual(full.steps["design-pitches"].calls, { min: 1, max: 1 });
  assert.deepEqual(full.steps["design-pitch-reader"].calls, { min: 2, max: 2 }, "two readers");
  assert.deepEqual(full.steps["design-pitch-review"].calls, { min: 1, max: 1 });
  assert.deepEqual(full.steps["design-chapter-review"].calls, { min: 3, max: 9 }, "twelve chapters, four a call, again after each of the two revisions at the most");
  assert.deepEqual(full.steps["design-coherence"].calls, { min: 1, max: 3 }, "one window, again after each revision");
  for (const kind of ["concept", "plan", "plan-reader", "plan-review"]) assert.deepEqual(full.steps[kind].calls, plain.steps[kind].calls, `${kind} keeps its calls`);
  assert.ok(full.calls.max > plain.calls.max && full.calls.min > plain.calls.min);
  assert.ok(full.inputTokens.max > plain.inputTokens.max);
  assert.ok(full.outputTokens.min > plain.outputTokens.min);
  assert.ok(full.cost.max > plain.cost.max);
  assert.equal(DESIGN_REVIEW_BATCH_CHAPTERS, 4);
  // The rubric makes the replies and the prompts of the readers and of the director bigger, and nothing else does.
  const rubric = estimate({ workflow: { rubric: true } });
  assert.deepEqual(rubric.calls, plain.calls);
  assert.ok(rubric.steps["plan-review"].outputTokens.min > plain.steps["plan-review"].outputTokens.min);
  assert.ok(rubric.steps["plan-reader"].outputTokens.min > plain.steps["plan-reader"].outputTokens.min);
  assert.ok(rubric.steps["plan-review"].inputTokens.min > plain.steps["plan-review"].inputTokens.min);
  // The capability each call is billed to.
  assert.ok(full.capabilities.review.calls.max >= 3, "the analysis is the specialist's");
  assert.ok(full.capabilities["reader-evaluation"].calls.max >= plain.capabilities["reader-evaluation"].calls.max + 2);
});

test("a long design is analysed in windows, a design with no readers has no reactions to the pitches, and what is already designed has no pitches", () => {
  const long = estimate({ workflow: { coherence: true } }, { outline: { lastChapter: 100 } });
  assert.deepEqual(long.steps["design-coherence"].calls, { min: 3, max: 9 }, "a hundred chapters, three windows of forty that overlap");
  const quiet = estimate({ workflow: WORKFLOW }, { options: { readersOnPlan: false } });
  assert.equal(quiet.steps["design-pitch-reader"].calls.max, 0);
  assert.equal(quiet.steps["design-pitch-review"].calls.max, 1);
  const done = estimate({ workflow: WORKFLOW }, { progress: { conceptDone: true } });
  assert.equal(done.steps["design-pitches"].calls.max, 0);
  assert.equal(done.steps["design-pitch-review"].calls.max, 0);
  assert.equal(done.steps["design-chapter-review"].calls.max, 9, "the chapters are reviewed all the same");
  // A workflow the engine would refuse is not estimated.
  const refused = estimate({ workflow: { alternatives: 1, rubric: "yes" } });
  assert.equal(refused.steps["design-pitches"].calls.max, 0);
  assert.deepEqual(refused.calls, estimate().calls);
});

test("the assumptions say what the design does besides the plain design, in the language of the book", () => {
  const plain = estimate();
  assert.equal(plain.assumptions.some((line) => /^The design also/.test(line)), false);
  const english = estimate({ workflow: WORKFLOW }).assumptions.find((line) => /^The design also/.test(line));
  assert.match(english, /^The design also proposes 3 alternative pitches judged by the director and the readers, reviews every chapter with the chapters beside it, four a call, analyses the whole structure for contradictions and plot holes and asks the director and the readers for the twelve criteria of the rubric\./);
  assert.match(english, /the worst case repeats them all\.$/);
  const italian = estimate({ workflow: { chapterReview: true } }, { language: "it" }).assumptions.find((line) => /^Il progetto /.test(line) && /rivede ogni capitolo/.test(line));
  assert.match(italian, /^Il progetto rivede ogni capitolo insieme a quelli accanto, quattro per chiamata\./);
  assert.equal(estimate({ workflow: WORKFLOW }).assumptions[0].startsWith("The design covers 12 chapters"), true);
});

// ─── Against the pipeline ───────────────────────────────────────────────────

async function describedBook() {
  const store = new MemoryBookStore(seedBookFiles({ chapters: 0, title: "The Glass Harbor" }));
  await writeOutlineBrief(store, { idea: "A harbor town built on glass hides a lie that the tide will tell.", genre: "mystery", audience: "adults", wordsPerScene: 200 });
  return store;
}

async function runDesign(ai) {
  const store = await describedBook();
  const session = new AutopilotSession({ bookId: "book", store, ai, host: "browser", hostLabel: "test", retryDelayMs: 0, now: () => new Date("2026-11-28T09:00:00.000Z") });
  await session.start({ design: { chapters: 12, review: { maxRounds: 3, readerRounds: 1 }, workflow: WORKFLOW }, options: OPTIONS });
  await session.waitForIdle();
  return parseAutopilotState(store.files.get("autopilot/state.json"));
}

const approve = { verdict: "approve", score: 9, summary: "Fine.", strengths: [], changes: [], guidance: [], critical: [], counterProposal: "x" };

test("the calls are exact: a design that is approved at once makes the best case of the estimate, call by call", async () => {
  const ai = createFakeAutopilotAi({ designReview: () => approve });
  const state = await runDesign(ai);
  assert.equal(state.design.outcome, "target", state.lastError?.message);
  const made = countByKind(ai.calls);
  const said = estimate({ workflow: WORKFLOW }, { scenario: { planRevisions: 0 } });
  for (const kind of KINDS) assert.equal(made[kind], said.steps[kind].calls.max, `${kind}: made ${made[kind]}`);
  assert.deepEqual(Object.fromEntries(NEW_KINDS.map((kind) => [kind, made[kind]])), { "design-pitches": 1, "design-pitch-reader": 2, "design-pitch-review": 1, "design-chapter-review": 3, "design-coherence": 1 });
});

test("the calls are exact: a design revised in every round makes the worst case of the estimate, call by call", async () => {
  const ai = createFakeAutopilotAi({
    designReview: (round) => (round < 3 ? { ...approve, verdict: "revise", score: 6, changes: [{ instruction: `Push every chapter harder, for the ${["first", "second"][round - 1]} time.` }] } : approve),
  });
  const state = await runDesign(ai);
  assert.equal(state.design.rounds.length, 3, state.lastError?.message);
  const made = countByKind(ai.calls);
  const said = estimate({ workflow: WORKFLOW });
  for (const kind of KINDS) assert.equal(made[kind], said.steps[kind].calls.max, `${kind}: made ${made[kind]}`);
});

test("the tokens of the new calls are near what the pipeline sent, in and out, in the worst case: the estimate is an upper bound within a reason", async () => {
  const ai = createFakeAutopilotAi({ designReview: () => approve });
  await runDesign(ai);
  const said = estimate({ workflow: WORKFLOW }, { scenario: { planRevisions: 0 } });
  for (const kind of NEW_KINDS) {
    const calls = ai.calls.filter((call) => countByKind([call])[kind] === 1);
    const sent = calls.reduce((total, call) => total + Math.ceil((call.system.length + call.user.length) / 4), 0);
    assert.ok(said.steps[kind].inputTokens.max > 0 && sent > 0, kind);
    assert.ok(said.steps[kind].inputTokens.max > sent * 0.25 && said.steps[kind].inputTokens.max < sent * 12, `${kind}: estimated ${Math.round(said.steps[kind].inputTokens.max)} in, sent about ${sent}`);
  }
  assert.equal(CAPABILITIES.length, 6);
});
