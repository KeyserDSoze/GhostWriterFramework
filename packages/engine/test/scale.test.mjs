import test from "node:test";
import assert from "node:assert/strict";
import * as engine from "../dist/index.js";
import { MemoryBookStore, createFakeAutopilotAi, seedBookFiles } from "../dist/testing/index.js";

// New exports are read from the namespace so that, before they exist, each test fails on its own.
const { AutopilotSession, chapterNumberFromSlug, createAutopilotState, loadBookSnapshot, normalizeBrief, normalizeOptions, parseAutopilotState, serializeAutopilotState, slugToTitle } = engine;

const STATE = "autopilot/state.json";
const FAST = { readers: false, readersOnPlan: false, specialists: false, pauseAfterPlan: false };

function stateOf(store) {
  return parseAutopilotState(store.files.get(STATE));
}

function plannedChapter(number, extra = {}) {
  return {
    number,
    title: `Plan ${number}`,
    slug: "",
    summary: `Summary of ${number}.`,
    goal: "",
    pov: [],
    keyEvents: [],
    reveals: [],
    status: "planned",
    scenes: [],
    ...extra,
  };
}

// ─── R1: no hidden caps ─────────────────────────────────────────────────────

test("MAX_BOOK_CHAPTERS is a typo guard far above any real book", () => {
  assert.equal(engine.MAX_BOOK_CHAPTERS, 100_000);
});

test("a brief with 5000 chapters is accepted and 2 000 000 is clamped to the guard", () => {
  assert.equal(normalizeBrief({ targetChapters: 5000 }).targetChapters, 5000);
  assert.equal(normalizeBrief({ targetChapters: 2_000_000 }).targetChapters, engine.MAX_BOOK_CHAPTERS);
  assert.equal(normalizeBrief({ targetChapters: 0 }).targetChapters, 1, "the lower bound is unchanged");
  assert.equal(normalizeBrief({ targetChapters: "300" }).targetChapters, 300);
  assert.equal(normalizeOptions({ chaptersPerRun: 5000 }).chaptersPerRun, 5000);
  assert.equal(normalizeOptions({ chaptersPerRun: 2_000_000 }).chaptersPerRun, engine.MAX_BOOK_CHAPTERS);
  assert.equal(normalizeOptions({ chaptersPerRun: -3 }).chaptersPerRun, 0, "0 still means no limit");
  assert.equal(normalizeBrief({ scenesPerChapter: 99 }).scenesPerChapter, 20, "other limits are not touched");
});

test("chapters 998..1203 survive normalizeAutopilotState round trips, with their reveals, review, question and revision", () => {
  const base = createAutopilotState(new Date(0));
  const state = {
    ...base,
    concept: { done: true, generated: true, secrets: [{ slug: "the-wall", title: "The wall", revealChapter: 1150 }] },
    plan: {
      chapters: Array.from({ length: 206 }, (_, index) => plannedChapter(998 + index, { scenes: [{ number: index === 0 ? 5000 : 1, title: "S", goal: "", beats: [], characters: [], status: "planned", revisions: 0 }] })),
      approved: true,
      rounds: 0,
      revisionNotes: [],
      readerReactions: [],
      readersDone: true,
      awaitingAuthor: false,
    },
    review: { chapterNumber: 1100, round: 1, readersPending: [], readerScores: [], readersSummaryDone: false, findings: [], specialistsDone: false, directorDone: false, decisions: [], repairQueue: [], previousFixes: [], history: [] },
    question: { id: "q1", kind: "director", question: "Which ending?", context: "", options: [], chapterNumber: 1101, askedAt: "2026-01-01T00:00:00.000Z" },
    revision: {
      id: "r1",
      instruction: "Make Orrin kinder.",
      createdAt: "2026-01-01T00:00:00.000Z",
      targets: [{ chapterNumber: 1200, sceneNumber: 1, instruction: "Kinder." }, { chapterNumber: 1203, sceneNumber: 7777, instruction: "Kinder." }],
      cursor: 123_456,
      revisedChapters: [1199, 1000, 1000],
    },
  };
  let current = state;
  for (let round = 0; round < 3; round += 1) current = parseAutopilotState(serializeAutopilotState(current));
  assert.deepEqual(current.plan.chapters.map((chapter) => chapter.number), Array.from({ length: 206 }, (_, index) => 998 + index));
  assert.equal(current.concept.secrets[0].revealChapter, 1150);
  assert.equal(current.review.chapterNumber, 1100);
  assert.equal(current.question.chapterNumber, 1101);
  assert.deepEqual(current.revision.targets.map((target) => target.chapterNumber), [1200, 1203], "a revision target on chapter 1200 is kept");
  assert.deepEqual(current.revision.revisedChapters, [1000, 1199]);
  assert.equal(current.revision.cursor, 123_456, "the cursor clamp is far above any real list");
  assert.equal(current.plan.chapters[0].scenes[0].number, 999, "scene numbers keep their 999 clamp");
  assert.equal(current.revision.targets[1].sceneNumber, 999, "so do the scene numbers of revision targets");
});

test("chapter numbers of three or more digits are read from slugs and titles", () => {
  assert.equal(chapterNumberFromSlug("1000-the-end"), 1000);
  assert.equal(chapterNumberFromSlug("12345-the-end"), 12345);
  assert.equal(chapterNumberFromSlug("001-the-arrival"), 1);
  assert.equal(chapterNumberFromSlug("999-last"), 999);
  assert.equal(chapterNumberFromSlug("01-short"), undefined);
  assert.equal(chapterNumberFromSlug("the-end"), undefined);
  assert.equal(slugToTitle("1000-the-end"), "The End");
  assert.equal(slugToTitle("001-the-arrival"), "The Arrival");
  assert.equal(slugToTitle("the-arrival"), "The Arrival");
  assert.equal(engine.referencedChapterNumber("chapter:1000-the-end"), 1000);
  assert.equal(engine.chapterSlug(1000, "The End"), "1000-the-end");
});

test("a chapter folder numbered 1000 is chapter 1000 for the snapshot, even without its chapter.md", async () => {
  const store = new MemoryBookStore({
    ...seedBookFiles(),
    "chapters/1000-the-end/001-last-scene.md": "---\ntype: paragraph\nid: paragraph:1000-the-end:001-last-scene\nchapter: chapter:1000-the-end\nnumber: 1\ntitle: Last Scene\n---\n\nThe harbor was quiet.",
  });
  const snapshot = await loadBookSnapshot(store);
  assert.deepEqual(snapshot.chapters.map((chapter) => [chapter.number, chapter.title]), [[1000, "The End"]]);
});

test("a run goes through chapters 998..1001 without folding them onto chapter 999", async () => {
  const state = createAutopilotState(new Date(0), { idea: "x", targetChapters: 1003, scenesPerChapter: 1, wordsPerScene: 300 }, { ...FAST, chaptersPerRun: 4 });
  state.concept = { done: true, generated: false, secrets: [] };
  state.plan = { chapters: Array.from({ length: 6 }, (_, index) => plannedChapter(998 + index)), approved: true, rounds: 0, revisionNotes: [], readerReactions: [], readersDone: true, awaitingAuthor: false };
  const store = new MemoryBookStore({ ...seedBookFiles(), [STATE]: serializeAutopilotState(state) });
  const ai = createFakeAutopilotAi({ reviewVerdict: () => "approve" });
  const session = new AutopilotSession({ bookId: "book", store, ai, host: "server", hostLabel: "test", retryDelayMs: 0 });
  await session.start();
  await session.waitForIdle();
  const saved = stateOf(store);
  assert.equal(saved.status, "paused", saved.lastError?.message);
  assert.deepEqual(saved.plan.chapters.map((chapter) => chapter.number), [998, 999, 1000, 1001, 1002, 1003]);
  assert.deepEqual(saved.plan.chapters.map((chapter) => chapter.status), ["done", "done", "done", "done", "planned", "planned"]);
  assert.deepEqual(saved.plan.chapters.slice(0, 4).map((chapter) => chapter.slug), ["998-plan-998", "999-plan-999", "1000-plan-1000", "1001-plan-1001"]);
  assert.ok(store.files.has("chapters/1000-plan-1000/001-scene-1-title.md"), "the scene of chapter 1000 is written in its own folder");
  assert.ok(store.files.has("chapters/1001-plan-1001/chapter.md"));
  assert.match(store.files.get("resumes/total.md"), /## Chapter 1000 Plan 1000/);
  assert.deepEqual(ai.calls.filter((call) => call.label.startsWith("autopilot:consolidate:")).map((call) => call.label), ["998", "999", "1000", "1001"].map((number) => `autopilot:consolidate:${number}`));
});

test("the step ceiling of a run grows with the book instead of stopping every long book at 5000 steps", () => {
  assert.equal(typeof engine.runStepCeiling, "function");
  const brief = (targetChapters) => ({ ...engine.DEFAULT_BRIEF, targetChapters });
  const plan = (length) => ({ chapters: Array.from({ length }, (_, index) => plannedChapter(index + 1)) });
  assert.equal(engine.runStepCeiling({ brief: brief(12), plan: null }), 500 + 80 * 12);
  assert.equal(engine.runStepCeiling({ brief: brief(1500), plan: null }), 500 + 80 * 1500);
  assert.equal(engine.runStepCeiling({ brief: brief(10), plan: plan(2000) }), 500 + 80 * 2000, "the longer of the brief and the plan counts");
  assert.equal(engine.runStepCeiling({ brief: brief(2000), plan: plan(10) }), 500 + 80 * 2000);
  assert.ok(engine.runStepCeiling({ brief: brief(300), plan: null }) > 5000, "a 300-chapter book may legitimately need more than the old fixed ceiling");
});

// ─── R3: windowed outlines ──────────────────────────────────────────────────

/** The outline as the engine rendered it before it was windowed: the reference for small plans. */
function referenceOutline(plan, options = {}) {
  if (!plan?.chapters.length) return "No plan yet.";
  return plan.chapters
    .filter((chapter) => options.upTo === undefined || chapter.number <= options.upTo)
    .map((chapter) => {
      const lines = [`${chapter.number}. ${chapter.title}${chapter.imported ? " (already written by the author)" : ""}${chapter.status === "done" ? " [done]" : ""}`];
      if (chapter.summary) lines.push(`   ${chapter.summary}`);
      if (chapter.reveals.length) lines.push(`   Reveals: ${chapter.reveals.join("; ")}`);
      if (options.scenes) for (const scene of chapter.scenes) lines.push(`   - Scene ${scene.number}: ${scene.title}${scene.summary ? ` — ${scene.summary}` : scene.goal ? ` — ${scene.goal}` : ""}`);
      return lines.join("\n");
    })
    .join("\n");
}

/** A chapter with a realistic amount of text: a four-sentence summary, reveals and three scenes. */
function richChapter(number, extra = {}) {
  const sentence = (index) => `In chapter ${number} the ${["harbor", "council", "lighthouse", "market"][index % 4]} changes what Mira believes about the wall and about her father's silence.`;
  return plannedChapter(number, {
    title: `The Harbor At Night ${number}`,
    summary: [0, 1, 2, 3].map(sentence).join(" "),
    reveals: [`Reveal ${number}.1: the keeper lied`, `Reveal ${number}.2: the wall is cracked`],
    scenes: [1, 2, 3].map((scene) => ({ number: scene, title: `Scene ${scene}`, goal: `Goal of scene ${scene}.`, beats: [], characters: [], status: "planned", summary: `Mira walks the quay of chapter ${number} in scene ${scene} and learns something new.`, revisions: 0 })),
    ...extra,
  });
}

function planOf(chapters) {
  return { chapters, approved: false, rounds: 0, revisionNotes: [], readerReactions: [], readersDone: false, awaitingAuthor: false };
}

function rich(count, extra = () => ({})) {
  return planOf(Array.from({ length: count }, (_, index) => richChapter(index + 1, extra(index + 1))));
}

/** Short chapters: the focus window fits, so the whole window keeps its detail. */
function compact(count, extra = () => ({}), label = "Compact") {
  return planOf(Array.from({ length: count }, (_, index) => plannedChapter(index + 1, { title: `${label} ${index + 1}`, summary: `Short summary of chapter ${index + 1} with a few more words.`, reveals: [`Reveal ${index + 1}`], ...extra(index + 1) })));
}

test("outline is exported with its default budget", () => {
  assert.equal(typeof engine.outline, "function");
  assert.equal(engine.OUTLINE_MAX_CHARS, 24_000);
  assert.equal(typeof engine.planOutline, "function");
  assert.equal(typeof engine.outlineList, "function");
  assert.equal(typeof engine.chapterList, "function");
});

test("the outline of a small plan is byte-identical to the old planOutline", () => {
  const plan = rich(12, (number) => ({ imported: number <= 2 ? true : undefined, status: number <= 4 ? "done" : "planned", reveals: number % 3 === 0 ? [] : [`Reveal ${number}`], summary: number === 5 ? "" : `Summary ${number}.` }));
  assert.equal(engine.outline(plan), referenceOutline(plan));
  assert.equal(engine.outline(plan, { around: 7 }), referenceOutline(plan));
  assert.equal(engine.outline(plan, { scenes: true }), referenceOutline(plan, { scenes: true }));
  assert.equal(engine.planOutline(plan, { scenes: true }), referenceOutline(plan, { scenes: true }));
  assert.equal(engine.planOutline(plan, { upTo: 3 }), referenceOutline(plan, { upTo: 3 }));
  const sixty = compact(60, (number) => ({ status: number % 2 ? "done" : "planned" }));
  assert.ok(referenceOutline(sixty).length < 24_000);
  assert.equal(engine.outline(sixty, { around: 30 }), referenceOutline(sixty), "60 chapters under budget are not condensed");
  assert.equal(engine.outline(sixty), referenceOutline(sixty));
  assert.equal(engine.outline(null), "No plan yet.");
  assert.equal(engine.outline(planOf([])), "No plan yet.");
});

test("an outline stays under its budget for 20, 60, 500 and 5000 chapters, whatever the focus", () => {
  for (const count of [20, 60, 500, 5000]) {
    const plan = rich(count);
    for (const around of [undefined, 1, Math.ceil(count / 2), count]) {
      for (const scenes of [false, true]) {
        const text = engine.outline(plan, { around, scenes });
        assert.ok(text.length <= 24_000, `${count} chapters, around ${around}, scenes ${scenes}: ${text.length} characters`);
      }
    }
    assert.ok(engine.outline(plan, { around: count, maxChars: 6000 }).length <= 6000, `${count} chapters in 6000 characters`);
  }
  const text = engine.outline(rich(5000), { around: 2500 });
  assert.ok(text.length > 4000, "the budget is used, not wasted");
});

test("a condensed outline keeps the first and the last five chapters and the whole focus window", () => {
  const label = "The Long Harbor Chronicle Chapter";
  const plan = compact(500, () => ({ status: "done" }), label);
  const text = engine.outline(plan, { around: 250 });
  assert.ok(text.length <= 24_000);
  assert.ok(referenceOutline(plan).length > 24_000);
  const line = (number) => new RegExp(`^${number}\\. ${label} ${number} \\[done\\]$`, "m");
  const detail = (number) => new RegExp(`^${number}\\. ${label} ${number} \\[done\\]\\n   Short summary of chapter ${number} [^\\n]*\\n   Reveals: Reveal ${number}$`, "m");
  for (const number of [1, 2, 3, 4, 5, 496, 497, 498, 499, 500]) assert.match(text, line(number), `chapter ${number}`);
  for (let number = 220; number <= 280; number += 1) assert.match(text, detail(number), `chapter ${number} keeps its summary and reveals`);
  for (const number of [150, 175, 219, 281, 300, 350]) {
    assert.match(text, line(number), `chapter ${number} keeps its title`);
    assert.doesNotMatch(text, new RegExp(`Short summary of chapter ${number} `), `chapter ${number} lost its summary`);
  }
  for (const number of [20, 99, 149, 351, 400, 450]) assert.doesNotMatch(text, new RegExp(`^${number}\\. `, "m"), `chapter ${number} is inside a block`);
  assert.match(text, /^Chapters 101-110[ :]/m, "far chapters collapse into one line per block of ten");
  assert.match(text, /^Chapters 451-460[ :]/m);
  assert.match(text.split("\n")[0], /^1\. /, "the outline is only the chapters: it starts with the first one");
  assert.doesNotMatch(text, /condensed/i);
  assert.equal(engine.outlineList(plan, { around: 250 }).text, text);
  assert.equal(engine.outlineList(plan, { around: 250 }).note, "condensed to fit: chapters far from chapter 250 show less detail, and runs of distant chapters share one line", "what was left out is said in words, for the label of the section");
  assert.equal(engine.outlineList(compact(60), { around: 30 }).note, "", "a list that fits says nothing");
  assert.equal(engine.listSection("CHAPTER PLAN", engine.outlineList(compact(60))), `CHAPTER PLAN:\n${engine.planOutline(compact(60))}`);
  assert.match(engine.listSection("CHAPTER PLAN", engine.outlineList(plan, { around: 250 })), /^CHAPTER PLAN \(condensed to fit: chapters far from chapter 250 show less detail, and runs of distant chapters share one line\):\n1\. /);
});

test("a block says what its chapters are when it cannot list their titles", () => {
  const outlineOf = (plan, maxChars) => engine.outline(plan, { around: 1, maxChars });
  const blockLabels = (plan) => {
    // The titles of a block are listed only when the budget has room for them: shrink the budget until none is.
    for (let maxChars = outlineOf(plan, 24_000).length; maxChars > 3000; maxChars -= 25) {
      const labels = outlineOf(plan, maxChars).split("\n").filter((entry) => /^Chapters \d+-\d+ \(/.test(entry));
      if (labels.length) return labels;
    }
    return [];
  };
  const long = "A Rather Long Title For A Chapter Of The Harbor Saga";
  const allLabelled = (labels, pattern) => labels.length > 0 && labels.every((entry) => pattern.test(entry));
  assert.ok(allLabelled(blockLabels(compact(400, () => ({ status: "done" }), long)), /\(all approved\)$/));
  assert.ok(allLabelled(blockLabels(compact(400, () => ({}), long)), /\(planned\)$/));
  assert.ok(allLabelled(blockLabels(compact(400, () => ({ imported: true, status: "done" }), long)), /\(already written by the author\)$/));
  const mixed = blockLabels(compact(400, (number) => ({ status: number % 2 ? "done" : "planned" }), long));
  assert.ok(allLabelled(mixed, /\((\d+ of \d+ approved|all approved|planned)\)$/), mixed.join("\n"));
  assert.ok(mixed.some((entry) => /^Chapters \d+-\d+ \(5 of 10 approved\)$/.test(entry)), mixed.join("\n"));
});

test("the degradation order: reveals and scenes first, then summaries, then blocks", () => {
  const plan = compact(130, () => ({ scenes: [{ number: 1, title: "Only scene", goal: "Goal.", beats: [], characters: [], status: "planned", summary: "Scene summary.", revisions: 0 }] }));
  const full = referenceOutline(plan, { scenes: true });
  const outlineWith = (maxChars) => engine.outline(plan, { around: 1, scenes: true, maxChars });
  const count = (text, pattern) => (text.match(pattern) ?? []).length;
  assert.equal(outlineWith(full.length), full, "it fits: nothing is dropped");
  assert.equal(count(full, /^   Reveals: /gm), 130);

  const noExtras = outlineWith(full.length - 1);
  assert.equal(count(noExtras, /^   Short summary of chapter /gm), 130, "every chapter keeps its summary");
  assert.equal(count(noExtras, /^   Reveals: /gm), 31, "only the chapters within 30 of the focus keep their reveals");
  assert.equal(count(noExtras, /^   - Scene 1: Only scene/gm), 31, "and their scene lines");
  assert.doesNotMatch(noExtras, /^Chapters /m, "nothing is collapsed yet");

  const titles = outlineWith(noExtras.length - 1);
  assert.equal(count(titles, /^   Short summary of chapter /gm), 31, "then far chapters keep only their title");
  assert.match(titles, /^80\. Compact 80$/m);
  assert.match(titles, /^   Reveals: Reveal 31$/m, "the window is untouched");
  assert.doesNotMatch(titles, /^Chapters /m, "still nothing is collapsed");

  const blocks = outlineWith(titles.length - 1);
  assert.match(blocks, /^Chapters 102-110[ :]/m, "beyond 100 chapters from the focus, one line per block");
  assert.match(blocks, /^101\. Compact 101$/m, "a chapter within 100 stays a line");
  assert.match(blocks, /^126\. Compact 126$/m, "and so do the last five chapters, however far");
  assert.doesNotMatch(blocks, /^105\. /m);
  assert.equal(count(blocks, /^   Short summary of chapter /gm), 31, "the window keeps its summaries");
});

test("a block lists the titles of its chapters when the budget allows it, nearest first", () => {
  const plan = compact(140);
  const outlineWith = (maxChars) => engine.outline(plan, { around: 1, maxChars });
  const noExtras = outlineWith(referenceOutline(plan).length - 1);
  const titles = outlineWith(noExtras.length - 1);
  const tight = outlineWith(titles.length - 1);
  const rich = (entry) => /^Chapters \d+-\d+: /.test(entry);
  const blockLines = (text) => text.split("\n").filter((entry) => entry.startsWith("Chapters "));
  assert.match(blockLines(tight)[0], /^Chapters 102-110: Compact 102; Compact 103; /, "the titles of a block fit where the budget has room");
  let mixed = 0;
  for (let maxChars = tight.length; maxChars > tight.length - 700; maxChars -= 7) {
    const text = outlineWith(maxChars);
    assert.ok(text.length <= maxChars, `${text.length} > ${maxChars}`);
    const lines = blockLines(text);
    const kinds = lines.map(rich);
    assert.deepEqual(kinds, [...kinds].sort((left, right) => Number(right) - Number(left)), "titles go to the blocks nearest the focus first");
    if (kinds.includes(true) && kinds.includes(false)) mixed += 1;
  }
  assert.ok(mixed > 0, "between a budget for every title and a budget for none, some blocks list titles and others do not");
});

test("an outline is deterministic and never changes the plan it is given", () => {
  const plan = rich(800, (number) => ({ status: number % 3 ? "done" : "planned", imported: number <= 3 ? true : undefined }));
  const before = structuredClone(plan);
  const first = engine.outline(plan, { around: 400 });
  const second = engine.outline(structuredClone(plan), { around: 400 });
  assert.equal(first, second);
  assert.deepEqual(plan, before);
  assert.notEqual(engine.outline(plan, { around: 100 }), first, "the focus matters");
  assert.equal(engine.outline(plan, { around: 400, maxChars: 24_000 }), first, "24 000 is the default budget");
  for (const line of first.split("\n")) assert.ok(!line.endsWith("…"), "no line is cut");
});

// ─── R3: windowed prompts ───────────────────────────────────────────────────

/** An AI that records the first request and then fails for good, so that a run ends right after it. */
function stopAfterTheFirstCall() {
  const calls = [];
  return {
    calls,
    async complete(request) {
      calls.push(request);
      throw new engine.AiProviderError("Stopped by the test.", 401, false);
    },
  };
}

async function firstRequest(store, start = {}) {
  const ai = stopAfterTheFirstCall();
  const session = new AutopilotSession({ bookId: "book", store, ai, host: "server", hostLabel: "test", retryDelayMs: 0 });
  await session.start(start);
  await session.waitForIdle();
  assert.ok(ai.calls.length >= 1, "the run reached an AI call");
  return ai.calls[0];
}

/** A book written by the author: `count` chapters of two scenes each, with the files the snapshot needs. */
function writtenBook(count) {
  const files = seedBookFiles();
  for (let number = 1; number <= count; number += 1) {
    const slug = engine.chapterSlug(number, `Written ${number}`);
    files[`chapters/${slug}/chapter.md`] = `---\ntype: chapter\nid: chapter:${slug}\nnumber: ${number}\ntitle: Written ${number}\nsummary: What happened in written chapter ${number}.\n---\n\n# Written ${number}\n`;
    for (const scene of [1, 2]) {
      files[`chapters/${slug}/00${scene}-scene-${scene}.md`] = `---\ntype: paragraph\nid: paragraph:${slug}:00${scene}-scene-${scene}\nchapter: chapter:${slug}\nnumber: ${scene}\ntitle: Scene ${scene}\nsummary: Scene ${scene} of chapter ${number}.\n---\n\nThe prose of chapter ${number}, scene ${scene}.`;
    }
  }
  return files;
}

/** A state whose chapters before `reviewing` are done and whose chapter `reviewing` waits for the specialists. */
function bookUnderReview(total, reviewing) {
  const state = createAutopilotState(new Date(0), { idea: "x", targetChapters: total, scenesPerChapter: 1, wordsPerScene: 300 }, { ...FAST, readers: false, specialists: true });
  state.concept = { done: true, generated: false, secrets: [] };
  const chapters = Array.from({ length: total }, (_, index) => richChapter(index + 1, index + 1 < reviewing ? { imported: true, status: "done", scenes: [] } : { scenes: [] }));
  const slug = engine.chapterSlug(reviewing, chapters[reviewing - 1].title);
  chapters[reviewing - 1] = { ...chapters[reviewing - 1], status: "review", scenes: [{ number: 1, title: "Scene 1", goal: "Goal.", beats: [], characters: [], status: "written", slug: "001-scene-1", path: `chapters/${slug}/001-scene-1.md`, revisions: 0, words: 30 }] };
  state.plan = planOf(chapters);
  state.plan.approved = true;
  state.plan.readersDone = true;
  const files = {
    ...seedBookFiles(),
    [STATE]: serializeAutopilotState(state),
    [`chapters/${slug}/chapter.md`]: `---\ntype: chapter\nid: chapter:${slug}\nnumber: ${reviewing}\ntitle: ${chapters[reviewing - 1].title}\n---\n\n# Chapter\n`,
    [`chapters/${slug}/001-scene-1.md`]: `---\ntype: paragraph\nid: paragraph:${slug}:001-scene-1\nchapter: chapter:${slug}\nnumber: 1\ntitle: Scene 1\n---\n\nMira walked the quay while the lamps came on one by one along the harbor wall.`,
  };
  return new MemoryBookStore(files);
}

test("the specialists' prompt for chapter 400 of a 500-chapter plan does not grow with the book", async () => {
  const small = await firstRequest(bookUnderReview(50, 40));
  assert.equal(small.label, "autopilot:specialists:40");
  const medium = await firstRequest(bookUnderReview(500, 400));
  assert.equal(medium.label, "autopilot:specialists:400");
  const large = await firstRequest(bookUnderReview(5000, 4000));
  assert.equal(large.label, "autopilot:specialists:4000");
  const fullList = Array.from({ length: 399 }, (_, index) => richChapter(index + 1)).map((chapter) => `${chapter.number}. ${chapter.title} — ${chapter.summary}`).join("\n");
  assert.ok(fullList.length > 150_000, "the old list of previous chapters was this long");
  assert.ok(medium.user.length < 32_000, `${medium.user.length} characters for chapter 400 of 500`);
  assert.ok(large.user.length < 32_000, `${large.user.length} characters for chapter 4000 of 5000`);
  assert.match(medium.user, /PREVIOUS CHAPTERS \(condensed to fit: chapters far from chapter 400 show less detail\):\n1\. /, "the label says the list is condensed (here only the titles of the far chapters are left)");
  assert.match(medium.user, /^399\. The Harbor At Night 399 — /m, "the chapters just before keep their summary");
  assert.match(medium.user, /^1\. The Harbor At Night 1$/m, "the first chapters are kept");
});

test("the specialists' prompt of a small book is exactly what it was", async () => {
  const request = await firstRequest(bookUnderReview(12, 10));
  const expected = Array.from({ length: 9 }, (_, index) => richChapter(index + 1)).map((chapter) => `${chapter.number}. ${chapter.title} — ${chapter.summary}`).join("\n");
  assert.ok(request.user.includes(`PREVIOUS CHAPTERS:\n${expected}\n\nCHAPTER 10: `), "one line per previous chapter, as before");
});

test("the plan reader's and the director's views of the plan stay bounded for a plan of 600 or 6000 chapters", async () => {
  const unapproved = (total, readersOnPlan) => {
    const state = createAutopilotState(new Date(0), { idea: "x", targetChapters: total, scenesPerChapter: 1 }, { ...FAST, readersOnPlan, maxReaders: 1 });
    state.concept = { done: true, generated: false, secrets: [] };
    state.plan = planOf(Array.from({ length: total }, (_, index) => richChapter(index + 1, { scenes: [] })));
    return new MemoryBookStore({ ...seedBookFiles(), [STATE]: serializeAutopilotState(state) });
  };
  const sizes = {};
  for (const [name, readersOnPlan, label] of [["reader", true, /^autopilot:plan-reader:/], ["director", false, /^autopilot:plan-review$/]]) {
    const small = await firstRequest(unapproved(30, readersOnPlan));
    const medium = await firstRequest(unapproved(600, readersOnPlan));
    const large = await firstRequest(unapproved(6000, readersOnPlan));
    for (const request of [small, medium, large]) assert.match(request.label, label);
    sizes[name] = [small.user.length, medium.user.length, large.user.length];
    assert.ok(medium.user.length < 40_000, `${name}: ${medium.user.length} characters for 600 chapters`);
    assert.ok(large.user.length < 40_000, `${name}: ${large.user.length} characters for 6000 chapters`);
    assert.match(medium.user, /CHAPTER PLAN \(condensed to fit: chapters far from chapter 1 show less detail, and runs of distant chapters share one line\):\n/, `${name}: the section says it is condensed`);
    assert.match(medium.user, /^1\. The Harbor At Night 1\n/m, `${name}: the opening of the book is in it`);
    assert.match(medium.user, /^600\. The Harbor At Night 600$/m, `${name}: and its last chapter`);
  }
  assert.ok(sizes.reader[0] < 24_000 && sizes.director[0] < 40_000);
});

test("the revision impact lists the written scenes of a small book as before and a bounded window of a long one", async () => {
  const pending = (files, instruction = "Make Orrin kinder.") => {
    const chapters = Object.keys(files).filter((path) => path.endsWith("/chapter.md")).length;
    const state = createAutopilotState(new Date(0), { idea: "x", targetChapters: chapters, scenesPerChapter: 2 }, FAST);
    state.concept = { done: true, generated: false, secrets: [] };
    state.revision = { id: "r1", instruction, createdAt: "2026-01-01T00:00:00.000Z", targets: null, cursor: 0 };
    return new MemoryBookStore({ ...files, [STATE]: serializeAutopilotState(state) });
  };
  const listOf = (request) => /WRITTEN SCENES(?: \([^)]*\))?:\n([\s\S]*?)\n<\/repository_content>/.exec(request.user)[1];

  const small = await firstRequest(pending(writtenBook(12)));
  assert.equal(small.label, "autopilot:impact");
  const expected = Array.from({ length: 12 }, (_, index) => [1, 2].map((scene) => `- Chapter ${index + 1}, scene ${scene} «Scene ${scene}»: Scene ${scene} of chapter ${index + 1}.`)).flat().join("\n");
  assert.equal(listOf(small), expected, "unchanged for a small book");
  assert.ok(small.user.includes(`WRITTEN SCENES:\n${expected}`), "under its plain label");
  assert.doesNotMatch(small.user, /Some chapters are listed without their scenes/);

  const medium = await firstRequest(pending(writtenBook(400)));
  const large = await firstRequest(pending(writtenBook(1600)));
  assert.ok(medium.user.length < 40_000, `${medium.user.length} characters for 400 chapters`);
  assert.ok(large.user.length < 40_000, `${large.user.length} characters for 1600 chapters`);
  assert.match(large.user, /WRITTEN SCENES \(condensed to fit: chapters far from chapter 1600 show less detail, and runs of distant chapters share one line\):\n/);
  assert.match(large.user, /Some chapters are listed without their scenes: a scene of such a chapter can still be chosen by its chapter and scene number\./);
  assert.match(listOf(large), /^- Chapter 1600, scene 2 «Scene 2»: Scene 2 of chapter 1600\.$/m, "the end of the book is where the author is working, so it keeps its scenes");
});

test("the director's view of the whole book lists a small book as before and a bounded window of a long one", async () => {
  const ask = async (files) => {
    const ai = stopAfterTheFirstCall();
    await assert.rejects(() => engine.askDirector({ store: new MemoryBookStore(files), ai, target: { kind: "book" } }), /Stopped by the test/);
    return ai.calls[0];
  };
  const listOf = (request) => /CHAPTERS(?: \([^)]*\))?:\n([\s\S]*?)(?:\n\n|\n<\/repository_content>)/.exec(request.user)[1];
  const small = await ask(writtenBook(12));
  const expected = Array.from({ length: 12 }, (_, index) => `- Chapter ${index + 1} «Written ${index + 1}» (2 scenes): What happened in written chapter ${index + 1}.`).join("\n");
  assert.equal(listOf(small), expected, "unchanged for a small book");
  const medium = await ask(writtenBook(400));
  const large = await ask(writtenBook(1600));
  assert.ok(medium.user.length < 45_000, `${medium.user.length} characters for 400 chapters`);
  assert.ok(large.user.length < 45_000, `${large.user.length} characters for 1600 chapters`);
  assert.match(large.user, /CHAPTERS \(condensed to fit: chapters far from chapter 1600 show less detail, and runs of distant chapters share one line\):\n/);
  assert.ok(small.user.includes(`CHAPTERS:\n${expected}`), "under its plain label");
  assert.match(listOf(large), /^- Chapter 1600 «Written 1600» \(2 scenes\): What happened in written chapter 1600\.$/m);
  assert.match(listOf(large), /^- Chapter 1 «Written 1» \(2 scenes\)/m, "the first chapters are kept");
});

test("extending a long written book lists its chapters as before when small and a bounded window when long", async () => {
  const request = (count) => firstRequest(new MemoryBookStore(writtenBook(count)), { brief: { idea: "x", targetChapters: count + 5, scenesPerChapter: 1 }, options: FAST });
  const small = await request(12);
  assert.equal(small.label, "autopilot:plan");
  const expected = Array.from({ length: 12 }, (_, index) => `${index + 1}. Written ${index + 1} — What happened in written chapter ${index + 1}.`).join("\n");
  assert.ok(small.user.includes(`CHAPTERS ALREADY WRITTEN:\n${expected}\n\n`), "unchanged for a small book");
  const medium = await request(400);
  const large = await request(1600);
  assert.ok(medium.user.length < 60_000, `${medium.user.length} characters after 400 chapters`);
  assert.ok(large.user.length < 60_000, `${large.user.length} characters after 1600 chapters`);
  assert.match(large.user, /CHAPTERS ALREADY WRITTEN \(condensed to fit: chapters far from chapter 1601 show less detail, and runs of distant chapters share one line\):\n/);
  assert.match(large.user, /^1600\. Written 1600 — What happened in written chapter 1600\.$/m);
});

// ─── R2: batched planning ───────────────────────────────────────────────────

function reply(json, extra = {}) {
  return { text: JSON.stringify(json), json, usage: { inputTokens: 100, outputTokens: 50, cachedInputTokens: 0 }, model: "fake-model", provider: "fake", cost: 0.001, currency: "USD", ...extra };
}

/** The fake AI, with some replies replaced: `script` returns undefined (default reply), an Error, or a response. */
function scripted(script, options = {}) {
  const base = createFakeAutopilotAi(options);
  return {
    calls: base.calls,
    async complete(request) {
      const seen = base.calls.filter((call) => call.label === request.label).length;
      const custom = script(request, seen);
      if (custom === undefined) return base.complete(request);
      base.calls.push(request);
      if (custom instanceof Error) throw custom;
      return custom;
    },
  };
}

const planCalls = (ai) => ai.calls.filter((call) => call.label === "autopilot:plan");

/** The chapters a plan request asks for, read the way the fake AI reads them. */
function requestedRange(call) {
  const match = /numbered (\d+) to (\d+)/.exec(call.user) ?? /chapters (\d+)-(\d+)/.exec(call.user);
  return [Number(match[1]), Number(match[2])];
}

function newSession(store, ai, extra = {}) {
  const events = [];
  const session = new AutopilotSession({ bookId: "book", store, ai, host: "server", hostLabel: "test", retryDelayMs: 0, ...extra });
  session.subscribe((event) => events.push(event));
  return { session, events };
}

/** Plans a book and stops once the plan is approved (the run pauses for the author). */
async function planBook(chapters, { ai = createFakeAutopilotAi(), options = {}, files = seedBookFiles() } = {}) {
  const store = new MemoryBookStore(files);
  const { session, events } = newSession(store, ai);
  await session.start({ brief: { idea: "x", targetChapters: chapters, scenesPerChapter: 1, wordsPerScene: 300 }, options: { ...FAST, pauseAfterPlan: true, ...options } });
  await session.waitForIdle();
  return { store, ai, session, events, state: stateOf(store) };
}

const numbersOf = (state) => state.plan.chapters.map((chapter) => chapter.number);
const sequence = (from, to) => Array.from({ length: to - from + 1 }, (_, index) => from + index);

test("PLAN_BATCH_CHAPTERS is 20 and describeTask says which chapters a batch plans", () => {
  assert.equal(engine.PLAN_BATCH_CHAPTERS, 20);
  const title = (language, params) => engine.describeTask("plan", language, params).title;
  assert.equal(title("en", { chapters: 12 }), "Planning 12 chapters", "a single batch keeps today's wording");
  assert.equal(title("it", { chapters: 12 }), "Pianificazione di 12 capitoli");
  assert.equal(title("en", { chapters: 20, from: 21, to: 40 }), "Planning chapters 21-40");
  assert.equal(title("it", { chapters: 20, from: 21, to: 40 }), "Pianificazione dei capitoli 21-40");
  assert.equal(title("en", { chapters: 1, from: 41, to: 41 }), "Planning chapter 41");
  assert.equal(title("it", { chapters: 1, from: 41, to: 41 }), "Pianificazione del capitolo 41");
});

test("a book of 20 chapters is planned in one call, 21 in two, 150 in eight, every chapter exactly once", async () => {
  for (const [chapters, ranges] of [
    [1, [[1, 1]]],
    [12, [[1, 12]]],
    [20, [[1, 20]]],
    [21, [[1, 20], [21, 21]]],
    [40, [[1, 20], [21, 40]]],
    [41, [[1, 20], [21, 40], [41, 41]]],
    [150, [[1, 20], [21, 40], [41, 60], [61, 80], [81, 100], [101, 120], [121, 140], [141, 150]]],
  ]) {
    const { ai, state } = await planBook(chapters);
    assert.equal(state.status, "paused", `${chapters}: ${state.lastError?.message}`);
    assert.equal(state.lastError, null);
    assert.deepEqual(planCalls(ai).map(requestedRange), ranges, `${chapters} chapters`);
    assert.deepEqual(numbersOf(state), sequence(1, chapters), `${chapters}: every chapter exactly once, in order`);
    assert.deepEqual(state.plan.chapters.map((chapter) => chapter.title), sequence(1, chapters).map((number) => `Chapter Title ${number}`));
    assert.equal(state.plan.approved, true);
    assert.deepEqual([state.plan.revisionNotes, state.plan.revisionBatches], [[], undefined], "nothing is left to revise");
    assert.equal(ai.calls.filter((call) => call.label === "autopilot:plan-review").length, 1, "the plan is reviewed once, when it is complete");
    assert.equal(ai.calls.filter((call) => call.label === "autopilot:concept").length, 1);
  }
});

test("the prompt of a plan of up to 20 chapters is the one it always was; a batch of a longer book says what it covers", async () => {
  const single = await planBook(20);
  const only = planCalls(single.ai)[0];
  assert.match(only.user, /^<current_request trust="user-instruction">\nPlan the next 20 chapters of the novel, numbered 1 to 20\.\n\n/);
  assert.doesNotMatch(only.user, /PLAN SO FAR|batch/i);
  assert.equal(only.maxOutputTokens, 9000);

  const { ai } = await planBook(150);
  const calls = planCalls(ai);
  assert.equal(calls.length, 8);
  calls.forEach((call, index) => {
    const from = 1 + index * 20;
    const to = Math.min(from + 19, 150);
    assert.ok(call.user.includes(`Plan the next ${to - from + 1} chapters of the novel, numbered ${from} to ${to}.`), `batch ${index + 1}`);
    assert.match(call.user, /The novel will have 150 chapters in all/, "the whole size of the book");
    assert.ok(call.user.includes(`this call covers only chapters ${from} to ${to}`), "and the range of this call");
    assert.equal(call.maxOutputTokens, 9000);
    assert.equal(call.json.name, "chapter_plan");
    assert.doesNotMatch(call.user, /Revise the chapter plan/);
  });
  assert.doesNotMatch(calls[0].user, /PLAN SO FAR/, "nothing is planned before the first batch");
  const second = calls[1].user;
  assert.match(second, /PLAN SO FAR[^\n]*:\n1\. Chapter Title 1\n   Summary of chapter 1\.\n/, "the plan so far reaches the next batch");
  assert.match(second, /^20\. Chapter Title 20$/m);
  assert.doesNotMatch(second, /^21\. Chapter Title 21/m, "and only that");
  assert.match(calls[7].user, /the last chapters of the book|chapter 150 is the end/i, "the last batch is told that it closes the book");
  assert.match(calls[0].user, /do not end the story|must not end/i, "the others are told not to");
});

test("a batch of a long book is a step of its own: its title, insight and summary name the chapters", async () => {
  const { events } = await planBook(45);
  const titles = events.filter((event) => event.type === "task-started" && event.activity.task === "plan").map((event) => event.activity.title);
  assert.deepEqual(titles, ["Planning chapters 1-20", "Planning chapters 21-40", "Planning chapters 41-45"]);
  const activities = events.filter((event) => event.type === "task-started" && event.activity.task === "plan").map((event) => event.activity.chapterNumber);
  assert.deepEqual(activities, [1, 21, 41], "the first chapter of the batch tells the steps apart, so none is mistaken for a repeat");
  const insights = events.filter((event) => event.type === "insight" && /planned/.test(event.title)).map((event) => event.title);
  assert.deepEqual(insights, ["Chapters 1-20 planned", "Chapters 21-40 planned", "Chapters 41-45 planned"]);
  const finished = events.filter((event) => event.type === "task-finished" && event.activity.task === "plan").map((event) => event.activity.summary);
  assert.match(finished[0], /^Chapters 1-20: 1\. Chapter Title 1; 2\. Chapter Title 2;/);
  assert.match(finished[2], /^Chapters 41-45: 41\. Chapter Title 41; /);

  const italian = await planBook(45, { files: seedBookFiles({ language: "it" }) });
  assert.deepEqual(italian.events.filter((event) => event.type === "task-started" && event.activity.task === "plan").map((event) => event.activity.title), ["Pianificazione dei capitoli 1-20", "Pianificazione dei capitoli 21-40", "Pianificazione dei capitoli 41-45"]);
  assert.deepEqual(italian.events.filter((event) => event.type === "insight" && /pianificati/.test(event.title)).map((event) => event.title), ["Capitoli 1-20 pianificati", "Capitoli 21-40 pianificati", "Capitoli 41-45 pianificati"]);

  const small = await planBook(12);
  assert.deepEqual(small.events.filter((event) => event.type === "task-started" && event.activity.task === "plan").map((event) => [event.activity.title, event.activity.chapterNumber]), [["Planning 12 chapters", undefined]]);
  assert.deepEqual(small.events.filter((event) => event.type === "insight" && /planned/.test(event.title)).map((event) => event.title), ["12 chapters planned"]);
  assert.match(small.events.find((event) => event.type === "task-finished" && event.activity.task === "plan").activity.summary, /^1\. Chapter Title 1; 2\. Chapter Title 2;/, "a single batch is summarized as before");
});

function plannerContext(language = "en", chapters = []) {
  const snapshot = { files: new Map(), book: { title: "B", language, description: "" }, chapters, canon: [], personaPaths: [], ghostwriterSlugs: [], hasDirector: false };
  return { snapshot, director: engine.defaultDirector(language), readers: [], language, storyDesignThin: false };
}

function planningState(target, planned = 0, extra = {}) {
  const state = createAutopilotState(new Date(0), { idea: "x", targetChapters: target, scenesPerChapter: 1 }, FAST);
  state.concept = { done: true, generated: false, secrets: [] };
  if (planned || extra.plan) state.plan = { ...planOf(sequence(1, planned).map((number) => plannedChapter(number, { title: `T${number}` }))), ...extra.plan };
  return state;
}

test("the planner plans the first chapter missing from the plan, and the batches of a revision in order", () => {
  const next = (state, language = "en") => engine.nextStep(state, plannerContext(language));
  const taskOf = (step) => (step.kind === "task" ? [step.task.kind, step.task.title, step.task.chapterNumber] : step);
  assert.deepEqual(taskOf(next(planningState(60))), ["plan", "Planning chapters 1-20", 1]);
  assert.deepEqual(taskOf(next(planningState(60, 20))), ["plan", "Planning chapters 21-40", 21]);
  assert.deepEqual(taskOf(next(planningState(60, 40))), ["plan", "Planning chapters 41-60", 41]);
  assert.deepEqual(taskOf(next(planningState(60, 40), "it")), ["plan", "Pianificazione dei capitoli 41-60", 41]);
  assert.deepEqual(taskOf(next(planningState(150, 140))), ["plan", "Planning chapters 141-150", 141]);
  assert.equal(next(planningState(60, 60)).task.kind, "plan-review", "a complete plan goes to its review");
  assert.deepEqual(taskOf(next(planningState(12))), ["plan", "Planning 12 chapters", undefined], "a single batch keeps today's task");
  assert.equal(next(planningState(60, 60, { plan: { approved: true, awaitingAuthor: false } })).task.kind, "scenes", "an approved plan is never planned again");

  const revising = (batches) => planningState(60, 60, { plan: { rounds: 1, revisionNotes: ["Chapter 45: darker."], ...(batches ? { revisionBatches: batches } : {}) } });
  assert.deepEqual(taskOf(next(revising([21, 41]))), ["plan", "Planning chapters 21-40", 21]);
  assert.deepEqual(taskOf(next(revising([41]))), ["plan", "Planning chapters 41-60", 41]);
  assert.deepEqual(taskOf(next(revising(undefined))), ["plan", "Planning chapters 1-20", 1], "a state written by an older engine revises every batch");
  assert.deepEqual(taskOf(next(revising([]))), ["plan", "Planning chapters 1-20", 1]);
  assert.equal(next(planningState(60, 60, { plan: { revisionNotes: [], revisionBatches: [21] } })).task.kind, "plan-review", "a list without notes is stale: nothing to revise");
  assert.deepEqual(taskOf(next(planningState(60, 40, { plan: { revisionNotes: ["Chapter 5: darker."], revisionBatches: [1] } }))), ["plan", "Planning chapters 41-60", 41], "chapters still missing are planned before a revision");
});

test("a director who asks for changes on chapters 5 and 45 of a 60-chapter plan gets exactly batches 1 and 41 again", async () => {
  const seenStates = [];
  let reviews = 0;
  const ai = scripted((request) => {
    if (request.json?.name !== "plan_review") return undefined;
    reviews += 1;
    return reviews === 1
      ? reply({ verdict: "revise", score: 5, summary: "Needs work.", strengths: [], changes: [{ chapterNumber: 5, instruction: "Make the harbor darker." }, { chapterNumber: 45, instruction: "Raise the stakes." }], guidance: [] })
      : undefined;
  });
  const holder = {};
  const hooks = { afterCommit: async ({ task }) => { if (task.kind === "plan-review") seenStates.push(stateOf(holder.store).plan); } };
  const store = new MemoryBookStore(seedBookFiles());
  holder.store = store;
  const { session } = newSession(store, ai, { hooks });
  await session.start({ brief: { idea: "x", targetChapters: 60, scenesPerChapter: 1 }, options: { ...FAST, pauseAfterPlan: true } });
  await session.waitForIdle();
  const state = stateOf(store);
  assert.equal(state.status, "paused", state.lastError?.message);
  assert.deepEqual(planCalls(ai).map(requestedRange), [[1, 20], [21, 40], [41, 60], [1, 20], [41, 60]], "batches 21-40 is not asked again");
  assert.deepEqual(seenStates[0].revisionBatches, [1, 41], "the review records which batches to regenerate");
  assert.deepEqual(seenStates[0].revisionNotes, ["Chapter 5: Make the harbor darker.", "Chapter 45: Raise the stakes."]);
  assert.equal(seenStates[0].approved, false);
  assert.equal(seenStates[0].rounds, 1);
  const [, , , first, second] = planCalls(ai);
  for (const call of [first, second]) {
    assert.match(call.user, /Revise the chapter plan \(chapters \d+-\d+\) applying the director's changes:\n- Chapter 5: Make the harbor darker\.\n- Chapter 45: Raise the stakes\./);
    assert.match(call.user, /Apply only the changes that concern/, "each batch is told to leave the others' changes alone");
  }
  assert.match(first.user, /CURRENT VERSION OF CHAPTERS 1-20[^\n]*:\nCHAPTER 1: Chapter Title 1\nSummary: Summary of chapter 1\.\nPurpose: Goal of chapter 1\.\nPoint of view: Mira Vale\nKey events:\n- Event 1\n/, "the batch is shown as it is now");
  assert.match(first.user, /^21\. Chapter Title 21\n/m, "and the rest of the plan around it");
  assert.doesNotMatch(first.user, /^5\. Chapter Title 5\n/m, "without repeating the chapters of the batch in the outline");
  assert.match(second.user, /^40\. Chapter Title 40\n/m);
  assert.equal(state.plan.rounds, 1);
  assert.deepEqual([state.plan.revisionNotes, state.plan.revisionBatches], [[], undefined], "the notes go once every batch is done");
  assert.deepEqual(numbersOf(state), sequence(1, 60));
  assert.equal(ai.calls.filter((call) => call.label === "autopilot:plan-review").length, 2, "the revised plan is reviewed once, when every batch is done");
  assert.equal(state.plan.approved, true);
});

test("a change without a chapter number, or whose chapter is not in the plan, regenerates every batch", async () => {
  const cases = [
    [[{ instruction: "Make everything darker." }], [1, 21, 41]],
    [[{ chapterNumber: 5, instruction: "Darker." }, { instruction: "Raise the stakes." }], [1, 21, 41]],
    [[{ chapterNumber: 999, instruction: "Darker." }], [1, 21, 41]],
    [[{ chapterNumber: 21, instruction: "Darker." }, { chapterNumber: 40, instruction: "Faster." }], [21]],
    [[{ chapterNumber: 20, instruction: "Darker." }, { chapterNumber: 21, instruction: "Faster." }, { chapterNumber: 60, instruction: "End." }], [1, 21, 41]],
  ];
  for (const [changes, batches] of cases) {
    let reviews = 0;
    const ai = scripted((request) => {
      if (request.json?.name !== "plan_review") return undefined;
      return (reviews += 1) === 1 ? reply({ verdict: "revise", score: 5, summary: "Needs work.", strengths: [], changes, guidance: [] }) : undefined;
    });
    const { state } = await planBook(60, { ai });
    assert.equal(state.status, "paused", state.lastError?.message);
    const regenerated = planCalls(ai).slice(3).map(requestedRange);
    assert.deepEqual(regenerated, batches.map((from) => [from, from + 19]), JSON.stringify(changes));
  }
});

test("resuming after an interruption between two batches continues with the next batch, without repeating one", async () => {
  const holder = {};
  let planned = 0;
  const hooks = { afterCommit: async ({ task }) => { if (task.kind === "plan" && (planned += 1) === 1) holder.session.pause("after-step"); } };
  const store = new MemoryBookStore(seedBookFiles());
  const ai = createFakeAutopilotAi();
  const { session } = newSession(store, ai, { hooks });
  holder.session = session;
  await session.start({ brief: { idea: "x", targetChapters: 60, scenesPerChapter: 1 }, options: { ...FAST, pauseAfterPlan: true } });
  await session.waitForIdle();
  let state = stateOf(store);
  assert.equal(state.status, "paused");
  assert.deepEqual(numbersOf(state), sequence(1, 20), "the first batch was saved");
  assert.equal(state.plan.approved, false);
  assert.deepEqual(planCalls(ai).map(requestedRange), [[1, 20]]);

  await session.start();
  await session.waitForIdle();
  state = stateOf(store);
  assert.equal(state.status, "paused", state.lastError?.message);
  assert.equal(state.plan.approved, true);
  assert.deepEqual(numbersOf(state), sequence(1, 60));
  assert.deepEqual(planCalls(ai).map(requestedRange), [[1, 20], [21, 40], [41, 60]], "no batch was asked twice");
});

test("a batch that fails is asked again on resume and nothing before it is", async () => {
  const store = new MemoryBookStore(seedBookFiles());
  const ai = createFakeAutopilotAi({ failOn: { call: 3, error: new engine.AiProviderError("The provider refused the request.", 400, false) } });
  const { session } = newSession(store, ai);
  await session.start({ brief: { idea: "x", targetChapters: 60, scenesPerChapter: 1 }, options: { ...FAST, pauseAfterPlan: true } });
  await session.waitForIdle();
  let state = stateOf(store);
  assert.equal(state.status, "error");
  assert.match(state.lastError.message, /refused/);
  assert.deepEqual(numbersOf(state), sequence(1, 20), "what was planned before the failure is kept");
  await session.start();
  await session.waitForIdle();
  state = stateOf(store);
  assert.equal(state.status, "paused", state.lastError?.message);
  assert.deepEqual(planCalls(ai).map(requestedRange), [[1, 20], [21, 40], [21, 40], [41, 60]]);
  assert.deepEqual(numbersOf(state), sequence(1, 60));
});

test("a 1500-chapter brief is planned completely, in 75 steps, and chapter 1500 is intact", async () => {
  const { ai, state, store } = await planBook(1500);
  assert.equal(state.status, "paused", state.lastError?.message);
  assert.equal(planCalls(ai).length, 75);
  assert.equal(state.plan.chapters.length, 1500);
  assert.deepEqual(numbersOf(state), sequence(1, 1500));
  const last = state.plan.chapters.at(-1);
  assert.deepEqual([last.number, last.title, last.slug, last.status], [1500, "Chapter Title 1500", "1500-chapter-title-1500", "planned"]);
  assert.equal(state.plan.chapters[999].number, 1000, "no chapter is folded onto 999");
  assert.equal(state.plan.chapters[999].slug, "1000-chapter-title-1000");
  assert.equal(state.plan.approved, true);
  assert.ok(store.files.has("chapters/1500-chapter-title-1500/chapter.md"), "the chapter file exists once the plan is approved");
  assert.match(store.files.get("autopilot/plan.md"), /## 1500 Chapter Title 1500 \(planned\)/);
  const biggest = Math.max(...ai.calls.map((call) => call.user.length));
  assert.ok(biggest < 60_000, `no prompt outgrows the outline budget: ${biggest} characters`);
  for (const call of planCalls(ai)) assert.ok(call.user.length < 45_000, `a batch prompt: ${call.user.length} characters`);
  const review = ai.calls.find((call) => call.label === "autopilot:plan-review");
  assert.ok(review.user.length < 40_000, `the plan review: ${review.user.length} characters`);
  assert.equal(state.lastError, null);
});

test("revisionBatches are normalized, and travel through state serialization", () => {
  const plan = (batches) => ({ ...planOf([plannedChapter(1)]), revisionNotes: ["Chapter 1: x"], ...(batches === undefined ? {} : { revisionBatches: batches }) });
  const state = (batches) => ({ ...createAutopilotState(new Date(0)), plan: plan(batches) });
  const reload = (value) => parseAutopilotState(JSON.stringify(value)).plan;
  assert.deepEqual(reload(state([41, 1, 21, 21, 1])).revisionBatches, [1, 21, 41], "sorted and unique");
  assert.deepEqual(reload(state(["21", 2.4, -3, 0, "x", null, {}, 41])).revisionBatches, [2, 21, 41], "positive integers only");
  assert.equal("revisionBatches" in reload(state([])), false, "an empty list is absent");
  assert.equal("revisionBatches" in reload(state(undefined)), false, "so is a missing one: today's files do not change");
  assert.equal("revisionBatches" in reload(state("nonsense")), false);
  assert.equal(reload(state([200_000, 5])).revisionBatches.at(-1), engine.MAX_BOOK_CHAPTERS);
  const saved = engine.serializeAutopilotState(state([21, 41]));
  assert.deepEqual(parseAutopilotState(saved).plan.revisionBatches, [21, 41]);
  assert.deepEqual(structuredClone(state([21, 41])).plan.revisionBatches, [21, 41]);
  assert.equal(JSON.stringify(createAutopilotState(new Date(0))).includes("revisionBatches"), false);
});

test("an author's rewrite of an unapproved plan applies to every batch again", () => {
  const base = { ...createAutopilotState(new Date(0)), plan: { ...planOf([plannedChapter(1)]), approved: false, revisionNotes: ["Chapter 5: darker."], revisionBatches: [41] } };
  const next = engine.applyIntervention(base, { scope: "rewrite", text: "Make it a thriller." }, new Date(0), "test");
  assert.deepEqual(next.plan.revisionNotes, ["Chapter 5: darker.", "Make it a thriller."]);
  assert.equal("revisionBatches" in next.plan, false, "the new note concerns the whole book");
  assert.equal(next.plan.approved, false);
});

test("raising the target of a finished 25-chapter book to 70 plans batches 20, 20 and 5 after its chapters, then reviews the plan", async () => {
  const store = new MemoryBookStore(seedBookFiles());
  const ai = createFakeAutopilotAi({ reviewVerdict: () => "approve" });
  const { session, events } = newSession(store, ai);
  await session.start({ brief: { idea: "x", targetChapters: 25, scenesPerChapter: 1, wordsPerScene: 300 }, options: FAST });
  await session.waitForIdle();
  assert.equal(stateOf(store).status, "completed");
  const before = { plan: planCalls(ai).length, concept: ai.calls.filter((call) => call.label === "autopilot:concept").length, review: ai.calls.filter((call) => call.label === "autopilot:plan-review").length };
  assert.deepEqual(before, { plan: 2, concept: 1, review: 1 }, "the 25 chapters were planned in two batches");
  const written = store.files.get("chapters/025-chapter-title-25/001-scene-1-title.md");

  const mark = ai.calls.length;
  events.length = 0;
  await session.start({ brief: { targetChapters: 70 }, options: { ...FAST, pauseAfterPlan: true } });
  await session.waitForIdle();
  const state = stateOf(store);
  assert.equal(state.status, "paused", state.lastError?.message);
  const extension = ai.calls.slice(mark);
  assert.deepEqual(extension.map((call) => call.label), ["autopilot:plan", "autopilot:plan", "autopilot:plan", "autopilot:plan-review"], "three batches, then the normal review");
  assert.deepEqual(extension.slice(0, 3).map(requestedRange), [[26, 45], [46, 65], [66, 70]]);
  assert.deepEqual(events.filter((event) => event.type === "task-started" && event.activity.task === "plan").map((event) => event.activity.title), ["Planning chapters 26-45", "Planning chapters 46-65", "Planning chapters 66-70"]);
  assert.deepEqual(numbersOf(state), sequence(1, 70));
  assert.deepEqual(state.plan.chapters.slice(0, 25).map((chapter) => [chapter.imported, chapter.status]), Array.from({ length: 25 }, () => [true, "done"]), "the written chapters are imported");
  assert.ok(state.plan.chapters.slice(25).every((chapter) => !chapter.imported && chapter.status === "planned"));
  assert.equal(state.plan.approved, true);
  assert.deepEqual([state.plan.revisionNotes, state.plan.revisionBatches, state.plan.rounds], [[], undefined, 0]);
  assert.match(extension[0].user, /CHAPTERS ALREADY WRITTEN:\n1\. Chapter Title 1 — /);
  assert.match(extension[1].user, /PLAN SO FAR[^\n]*:\n26\. Chapter Title 26\n/, "a later batch sees the first one");
  assert.equal(store.files.get("chapters/025-chapter-title-25/001-scene-1-title.md"), written, "what was written is untouched");
  assert.ok(store.files.has("chapters/070-chapter-title-70/chapter.md"));
});

test("a plan revision of a book of up to 20 chapters is still one call", async () => {
  let reviews = 0;
  const ai = scripted((request) => {
    if (request.json?.name !== "plan_review") return undefined;
    return (reviews += 1) === 1 ? reply({ verdict: "revise", score: 5, summary: "Needs work.", strengths: [], changes: [{ chapterNumber: 3, instruction: "Darker." }], guidance: [] }) : undefined;
  });
  const { state } = await planBook(12, { ai });
  assert.equal(state.status, "paused", state.lastError?.message);
  assert.deepEqual(planCalls(ai).map(requestedRange), [[1, 12], [1, 12]]);
  assert.ok(planCalls(ai)[1].user.includes("Revise the chapter plan (chapters 1-12) applying the director's changes:\n- Chapter 3: Darker."));
  assert.doesNotMatch(planCalls(ai)[1].user, /Apply only the changes|CURRENT VERSION/);
  assert.match(planCalls(ai)[1].user, /CURRENT PLAN:\n1\. Chapter Title 1\n/);
  assert.deepEqual([state.plan.revisionNotes, state.plan.revisionBatches], [[], undefined]);
});

test("a state written by an older engine, with notes pending and no batch list, revises every batch and then clears the notes", async () => {
  const state = planningState(60, 60, { plan: { rounds: 1, revisionNotes: ["Chapter 45: darker."] } });
  state.plan.chapters = state.plan.chapters.map((chapter) => ({ ...chapter, slug: engine.chapterSlug(chapter.number, chapter.title) }));
  const store = new MemoryBookStore({ ...seedBookFiles(), [STATE]: engine.serializeAutopilotState(state) });
  const holder = { store, plans: [] };
  const hooks = { afterCommit: async ({ task }) => { if (task.kind === "plan") holder.plans.push(stateOf(holder.store).plan); } };
  const ai = createFakeAutopilotAi();
  const { session } = newSession(store, ai, { hooks });
  await session.start({ options: { ...FAST, pauseAfterPlan: true } });
  await session.waitForIdle();
  const saved = stateOf(store);
  assert.equal(saved.status, "paused", saved.lastError?.message);
  assert.deepEqual(planCalls(ai).map(requestedRange), [[1, 20], [21, 40], [41, 60]]);
  assert.deepEqual(holder.plans.map((plan) => plan.revisionBatches), [[21, 41], [41], undefined], "the list is initialised by the first batch and shrinks with every one");
  assert.deepEqual(holder.plans.map((plan) => plan.revisionNotes.length), [1, 1, 0]);
  assert.equal(saved.plan.approved, true);
  assert.equal(saved.plan.rounds, 1);
});

test("a task says what comes next: another batch, or the review of the plan", () => {
  const next = (state) => engine.nextStep(state, plannerContext("en")).task.next;
  assert.equal(next(planningState(60)), "Plan the next chapters.");
  assert.equal(next(planningState(60, 20)), "Plan the next chapters.");
  assert.equal(next(planningState(60, 40)), "Simulated readers and the director review the plan.");
  assert.equal(next(planningState(12)), "Simulated readers and the director review the plan.");
  const revising = (batches) => planningState(60, 60, { plan: { revisionNotes: ["Chapter 5: x."], revisionBatches: batches } });
  assert.equal(next(revising([1, 41])), "Plan the next chapters.");
  assert.equal(next(revising([41])), "Simulated readers and the director review the plan.");
  assert.equal(engine.nextStep(planningState(60, 20), plannerContext("it")).task.next, "Pianificare i capitoli successivi.");
});

// ─── R5: a real run of 150 chapters ─────────────────────────────────────────

test("a book of 150 chapters is planned, written, closed and resumed by a real run: 8 plan calls, a lean state, quick steps", async () => {
  const store = new MemoryBookStore(seedBookFiles());
  const ai = createFakeAutopilotAi({ words: 120, scenes: 1 });
  const { session, events } = newSession(store, ai);
  const brief = { idea: "A harbor town.", targetChapters: 150, scenesPerChapter: 1, wordsPerScene: 200 };
  const options = { readers: false, specialists: false, readersOnPlan: false, pauseAfterPlan: false, pauseAfterEachChapter: false };
  const started = performance.now();
  await session.start({ brief, options: { ...options, chaptersPerRun: 75 } });
  await session.waitForIdle();
  let state = stateOf(store);
  assert.equal(state.status, "paused", state.lastError?.message);
  assert.match(state.message, /75 chapters completed in this session/);
  assert.equal(state.plan.chapters.filter((chapter) => chapter.status === "done").length, 75, "the run stopped at the chapter limit");
  assert.equal(planCalls(ai).length, 8, "the whole plan was made before the first chapter");

  await session.start({ options: { chaptersPerRun: 0 } });
  await session.waitForIdle();
  const elapsed = performance.now() - started;
  state = stateOf(store);
  assert.equal(state.status, "completed", state.lastError?.message);
  assert.equal(state.finalDone, true);
  assert.equal(state.plan.chapters.length, 150);
  assert.ok(state.plan.chapters.every((chapter, index) => chapter.number === index + 1 && chapter.status === "done" && chapter.scenes.length === 1), "every chapter is closed, once");
  assert.equal(planCalls(ai).length, 8, "no plan call was repeated by the resume");
  assert.deepEqual(planCalls(ai).map(requestedRange).slice(-2), [[121, 140], [141, 150]]);

  const steps = events.filter((event) => event.type === "task-finished" && event.activity.status === "succeeded").length;
  assert.equal(steps, state.stats.tasks, "every step is counted once");
  assert.ok(steps >= 600 && steps <= 700, `${steps} steps`);
  const stateBytes = store.files.get(STATE).length;
  assert.ok(stateBytes < 150 * 3 * 1024, `state.json is ${(stateBytes / 150 / 1024).toFixed(2)} KB per chapter`);
  assert.ok(elapsed / steps < 150, `an average step took ${(elapsed / steps).toFixed(1)} ms`);
  assert.ok(Math.max(...ai.calls.map((call) => call.user.length)) < 40_000, "no prompt grew with the book");

  const resume = engine.parseTotalResume(engine.parseMarkdown(store.files.get("resumes/total.md")).body);
  assert.equal(resume.chapters.length, 150);
  assert.match(store.files.get("plot.md"), /## Chapter 150 Chapter Title 150/);
  assert.equal((await engine.readStoredAutopilot(store)).activities.length, 200, "the activity log keeps its last 200 entries");

  const remote = new MemoryBookStore();
  const synced = await engine.syncBookStores({ local: store, remote, base: new Map() });
  assert.equal(synced.uploaded.length, store.files.size, "the whole book moves to the other side");
  assert.ok(remote.commits.length >= 2 && remote.commits.every((commit) => commit.paths.length <= 400), "in chunks");
});

// ─── Per-step cost does not grow faster than the book ───────────────────────

test("advanceState takes time proportional to the number of chapters, not its square", () => {
  const build = (count) => {
    const chapters = Array.from({ length: count }, (_, index) => {
      const number = index + 1;
      const slug = engine.chapterSlug(number, `Chapter ${number}`);
      return plannedChapter(number, { title: `Chapter ${number}`, slug, status: "done", scenes: [{ number: 1, title: "S", goal: "", beats: [], characters: [], status: "reviewed", slug: "001-s", path: `chapters/${slug}/001-s.md`, revisions: 0 }] });
    });
    const state = { ...createAutopilotState(new Date(0), { idea: "x", targetChapters: count, scenesPerChapter: 1 }, FAST), concept: { done: true, generated: false, secrets: [] }, plan: { ...planOf(chapters), approved: true, readersDone: true } };
    const files = new Map(chapters.map((chapter) => [chapter.scenes[0].path, "hash"]));
    const snapshot = {
      files,
      book: { title: "B", language: "en", description: "" },
      chapters: chapters.map((chapter) => ({ slug: chapter.slug, number: chapter.number, title: chapter.title, pov: [], path: `chapters/${chapter.slug}/chapter.md`, paragraphs: [{ chapter: chapter.slug, slug: "001-s", number: 1, title: "S", path: chapter.scenes[0].path, hash: "hash" }] })),
      canon: [],
      personaPaths: [],
      ghostwriterSlugs: [],
      hasDirector: false,
    };
    return { state, context: { ...plannerContext("en"), snapshot } };
  };
  const best = (count) => {
    const { state, context } = build(count);
    let fastest = Number.POSITIVE_INFINITY;
    for (let run = 0; run < 5; run += 1) {
      const started = performance.now();
      engine.advanceState(state, context);
      fastest = Math.min(fastest, performance.now() - started);
    }
    return fastest;
  };
  best(1000);
  const small = best(6000);
  const large = best(24_000);
  assert.ok(large < small * 10, `four times the chapters took ${(large / small).toFixed(1)} times as long (${small.toFixed(1)} ms, ${large.toFixed(1)} ms)`);
});

test("the simulated readers and the director see the plan only once every batch is planned, and the readers are not asked again after a revision", async () => {
  let reviews = 0;
  const ai = scripted((request) => {
    if (request.json?.name !== "plan_review") return undefined;
    return (reviews += 1) === 1 ? reply({ verdict: "revise", score: 5, summary: "Needs work.", strengths: [], changes: [{ chapterNumber: 30, instruction: "Darker." }], guidance: [] }) : undefined;
  });
  const { state } = await planBook(45, { ai, options: { readersOnPlan: true, maxReaders: 2 } });
  assert.equal(state.status, "paused", state.lastError?.message);
  const labels = ai.calls.map((call) => call.label.replace(/^autopilot:plan-reader:.*/, "autopilot:plan-reader"));
  assert.deepEqual(labels, [
    "autopilot:concept",
    "autopilot:plan", "autopilot:plan", "autopilot:plan",
    "autopilot:plan-reader", "autopilot:plan-reader",
    "autopilot:plan-review",
    "autopilot:plan",
    "autopilot:plan-review",
  ], "one batch again for chapter 30, then straight to the review");
  assert.deepEqual(planCalls(ai).map(requestedRange), [[1, 20], [21, 40], [41, 45], [21, 40]]);
  assert.equal(state.plan.readerReactions.length, 2);
});
