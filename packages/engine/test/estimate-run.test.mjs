import test from "node:test";
import assert from "node:assert/strict";
import * as engine from "../dist/index.js";
import { likelyMessageTokens, likelyTextTokens } from "../dist/ai/budget.js";
import { CAPABILITIES, KINDS, addOutlineChapters, bookFiles, kindOfLabel, prose, runBook, scriptedAi, uniform, words } from "./estimate-fakes.mjs";

// New exports are read from the namespace so that, before they exist, each test fails on its own.
const { estimateAutopilotRun, estimateContextFromState, estimateProgressFromState, tokensPerWord } = engine;

// The estimate is checked against the pipeline itself: the real autopilot writes a whole book with the engine's fake AI (answering with the replies of a
// scripted review), and what the estimate said of the run is held against what the run did.
//
//  - The CALLS are exact. A run whose reviews are the least the pipeline does (every chapter approved at once, the plan too) makes the estimate's best
//    case, call by call; a run whose reviews are the most (every round revised, every scene repaired, the plan revised twice) makes its worst case;
//    and a run whose rounds and repairs the estimate is told (`scenario`) makes its single number. Any run in between falls inside the interval.
//  - The TOKENS are held to a tolerance, declared here. What a prompt weighs is counted the way the router counts it (`likelyMessageTokens` for the
//    messages, `likelyTextTokens` for the function, 8 for its envelope) over what the fake AI received; what a reply weighs is the words of what it
//    answered at the tokens a word costs in the book's language (`tokensPerWord`). The fake AI's replies are as long as the estimate takes a reply to be
//    (`ESTIMATE_TYPICAL`): what is measured is the arithmetic of the pipeline (what a prompt carries, how many times, how it grows with the book), not
//    the size of the replies of a real model, which only a real run can tell.
export const TOLERANCE = {
  /** The tokens of a whole run, in and out. Observed: 0.9% and 1.1% over the runs of this file. */
  total: 0.03,
  /** The tokens of one kind of call, when it is at least `share` of the run (the small kinds are covered by the total). Observed: 5.2% in and 5.6% out at the most; see the README of the engine for each. */
  kind: 0.08,
  share: 0.03,
};

const IDEA = "A harbor town built on glass hides a lie.";

const SHAPES = {
  "a story of four chapters": { brief: { idea: IDEA, targetChapters: 4, scenesPerChapter: 2, wordsPerScene: 900 }, options: { readers: true, maxReaders: 3, readersOnPlan: false, specialists: true } },
  "a short novel read by five readers, plan included": { brief: { idea: IDEA, targetChapters: 5, scenesPerChapter: 3, wordsPerScene: 1400 }, options: { readers: true, maxReaders: 5, readersOnPlan: true, specialists: true } },
  "a story without readers": { brief: { idea: IDEA, targetChapters: 4, scenesPerChapter: 2, wordsPerScene: 900 }, options: { readers: false, readersOnPlan: false, specialists: true } },
  "a story without specialists": { brief: { idea: IDEA, targetChapters: 4, scenesPerChapter: 2, wordsPerScene: 900 }, options: { readers: true, maxReaders: 3, readersOnPlan: true, specialists: false } },
};

const STORY = SHAPES["a story of four chapters"];

// ─── What the run did ───────────────────────────────────────────────────────

/** What the router counts a request at (routing.ts): the two messages, and the function the reply is forced into. */
const promptTokens = (call) => likelyMessageTokens([{ content: call.system }, { content: call.user }]) + (call.json ? likelyTextTokens(JSON.stringify([{ type: "function", function: call.json }])) + 8 : 0);

/** The words a reply says: those of its structured answer, or of its text. */
function replyWords(response) {
  const count = (value) => {
    if (typeof value === "string") return value.split(/\s+/).filter(Boolean).length;
    if (Array.isArray(value)) return value.reduce((total, item) => total + count(item), 0);
    if (value && typeof value === "object") return Object.values(value).reduce((total, item) => total + count(item), 0);
    return 0;
  };
  return response.json === undefined ? count(response.text) : count(response.json);
}

/** The calls, the tokens in and the tokens out of a run, by kind of call (from `from`: the calls of the later part of a book that was written in two). */
function measured(calls, replies, language = "en", from = 0) {
  const factor = tokensPerWord(language);
  const kinds = Object.fromEntries(KINDS.map((kind) => [kind, { calls: 0, input: 0, output: 0 }]));
  for (let index = from; index < calls.length; index += 1) {
    const entry = kinds[kindOfLabel(calls[index].label)];
    entry.calls += 1;
    entry.input += promptTokens(calls[index]);
    entry.output += replyWords(replies[index]) * factor;
  }
  return kinds;
}

function byCapability(calls, from = 0) {
  const counts = Object.fromEntries(CAPABILITIES.map((capability) => [capability, 0]));
  for (const call of calls.slice(from)) {
    assert.ok(call.capability in counts, `the capability ${call.capability} is not one the estimate knows`);
    counts[call.capability] += 1;
  }
  return counts;
}

const reportOn = Boolean(process.env.ESTIMATE_REPORT);

function report(label, result, kinds, which) {
  if (!reportOn) return;
  const pick = (range) => (which === "max" ? range.max : range.min);
  const rows = KINDS.filter((kind) => kinds[kind].calls || pick(result.steps[kind].calls)).map((kind) => {
    const step = result.steps[kind];
    const percent = (real, estimated) => (estimated ? `${(((real - estimated) / estimated) * 100).toFixed(1)}%` : "-");
    return `  ${kind.padEnd(19)} calls ${String(kinds[kind].calls).padStart(4)}/${String(pick(step.calls)).padEnd(4)} in ${String(Math.round(kinds[kind].input)).padStart(8)}/${String(pick(step.inputTokens)).padEnd(8)} ${percent(kinds[kind].input, pick(step.inputTokens)).padStart(7)}  out ${String(Math.round(kinds[kind].output)).padStart(7)}/${String(pick(step.outputTokens)).padEnd(7)} ${percent(kinds[kind].output, pick(step.outputTokens)).padStart(7)}`;
  });
  const sum = (field) => KINDS.reduce((total, kind) => total + kinds[kind][field], 0);
  rows.push(`  TOTAL               in ${Math.round(sum("input"))}/${pick(result.inputTokens)} (${(((sum("input") - pick(result.inputTokens)) / pick(result.inputTokens)) * 100).toFixed(1)}%)  out ${Math.round(sum("output"))}/${pick(result.outputTokens)} (${(((sum("output") - pick(result.outputTokens)) / pick(result.outputTokens)) * 100).toFixed(1)}%)`);
  console.log(`\n${label}\n${rows.join("\n")}`);
}

function assertNear(real, estimated, tolerance, message) {
  const gap = Math.abs(real - estimated);
  assert.ok(gap <= Math.max(estimated * tolerance, 2), `${message}: the run used ${Math.round(real)}, the estimate said ${Math.round(estimated)} (${((gap / Math.max(estimated, 1)) * 100).toFixed(1)}% apart; at most ${tolerance * 100}%)`);
}

/**
 * The estimate against the run. `which` is the end of the interval the run is at ("min", "max"), or "inside" for a run somewhere between.
 * `from` is where the later part of a book that was written in two begins, in the calls.
 */
function holds(label, result, run, which, { language = "en", from = 0, tolerance = TOLERANCE } = {}) {
  const kinds = measured(run.calls, run.replies ?? run.ai.replies, language, from);
  const pickEnd = (range) => (which === "max" ? range.max : range.min);
  const total = { input: 0, output: 0 };
  for (const kind of KINDS) {
    const step = result.steps[kind];
    assert.ok(kinds[kind].calls >= step.calls.min && kinds[kind].calls <= step.calls.max, `${label}, ${kind}: ${kinds[kind].calls} calls, the estimate said ${step.calls.min} to ${step.calls.max}`);
    if (which !== "inside") assert.equal(kinds[kind].calls, pickEnd(step.calls), `${label}, ${kind}: the calls of a run at its ${which}`);
    total.input += kinds[kind].input;
    total.output += kinds[kind].output;
  }
  const counted = byCapability(run.calls, from);
  for (const capability of CAPABILITIES) {
    const range = result.capabilities[capability].calls;
    assert.ok(counted[capability] >= range.min && counted[capability] <= range.max, `${label}, ${capability}: ${counted[capability]} calls, the estimate said ${range.min} to ${range.max}`);
    if (which !== "inside") assert.equal(counted[capability], pickEnd(range), `${label}, ${capability}: the calls of a run at its ${which}`);
  }
  const all = Object.values(counted).reduce((sum, count) => sum + count, 0);
  assert.ok(all >= result.calls.min && all <= result.calls.max, `${label}: ${all} calls, the estimate said ${result.calls.min} to ${result.calls.max}`);
  if (which !== "inside") assert.equal(all, pickEnd(result.calls), `${label}: the calls of a run at its ${which}`);
  report(label, result, kinds, which === "max" ? "max" : "min");
  if (which === "inside") {
    assert.ok(total.input >= result.inputTokens.min * (1 - tolerance.total) && total.input <= result.inputTokens.max * (1 + tolerance.total), `${label}: ${Math.round(total.input)} tokens in, the estimate said ${result.inputTokens.min} to ${result.inputTokens.max}`);
    assert.ok(total.output >= result.outputTokens.min * (1 - tolerance.total) && total.output <= result.outputTokens.max * (1 + tolerance.total), `${label}: ${Math.round(total.output)} tokens out, the estimate said ${result.outputTokens.min} to ${result.outputTokens.max}`);
    return kinds;
  }
  assertNear(total.input, pickEnd(result.inputTokens), tolerance.total, `${label}: the tokens in`);
  assertNear(total.output, pickEnd(result.outputTokens), tolerance.total, `${label}: the tokens out`);
  for (const kind of KINDS) {
    const step = result.steps[kind];
    if (pickEnd(step.inputTokens) >= total.input * tolerance.share) assertNear(kinds[kind].input, pickEnd(step.inputTokens), tolerance.kind, `${label}, ${kind}: the tokens in`);
    if (pickEnd(step.outputTokens) >= total.output * tolerance.share) assertNear(kinds[kind].output, pickEnd(step.outputTokens), tolerance.kind, `${label}, ${kind}: the tokens out`);
  }
  return kinds;
}

// ─── The books ──────────────────────────────────────────────────────────────

/** A real run of `shape`, the reviews as the script says; completed, or the test fails with what stopped it. */
async function realRun(shape, { rounds = {}, planVerdicts = [], maxReviewRounds = 2, language = "en", words: wordsPerScene = shape.brief.wordsPerScene, ...extra } = {}) {
  const ai = scriptedAi({ scenes: shape.brief.scenesPerChapter, words: wordsPerScene, rounds, planVerdicts, realistic: true });
  const run = await runBook({ brief: shape.brief, options: shape.options, ai, maxReviewRounds, language, ...extra });
  assert.equal(run.state.status, "completed", run.state.lastError?.message);
  return { ...run, ai, replies: ai.replies };
}

// The chapters of a shape are the outline's (the entries of the book), its scenes the host's expectation.
// The entries of the fixtures are ten words each (`outlineEntryFiles`: a title and a line of text).
const forecast = (shape, extra = {}) => estimateAutopilotRun({ brief: shape.brief, scenesPerChapter: shape.brief.scenesPerChapter, outline: { entries: shape.brief.targetChapters, lastChapter: shape.brief.targetChapters, words: 10 * shape.brief.targetChapters }, options: shape.options, maxReviewRounds: 2, models: uniform(), ...extra });

const everyScene = (scenes) => Array.from({ length: scenes }, (_, index) => index + 1);

// ─── The least and the most of every shape ──────────────────────────────────

for (const [name, shape] of Object.entries(SHAPES)) {
  test(`${name}, with every chapter approved at once and the plan too: the calls of the estimate's best case, one by one`, async () => {
    const run = await realRun(shape);
    holds(name, forecast(shape), run, "min");
  });

  test(`${name}, with every round revised, every scene repaired and the plan revised twice: the calls of the estimate's worst case, one by one`, async () => {
    const scenes = everyScene(shape.brief.scenesPerChapter);
    const run = await realRun(shape, { rounds: { default: [scenes, scenes] }, planVerdicts: ["revise", "revise"] });
    holds(name, forecast(shape), run, "max");
  });
}

test("a director who allows three rounds: the worst case is three rounds of every scene and the plan revised twice, call by call", async () => {
  const scenes = everyScene(STORY.brief.scenesPerChapter);
  const run = await realRun(STORY, { maxReviewRounds: 3, rounds: { default: [scenes, scenes, scenes] }, planVerdicts: ["revise", "revise"] });
  const result = forecast(STORY, { maxReviewRounds: 3 });
  assert.equal(result.steps["director-review"].calls.max, 12);
  holds("three rounds, at the most", result, run, "max");
});

test("a book in Italian: the director and the readers are the Italian ones, and the estimate counts their prompts", async () => {
  const minimum = await realRun(STORY, { language: "it" });
  holds("an Italian story", forecast(STORY, { language: "it" }), minimum, "min", { language: "it" });
  const scenes = everyScene(STORY.brief.scenesPerChapter);
  const maximum = await realRun(STORY, { language: "it", rounds: { default: [scenes, scenes] }, planVerdicts: ["revise", "revise"] });
  holds("an Italian story, at its most", forecast(STORY, { language: "it" }), maximum, "max", { language: "it" });
});

test("a panel the director ignores some readers of: the readers are the enabled ones the director does not ignore, and the estimate is told how many", async () => {
  const standard = engine.builtinReaderPersonas("en").filter((persona) => persona.enabled).map((persona) => persona.slug);
  assert.equal(standard.length, 8, "the built-in panel has eight readers");
  const readerWeights = Object.fromEntries(standard.slice(0, 5).map((slug) => [slug, 0]));
  const files = { ...bookFiles({ chapters: STORY.brief.targetChapters }), "director.md": engine.serializeDirector({ ...engine.defaultDirector("en"), readerWeights }) };
  const shape = { brief: STORY.brief, options: { readers: true, maxReaders: 5, readersOnPlan: true, specialists: true } };
  const run = await realRun(shape, { files });
  const result = forecast(shape, { readerPanelSize: 3 });
  assert.equal(result.steps.reader.calls.min, 4 * 3);
  assert.equal(result.steps["plan-reader"].calls.min, 3);
  holds("a panel of three", result, run, "min");
  assert.ok(forecast(shape).steps.reader.calls.min > result.steps.reader.calls.min, "without being told, the estimate counts the whole panel: five readers");
});

// ─── Rounds and repairs the estimate is told ────────────────────────────────

const PINNED = [
  { name: "one round, nothing repaired", rounds: 1, repairs: 0, revisions: 0, script: [[]], verdicts: [] },
  { name: "two rounds, one scene repaired in the first", rounds: 2, repairs: 1, revisions: 0, script: [[1], []], verdicts: [] },
  { name: "two rounds, both scenes repaired in the first, the plan revised once", rounds: 2, repairs: 2, revisions: 1, script: [[1, 2], []], verdicts: ["revise"] },
  { name: "three rounds, a scene repaired in each of the first two, the plan revised twice", rounds: 3, repairs: 2, revisions: 2, script: [[1], [2], []], verdicts: ["revise", "revise"] },
  { name: "three rounds, both scenes repaired in every one, the last revised too", rounds: 3, repairs: 6, revisions: 0, script: [[1, 2], [1, 2], [1, 2]], verdicts: [] },
];

for (const pinned of PINNED) {
  test(`pinned: ${pinned.name}: the estimate is one number, and it is the number of the run, kind by kind`, async () => {
    const run = await realRun(STORY, { rounds: { default: pinned.script }, planVerdicts: pinned.verdicts, maxReviewRounds: 3 });
    const result = forecast(STORY, { maxReviewRounds: 3, scenario: { rounds: pinned.rounds, repairs: pinned.repairs, planRevisions: pinned.revisions } });
    assert.deepEqual([result.calls.min, result.inputTokens.min, result.outputTokens.min], [result.calls.max, result.inputTokens.max, result.outputTokens.max], "the range of what is told is one number");
    holds(pinned.name, result, run, "min");
  });
}

test("a run whose chapters are judged differently, one approved at once and another after three rounds, falls inside the interval, kind by kind", async () => {
  const run = await realRun(STORY, { maxReviewRounds: 3, rounds: { 1: [[]], 2: [[1], []], 3: [[1, 2], [2], []], 4: [[2], []] }, planVerdicts: ["revise"] });
  const kinds = holds("mixed", forecast(STORY, { maxReviewRounds: 3 }), run, "inside");
  assert.equal(kinds["director-review"].calls, 1 + 2 + 3 + 2, "the director judged each chapter as often as the script says");
  assert.equal(kinds.repair.calls, 0 + 1 + 3 + 1);
  assert.equal(kinds.plan.calls, 2, "and the plan twice");
});

// ─── A book that is not at its start ────────────────────────────────────────

test("a book that was stopped after three of its eight chapters and resumed: the estimate counts only the rest, kind by kind, in the calls and in the tokens", async () => {
  const shape = { brief: { idea: IDEA, targetChapters: 8, scenesPerChapter: 2, wordsPerScene: 700 }, options: { readers: true, maxReaders: 3, readersOnPlan: true, specialists: true } };
  const ai = scriptedAi({ scenes: 2, words: 700, realistic: true });
  const firstPart = await runBook({ brief: shape.brief, options: shape.options, ai, start: { brief: { idea: IDEA, ...shape.brief }, options: { pauseAfterPlan: false, ...shape.options }, limits: { chapters: 3 } } });
  assert.equal(firstPart.state.status, "paused");
  const done = ai.calls.length;
  const progress = estimateProgressFromState(firstPart.state);
  assert.deepEqual(progress, { chaptersDone: 3, planned: 8, conceptDone: true, finalDone: false, withoutSummary: 0 });
  await firstPart.session.start({});
  await firstPart.session.waitForIdle();
  const snapshot = await firstPart.session.snapshot();
  assert.equal(snapshot.state.status, "completed", snapshot.state.lastError?.message);
  const result = forecast(shape, { progress, context: estimateContextFromState(firstPart.state) });
  assert.equal(result.chaptersToWrite, 5);
  holds("the rest of a book", result, { calls: ai.calls, replies: ai.replies }, "min", { from: done });
  assert.ok(result.calls.min < forecast(shape).calls.min, "the rest costs less than the whole");
});

test("chapters added to a book that is finished: the plan is extended for the new ones and the estimate counts only those, kind by kind", async () => {
  const shape = { brief: { idea: IDEA, targetChapters: 4, scenesPerChapter: 2, wordsPerScene: 700 }, options: { readers: true, maxReaders: 3, readersOnPlan: true, specialists: true } };
  const ai = scriptedAi({ scenes: 2, words: 700, realistic: true });
  const firstPart = await runBook({ brief: shape.brief, options: shape.options, ai });
  assert.equal(firstPart.state.status, "completed", firstPart.state.lastError?.message);
  const done = ai.calls.length;
  const progress = estimateProgressFromState(firstPart.state);
  assert.deepEqual(progress, { chaptersDone: 4, planned: 4, conceptDone: true, finalDone: true, withoutSummary: 0 });
  addOutlineChapters(firstPart.store, 7);
  await firstPart.session.start({ brief: { idea: IDEA } });
  await firstPart.session.waitForIdle();
  const snapshot = await firstPart.session.snapshot();
  assert.equal(snapshot.state.status, "completed", snapshot.state.lastError?.message);
  const wider = { ...shape, brief: { ...shape.brief, targetChapters: 7 } };
  const result = forecast(wider, { progress, context: estimateContextFromState(firstPart.state) });
  assert.equal(result.chaptersToWrite, 3);
  assert.equal(result.steps["plan-reader"].calls.max, 0, "the readers do not read an extension");
  holds("three chapters added", result, { calls: ai.calls, replies: ai.replies }, "min", { from: done });
});

test("chapters added to a book in a number that is planned in two batches: the plan is extended batch by batch, kind by kind", async () => {
  const shape = { brief: { idea: IDEA, targetChapters: 4, scenesPerChapter: 1, wordsPerScene: 300 }, options: { readers: false, readersOnPlan: false, specialists: true } };
  const ai = scriptedAi({ scenes: 1, words: 300, realistic: true });
  const firstPart = await runBook({ brief: shape.brief, options: shape.options, ai, maxReviewRounds: 1 });
  assert.equal(firstPart.state.status, "completed", firstPart.state.lastError?.message);
  const done = ai.calls.length;
  const progress = estimateProgressFromState(firstPart.state);
  addOutlineChapters(firstPart.store, 29);
  await firstPart.session.start({ brief: { idea: IDEA } });
  await firstPart.session.waitForIdle();
  const snapshot = await firstPart.session.snapshot();
  assert.equal(snapshot.state.status, "completed", snapshot.state.lastError?.message);
  const result = forecast({ ...shape, brief: { ...shape.brief, targetChapters: 29 } }, { progress, maxReviewRounds: 1, context: estimateContextFromState(firstPart.state) });
  assert.equal(result.chaptersToWrite, 25);
  assert.deepEqual([result.steps.plan.calls.min, result.steps.plan.calls.max], [2, 6], "twenty-five chapters are two batches");
  holds("twenty-five chapters added", result, { calls: ai.calls, replies: ai.replies }, "min", { from: done });
});

test("chapters the author wrote and did not summarize: one call each before the plan, and the plan of the rest, kind by kind", async () => {
  const slugOf = (number) => `00${number}-part-${number}`;
  const chapterFile = (number) => `---\ntype: chapter\nid: chapter:${slugOf(number)}\nnumber: ${number}\ntitle: Part ${number}\n---\n\n# Part ${number}\n`;
  const sceneFile = (number) => `---\ntype: paragraph\nid: paragraph:${slugOf(number)}:001-scene\nchapter: chapter:${slugOf(number)}\nnumber: 1\ntitle: Scene\n---\n\n${prose(500, number)}`;
  const files = bookFiles({ chapters: 6 });
  for (let number = 1; number <= 3; number += 1) {
    files[`chapters/${slugOf(number)}/chapter.md`] = chapterFile(number);
    files[`chapters/${slugOf(number)}/001-scene.md`] = sceneFile(number);
  }
  const shape = { brief: { idea: IDEA, targetChapters: 6, scenesPerChapter: 2, wordsPerScene: 700 }, options: { readers: true, maxReaders: 3, readersOnPlan: true, specialists: true } };
  const run = await realRun(shape, { files });
  const kinds = measured(run.calls, run.replies);
  assert.equal(kinds["summarize-imported"].calls, 3);
  assert.equal(kinds.concept.calls, 0, "a book that has prose has its foundation");
  // The book has the files of a book that is just begun, which the host knows the size of: the estimate is told, and does not assume the files of a book with a concept.
  const sizeOf = (path) => engine.countWords(engine.parseMarkdown(files[path]).body);
  const context = { designWords: sizeOf("story-design.md"), worldWords: sizeOf("context.md"), canonWords: 0, secretsWords: 0 };
  const result = forecast(shape, { progress: { chaptersDone: 3, withoutSummary: 3, withoutSummaryWords: 3 * 500 }, context });
  assert.equal(result.chaptersToWrite, 3);
  holds("an author's chapters", result, run, "min");
});

test("an outline that asks for more chapters than the brief: the book has the chapters of the outline, and the estimate counts them, kind by kind", async () => {
  const entry = (number) => `---\ntype: outline-chapter\ntitle: ${JSON.stringify(`Chapter ${number}`)}\n---\n\n${prose(60, number)}\n`;
  const files = bookFiles({ chapters: 0 });
  for (let number = 1; number <= 5; number += 1) files[`outline/chapters/00${number}.md`] = entry(number);
  const shape = { brief: { idea: IDEA, targetChapters: 3, scenesPerChapter: 2, wordsPerScene: 700 }, options: { readers: true, maxReaders: 3, readersOnPlan: true, specialists: true, fillOutline: false } };
  const run = await realRun(shape, { files });
  const result = forecast(shape, { outline: { entries: 5, lastChapter: 5, words: 5 * 60 } });
  assert.equal(result.chapters, 5);
  assert.equal(measured(run.calls, run.replies).scenes.calls, 5, "the run planned the five chapters of the outline");
  holds("an outline of five chapters for a brief of three", result, run, "min");
});

// ─── Books of other sizes ───────────────────────────────────────────────────

test("a draft of twenty-four chapters is planned in two batches, and each revision of the plan asks for both again; kind by kind", async () => {
  const shape = { brief: { idea: IDEA, targetChapters: 24, scenesPerChapter: 1, wordsPerScene: 300 }, options: { readers: false, readersOnPlan: false, specialists: true } };
  const minimum = await realRun(shape, { maxReviewRounds: 1 });
  const result = forecast(shape, { maxReviewRounds: 1 });
  assert.deepEqual([result.steps.plan.calls.min, result.steps.plan.calls.max], [2, 6]);
  holds("a draft", result, minimum, "min");
  const maximum = await realRun(shape, { maxReviewRounds: 1, rounds: { default: [[1]] }, planVerdicts: ["revise", "revise"] });
  holds("a draft, at its most", result, maximum, "max");
});

test("a book of eighty chapters: the story so far and the lists of the chapters stop growing where the prompts stop them, and the estimate stops with them", async () => {
  const shape = { brief: { idea: IDEA, targetChapters: 80, scenesPerChapter: 1, wordsPerScene: 200 }, options: { readers: false, readersOnPlan: false, specialists: true } };
  const run = await realRun(shape, { maxReviewRounds: 1 });
  const result = forecast(shape, { maxReviewRounds: 1 });
  assert.equal(result.steps.plan.calls.min, 4);
  const kinds = holds("eighty chapters", result, run, "min");
  const specialists = run.calls.filter((call) => kindOfLabel(call.label) === "specialists").map(promptTokens);
  assert.ok(specialists[60] > specialists[10] * 2, "the list of the chapters before this one was growing");
  assert.ok(specialists[70] < specialists[60], "until it no longer fit its budget: then the chapters far from this one kept a title and the list was shorter");
  assert.ok(Math.abs(specialists[79] - specialists[70]) < specialists[79] * 0.03, "and from there it grows by a title a chapter: the last chapters carry nearly the same list");
  assert.ok(kinds.specialists.input > 0);
});

test("a director whose profile is long: the estimate is told its size, and counts it in the prompts of the director and in the taste the writer carries", async () => {
  const profile = { ...engine.defaultDirector("en"), body: `# Vision\n\n${prose(700, 3)}\n\n# How I decide\n\n- ${prose(100, 5)}`, taste: ["Concrete scenes", "Subtext in dialogue", "Earned payoffs", "No summary where a scene would do", "A voice that does not change"] };
  const directorWords = engine.countWords(engine.directorPrompt(profile));
  assert.ok(directorWords > 800, `${directorWords} words`);
  const files = { ...bookFiles({ chapters: STORY.brief.targetChapters }), "director.md": engine.serializeDirector(profile) };
  const run = await realRun(STORY, { files });
  const plain = forecast(STORY);
  const told = forecast(STORY, { context: { directorWords } });
  holds("a long director", told, run, "min");
  for (const kind of ["plan-review", "director-review", "final", "write"]) assert.ok(told.steps[kind].inputTokens.min > plain.steps[kind].inputTokens.min * 1.1, `${kind}: the director's profile is in its prompt`);
  assert.equal(told.steps.reader.inputTokens.min, plain.steps.reader.inputTokens.min, "the readers do not read it");
});

test("a book with a synopsis, rules of the author and an evaluation style: the estimate is told the words, and puts them in the prompts that carry them", async () => {
  const synopsis = Array.from({ length: 6 }, (_, index) => `Chapter ${index + 1}: ${words(24, index)}.`).join(" ");
  const rules = ["Never kill the dog, whatever the plot asks of it, and keep the old harbor master alive until the last chapter.", "Write the dialogue sharp and short, and keep every chapter ending on a turn that the next one has to answer."];
  const criteria = Object.fromEntries(["canon_coherence", "pacing", "voice", "tension", "emotional_payoff", "originality", "clarity", "stakes"].map((name, index) => [name, { description: words(22, index) }]));
  const styleFile = `---\ntype: evaluation-guidelines\ntitle: How I judge\ncriteria:\n${Object.entries(criteria).map(([name, { description }]) => `  ${name}:\n    description: ${description}`).join("\n")}\n---\n\n# Method\n\n${words(140)}\n`;
  const state = { ...engine.createAutopilotState(new Date("2026-01-01T00:00:00Z")), constraints: rules };
  const files = { ...bookFiles({ chapters: STORY.brief.targetChapters }), "evaluation-guidelines.md": styleFile, "autopilot/state.json": engine.serializeAutopilotState(state) };
  const shape = { brief: { ...STORY.brief, synopsis }, options: STORY.options };
  const run = await realRun(shape, { files });
  const style = engine.parseEvaluationStyle(styleFile);
  const context = { ...estimateContextFromState(state), styleWords: engine.countWords(engine.evaluationStyleBlock(style)) };
  assert.ok(context.rulesWords > 30 && context.styleWords > 250, JSON.stringify(context));
  const told = forecast(shape, { context });
  const plain = forecast(STORY);
  holds("synopsis, rules and style", told, run, "min");
  for (const kind of ["concept", "plan", "plan-review"]) assert.ok(told.steps[kind].inputTokens.min > plain.steps[kind].inputTokens.min, `${kind}: the synopsis`);
  for (const kind of ["concept", "plan", "plan-review", "scenes", "write", "specialists", "director-review", "final"]) assert.ok(told.steps[kind].inputTokens.min > plain.steps[kind].inputTokens.min, `${kind}: the rules`);
  for (const kind of ["specialists", "director-review", "final", "plan-review"]) assert.ok(told.steps[kind].inputTokens.min > plain.steps[kind].inputTokens.min, `${kind}: the style`);
  for (const kind of ["reader", "scene-summary", "readers-summary", "consolidate"]) assert.equal(told.steps[kind].inputTokens.min, plain.steps[kind].inputTokens.min, `${kind}: none of them`);
});

// ─── The language of the book ───────────────────────────────────────────────

for (const language of ["ru", "zh"]) {
  test(`a book in ${language}: the prose is asked for at what a word of the language costs, as the pipeline sizes its own limit; the calls are the same`, async () => {
    const run = await realRun(STORY, { language });
    const result = forecast(STORY, { language });
    const factor = tokensPerWord(language);
    assert.ok(factor > 2.4);
    const writes = run.calls.filter((call) => kindOfLabel(call.label) === "write");
    assert.equal(writes.length, 8);
    const perScene = result.steps.write.outputTokens.min / 8;
    assert.equal(perScene, 900 * factor, "a scene of nine hundred words, at what a word of the language costs");
    for (const call of writes) {
      assert.equal(call.maxOutputTokens, Math.min(16_000, Math.ceil(900 * factor) + 800), "the limit the pipeline puts on a scene of nine hundred words");
      assert.equal(call.maxOutputTokens, Math.ceil(perScene) + 800, "is what the estimate takes the scene to be, and the margin of 800 tokens the pipeline keeps");
    }
    const kinds = measured(run.calls, run.replies, language);
    for (const kind of KINDS) assert.equal(kinds[kind].calls, result.steps[kind].calls.min, kind);
    const latin = forecast(STORY);
    assert.deepEqual(KINDS.map((kind) => result.steps[kind].calls), KINDS.map((kind) => latin.steps[kind].calls), "the language changes no call");
    // The text the fake AI writes is in Latin script whatever the language, and the router counts every script at four characters a token: with the
    // factor of Latin script the estimate is the router's, so the whole difference of a language is that factor.
    const asLatin = forecast(STORY, { language, tokensPerWord: 2.4 });
    assertNear(measured(run.calls, run.replies, "en").write.input, asLatin.steps.write.inputTokens.min, TOLERANCE.kind, "the prompts of the prose, counted as the router counts them");
  });
}
