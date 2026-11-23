import test from "node:test";
import assert from "node:assert/strict";
import * as engine from "../dist/index.js";
import { continuitySystemPrompt, SCENE_SUMMARY_TOOL } from "../dist/autopilot/prompts.js";
import { CAPABILITIES, KINDS, MODEL, uniform } from "./estimate-fakes.mjs";

// New exports are read from the namespace so that, before they exist, each test fails on its own.
const { ESTIMATE_CALL_KINDS, ESTIMATE_CAPABILITIES, ESTIMATE_TYPICAL, createAutopilotState, estimateAutopilotRun, estimateContextFromState, estimateModelsFromConfig, estimateProgressFromChapters, estimateProgressFromState, likelyTextTokens, pickAiRuntimeConfig, resolveModelTokenBudgets, scaleOutputTokens, tokensPerWord } = engine;

// The books the interface offers first. Their values are written out here: the tests of the estimate do not depend on the presets.
const STORY = { brief: { targetChapters: 4, scenesPerChapter: 2, wordsPerScene: 900 }, options: { readers: true, maxReaders: 3, readersOnPlan: false, specialists: true }, maxReviewRounds: 2 };
const NOVELLA = { brief: { targetChapters: 12, scenesPerChapter: 3, wordsPerScene: 1400 }, options: { readers: true, maxReaders: 5, readersOnPlan: true, specialists: true }, maxReviewRounds: 2 };
const DRAFT = { brief: { targetChapters: 24, scenesPerChapter: 3, wordsPerScene: 1500 }, options: { readers: true, maxReaders: 3, readersOnPlan: true, specialists: true }, maxReviewRounds: 1 };

// The chapters are the outline's, and the scenes a host expects are the estimate's own input: the brief keeps the words of a scene.
const shaped = (input) => {
  const { brief = {}, ...rest } = input;
  const { targetChapters, scenesPerChapter, ...words } = brief;
  return {
    ...rest,
    brief: words,
    ...(scenesPerChapter === undefined ? {} : { scenesPerChapter }),
    ...(targetChapters === undefined ? {} : { outline: { lastChapter: targetChapters, entries: targetChapters, ...rest.outline } }),
  };
};
const estimate = (input, extra = {}) => estimateAutopilotRun({ models: uniform(), ...shaped(input), ...extra });
const zero = Object.fromEntries(KINDS.map((kind) => [kind, [0, 0]]));
const stepsOf = (result) => Object.fromEntries(KINDS.map((kind) => [kind, [result.steps[kind].calls.min, result.steps[kind].calls.max]]));
const capabilitiesOf = (result) => Object.fromEntries(CAPABILITIES.map((capability) => [capability, [result.capabilities[capability].calls.min, result.capabilities[capability].calls.max]]));
const rangeOf = (range) => [range.min, range.max];
const near = (actual, expected, tolerance, message) => assert.ok(Math.abs(actual - expected) <= tolerance, `${message ?? ""} ${actual} is not within ${tolerance} of ${expected}`);
const warningsOf = (result, code) => result.warnings.filter((warning) => warning.code === code);

// ─── The numbers of the pipeline, worked out by hand ────────────────────────
//
// A chapter of S scenes read by R readers, reviewed by the specialists (E = 1 or 0) in r rounds, with p scenes repaired in all, costs:
//   writer (autopilot)         1 scene plan + S scenes + p repairs + 1 consolidation          = 2 + S + p
//   simple tasks               1 summary for each scene written and for each repaired         = S + p
//   readers                    R
//   readers' summary           1 when R > 0
//   specialists (review)       E × r
//   director                   r
// The plan is B = ceil(chapters / 20) calls, asked again (at most B calls) after each of at most two revisions the director asks for; the director
// reviews it once, and once more after each revision; the readers read it once. Then the final review of the book: one director call.
//   best case:  r = 1, p = 0, no revision of the plan.          worst case: r = M, p = M × S, two revisions.

const CASES = [
  {
    name: "a story: four short chapters",
    input: STORY,
    total: [52, 96],
    words: 7200,
    steps: { concept: [1, 1], plan: [1, 3], "plan-review": [1, 3], scenes: [4, 4], write: [8, 8], "scene-summary": [8, 24], reader: [12, 12], "readers-summary": [4, 4], specialists: [4, 8], "director-review": [4, 8], repair: [0, 16], consolidate: [4, 4], final: [1, 1] },
    capabilities: { autopilot: [18, 36], director: [6, 12], "reader-evaluation": [12, 12], "reader-evaluation-summary": [4, 4], review: [4, 8], "simple-tasks": [8, 24] },
    prose: { write: [17_280, 17_280], repair: [0, 34_560] },
  },
  {
    name: "a short novel: twelve chapters of three scenes",
    input: NOVELLA,
    total: [201, 373],
    words: 50_400,
    steps: { concept: [1, 1], plan: [1, 3], "plan-reader": [5, 5], "plan-review": [1, 3], scenes: [12, 12], write: [36, 36], "scene-summary": [36, 108], reader: [60, 60], "readers-summary": [12, 12], specialists: [12, 24], "director-review": [12, 24], repair: [0, 72], consolidate: [12, 12], final: [1, 1] },
    capabilities: { autopilot: [62, 136], director: [14, 28], "reader-evaluation": [65, 65], "reader-evaluation-summary": [12, 12], review: [12, 24], "simple-tasks": [36, 108] },
    prose: { write: [120_960, 120_960], repair: [0, 241_920] },
  },
  {
    name: "a draft of a novel: twenty-four chapters, planned in two batches, one round of review",
    input: DRAFT,
    total: [344, 494],
    words: 108_000,
    steps: { concept: [1, 1], plan: [2, 6], "plan-reader": [3, 3], "plan-review": [1, 3], scenes: [24, 24], write: [72, 72], "scene-summary": [72, 144], reader: [72, 72], "readers-summary": [24, 24], specialists: [24, 24], "director-review": [24, 24], repair: [0, 72], consolidate: [24, 24], final: [1, 1] },
    capabilities: { autopilot: [123, 199], director: [26, 28], "reader-evaluation": [75, 75], "reader-evaluation-summary": [24, 24], review: [24, 24], "simple-tasks": [72, 144] },
    prose: { write: [259_200, 259_200], repair: [0, 259_200] },
  },
  {
    name: "a book that is half way: five of its twelve chapters are done and the plan is approved",
    input: { ...NOVELLA, progress: { chaptersDone: 5, planned: 12, conceptDone: true } },
    total: [113, 211],
    words: 29_400,
    steps: { scenes: [7, 7], write: [21, 21], "scene-summary": [21, 63], reader: [35, 35], "readers-summary": [7, 7], specialists: [7, 14], "director-review": [7, 14], repair: [0, 42], consolidate: [7, 7], final: [1, 1] },
    capabilities: { autopilot: [35, 77], director: [8, 15], "reader-evaluation": [35, 35], "reader-evaluation-summary": [7, 7], review: [7, 14], "simple-tasks": [21, 63] },
    prose: { write: [70_560, 70_560], repair: [0, 141_120] },
  },
  {
    name: "chapters added to a finished book: twelve are done, the author asks for eighteen",
    input: { ...NOVELLA, brief: { ...NOVELLA.brief, targetChapters: 18 }, progress: { chaptersDone: 12, planned: 12, conceptDone: true } },
    total: [99, 187],
    words: 25_200,
    steps: { plan: [1, 3], "plan-review": [1, 3], scenes: [6, 6], write: [18, 18], "scene-summary": [18, 54], reader: [30, 30], "readers-summary": [6, 6], specialists: [6, 12], "director-review": [6, 12], repair: [0, 36], consolidate: [6, 6], final: [1, 1] },
    capabilities: { autopilot: [31, 69], director: [8, 16], "reader-evaluation": [30, 30], "reader-evaluation-summary": [6, 6], review: [6, 12], "simple-tasks": [18, 54] },
    prose: { write: [60_480, 60_480], repair: [0, 120_960] },
  },
  {
    name: "an outline that asks for twenty chapters when the brief says twelve: the book has twenty",
    input: { ...NOVELLA, outline: { entries: 20, lastChapter: 20 } },
    total: [329, 613],
    words: 84_000,
    steps: { concept: [1, 1], plan: [1, 3], "plan-reader": [5, 5], "plan-review": [1, 3], scenes: [20, 20], write: [60, 60], "scene-summary": [60, 180], reader: [100, 100], "readers-summary": [20, 20], specialists: [20, 40], "director-review": [20, 40], repair: [0, 120], consolidate: [20, 20], final: [1, 1] },
    capabilities: { autopilot: [102, 224], director: [22, 44], "reader-evaluation": [105, 105], "reader-evaluation-summary": [20, 20], review: [20, 40], "simple-tasks": [60, 180] },
    prose: { write: [201_600, 201_600], repair: [0, 403_200] },
  },
  {
    name: "no simulated readers, on the chapters or on the plan",
    input: { ...NOVELLA, options: { ...NOVELLA.options, readers: false, readersOnPlan: false } },
    total: [124, 296],
    words: 50_400,
    steps: { concept: [1, 1], plan: [1, 3], "plan-review": [1, 3], scenes: [12, 12], write: [36, 36], "scene-summary": [36, 108], specialists: [12, 24], "director-review": [12, 24], repair: [0, 72], consolidate: [12, 12], final: [1, 1] },
    capabilities: { autopilot: [62, 136], director: [14, 28], "reader-evaluation": [0, 0], "reader-evaluation-summary": [0, 0], review: [12, 24], "simple-tasks": [36, 108] },
    prose: { write: [120_960, 120_960], repair: [0, 241_920] },
  },
  {
    name: "no specialists",
    input: { ...NOVELLA, options: { ...NOVELLA.options, specialists: false } },
    total: [189, 349],
    words: 50_400,
    steps: { concept: [1, 1], plan: [1, 3], "plan-reader": [5, 5], "plan-review": [1, 3], scenes: [12, 12], write: [36, 36], "scene-summary": [36, 108], reader: [60, 60], "readers-summary": [12, 12], "director-review": [12, 24], repair: [0, 72], consolidate: [12, 12], final: [1, 1] },
    capabilities: { autopilot: [62, 136], director: [14, 28], "reader-evaluation": [65, 65], "reader-evaluation-summary": [12, 12], review: [0, 0], "simple-tasks": [36, 108] },
    prose: { write: [120_960, 120_960], repair: [0, 241_920] },
  },
  {
    name: "the review fixed to two rounds with one scene repaired, and the plan approved as it is: the range is one number",
    input: { ...NOVELLA, scenario: { rounds: 2, repairs: 1, planRevisions: 0 } },
    total: [249, 249],
    words: 50_400,
    steps: { concept: [1, 1], plan: [1, 1], "plan-reader": [5, 5], "plan-review": [1, 1], scenes: [12, 12], write: [36, 36], "scene-summary": [48, 48], reader: [60, 60], "readers-summary": [12, 12], specialists: [24, 24], "director-review": [24, 24], repair: [12, 12], consolidate: [12, 12], final: [1, 1] },
    capabilities: { autopilot: [74, 74], director: [26, 26], "reader-evaluation": [65, 65], "reader-evaluation-summary": [12, 12], review: [24, 24], "simple-tasks": [48, 48] },
    prose: { write: [120_960, 120_960], repair: [40_320, 40_320] },
  },
  {
    name: "the plan revised twice, every chapter reviewed twice with one repair",
    input: { ...NOVELLA, scenario: { rounds: 2, repairs: 1, planRevisions: 2 } },
    total: [253, 253],
    words: 50_400,
    steps: { concept: [1, 1], plan: [3, 3], "plan-reader": [5, 5], "plan-review": [3, 3], scenes: [12, 12], write: [36, 36], "scene-summary": [48, 48], reader: [60, 60], "readers-summary": [12, 12], specialists: [24, 24], "director-review": [24, 24], repair: [12, 12], consolidate: [12, 12], final: [1, 1] },
    capabilities: { autopilot: [76, 76], director: [28, 28], "reader-evaluation": [65, 65], "reader-evaluation-summary": [12, 12], review: [24, 24], "simple-tasks": [48, 48] },
    prose: { write: [120_960, 120_960], repair: [40_320, 40_320] },
  },
  {
    name: "only the rounds fixed: the repairs still go from the least a second round needs to every scene in both rounds",
    input: { ...NOVELLA, scenario: { rounds: 2 } },
    total: [249, 373],
    words: 50_400,
    steps: { concept: [1, 1], plan: [1, 3], "plan-reader": [5, 5], "plan-review": [1, 3], scenes: [12, 12], write: [36, 36], "scene-summary": [48, 108], reader: [60, 60], "readers-summary": [12, 12], specialists: [24, 24], "director-review": [24, 24], repair: [12, 72], consolidate: [12, 12], final: [1, 1] },
    capabilities: { autopilot: [74, 136], director: [26, 28], "reader-evaluation": [65, 65], "reader-evaluation-summary": [12, 12], review: [24, 24], "simple-tasks": [48, 108] },
    prose: { write: [120_960, 120_960], repair: [40_320, 241_920] },
  },
];

for (const entry of CASES) {
  test(`${entry.name}: the calls, by kind of call and by capability, as the pipeline makes them`, () => {
    const result = estimate(entry.input);
    assert.deepEqual(stepsOf(result), { ...zero, ...entry.steps }, "by kind of call");
    assert.deepEqual(capabilitiesOf(result), entry.capabilities, "by capability");
    assert.deepEqual(rangeOf(result.calls), entry.total, "in all");
    assert.equal(result.words, entry.words, "the words the run writes, at the length the brief asks");
    for (const [kind, expected] of Object.entries(entry.prose)) assert.deepEqual(rangeOf(result.steps[kind].outputTokens), expected, `the prose of ${kind}, at 2.4 tokens a word`);
    const sum = (select) => KINDS.reduce((total, kind) => total + select(result.steps[kind]), 0);
    assert.equal(sum((step) => step.calls.min), result.calls.min, "the kinds add up to the total (best case)");
    assert.equal(sum((step) => step.calls.max), result.calls.max, "the kinds add up to the total (worst case)");
    for (const field of ["inputTokens", "outputTokens"]) {
      assert.equal(sum((step) => step[field].min), result[field].min, `${field}: the kinds add up (best case)`);
      assert.equal(sum((step) => step[field].max), result[field].max, `${field}: the kinds add up (worst case)`);
      assert.equal(CAPABILITIES.reduce((total, capability) => total + result.capabilities[capability][field].min, 0), result[field].min, `${field}: the capabilities add up (best case)`);
      assert.equal(CAPABILITIES.reduce((total, capability) => total + result.capabilities[capability][field].max, 0), result[field].max, `${field}: the capabilities add up (worst case)`);
    }
  });
}

test("the estimate says calls, tokens, cost, time, warnings and assumptions, in whole numbers and ranges that never run backwards", () => {
  const result = estimate(NOVELLA);
  for (const key of ["language", "chapters", "chaptersToWrite", "words", "calls", "inputTokens", "cachedInputTokens", "outputTokens", "cost", "unpriced", "minutes", "unmeasured", "capabilities", "steps", "warnings", "assumptions"]) assert.ok(key in result, key);
  assert.deepEqual([...ESTIMATE_CAPABILITIES].sort(), [...CAPABILITIES].sort(), "the six capabilities of the router that the autopilot uses");
  assert.deepEqual([...ESTIMATE_CALL_KINDS], KINDS, "the kinds of call, in the order the pipeline makes them");
  assert.deepEqual(Object.keys(result.capabilities).sort(), [...CAPABILITIES].sort());
  assert.deepEqual(Object.keys(result.steps), KINDS);
  assert.equal(result.chapters, 12);
  assert.equal(result.chaptersToWrite, 12);
  assert.equal(result.language, "en");
  const ranges = [result.calls, result.inputTokens, result.cachedInputTokens, result.outputTokens, ...KINDS.flatMap((kind) => [result.steps[kind].calls, result.steps[kind].inputTokens, result.steps[kind].outputTokens]), ...CAPABILITIES.flatMap((capability) => [result.capabilities[capability].calls, result.capabilities[capability].inputTokens, result.capabilities[capability].outputTokens])];
  for (const range of ranges) assert.ok(Number.isInteger(range.min) && Number.isInteger(range.max) && range.min >= 0 && range.min <= range.max, JSON.stringify(range));
  const unused = estimate({ ...NOVELLA, options: { ...NOVELLA.options, readers: false, readersOnPlan: false } });
  for (const kind of ["reader", "plan-reader", "readers-summary", "summarize-imported"]) assert.deepEqual([unused.steps[kind].inputTokens.max, unused.steps[kind].outputTokens.max], [0, 0], `${kind}: a step that makes no call weighs nothing`);
  assert.ok(result.assumptions.length >= 4 && result.assumptions.every((line) => typeof line === "string" && line.length > 20), "a few sentences");
});

test("a book is estimated with what the engine would make of the values: the defaults of a new book, and the limits the autopilot keeps", () => {
  assert.deepEqual(rangeOf(estimateAutopilotRun({ models: uniform(), outline: { entries: 12, lastChapter: 12 } }).calls), rangeOf(estimate(NOVELLA).calls), "no brief, no options: twelve chapters of three scenes, as the autopilot starts");
  const wild = estimate({ brief: { targetChapters: 1, scenesPerChapter: 500, wordsPerScene: 1 }, options: { maxReaders: 99 }, maxReviewRounds: 9 });
  assert.equal(wild.chapters, 1, "at least a chapter");
  const scenes = 20;
  assert.equal(wild.steps.scenes.calls.min, 1);
  assert.equal(wild.steps.write.calls.min, scenes, "at most twenty scenes to a chapter");
  assert.equal(wild.steps.write.outputTokens.min, Math.round(scenes * 200 * 2.4), "and at least two hundred words to a scene");
  assert.equal(wild.steps.reader.calls.min, 8, "the panel has eight readers, whatever the author asks for");
  assert.equal(wild.steps["director-review"].calls.max, 3, "a director judges a chapter three times at most");
  for (const garbage of [null, undefined, Number.NaN, "x", {}, [], -5, Number.POSITIVE_INFINITY]) {
    const result = estimateAutopilotRun({ brief: { targetChapters: garbage, scenesPerChapter: garbage, wordsPerScene: garbage }, options: { maxReaders: garbage, readers: garbage }, maxReviewRounds: garbage, progress: garbage, outline: garbage, scenario: garbage, context: garbage, models: garbage });
    assert.ok(Number.isInteger(result.calls.min) && result.calls.min > 0, `garbage ${String(garbage)} is the default`);
  }
});

test("the chapters are planned twenty to a call, and each revision of the plan asks again", () => {
  const plan = (chapters) => estimate({ brief: { targetChapters: chapters, scenesPerChapter: 1, wordsPerScene: 300 }, options: { readers: false, readersOnPlan: false, specialists: false } }).steps.plan.calls;
  assert.deepEqual(rangeOf(plan(1)), [1, 3]);
  assert.deepEqual(rangeOf(plan(20)), [1, 3]);
  assert.deepEqual(rangeOf(plan(21)), [2, 6]);
  assert.deepEqual(rangeOf(plan(40)), [2, 6]);
  assert.deepEqual(rangeOf(plan(41)), [3, 9]);
  assert.deepEqual(rangeOf(estimate({ brief: { targetChapters: 100, scenesPerChapter: 1, wordsPerScene: 300 } }).steps.plan.calls), [5, 15]);
});

test("the readers are the enabled ones of the panel, at most the author's number, for the chapters and for the plan alike", () => {
  const readers = (options, extra = {}) => { const result = estimate({ brief: { targetChapters: 2, scenesPerChapter: 1, wordsPerScene: 300 }, options, ...extra }); return [result.steps.reader.calls.min, result.steps["plan-reader"].calls.min]; };
  assert.deepEqual(readers({ maxReaders: 5 }), [10, 5]);
  assert.deepEqual(readers({ maxReaders: 20 }), [16, 8], "the built-in panel has eight readers: more cannot be asked");
  assert.deepEqual(readers({ maxReaders: 2 }), [4, 2]);
  assert.deepEqual(readers({ maxReaders: 5 }, { readerPanelSize: 3 }), [6, 3], "a panel the host knows is smaller");
  assert.deepEqual(readers({ maxReaders: 5 }, { readerPanelSize: 12 }), [10, 5], "or larger");
  assert.deepEqual(readers({ maxReaders: 5, readers: false }), [0, 5], "the readers of the plan do not depend on the readers of the chapters");
  assert.deepEqual(readers({ maxReaders: 5, readersOnPlan: false }), [10, 0]);
  assert.deepEqual(readers({ maxReaders: 5 }, { readerPanelSize: 0 }), [0, 0], "a panel with nobody in it reads nothing, and no summary is asked");
  assert.equal(estimate({ brief: { targetChapters: 2, scenesPerChapter: 1, wordsPerScene: 300 }, readerPanelSize: 0 }).steps["readers-summary"].calls.max, 0);
});

test("chapters the author wrote and has not summarized each cost one call of the simple tasks, before the plan; the concept is skipped for a book with prose", () => {
  const result = estimate({ ...NOVELLA, progress: { chaptersDone: 3, withoutSummary: 3 } });
  assert.deepEqual(rangeOf(result.steps["summarize-imported"].calls), [3, 3]);
  assert.equal(result.steps["summarize-imported"].capability, "simple-tasks");
  assert.deepEqual(rangeOf(result.steps.concept.calls), [0, 0], "a book that has prose has its foundation");
  assert.equal(result.chaptersToWrite, 9);
  assert.deepEqual(rangeOf(result.steps.plan.calls), [1, 3]);
  assert.deepEqual(rangeOf(result.steps["plan-reader"].calls), [5, 5], "the plan of the rest is still read by the readers");
  assert.deepEqual(rangeOf(estimate({ ...NOVELLA, progress: { conceptDone: true } }).steps.concept.calls), [0, 0], "or a design the author wrote");
  assert.deepEqual(rangeOf(estimate({ ...NOVELLA, progress: { conceptDone: false, chaptersDone: 2 } }).steps.concept.calls), [1, 1], "unless the host says it is not done");
});

test("a finished book has nothing left to do, and one that is not judged yet has the director's last look", () => {
  const done = estimate({ ...NOVELLA, progress: { chaptersDone: 12, planned: 12, finalDone: true } });
  assert.deepEqual(rangeOf(done.calls), [0, 0]);
  assert.equal(done.chaptersToWrite, 0);
  assert.equal(done.words, 0);
  assert.deepEqual(rangeOf(estimate({ ...NOVELLA, progress: { chaptersDone: 12, planned: 12 } }).calls), [1, 1]);
  assert.deepEqual(rangeOf(estimate({ ...NOVELLA, progress: { chaptersDone: 40, planned: 40 } }).calls), [1, 1], "more chapters than the book asks for are not a debt");
});

test("what the run keeps for later changes nothing of the calls: the pause after the plan, the outline the plan fills, the other options", () => {
  const plain = estimate(NOVELLA);
  for (const options of [{ pauseAfterPlan: false }, { pauseAfterPlan: true }, { fillOutline: false }, { fillOutline: true }, { pauseAfterEachChapter: true, chaptersPerRun: 3, budgetLimit: 5, syncAfterChapter: false }]) {
    const other = estimate({ ...NOVELLA, options: { ...NOVELLA.options, ...options } });
    assert.deepEqual(other.steps, plain.steps, JSON.stringify(options));
    assert.deepEqual(other.calls, plain.calls);
    assert.deepEqual(other.inputTokens, plain.inputTokens);
  }
});

test("the outline: its chapter entries are the chapters of the book, and the chapters already planned count when it has none", () => {
  const words = { wordsPerScene: 1400 };
  const chapters = (outline, progress) => estimate({ ...NOVELLA, brief: words, outline, progress }).chapters;
  assert.equal(chapters({ entries: 20, lastChapter: 20 }), 20);
  assert.equal(chapters({ entries: 8, lastChapter: 8 }), 8);
  assert.equal(chapters({ entries: 3 }), 3);
  assert.equal(chapters({ entries: 0 }), 0);
  assert.equal(chapters({}), 0);
  assert.equal(chapters({}, { planned: 7 }), 7, "a plan with no outline is the book's chapters");
  assert.equal(chapters({ entries: 20, lastChapter: 20 }, { planned: 7 }), 20);
  assert.equal(estimate({ ...NOVELLA, brief: words, outline: { entries: 20, lastChapter: 20 } }).chapters, 20);
  assert.equal(estimate({ ...NOVELLA, brief: words, outline: { entries: 20 } }).chapters, 20, "twenty entries are chapters 1 to 20");
  assert.equal(estimate({ ...NOVELLA, brief: words, outline: { entries: 5, lastChapter: 30 } }).chapters, 30, "a gap in the outline does not shorten the book");
  const withOutline = estimate({ ...NOVELLA, outline: { entries: 12, lastChapter: 12 } });
  const without = estimate({ ...NOVELLA, outline: { entries: 12, lastChapter: 12, words: 0 } });
  assert.ok(withOutline.steps.plan.inputTokens.min > without.steps.plan.inputTokens.min, "the outline goes into the plan's prompt");
  assert.ok(withOutline.steps.concept.inputTokens.min > without.steps.concept.inputTokens.min, "and into the concept's");
  assert.equal(withOutline.steps.write.inputTokens.min, without.steps.write.inputTokens.min, "but not into the prose's");
});

// ─── Tokens ─────────────────────────────────────────────────────────────────

test("a scene is written at what a word of the book's language costs: 2.4 tokens in Latin script, more in the others, the engine's own figures", () => {
  const story = (language) => estimate(STORY, { language });
  const writes = 8 * 900;
  for (const [language, perWord] of [["en", 2.4], ["it", 2.4], ["Italiano", 2.4], ["ru", 4], ["Русский", 4], ["zh", 3.5], ["ja", 3.5], ["el", 5], ["ko", 6], ["hi", 8], ["th", 9], ["tlh", 6]]) {
    assert.equal(tokensPerWord(language), perWord, `the engine's figure for ${language}`);
    const result = story(language);
    assert.deepEqual(rangeOf(result.steps.write.outputTokens), [Math.round(writes * perWord), Math.round(writes * perWord)], language);
    assert.deepEqual(rangeOf(result.steps.repair.outputTokens), [0, Math.round(16 * 900 * perWord)], language);
  }
  const latin = story("en");
  const cyrillic = story("ru");
  assert.ok(cyrillic.outputTokens.min > latin.outputTokens.min * 1.5, "the structured replies are written in the language too");
  assert.ok(cyrillic.steps.reader.inputTokens.min > latin.steps.reader.inputTokens.min * 1.3, "and so is what is read");
  assert.equal(cyrillic.steps.reader.calls.min, latin.steps.reader.calls.min, "but the number of calls does not depend on the language");
  assert.equal(story(undefined).language, "en");
  assert.equal(story("it").language, "it");
  assert.equal(estimate(STORY, { language: "Русский" }).language, "ru", "the language as a code, whatever the host called it");
});

test("the engine's factor can be replaced by the one a host has measured", () => {
  const measured = estimate(STORY, { tokensPerWord: 1.5 });
  assert.deepEqual(rangeOf(measured.steps.write.outputTokens), [Math.round(8 * 900 * 1.5), Math.round(8 * 900 * 1.5)]);
  assert.deepEqual(rangeOf(estimate(STORY, { tokensPerWord: 0 }).steps.write.outputTokens), [17_280, 17_280], "a figure that is no figure is not used");
  assert.deepEqual(rangeOf(estimate(STORY, { tokensPerWord: Number.NaN }).steps.write.outputTokens), [17_280, 17_280]);
});

test("a reply is never more than the engine's own limit for it, nor than the largest answer the model can give", () => {
  const huge = estimate({ brief: { targetChapters: 1, scenesPerChapter: 1, wordsPerScene: 8000 }, options: { readers: false, readersOnPlan: false } });
  assert.equal(huge.steps.write.outputTokens.min, 16_000, "the ceiling of the engine's replies, as a scene's limit is set");
  const capped = estimate(STORY, { models: uniform({ ...MODEL, maxOutputTokens: 1000 }) });
  assert.deepEqual(rangeOf(capped.steps.write.outputTokens), [8 * 1000, 8 * 1000], "a model that cannot write more than a thousand tokens writes no more");
  for (const kind of KINDS) {
    const calls = capped.steps[kind].calls.max;
    assert.ok(capped.steps[kind].outputTokens.max <= calls * 1000, kind);
  }
});

test("the prompt of a call is counted as the engine counts a prompt: the system message, the tools, the request, and the book's words at the language's price", () => {
  const result = estimate(NOVELLA);
  const call = result.steps["scene-summary"];
  const words = 1400;
  // 4 tokens a message, the system prompt and the function at 4 characters a token (the function: the way the request sends it, and 8 tokens for it),
  // the wrappers and the request line at 4 characters a token (211 and 76 characters, as the real prompt shows them), the scene at 1.5 tokens a word.
  const system = Math.ceil(continuitySystemPrompt("en").length / 4) + 4;
  const tool = likelyTextTokens(JSON.stringify([{ type: "function", function: SCENE_SUMMARY_TOOL }])) + 8;
  const user = Math.ceil((211 + 76) / 4) + 4 + words * 1.5;
  const perCall = system + tool + user;
  const calls = call.calls.min;
  near(call.inputTokens.min, calls * perCall, calls * 3, "the prompts of the summaries of the scenes");
  assert.equal(calls, 36);
  assert.equal(call.outputTokens.min, Math.round(calls * ESTIMATE_TYPICAL.summaryWords * 2.4), "and what they answer");
});

test("what the book's files hold goes where the pipeline puts it: the ghostwriter in the prose, the repairs and the specialists, and nowhere else", () => {
  const plain = estimate(NOVELLA);
  const more = estimate({ ...NOVELLA, context: { ghostwriterWords: ESTIMATE_TYPICAL.ghostwriterWords + 100 } });
  const raised = (kind) => more.steps[kind].inputTokens.max - plain.steps[kind].inputTokens.max;
  const perCall = (kind) => 100 * 1.5 * more.steps[kind].calls.max;
  for (const kind of ["write", "repair", "specialists"]) near(raised(kind), perCall(kind), more.steps[kind].calls.max, kind);
  for (const kind of KINDS.filter((kind) => !["write", "repair", "specialists"].includes(kind))) assert.equal(raised(kind), 0, `${kind} does not carry the ghostwriter`);
  const canon = estimate({ ...NOVELLA, context: { canonWords: ESTIMATE_TYPICAL.canonWords + 200 } });
  for (const kind of ["plan", "plan-review", "scenes", "specialists"]) assert.ok(canon.steps[kind].inputTokens.max > plain.steps[kind].inputTokens.max, `${kind} carries the canon`);
  for (const kind of ["reader", "readers-summary", "scene-summary", "consolidate", "director-review"]) assert.equal(canon.steps[kind].inputTokens.max, plain.steps[kind].inputTokens.max, `${kind} does not`);
  const rules = estimate({ ...NOVELLA, context: { rulesWords: 80 } });
  for (const kind of ["concept", "plan", "scenes", "write", "specialists", "director-review", "repair"]) assert.ok(rules.steps[kind].inputTokens.max > plain.steps[kind].inputTokens.max, `${kind} carries the author's rules`);
  for (const kind of ["reader", "scene-summary", "readers-summary", "consolidate"]) assert.equal(rules.steps[kind].inputTokens.max, plain.steps[kind].inputTokens.max, `${kind} does not`);
  const idea = estimate({ ...NOVELLA, brief: { ...NOVELLA.brief, idea: "word ".repeat(300) } });
  for (const kind of ["concept", "plan", "plan-reader", "plan-review"]) assert.ok(idea.steps[kind].inputTokens.max > plain.steps[kind].inputTokens.max, `${kind} carries the idea`);
  assert.equal(idea.steps.write.inputTokens.max, plain.steps.write.inputTokens.max);
  assert.ok(estimate({ ...NOVELLA, brief: { ...NOVELLA.brief, idea: "A glassmaker." } }).steps.concept.inputTokens.min < plain.steps.concept.inputTokens.min, "a short idea weighs less than the pitch the estimate assumes");
});

test("a longer or shorter chapter weighs what its words weigh in every prompt that carries it, and a book of more scenes is read more times", () => {
  const base = { brief: { targetChapters: 4, scenesPerChapter: 2, wordsPerScene: 600 }, options: { readers: true, maxReaders: 2, readersOnPlan: false, specialists: true } };
  const short = estimate(base);
  const long = estimate({ ...base, brief: { ...base.brief, wordsPerScene: 1200 } });
  for (const kind of ["reader", "specialists", "director-review", "consolidate", "scene-summary", "repair"]) {
    const added = long.steps[kind].inputTokens.max - short.steps[kind].inputTokens.max;
    const calls = short.steps[kind].calls.max;
    assert.ok(added >= calls * 600 * 1.5 * 0.9, `${kind}: every call carries the whole chapter, or the scene (${added} for ${calls} calls)`);
  }
  assert.equal(long.steps.concept.inputTokens.max, short.steps.concept.inputTokens.max, "the concept does not depend on the length of a scene");
  assert.equal(long.steps.write.outputTokens.min, short.steps.write.outputTokens.min * 2);
  assert.ok(long.steps.consolidate.outputTokens.max === short.steps.consolidate.outputTokens.max, "and the consolidation writes the same summary");
  const fourScenes = estimate({ ...base, brief: { ...base.brief, scenesPerChapter: 4 } });
  const readers = short.steps.reader.calls.max;
  assert.equal(fourScenes.steps.reader.calls.max, readers, "the readers are as many");
  assert.ok(fourScenes.steps.reader.inputTokens.max - short.steps.reader.inputTokens.max >= readers * 2 * 600 * 1.5 * 0.9, "but each reads two scenes more");
});

test("the story so far and the lists of the chapters grow with the book until the limits of the prompts, and no longer", () => {
  const T = ESTIMATE_TYPICAL;
  const book = (chapters) => ({ brief: { targetChapters: chapters, scenesPerChapter: 2, wordsPerScene: 500 }, options: { readers: true, maxReaders: 1, readersOnPlan: false, specialists: true } });
  // The calls of one chapter, found by taking the book from the point where it is to the point just after it.
  const chapter = (step, number, chapters = 300) => {
    const before = estimate({ ...book(chapters), progress: { chaptersDone: number - 1, planned: chapters, conceptDone: true } }).steps[step].inputTokens.min;
    const after = estimate({ ...book(chapters), progress: { chaptersDone: number, planned: chapters, conceptDone: true } }).steps[step].inputTokens.min;
    return before - after;
  };
  // The specialists see the chapters before this one, a line each (the summary the closing wrote), for as long as the list fits its budget of 24 000 characters.
  const line = T.closedLineWords * 1.5;
  const fits = Math.floor(T.listCapWords / T.closedLineWords) + 1;
  for (const number of [2, 3, 10, 40, fits - 3]) near(chapter("specialists", number + 1) - chapter("specialists", number), line, 2, `chapter ${number} to ${number + 1}`);
  // Then the list is condensed to fit: the thirty chapters around this one keep their line and the others a title, so the list is shorter than the one that fitted, and grows by a title.
  const last = chapter("specialists", fits);
  const condensed = chapter("specialists", fits + 1);
  assert.ok(last - condensed > (T.closedLineWords - T.titleLineWords) * 1.5 * (fits - 1 - T.listFullLines) * 0.9, `the list of ${fits} chapters is condensed: ${last} to ${condensed}`);
  const title = T.titleLineWords * 1.5;
  for (const number of [fits + 10, 100, 250]) near(chapter("specialists", number + 1) - chapter("specialists", number), title, 2, `chapter ${number} to ${number + 1}`);
  // A list is never more than its budget, however long the book.
  const longest = (number) => chapter("specialists", number, 5000);
  near(longest(2000) - longest(1000), 0, 3, "the list is at its budget");
  assert.ok(longest(1000) > longest(300) - 1, "and was growing");
  // A scene's prompt carries the story so far: a summary of what happened, which a chapter adds to until its target.
  const story = T.storyWordsPerChapter * 1.5;
  const writeAt = (number) => chapter("write", number);
  for (const number of [2, 3, 5, 8]) near((writeAt(number + 1) - writeAt(number)) / 2, story, 2, `a scene at chapter ${number} to ${number + 1}`);
  const full = writeAt(40);
  for (const number of [41, 100, 250]) near(writeAt(number), full, 2, `the story so far is full at chapter ${number}`);
  assert.ok(full > writeAt(1), "and the first chapter has none");
});

test("five thousand chapters are estimated at once: an arithmetic of a few steps, not a walk through the book", () => {
  const thousands = { brief: { targetChapters: 5000, scenesPerChapter: 3, wordsPerScene: 1400 }, options: { readers: true, maxReaders: 5, readersOnPlan: true, specialists: true } };
  estimate(thousands);
  const start = performance.now();
  const result = estimate(thousands);
  const elapsed = performance.now() - start;
  assert.ok(elapsed < 50, `${elapsed.toFixed(2)} ms`);
  assert.equal(result.chapters, 5000);
  assert.deepEqual(rangeOf(result.steps.plan.calls), [250, 750]);
  assert.deepEqual(rangeOf(result.steps.write.calls), [15_000, 15_000]);
  assert.deepEqual(rangeOf(result.calls), [5000 * 16 + 1 + 250 + 5 + 1 + 1, 5000 * 30 + 1 + 750 + 5 + 3 + 1]);
  const huge = performance.now();
  estimate({ ...thousands, brief: { ...thousands.brief, targetChapters: 100_000 } });
  assert.ok(performance.now() - huge < 50, "a hundred thousand chapters too");
  const slow = performance.now();
  for (let count = 0; count < 200; count += 1) estimate(NOVELLA);
  assert.ok(performance.now() - slow < 3000, "and a preview that is asked on every key the author types: two hundred of them in a few seconds, at the slowest");
});

// ─── Cost and time ──────────────────────────────────────────────────────────

test("the cost is each capability's tokens at its model's prices, in the best case and in the worst, and the money is the host's", () => {
  const result = estimate(NOVELLA, { currency: "EUR" });
  assert.equal(result.cost.currency, "EUR");
  assert.deepEqual(result.unpriced, []);
  let min = 0;
  let max = 0;
  for (const capability of CAPABILITIES) {
    const part = result.capabilities[capability];
    const lowest = (part.inputTokens.min * 2 + part.outputTokens.min * 10) / 1e6;
    const highest = (part.inputTokens.max * 2 + part.outputTokens.max * 10) / 1e6;
    near(part.cost.min, lowest, 1e-9, `${capability} (best)`);
    near(part.cost.max, highest, 1e-9, `${capability} (worst)`);
    min += lowest;
    max += highest;
  }
  near(result.cost.min, min, 1e-9);
  near(result.cost.max, max, 1e-9);
  assert.ok(result.cost.min > 0 && result.cost.min < result.cost.max);
  assert.equal("currency" in estimate(NOVELLA).cost, false, "no currency is made up");
  const pricey = estimate(NOVELLA, { models: { ...uniform(), autopilot: { ...MODEL, pricing: { inputPerMTok: 20, outputPerMTok: 100 } } } });
  assert.ok(pricey.capabilities.autopilot.cost.max > result.capabilities.autopilot.cost.max * 9, "each capability has its own model's prices");
  assert.equal(pricey.capabilities.director.cost.max, result.capabilities.director.cost.max);
});

test("a model that declares a price for what it has cached makes the best case cheaper; the worst case counts on no cache", () => {
  const cached = { ...MODEL, pricing: { inputPerMTok: 2, cachedPerMTok: 0.5, outputPerMTok: 10 } };
  const plain = estimate(NOVELLA);
  const result = estimate(NOVELLA, { models: uniform(cached) });
  assert.ok(result.cachedInputTokens.min > 0, "the fixed start of every request: the system message and the functions");
  assert.ok(result.cachedInputTokens.min < result.inputTokens.min);
  assert.ok(result.cachedInputTokens.max >= result.cachedInputTokens.min);
  assert.equal(plain.cachedInputTokens.max, 0, "a model that declares no cached price is not counted on to cache");
  assert.deepEqual(result.inputTokens, plain.inputTokens, "the tokens are the same");
  let min = 0;
  let max = 0;
  for (const capability of CAPABILITIES) {
    const part = result.capabilities[capability];
    min += ((part.inputTokens.min - part.cachedInputTokens.min) * 2 + part.cachedInputTokens.min * 0.5 + part.outputTokens.min * 10) / 1e6;
    max += (part.inputTokens.max * 2 + part.outputTokens.max * 10) / 1e6;
  }
  near(result.cost.min, min, 1e-9, "best case: cached at the cached price");
  near(result.cost.max, max, 1e-9, "worst case: no cache");
  assert.ok(result.cost.min < plain.cost.min);
  assert.equal(result.cost.max, plain.cost.max);
  const absurd = estimate(NOVELLA, { models: uniform({ ...MODEL, pricing: { inputPerMTok: 2, cachedPerMTok: 50, outputPerMTok: 10 } }) });
  near(absurd.cost.min, plain.cost.min, 1e-9, "a cache that costs more than the input it saves saves nothing, and the best case is never above the worst");
  assert.ok(absurd.cost.min <= absurd.cost.max);
});

test("a model with no price makes the cost unknown, never zero, and the capabilities that lack a price are named", () => {
  const without = { ...MODEL, model: "local-model", pricing: undefined };
  for (const pricing of [undefined, {}, { inputPerMTok: 2 }, { outputPerMTok: 10 }, { inputPerMTok: Number.NaN, outputPerMTok: 10 }, { inputPerMTok: -1, outputPerMTok: 10 }]) {
    const result = estimate(NOVELLA, { models: { ...uniform(), director: { ...without, pricing } } });
    assert.equal(result.cost, null, JSON.stringify(pricing));
    assert.deepEqual(result.unpriced, ["director"]);
    assert.equal(result.capabilities.director.cost, null);
    assert.notEqual(result.capabilities.autopilot.cost, null, "the others have theirs");
    const [warning] = warningsOf(result, "noPrice");
    assert.deepEqual([warning.capability, warning.model, warning.severity], ["director", "local-model", "warning"]);
    assert.equal(warningsOf(result, "noPrice").length, 1);
  }
  const free = estimate(NOVELLA, { models: uniform({ ...MODEL, pricing: { inputPerMTok: 0, outputPerMTok: 0 } }) });
  assert.deepEqual(rangeOf(free.cost), [0, 0], "a model that is free costs nothing, which is a price");
  assert.deepEqual(free.unpriced, []);
  assert.deepEqual(warningsOf(free, "noPrice"), []);
  const none = estimate(NOVELLA, { models: uniform({ ...MODEL, pricing: undefined }) });
  assert.equal(none.cost, null);
  assert.deepEqual([...none.unpriced].sort(), [...CAPABILITIES].sort());
  assert.equal(warningsOf(none, "noPrice").length, 6);
});

test("a capability that makes no call needs no price, no speed and no model", () => {
  const readersOff = { ...NOVELLA, options: { ...NOVELLA.options, readers: false, readersOnPlan: false } };
  const bare = estimate(readersOff, { models: { autopilot: MODEL, director: MODEL, review: MODEL, "simple-tasks": MODEL } });
  assert.deepEqual(bare.unpriced, []);
  assert.deepEqual(bare.unmeasured, []);
  assert.deepEqual(bare.warnings.map((warning) => warning.code), [], "nobody is asked for what is never asked");
  assert.deepEqual(rangeOf(bare.capabilities["reader-evaluation"].cost), [0, 0]);
  assert.deepEqual(rangeOf(bare.capabilities["reader-evaluation"].minutes), [0, 0]);
  assert.equal(bare.capabilities["reader-evaluation"].model, null);
  assert.ok(bare.cost.max > 0 && bare.minutes.max > 0);
});

test("the time is the tokens a model writes at its speed, when every model that is asked has one; never a guess", () => {
  const result = estimate(NOVELLA);
  assert.deepEqual(result.unmeasured, []);
  let min = 0;
  let max = 0;
  for (const capability of CAPABILITIES) {
    const part = result.capabilities[capability];
    near(part.minutes.min, part.outputTokens.min / 20 / 60, 1e-9, capability);
    near(part.minutes.max, part.outputTokens.max / 20 / 60, 1e-9, capability);
    min += part.outputTokens.min / 20 / 60;
    max += part.outputTokens.max / 20 / 60;
  }
  near(result.minutes.min, min, 1e-9);
  near(result.minutes.max, max, 1e-9);
  assert.ok(result.minutes.min > 0 && result.minutes.min < result.minutes.max);
  const slowDirector = estimate(NOVELLA, { models: { ...uniform(), director: { ...MODEL, tokensPerSecond: 2 } } });
  near(slowDirector.capabilities.director.minutes.max, result.capabilities.director.minutes.max * 10, 1e-9, "each capability has its own model's speed");
  for (const speed of [undefined, 0, -3, Number.NaN, Number.POSITIVE_INFINITY, "fast", null]) {
    const unknown = estimate(NOVELLA, { models: { ...uniform(), review: { ...MODEL, model: "slow-review", tokensPerSecond: speed } } });
    assert.equal(unknown.minutes, null, `a speed of ${String(speed)} is no speed`);
    assert.deepEqual(unknown.unmeasured, ["review"]);
    assert.equal(unknown.capabilities.review.minutes, null);
    assert.notEqual(unknown.capabilities.autopilot.minutes, null, "the others have theirs");
    const [warning] = warningsOf(unknown, "noSpeed");
    assert.deepEqual([warning.capability, warning.model, warning.severity], ["review", "slow-review", "info"]);
  }
  assert.equal(estimate(NOVELLA, { models: uniform({ ...MODEL, tokensPerSecond: undefined }) }).minutes, null);
});

// ─── Warnings ───────────────────────────────────────────────────────────────

test("a capability with no model is an error: the run would stop at its first step, and there is nothing to price or to time", () => {
  const result = estimate(NOVELLA, { models: { ...uniform(), director: undefined, review: null } });
  const missing = warningsOf(result, "noModel");
  assert.deepEqual(missing.map((warning) => warning.capability).sort(), ["director", "review"]);
  for (const warning of missing) {
    assert.equal(warning.severity, "error");
    assert.ok(warning.text.length > 30);
    assert.equal("model" in warning, false);
  }
  assert.equal(result.capabilities.director.model, null);
  assert.equal(result.cost, null);
  assert.deepEqual([...result.unpriced].sort(), ["director", "review"], "no model, no price");
  assert.equal(result.minutes, null);
  assert.deepEqual([...result.unmeasured].sort(), ["director", "review"]);
  assert.deepEqual(warningsOf(result, "noPrice"), [], "it is not also said that a model that is not there has no price");
  assert.deepEqual(warningsOf(result, "noSpeed"), []);
  assert.ok(result.calls.min > 0, "the calls are counted: the work is there to do");
  const all = estimateAutopilotRun({ brief: NOVELLA.brief, outline: { entries: 12, lastChapter: 12 } });
  assert.equal(warningsOf(all, "noModel").length, 6, "no model for anything");
  assert.equal(result.warnings[0].severity, "error", "the errors come first");
});

test("a window too small for the prompts is said with the window, what the engine leaves for a prompt, and the prompt: an error when it does not fit", () => {
  const small = (window, extra = {}) => estimate(NOVELLA, { models: { ...uniform(), director: { ...MODEL, maxInputTokens: window, ...extra } } });
  const result = small(8192);
  const [warning] = warningsOf(result, "smallWindow");
  assert.equal(warning.capability, "director");
  assert.equal(warning.model, "writer-model");
  assert.equal(warning.window, 8192);
  assert.equal(warning.severity, "error");
  assert.ok(warning.typicalPrompt > warning.inputBudget, "the prompt does not fit");
  assert.ok(warning.typicalPrompt > 8000 && warning.typicalPrompt < 40_000, `the director's largest prompt, ${warning.typicalPrompt}`);
  // What the engine leaves: the window, less the room for the reply (the director's review is allowed 6000 tokens) and a margin of 5%.
  assert.equal(warning.inputBudget, resolveModelTokenBudgets(8192, 6000).inputTokens);
  assert.match(warning.text, /8192|8 192|8,192|8\.192/);
  assert.ok(warning.text.replace(/[\s,.\u00a0\u202f]/g, "").includes(String(warning.typicalPrompt)), "the prompt, as the warning says it");
  assert.equal(warningsOf(result, "smallWindow").length, 1, "only the capability whose window is small");
  const typical = warning.typicalPrompt;
  let tight = 8192;
  while (resolveModelTokenBudgets(tight, 6000).inputTokens < typical * 1.1) tight += 64;
  const closeCall = warningsOf(small(tight), "smallWindow");
  assert.equal(closeCall.length, 1, "it fits, with less than a fifth to spare");
  assert.equal(closeCall[0].severity, "warning");
  assert.ok(closeCall[0].typicalPrompt <= closeCall[0].inputBudget);
  let roomy = tight;
  while (resolveModelTokenBudgets(roomy, 6000).inputTokens < typical * 1.5) roomy += 64;
  assert.deepEqual(warningsOf(small(roomy), "smallWindow"), [], "a window with room to spare says nothing");
  assert.deepEqual(warningsOf(small(undefined), "smallWindow"), [], "a window that is not declared is not checked, as the engine does not");
  assert.deepEqual(warningsOf(small(0), "smallWindow"), []);
  assert.deepEqual(warningsOf(estimate(NOVELLA), "smallWindow"), []);
  // The router asks a structured reply for at least 4096 tokens (`STRUCTURED_OUTPUT_FLOOR`): a window of 8192 leaves 3686 for the prompt, which holds a scene to summarize and not a chapter.
  const tiny = estimate(NOVELLA, { models: uniform({ ...MODEL, maxInputTokens: 8192 }) });
  const tooSmall = warningsOf(tiny, "smallWindow").map((warning) => warning.capability);
  for (const capability of ["autopilot", "director", "reader-evaluation", "review"]) assert.ok(tooSmall.includes(capability), `${capability}: a chapter does not fit 8192 tokens`);
  assert.ok(!tooSmall.includes("simple-tasks"), "but a scene to summarize does");
  const floor = warningsOf(estimate(NOVELLA, { models: uniform({ ...MODEL, maxInputTokens: 4096 }) }), "smallWindow").map((warning) => warning.capability);
  assert.ok(floor.includes("simple-tasks"), "a window of 4096 is gone to the 4096 tokens the router asks a structured reply for: nothing is left for the prompt of anything");
});

test("the window is judged by the largest prompt of the capability, in a late chapter of a long book, as the engine would judge it", () => {
  const model = (window) => ({ ...MODEL, maxInputTokens: window });
  const prompt = (input) => warningsOf(estimate(input, { models: { ...uniform(), review: model(2048) } }), "smallWindow")[0].typicalPrompt;
  const short = prompt({ ...NOVELLA, brief: { ...NOVELLA.brief, targetChapters: 2 } });
  const long = prompt({ ...NOVELLA, brief: { ...NOVELLA.brief, targetChapters: 200 } });
  assert.ok(long > short + 3000, "the list of the chapters before a chapter is part of the specialists' prompt: " + [short, long]);
  const longer = prompt({ ...NOVELLA, brief: { ...NOVELLA.brief, targetChapters: 5000 } });
  near(longer, prompt({ ...NOVELLA, brief: { ...NOVELLA.brief, targetChapters: 2000 } }), 40, "and the list stops growing where the prompt limits it");
  assert.ok(longer > long, "after growing for a book of two hundred chapters, by a title for each chapter");
  const bigger = prompt({ ...NOVELLA, brief: { ...NOVELLA.brief, wordsPerScene: 2800 } });
  assert.ok(bigger > prompt(NOVELLA) + 3 * 1400 * 1.5 * 0.9, "a longer chapter is read whole");
});

test("a model that cannot answer as long as the longest reply of its steps is warned about, in tokens", () => {
  const plain = estimate(NOVELLA);
  const writer = ["concept", "plan", "scenes", "write", "repair", "consolidate"];
  const largest = Math.round(Math.max(...writer.map((kind) => plain.steps[kind].outputTokens.max / plain.steps[kind].calls.max)));
  assert.ok(largest > 1400 * 2.4, "the concept is longer than a scene: " + largest);
  const result = estimate(NOVELLA, { models: { ...uniform(), autopilot: { ...MODEL, maxOutputTokens: 2000 } } });
  const [warning] = warningsOf(result, "smallOutput");
  assert.deepEqual([warning.capability, warning.model, warning.maxOutputTokens, warning.severity], ["autopilot", "writer-model", 2000, "warning"]);
  assert.equal(warning.typicalReply, largest);
  assert.equal(warningsOf(result, "smallOutput").length, 1, "only the capability that has a reply too long for its model");
  assert.deepEqual(warningsOf(estimate(NOVELLA, { models: { ...uniform(), autopilot: { ...MODEL, maxOutputTokens: largest } } }), "smallOutput"), [], "a model that can answer exactly that much is enough");
  assert.equal(warningsOf(estimate(NOVELLA, { models: { ...uniform(), autopilot: { ...MODEL, maxOutputTokens: largest - 1 } } }), "smallOutput").length, 1);
  assert.deepEqual(warningsOf(estimate(NOVELLA, { models: { ...uniform(), autopilot: { ...MODEL, maxOutputTokens: undefined } } }), "smallOutput"), [], "a largest answer that is not declared is not checked");
  assert.deepEqual(warningsOf(plain, "smallOutput"), []);
});

test("a model that reasons spends more tokens than the ones that are counted: it is named once per capability, by its name or by what it declares", () => {
  for (const model of [{ ...MODEL, model: "o3-mini" }, { ...MODEL, model: "gpt-5" }, { ...MODEL, supportsReasoning: true }, { ...MODEL, model: "my-deployment", provider: "azure_openai", underlyingModel: "o4-mini" }]) {
    const result = estimate(NOVELLA, { models: { ...uniform(), director: model } });
    const [warning] = warningsOf(result, "reasoningModel");
    assert.deepEqual([warning.capability, warning.model, warning.severity], ["director", model.model, "info"], JSON.stringify(model));
    assert.equal(warningsOf(result, "reasoningModel").length, 1);
  }
  assert.deepEqual(warningsOf(estimate(NOVELLA, { models: { ...uniform(), director: { ...MODEL, model: "gpt-4o", supportsReasoning: false } } }), "reasoningModel"), []);
  assert.deepEqual(warningsOf(estimate(NOVELLA), "reasoningModel"), []);
  assert.ok(estimate(NOVELLA).assumptions.some((line) => /reason/i.test(line)), "the estimate says, whatever the models, that a model that reasons spends more");
});

test("a healthy configuration has nothing to say but the assumptions; the warnings are ordered by gravity and say what they say in the language of the book", () => {
  assert.deepEqual(estimate(NOVELLA).warnings, []);
  const bad = { ...uniform(), director: undefined, review: { ...MODEL, pricing: undefined, tokensPerSecond: undefined, model: "o3", maxInputTokens: 4096 } };
  const english = estimate(NOVELLA, { models: bad, outline: { entries: 20 } });
  const rank = { error: 0, warning: 1, info: 2 };
  assert.deepEqual(english.warnings.map((warning) => rank[warning.severity]), english.warnings.map((warning) => rank[warning.severity]).sort(), "the errors first, then the warnings, then the rest");
  assert.ok(english.warnings.length >= 5);
  for (const warning of english.warnings) {
    assert.ok(["error", "warning", "info"].includes(warning.severity));
    assert.ok(typeof warning.text === "string" && warning.text.length > 20 && !/undefined|NaN|\[object/.test(warning.text), warning.text);
  }
  const italian = estimate(NOVELLA, { models: bad, outline: { entries: 20 }, language: "it" });
  assert.deepEqual(italian.warnings.map((warning) => warning.code), english.warnings.map((warning) => warning.code), "the same warnings");
  const noModel = (result) => warningsOf(result, "noModel")[0].text;
  assert.match(noModel(english), /Director/);
  assert.match(noModel(italian), /Direttore/);
  assert.doesNotMatch(noModel(italian), /\bis\b|\bthe\b/, "in Italian");
  assert.ok(italian.assumptions.every((line) => !/\bthe\b/.test(line)), "the assumptions too");
  assert.match(italian.assumptions[0], /capitol/i);
  assert.match(english.assumptions[0], /chapter/i);
  const unknown = estimate(NOVELLA, { models: bad, language: "ru" });
  assert.equal(warningsOf(unknown, "noModel")[0].text, noModel(english), "a language the engine has no words for gets English");
  const other = estimate(NOVELLA, { models: bad, language: "Italiano" });
  assert.equal(warningsOf(other, "noModel")[0].text, noModel(italian), "the language as the book names it");
});

// ─── The models of the router ───────────────────────────────────────────────

test("the models come from the configuration as the router would choose them, with no key, and with the speeds a book has measured", () => {
  const config = pickAiRuntimeConfig({
    aiIntegrations: [
      { id: "a", name: "Alpha", provider: "openai", endpoint: "http://a.test/v1", apiKey: "sk-secret-0123456789", chatModels: [{ id: "w", name: "writer-model", capabilities: ["autopilot", "simple-tasks"], maxInputTokens: 32_000, maxOutputTokens: 8000, pricing: { inputPerMTok: 1, outputPerMTok: 4 } }, { id: "d", name: "director-model", capabilities: ["director"], supportsReasoning: true }] },
      { id: "b", name: "Beta", provider: "openai", endpoint: "http://b.test/v1", apiKey: "sk-secret-9876543210", chatModels: [{ id: "x", name: "default-model", capabilities: ["default"] }] },
    ],
    costCurrency: "USD",
    taskRouting: { review: { primary: { integrationId: "b", model: "default-model" } } },
  });
  const speeds = new Map([["writer-model", { tokensPerSecond: 31, samples: 5 }], ["default-model", { tokensPerSecond: 12, samples: 2 }]]);
  const models = estimateModelsFromConfig(config, speeds);
  assert.deepEqual(models.autopilot, { model: "writer-model", maxInputTokens: 32_000, maxOutputTokens: 8000, pricing: { inputPerMTok: 1, outputPerMTok: 4 }, tokensPerSecond: 31 });
  assert.deepEqual(models["simple-tasks"], models.autopilot, "the same model for two capabilities");
  assert.deepEqual(models.director, { model: "director-model", supportsReasoning: true });
  assert.deepEqual(models.review, { model: "default-model", tokensPerSecond: 12 }, "a route sends it to the other integration");
  assert.deepEqual(models["reader-evaluation"], { model: "default-model", tokensPerSecond: 12 }, "nothing is tagged for it: the first model tagged `default`, as resolveAiCandidates picks");
  assert.deepEqual(models["reader-evaluation-summary"], models["reader-evaluation"]);
  assert.equal(JSON.stringify(models).includes("sk-secret"), false, "no key");
  assert.equal(JSON.stringify(models).includes("http"), false, "no address");
  const result = estimateAutopilotRun({ brief: NOVELLA.brief, outline: { entries: 12, lastChapter: 12 }, models });
  assert.deepEqual([...result.unpriced].sort(), ["director", "reader-evaluation", "reader-evaluation-summary", "review"], "the models of the configuration that have no price");
  assert.equal(result.cost, null);
  assert.deepEqual(result.unmeasured, ["director"], "and the one that has no speed");
  assert.deepEqual(estimateModelsFromConfig({ aiIntegrations: [] }), {}, "nothing is configured: no model for anything");
  assert.deepEqual(estimateModelsFromConfig(undefined), {});
  assert.deepEqual(estimateModelsFromConfig(config).autopilot, { model: "writer-model", maxInputTokens: 32_000, maxOutputTokens: 8000, pricing: { inputPerMTok: 1, outputPerMTok: 4 } }, "without measured speeds there is none");
});

// ─── Where the book is ──────────────────────────────────────────────────────

test("where a book is comes from its state: the chapters done, the chapters in the plan, the concept and the final judgement", () => {
  const state = createAutopilotState(new Date("2026-01-01T00:00:00Z"));
  assert.deepEqual(estimateProgressFromState(state), { chaptersDone: 0, planned: 0, conceptDone: false, finalDone: false, withoutSummary: 0 });
  assert.deepEqual(estimateProgressFromState(null), { chaptersDone: 0, planned: 0, conceptDone: false, finalDone: false, withoutSummary: 0 });
  const chapter = (number, status, extra = {}) => ({ number, title: `T${number}`, slug: `00${number}-t${number}`, summary: "", goal: "", pov: [], keyEvents: [], reveals: [], status, scenes: [], ...extra });
  const planned = { ...state, concept: { ...state.concept, done: true }, plan: { chapters: [chapter(1, "done", { imported: true }), chapter(2, "done", { imported: true, summary: "Seen." }), chapter(3, "done"), chapter(4, "writing"), chapter(5, "planned")], approved: true, rounds: 0, revisionNotes: [], readerReactions: [], readersDone: true, awaitingAuthor: false } };
  assert.deepEqual(estimateProgressFromState(planned), { chaptersDone: 3, planned: 5, conceptDone: true, finalDone: false, withoutSummary: 1 });
  const waiting = { ...planned, plan: { ...planned.plan, approved: false } };
  assert.equal(estimateProgressFromState(waiting).planned, 0, "a plan that is not approved is not a plan to go on from");
  assert.equal(estimateProgressFromState({ ...planned, finalDone: true }).finalDone, true);
  const resumed = estimate({ ...NOVELLA, progress: estimateProgressFromState(planned) });
  assert.equal(resumed.chaptersToWrite, 9);
  assert.deepEqual(rangeOf(resumed.steps.concept.calls), [0, 0]);
  assert.deepEqual(rangeOf(resumed.steps.plan.calls), [1, 3], "the plan has five chapters and the book twelve: once the five are written the plan is extended to the rest");
  assert.deepEqual(rangeOf(resumed.steps["plan-reader"].calls), [0, 0], "and the readers do not read an extension");
});

test("a book that has no state yet is where its chapters are: the ones with prose are done, and the ones with no summary are to be summarized", () => {
  const chapters = [{ summary: "Seen.", paragraphs: [{}, {}] }, { summary: "", paragraphs: [{}] }, { paragraphs: [{}] }, { summary: "  ", paragraphs: [{}] }, { summary: "Empty folder.", paragraphs: [] }, { summary: "", paragraphs: undefined }, null, "x"];
  assert.deepEqual(estimateProgressFromChapters(chapters), { chaptersDone: 4, withoutSummary: 3 });
  assert.deepEqual(estimateProgressFromChapters([]), { chaptersDone: 0, withoutSummary: 0 });
  for (const garbage of [null, undefined, "chapters", 5, {}]) assert.deepEqual(estimateProgressFromChapters(garbage), { chaptersDone: 0, withoutSummary: 0 });
  const result = estimate(NOVELLA, { progress: estimateProgressFromChapters(chapters) });
  assert.equal(result.chaptersToWrite, 8);
  assert.deepEqual(rangeOf(result.steps["summarize-imported"].calls), [3, 3]);
});

test("a configuration the router cannot read has no models, and does not break the estimate", () => {
  assert.deepEqual(estimateModelsFromConfig({ aiIntegrations: [null, 5, "x"] }), {});
  assert.deepEqual(estimateModelsFromConfig({ aiIntegrations: "none" }), {});
  assert.deepEqual(estimateModelsFromConfig(5), {});
  assert.deepEqual(estimateModelsFromConfig({ aiIntegrations: [{ id: "a", name: "A", provider: "openai", apiKey: "k", chatModels: [null, { id: "x" }] }] }), {}, "models with no name are no models");
});

test("what the state knows of the words of the prompts: the author's rules always, the director's notes once the plan is approved", () => {
  const state = createAutopilotState(new Date("2026-01-01T00:00:00Z"));
  assert.deepEqual(estimateContextFromState(state), { rulesWords: 0 }, "a book with no plan has no notes of the director: the estimate takes the typical ones");
  assert.deepEqual(estimateContextFromState(null), { rulesWords: 0 });
  const approved = { ...state, constraints: ["Never kill the dog.", "Keep the chapters short and the dialogue sharp."], directorNotes: ["Keep Orrin calm on the surface."], plan: { chapters: [], approved: true, rounds: 0, revisionNotes: [], readerReactions: [], readersDone: true, awaitingAuthor: false } };
  assert.deepEqual(estimateContextFromState(approved), { rulesWords: 12, notesWords: 6 });
  assert.deepEqual(estimateContextFromState({ ...approved, constraints: [3, null, "One two"], directorNotes: "text" }), { rulesWords: 2, notesWords: 0 }, "what is not a list of texts says nothing");
  const told = estimate(NOVELLA, { context: estimateContextFromState(approved) });
  assert.ok(told.steps.write.inputTokens.min > estimate(NOVELLA, { context: { notesWords: 6 } }).steps.write.inputTokens.min, "the rules are in the prompt of every scene");
});

test("whatever it is given, the estimate answers: whole numbers that do not run backwards, money and time that are numbers or null, and texts with nothing missing", () => {
  // A generator of numbers that is the same on every run.
  let seed = 20_260_722;
  const next = () => {
    seed = (seed + 0x6d2b79f5) | 0;
    let value = Math.imul(seed ^ (seed >>> 15), 1 | seed);
    value = (value + Math.imul(value ^ (value >>> 7), 61 | value)) ^ value;
    return ((value ^ (value >>> 14)) >>> 0) / 4_294_967_296;
  };
  const pick = (list) => list[Math.floor(next() * list.length)];
  const odd = [undefined, null, Number.NaN, Number.POSITIVE_INFINITY, Number.NEGATIVE_INFINITY, -1, 0, 0.5, 1, 2, 3, 7, 12, 20, 21, 41, 300, 5000, 1e9, "7", "x", "", true, false, [], {}, [1], { min: 1, max: 3 }, { min: 5, max: 2 }, () => 1, Symbol("s")];
  const number = () => pick(odd);
  const model = () => pick([undefined, null, 5, "m", {}, { model: "" }, { model: "m" }, { model: "m", maxInputTokens: number(), maxOutputTokens: number(), tokensPerSecond: number(), pricing: { inputPerMTok: number(), outputPerMTok: number(), cachedPerMTok: number() }, supportsReasoning: number() }, { model: "o3", pricing: { inputPerMTok: 1, outputPerMTok: 2 }, tokensPerSecond: 10, maxInputTokens: 8192 }, MODEL]);
  let checked = 0;
  for (let round = 0; round < 1500; round += 1) {
    const input = {
      brief: pick([undefined, null, {}, { targetChapters: number(), scenesPerChapter: number(), wordsPerScene: number(), idea: pick([undefined, "", "an idea of five words", 5]), synopsis: pick([undefined, "one. two. three.", 5]) }]),
      options: pick([undefined, null, {}, { readers: number(), maxReaders: number(), readersOnPlan: number(), specialists: number() }]),
      maxReviewRounds: number(),
      language: pick([undefined, null, 5, "", "it", "en", "Italiano", "ru", "zh", "hi", "klingon"]),
      models: pick([undefined, null, 5, {}, Object.fromEntries(CAPABILITIES.map((capability) => [capability, model()])), uniform()]),
      outline: pick([undefined, null, 5, { entries: number(), lastChapter: number(), words: number() }]),
      progress: pick([undefined, null, 5, { chaptersDone: number(), planned: number(), conceptDone: number(), finalDone: number(), withoutSummary: number(), withoutSummaryWords: number() }]),
      scenario: pick([undefined, null, 5, { rounds: number(), repairs: number(), planRevisions: number() }]),
      context: pick([undefined, null, 5, { designWords: number(), worldWords: number(), ghostwriterWords: number(), directorWords: number(), canonWords: number(), secretsWords: number(), rulesWords: number(), notesWords: number(), styleWords: number() }]),
      readerPanelSize: number(),
      currency: pick([undefined, 5, "", "EUR"]),
      tokensPerWord: number(),
    };
    const result = estimateAutopilotRun(input);
    checked += 1;
    const ranges = [result.calls, result.inputTokens, result.cachedInputTokens, result.outputTokens, ...KINDS.flatMap((kind) => [result.steps[kind].calls, result.steps[kind].inputTokens, result.steps[kind].outputTokens]), ...CAPABILITIES.flatMap((capability) => [result.capabilities[capability].calls, result.capabilities[capability].inputTokens, result.capabilities[capability].cachedInputTokens, result.capabilities[capability].outputTokens])];
    for (const range of ranges) assert.ok(Number.isInteger(range.min) && Number.isInteger(range.max) && range.min >= 0 && range.min <= range.max, `${JSON.stringify(range)} for ${JSON.stringify(input, (key, value) => (typeof value === "number" && !Number.isFinite(value) ? String(value) : typeof value === "symbol" || typeof value === "function" ? String(value) : value))}`);
    for (const money of [result.cost, ...CAPABILITIES.map((capability) => result.capabilities[capability].cost), result.minutes, ...CAPABILITIES.map((capability) => result.capabilities[capability].minutes)]) {
      if (money !== null) assert.ok(Number.isFinite(money.min) && Number.isFinite(money.max) && money.min >= 0 && money.min <= money.max + 1e-9, JSON.stringify(money));
    }
    assert.ok(result.chapters >= 0 && result.chaptersToWrite >= 0 && result.chaptersToWrite <= result.chapters && Number.isInteger(result.words));
    for (const warning of result.warnings) assert.ok(typeof warning.text === "string" && warning.text.length > 20 && !/undefined|NaN|\[object|null/.test(warning.text), warning.text);
    assert.ok(result.assumptions.every((line) => typeof line === "string" && line.length > 20 && !/undefined|NaN|\[object/.test(line)), result.assumptions.join("\n"));
  }
  assert.equal(checked, 1500);
});

// ─── A function of its input and nothing else ───────────────────────────────

function deepFreeze(value) {
  if (value && typeof value === "object" && !Object.isFrozen(value)) {
    Object.freeze(value);
    for (const inner of Object.values(value)) deepFreeze(inner);
  }
  return value;
}

test("the estimate touches nothing but its input: no clock, no network, no timer, no random number, and the input is left as it was", () => {
  const input = deepFreeze({ ...NOVELLA, language: "it", models: uniform(), outline: { entries: 14 }, progress: { chaptersDone: 2, planned: 12 }, scenario: { rounds: 2 }, context: { canonWords: 400 }, currency: "EUR" });
  const forbidden = ["Date", "performance", "fetch", "setTimeout", "setInterval", "setImmediate", "queueMicrotask", "XMLHttpRequest"];
  const kept = Object.fromEntries(forbidden.map((name) => [name, Object.getOwnPropertyDescriptor(globalThis, name)]));
  const random = Math.random;
  const now = Date.now;
  let result;
  try {
    for (const name of forbidden) if (kept[name]) Object.defineProperty(globalThis, name, { configurable: true, get() { throw new Error(`the estimate used ${name}`); } });
    Math.random = () => { throw new Error("the estimate used Math.random"); };
    result = estimateAutopilotRun(input);
  } finally {
    for (const name of forbidden) if (kept[name]) Object.defineProperty(globalThis, name, kept[name]);
    Math.random = random;
    Date.now = now;
  }
  assert.ok(result.calls.max > 0);
  assert.deepEqual(estimateAutopilotRun(input), result, "the same input, the same answer");
  const warned = result.warnings.length;
  result.calls.min = -1;
  result.steps.write.calls.max = -1;
  result.warnings.push({ code: "x" });
  const again = estimateAutopilotRun(input);
  assert.ok(again.calls.min > 0 && again.steps.write.calls.max > 0 && again.warnings.length === warned, "the answer is a fresh object every time");
});

test("the typical sizes the estimate assumes are public, fixed and in words, and the replies stay under the limits the pipeline sets them", () => {
  assert.ok(Object.isFrozen(ESTIMATE_TYPICAL));
  for (const [name, value] of Object.entries(ESTIMATE_TYPICAL)) assert.ok(Number.isFinite(value) && value >= 0, name);
  for (const name of ["designWords", "worldWords", "ghostwriterWords", "canonWords", "secretsWords", "notesWords", "chapterWords", "chapterLineWords", "sceneWords", "storyWordsPerChapter", "storyWordsTarget", "listCapWords", "summaryWords", "findings", "readerProposals", "findingWords", "closedLineWords", "noteWords", "titleLineWords", "listFullLines", "secretLineWords", "revealsWords"]) assert.ok(ESTIMATE_TYPICAL[name] > 0, name);
  assert.equal(ESTIMATE_TYPICAL.storyWordsTarget, 900, "the story so far the consolidation is asked for (STORY_SO_FAR_TARGET_WORDS)");
  assert.equal(ESTIMATE_TYPICAL.listCapWords, 4000, "a list of chapters in a prompt: 24 000 characters at six a word (OUTLINE_MAX_CHARS)");
  for (const language of ["en", "ru", "zh", "hi"]) {
    const result = estimate({ brief: { targetChapters: 30, scenesPerChapter: 20, wordsPerScene: 1000 }, options: { readers: true, maxReaders: 8, readersOnPlan: true, specialists: true } }, { language });
    const limits = { concept: 9000, plan: 9000, "plan-reader": 1500, "plan-review": 4000, scenes: 5000, "scene-summary": 400, reader: 2500, "readers-summary": 2500, specialists: 5000, "director-review": 6000, consolidate: 5000, final: 4000 };
    for (const [kind, limit] of Object.entries(limits)) {
      const effective = scaleOutputTokens(limit, language);
      assert.ok(result.steps[kind].outputTokens.max <= result.steps[kind].calls.max * effective, `${kind} in ${language}: a reply is cut at ${effective} tokens`);
    }
  }
});
