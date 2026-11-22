import test from "node:test";
import assert from "node:assert/strict";
import * as engine from "../dist/index.js";
import { MemoryBookStore, createFakeAutopilotAi, seedBookFiles } from "../dist/testing/index.js";

// New exports are read from the namespace so that, before they exist, each test fails on its own.
const { AI_CAPABILITIES, AutopilotSession, createAutopilotState, parseAutopilotState, parseMarkdown, serializeAutopilotState } = engine;

const STATE = "autopilot/state.json";
const ACTIVITY = "autopilot/activity.json";
const FAST = { readers: false, readersOnPlan: false, pauseAfterPlan: false };
const SIX = { idea: "x", targetChapters: 6, scenesPerChapter: 1, wordsPerScene: 300 };

const slugOf = (number) => `00${number}-part-${number}`;
const chapterPath = (number) => `chapters/${slugOf(number)}/chapter.md`;
const scenePath = (number) => `chapters/${slugOf(number)}/001-scene.md`;
const chapterFile = (number, summary) => `---\ntype: chapter\nid: chapter:${slugOf(number)}\nnumber: ${number}\ntitle: Part ${number}\n${summary ? `summary: ${summary}\n` : ""}---\n\n# Part ${number}\n`;
const sceneFile = (number) => `---\ntype: paragraph\nid: paragraph:${slugOf(number)}:001-scene\nchapter: chapter:${slugOf(number)}\nnumber: 1\ntitle: Scene\n---\n\nEvents of the author's chapter ${number}: ${"something important happens. ".repeat(40)}`;

/** A manuscript: `chapters` chapters by the author, with a summary only for the numbers in `summaries` (number → text). */
function manuscript({ chapters = 5, summaries = {}, language = "en" } = {}) {
  const files = seedBookFiles({ language });
  for (let number = 1; number <= chapters; number += 1) {
    files[chapterPath(number)] = chapterFile(number, summaries[number]);
    files[scenePath(number)] = sceneFile(number);
  }
  return files;
}

function reply(json, extra = {}) {
  return { text: JSON.stringify(json), json, usage: { inputTokens: 100, outputTokens: 50, cachedInputTokens: 0 }, model: "fake-model", provider: "fake", cost: 0.001, currency: "USD", ...extra };
}

/** The fake AI, with some replies replaced: `script(request)` returns undefined (the default reply), an Error or a response. */
function scripted(script, options = {}) {
  const base = createFakeAutopilotAi(options);
  return {
    calls: base.calls,
    async complete(request) {
      const custom = script(request);
      if (custom === undefined) return base.complete(request);
      base.calls.push(request);
      request.signal?.throwIfAborted();
      if (custom instanceof Error) throw custom;
      return custom;
    },
  };
}

const SUMMARY_LABEL = /^autopilot:summarize-imported:(\d+)$/;

/** The summary the model gives a chapter is `Summary of imported chapter N.`, whatever else it is asked. */
function summarizing(extra = () => undefined, options = {}) {
  return scripted((request) => {
    const match = SUMMARY_LABEL.exec(request.label);
    if (!match) return undefined;
    return extra(request, Number(match[1])) ?? reply({ summary: `Summary of imported chapter ${match[1]}.` });
  }, options);
}

const summaryCalls = (ai) => ai.calls.filter((call) => SUMMARY_LABEL.test(call.label));
const summaryNumbers = (ai) => summaryCalls(ai).map((call) => Number(SUMMARY_LABEL.exec(call.label)[1]));

async function run(files, ai, start = { brief: SIX, options: FAST }, extra = {}) {
  const store = new MemoryBookStore(files);
  const events = [];
  const session = new AutopilotSession({ bookId: "book", store, ai, host: "server", hostLabel: "test", retryDelayMs: 0, ...extra });
  session.subscribe((event) => events.push(event));
  await session.start(start);
  await session.waitForIdle();
  return { store, session, events, state: parseAutopilotState(store.files.get(STATE)) };
}

async function resume(context, start) {
  await context.session.start(start);
  await context.session.waitForIdle();
  return parseAutopilotState(context.store.files.get(STATE));
}

const summaryOf = (store, number) => parseMarkdown(store.files.get(chapterPath(number))).frontmatter.summary;

// ─── A manuscript of five chapters without a summary ────────────────────────────────────────────────────────────────────

test("five imported chapters without a summary are summarized, one step each, before anything is planned or written", async () => {
  const ai = summarizing();
  const original = manuscript();
  const { store, state, events } = await run(original, ai);
  assert.equal(state.status, "completed", state.lastError?.message);
  assert.deepEqual(summaryNumbers(ai), [1, 2, 3, 4, 5], "one call per chapter, in order");
  const labels = ai.calls.map((call) => call.label);
  assert.deepEqual(labels.slice(0, 5), [1, 2, 3, 4, 5].map((number) => `autopilot:summarize-imported:${number}`), "they come first: a book with prose has no concept to make");
  assert.equal(labels[5], "autopilot:plan");
  for (const call of summaryCalls(ai)) assert.equal(call.capability, AI_CAPABILITIES.summary, "the cheap model of simple tasks");
  assert.equal(AI_CAPABILITIES.summary, "simple-tasks");

  for (let number = 1; number <= 5; number += 1) {
    const chapter = parseMarkdown(store.files.get(chapterPath(number)));
    assert.equal(chapter.frontmatter.summary, `Summary of imported chapter ${number}.`);
    assert.equal(chapter.frontmatter.type, "chapter");
    assert.equal(chapter.frontmatter.id, `chapter:${slugOf(number)}`);
    assert.equal(chapter.frontmatter.number, number);
    assert.equal(chapter.frontmatter.title, `Part ${number}`);
    assert.equal(chapter.body, `# Part ${number}`);
    assert.equal(store.files.get(scenePath(number)), original[scenePath(number)], "the author's scene is not touched");
    const call = summaryCalls(ai)[number - 1];
    assert.ok(call.user.includes(`Events of the author's chapter ${number}:`), "the model reads the chapter");
    assert.ok(call.user.includes("Part " + number), "and knows which one it is");
    assert.equal(call.json.name, "chapter_summary");
  }

  // One commit per step, each with the chapter file and the autopilot's own files.
  for (let number = 1; number <= 5; number += 1) {
    const commits = store.commits.filter((commit) => commit.paths.includes(chapterPath(number)));
    assert.equal(commits.length, 1, `chapter ${number}: one commit`);
    assert.ok(commits[0].paths.includes(STATE) && commits[0].paths.includes(ACTIVITY));
    assert.match(commits[0].message, new RegExp(`^Autopilot: .*${number}`));
  }
  const started = events.filter((event) => event.type === "task-started" && event.activity.task === "summarize-imported");
  assert.deepEqual(started.map((event) => event.activity.chapterNumber), [1, 2, 3, 4, 5]);

  // What they say reaches the next steps: the plan, and the chapter that is written after them.
  const plan = ai.calls.find((call) => call.label === "autopilot:plan");
  const write = ai.calls.find((call) => call.label === "autopilot:write:6.1");
  for (const prompt of [plan.user, write.user]) {
    assert.match(prompt, /STORY SO FAR \(before (chapter 6|this chapter)\):/);
    for (let number = 1; number <= 5; number += 1) assert.ok(prompt.includes(`Summary of imported chapter ${number}.`), `chapter ${number} is in the story so far`);
  }
  assert.deepEqual(state.plan.chapters.slice(0, 5).map((chapter) => [chapter.imported, chapter.summary]), [1, 2, 3, 4, 5].map((number) => [true, `Summary of imported chapter ${number}.`]));
});

test("the fake AI of the testing entry point answers the step", async () => {
  const { store, state } = await run(manuscript({ chapters: 2 }), createFakeAutopilotAi(), { brief: { ...SIX, targetChapters: 3 }, options: FAST });
  assert.equal(state.status, "completed", state.lastError?.message);
  for (const number of [1, 2]) assert.ok(String(summaryOf(store, number)).length > 10, `chapter ${number}`);
});

test("the step is shown with a title and a reason in the language of the book", async () => {
  for (const [language, title, reason, next] of [
    ["en", /^Summarizing chapter 2 «Part 2», written by the author$/, /story so far/, /./],
    ["it", /^Riassunto del capitolo 2 «Part 2», scritto dall'autore$/, /storia finora/, /./],
  ]) {
    const ai = summarizing();
    const { events, store } = await run(manuscript({ chapters: 3, language }), ai, { brief: { ...SIX, targetChapters: 4 }, options: FAST });
    const activities = events.filter((event) => event.type === "task-finished" && event.activity.task === "summarize-imported").map((event) => event.activity);
    assert.equal(activities.length, 3, language);
    const second = activities[1];
    assert.match(second.title, title, language);
    assert.match(second.reason, reason, language);
    assert.match(second.next, next, language);
    assert.equal(second.phase, "plan");
    assert.equal(second.status, "succeeded");
    assert.equal(second.chapterNumber, 2);
    assert.match(second.summary, /Summary of imported chapter 2/);
    const logged = JSON.parse(store.files.get(ACTIVITY)).activities.filter((activity) => activity.task === "summarize-imported");
    assert.equal(logged.length, 3, "it is in the activity log too");
  }
});

// ─── A manuscript where some chapters have their summary ────────────────────────────────────────────────────────────────

test("a chapter that already has a summary is skipped and left as it is", async () => {
  const original = manuscript({ summaries: { 2: "The author's own summary of chapter 2.", 4: "The author's own summary of chapter 4." } });
  const ai = summarizing();
  const { store, state } = await run(original, ai);
  assert.equal(state.status, "completed", state.lastError?.message);
  assert.deepEqual(summaryNumbers(ai), [1, 3, 5], "only the chapters without one");
  for (const number of [2, 4]) assert.equal(store.files.get(chapterPath(number)), original[chapterPath(number)], `chapter ${number} is byte for byte what the author wrote`);
  const plan = ai.calls.find((call) => call.label === "autopilot:plan").user;
  for (const text of ["Summary of imported chapter 1.", "The author's own summary of chapter 2.", "Summary of imported chapter 3.", "The author's own summary of chapter 4.", "Summary of imported chapter 5."]) {
    assert.ok(plan.includes(text), text);
  }
  assert.deepEqual(state.plan.chapters.slice(0, 5).map((chapter) => chapter.summary), ["Summary of imported chapter 1.", "The author's own summary of chapter 2.", "Summary of imported chapter 3.", "The author's own summary of chapter 4.", "Summary of imported chapter 5."]);
});

test("a manuscript whose chapters all have their summary costs nothing more than it did", async () => {
  const summaries = Object.fromEntries([1, 2, 3].map((number) => [number, `Summary ${number}.`]));
  const ai = summarizing();
  const { state } = await run(manuscript({ chapters: 3, summaries }), ai, { brief: { ...SIX, targetChapters: 4 }, options: FAST });
  assert.equal(state.status, "completed", state.lastError?.message);
  assert.deepEqual(summaryNumbers(ai), []);
});

test("a chapter that has scenes but no chapter.md gets one, with its summary", async () => {
  const files = manuscript({ chapters: 2 });
  delete files[chapterPath(1)];
  const ai = summarizing();
  const { store, state } = await run(files, ai, { brief: { ...SIX, targetChapters: 3 }, options: FAST });
  assert.equal(state.status, "completed", state.lastError?.message);
  assert.deepEqual(summaryNumbers(ai), [1, 2]);
  const created = parseMarkdown(store.files.get(chapterPath(1)));
  assert.deepEqual([created.frontmatter.type, created.frontmatter.id, created.frontmatter.number, created.frontmatter.summary], ["chapter", `chapter:${slugOf(1)}`, 1, "Summary of imported chapter 1."]);
});

// ─── Repeatable, resumable, and under the control of the author ─────────────────────────────────────────────────────────

test("a second resume does not summarize again", async () => {
  const ai = summarizing();
  const context = await run(manuscript(), ai, { brief: SIX, options: { ...FAST, pauseAfterPlan: true } });
  assert.equal(context.state.status, "paused", context.state.lastError?.message);
  assert.equal(summaryCalls(ai).length, 5);
  const before = ai.calls.length;
  const state = await resume(context, { options: { pauseAfterPlan: false } });
  assert.equal(state.status, "completed", state.lastError?.message);
  assert.equal(summaryCalls(ai).length, 5, "the five summaries are not asked again");
  assert.ok(ai.calls.length > before);
  const again = await resume(context);
  assert.equal(again.status, "completed");
  assert.equal(summaryCalls(ai).length, 5);
});

test("a run that stopped in the middle goes on with the chapters that are left, and repeats none", async () => {
  let failed = false;
  const ai = summarizing((_request, number) => {
    if (number === 3 && !failed) {
      failed = true;
      return new Error("The disk is full.");
    }
    return undefined;
  });
  const context = await run(manuscript(), ai);
  assert.equal(context.state.status, "error");
  assert.deepEqual([1, 2, 3, 4, 5].map((number) => Boolean(summaryOf(context.store, number))), [true, true, false, false, false]);
  const committed = context.store.commits.length;
  const state = await resume(context);
  assert.equal(state.status, "completed", state.lastError?.message);
  assert.deepEqual(summaryNumbers(ai), [1, 2, 3, 3, 4, 5], "chapter 3 again after its failure, and nothing before it");
  assert.ok(context.store.commits.length > committed);
  assert.deepEqual([1, 2, 3, 4, 5].map((number) => summaryOf(context.store, number)), [1, 2, 3, 4, 5].map((number) => `Summary of imported chapter ${number}.`));
});

test("a pause between two chapters is respected, and the run resumes where it stopped", async () => {
  let session;
  const ai = summarizing((_request, number) => {
    if (number === 2) session.pause("after-step");
    return undefined;
  });
  const store = new MemoryBookStore(manuscript());
  session = new AutopilotSession({ bookId: "book", store, ai, host: "server", hostLabel: "test", retryDelayMs: 0 });
  await session.start({ brief: SIX, options: FAST });
  await session.waitForIdle();
  let state = parseAutopilotState(store.files.get(STATE));
  assert.equal(state.status, "paused");
  assert.deepEqual(summaryNumbers(ai), [1, 2], "the step that was running finished and was saved");
  assert.ok(summaryOf(store, 2));
  await session.start();
  await session.waitForIdle();
  state = parseAutopilotState(store.files.get(STATE));
  assert.equal(state.status, "completed", state.lastError?.message);
  assert.deepEqual(summaryNumbers(ai), [1, 2, 3, 4, 5]);
});

test("the token budget stops the summaries like any other step, and raising it lets them finish", async () => {
  const ai = summarizing();
  const context = await run(manuscript(), ai, { brief: SIX, options: { ...FAST, budgetTokens: 400 } });
  assert.equal(context.state.status, "paused", context.state.lastError?.message);
  assert.match(context.state.message, /[Tt]oken budget/);
  assert.deepEqual(summaryNumbers(ai), [1, 2, 3], "150 tokens a call: the limit of 400 is reached after the third");
  const state = await resume(context, { options: { budgetTokens: 0 } });
  assert.equal(state.status, "completed", state.lastError?.message);
  assert.deepEqual(summaryNumbers(ai), [1, 2, 3, 4, 5]);
});

test("a chapter whose chapter.md cannot be read is refused before the model is asked about it", async () => {
  const files = manuscript({ chapters: 3 });
  const damaged = "---\ntype: chapter\nid: chapter:002-part-2\nnumber: 2\ntitle: Part 2: the harbor\n---\n\n# Part 2\n";
  files[chapterPath(2)] = damaged;
  const ai = summarizing();
  const { store, state } = await run(files, ai, { brief: { ...SIX, targetChapters: 4 }, options: FAST });
  assert.equal(state.status, "error");
  assert.ok(state.lastError.message.includes(chapterPath(2)), state.lastError.message);
  assert.match(state.lastError.message, /line 5\b/);
  assert.deepEqual(summaryNumbers(ai), [1], "nothing was spent on the chapter that cannot be saved");
  assert.equal(store.files.get(chapterPath(2)), damaged);
});

// ─── A book that already has a plan, and a book that is complete ────────────────────────────────────────────────────────

function plannedChapter(number, status, imported) {
  return {
    number,
    title: `Part ${number}`,
    slug: slugOf(number),
    summary: "",
    goal: "",
    pov: [],
    keyEvents: [],
    reveals: [],
    status,
    ...(imported ? { imported: true } : {}),
    scenes: imported ? [{ number: 1, title: "Scene", goal: "", beats: [], characters: [], status: "reviewed", slug: "001-scene", path: scenePath(number), revisions: 0 }] : [],
  };
}

test("a plan saved before the summaries existed is completed with them before the next chapter is written", async () => {
  const state = createAutopilotState(new Date(0), { idea: "x", targetChapters: 3, scenesPerChapter: 1, wordsPerScene: 300 }, FAST);
  state.concept = { done: true, generated: false, secrets: [] };
  state.plan = { chapters: [plannedChapter(1, "done", true), plannedChapter(2, "done", true), { ...plannedChapter(3, "planned", false), title: "Part 3" }], approved: true, rounds: 0, revisionNotes: [], readerReactions: [], readersDone: true, awaitingAuthor: false };
  const files = { ...manuscript({ chapters: 2 }), [STATE]: serializeAutopilotState(state) };
  const ai = summarizing();
  const { store, state: after } = await run(files, ai, { brief: { targetChapters: 3 }, options: FAST });
  assert.equal(after.status, "completed", after.lastError?.message);
  assert.deepEqual(summaryNumbers(ai), [1, 2]);
  const labels = ai.calls.map((call) => call.label);
  assert.ok(labels.indexOf("autopilot:summarize-imported:2") < labels.indexOf("autopilot:scenes:3"), "before anything is written after them");
  const write = ai.calls.find((call) => call.label === "autopilot:write:3.1");
  assert.ok(write.user.includes("Summary of imported chapter 1.") && write.user.includes("Summary of imported chapter 2."), "the chapter written after them knows them");
  assert.deepEqual(after.plan.chapters.slice(0, 2).map((chapter) => chapter.summary), ["Summary of imported chapter 1.", "Summary of imported chapter 2."]);
  assert.equal(summaryOf(store, 1), "Summary of imported chapter 1.");
});

test("a summary the author adds to chapter.md reaches a plan that was saved without it, with no call to the model", async () => {
  const state = createAutopilotState(new Date(0), { idea: "x", targetChapters: 3, scenesPerChapter: 1, wordsPerScene: 300 }, FAST);
  state.concept = { done: true, generated: false, secrets: [] };
  state.plan = { chapters: [plannedChapter(1, "done", true), plannedChapter(2, "done", true), plannedChapter(3, "planned", false)], approved: true, rounds: 0, revisionNotes: [], readerReactions: [], readersDone: true, awaitingAuthor: false };
  const files = { ...manuscript({ chapters: 2, summaries: { 1: "The author wrote this one.", 2: "And this one." } }), [STATE]: serializeAutopilotState(state) };
  const ai = summarizing();
  const { state: after } = await run(files, ai, { brief: { targetChapters: 3 }, options: FAST });
  assert.equal(after.status, "completed", after.lastError?.message);
  assert.deepEqual(summaryNumbers(ai), []);
  assert.deepEqual(after.plan.chapters.slice(0, 2).map((chapter) => chapter.summary), ["The author wrote this one.", "And this one."]);
  assert.ok(ai.calls.find((call) => call.label === "autopilot:write:3.1").user.includes("The author wrote this one."));
});

test("a book that is complete is not summarized when it is resumed", async () => {
  const state = createAutopilotState(new Date(0), { idea: "x", targetChapters: 2, scenesPerChapter: 1, wordsPerScene: 300 }, FAST);
  state.concept = { done: true, generated: false, secrets: [] };
  state.plan = { chapters: [plannedChapter(1, "done", true), plannedChapter(2, "done", true)], approved: true, rounds: 0, revisionNotes: [], readerReactions: [], readersDone: true, awaitingAuthor: false };
  state.finalDone = true;
  state.status = "completed";
  const ai = summarizing();
  const { state: after } = await run({ ...manuscript({ chapters: 2 }), [STATE]: serializeAutopilotState(state) }, ai, { brief: { targetChapters: 2 }, options: FAST });
  assert.equal(after.status, "completed");
  assert.equal(ai.calls.length, 0, "nothing is asked for a finished book");
});
