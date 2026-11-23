import test from "node:test";
import assert from "node:assert/strict";
import * as engine from "../dist/index.js";
import { MODEL, uniform } from "./estimate-fakes.mjs";

// New exports are read from the namespace so that, before they exist, each test fails on its own.
const { AUTOPILOT_PRESETS, AUTOPILOT_PRESET_IDS, DEFAULT_BRIEF, DEFAULT_OPTIONS, autopilotPreset, estimateAutopilotRun, matchAutopilotPreset, normalizeBrief, normalizeOptions } = engine;

const BRIEF_FIELDS = ["targetChapters", "scenesPerChapter", "wordsPerScene"];
const OPTION_FIELDS = ["readers", "maxReaders", "readersOnPlan", "specialists"];
const wordsOf = (preset) => preset.brief.targetChapters * preset.brief.scenesPerChapter * preset.brief.wordsPerScene;
const preset = (id) => AUTOPILOT_PRESETS.find((entry) => entry.id === id);

/** The values of a preset as a form hands them over. */
const valuesOf = (entry) => ({ brief: { ...entry.brief }, options: { ...entry.options }, maxReviewRounds: entry.maxReviewRounds });

test("the engine has three presets, from the shortest book to the longest, each with an id the interface can name and translate", () => {
  assert.ok(Array.isArray(AUTOPILOT_PRESETS));
  assert.deepEqual(AUTOPILOT_PRESETS.map((entry) => entry.id), ["story", "novella", "novel-draft"]);
  assert.deepEqual([...AUTOPILOT_PRESET_IDS], ["story", "novella", "novel-draft"]);
  assert.equal(autopilotPreset("story"), AUTOPILOT_PRESETS[0]);
  assert.equal(autopilotPreset("novel-draft"), AUTOPILOT_PRESETS[2]);
  for (const unknown of ["", "Story", "novel", "custom", "__proto__", "constructor", undefined, null, 3]) assert.equal(autopilotPreset(unknown), undefined, String(unknown));
  const sizes = AUTOPILOT_PRESETS.map(wordsOf);
  assert.deepEqual([...sizes].sort((a, b) => a - b), sizes, "from the shortest to the longest");
  assert.equal(new Set(sizes).size, 3);
});

test("a preset is numbers: the three of the brief, the four that change the cost, and the rounds of the review. Names and descriptions are the interface's", () => {
  for (const entry of AUTOPILOT_PRESETS) {
    assert.deepEqual(Object.keys(entry).sort(), ["brief", "id", "maxReviewRounds", "options"], entry.id);
    assert.deepEqual(Object.keys(entry.brief).sort(), [...BRIEF_FIELDS].sort(), entry.id);
    assert.deepEqual(Object.keys(entry.options).sort(), [...OPTION_FIELDS].sort(), entry.id);
    const strings = [];
    JSON.stringify(entry, (key, value) => { if (typeof value === "string") strings.push(key); return value; });
    assert.deepEqual(strings, ["id"], `${entry.id}: no name, no description, no text but the id`);
    for (const field of BRIEF_FIELDS) assert.ok(Number.isInteger(entry.brief[field]) && entry.brief[field] > 0, `${entry.id}.${field}`);
    for (const field of ["readers", "readersOnPlan", "specialists"]) assert.equal(typeof entry.options[field], "boolean", `${entry.id}.${field}`);
    assert.ok(Number.isInteger(entry.options.maxReaders) && entry.options.maxReaders > 0);
    assert.ok([1, 2, 3].includes(entry.maxReviewRounds), `${entry.id}: the rounds a director is allowed`);
  }
});

test("the presets cannot be changed by whoever reads them: the list, every preset and everything in it is frozen", () => {
  assert.ok(Object.isFrozen(AUTOPILOT_PRESETS));
  assert.ok(Object.isFrozen(AUTOPILOT_PRESET_IDS));
  for (const entry of AUTOPILOT_PRESETS) {
    assert.ok(Object.isFrozen(entry) && Object.isFrozen(entry.brief) && Object.isFrozen(entry.options), entry.id);
    assert.throws(() => { entry.brief.targetChapters = 300; }, TypeError, entry.id);
    assert.throws(() => { entry.options.readers = !entry.options.readers; }, TypeError);
    assert.throws(() => { entry.maxReviewRounds = 3; }, TypeError);
  }
  assert.throws(() => { AUTOPILOT_PRESETS.push({}); }, TypeError);
});

test("a story is three to five short chapters; a novella forty to sixty thousand words; the draft of a novel ninety to a hundred and twenty thousand; and none is three hundred chapters", () => {
  const story = preset("story");
  assert.ok(story.brief.targetChapters >= 3 && story.brief.targetChapters <= 5, "three to five chapters");
  assert.ok(story.brief.scenesPerChapter * story.brief.wordsPerScene <= 3000, "short chapters");
  assert.ok(wordsOf(story) >= 5000 && wordsOf(story) <= 12_000, `a story of ${wordsOf(story)} words`);
  assert.ok(wordsOf(preset("novella")) >= 40_000 && wordsOf(preset("novella")) <= 60_000, `a novella of ${wordsOf(preset("novella"))} words`);
  assert.ok(wordsOf(preset("novel-draft")) >= 90_000 && wordsOf(preset("novel-draft")) <= 120_000, `the draft of a novel of ${wordsOf(preset("novel-draft"))} words`);
  for (const entry of AUTOPILOT_PRESETS) assert.ok(entry.brief.targetChapters <= 60, `${entry.id}: ${entry.brief.targetChapters} chapters is not a starting point`);
});

test("the values of the presets, as the documentation gives them: a change to one is a decision", () => {
  assert.deepEqual(valuesOf(preset("story")), { brief: { targetChapters: 4, scenesPerChapter: 2, wordsPerScene: 900 }, options: { readers: true, maxReaders: 3, readersOnPlan: false, specialists: true }, maxReviewRounds: 2 });
  assert.deepEqual(valuesOf(preset("novella")), { brief: { targetChapters: 12, scenesPerChapter: 3, wordsPerScene: 1400 }, options: { readers: true, maxReaders: 5, readersOnPlan: true, specialists: true }, maxReviewRounds: 2 });
  assert.deepEqual(valuesOf(preset("novel-draft")), { brief: { targetChapters: 24, scenesPerChapter: 3, wordsPerScene: 1500 }, options: { readers: true, maxReaders: 3, readersOnPlan: true, specialists: true }, maxReviewRounds: 1 });
});

test("the values of a preset are the values the engine takes: filling a form with them and saving it changes nothing", () => {
  for (const entry of AUTOPILOT_PRESETS) {
    const brief = normalizeBrief(entry.brief);
    for (const field of BRIEF_FIELDS) assert.equal(brief[field], entry.brief[field], `${entry.id}.${field}`);
    const options = normalizeOptions(entry.options);
    for (const field of OPTION_FIELDS) assert.equal(options[field], entry.options[field], `${entry.id}.${field}`);
  }
});

test("the defaults of a new book are the novella: the form that opens with them says so", () => {
  assert.equal(matchAutopilotPreset({ brief: DEFAULT_BRIEF, options: DEFAULT_OPTIONS }), "novella");
  assert.equal(matchAutopilotPreset({ brief: DEFAULT_BRIEF, options: DEFAULT_OPTIONS, maxReviewRounds: 2 }), "novella");
  assert.equal(matchAutopilotPreset({}), "novella", "what is not given is the default");
  assert.equal(matchAutopilotPreset(undefined), "novella");
  assert.equal(matchAutopilotPreset(null), "novella");
  for (const field of BRIEF_FIELDS) assert.equal(preset("novella").brief[field], DEFAULT_BRIEF[field], field);
  for (const field of OPTION_FIELDS) assert.equal(preset("novella").options[field], DEFAULT_OPTIONS[field], field);
});

test("every preset names itself, and no other: its own values give its id, and nobody else's do", () => {
  for (const entry of AUTOPILOT_PRESETS) {
    assert.equal(matchAutopilotPreset(valuesOf(entry)), entry.id);
    assert.equal(matchAutopilotPreset({ brief: entry.brief, options: entry.options }), entry.id, "the rounds are compared only when they are given");
    assert.equal(matchAutopilotPreset({ brief: entry.brief, options: entry.options, maxReviewRounds: entry.maxReviewRounds }), entry.id);
  }
  const ids = AUTOPILOT_PRESETS.map((entry) => matchAutopilotPreset(valuesOf(entry)));
  assert.equal(new Set(ids).size, ids.length);
});

test("one value of the cost changed makes the book a custom one, and the answer is null: the interface calls it custom", () => {
  const changes = [
    (values) => { values.brief.targetChapters += 1; },
    (values) => { values.brief.targetChapters -= 1; },
    (values) => { values.brief.scenesPerChapter += 1; },
    (values) => { values.brief.wordsPerScene += 100; },
    (values) => { values.brief.wordsPerScene -= 100; },
    (values) => { values.options.readers = !values.options.readers; },
    (values) => { values.options.maxReaders += 1; },
    (values) => { values.options.maxReaders -= 1; },
    (values) => { values.options.readersOnPlan = !values.options.readersOnPlan; },
    (values) => { values.options.specialists = !values.options.specialists; },
    (values) => { values.maxReviewRounds = values.maxReviewRounds === 3 ? 2 : values.maxReviewRounds + 1; },
  ];
  for (const entry of AUTOPILOT_PRESETS) {
    changes.forEach((change, index) => {
      const values = valuesOf(entry);
      change(values);
      assert.equal(matchAutopilotPreset(values), null, `${entry.id}, change ${index}`);
    });
  }
  assert.equal(matchAutopilotPreset({ brief: { targetChapters: 300, scenesPerChapter: 3, wordsPerScene: 1400 } }), null);
});

test("what does not change what a book costs does not change its preset: the pauses, the budgets, the outline, the idea", () => {
  const rest = { pauseAfterPlan: false, pauseAfterEachChapter: true, chaptersPerRun: 4, budgetLimit: 12.5, budgetTokens: 900_000, syncAfterChapter: false, fillOutline: false, frozenEdits: "auto", publishEvery: "chapter" };
  for (const entry of AUTOPILOT_PRESETS) {
    const values = valuesOf(entry);
    values.brief = { ...values.brief, idea: "A glassmaker's daughter.", synopsis: "One. Two. Three.", genre: "mystery", audience: "adults" };
    values.options = { ...values.options, ...rest };
    assert.equal(matchAutopilotPreset(values), entry.id, entry.id);
  }
});

test("the values are compared as the engine takes them: text that is a number, a number with decimals, a value past the limits", () => {
  const story = valuesOf(preset("story"));
  for (const brief of [{ ...story.brief, targetChapters: "4" }, { ...story.brief, targetChapters: 4.4 }, { ...story.brief, wordsPerScene: " 900 " }, { ...story.brief, scenesPerChapter: 2.2 }]) {
    assert.equal(matchAutopilotPreset({ ...story, brief }), "story", JSON.stringify(brief));
    assert.equal(matchAutopilotPreset({ ...story, brief }), matchAutopilotPreset({ ...story, brief: normalizeBrief(brief) }));
  }
  assert.equal(matchAutopilotPreset({ ...story, brief: { ...story.brief, targetChapters: 4.6 } }), null, "five chapters");
  assert.equal(matchAutopilotPreset({ ...story, options: { ...story.options, readers: "true" } }), "story");
  assert.equal(matchAutopilotPreset({ ...story, options: { ...story.options, maxReaders: "3" } }), "story");
  assert.equal(matchAutopilotPreset({ ...story, brief: { ...story.brief, wordsPerScene: 50 } }), null, "less than the engine allows is what the engine allows, and no preset is that");
  const wild = { brief: { targetChapters: "many", scenesPerChapter: null, wordsPerScene: {} }, options: { readers: "maybe", maxReaders: [] } };
  assert.equal(matchAutopilotPreset(wild), matchAutopilotPreset({ brief: normalizeBrief(wild.brief), options: normalizeOptions(wild.options) }), "what is not a number is the default");
  assert.equal(matchAutopilotPreset(wild), "novella");
});

test("a value that is no value does not break the matching: it is as if it was not given; the rounds are taken as the director's profile takes them", () => {
  for (const garbage of [0, 1, "story", true, [], () => 1, Symbol("x")]) assert.equal(matchAutopilotPreset(garbage), "novella", String(garbage));
  for (const garbage of [null, 3, "x", []]) assert.equal(matchAutopilotPreset({ brief: garbage, options: garbage }), "novella", String(garbage));
  for (const garbage of [null, undefined, "x", [], {}, Number.NaN]) assert.equal(matchAutopilotPreset({ ...valuesOf(preset("story")), maxReviewRounds: garbage }), "story", `rounds: ${String(garbage)}`);
  assert.equal(matchAutopilotPreset({ ...valuesOf(preset("novel-draft")), maxReviewRounds: 0 }), "novel-draft", "a profile cannot ask for less than one round");
  assert.equal(matchAutopilotPreset({ ...valuesOf(preset("novel-draft")), maxReviewRounds: "1" }), "novel-draft");
  assert.equal(matchAutopilotPreset({ ...valuesOf(preset("story")), maxReviewRounds: 2.4 }), "story");
  assert.equal(matchAutopilotPreset({ ...valuesOf(preset("story")), maxReviewRounds: 9 }), null, "nor for more than three, and no preset is three");
});

test("every preset can be estimated: the chapters and the words it says, a number of calls that is a book's and not a library's", () => {
  for (const entry of AUTOPILOT_PRESETS) {
    const result = estimateAutopilotRun({ ...valuesOf(entry), models: uniform(MODEL) });
    assert.equal(result.chapters, entry.brief.targetChapters, entry.id);
    assert.equal(result.words, wordsOf(entry), entry.id);
    assert.ok(result.calls.min > 10 && result.calls.max < 1000, `${entry.id}: ${result.calls.min} to ${result.calls.max} calls`);
    assert.deepEqual(result.warnings, [], entry.id);
  }
  const [story, novella, draft] = AUTOPILOT_PRESETS.map((entry) => estimateAutopilotRun({ ...valuesOf(entry), models: uniform(MODEL) }));
  assert.ok(story.calls.min < novella.calls.min && novella.calls.min < draft.calls.min, "the longer the book, the more calls, from the story to the draft");
  assert.ok(story.calls.max < novella.calls.max && novella.calls.max < draft.calls.max);
  assert.ok(story.cost.max < novella.cost.max && novella.cost.max < draft.cost.max, "and the more it costs");
});
