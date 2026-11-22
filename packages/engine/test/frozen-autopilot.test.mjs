import test from "node:test";
import assert from "node:assert/strict";
import * as engine from "../dist/index.js";
import { MemoryBookStore, createFakeAutopilotAi, seedBookFiles } from "../dist/testing/index.js";

// New exports are read from the namespace so that, before they exist, each test fails on its own.
const { AutopilotSession, loadBookSnapshot, parseAutopilotState, parseMarkdown } = engine;

// ─── E4b-F1..F3: the autopilot freezes what it approves, notices what the author changed after, and asks ───────────────

const STATE = "autopilot/state.json";
const FAST = { readers: false, readersOnPlan: false, specialists: false, pauseAfterPlan: false };
const clock = () => new Date("2026-01-01T00:00:00.000Z");
const ONE = "chapters/001-chapter-title-1";
const TWO = "chapters/002-chapter-title-2";
const THREE = "chapters/003-chapter-title-3";

const stateOf = (store) => parseAutopilotState(store.files.get(STATE));
const labelsSince = (ai, mark) => ai.calls.slice(mark).map((call) => call.label);
const callsSince = (ai, mark, label) => ai.calls.slice(mark).filter((call) => call.label === label);
const insights = (events, code) => events.filter((event) => event.type === "insight" && event.code === code);
const reply = (json) => ({ text: JSON.stringify(json), json, usage: { inputTokens: 100, outputTokens: 50, cachedInputTokens: 0 }, model: "fake-model", provider: "fake", cost: 0.001, currency: "USD" });

function scripted(script, options = {}) {
  const base = createFakeAutopilotAi(options);
  return {
    calls: base.calls,
    async complete(request) {
      const custom = script(request);
      if (custom === undefined) return base.complete(request);
      base.calls.push(request);
      request.signal?.throwIfAborted();
      return custom;
    },
  };
}

function newSession(store, ai) {
  const events = [];
  const session = new AutopilotSession({ bookId: "book", store, ai, host: "server", hostLabel: "test", retryDelayMs: 0, now: clock });
  session.subscribe((event) => events.push(event));
  return { session, events };
}

async function run(store, ai, start = {}) {
  const { session, events } = newSession(store, ai);
  await session.start(start);
  await session.waitForIdle();
  return { session, events, state: stateOf(store) };
}

/** A book the autopilot wrote to the end: every chapter approved at once, so frozen by it. */
async function finishedBook({ chapters = 2, scenes = 2, options = {}, files = seedBookFiles() } = {}) {
  const store = new MemoryBookStore(files);
  const ai = createFakeAutopilotAi({ reviewVerdict: () => "approve" });
  const { state } = await run(store, ai, { brief: { idea: "x", targetChapters: chapters, scenesPerChapter: scenes, wordsPerScene: 300 }, options: { ...FAST, ...options } });
  assert.equal(state.status, "completed", state.lastError?.message);
  return { store, ai };
}

/** The author changes the text of a scene, as an editor would save it. */
function rewriteScene(store, path, text = "The author rewrote this sentence by hand.") {
  const document = parseMarkdown(store.files.get(path));
  store.write(path, store.files.get(path).replace(document.body, `${document.body}\n\n${text}`));
}

async function answer(store, ai, input) {
  const { session } = newSession(store, ai);
  const question = stateOf(store).question;
  return session.answer({ questionId: question.id, answer: "", ...input });
}

test("the autopilot freezes every chapter it approves, in the same commit as its closing", async () => {
  const { store } = await finishedBook();
  const snapshot = await loadBookSnapshot(store);
  assert.equal(snapshot.chapters.length, 2);
  for (const chapter of snapshot.chapters) {
    assert.equal(chapter.frozen?.by, "autopilot", chapter.slug);
    assert.equal(chapter.frozen.at, "2026-01-01T00:00:00.000Z");
    assert.deepEqual(Object.keys(chapter.frozen.files).sort(), chapter.paragraphs.map((paragraph) => paragraph.path.split("/").pop()).sort());
    const touching = store.commits.filter((commit) => commit.paths.includes(chapter.path));
    assert.match(touching.at(-1).message, /^Autopilot: Closing chapter/, "the record is written by the closing of the chapter, and nothing writes the file after it");
  }
  assert.deepEqual(engine.frozenChanges(snapshot), []);
});

test("a frozen chapter the author changed stops the next run with a question, before any step and without spending anything", async () => {
  const { store, ai } = await finishedBook();
  rewriteScene(store, `${ONE}/001-scene-1-title.md`);
  const mark = ai.calls.length;
  const { session, events, state } = await run(store, ai);
  assert.deepEqual(labelsSince(ai, mark), [], "nothing is asked of the model");
  assert.equal(state.status, "waiting-author");
  const question = state.question;
  assert.equal(question.kind, "frozen-change");
  assert.match(question.question, /chapter 1\b/i);
  assert.match(question.question, /2026-01-01/, "it says when the chapter was frozen");
  assert.deepEqual(question.choices.map((choice) => choice.id), ["review-and-update", "review-only", "mark-reviewed"]);
  assert.deepEqual(question.options, question.choices.map((choice) => choice.label), "an interface that only shows options shows the same choices");
  assert.deepEqual([question.frozen.kind, question.frozen.number, question.frozen.slug], ["frozen", 1, "001-chapter-title-1"]);
  assert.deepEqual(question.frozen.changed, { added: [], removed: [], modified: ["001-scene-1-title.md"], body: false });
  assert.match(state.message ?? "", /chapter 1/i, "the message of the stop says why");
  const summaries = events.filter((event) => event.type === "state").map((event) => event.state);
  assert.equal(summaries.at(-1).frozenChanges, 1, "the summary counts the change");
  assert.equal((await session.snapshot()).summary.frozenChanges, 1);
  assert.equal(engine.summarizeAutopilotState(state).frozenChanges, undefined, "a summary made from the state file alone does not know it");

  const again = await run(store, ai);
  assert.deepEqual(labelsSince(ai, mark), [], "asked again, still without spending");
  assert.equal(again.state.question.id, question.id, "the same question");
});

test("marking it reviewed freezes the text as it is: no call to the model, and the next run does not ask again", async () => {
  for (const input of [{ answer: "mark-reviewed" }, { answer: "Mark as reviewed" }, { answer: "", accept: true }, { choice: "mark-reviewed" }]) {
    const { store, ai } = await finishedBook();
    const scene = `${ONE}/001-scene-1-title.md`;
    rewriteScene(store, scene);
    const edited = store.files.get(scene);
    await run(store, ai);
    const mark = ai.calls.length;
    const saved = await answer(store, ai, input);
    assert.equal(saved.question, null, JSON.stringify(input));
    assert.deepEqual(engine.frozenChanges(await loadBookSnapshot(store)), [], `the change is frozen at once (${JSON.stringify(input)})`);
    assert.equal((await loadBookSnapshot(store)).chapters[0].frozen.by, "autopilot", "who froze it does not change");
    const { state, events } = await run(store, ai);
    assert.equal(state.status, "completed", state.lastError?.message);
    assert.deepEqual(labelsSince(ai, mark), [], "and nothing is spent");
    assert.equal(state.question, null);
    assert.equal(store.files.get(scene), edited, "the author's text stays");
    assert.equal(insights(events, "frozenChanged").length, 0);
  }
});

test("only a review: the director judges the changed chapter once, nothing is rewritten, its vote joins its rounds, and it is frozen again", async () => {
  const { store } = await finishedBook();
  const scene = `${ONE}/001-scene-1-title.md`;
  rewriteScene(store, scene);
  const edited = store.files.get(scene);
  // A director who wants a fix: it is advice for the author, never applied to the author's text.
  const ai = scripted((request) => (request.json?.name === "director_review"
    ? reply({ verdict: "revise", score: 6, summary: "The new line weakens the ending.", strengths: [], decisions: [], extraFixes: [{ sceneNumber: 1, remediation: "Cut the new last sentence.", rationale: "It explains too much." }], guidance: [] })
    : undefined));
  await run(store, ai);
  const rounds = stateOf(store).plan.chapters[0].rounds.length;
  await answer(store, ai, { answer: "review-only" });
  const mark = ai.calls.length;
  const { state } = await run(store, ai);
  assert.equal(state.status, "completed", state.lastError?.message);
  const labels = labelsSince(ai, mark);
  assert.deepEqual(labels, ["autopilot:director-review:1", "autopilot:consolidate:1"], "one review round (whose fix is not applied) and the closing");
  const review = callsSince(ai, mark, "autopilot:director-review:1")[0];
  assert.match(review.user, /changed this chapter after it was approved/i, "the director knows it judges the author's change");
  assert.equal(store.files.get(scene), edited, "the author's text is not rewritten");
  const chapter = state.plan.chapters[0];
  assert.equal(chapter.rounds.length, rounds + 1, "the round is in the chapter's history");
  assert.deepEqual([chapter.rounds.at(-1).director, chapter.rounds.at(-1).verdict, chapter.rounds.at(-1).accepted], [6, "revise", 1], "as the director judged it");
  assert.equal(chapter.status, "done");
  assert.equal(state.finalDone, true, "the book stays complete: only a review was asked");
  assert.deepEqual(engine.frozenChanges(await loadBookSnapshot(store)), [], "frozen again, with the author's text");
  assert.deepEqual(state.pendingReviews ?? [], []);
});

/** The impact of a change on the later chapters, as a director that finds one scene to rewrite (and one it may not touch) answers it. */
function updatingAi({ targets = [{ chapterNumber: 1, sceneNumber: 1, instruction: "Never this one." }, { chapterNumber: 2, sceneNumber: 1, instruction: "Let Mira remember what changed. LATER-FIX" }] } = {}) {
  return scripted((request) => {
    if (request.json?.name === "revision_impact") return reply({ summary: "One later scene depends on the change.", targets });
    if (request.json?.name === "chapter_consolidation" && request.label === "autopilot:consolidate:1") {
      return reply({ summary: "Mira lies to Orrin. AFTER-MARK", recap: "- Scene 1.", stateChanges: {}, storySoFar: "Mira lied to Orrin. AFTER-STORY" });
    }
    return undefined;
  }, { reviewVerdict: () => "approve" });
}

test("review and update: the changed chapter is reviewed, the later chapters are checked against BEFORE and AFTER, only their scenes are rewritten, and everything is frozen again", async () => {
  const { store } = await finishedBook({ chapters: 3 });
  const changed = `${ONE}/001-scene-1-title.md`;
  const later = `${TWO}/001-scene-1-title.md`;
  rewriteScene(store, changed);
  const edited = store.files.get(changed);
  const laterBefore = store.files.get(later);
  const ai = updatingAi();
  await run(store, ai);
  await answer(store, ai, { answer: "review-and-update" });
  const mark = ai.calls.length;
  const { state } = await run(store, ai);
  assert.equal(state.status, "completed", state.lastError?.message);
  const labels = labelsSince(ai, mark);
  const at = (label) => labels.indexOf(label);
  assert.ok(at("autopilot:director-review:1") === 0, labels.join(", "));
  assert.ok(at("autopilot:consolidate:1") < at("autopilot:impact") && at("autopilot:impact") < at("autopilot:revise:2.1"), labels.join(", "));
  assert.ok(at("autopilot:revise:2.1") < at("autopilot:director-review:2") && at("autopilot:director-review:2") < at("autopilot:consolidate:2"), labels.join(", "));
  assert.ok(!labels.some((label) => /^autopilot:(revise|repair):1\./.test(label)), "the changed chapter is never rewritten: the author's change stands");
  assert.ok(!labels.includes("autopilot:director-review:3"), "a later chapter the change does not touch is left alone");
  const impact = callsSince(ai, mark, "autopilot:impact")[0];
  assert.match(impact.user, /BEFORE/);
  assert.match(impact.user, /Mira confronts Orrin\./, "BEFORE: what the autopilot knew of the chapter when it was frozen");
  assert.match(impact.user, /AFTER-MARK/, "AFTER: the new closing of the chapter");
  assert.doesNotMatch(impact.user, /Chapter 1, scene/, "only the later chapters' scenes can be chosen");
  assert.match(callsSince(ai, mark, "autopilot:revise:2.1")[0].user, /LATER-FIX/);
  assert.equal(store.files.get(changed), edited, "the author's text stands");
  assert.notEqual(store.files.get(later), laterBefore, "the later scene was rewritten");
  assert.deepEqual(engine.frozenChanges(await loadBookSnapshot(store)), [], "every chapter is frozen again");
  assert.equal(state.revision, null);
  assert.deepEqual(state.pendingReviews ?? [], []);
  assert.ok(labels.includes("director:book"), "the book changed: its final judgement is made again");
});

test("the impact of one change never rewrites a later chapter whose own change the author has not seen reviewed yet", async () => {
  const { store } = await finishedBook({ chapters: 3 });
  rewriteScene(store, `${ONE}/001-scene-1-title.md`);
  rewriteScene(store, `${TWO}/001-scene-1-title.md`, "The author's own new line in chapter 2. KEEP-ME");
  const editedTwo = store.files.get(`${TWO}/001-scene-1-title.md`);
  const ai = updatingAi({ targets: [{ chapterNumber: 2, sceneNumber: 1, instruction: "Rewrite it." }, { chapterNumber: 3, sceneNumber: 1, instruction: "Follow the change. LATER-FIX" }] });
  await run(store, ai);
  await answer(store, ai, { answer: "review-and-update" });
  const second = await run(store, ai);
  assert.equal(second.state.question.frozen.number, 2, "the other change is asked about before any work begins");
  await answer(store, ai, { answer: "review-only" });
  const mark = ai.calls.length;
  const { state } = await run(store, ai);
  assert.equal(state.status, "completed", state.lastError?.message);
  const impact = callsSince(ai, mark, "autopilot:impact")[0];
  assert.doesNotMatch(impact.user, /Chapter 2, scene/, "a chapter with a change of the author's that waits is not offered");
  const labels = labelsSince(ai, mark);
  assert.ok(!labels.includes("autopilot:revise:2.1"), labels.join(", "));
  assert.ok(labels.includes("autopilot:revise:3.1") && labels.includes("autopilot:director-review:2"), labels.join(", "));
  assert.equal(store.files.get(`${TWO}/001-scene-1-title.md`), editedTwo, "the author's text of chapter 2 stands");
  assert.deepEqual(engine.frozenChanges(await loadBookSnapshot(store)), []);
});

test("auto: the same review and update starts without a question, and says so", async () => {
  const { store } = await finishedBook({ chapters: 3 });
  rewriteScene(store, `${ONE}/001-scene-1-title.md`);
  const ai = updatingAi();
  const { state, events } = await run(store, ai, { options: { frozenEdits: "auto" } });
  assert.equal(state.status, "completed", state.lastError?.message);
  assert.deepEqual(insights(events, "frozenAuto").map((event) => event.chapterNumber), [1]);
  const labels = labelsSince(ai, 0);
  assert.ok(labels.indexOf("autopilot:director-review:1") >= 0 && labels.indexOf("autopilot:impact") > labels.indexOf("autopilot:consolidate:1"), labels.join(", "));
  assert.ok(labels.includes("autopilot:revise:2.1"));
  assert.deepEqual(engine.frozenChanges(await loadBookSnapshot(store)), []);
});

test("notify: the change is said once, across runs, and nothing is done", async () => {
  const { store, ai } = await finishedBook({ options: { frozenEdits: "notify" } });
  const scene = `${TWO}/002-scene-2-title.md`;
  rewriteScene(store, scene);
  const mark = ai.calls.length;
  const first = await run(store, ai);
  assert.equal(first.state.status, "completed", first.state.lastError?.message);
  assert.deepEqual(insights(first.events, "frozenChanged").map((event) => event.chapterNumber), [2]);
  assert.equal(first.state.question, null);
  const second = await run(store, ai);
  assert.equal(insights(second.events, "frozenChanged").length, 0, "the same change is not said twice");
  rewriteScene(store, scene, "And another sentence.");
  const third = await run(store, ai);
  assert.deepEqual(insights(third.events, "frozenChanged").map((event) => event.chapterNumber), [2], "a new change is said");
  assert.deepEqual(labelsSince(ai, mark), [], "nothing is spent");
  assert.equal(engine.frozenChanges(await loadBookSnapshot(store)).length, 1, "and the change is still there for the author");
});

test("several chapters changed: one question at a time, in order, and the question says the others", async () => {
  const { store, ai } = await finishedBook({ chapters: 3 });
  rewriteScene(store, `${THREE}/001-scene-1-title.md`);
  rewriteScene(store, `${ONE}/002-scene-2-title.md`);
  let { state } = await run(store, ai);
  assert.equal(state.question.frozen.number, 1);
  assert.match(state.question.context, /chapter 3\b/i);
  await answer(store, ai, { answer: "mark-reviewed" });
  ({ state } = await run(store, ai));
  assert.equal(state.question.frozen.number, 3);
  await answer(store, ai, { answer: "mark-reviewed" });
  ({ state } = await run(store, ai));
  assert.equal(state.status, "completed", state.lastError?.message);
});

test("a frozen chapter changed while a run goes on stops it at the next step, before anything else is written", async () => {
  const store = new MemoryBookStore(seedBookFiles());
  const ai = createFakeAutopilotAi({ reviewVerdict: () => "approve" });
  const { session } = newSession(store, ai);
  let mark = -1;
  session.subscribe((event) => {
    if (mark >= 0 || event.type !== "task-finished" || event.activity.task !== "consolidate" || event.activity.chapterNumber !== 1) return;
    // The author saves an edit of chapter 1 right after the autopilot approved (and froze) it.
    rewriteScene(store, `${ONE}/001-scene-1-title.md`);
    mark = ai.calls.length;
  });
  await session.start({ brief: { idea: "x", targetChapters: 3, scenesPerChapter: 2, wordsPerScene: 300 }, options: FAST });
  await session.waitForIdle();
  const state = stateOf(store);
  assert.ok(mark >= 0);
  assert.deepEqual(labelsSince(ai, mark), [], "not one more step");
  assert.equal(state.status, "waiting-author");
  assert.deepEqual([state.question.kind, state.question.frozen.number], ["frozen-change", 1]);
  assert.deepEqual(state.plan.chapters.map((chapter) => chapter.status), ["done", "planned", "planned"]);
});

test("a chapter the author wrote and froze by hand is reviewed when the author asks, and never rewritten", async () => {
  const files = seedBookFiles();
  files["chapters/001-the-arrival/chapter.md"] = "---\ntype: chapter\nid: chapter:001-the-arrival\nnumber: 1\ntitle: The Arrival\nsummary: Mira arrives.\n---\n\n# The Arrival\n";
  files["chapters/001-the-arrival/001-dawn.md"] = "---\ntype: paragraph\nid: paragraph:001-the-arrival:001-dawn\nchapter: chapter:001-the-arrival\nnumber: 1\ntitle: Dawn\n---\n\nThe author's own opening, written before the autopilot.";
  const { store } = await finishedBook({ chapters: 2, files });
  const ai = createFakeAutopilotAi({ reviewVerdict: () => "approve" });
  const { session } = newSession(store, ai);
  await session.freezeChapter("001-the-arrival");
  rewriteScene(store, "chapters/001-the-arrival/001-dawn.md", "The author adds an ending.");
  const edited = store.files.get("chapters/001-the-arrival/001-dawn.md");
  let { state } = await run(store, ai);
  assert.equal(state.question.frozen.number, 1);
  await answer(store, ai, { answer: "review-only" });
  ({ state } = await run(store, ai));
  assert.equal(state.status, "completed", state.lastError?.message);
  assert.deepEqual(labelsSince(ai, 0), ["autopilot:director-review:1", "autopilot:consolidate:1"]);
  assert.equal(store.files.get("chapters/001-the-arrival/001-dawn.md"), edited);
  const snapshot = await loadBookSnapshot(store);
  assert.equal(snapshot.chapters[0].frozen.by, "author", "still the author's freeze");
  assert.deepEqual(engine.frozenChanges(snapshot), []);
  assert.equal(state.plan.chapters[0].imported, true);
});

test("the autopilot's own rewrites of a frozen chapter are never asked about, and the chapter is frozen again after them", async () => {
  const { store } = await finishedBook();
  const ai = createFakeAutopilotAi({ reviewVerdict: () => "approve" });
  const { session } = newSession(store, ai);
  await session.intervene({ scope: "rewrite", text: "Make the harbor colder." });
  await session.start();
  await session.waitForIdle();
  const state = stateOf(store);
  assert.equal(state.status, "completed", state.lastError?.message);
  assert.equal(state.question, null);
  assert.ok(ai.calls.some((call) => call.label === "autopilot:revise:1.1"));
  assert.deepEqual(engine.frozenChanges(await loadBookSnapshot(store)), []);
});

test("an author who changes a frozen chapter and asks for a rewrite is not stopped before it: a change the rewrite does not reach is asked about after it", async () => {
  const { store } = await finishedBook({ chapters: 2 });
  rewriteScene(store, `${TWO}/002-scene-2-title.md`);
  const ai = createFakeAutopilotAi({ reviewVerdict: () => "approve" });
  const { session } = newSession(store, ai);
  await session.intervene({ scope: "rewrite", text: "Make the harbor colder." });
  await session.start();
  await session.waitForIdle();
  const state = stateOf(store);
  const labels = labelsSince(ai, 0);
  assert.ok(labels.indexOf("autopilot:impact") === 0 && labels.includes("autopilot:revise:1.1") && labels.includes("autopilot:consolidate:1"), labels.join(", "));
  assert.equal(state.status, "waiting-author", state.lastError?.message);
  assert.deepEqual([state.question.kind, state.question.frozen.number], ["frozen-change", 2], "then the change of chapter 2 is asked about");
});

test("a scene the author deleted from a frozen chapter is not written again: the author is asked", async () => {
  const { store, ai } = await finishedBook();
  store.write(`${ONE}/002-scene-2-title.md`, null);
  const mark = ai.calls.length;
  let { state } = await run(store, ai);
  assert.deepEqual(labelsSince(ai, mark), []);
  assert.equal(state.question.kind, "frozen-change");
  assert.deepEqual(state.question.frozen.changed.removed, ["002-scene-2-title.md"]);
  assert.equal(state.plan.chapters[0].status, "done", "the chapter is not reopened");
  await answer(store, ai, { answer: "mark-reviewed" });
  ({ state } = await run(store, ai));
  assert.equal(state.status, "completed", state.lastError?.message);
  assert.deepEqual(labelsSince(ai, mark), [], "the scene is not written again");
  assert.ok(!store.files.has(`${ONE}/002-scene-2-title.md`));
  assert.deepEqual(state.plan.chapters[0].scenes.map((scene) => scene.number), [1], "the plan follows the files");
});

test("a change the author took back withdraws its question", async () => {
  const { store, ai } = await finishedBook();
  const scene = `${ONE}/001-scene-1-title.md`;
  const original = store.files.get(scene);
  rewriteScene(store, scene);
  assert.equal((await run(store, ai)).state.status, "waiting-author");
  store.write(scene, original);
  const { state } = await run(store, ai);
  assert.equal(state.question, null);
  assert.equal(state.status, "completed", state.lastError?.message);
});

test("an answer in the author's own words reviews and updates, and the director reads them", async () => {
  const { store } = await finishedBook({ chapters: 3 });
  rewriteScene(store, `${ONE}/001-scene-1-title.md`);
  const ai = updatingAi({ targets: [] });
  await run(store, ai);
  await answer(store, ai, { answer: "Orrin must now sound afraid. AUTHOR-NOTE" });
  const mark = ai.calls.length;
  const { state } = await run(store, ai);
  assert.equal(state.status, "completed", state.lastError?.message);
  assert.match(callsSince(ai, mark, "autopilot:director-review:1")[0].user, /AUTHOR-NOTE/);
  assert.match(callsSince(ai, mark, "autopilot:impact")[0].user, /AUTHOR-NOTE/);
});

test("the option frozenEdits: ask by default, saved, read tolerantly, and it can change while a run goes on", async () => {
  assert.equal(engine.DEFAULT_OPTIONS.frozenEdits, "ask");
  assert.deepEqual(engine.FROZEN_EDITS_MODES, ["ask", "auto", "notify"]);
  assert.equal(engine.normalizeOptions({}).frozenEdits, "ask");
  assert.equal(engine.normalizeOptions({ frozenEdits: " Notify " }).frozenEdits, "notify");
  assert.equal(engine.normalizeOptions({ frozenEdits: "sometimes" }, { ...engine.DEFAULT_OPTIONS, frozenEdits: "auto" }).frozenEdits, "auto", "a value nobody knows changes nothing");
  assert.equal(parseAutopilotState(JSON.stringify({ options: { frozenEdits: "auto" } })).options.frozenEdits, "auto");
  assert.equal(parseAutopilotState(JSON.stringify({ options: {} })).options.frozenEdits, "ask", "an older state asks");
  assert.ok(engine.LIVE_AUTOPILOT_OPTIONS.includes("frozenEdits"));

  const store = new MemoryBookStore(seedBookFiles());
  const ai = createFakeAutopilotAi({ delayMs: 30 });
  const { session } = newSession(store, ai);
  await session.start({ brief: { idea: "x", targetChapters: 1, scenesPerChapter: 1 }, options: FAST });
  const saved = await session.updateOptions({ frozenEdits: "notify" });
  assert.equal(saved.options.frozenEdits, "notify", "changed while the run goes on");
  await session.waitForIdle();
  assert.equal(stateOf(store).options.frozenEdits, "notify", "and kept by the run");
});

test("a book whose state was saved before frozen chapters existed: what the autopilot approved is frozen once, without asking; the author's chapters are not", async () => {
  const files = seedBookFiles();
  files["chapters/001-the-arrival/chapter.md"] = "---\ntype: chapter\nid: chapter:001-the-arrival\nnumber: 1\ntitle: The Arrival\nsummary: Mira arrives.\n---\n\n# The Arrival\n";
  files["chapters/001-the-arrival/001-dawn.md"] = "---\ntype: paragraph\nid: paragraph:001-the-arrival:001-dawn\nchapter: chapter:001-the-arrival\nnumber: 1\ntitle: Dawn\n---\n\nThe author's own opening, written before the autopilot.";
  const { store } = await finishedBook({ chapters: 3, files });
  const author = "chapters/001-the-arrival/chapter.md";
  assert.equal((await loadBookSnapshot(store)).chapters[0].frozen, undefined, "the author's chapter is never frozen by the autopilot");
  // What an older engine left: no record in any chapter, and a state that does not know frozen chapters.
  for (const path of [...store.files.keys()].filter((entry) => /^chapters\/[^/]+\/chapter\.md$/.test(entry))) {
    const document = parseMarkdown(store.files.get(path));
    const { frozen: _frozen, ...frontmatter } = document.frontmatter;
    store.write(path, engine.renderMarkdown(frontmatter, document.body));
  }
  const old = JSON.parse(store.files.get(STATE));
  delete old.frozenSince;
  store.write(STATE, JSON.stringify(old));
  const ai = createFakeAutopilotAi();
  const { state, events } = await run(store, ai);
  assert.equal(state.status, "completed", state.lastError?.message);
  assert.deepEqual(labelsSince(ai, 0), [], "no call to the model");
  const snapshot = await loadBookSnapshot(store);
  assert.deepEqual(snapshot.chapters.map((chapter) => chapter.frozen?.by ?? null), [null, "autopilot", "autopilot"]);
  assert.equal(insights(events, "frozenMigrated").length, 1);
  assert.ok(state.frozenSince);
  const author_before = store.files.get(author);
  const second = await run(store, ai);
  assert.equal(insights(second.events, "frozenMigrated").length, 0, "once");
  assert.equal(store.files.get(author), author_before);

  // A chapter the author unfroze after that stays as the author left it.
  const { session } = newSession(store, ai);
  await session.unfreezeChapter("002-chapter-title-2");
  await run(store, ai);
  assert.equal((await loadBookSnapshot(store)).chapters[1].frozen, undefined);
});

// ─── The outline of a chapter already written ───────────────────────────────

async function outlineOf(store) {
  const paths = (await store.list()).filter((file) => file.path.startsWith("outline/"));
  return engine.parseOutline(await Promise.all(paths.map((file) => store.read(file.path))));
}

async function editOutline(store, edit) {
  const result = engine.outlineChanges({ outline: await outlineOf(store), edit });
  await store.commit(result.changes, "the author edits the outline");
  return result;
}

test("the outline entry of a written chapter that changed is asked about; keeping the text follows the new entry without rewriting anything", async () => {
  const { store, ai } = await finishedBook({ chapters: 2 });
  await editOutline(store, { kind: "update", number: 1, entry: { body: "Mira never reaches the harbor. NEW-ENTRY" } });
  const mark = ai.calls.length;
  let { state } = await run(store, ai);
  assert.deepEqual(labelsSince(ai, mark), []);
  assert.equal(state.question.kind, "outline-change");
  assert.deepEqual(state.question.choices.map((choice) => choice.id), ["rewrite-to-outline", "keep-text", "mark-reviewed"]);
  assert.deepEqual([state.question.frozen.kind, state.question.frozen.number], ["outline", 1]);
  const entry = (await outlineOf(store)).chapters[0];
  await answer(store, ai, { answer: "keep-text" });
  assert.equal(stateOf(store).plan.chapters[0].outlineDigest, entry.contentDigest, "the plan follows the new entry at once");
  ({ state } = await run(store, ai));
  assert.equal(state.status, "completed", state.lastError?.message);
  assert.deepEqual(labelsSince(ai, mark), [], "and nothing is rewritten");
});

test("rewriting a chapter to follow its outline: its scenes are rewritten for the new entry and reviewed, then the later chapters are checked", async () => {
  const { store } = await finishedBook({ chapters: 2 });
  await editOutline(store, { kind: "update", number: 1, entry: { body: "Mira never reaches the harbor. NEW-ENTRY" } });
  const before = store.files.get(`${ONE}/001-scene-1-title.md`);
  const ai = scripted((request) => {
    if (request.json?.name !== "revision_impact") return undefined;
    return request.user.includes("BEFORE")
      ? reply({ summary: "Nothing later depends on it.", targets: [] })
      : reply({ summary: "The first scene must follow the entry.", targets: [{ chapterNumber: 1, sceneNumber: 1, instruction: "Mira turns back before the harbor." }] });
  }, { reviewVerdict: () => "approve" });
  await run(store, ai);
  await answer(store, ai, { answer: "rewrite-to-outline" });
  const mark = ai.calls.length;
  const { state } = await run(store, ai);
  assert.equal(state.status, "completed", state.lastError?.message);
  const labels = labelsSince(ai, mark);
  const impacts = callsSince(ai, mark, "autopilot:impact");
  assert.equal(impacts.length, 2, labels.join(", "));
  assert.match(impacts[0].user, /NEW-ENTRY/, "the rewrite follows the new entry");
  assert.ok(labels.indexOf("autopilot:revise:1.1") > labels.indexOf("autopilot:impact"));
  assert.ok(labels.indexOf("autopilot:director-review:1") > labels.indexOf("autopilot:revise:1.1"));
  assert.ok(labels.lastIndexOf("autopilot:impact") > labels.indexOf("autopilot:consolidate:1"), "then the later chapters");
  assert.notEqual(store.files.get(`${ONE}/001-scene-1-title.md`), before);
  assert.equal(state.plan.chapters[0].outlineDigest, (await outlineOf(store)).chapters[0].contentDigest);
  assert.deepEqual(engine.frozenChanges(await loadBookSnapshot(store)), []);
  assert.equal(state.question, null);
});

test("the entry of a written chapter that the author deleted is still only said: the chapter stays in the book", async () => {
  const { store, ai } = await finishedBook({ chapters: 2 });
  await editOutline(store, { kind: "remove", number: 2 });
  const { state, events } = await run(store, ai);
  assert.equal(state.status, "completed", state.lastError?.message);
  assert.deepEqual(insights(events, "outlineWrittenChanged").map((event) => event.chapterNumber), [2]);
});
