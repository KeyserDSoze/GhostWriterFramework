import test from "node:test";
import assert from "node:assert/strict";
import {
  AutopilotSession,
  askDirector,
  listDirectorOpinions,
  parseAutopilotState,
  parseMarkdown,
  readStoredAutopilot,
} from "../dist/index.js";
import { MemoryBookStore, createFakeAutopilotAi, seedBookFiles } from "../dist/testing/index.js";

function session(store, ai, extra = {}) {
  const events = [];
  const instance = new AutopilotSession({ bookId: "book-1", store, ai, host: "server", hostLabel: "test-host", retryDelayMs: 0, ...extra });
  instance.subscribe((event) => events.push(event));
  return { session: instance, events };
}

async function runToEnd(instance, options) {
  await instance.start(options);
  await instance.waitForIdle();
  return (await instance.snapshot()).state;
}

test("the autopilot writes a whole book from an idea, with readers and the director", async () => {
  const store = new MemoryBookStore(seedBookFiles());
  const ai = createFakeAutopilotAi();
  const { session: autopilot, events } = session(store, ai);

  let state = await runToEnd(autopilot, { brief: { idea: "A harbor built on glass hides a lie.", targetChapters: 2, scenesPerChapter: 2, wordsPerScene: 300 }, options: { maxReaders: 2 } });
  assert.equal(state.status, "paused", "pauses when the plan is ready");
  assert.equal(state.plan.approved, true);
  assert.equal(state.plan.awaitingAuthor, true);
  assert.equal(state.plan.readerReactions.length, 2);
  assert.ok(store.files.has("characters/mira-vale.md"));
  assert.ok(store.files.has("secrets/the-wall-is-failing.md"));
  assert.ok(store.files.has("chapters/001-chapter-title-1/chapter.md"));
  assert.match(store.files.get("secrets/the-wall-is-failing.md"), /reveal_in: chapter:002-chapter-title-2/);
  assert.match(store.files.get("story-design.md"), /Mira, a glassmaker's daughter/);
  assert.ok(store.files.has("autopilot/plan.md"));

  state = await runToEnd(autopilot);
  assert.equal(state.status, "completed");
  assert.equal(state.phase, "completed");
  assert.equal(state.finalDone, true);
  assert.deepEqual(state.plan.chapters.map((chapter) => chapter.status), ["done", "done"]);

  const scene = parseMarkdown(store.files.get("chapters/001-chapter-title-1/001-scene-1-title.md"));
  assert.equal(scene.frontmatter.type, "paragraph");
  assert.equal(scene.frontmatter.id, "paragraph:001-chapter-title-1:001-scene-1-title");
  assert.ok(scene.body.length > 200);

  const reader = parseMarkdown(store.files.get("evaluations/readers/chapters/001-chapter-title-1/standard-general.md"));
  assert.equal(reader.frontmatter.type, "readerEvaluation");
  assert.equal(reader.frontmatter.generatedBy, "autopilot");
  assert.ok(store.files.has("evaluations/readers/summaries/chapters/001-chapter-title-1.md"));
  const opinion = parseMarkdown(store.files.get("evaluations/director/chapters/001-chapter-title-1.md"));
  assert.equal(opinion.frontmatter.type, "director-opinion");
  assert.equal(opinion.frontmatter.source, "autopilot");
  assert.ok(store.files.has("evaluations/director/book.md"));
  assert.match(store.files.get("resumes/chapters/001-chapter-title-1.md"), /state_changes/);
  assert.match(store.files.get("plot.md"), /## Chapter 001 Chapter Title 1/);
  assert.match(store.files.get("chapters/001-chapter-title-1/chapter.md"), /summary: Mira confronts Orrin\./);

  const labels = ai.calls.map((call) => call.label);
  assert.ok(labels.includes("autopilot:repair:1.1"), "round 1 fixes are applied");
  assert.ok(labels.filter((label) => label === "autopilot:director-review:1").length === 2, "round 2 re-checks the chapter");
  assert.ok(events.some((event) => event.type === "insight" && /Director/.test(event.title)));
  assert.ok(events.some((event) => event.type === "task-progress"));
  const { activities } = await readStoredAutopilot(store);
  assert.ok(activities.length > 15);
  assert.ok(activities.every((activity) => activity.status === "succeeded"));
  assert.ok(state.stats.aiCalls > 15);
  assert.ok(state.stats.cost > 0);
});

test("author interventions reach the next writing step and permanent rules reach the director", async () => {
  const store = new MemoryBookStore(seedBookFiles());
  const ai = createFakeAutopilotAi();
  const { session: autopilot } = session(store, ai);
  await runToEnd(autopilot, { brief: { idea: "x", targetChapters: 1, scenesPerChapter: 1, wordsPerScene: 300 }, options: { readers: false, readersOnPlan: false } });
  await autopilot.intervene({ scope: "next_step", text: "Mira must lose her glove in the first scene." });
  await autopilot.intervene({ scope: "from_now", text: "Never use the word suddenly." });
  const state = await runToEnd(autopilot);
  assert.equal(state.status, "completed");
  const scenes = ai.calls.find((call) => call.label === "autopilot:scenes:1");
  assert.match(scenes.user, /Mira must lose her glove/);
  const write = ai.calls.find((call) => call.label === "autopilot:write:1.1");
  assert.doesNotMatch(write.user, /lose her glove/, "a next-step note is delivered once");
  assert.match(write.user, /Never use the word suddenly/);
  const director = ai.calls.find((call) => call.label === "autopilot:director-review:1");
  assert.match(director.user, /Never use the word suddenly/);
  const note = state.interventions.find((entry) => entry.text.includes("glove"));
  assert.equal(note.status, "applied");
});

test("readers never see secrets, specialists and the director do", async () => {
  const store = new MemoryBookStore(seedBookFiles());
  const ai = createFakeAutopilotAi();
  const { session: autopilot } = session(store, ai);
  await runToEnd(autopilot, { brief: { idea: "x", targetChapters: 1, scenesPerChapter: 1 }, options: { maxReaders: 1, pauseAfterPlan: false } });
  const reader = ai.calls.find((call) => call.label.startsWith("reader-evaluation:"));
  assert.doesNotMatch(reader.user, /sea wall cracked/);
  const specialists = ai.calls.find((call) => call.label === "autopilot:specialists:1");
  assert.match(specialists.user, /sea wall cracked/);
});

test("a rewrite request makes the director pick scenes, rewrites them and reviews again", async () => {
  const store = new MemoryBookStore(seedBookFiles());
  const ai = createFakeAutopilotAi({ reviewVerdict: () => "approve" });
  const { session: autopilot } = session(store, ai);
  let state = await runToEnd(autopilot, { brief: { idea: "x", targetChapters: 1, scenesPerChapter: 1, wordsPerScene: 300 }, options: { readers: false, readersOnPlan: false, pauseAfterPlan: false } });
  assert.equal(state.status, "completed");
  const before = store.files.get("chapters/001-chapter-title-1/001-scene-1-title.md");
  await autopilot.intervene({ scope: "rewrite", text: "Make Orrin kinder." });
  state = await runToEnd(autopilot);
  assert.equal(state.status, "completed");
  assert.ok(state.constraints.includes("Make Orrin kinder."));
  const labels = ai.calls.map((call) => call.label);
  assert.ok(labels.includes("autopilot:impact"));
  assert.ok(labels.includes("autopilot:revise:1.1"));
  assert.equal(labels.filter((label) => label === "autopilot:director-review:1").length, 2);
  assert.notEqual(store.files.get("chapters/001-chapter-title-1/001-scene-1-title.md"), before);
});

test("pausing after the step and stopping now both leave a resumable state", async () => {
  const store = new MemoryBookStore(seedBookFiles());
  const ai = createFakeAutopilotAi({ delayMs: 20 });
  const { session: autopilot, events } = session(store, ai);
  await autopilot.start({ brief: { idea: "x", targetChapters: 1, scenesPerChapter: 1 }, options: { readers: false, readersOnPlan: false } });
  await new Promise((resolve) => setTimeout(resolve, 5));
  assert.equal(autopilot.pause("after-step"), true);
  await autopilot.waitForIdle();
  let state = (await autopilot.snapshot()).state;
  assert.equal(state.status, "paused");
  assert.equal(state.concept.done, true, "the running step was saved");
  assert.equal(state.plan, null, "no new step started");

  await autopilot.start();
  await new Promise((resolve) => setTimeout(resolve, 5));
  autopilot.pause("now");
  await autopilot.waitForIdle();
  state = (await autopilot.snapshot()).state;
  assert.equal(state.status, "paused");
  assert.ok(events.some((event) => event.type === "task-finished" && event.activity.status === "cancelled"));
  const final = await runToEnd(autopilot, { options: { pauseAfterPlan: false } });
  assert.equal(final.status, "completed");
});

test("an author edit during a step is never overwritten: the step is repeated on the latest text", async () => {
  const store = new MemoryBookStore(seedBookFiles());
  const ai = createFakeAutopilotAi();
  let edited = false;
  store.beforeCommit = (changes) => {
    if (!edited && changes.some((change) => change.path === "story-design.md")) {
      edited = true;
      store.write("story-design.md", "---\ntype: note\n---\n\n# Story Design\n\nThe author's own design, written while the AI was working. Mira is a glassmaker who refuses to inherit her father's silence, and the harbor council will do anything to keep the failing sea wall a secret until the winter storms arrive.");
    }
  };
  const { session: autopilot, events } = session(store, ai);
  const state = await runToEnd(autopilot, { brief: { idea: "x", targetChapters: 1, scenesPerChapter: 1 }, options: { readers: false, readersOnPlan: false, pauseAfterPlan: false } });
  assert.equal(state.status, "completed");
  assert.match(store.files.get("story-design.md"), /The author's own design/, "the author's text wins");
  assert.equal(ai.calls.filter((call) => call.label === "autopilot:concept").length, 1, "the concept is not regenerated over a real design");
  assert.ok(events.some((event) => event.type === "insight" && /book changed/.test(event.title)));
});

test("an existing book is continued from its last written chapter", async () => {
  const files = seedBookFiles();
  files["chapters/001-the-arrival/chapter.md"] = "---\ntype: chapter\nid: chapter:001-the-arrival\nnumber: 1\ntitle: The Arrival\nsummary: Mira arrives.\n---\n\n# The Arrival\n";
  files["chapters/001-the-arrival/001-dawn.md"] = "---\ntype: paragraph\nid: paragraph:001-the-arrival:001-dawn\nchapter: chapter:001-the-arrival\nnumber: 1\ntitle: Dawn\n---\n\nThe author's own opening scene.";
  const store = new MemoryBookStore(files);
  const ai = createFakeAutopilotAi();
  const { session: autopilot } = session(store, ai);
  const state = await runToEnd(autopilot, { brief: { targetChapters: 2, scenesPerChapter: 1 }, options: { readers: false, readersOnPlan: false, pauseAfterPlan: false } });
  assert.equal(state.status, "completed");
  assert.ok(!ai.calls.some((call) => call.label === "autopilot:concept"), "no concept for a book with prose");
  assert.equal(state.plan.chapters[0].imported, true);
  assert.equal(state.plan.chapters[1].number, 2);
  assert.ok(store.files.has("chapters/002-chapter-title-2/001-scene-1-title.md"));
  assert.equal(store.files.get("chapters/001-the-arrival/001-dawn.md").includes("The author's own opening scene."), true);
});

test("the director answers questions on a chapter and keeps the opinion in the book", async () => {
  const store = new MemoryBookStore(seedBookFiles());
  const ai = createFakeAutopilotAi();
  const { session: autopilot } = session(store, ai);
  await runToEnd(autopilot, { brief: { idea: "x", targetChapters: 1, scenesPerChapter: 1 }, options: { readers: false, readersOnPlan: false, pauseAfterPlan: false } });
  const result = await askDirector({ store, ai, target: { kind: "chapter", chapter: "001-chapter-title-1" }, question: "Is the ending strong enough?", save: true });
  assert.equal(result.opinion.answer, "Yes, keep it.");
  assert.equal(result.path, "evaluations/director/chapters/001-chapter-title-1.md");
  const opinions = await listDirectorOpinions(store);
  const saved = opinions.find((entry) => entry.path === result.path);
  assert.equal(saved.question, "Is the ending strong enough?");
  assert.equal(saved.source, "on-demand");
  const scene = await askDirector({ store, ai, target: { kind: "paragraph", chapter: "001-chapter-title-1", paragraph: "001-scene-1-title" } });
  assert.equal(scene.saved, false);
  assert.match(ai.calls.at(-1).user, /SCENE 1: Scene 1 Title/);
});

test("a failing provider is retried once, then the autopilot stops with a readable error", async () => {
  const store = new MemoryBookStore(seedBookFiles());
  const failing = createFakeAutopilotAi({ failOn: { call: 1, error: new Error("temporary outage") } });
  const { session: autopilot, events } = session(store, failing);
  const state = await runToEnd(autopilot, { brief: { idea: "x", targetChapters: 1, scenesPerChapter: 1 }, options: { readers: false, readersOnPlan: false, pauseAfterPlan: false } });
  assert.equal(state.status, "completed");
  assert.ok(events.some((event) => event.type === "insight" && /retrying once/.test(event.title)));

  const broken = new MemoryBookStore(seedBookFiles());
  const ai = { calls: [], async complete() { throw new Error("invalid api key"); } };
  const { session: second } = session(broken, ai);
  const failed = await runToEnd(second, { brief: { idea: "x" } });
  assert.equal(failed.status, "error");
  assert.match(failed.lastError.message, /invalid api key/);
  assert.equal(failed.lastError.task, "concept");
  const stored = parseAutopilotState(broken.files.get("autopilot/state.json"));
  assert.equal(stored.status, "error");
});

test("interventions recorded while a step runs steer the next step, or restart the current one", async () => {
  const store = new MemoryBookStore(seedBookFiles());
  const ai = createFakeAutopilotAi({ delayMs: 40 });
  const { session: autopilot, events } = session(store, ai);
  await autopilot.start({ brief: { idea: "x", targetChapters: 1, scenesPerChapter: 1 }, options: { readers: false, readersOnPlan: false } });
  await new Promise((resolve) => setTimeout(resolve, 10));
  await autopilot.intervene({ scope: "next_step", text: "Open the plan with a storm." });
  await autopilot.waitForIdle();
  const concept = ai.calls.filter((call) => call.label === "autopilot:concept");
  const plan = ai.calls.find((call) => call.label === "autopilot:plan");
  assert.equal(concept.length, 1);
  assert.doesNotMatch(concept[0].user, /storm/);
  assert.match(plan.user, /Open the plan with a storm\./, "the queued note reaches the next step that accepts notes");

  const second = new MemoryBookStore(seedBookFiles());
  const slow = createFakeAutopilotAi({ delayMs: 40 });
  const { session: interrupted, events: interruptedEvents } = session(second, slow);
  await interrupted.start({ brief: { idea: "x", targetChapters: 1, scenesPerChapter: 1 }, options: { readers: false, readersOnPlan: false } });
  await new Promise((resolve) => setTimeout(resolve, 10));
  await interrupted.intervene({ scope: "from_now", text: "Everything happens in winter.", interrupt: true });
  await interrupted.waitForIdle();
  const concepts = slow.calls.filter((call) => call.label === "autopilot:concept");
  assert.equal(concepts.length, 2, "the interrupted step is repeated");
  assert.match(concepts[1].user, /Everything happens in winter\./);
  assert.ok(interruptedEvents.some((event) => event.type === "task-finished" && event.activity.status === "cancelled"));
  assert.ok(interruptedEvents.some((event) => event.type === "insight" && event.code === "interventionInterrupt"));
  assert.ok(events.some((event) => event.type === "insight" && event.code === "interventionQueued"));
});

test("a second host cannot start while another runner is active", async () => {
  const store = new MemoryBookStore(seedBookFiles());
  const first = session(store, createFakeAutopilotAi({ delayMs: 30 })).session;
  await first.start({ brief: { idea: "x" } });
  const other = new AutopilotSession({ bookId: "book-1", store, ai: createFakeAutopilotAi(), host: "browser", hostLabel: "another browser" });
  await assert.rejects(() => other.start(), /already running on test-host/);
  first.pause("now");
  await first.waitForIdle();
});

test("runners are identified by host id, and a live run of the same host blocks a second start", async () => {
  const store = new MemoryBookStore(seedBookFiles());
  const tabA = new AutopilotSession({ bookId: "book-1", store, ai: createFakeAutopilotAi({ delayMs: 40 }), host: "browser", hostLabel: "Browser · Linux", hostId: "device-a", retryDelayMs: 0 });
  await tabA.start({ brief: { idea: "x" } });
  const running = parseAutopilotState(store.files.get("autopilot/state.json"));
  assert.equal(running.runner.hostId, "device-a");

  const sameLabelOtherDevice = new AutopilotSession({ bookId: "book-1", store, ai: createFakeAutopilotAi(), host: "browser", hostLabel: "Browser · Linux", hostId: "device-b" });
  assert.equal((await sameLabelOtherDevice.snapshot()).state.status, "running", "another device's run is not mistaken for an interrupted one");
  await assert.rejects(() => sameLabelOtherDevice.start(), /already running/);

  const tabB = new AutopilotSession({ bookId: "book-1", store, ai: createFakeAutopilotAi(), host: "browser", hostLabel: "Browser · Linux", hostId: "device-a", ownRunnerAlive: () => true });
  assert.equal((await tabB.snapshot()).state.status, "running", "a run in another tab of this browser stays visible as running");
  await assert.rejects(() => tabB.start(), /already running/);

  const reloaded = new AutopilotSession({ bookId: "book-1", store, ai: createFakeAutopilotAi(), host: "browser", hostLabel: "Browser · Linux", hostId: "device-a", ownRunnerAlive: () => false });
  const interrupted = (await reloaded.snapshot()).state;
  assert.equal(interrupted.status, "paused", "without a live runner the same host sees its run as interrupted");
  assert.match(interrupted.message, /Interrupted/);

  tabA.pause("now");
  await tabA.waitForIdle();
});
