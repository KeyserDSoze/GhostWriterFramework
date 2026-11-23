import test from "node:test";
import assert from "node:assert/strict";
import * as engine from "../dist/index.js";
import { MemoryBookStore, createFakeAutopilotAi, seedBookFiles } from "../dist/testing/index.js";

// What the autopilot does when the author changes the entry of a chapter of the outline (`changeOfWritten`), written once, as a pure function that the web app's
// Outline page and the personal server's MCP both use to tell the author. The rule itself is the engine's, in `outlinePlanStatus` (outline-check.ts) and
// `settleFrozenChanges` (frozen.ts): the first half of this file is the table of the rule, the second half runs those two functions on a real book, for every
// row of the table, and the function must say what they do.

// New exports are read from the namespace so that, before they exist, each test fails on its own.
const { AutopilotSession, changeOfWritten, groupOutlineChanges, OUTLINE_CHANGE_OUTCOMES, parseAutopilotState } = engine;

const D = "0123456789abcdef";
const scene = (status) => ({ number: 1, title: "A scene", goal: "", beats: [], characters: [], status, revisions: 0 });
const chapter = (extra = {}) => ({ number: 2, title: "Two", slug: "002-two", summary: "", goal: "", pov: [], keyEvents: [], reveals: [], status: "planned", scenes: [], ...extra });
/** The state the rule reads: the mode, the plan and what the autopilot has in its hands. */
const stateOf = (chapters, mode, extra = {}) => ({ options: mode === undefined ? {} : { frozenEdits: mode }, plan: chapters === null ? null : { chapters, approved: true }, ...extra });

// ─── The table ──────────────────────────────────────────────────────────────

/**
 * Every state of a chapter that has a plan, with what happens when its entry changes (`changed`: one outcome for each mode, in the order ask, auto, notify) and
 * when it is deleted (`removed`: the same for every mode).
 */
const ROWS = [
  { name: "a chapter that the plan does not have", others: [{ number: 1, status: "done", scenes: [scene("reviewed")], outlineDigest: D }], changed: ["none", "none", "none"], removed: "none" },
  { name: "not written, planned from its entry", chapter: { status: "planned", outlineDigest: D }, changed: ["replan", "replan", "replan"], removed: "unplan" },
  { name: "not written, its scenes planned and none written", chapter: { status: "planned", scenes: [scene("planned"), scene("planned")], outlineDigest: D }, changed: ["replan", "replan", "replan"], removed: "unplan" },
  { name: "not written, planned from no entry: the author's entry is followed from now on", chapter: { status: "planned" }, changed: ["replan", "replan", "replan"], removed: "none" },
  { name: "being written: a scene is written", chapter: { status: "writing", scenes: [scene("written"), scene("planned")], outlineDigest: D }, changed: ["later", "later", "later"], removed: "stays" },
  { name: "being written, though its status still says planned", chapter: { status: "planned", scenes: [scene("written")], outlineDigest: D }, changed: ["later", "later", "later"], removed: "stays" },
  { name: "in review", chapter: { status: "review", scenes: [scene("reviewed")], outlineDigest: D }, changed: ["later", "later", "later"], removed: "stays" },
  { name: "being written, the plan remembers no entry", chapter: { status: "writing", scenes: [scene("written")] }, changed: ["none", "none", "none"], removed: "none" },
  { name: "closed", chapter: { status: "done", scenes: [scene("reviewed")], outlineDigest: D }, changed: ["ask", "auto", "notify"], removed: "stays" },
  { name: "closed, the plan remembers no entry (a plan of an engine that did not know the outline)", chapter: { status: "done", scenes: [scene("reviewed")] }, changed: ["none", "none", "none"], removed: "none" },
  { name: "written by the author before the autopilot took over: never rewritten for its decision", chapter: { status: "done", imported: true, scenes: [scene("reviewed")], outlineDigest: D }, changed: ["ask", "notify", "notify"], removed: "stays" },
  { name: "written by the author, the plan remembers no entry", chapter: { status: "done", imported: true, scenes: [] }, changed: ["none", "none", "none"], removed: "none" },
  { name: "marked as written by the author though its status says planned (a plan written by hand): it is written, and it is not closed", chapter: { status: "planned", imported: true, scenes: [], outlineDigest: D }, changed: ["later", "later", "later"], removed: "stays" },
];

const MODES = ["ask", "auto", "notify"];

test("the outcomes, in the order they are told", () => {
  assert.deepEqual([...OUTLINE_CHANGE_OUTCOMES], ["ask", "auto", "notify", "later", "replan", "unplan", "stays", "none"]);
});

test("the rule, state by state and mode by mode: a closed chapter is asked about, rewritten or only reported as the setting says, and the chapters of the author are never rewritten for the autopilot's decision", () => {
  for (const row of ROWS) {
    const chapters = row.others ?? [chapter(row.chapter)];
    const number = 2;
    MODES.forEach((mode, index) => {
      assert.equal(changeOfWritten(stateOf(chapters, mode), number), row.changed[index], `${row.name}: changed, ${mode}`);
      assert.equal(changeOfWritten(stateOf(chapters, mode), number, { entry: "changed" }), row.changed[index], `${row.name}: changed, ${mode}, said`);
      assert.equal(changeOfWritten(stateOf(chapters, mode), number, { entry: "removed" }), row.removed, `${row.name}: removed, ${mode}`);
    });
    // The setting a book has when the author chose none is `ask`, whatever is missing from the state.
    assert.equal(changeOfWritten(stateOf(chapters, undefined), number), row.changed[0], `${row.name}: no setting`);
    assert.equal(changeOfWritten({ plan: { chapters } }, number), row.changed[0], `${row.name}: no options at all`);
    assert.equal(changeOfWritten(stateOf(chapters, "frobnicate"), number), row.changed[0], `${row.name}: a value nobody knows is ask`);
  }
});

test("without a plan, or a state, nothing follows the entry", () => {
  for (const state of [null, undefined, {}, { plan: null }, { options: { frozenEdits: "auto" }, plan: null }, { plan: { chapters: [] } }]) {
    assert.equal(changeOfWritten(state, 2), "none", JSON.stringify(state));
    assert.equal(changeOfWritten(state, 2, { entry: "removed" }), "none", JSON.stringify(state));
  }
});

test("the plan is looked up by the number of the chapter, among all its chapters", () => {
  const chapters = [chapter({ number: 1, status: "done", scenes: [scene("reviewed")], outlineDigest: D }), chapter({ number: 2, status: "writing", scenes: [scene("written")], outlineDigest: D }), chapter({ number: 3, status: "planned", outlineDigest: D }), chapter({ number: 4, status: "done", imported: true, scenes: [scene("reviewed")], outlineDigest: D })];
  const state = stateOf(chapters, "auto");
  assert.deepEqual([1, 2, 3, 4, 5].map((number) => changeOfWritten(state, number)), ["auto", "later", "replan", "notify", "none"]);
  assert.deepEqual([1, 2, 3, 4, 5].map((number) => changeOfWritten(state, number, { entry: "removed" })), ["stays", "stays", "unplan", "stays", "none"]);
});

test("a chapter the autopilot has in its hands (rewritten by the revision in progress, or being reviewed for a decision) is decided about once the work is over", () => {
  const closed = chapter({ status: "done", scenes: [scene("reviewed")], outlineDigest: D });
  for (const mode of MODES) {
    const revising = stateOf([closed], mode, { revision: { onlyChapter: 2 } });
    assert.equal(changeOfWritten(revising, 2), "later", `${mode}: the revision rewrites it`);
    assert.equal(changeOfWritten(stateOf([closed], mode, { revision: { targets: [{ chapterNumber: 2 }] } }), 2), "later", `${mode}: a target of the revision`);
    assert.equal(changeOfWritten(stateOf([closed], mode, { revision: { revisedChapters: [2] } }), 2), "later", `${mode}: rewritten, and reviewed again at its end`);
    assert.equal(changeOfWritten(stateOf([closed], mode, { pendingReviews: [{ id: "a", kind: "outline", number: 2, action: "rewrite-to-outline", fingerprint: D, at: "x", started: { at: "x", phase: "rewrite", before: {} } }] }), 2), "later", `${mode}: the decision about it is carried out`);
    // Another chapter's work is not this chapter's.
    assert.equal(changeOfWritten(stateOf([closed], mode, { revision: { onlyChapter: 3 } }), 2), changeOfWritten(stateOf([closed], mode), 2), `${mode}: the revision is about another chapter`);
    assert.equal(changeOfWritten(stateOf([closed], mode, { pendingReviews: [{ id: "a", kind: "outline", number: 2, action: "keep-text", fingerprint: D, at: "x" }] }), 2), changeOfWritten(stateOf([closed], mode), 2), `${mode}: a decision that waits is not work in progress`);
  }
  // A deleted entry is said all the same: the chapter stays.
  assert.equal(changeOfWritten(stateOf([closed], "ask", { revision: { onlyChapter: 2 } }), 2, { entry: "removed" }), "stays");
});

test("an entry deleted with all the others is the deletion of outline/, which takes no chapter out of the plan and says nothing of the written ones", () => {
  for (const row of ROWS) {
    const chapters = row.others ?? [chapter(row.chapter)];
    assert.equal(changeOfWritten(stateOf(chapters, "ask"), 2, { entry: "removed", outlineEmpty: true }), "none", row.name);
    assert.equal(changeOfWritten(stateOf(chapters, "ask"), 2, { entry: "changed", outlineEmpty: true }), row.changed[0], `${row.name}: only a deletion is about the whole outline`);
  }
});

test("the changes of a series are grouped by what the autopilot does about each, in the order of the outcomes, the numbers in order and each once", () => {
  const chapters = [
    chapter({ number: 1, status: "done", scenes: [scene("reviewed")], outlineDigest: D }),
    chapter({ number: 2, status: "done", imported: true, scenes: [scene("reviewed")], outlineDigest: D }),
    chapter({ number: 3, status: "writing", scenes: [scene("written")], outlineDigest: D }),
    chapter({ number: 4, status: "planned", outlineDigest: D }),
    chapter({ number: 5, status: "done", scenes: [scene("reviewed")], outlineDigest: D }),
  ];
  const changes = [{ number: 5 }, { number: 1 }, { number: 2, entry: "changed" }, { number: 3 }, { number: 4 }, { number: 6 }, { number: 1 }, { number: 3, entry: "removed" }, { number: 4, entry: "removed" }, { number: 5, entry: "removed" }];
  assert.deepEqual(groupOutlineChanges(stateOf(chapters, "auto"), changes), [
    { outcome: "auto", numbers: [1, 5] },
    { outcome: "notify", numbers: [2] },
    { outcome: "later", numbers: [3] },
    { outcome: "replan", numbers: [4] },
    { outcome: "unplan", numbers: [4] },
    { outcome: "stays", numbers: [3, 5] },
    { outcome: "none", numbers: [6] },
  ]);
  assert.deepEqual(groupOutlineChanges(stateOf(chapters, "ask"), [{ number: 2 }, { number: 1 }]), [{ outcome: "ask", numbers: [1, 2] }]);
  assert.deepEqual(groupOutlineChanges(stateOf(chapters, "ask"), []), []);
  assert.deepEqual(groupOutlineChanges(null, [{ number: 1 }]), [{ outcome: "none", numbers: [1] }]);
  assert.deepEqual(groupOutlineChanges(stateOf(chapters, "ask"), [{ number: 3, entry: "removed" }], { outlineEmpty: true }), [{ outcome: "none", numbers: [3] }]);
});

// ─── The rule is the engine's ───────────────────────────────────────────────

const STATE = "autopilot/state.json";
const NOW = "2026-01-01T00:00:00.000Z";
const FAST = { readers: false, readersOnPlan: false, specialists: false, pauseAfterPlan: false };

/** A book the autopilot wrote to the end: three chapters, each approved (so frozen) and with the entry the autopilot wrote for it. */
async function finishedBook() {
  const store = new MemoryBookStore(seedBookFiles());
  const ai = createFakeAutopilotAi({ chapters: 3, scenes: 1, reviewVerdict: () => "approve" });
  const session = new AutopilotSession({ bookId: "book", store, ai, host: "server", hostLabel: "test", retryDelayMs: 0, now: () => new Date(NOW) });
  await session.start({ brief: { idea: "x", targetChapters: 3, scenesPerChapter: 1, wordsPerScene: 300 }, options: FAST });
  await session.waitForIdle();
  const state = parseAutopilotState(store.files.get(STATE));
  assert.equal(state.status, "completed", state.lastError?.message);
  assert.deepEqual(state.plan.chapters.map((entry) => [entry.status, Boolean(entry.outlineDigest)]), [["done", true], ["done", true], ["done", true]]);
  return store;
}

const outlineOf = async (store) => engine.parseOutline(await Promise.all((await store.list()).filter((file) => file.path.startsWith("outline/")).map((file) => store.read(file.path))));

/** The author edits the outline as the engine edits it for the author. */
async function authorEdits(store, edit) {
  await store.commit(engine.outlineChanges({ outline: await outlineOf(store), edit }).changes, "the author edits the outline");
}

/** What the engine does about chapter `number` before its next step: the words of `OUTLINE_CHANGE_OUTCOMES`, found by asking the engine, not the rule. */
async function observe(store, state, number) {
  const snapshot = await engine.loadBookSnapshot(store);
  const status = await engine.outlinePlanStatus(engine.OutlineReader.of(store, snapshot), state, "en");
  const changed = status.changed.get(number);
  if (changed === "changed") return "replan";
  if (changed === "removed") return "unplan";
  const said = status.notes.filter((note) => note.chapterNumber === number).map((note) => note.code);
  if (said.includes("outlineChangedWhileWriting")) return "later";
  if (said.includes("outlineRemovedWritten")) return "stays";
  if (!status.written.has(number)) return "none";
  const settled = engine.settleFrozenChanges(state, { snapshot, outlineWritten: status.written, language: "en", now: NOW });
  const question = settled.state.question;
  if (question?.kind === "outline-change" && question.frozen.number === number) return "ask";
  if ((settled.state.pendingReviews ?? []).some((entry) => entry.kind === "outline" && entry.number === number && entry.auto === true)) return "auto";
  if (settled.notes.some((note) => note.code === "outlineWrittenChanged" && note.chapterNumber === number)) return "notify";
  // The change is not decided now: the chapter is in the hands of the autopilot.
  return "later";
}

const clone = (store) => new MemoryBookStore(Object.fromEntries(store.files));

/** A plan chapter that is `row.chapter` instead of what the run left, in a state with `mode`. */
function stateWith(base, row, mode, extra = {}) {
  const state = structuredClone(parseAutopilotState(base.files.get(STATE)));
  state.options.frozenEdits = mode;
  const target = state.plan.chapters.find((entry) => entry.number === 2);
  if (row.chapter) {
    const { outlineDigest } = target;
    for (const key of ["imported", "outlineDigest"]) delete target[key];
    Object.assign(target, { status: row.chapter.status, ...(row.chapter.imported ? { imported: true } : {}), ...("outlineDigest" in row.chapter ? { outlineDigest } : {}) });
    target.scenes = (row.chapter.scenes ?? []).length ? row.chapter.scenes.map((entry, index) => ({ ...target.scenes[0], number: index + 1, status: entry.status })) : [];
  }
  return Object.assign(state, extra);
}

const DIFFERENTIAL = ROWS.filter((row) => row.chapter);

test("the rule says what the engine does: for every row of the table, in every mode, an entry the author changed or deleted is met with the outcome the table gives", async () => {
  const base = await finishedBook();
  const changed = clone(base);
  await authorEdits(changed, { kind: "update", number: 2, entry: { title: "The author's own title", body: "The author has another idea for this chapter." } });
  const removed = clone(base);
  await authorEdits(removed, { kind: "remove", number: 2 });
  assert.equal((await outlineOf(removed)).chapters.length, 2, "the other entries stay");

  for (const row of DIFFERENTIAL) {
    for (const [mode, expected] of MODES.map((mode, index) => [mode, row.changed[index]])) {
      const state = stateWith(base, row, mode);
      assert.equal(await observe(changed, state, 2), expected, `the engine: ${row.name}, changed, ${mode}`);
      assert.equal(changeOfWritten(state, 2), expected, `changeOfWritten: ${row.name}, changed, ${mode}`);
    }
    const state = stateWith(base, row, "ask");
    assert.equal(await observe(removed, state, 2), row.removed, `the engine: ${row.name}, removed`);
    assert.equal(changeOfWritten(state, 2, { entry: "removed" }), row.removed, `changeOfWritten: ${row.name}, removed`);
  }
});

test("whether the chapter is frozen changes nothing: a chapter the autopilot closed is frozen, and the same chapter with no record, or the author's own record, is met the same way", async () => {
  const base = await finishedBook();
  const snapshot = await engine.loadBookSnapshot(base);
  assert.equal(snapshot.chapters[1].frozen?.by, "autopilot", "the run froze the chapter it closed");
  const closed = ROWS.find((row) => row.name === "closed");
  const unfrozen = clone(base);
  await unfrozen.commit(engine.unfreezeChapterChanges(snapshot, snapshot.chapters[1].slug), "the author takes the freeze away");
  const byAuthor = clone(base);
  await byAuthor.commit(engine.freezeChapterChanges(snapshot, snapshot.chapters[1].slug, "author", NOW), "the author freezes it");
  assert.equal((await engine.loadBookSnapshot(unfrozen)).chapters[1].frozen, undefined);
  assert.equal((await engine.loadBookSnapshot(byAuthor)).chapters[1].frozen?.by, "author");
  for (const [label, store] of [["frozen by the autopilot", base], ["not frozen", unfrozen], ["frozen by the author", byAuthor]]) {
    const changed = clone(store);
    await authorEdits(changed, { kind: "update", number: 2, entry: { body: "Another idea." } });
    for (const [index, mode] of MODES.entries()) {
      const state = stateWith(base, closed, mode);
      assert.equal(await observe(changed, state, 2), closed.changed[index], `${label}, ${mode}`);
      assert.equal(changeOfWritten(state, 2), closed.changed[index], `${label}, ${mode}: the rule`);
    }
  }
});

test("a chapter the autopilot has in its hands is not asked about, rewritten or reported before the work is over: the rule says later, and so does the engine", async () => {
  const base = await finishedBook();
  const changed = clone(base);
  await authorEdits(changed, { kind: "update", number: 2, entry: { body: "Another idea." } });
  const closed = ROWS.find((row) => row.name === "closed");
  for (const mode of MODES) {
    const revising = stateWith(base, closed, mode, { revision: { onlyChapter: 2, targets: [], revisedChapters: [], notes: [], rounds: 0 } });
    assert.equal(await observe(changed, revising, 2), "later", `${mode}: revision`);
    assert.equal(changeOfWritten(revising, 2), "later", `${mode}: revision, the rule`);
    const started = { id: "decision", kind: "outline", number: 2, action: "rewrite-to-outline", fingerprint: "f", at: NOW, started: { at: NOW, phase: "rewrite", before: { number: 2, slug: "002-chapter-title-2", title: "Two", summary: "", keyEvents: [], storySoFar: "" } } };
    const deciding = stateWith(base, closed, mode, { pendingReviews: [started] });
    assert.equal(await observe(changed, deciding, 2), "later", `${mode}: decision`);
    assert.equal(changeOfWritten(deciding, 2), "later", `${mode}: decision, the rule`);
  }
});

test("the whole outline deleted takes no chapter out of the plan and says nothing of the written ones; the rule knows it with outlineEmpty", async () => {
  const base = await finishedBook();
  const gone = clone(base);
  for (const path of [...gone.files.keys()]) if (path.startsWith("outline/")) gone.write(path, null);
  assert.equal((await outlineOf(gone)).chapters.length, 0);
  for (const row of DIFFERENTIAL) {
    const state = stateWith(base, row, "ask");
    assert.equal(await observe(gone, state, 2), "none", `the engine: ${row.name}`);
    assert.equal(changeOfWritten(state, 2, { entry: "removed", outlineEmpty: true }), "none", `the rule: ${row.name}`);
  }
});

test("nothing happens for a change the engine does not follow: a chapter the plan does not have, and the plan of a state that has none", async () => {
  const base = await finishedBook();
  const changed = clone(base);
  await authorEdits(changed, { kind: "update", number: 2, entry: { body: "Another idea." } });
  await authorEdits(changed, { kind: "append", entry: { title: "A fourth chapter", body: "The book goes on." } });
  const state = structuredClone(parseAutopilotState(base.files.get(STATE)));
  assert.equal(await observe(changed, state, 4), "none", "the engine: no chapter 4 in the plan");
  assert.equal(changeOfWritten(state, 4), "none");
  const planless = { ...state, plan: null };
  assert.equal(await observe(changed, planless, 2), "none", "the engine: no plan");
  assert.equal(changeOfWritten(planless, 2), "none");
});
