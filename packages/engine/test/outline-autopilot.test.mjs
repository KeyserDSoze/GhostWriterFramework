import test from "node:test";
import assert from "node:assert/strict";
import * as engine from "../dist/index.js";
import { MemoryBookStore, createFakeAutopilotAi, seedBookFiles } from "../dist/testing/index.js";

// New exports are read from the namespace so that, before they exist, each test fails on its own.
const { AutopilotSession, parseAutopilotState, parseMarkdown } = engine;

const STATE = "autopilot/state.json";
const FAST = { readers: false, readersOnPlan: false, specialists: false, pauseAfterPlan: false };
const NOIR = "---\ntype: ghostwriter\nid: ghostwriter:noir\nname: Noir Writer\nlanguage: English\ntone: NOIR-MARK hard-boiled\ntemperature: 0.6\n---\n\nShort sentences, rain and neon.\n";

const stateOf = (store) => parseAutopilotState(store.files.get(STATE));
const frontmatterOf = (store, path) => parseMarkdown(store.files.get(path)).frontmatter;
const labels = (ai) => ai.calls.map((call) => call.label);
const call = (ai, label) => ai.calls.find((entry) => entry.label === label);

function reply(json) {
  return { text: JSON.stringify(json), json, usage: { inputTokens: 100, outputTokens: 50, cachedInputTokens: 0 }, model: "fake-model", provider: "fake", cost: 0.001, currency: "USD" };
}

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

function entry({ title, body, ghostwriter, origin, digest }) {
  return ["---", "type: outline-chapter", ...(title ? [`title: ${JSON.stringify(title)}`] : []), ...(ghostwriter ? [`ghostwriter: ${ghostwriter}`] : []), ...(origin ? [`origin: ${origin}`] : []), ...(digest ? [`digest: ${digest}`] : []), "---", "", body, ""].join("\n");
}

function newSession(store, ai) {
  const events = [];
  const session = new AutopilotSession({ bookId: "book", store, ai, host: "server", hostLabel: "test", retryDelayMs: 0, now: () => new Date("2026-01-01T00:00:00.000Z") });
  session.subscribe((event) => events.push(event));
  return { session, events };
}

async function run(store, ai, start) {
  const { session, events } = newSession(store, ai);
  await session.start(start);
  await session.waitForIdle();
  return { session, events, state: stateOf(store) };
}

async function outlineOf(store) {
  const paths = (await store.list()).filter((file) => file.path.startsWith("outline/"));
  return engine.parseOutline(await Promise.all(paths.map((file) => store.read(file.path))));
}

async function editOutline(store, edit) {
  const result = engine.outlineChanges({ outline: await outlineOf(store), edit });
  await store.commit(result.changes, "the author edits the outline");
  return result;
}

const insights = (events, code) => events.filter((event) => event.type === "insight" && event.code === code);

/** The author's entries of these chapters, the way `outlineEntryFiles` writes them. */
function entriesOf(numbers) {
  return Object.fromEntries(numbers.map((number) => [engine.outlineChapterPath(number), entry({ title: `Chapter Title ${number}`, body: `Event ${number} happens and the story turns.` })]));
}

/** Entries the autopilot wrote and nobody touched since: intact, they bind nothing, and the chapters they number are the book's. */
async function autopilotEntries(numbers) {
  const files = {};
  for (const number of numbers) {
    const title = `Chapter Title ${number}`;
    const body = `Event ${number} happens and the story turns.`;
    files[engine.outlineChapterPath(number)] = `---\ntype: outline-chapter\nnumber: ${number}\ntitle: ${title}\norigin: autopilot\ndigest: ${await engine.outlineEntryDigest({ title, body })}\n---\n\n${body}\n`;
  }
  return files;
}

/** A book whose author wrote the outline before the autopilot: three chapters for a brief of two, the second with its own ghostwriter, the third with one that does not exist. */
function authoredBook() {
  return {
    ...seedBookFiles(),
    "ghostwriters/noir.md": NOIR,
    "outline/book.md": "---\ntype: outline\nid: outline:book\ntitle: Working Title\n---\n\nA harbor built on glass hides a lie. BOOK-MARK\n",
    "outline/chapters/001.md": entry({ title: "The Arrival", body: "Mira arrives at the glass harbor at night. ENTRY-MARK-1" }),
    "outline/chapters/002.md": entry({ title: "The Storm", body: "The storm cracks the sea wall and Orrin hides it. ENTRY-MARK-2", ghostwriter: "noir" }),
    "outline/chapters/003.md": entry({ body: "Mira tells the town the truth. ENTRY-MARK-3", ghostwriter: "ghost-of-nobody" }),
  };
}

// ─── E4-3: the autopilot follows the outline ────────────────────────────────

test("the plan follows the author's outline: its chapters, its order, its titles, its events, and as many chapters as it has", async () => {
  const files = authoredBook();
  const store = new MemoryBookStore(files);
  const ai = createFakeAutopilotAi();
  // No idea is sent: the description of the book is the author's own text, and a brief's idea would replace it.
  const { state, events } = await run(store, ai, { brief: { targetChapters: 2, scenesPerChapter: 1, wordsPerScene: 300 }, options: { ...FAST, pauseAfterPlan: true } });
  assert.equal(state.status, "paused", state.lastError?.message);
  const plan = call(ai, "autopilot:plan").user;
  assert.match(plan, /numbered 1 to 3/, "max(brief.targetChapters, the last chapter of the outline)");
  assert.match(plan, /Follow the author's outline/);
  assert.match(plan, /same order/);
  assert.match(plan, /BOOK-MARK/);
  for (const mark of ["ENTRY-MARK-1", "ENTRY-MARK-2", "ENTRY-MARK-3"]) assert.match(plan, new RegExp(mark));
  assert.match(call(ai, "autopilot:concept").user, /ENTRY-MARK-1/, "the concept makes the outline possible");
  assert.match(call(ai, "autopilot:plan-review").user, /outline/i, "the director does not ask to change what the outline says");
  assert.deepEqual(state.plan.chapters.map((chapter) => chapter.title), ["The Arrival", "The Storm", "Chapter Title 3"], "the outline's titles; the model's only where the entry has none");
  assert.deepEqual(state.plan.chapters.map((chapter) => chapter.ghostwriter), [undefined, "noir", undefined]);
  const digests = await Promise.all([1, 2, 3].map(async (number) => (await outlineOf(store)).chapters[number - 1].contentDigest));
  assert.deepEqual(state.plan.chapters.map((chapter) => chapter.outlineDigest), digests, "the plan remembers the entry it followed");
  const missing = insights(events, "outlineGhostwriter");
  assert.equal(missing.length, 1);
  assert.deepEqual([missing[0].chapterNumber, missing[0].ghostwriter, missing[0].tone], [3, "ghost-of-nobody", "warning"]);
  assert.equal(frontmatterOf(store, "chapters/002-the-storm/chapter.md").ghostwriter, "noir", "the chapter is created with its ghostwriter");
  assert.equal("ghostwriter" in frontmatterOf(store, "chapters/001-the-arrival/chapter.md"), false, "the book's ghostwriter is not repeated");
  assert.equal("ghostwriter" in frontmatterOf(store, "chapters/003-chapter-title-3/chapter.md"), false, "a ghostwriter that does not exist is not written: the book's writes");
  for (const path of ["outline/book.md", "outline/chapters/001.md", "outline/chapters/002.md", "outline/chapters/003.md"]) assert.equal(store.files.get(path), files[path], `${path} is the author's: never touched`);

  const done = await run(store, ai, { options: { ...FAST } });
  assert.equal(done.state.status, "completed", done.state.lastError?.message);
  const second = call(ai, "autopilot:write:2.1");
  assert.match(second.user, /Ghostwriter persona: Noir Writer\./, "the chapter's ghostwriter writes it");
  assert.equal(second.temperature, 0.6);
  assert.match(call(ai, "autopilot:write:1.1").user, /Ghostwriter persona: Default Ghostwriter\./);
  assert.match(call(ai, "autopilot:write:3.1").user, /Ghostwriter persona: Default Ghostwriter\./);
});

test("the synopsis of the brief is the fallback: alone it binds as ever, next to an outline the outline wins", async () => {
  const synopsis = "1. Mira arrives. 2. The storm.";
  const alone = createFakeAutopilotAi();
  await run(new MemoryBookStore({ ...seedBookFiles({ chapters: 2 }), ...(await autopilotEntries([1, 2])) }), alone, { brief: { idea: "x", synopsis, targetChapters: 2, scenesPerChapter: 1 }, options: { ...FAST, pauseAfterPlan: true } });
  assert.match(call(alone, "autopilot:plan").user, /Follow the author's chapter-by-chapter synopsis exactly: same chapters, same order, same events\. Enrich, never change\./);
  assert.doesNotMatch(call(alone, "autopilot:plan").user, /AUTHOR'S OUTLINE/);

  const both = createFakeAutopilotAi();
  await run(new MemoryBookStore(authoredBook()), both, { brief: { idea: "x", synopsis, targetChapters: 2, scenesPerChapter: 1 }, options: { ...FAST, pauseAfterPlan: true } });
  const plan = call(both, "autopilot:plan").user;
  assert.match(plan, /Follow the author's outline/);
  assert.match(plan, /the outline wins/);
  assert.match(plan, /1\. Mira arrives\. 2\. The storm\./, "the synopsis is still there, as the fallback");
  assert.doesNotMatch(plan, /Follow the author's chapter-by-chapter synopsis exactly/);
});

test("the outline of a long book reaches every batch around the chapters it plans, and no prompt grows with it", async () => {
  const files = seedBookFiles({ chapters: 12 });
  for (let number = 1; number <= 120; number += 1) files[engine.outlineChapterPath(number)] = entry({ title: `Outline ${number}`, body: `What happens in chapter ${number}. MARK-${number}-END ${"The tide keeps rising. ".repeat(30)}` });
  const store = new MemoryBookStore(files);
  const ai = createFakeAutopilotAi();
  const { state } = await run(store, ai, { brief: { idea: "x", targetChapters: 12, scenesPerChapter: 1 }, options: { ...FAST, pauseAfterPlan: true } });
  assert.equal(state.status, "paused", state.lastError?.message);
  assert.equal(state.plan.chapters.length, 120);
  const plans = ai.calls.filter((entry) => entry.label === "autopilot:plan");
  assert.equal(plans.length, 6);
  plans.forEach((plan, index) => {
    const from = index * 20 + 1;
    for (let number = from; number < from + 20; number += 1) assert.ok(plan.user.includes(`MARK-${number}-END`), `batch ${from}: the entry of chapter ${number} is there in full`);
    assert.ok(plan.user.length < 70_000, `batch ${from}: ${plan.user.length} characters`);
  });
  assert.deepEqual(state.plan.chapters.slice(0, 3).map((chapter) => chapter.title), ["Outline 1", "Outline 2", "Outline 3"]);
});

test("a ghostwriter the outline named before it existed writes the chapter once the author creates it", async () => {
  const files = authoredBook();
  delete files["ghostwriters/noir.md"];
  const store = new MemoryBookStore(files);
  const ai = createFakeAutopilotAi();
  const planned = await run(store, ai, { brief: { idea: "x", targetChapters: 2, scenesPerChapter: 1, wordsPerScene: 300 }, options: { ...FAST, pauseAfterPlan: true } });
  assert.equal(planned.state.plan.chapters[1].ghostwriter, undefined, "it does not exist yet: the book's");
  assert.deepEqual(insights(planned.events, "outlineGhostwriter").map((event) => [event.chapterNumber, event.ghostwriter]), [[2, "noir"], [3, "ghost-of-nobody"]]);
  store.write("ghostwriters/noir.md", NOIR);
  const done = await run(store, ai, { options: { ...FAST } });
  assert.equal(done.state.status, "completed", done.state.lastError?.message);
  assert.equal(done.state.plan.chapters[1].ghostwriter, "noir");
  assert.equal(frontmatterOf(store, "chapters/002-the-storm/chapter.md").ghostwriter, "noir");
  assert.match(call(ai, "autopilot:write:2.1").user, /Ghostwriter persona: Noir Writer\./);
  assert.ok(!labels(ai).some((label) => label.startsWith("autopilot:replan")), "the plan of the chapter is not made again for it");
});

// ─── E4-4: the plan fills the outline ───────────────────────────────────────

test("the plan fills the chapter the outline leaves without an entry, in the same commit, and the book's description, as the autopilot's", async () => {
  const files = { ...seedBookFiles(), ...entriesOf([1, 3]) };
  const store = new MemoryBookStore(files);
  const ai = createFakeAutopilotAi();
  const { state } = await run(store, ai, { brief: { targetChapters: 3, scenesPerChapter: 1 }, options: { ...FAST, pauseAfterPlan: true } });
  assert.equal(state.status, "paused", state.lastError?.message);
  const outline = await outlineOf(store);
  assert.deepEqual(outline.chapters.map((item) => [item.number, item.title, item.origin, item.intact]), [[1, "Chapter Title 1", "author", false], [2, "Chapter Title 2", "autopilot", true], [3, "Chapter Title 3", "author", false]]);
  assert.equal(outline.chapters[1].body, "Summary of chapter 2.\n\n- Event 2", "the summary of the plan, then its key events as a list");
  assert.deepEqual(state.plan.chapters.map((chapter) => chapter.outlineDigest), outline.chapters.map((item) => item.contentDigest));
  assert.equal(outline.book.origin, "autopilot");
  assert.equal(outline.book.intact, true);
  assert.match(outline.book.body, /glassmaker's daughter/, "the logline of the concept");
  const commit = store.commits.find((entry) => entry.message.startsWith("Autopilot: Planning"));
  assert.ok(["outline/book.md", "outline/chapters/002.md", "autopilot/state.json"].every((path) => commit.paths.includes(path)), "one commit for the plan and its outline");
  assert.deepEqual(outline.warnings, []);
  // The entry it wrote is a series of the journal of the Synopsis, by the autopilot, in the same commit.
  assert.ok(commit.paths.includes(engine.OUTLINE_CHANGES_FILE), "the journal in the commit of the plan");
  const journal = engine.parseOutlineJournal(store.files.get(engine.OUTLINE_CHANGES_FILE));
  assert.deepEqual(journal.series.map((series) => [series.by, series.at, series.chapters.map((item) => [item.chapter, item.change, item.title, item.after])]), [["autopilot", "2026-01-01T00:00:00.000Z", [[2, "created", "Chapter Title 2", outline.chapters[1].contentDigest]]]]);
});

test("the option fillOutline is on by default, saved, and off leaves the outline alone", async () => {
  assert.equal(engine.DEFAULT_OPTIONS.fillOutline, true);
  assert.equal(engine.normalizeOptions({}).fillOutline, true);
  assert.equal(engine.normalizeOptions({ fillOutline: false }).fillOutline, false);
  assert.equal(engine.normalizeOptions({ fillOutline: "nonsense" }, { ...engine.DEFAULT_OPTIONS, fillOutline: false }).fillOutline, false, "a value nobody knows changes nothing");
  assert.equal(engine.parseAutopilotState(JSON.stringify({ options: { fillOutline: false } })).options.fillOutline, false);
  const files = { ...seedBookFiles(), ...entriesOf([1, 3]) };
  const store = new MemoryBookStore(files);
  const { state } = await run(store, createFakeAutopilotAi(), { brief: { targetChapters: 2, scenesPerChapter: 1 }, options: { ...FAST, pauseAfterPlan: true, fillOutline: false } });
  assert.equal(state.options.fillOutline, false);
  assert.deepEqual([...store.files.keys()].filter((path) => path.startsWith("outline/") && path !== engine.OUTLINE_BRIEF_FILE).sort(), Object.keys(files).filter((path) => path.startsWith("outline/")).sort(), "nothing written in outline/ but the brief the run was given");
});

test("the plan never touches the author's entries, rewrites its own untouched ones, and leaves its own once the author changed them", async () => {
  const two = await engine.outlineEntryDigest({ title: "Old two", body: "Written by an earlier plan." });
  const three = await engine.outlineEntryDigest({ title: "Old three", body: "Written by an earlier plan." });
  const four = await engine.outlineEntryDigest({ title: "Old four", body: "Written by an earlier plan." });
  const files = {
    ...seedBookFiles({ chapters: 4 }),
    "outline/chapters/001.md": entry({ title: "The Arrival", body: "The author's chapter one. AUTHOR-1" }),
    "outline/chapters/002.md": entry({ title: "Old two", body: "Written by an earlier plan.", origin: "autopilot", digest: two }),
    "outline/chapters/003.md": entry({ title: "Old three", body: "Written by an earlier plan, then corrected by the author.", origin: "autopilot", digest: three }),
    "outline/chapters/004.md": entry({ title: "Old four", body: "Written by an earlier plan.", origin: "autopilot", digest: four }),
  };
  let planCalls = 0;
  let reviews = 0;
  const ai = scripted((request) => {
    if (request.json?.name === "plan_review") return (reviews += 1) === 1 ? reply({ verdict: "revise", score: 5, summary: "Chapter 2 is weak.", strengths: [], changes: [{ chapterNumber: 2, instruction: "Make it darker." }], guidance: [] }) : undefined;
    if (request.json?.name !== "chapter_plan") return undefined;
    planCalls += 1;
    return reply({ chapters: [1, 2, 3, 4].map((number) => ({ number, title: `Plan ${number} v${planCalls}`, summary: `Version ${planCalls} of chapter ${number}.`, goal: "Goal.", pov: [], keyEvents: [`Event ${number}`], reveals: [] })) });
  });
  const store = new MemoryBookStore(files);
  const { state } = await run(store, ai, { brief: { idea: "x", targetChapters: 4, scenesPerChapter: 1 }, options: { ...FAST, pauseAfterPlan: true } });
  assert.equal(state.status, "paused", state.lastError?.message);
  assert.equal(planCalls, 2, "the director had the plan revised once");
  const plan = ai.calls.filter((entry) => entry.label === "autopilot:plan");
  assert.match(plan[0].user, /AUTHOR-1/);
  assert.match(plan[0].user, /corrected by the author/, "the entry the author changed binds");
  assert.doesNotMatch(plan[0].user, /Old two/, "the autopilot's own entry does not bind");
  const outline = await outlineOf(store);
  assert.equal(store.files.get("outline/chapters/001.md"), files["outline/chapters/001.md"]);
  assert.equal(store.files.get("outline/chapters/003.md"), files["outline/chapters/003.md"]);
  assert.deepEqual([outline.chapters[1].title, outline.chapters[1].body, outline.chapters[1].intact], ["Plan 2 v2", "Version 2 of chapter 2.\n\n- Event 2", true], "the autopilot's entry follows the revision of the plan");
  assert.deepEqual([outline.chapters[3].title, outline.chapters[3].origin], ["Plan 4 v2", "autopilot"]);
  assert.deepEqual(state.plan.chapters.map((chapter) => chapter.title), ["The Arrival", "Plan 2 v2", "Old three", "Plan 4 v2"]);
  assert.deepEqual(state.plan.chapters.map((chapter) => chapter.outlineDigest), outline.chapters.map((item) => item.contentDigest));
});

test("the chapters the author wrote get an entry only when they have none, with their summary", async () => {
  const files = { ...seedBookFiles(), ...entriesOf([1, 3]) };
  files["chapters/001-the-arrival/chapter.md"] = "---\ntype: chapter\nid: chapter:001-the-arrival\nnumber: 1\ntitle: The Arrival\nsummary: Mira arrives.\n---\n\n# The Arrival\n";
  files["chapters/001-the-arrival/001-dawn.md"] = "---\ntype: paragraph\nid: paragraph:001-the-arrival:001-dawn\nchapter: chapter:001-the-arrival\nnumber: 1\ntitle: Dawn\n---\n\nThe author's opening scene, long enough to be a scene of its own.";
  files["chapters/002-the-storm/001-wind.md"] = "---\ntype: paragraph\nid: paragraph:002-the-storm:001-wind\nchapter: chapter:002-the-storm\nnumber: 1\ntitle: Wind\n---\n\nThe author's second chapter, a storm over the harbor.";
  files["outline/chapters/001.md"] = entry({ title: "Arrival", body: "The author's own entry. AUTHOR-ENTRY" });
  const store = new MemoryBookStore(files);
  const { state } = await run(store, createFakeAutopilotAi(), { brief: { targetChapters: 3, scenesPerChapter: 1 }, options: { ...FAST, pauseAfterPlan: true } });
  assert.equal(state.status, "paused", state.lastError?.message);
  const outline = await outlineOf(store);
  assert.equal(store.files.get("outline/chapters/001.md"), files["outline/chapters/001.md"]);
  assert.deepEqual([outline.chapters[1].title, outline.chapters[1].body, outline.chapters[1].origin, outline.chapters[1].intact], ["The Storm", "Summary of imported chapter 2.", "autopilot", true]);
  assert.equal(outline.chapters[2].title, "Chapter Title 3");
  assert.deepEqual(state.plan.chapters.map((chapter) => chapter.outlineDigest), outline.chapters.map((item) => item.contentDigest), "the chapters the author wrote remember their entry too");
});

// ─── E4-5: the author changes the outline of a chapter not written yet ─────

async function plannedBook(chapters = 3, extra = {}) {
  const store = new MemoryBookStore({ ...seedBookFiles(), ...(await autopilotEntries(Array.from({ length: chapters }, (_, index) => index + 1))), "ghostwriters/noir.md": NOIR });
  const ai = createFakeAutopilotAi();
  const { state } = await run(store, ai, { brief: { idea: "x", targetChapters: chapters, scenesPerChapter: 1, wordsPerScene: 300 }, options: { ...FAST, pauseAfterPlan: true, ...extra } });
  assert.equal(state.status, "paused", state.lastError?.message);
  return { store, ai };
}

test("an entry the author changed is planned again before its chapter is written, and no other chapter is", async () => {
  const { store, ai } = await plannedBook();
  await editOutline(store, { kind: "update", number: 2, entry: { title: "The Flood", body: "A flood takes the harbor. NEW-ENTRY-MARK", ghostwriter: "noir" } });
  const mark = ai.calls.length;
  const { state, events } = await run(store, ai, { options: { ...FAST } });
  assert.equal(state.status, "completed", state.lastError?.message);
  const after = labels(ai).slice(mark);
  assert.ok(after.indexOf("autopilot:replan:2") >= 0 && after.indexOf("autopilot:replan:2") < after.indexOf("autopilot:scenes:2"), after.join(", "));
  assert.equal(after.filter((label) => label.startsWith("autopilot:replan")).length, 1, "only the chapter that changed");
  assert.ok(!after.includes("autopilot:plan"), "the rest of the plan is not made again");
  assert.match(call(ai, "autopilot:replan:2").user, /NEW-ENTRY-MARK/);
  const changed = insights(events, "outlineChanged");
  assert.deepEqual(changed.map((event) => event.chapterNumber), [2]);
  assert.match(changed[0].title, /chapter 2/);
  const chapter = state.plan.chapters[1];
  assert.deepEqual([chapter.number, chapter.title, chapter.ghostwriter, chapter.status], [2, "The Flood", "noir", "done"]);
  assert.equal(chapter.outlineDigest, (await outlineOf(store)).chapters[1].contentDigest);
  assert.ok(!store.files.has("chapters/002-chapter-title-2/chapter.md"), "the empty folder of the old plan is gone");
  assert.equal(frontmatterOf(store, "chapters/002-the-flood/chapter.md").ghostwriter, "noir");
  assert.match(call(ai, "autopilot:write:2.1").user, /Ghostwriter persona: Noir Writer\./);
  assert.deepEqual(state.plan.chapters.map((item) => item.title), ["Chapter Title 1", "The Flood", "Chapter Title 3"]);
});

test("an entry the author deleted takes its unwritten chapter out of the plan, and the next chapters keep their numbers", async () => {
  const { store, ai } = await plannedBook();
  await editOutline(store, { kind: "remove", number: 2 });
  const mark = ai.calls.length;
  const { state, events } = await run(store, ai, { options: { ...FAST } });
  assert.equal(state.status, "completed", state.lastError?.message);
  assert.deepEqual(state.plan.chapters.map((chapter) => [chapter.number, chapter.status]), [[1, "done"], [3, "done"]]);
  assert.ok(!labels(ai).slice(mark).some((label) => /^autopilot:(?:plan|scenes:2|write:2)/.test(label)), "no chapter 2, and nothing planned to replace it");
  assert.ok(!store.files.has("chapters/002-chapter-title-2/chapter.md"), "its empty folder leaves the book");
  assert.ok(store.files.has("chapters/003-chapter-title-3/001-scene-1-title.md"));
  const removed = insights(events, "outlineRemoved");
  assert.deepEqual(removed.map((event) => event.chapterNumber), [2]);
  assert.match(removed[0].detail ?? removed[0].title, /number/);
});

test("a plan saved by an engine that did not know the outline does not plan its chapters again from the entries the autopilot wrote", async () => {
  const { store, ai } = await plannedBook();
  const state = stateOf(store);
  for (const chapter of state.plan.chapters) delete chapter.outlineDigest;
  store.write(STATE, engine.serializeAutopilotState(state));
  const mark = ai.calls.length;
  const { state: done } = await run(store, ai, { options: { ...FAST } });
  assert.equal(done.status, "completed", done.lastError?.message);
  assert.ok(!labels(ai).slice(mark).some((label) => label.startsWith("autopilot:replan")), labels(ai).slice(mark).join(", "));
  await editOutline(store, { kind: "update", number: 3, entry: { body: "Changed by the author after all." } });
  const notices = await run(store, ai, { options: { ...FAST } });
  for (const code of ["outlineWrittenChanged", "outlineChangedWhileWriting", "outlineRemovedWritten"]) {
    assert.deepEqual(insights(notices.events, code).map((event) => event.chapterNumber), [], `a chapter that does not remember its entry is not said to have changed (${code})`);
  }
});

test("deleting the whole outline takes no chapter out of the plan", async () => {
  const { store, ai } = await plannedBook();
  for (const path of [...store.files.keys()].filter((name) => name.startsWith("outline/"))) store.write(path, null);
  const { state, events } = await run(store, ai, { options: { ...FAST } });
  assert.equal(state.status, "completed", state.lastError?.message);
  assert.deepEqual(state.plan.chapters.map((chapter) => chapter.number), [1, 2, 3]);
  assert.equal(insights(events, "outlineRemoved").length, 0);
});

test("the outline of a chapter already written that changed is said once, and the chapter is left as it is", async () => {
  const { store, ai } = await plannedBook(3, {});
  const first = await run(store, ai, { options: { ...FAST, chaptersPerRun: 1 } });
  assert.equal(first.state.plan.chapters[0].status, "done");
  const written = store.files.get("chapters/001-chapter-title-1/001-scene-1-title.md");
  await editOutline(store, { kind: "update", number: 1, entry: { body: "The author now wants a different opening." } });
  const mark = ai.calls.length;
  // Only said (E4b: with `frozenEdits: "notify"`; the default asks the author what to do, see frozen-autopilot.test.mjs).
  const { state, events } = await run(store, ai, { options: { ...FAST, chaptersPerRun: 0, frozenEdits: "notify" } });
  assert.equal(state.status, "completed", state.lastError?.message);
  const notices = insights(events, "outlineWrittenChanged");
  assert.deepEqual(notices.map((event) => event.chapterNumber), [1], "once, for the whole run");
  assert.ok(!labels(ai).slice(mark).some((label) => /replan:1|scenes:1|write:1\./.test(label)), "the written chapter is not planned or written again");
  assert.equal(store.files.get("chapters/001-chapter-title-1/001-scene-1-title.md"), written);
});

test("an entry that changes while its chapter is being written has a code of its own; once the chapter is closed, the notice of a written chapter has its own", async () => {
  const store = new MemoryBookStore(seedBookFiles({ chapters: 1 }));
  const ai = createFakeAutopilotAi({ reviewVerdict: () => "approve" });
  const { session, events } = newSession(store, ai);
  let paused = false;
  session.subscribe((event) => {
    if (paused || event.type !== "task-finished" || event.activity.task !== "write" || event.activity.sceneNumber !== 1) return;
    paused = true;
    session.pause("after-step");
  });
  await session.start({ brief: { idea: "x", targetChapters: 1, scenesPerChapter: 2, wordsPerScene: 300 }, options: { ...FAST, frozenEdits: "notify" } });
  await session.waitForIdle();
  assert.equal(stateOf(store).plan.chapters[0].status, "writing", "(the first scene is written, the second is not)");
  await editOutline(store, { kind: "update", number: 1, entry: { body: "The author changes the chapter while it is being written." } });
  await session.start();
  await session.waitForIdle();
  assert.equal(stateOf(store).status, "completed", stateOf(store).lastError?.message);
  assert.deepEqual(insights(events, "outlineChangedWhileWriting").map((event) => event.chapterNumber), [1], "said while the chapter is written");
  assert.match(insights(events, "outlineChangedWhileWriting")[0].title, /being written/);
  assert.deepEqual(insights(events, "outlineWrittenChanged").map((event) => event.chapterNumber), [1], "and, once it is closed, as the notice of a written chapter");
  assert.deepEqual(insights(events, "outlineRemovedWritten"), []);
});

test("an entry the author adds after the last chapter extends a finished book, following the entry", async () => {
  const store = new MemoryBookStore(seedBookFiles({ chapters: 2 }));
  const ai = createFakeAutopilotAi();
  const first = await run(store, ai, { brief: { idea: "x", targetChapters: 2, scenesPerChapter: 1 }, options: { ...FAST } });
  assert.equal(first.state.status, "completed", first.state.lastError?.message);
  await editOutline(store, { kind: "append", entry: { title: "The Return", body: "Mira comes back years later. APPENDED-MARK" } });
  const mark = ai.calls.length;
  const { state } = await run(store, ai, { options: { ...FAST } });
  assert.equal(state.status, "completed", state.lastError?.message);
  assert.deepEqual(state.plan.chapters.map((chapter) => [chapter.number, chapter.title]), [[1, "Chapter Title 1"], [2, "Chapter Title 2"], [3, "The Return"]]);
  const extension = ai.calls.slice(mark).find((entry) => entry.label === "autopilot:plan");
  assert.match(extension.user, /APPENDED-MARK/);
});

// ─── The planner, without AI ────────────────────────────────────────────────

test("the planner counts the chapters of the outline, and plans again a chapter whose entry changed before its scenes", () => {
  const snapshot = { files: new Map(), book: { title: "B", language: "en", description: "" }, chapters: [], canon: [], personaPaths: [], ghostwriterSlugs: [], hasDirector: false };
  const context = { snapshot, director: engine.defaultDirector("en"), readers: [], language: "en", storyDesignThin: false };
  const state = engine.createAutopilotState(new Date(0), { idea: "x" }, FAST);
  state.concept = { done: true, generated: false, secrets: [] };
  assert.equal(engine.nextStep(state, context).kind, "stop", "no chapter in the outline: nothing to plan");
  assert.equal(engine.nextStep(state, { ...context, outline: { lastChapter: 3 } }).task.title, "Planning 3 chapters");
  assert.equal(engine.nextStep(state, { ...context, outline: { lastChapter: 5 } }).task.title, "Planning 5 chapters");
  assert.equal(engine.bookChapters({ lastChapter: 5 }), 5);
  assert.equal(engine.bookChapters(null), 0);
  const chapter = (number) => ({ number, title: `T${number}`, slug: engine.chapterSlug(number, `T${number}`), summary: "", goal: "", pov: [], keyEvents: [], reveals: [], status: "planned", scenes: [] });
  state.plan = { chapters: [chapter(1), chapter(2)], approved: true, rounds: 0, revisionNotes: [], readerReactions: [], readersDone: true, awaitingAuthor: false };
  assert.equal(engine.nextStep(state, context).task.kind, "scenes");
  const replan = engine.nextStep(state, { ...context, outline: { lastChapter: 0, changed: new Map([[1, "changed"]]) } }).task;
  assert.deepEqual([replan.kind, replan.chapterNumber, replan.phase, replan.acceptsNotes], ["replan", 1, "write", true]);
  assert.match(replan.title, /chapter 1/);
  assert.equal(engine.describeTask("replan", "it", { chapter: chapter(4) }).title.includes("capitolo 4"), true);
});
