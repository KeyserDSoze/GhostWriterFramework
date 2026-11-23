import test from "node:test";
import assert from "node:assert/strict";
import * as engine from "../dist/index.js";
import { MemoryBookStore, createFakeAutopilotAi, outlineEntryFiles, seedBookFiles } from "../dist/testing/index.js";

// A state written before the brief lived in the Scaletta: the brief carries `targetChapters` and `scenesPerChapter`, and the
// plan has as many chapters as the book had. These tests are about what such a state does now: it runs to the end of its plan,
// it never loops, and it is extended only when the author adds chapter entries to the outline.

const STATE = "autopilot/state.json";
const FAST = { readers: false, readersOnPlan: false, specialists: false, pauseAfterPlan: false };
const clock = () => new Date("2026-01-01T00:00:00.000Z");

/** The brief of an older state, as it was saved: the two counts the engine no longer reads. */
const LEGACY_BRIEF = (chapters, scenes = 2) => ({ idea: "A lighthouse keeper's last winter.", synopsis: "", targetChapters: chapters, scenesPerChapter: scenes, wordsPerScene: 300, genre: "", audience: "" });

function legacyPlan(numbers, status = "planned") {
  return numbers.map((number) => ({
    number,
    title: `Chapter Title ${number}`,
    slug: engine.chapterSlug(number, `Chapter Title ${number}`),
    summary: `Summary of chapter ${number}.`,
    goal: "",
    pov: [],
    keyEvents: [],
    reveals: [],
    status,
    scenes: [],
  }));
}

/** A state saved by the older engine: approved plan, the legacy brief, and nothing else of the run. */
function legacyState(brief, chapters, extra = {}) {
  const state = engine.createAutopilotState(clock(), {}, FAST);
  return {
    ...state,
    brief,
    concept: { done: true, generated: false, secrets: [] },
    plan: { chapters, approved: true, rounds: 0, revisionNotes: [], readerReactions: [], readersDone: true, awaitingAuthor: false },
    ...extra,
  };
}

function session(store, ai) {
  return new engine.AutopilotSession({ bookId: "book", store, ai, host: "server", hostLabel: "test", retryDelayMs: 0, now: clock });
}

const stateOf = (store) => engine.parseAutopilotState(store.files.get(STATE));
const labelsOf = (ai) => ai.calls.map((call) => call.label);

test("a legacy state with no entry in the outline runs to the end of its own plan, and never plans a chapter past it", async () => {
  // The book has chapters 1 to 3 in its plan and no outline at all: the plan is approved, so the run writes what is planned and stops
  // at its end. It does not plan more, and it does not loop on a chapter number the plan does not have.
  const store = new MemoryBookStore({ ...seedBookFiles() });
  store.files.set(STATE, engine.serializeAutopilotState(legacyState(LEGACY_BRIEF(3), legacyPlan([1, 2, 3]))));
  const ai = createFakeAutopilotAi({ reviewVerdict: () => "approve" });
  const session_ = session(store, ai);
  await session_.start({ options: FAST });
  await session_.waitForIdle();
  const state = stateOf(store);
  assert.equal(state.status, "completed", state.lastError?.message);
  assert.deepEqual(state.plan.chapters.map((chapter) => chapter.number), [1, 2, 3], "the plan is the book's: no chapter is added");
  assert.deepEqual(state.plan.chapters.map((chapter) => chapter.status), ["done", "done", "done"]);
  assert.equal(labelsOf(ai).some((label) => label === "autopilot:plan" || label === "autopilot:concept"), false, "nothing is planned again");
  assert.equal(state.brief.targetChapters, undefined, "the count of the old brief is not kept");
});

test("a legacy state runs to the end of its plan, with the brief it had, and nothing is extended", async () => {
  const store = new MemoryBookStore({ ...seedBookFiles(), ...outlineEntryFiles(4) });
  store.files.set(STATE, engine.serializeAutopilotState(legacyState(LEGACY_BRIEF(4), legacyPlan([1, 2, 3, 4]))));
  const ai = createFakeAutopilotAi({ reviewVerdict: () => "approve" });
  const session_ = session(store, ai);
  await session_.start({ options: FAST });
  await session_.waitForIdle();
  const state = stateOf(store);
  assert.equal(state.status, "completed", state.lastError?.message);
  assert.deepEqual(state.plan.chapters.map((chapter) => chapter.number), [1, 2, 3, 4]);
  assert.ok(labelsOf(ai).includes("autopilot:write:4.1"), "the last chapter of the plan is written");
  assert.equal(labelsOf(ai).includes("autopilot:plan"), false, "the plan was there: it is not made again");
  assert.match(store.files.get("autopilot/state.json"), /"idea": "A lighthouse keeper's last winter\."/, "the idea the state had is in the file the brief lives in");
  assert.equal(store.files.has("outline/_brief.md"), true, "the brief moved to the outline with the start");
});

test("a completed legacy book is not extended unless the author adds chapter entries to the outline", async () => {
  // Written to the end by the engine as it is now, then made into the older state: the brief says three chapters, there is no entry.
  const store = new MemoryBookStore({ ...seedBookFiles(), ...outlineEntryFiles(3) });
  const ai = createFakeAutopilotAi({ reviewVerdict: () => "approve" });
  const first = session(store, ai);
  await first.start({ brief: { idea: "x", wordsPerScene: 300 }, options: FAST });
  await first.waitForIdle();
  assert.equal(stateOf(store).status, "completed", stateOf(store).lastError?.message);
  for (const path of [...store.files.keys()].filter((name) => /^outline\/chapters\//.test(name))) store.files.delete(path);
  const completed = stateOf(store);
  store.files.set(STATE, engine.serializeAutopilotState({ ...completed, brief: { ...completed.brief, ...LEGACY_BRIEF(3) } }));

  const second = session(store, createFakeAutopilotAi({ reviewVerdict: () => "approve" }));
  await second.start({ options: FAST });
  await second.waitForIdle();
  const unchanged = stateOf(store);
  assert.equal(unchanged.status, "completed", unchanged.lastError?.message);
  assert.equal(unchanged.plan.chapters.length, 3, "still three chapters: the old count does not extend the book");
  assert.equal(unchanged.finalDone, true);

  // The author writes chapter 4 into the Scaletta: that, and only that, extends the book.
  store.files.set("outline/chapters/004.md", "---\ntype: outline-chapter\nid: outline-chapter:004\nnumber: 4\ntitle: Chapter Title 4\norigin: author\n---\n\nEvent 4 happens and the story turns.\n");
  const extendAi = createFakeAutopilotAi({ reviewVerdict: () => "approve" });
  const third = session(store, extendAi);
  await third.start({ options: FAST });
  await third.waitForIdle();
  const extended = stateOf(store);
  assert.equal(extended.status, "completed", extended.lastError?.message);
  assert.deepEqual(extended.plan.chapters.map((chapter) => chapter.number), [1, 2, 3, 4], "the author's chapter 4 is planned and written");
  assert.ok(labelsOf(extendAi).includes("autopilot:write:4.1"));
});

test("a book that goes on from chapter 1198 is planned and written up to its last entry, and never past it", async () => {
  // The chapters are numbered, not counted: the plan starts at 1198 and the outline ends at 1203. A plan that counted its chapters
  // used to reopen after the last one and plan 1204, 1205, … without end.
  const numbers = [1198, 1199, 1200, 1201, 1202, 1203];
  const entries = Object.fromEntries(numbers.map((number) => [engine.outlineChapterPath(number), `---\ntype: outline-chapter\nid: outline-chapter:${number}\nnumber: ${number}\ntitle: Chapter Title ${number}\norigin: author\n---\n\nEvent ${number} happens and the story turns.\n`]));
  const store = new MemoryBookStore({ ...seedBookFiles(), ...entries });
  store.files.set(STATE, engine.serializeAutopilotState(legacyState(LEGACY_BRIEF(1203), legacyPlan(numbers))));
  const ai = createFakeAutopilotAi({ reviewVerdict: () => "approve" });
  const started = session(store, ai);
  await started.start({ options: { ...FAST, chaptersPerRun: 20 } });
  await started.waitForIdle();
  const state = stateOf(store);
  assert.equal(state.status, "completed", state.lastError?.message);
  assert.deepEqual(state.plan.chapters.map((chapter) => chapter.number), numbers);
  assert.equal(labelsOf(ai).some((label) => /^autopilot:(plan|write):1204/.test(label)), false, "nothing past chapter 1203");
});
