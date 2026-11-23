import test from "node:test";
import assert from "node:assert/strict";
import * as engine from "../dist/index.js";
import { uniform } from "./estimate-fakes.mjs";

// New exports are read from the namespace so that, before they exist, each test fails on its own.
const { AUTOPILOT_PRESETS, AUTOPILOT_PRESET_IDS, DEFAULT_BRIEF, DEFAULT_OPTIONS, autopilotPresetSkeleton, estimateAutopilotRun } = engine;

const skeleton = (id) => autopilotPresetSkeleton(id);

test("the engine has three starting points, from the shortest book to the longest, each with the id the interface can name", () => {
  assert.deepEqual([...AUTOPILOT_PRESET_IDS], ["story", "novella", "novel-draft"]);
  assert.deepEqual(AUTOPILOT_PRESETS.map((entry) => entry.id), ["story", "novella", "novel-draft"]);
});

test("a starting point gives the chapter entries a new book's outline starts with, the words of a scene and the review: nothing else", () => {
  assert.deepEqual(skeleton("story"), { id: "story", chapters: 4, wordsPerScene: 900, options: { readers: true, maxReaders: 3, readersOnPlan: false, specialists: true }, maxReviewRounds: 2 });
  assert.deepEqual(skeleton("novella"), { id: "novella", chapters: 12, wordsPerScene: 1400, options: { readers: true, maxReaders: 5, readersOnPlan: true, specialists: true }, maxReviewRounds: 2 });
  assert.deepEqual(skeleton("novel-draft"), { id: "novel-draft", chapters: 24, wordsPerScene: 1500, options: { readers: true, maxReaders: 3, readersOnPlan: true, specialists: true }, maxReviewRounds: 1 });
});

test("the starting points are read-only: the list, every one and everything in it is frozen", () => {
  assert.equal(Object.isFrozen(AUTOPILOT_PRESETS), true);
  assert.equal(Object.isFrozen(skeleton("novella")), true);
  assert.equal(Object.isFrozen(skeleton("novella").options), true);
  assert.throws(() => { skeleton("novella").chapters = 300; }, TypeError);
  assert.throws(() => { skeleton("novella").options.readers = false; }, TypeError);
});

test("an id that is no starting point has no skeleton: the custom book, a number, an object, the words of a prototype", () => {
  for (const id of ["custom", null, undefined, 12, {}, "__proto__", "Novella", ""]) assert.equal(skeleton(id), undefined, String(id));
});

test("the novella is what a new book starts with: the defaults of the brief and of the options say the same", () => {
  assert.equal(skeleton("novella").wordsPerScene, DEFAULT_BRIEF.wordsPerScene);
  for (const [key, value] of Object.entries(skeleton("novella").options)) assert.equal(DEFAULT_OPTIONS[key], value, key);
});

test("every starting point can be estimated: the chapters are the ones its skeleton creates, and the words follow", () => {
  for (const preset of AUTOPILOT_PRESETS) {
    const result = estimateAutopilotRun({
      brief: { wordsPerScene: preset.wordsPerScene },
      outline: { entries: preset.chapters, lastChapter: preset.chapters },
      options: preset.options,
      maxReviewRounds: preset.maxReviewRounds,
      models: uniform(),
    });
    assert.equal(result.chapters, preset.chapters, preset.id);
    assert.ok(result.calls.min > 0 && result.calls.min <= result.calls.max, `${preset.id}: calls`);
    assert.ok(result.calls.min >= preset.chapters, `${preset.id}: at least one call a chapter`);
  }
  assert.equal(estimateAutopilotRun({ models: uniform() }).chapters, 0, "a book with no chapter in its outline is estimated with none");
});

test("the three starting points are a short story, a novella and a draft, from four chapters to twenty-four", () => {
  assert.ok(skeleton("story").chapters >= 3 && skeleton("story").chapters <= 5, "three to five chapters");
  assert.ok(skeleton("novella").chapters * 3 * skeleton("novella").wordsPerScene >= 40_000, "a novella is forty thousand words or more");
  assert.ok(skeleton("novel-draft").chapters * 3 * skeleton("novel-draft").wordsPerScene <= 120_000, "a draft is at most a hundred and twenty thousand words");
  for (const entry of AUTOPILOT_PRESETS) assert.ok(entry.chapters <= 60, `${entry.id}: ${entry.chapters} chapters is a starting point`);
});
