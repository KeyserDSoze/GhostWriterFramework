import test from "node:test";
import assert from "node:assert/strict";
import * as engine from "../dist/index.js";
import { MemoryBookStore, createFakeAutopilotAi, seedBookFiles } from "../dist/testing/index.js";

// New exports are read from the namespace so that, before they exist, each test fails on its own.
const { AutopilotSession, advanceState, createAutopilotState, loadBookSnapshot, parseAutopilotState, readStoredAutopilot } = engine;

const STATE = "autopilot/state.json";
const FAST = { readers: false, readersOnPlan: false, pauseAfterPlan: false, specialists: false };

function session(store, ai, extra = {}) {
  const events = [];
  const instance = new AutopilotSession({ bookId: "book-1", store, ai, host: "server", hostLabel: "test-host", hostId: "server-1", retryDelayMs: 0, ...extra });
  instance.subscribe((event) => events.push(event));
  return { session: instance, events };
}

function stateOf(store) {
  return parseAutopilotState(store.files.get(STATE));
}

const reply = (json) => ({ text: JSON.stringify(json), json, usage: { inputTokens: 100, outputTokens: 50, cachedInputTokens: 0 }, model: "fake-model", provider: "fake", cost: 0.001, currency: "USD" });

/** The fake AI, with some schemas answered by the test. */
function withReplies(base, replies) {
  return {
    calls: base.calls,
    async complete(request) {
      const custom = request.json ? replies[request.json.name]?.(request) : undefined;
      if (custom === undefined) return base.complete(request);
      base.calls.push(request);
      return reply(custom);
    },
  };
}

/** Scene plans of a different length per chapter. */
function sceneCounts(base, counts) {
  return withReplies(base, {
    scene_plan: (request) => {
      const chapter = /^autopilot:scenes:(\d+)$/.exec(request.label)?.[1];
      if (!chapter || counts[chapter] === undefined) return undefined;
      return { scenes: Array.from({ length: counts[chapter] }, (_, index) => ({ title: `Scene ${index + 1} Title`, goal: `Goal of scene ${index + 1}.`, beats: ["Arrival", "Conflict", "Turn"], pov: "Mira Vale", location: "Glass Harbor", characters: ["Mira Vale", "Orrin Hale"], summary: `Outcome of scene ${index + 1}.` })) };
    },
  });
}

async function finishedBook({ chapters = 2, ai = createFakeAutopilotAi({ reviewVerdict: () => "approve" }), start = {} } = {}) {
  const store = new MemoryBookStore(seedBookFiles({ chapters: 2 }));
  const { session: autopilot, events } = session(store, ai);
  await autopilot.start({ brief: { idea: "x", targetChapters: chapters, scenesPerChapter: 2, wordsPerScene: 300 }, options: FAST, ...start });
  await autopilot.waitForIdle();
  return { store, ai, autopilot, events };
}

/** What the author does when a chapter folder is renamed: every file moves, and the references to the folder follow. */
function moveChapter(store, from, to, edit = (path, content) => content) {
  for (const path of [...store.files.keys()].filter((entry) => entry.startsWith(`chapters/${from}/`))) {
    const content = store.files.get(path).replaceAll(from, to);
    store.write(path.replace(`chapters/${from}/`, `chapters/${to}/`), edit(path, content));
    store.write(path, null);
  }
}

const retitle = (from, to) => (path, content) => (path.endsWith("/chapter.md") ? content.replaceAll(from, to) : content);
const bookFiles = (store) => [...store.files.keys()].filter((path) => !path.startsWith("autopilot/")).sort();
const folders = (store) => [...new Set([...store.files.keys()].filter((path) => path.startsWith("chapters/")).map((path) => path.split("/")[1]))].sort();
const pauseAfter = (autopilot, taskKind) => autopilot.subscribe((event) => {
  if (event.type === "task-finished" && event.activity.task === taskKind && event.activity.status === "succeeded") autopilot.pause("after-step");
});
const mentions = (event, text) => event.type === "insight" && `${event.title} ${event.detail ?? ""}`.includes(text);

// ─── Q6: a chapter the author renamed or reordered is the same chapter ──────

test("a chapter whose folder and title the author renamed is not written again: the plan follows the files", async () => {
  const { store, ai, autopilot } = await finishedBook();
  assert.equal(stateOf(store).status, "completed");
  moveChapter(store, "001-chapter-title-1", "001-the-glass-harbor", retitle("Chapter Title 1", "The Glass Harbor"));
  const paths = bookFiles(store);
  const calls = ai.calls.length;

  await autopilot.start();
  await autopilot.waitForIdle();
  assert.equal(ai.calls.length, calls, "no AI call: nothing is written again");
  assert.deepEqual(bookFiles(store), paths, "no file was created, in a duplicated folder or anywhere else");
  assert.deepEqual(folders(store), ["001-the-glass-harbor", "002-chapter-title-2"]);
  const state = stateOf(store);
  assert.equal(state.status, "completed", state.lastError?.message);
  const [one, two] = state.plan.chapters;
  assert.equal(one.slug, "001-the-glass-harbor", "the plan has the folder's name");
  assert.equal(one.title, "The Glass Harbor", "and its title");
  assert.equal(one.status, "done", "a done chapter is not reopened");
  assert.deepEqual(one.scenes.map((scene) => scene.path), ["chapters/001-the-glass-harbor/001-scene-1-title.md", "chapters/001-the-glass-harbor/002-scene-2-title.md"], "and the real paths of its scenes");
  assert.deepEqual(one.scenes.map((scene) => scene.status), ["reviewed", "reviewed"]);
  assert.equal(two.slug, "002-chapter-title-2", "the other chapter is as it was");
  assert.equal(two.status, "done");
});

test("a chapter renamed between two sessions: the next chapter is written, the renamed one is read from its new files", async () => {
  const ai = createFakeAutopilotAi({ reviewVerdict: () => "approve" });
  const { store, autopilot } = await finishedBook({ ai, start: { options: { ...FAST, chaptersPerRun: 1 } } });
  assert.equal(stateOf(store).status, "paused");
  assert.deepEqual(stateOf(store).plan.chapters.map((chapter) => chapter.status), ["done", "planned"]);
  moveChapter(store, "001-chapter-title-1", "001-the-glass-harbor", retitle("Chapter Title 1", "The Glass Harbor"));
  const mark = ai.calls.length;

  await autopilot.start({ options: { chaptersPerRun: 0 } });
  await autopilot.waitForIdle();
  const labels = ai.calls.slice(mark).map((call) => call.label);
  assert.ok(!labels.some((label) => /:1(\.|$)/.test(label)), `chapter 1 was not touched: ${labels.join(", ")}`);
  assert.ok(labels.includes("autopilot:write:2.1"));
  assert.deepEqual(folders(store), ["001-the-glass-harbor", "002-chapter-title-2"], "no folder was created for the old name");
  const state = stateOf(store);
  assert.equal(state.status, "completed", state.lastError?.message);
  const last = ai.calls.find((call) => call.label === "autopilot:write:2.1");
  const ending = store.files.get("chapters/001-the-glass-harbor/002-scene-2-title.md").split("---\n").at(-1).trim();
  assert.ok(last.user.includes(ending.slice(-80)), "the new chapter continues from the last scene of the renamed one");
});

test("a chapter the autopilot has not written yet, renamed by the author, is written in the renamed folder", async () => {
  const ai = createFakeAutopilotAi({ reviewVerdict: () => "approve" });
  const { store, autopilot } = await finishedBook({ ai, start: { options: { ...FAST, chaptersPerRun: 1 } } });
  assert.ok(store.files.has("chapters/002-chapter-title-2/chapter.md"), "the stub of the next chapter exists");
  moveChapter(store, "002-chapter-title-2", "002-the-storm", retitle("Chapter Title 2", "The Storm"));

  await autopilot.start({ options: { chaptersPerRun: 0 } });
  await autopilot.waitForIdle();
  const state = stateOf(store);
  assert.equal(state.status, "completed", state.lastError?.message);
  assert.deepEqual(folders(store), ["001-chapter-title-1", "002-the-storm"], "the old name was not made again");
  assert.ok(store.files.has("chapters/002-the-storm/001-scene-1-title.md"), "the scenes went where the author put the chapter");
  const two = state.plan.chapters[1];
  assert.equal(two.slug, "002-the-storm");
  assert.equal(two.title, "The Storm");
  assert.equal(two.status, "done");
  assert.match(store.files.get("chapters/002-the-storm/chapter.md"), /summary: Mira confronts Orrin\./, "the closing wrote its summary in the author's folder");
});

test("a chapter renamed while its scenes are being written: the rest of the scenes go to the renamed folder", async () => {
  const ai = createFakeAutopilotAi({ reviewVerdict: () => "approve" });
  const store = new MemoryBookStore(seedBookFiles({ chapters: 2 }));
  const { session: autopilot } = session(store, ai);
  const off = autopilot.subscribe((event) => {
    if (event.type === "task-finished" && event.activity.task === "write" && event.activity.chapterNumber === 2 && event.activity.sceneNumber === 1) autopilot.pause("after-step");
  });
  await autopilot.start({ brief: { idea: "x", targetChapters: 2, scenesPerChapter: 2, wordsPerScene: 300 }, options: FAST });
  await autopilot.waitForIdle();
  off();
  assert.equal(stateOf(store).plan.chapters[1].status, "writing");
  moveChapter(store, "002-chapter-title-2", "002-the-storm", retitle("Chapter Title 2", "The Storm"));
  const mark = ai.calls.length;

  await autopilot.start();
  await autopilot.waitForIdle();
  const labels = ai.calls.slice(mark).map((call) => call.label);
  assert.ok(!labels.includes("autopilot:write:2.1"), "the scene that was written is not written again");
  assert.ok(labels.includes("autopilot:write:2.2"));
  assert.deepEqual(folders(store), ["001-chapter-title-1", "002-the-storm"]);
  assert.deepEqual([...store.files.keys()].filter((path) => path.startsWith("chapters/002-the-storm/")).sort(), ["chapters/002-the-storm/001-scene-1-title.md", "chapters/002-the-storm/002-scene-2-title.md", "chapters/002-the-storm/chapter.md"]);
  assert.equal(stateOf(store).status, "completed");
});

test("two chapters swapped by the author (their folders exchange numbers) are not written again, whatever their chapter.md say", async () => {
  for (const updateNumbers of [true, false]) {
    const { store, ai, autopilot } = await finishedBook();
    const number = (from, to) => (path, content) => (updateNumbers && path.endsWith("/chapter.md") ? content.replace(`number: ${from}\n`, `number: ${to}\n`) : content);
    moveChapter(store, "001-chapter-title-1", "002-chapter-title-1", number(1, 2));
    moveChapter(store, "002-chapter-title-2", "001-chapter-title-2", number(2, 1));
    const paths = bookFiles(store);
    const calls = ai.calls.length;

    await autopilot.start();
    await autopilot.waitForIdle();
    assert.equal(ai.calls.length, calls, `no AI call (chapter.md numbers updated: ${updateNumbers})`);
    assert.deepEqual(bookFiles(store), paths, "no file was created");
    const state = stateOf(store);
    assert.equal(state.status, "completed", state.lastError?.message);
    const [first, second] = state.plan.chapters;
    assert.equal(first.slug, "001-chapter-title-2", "the chapter that is now first");
    assert.equal(first.title, "Chapter Title 2");
    assert.equal(second.slug, "002-chapter-title-1");
    assert.equal(second.title, "Chapter Title 1");
    assert.deepEqual([first.status, second.status], ["done", "done"]);
    assert.ok(first.scenes.every((scene) => scene.path.startsWith("chapters/001-chapter-title-2/")));
    assert.ok(second.scenes.every((scene) => scene.path.startsWith("chapters/002-chapter-title-1/")));
  }
});

test("a swap of chapters with a different number of scenes does not reopen them or write into the other one's folder", async () => {
  const ai = sceneCounts(createFakeAutopilotAi({ reviewVerdict: () => "approve" }), { 1: 2, 2: 3 });
  const { store, autopilot } = await finishedBook({ ai });
  assert.deepEqual(stateOf(store).plan.chapters.map((chapter) => chapter.scenes.length), [2, 3]);
  moveChapter(store, "001-chapter-title-1", "002-chapter-title-1");
  moveChapter(store, "002-chapter-title-2", "001-chapter-title-2");
  const paths = bookFiles(store);
  const calls = ai.calls.length;

  await autopilot.start();
  await autopilot.waitForIdle();
  assert.equal(ai.calls.length, calls, "nothing was rewritten");
  assert.deepEqual(bookFiles(store), paths, "and nothing was added to either folder");
  const state = stateOf(store);
  assert.equal(state.status, "completed", state.lastError?.message);
  assert.deepEqual(state.plan.chapters.map((chapter) => chapter.status), ["done", "done"], "neither chapter was reopened");
  assert.deepEqual(state.plan.chapters.map((chapter) => chapter.scenes.length), [3, 2], "the plan has the scenes the files have");
  assert.deepEqual(state.plan.chapters[0].scenes.map((scene) => scene.path), ["chapters/001-chapter-title-2/001-scene-1-title.md", "chapters/001-chapter-title-2/002-scene-2-title.md", "chapters/001-chapter-title-2/003-scene-3-title.md"]);
});

test("a second folder with the number of a chapter is reported and never written in; the folder the plan knows is kept", async () => {
  const ai = createFakeAutopilotAi({ reviewVerdict: () => "approve" });
  const { store, autopilot, events } = await finishedBook({ ai, start: { options: { ...FAST, chaptersPerRun: 1 } } });
  const draft = {
    "chapters/002-my-draft/chapter.md": "---\ntype: chapter\nid: chapter:002-my-draft\nnumber: 2\ntitle: My Draft\n---\n\n# My Draft\n",
    "chapters/002-my-draft/001-first-try.md": "---\ntype: paragraph\nid: paragraph:002-my-draft:001-first-try\nchapter: chapter:002-my-draft\nnumber: 1\ntitle: First Try\n---\n\nThe author's own pages, which nobody else may touch.",
  };
  for (const [path, content] of Object.entries(draft)) store.write(path, content);

  await autopilot.start({ options: { chaptersPerRun: 0 } });
  await autopilot.waitForIdle();
  const state = stateOf(store);
  assert.equal(state.status, "completed", state.lastError?.message);
  assert.equal(state.plan.chapters[1].slug, "002-chapter-title-2", "the folder the plan knows");
  assert.ok(store.files.has("chapters/002-chapter-title-2/001-scene-1-title.md"), "chapter 2 was written there");
  for (const [path, content] of Object.entries(draft)) assert.equal(store.files.get(path), content, `${path} is exactly as the author left it`);
  assert.deepEqual([...store.files.keys()].filter((path) => path.startsWith("chapters/002-my-draft/")).sort(), Object.keys(draft).sort(), "nothing was added to it");
  const notices = events.filter((event) => mentions(event, "002-my-draft"));
  assert.equal(notices.length, 1, "reported once, however many steps ran");
  assert.equal(notices[0].tone, "warning");
  assert.match(`${notices[0].title} ${notices[0].detail}`, /002-chapter-title-2/, "and it says which one is used");
});

test("two folders with the number of a chapter and neither is the plan's: one is used, the same one every time, and the other is reported", async () => {
  const { store, ai, autopilot, events } = await finishedBook();
  moveChapter(store, "001-chapter-title-1", "001-draft-b");
  for (const path of [...store.files.keys()].filter((entry) => entry.startsWith("chapters/001-draft-b/"))) store.write(path.replace("001-draft-b", "001-draft-a"), store.files.get(path).replaceAll("001-draft-b", "001-draft-a"));
  const paths = bookFiles(store);
  const calls = ai.calls.length;

  await autopilot.start();
  await autopilot.waitForIdle();
  assert.equal(ai.calls.length, calls);
  assert.deepEqual(bookFiles(store), paths, "nothing was created or changed");
  const state = stateOf(store);
  assert.equal(state.status, "completed", state.lastError?.message);
  assert.equal(state.plan.chapters[0].slug, "001-draft-a", "the first by name");
  assert.equal(state.plan.chapters[0].status, "done");
  const notices = events.filter((event) => mentions(event, "001-draft-b"));
  assert.equal(notices.length, 1, "the other is reported, once");
  assert.equal(notices[0].tone, "warning");
  assert.match(`${notices[0].title} ${notices[0].detail}`, /001-draft-a/, "and the report says which one is used");
});

test("a chapter not written yet whose own folder is gone never writes into the author's pages", async () => {
  const ai = createFakeAutopilotAi({ reviewVerdict: () => "approve" });
  const { store, autopilot } = await finishedBook({ ai, start: { options: { ...FAST, chaptersPerRun: 1 } } });
  store.write("chapters/002-chapter-title-2/chapter.md", null);
  const pages = {
    "chapters/002-my-own-pages/chapter.md": "---\ntype: chapter\nid: chapter:002-my-own-pages\nnumber: 2\ntitle: My Own Pages\n---\n\n# My Own Pages\n",
    "chapters/002-my-own-pages/001-scene-1-title.md": "---\ntype: paragraph\nid: paragraph:002-my-own-pages:001-scene-1-title\nchapter: chapter:002-my-own-pages\nnumber: 1\ntitle: Scene 1 Title\n---\n\nThe author wrote this scene by hand, under the very name the autopilot gives its own.",
  };
  for (const [path, content] of Object.entries(pages)) store.write(path, content);

  await autopilot.start({ options: { chaptersPerRun: 0 } });
  await autopilot.waitForIdle();
  const state = stateOf(store);
  assert.equal(state.status, "completed", state.lastError?.message);
  for (const [path, content] of Object.entries(pages)) assert.equal(store.files.get(path), content, `${path} is exactly as the author left it`);
  assert.deepEqual([...store.files.keys()].filter((path) => path.startsWith("chapters/002-my-own-pages/")).sort(), Object.keys(pages).sort());
  assert.equal(state.plan.chapters[1].slug, "002-chapter-title-2", "chapter 2 was written in a folder of its own");
  assert.ok(store.files.has("chapters/002-chapter-title-2/001-scene-1-title.md"));
});

// ─── Q6 at the planner ──────────────────────────────────────────────────────

function chapterFolder(slug, { number, title = "Folder", scenes = 1 } = {}) {
  const files = {};
  const digits = /^\d+/.exec(slug)?.[0];
  files[`chapters/${slug}/chapter.md`] = `---\ntype: chapter\nid: chapter:${slug}\nnumber: ${number ?? Number(digits)}\ntitle: ${title}\n---\n\n# ${title}\n`;
  for (let scene = 1; scene <= scenes; scene += 1) files[`chapters/${slug}/00${scene}-s${scene}.md`] = `---\ntype: paragraph\nid: paragraph:${slug}:00${scene}-s${scene}\nchapter: chapter:${slug}\nnumber: ${scene}\ntitle: Scene ${scene}\n---\n\nProse of scene ${scene}.`;
  return files;
}

function doneChapter(number, slug, scenes = 1) {
  return {
    number,
    title: `Old ${number}`,
    slug,
    summary: "",
    goal: "",
    pov: [],
    keyEvents: [],
    reveals: [],
    status: "done",
    scenes: Array.from({ length: scenes }, (_, index) => ({ number: index + 1, title: `S${index + 1}`, goal: "", beats: [], characters: [], status: "reviewed", slug: `00${index + 1}-s${index + 1}`, path: `chapters/${slug}/00${index + 1}-s${index + 1}.md`, revisions: 0 })),
  };
}

function planState(chapters) {
  return {
    ...createAutopilotState(new Date(0), { idea: "x", targetChapters: chapters.length, scenesPerChapter: 1 }, FAST),
    concept: { done: true, generated: false, secrets: [] },
    plan: { chapters, approved: true, rounds: 0, revisionNotes: [], readerReactions: [], readersDone: true, awaitingAuthor: false },
  };
}

async function reconciled(files, chapters, report) {
  const store = new MemoryBookStore({ ...seedBookFiles({ chapters: 2 }), ...files });
  const snapshot = await loadBookSnapshot(store);
  const context = { snapshot, director: engine.defaultDirector("en"), readers: [], language: "en", storyDesignThin: false, ...(report ? { report } : {}) };
  return advanceState(planState(chapters), context);
}

test("chapters are matched by the leading digits of the folder, three or more: a folder numbered 1000 is chapter 1000, one numbered 12 is not chapter 12", async () => {
  const state = await reconciled({ ...chapterFolder("1000-the-end", { title: "The End" }), ...chapterFolder("12-intro", { number: 12, title: "Intro" }) }, [doneChapter(1000, "1000-old"), doneChapter(12, "012-old")]);
  const [thousand, twelve] = state.plan.chapters;
  assert.equal(thousand.slug, "1000-the-end", "four digits");
  assert.equal(thousand.title, "The End");
  assert.equal(thousand.status, "done");
  assert.equal(thousand.scenes[0].path, "chapters/1000-the-end/001-s1.md");
  assert.equal(twelve.slug, "012-old", "a folder that does not begin with three digits is not a chapter number");
});

test("the number is the folder's, not the chapter.md's", async () => {
  const state = await reconciled(chapterFolder("003-folder-three", { number: 7, title: "Says seven" }), [doneChapter(3, "003-old"), doneChapter(7, "007-old")]);
  assert.equal(state.plan.chapters[0].slug, "003-folder-three", "chapter 3 is the folder numbered 003, though its chapter.md says 7");
  assert.equal(state.plan.chapters[0].title, "Says seven");
  assert.equal(state.plan.chapters[1].slug, "007-old", "and chapter 7 finds no folder");
});

test("a done chapter that finds its folder keeps its status and its scenes' status; a missing scene of a folder the plan knows still reopens it, as before", async () => {
  const renamed = await reconciled(chapterFolder("001-new-name", { title: "New Name", scenes: 2 }), [doneChapter(1, "001-old-name", 2)]);
  assert.equal(renamed.plan.chapters[0].status, "done");
  assert.deepEqual(renamed.plan.chapters[0].scenes.map((scene) => scene.status), ["reviewed", "reviewed"]);

  const fewer = await reconciled(chapterFolder("001-new-name", { title: "New Name", scenes: 1 }), [doneChapter(1, "001-old-name", 3)]);
  assert.equal(fewer.plan.chapters[0].status, "done", "the folder is the chapter: the plan follows it");
  assert.deepEqual(fewer.plan.chapters[0].scenes.map((scene) => scene.number), [1]);

  const known = await reconciled(chapterFolder("001-old-name", { title: "Old 1", scenes: 1 }), [doneChapter(1, "001-old-name", 2)]);
  assert.equal(known.plan.chapters[0].status, "writing", "a scene deleted from the plan's own folder is written again, as before");
  assert.deepEqual(known.plan.chapters[0].scenes.map((scene) => scene.status), ["reviewed", "planned"]);
});

test("a chapter with no folder by number or by name is as it was: its missing scenes are written again", async () => {
  const state = await reconciled({}, [doneChapter(1, "001-gone", 2)]);
  assert.equal(state.plan.chapters[0].slug, "001-gone");
  assert.equal(state.plan.chapters[0].status, "writing");
  assert.deepEqual(state.plan.chapters[0].scenes.map((scene) => scene.status), ["planned", "planned"]);
});

test("a folder without scenes is not taken for a chapter that has been written; a folder with scenes is not taken for one that has not", async () => {
  const state = await reconciled(chapterFolder("001-stub", { title: "Stub", scenes: 0 }), [doneChapter(1, "001-old", 2)]);
  assert.equal(state.plan.chapters[0].slug, "001-old", "it is not that chapter's home");
  const planned = await reconciled(chapterFolder("001-stub", { title: "Renamed Stub", scenes: 0 }), [{ ...doneChapter(1, "001-old", 0), status: "planned" }]);
  assert.equal(planned.plan.chapters[0].slug, "001-stub", "a chapter that has nothing written takes the stub the author renamed");
  assert.equal(planned.plan.chapters[0].title, "Renamed Stub");

  const authors = await reconciled(chapterFolder("001-my-own-pages", { title: "My Own Pages", scenes: 2 }), [{ ...doneChapter(1, "001-old", 0), status: "planned" }]);
  assert.equal(authors.plan.chapters[0].slug, "001-old", "the author's own pages are never the home of a chapter the autopilot has still to write");
  assert.equal(authors.plan.chapters[0].title, "Old 1");

  const unapproved = planState([{ ...doneChapter(1, "001-old", 0), status: "planned" }]);
  unapproved.plan.approved = false;
  const store = new MemoryBookStore({ ...seedBookFiles({ chapters: 2 }), ...chapterFolder("001-stub", { title: "Not Ours", scenes: 0 }) });
  const context = { snapshot: await loadBookSnapshot(store), director: engine.defaultDirector("en"), readers: [], language: "en", storyDesignThin: false };
  assert.equal(advanceState(unapproved, context).plan.chapters[0].slug, "001-old", "before the plan is approved the autopilot has made no folder: whatever is there is not its chapter");
});

test("the planner reports what it found: the folder it follows and the folders it will not write in", async () => {
  const notes = [];
  const files = { ...chapterFolder("001-a-new-name", { title: "New Name" }), ...chapterFolder("001-copy", { title: "Copy" }), ...chapterFolder("002-kept", { title: "Kept" }), ...chapterFolder("002-kept-too", { title: "Kept too" }) };
  const state = await reconciled(files, [doneChapter(1, "001-old"), doneChapter(2, "002-kept")], (note) => notes.push(note));
  assert.equal(state.plan.chapters[0].slug, "001-a-new-name", "of two folders neither of which the plan knows, the first by name");
  assert.equal(state.plan.chapters[1].slug, "002-kept", "the known folder wins over the other with its number");
  const text = (note) => `${note.title} ${note.detail ?? ""}`;
  assert.ok(notes.some((note) => /002-kept-too/.test(text(note)) && note.tone === "warning"), JSON.stringify(notes));
  assert.ok(notes.some((note) => /001-copy/.test(text(note)) && note.tone === "warning"), "the folder that is not used is named");
  assert.ok(notes.every((note) => typeof note.key === "string" && note.key && ["info", "warning"].includes(note.tone)), "every note has a key and a tone");
  assert.equal(new Set(notes.map((note) => note.key)).size, notes.length, "each finding has its own key, so a run can say each once");
});

test("the notes are in the book's language", async () => {
  const store = new MemoryBookStore({ ...seedBookFiles({ chapters: 2 }), ...chapterFolder("001-new-name", { title: "New Name" }), ...chapterFolder("001-copy", { title: "Copy" }) });
  const notes = [];
  const context = { snapshot: await loadBookSnapshot(store), director: engine.defaultDirector("it"), readers: [], language: "it", storyDesignThin: false, report: (note) => notes.push(note) };
  advanceState(planState([doneChapter(1, "001-old")]), context);
  assert.equal(notes.length, 2);
  assert.match(notes[0].title, /^Il capitolo 1 è ora nella cartella «001-copy»$/);
  assert.match(notes[1].title, /^Due cartelle per il capitolo 1: uso «001-copy», «001-new-name» resta com'è$/);
});

test("advanceState on a plan whose folders all match does no more than before: the same state, no notes", async () => {
  const chapters = [doneChapter(1, "001-a", 2), doneChapter(2, "002-b", 2)];
  const files = { ...chapterFolder("001-a", { title: "Old 1", scenes: 2 }), ...chapterFolder("002-b", { title: "Old 2", scenes: 2 }) };
  const notes = [];
  const state = await reconciled(files, chapters, (note) => notes.push(note));
  assert.deepEqual(notes, []);
  assert.deepEqual(state.plan.chapters.map((chapter) => [chapter.slug, chapter.title, chapter.status]), [["001-a", "Old 1", "done"], ["002-b", "Old 2", "done"]]);
});

// ─── Q5: a scene the author deleted ─────────────────────────────────────────

const SCENE_ONE = "chapters/001-chapter-title-1/001-scene-1-title.md";
const twoTargets = [{ chapterNumber: 1, sceneNumber: 1, instruction: "Kinder." }, { chapterNumber: 1, sceneNumber: 2, instruction: "Kinder again." }];

async function bookWithRevisionPending(targets) {
  const base = createFakeAutopilotAi({ reviewVerdict: () => "approve" });
  const ai = withReplies(base, { revision_impact: () => ({ summary: "These scenes change.", targets }) });
  const { store, autopilot, events } = await finishedBook({ chapters: 1, ai });
  assert.equal(stateOf(store).status, "completed");
  await autopilot.intervene({ scope: "rewrite", text: "Make Orrin kinder." });
  const off = pauseAfter(autopilot, "impact");
  await autopilot.start();
  await autopilot.waitForIdle();
  off();
  const pending = stateOf(store);
  assert.deepEqual(pending.revision.targets.map((target) => target.sceneNumber), targets.map((target) => target.sceneNumber));
  assert.equal(pending.revision.cursor, 0, "the director chose the scenes; none is rewritten yet");
  return { store, ai, autopilot, events };
}

test("a rewrite whose target scene the author deleted is skipped, with a notice that names the file, and the revision goes on", async () => {
  const { store, ai, autopilot, events } = await bookWithRevisionPending(twoTargets);
  store.write(SCENE_ONE, null);
  const mark = ai.calls.length;
  const eventsBefore = events.length;

  await autopilot.start();
  await autopilot.waitForIdle();
  const state = stateOf(store);
  assert.equal(state.status, "completed", state.lastError?.message);
  assert.equal(state.lastError, null);
  assert.equal(state.revision, null, "the revision is over");
  const labels = ai.calls.slice(mark).map((call) => call.label);
  assert.ok(!labels.includes("autopilot:revise:1.1"), "nothing to rewrite there");
  assert.equal(labels.filter((label) => label === "autopilot:revise:1.2").length, 1, "the other target was rewritten");
  const notices = events.slice(eventsBefore).filter((event) => mentions(event, SCENE_ONE));
  assert.equal(notices.length, 1, "one notice that names the path");
  assert.equal(notices[0].tone, "warning");
  const { activities } = await readStoredAutopilot(store);
  assert.ok(activities.every((activity) => activity.status !== "failed"), "no step failed");
});

test("a revision whose every target was deleted ends instead of failing at every Resume", async () => {
  const { store, ai, autopilot, events } = await bookWithRevisionPending([twoTargets[0]]);
  store.write(SCENE_ONE, null);
  const mark = ai.calls.length;
  for (let attempt = 1; attempt <= 2; attempt += 1) {
    await autopilot.start();
    await autopilot.waitForIdle();
    const state = stateOf(store);
    assert.equal(state.status, "completed", `Resume ${attempt}: ${state.lastError?.message}`);
  }
  assert.ok(!ai.calls.slice(mark).some((call) => call.label.startsWith("autopilot:revise:")));
  assert.equal(stateOf(store).revision, null);
  assert.equal(events.filter((event) => mentions(event, SCENE_ONE)).length, 1, "told once");
});

test("a target that is no longer in the plan is skipped by the planner, and reported", async () => {
  const chapter = doneChapter(1, "001-a", 1);
  const state = {
    ...planState([chapter]),
    revision: { id: "r1", instruction: "Make Orrin kinder.", createdAt: "2026-01-01T00:00:00.000Z", targets: [{ chapterNumber: 9, sceneNumber: 1, instruction: "x" }, { chapterNumber: 1, sceneNumber: 5, instruction: "y" }, { chapterNumber: 1, sceneNumber: 1, instruction: "z" }], cursor: 0 },
  };
  const store = new MemoryBookStore({ ...seedBookFiles({ chapters: 2 }), ...chapterFolder("001-a", { title: "Old 1" }) });
  const notes = [];
  const context = { snapshot: await loadBookSnapshot(store), director: engine.defaultDirector("en"), readers: [], language: "en", storyDesignThin: false, report: (note) => notes.push(note) };
  const next = advanceState(state, context);
  assert.equal(next.revision.cursor, 2, "the two targets that name no scene of the plan were passed over");
  assert.equal(engine.nextStep(next, context).task.kind, "revise", "and the one that does is next");
  assert.equal(notes.length, 2);
  assert.ok(notes.some((note) => /9/.test(`${note.title} ${note.detail ?? ""}`)));
});

test("a scene that disappears between the listing and the step is skipped too: a repair is not an error", async () => {
  class Hiding extends MemoryBookStore {
    hidden = new Set();
    async read(path) {
      return this.hidden.has(path) ? null : super.read(path);
    }
  }
  const store = new Hiding(seedBookFiles({ chapters: 1 }));
  const ai = createFakeAutopilotAi();
  const { session: autopilot, events } = session(store, ai);
  autopilot.subscribe((event) => {
    if (event.type !== "task-started" || event.activity.task !== "repair") return;
    store.hidden.add(SCENE_ONE);
  });
  autopilot.subscribe((event) => {
    if (event.type === "task-finished" && event.activity.task === "repair") store.hidden.delete(SCENE_ONE);
  });
  await autopilot.start({ brief: { idea: "x", targetChapters: 1, scenesPerChapter: 2, wordsPerScene: 300 }, options: { readers: false, readersOnPlan: false, pauseAfterPlan: false } });
  await autopilot.waitForIdle();
  const state = stateOf(store);
  assert.equal(state.status, "completed", state.lastError?.message);
  assert.ok(events.some((event) => mentions(event, SCENE_ONE)), "the notice names the file");
  assert.equal(ai.calls.filter((call) => call.label === "autopilot:repair:1.1").length, 0, "no repair request was made for a scene that is not there");
});
