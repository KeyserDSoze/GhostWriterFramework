import test from "node:test";
import assert from "node:assert/strict";
import * as engine from "../dist/index.js";
import { MemoryBookStore, createFakeAutopilotAi, seedBookFiles } from "../dist/testing/index.js";

// New exports are read from the namespace so that, before they exist, each test fails on its own.
const { AiProviderError, AutopilotSession, normalizeRunLimits, parseAutopilotState, readStoredAutopilot } = engine;

const STATE = "autopilot/state.json";
const ACTIVITY = "autopilot/activity.json";
const FAST = { readers: false, readersOnPlan: false, specialists: false, pauseAfterPlan: false };
const THREE = { brief: { idea: "x", targetChapters: 3, scenesPerChapter: 1, wordsPerScene: 300 }, options: FAST };
const ONE = { brief: { idea: "x", targetChapters: 1, scenesPerChapter: 1, wordsPerScene: 300 }, options: FAST };

/** Chapters of one scene each: concept, plan, review of the plan, then scenes, write, director-review and consolidate for every chapter, and the final review. */
const fakeAi = (extra = {}) => createFakeAutopilotAi({ chapters: 3, scenes: 1, reviewVerdict: () => "approve", ...extra });

function session(store, ai, extra = {}) {
  const events = [];
  const instance = new AutopilotSession({ bookId: "book-1", store, ai, host: "server", hostLabel: "test-host", hostId: "server-1", retryDelayMs: 0, ...extra });
  instance.subscribe((event) => events.push(event));
  return { session: instance, events };
}

const stateOf = (store) => parseAutopilotState(store.files.get(STATE));
const labelsOf = (ai) => ai.calls.map((call) => call.label);
const runEnded = (events) => events.filter((event) => event.type === "run-ended");
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/** The steps that were saved: every step is one commit that also writes the activity log (the commits that record a step that failed or was abandoned are not steps). */
const stepCommits = (store) => store.commits.filter((commit) => commit.paths.includes(ACTIVITY) && !/\((failed|cancelled)\)$/.test(commit.message));

/** Runs `action` once, as soon as the event `match` recognises is emitted. */
function when(autopilot, match, action) {
  let done = false;
  autopilot.subscribe((event) => {
    if (done || !match(event)) return;
    done = true;
    action(event);
  });
}

const started = (task, chapter) => (event) => event.type === "task-started" && event.activity.task === task && (chapter === undefined || event.activity.chapterNumber === chapter);

async function run(autopilot, start) {
  await autopilot.start(start);
  await autopilot.waitForIdle();
}

// ─── Q2: the limits of one run ──────────────────────────────────────────────

test("a run of one step, repeated three times, makes exactly three steps and three commits", async () => {
  const store = new MemoryBookStore(seedBookFiles());
  const ai = fakeAi();
  const { session: autopilot, events } = session(store, ai);
  const limit = { limits: { steps: 1 } };

  await run(autopilot, { ...THREE, ...limit });
  assert.equal(stepCommits(store).length, 1, "one step, one commit");
  assert.deepEqual(labelsOf(ai), ["autopilot:concept"]);
  assert.equal(stateOf(store).status, "paused");
  assert.equal(stateOf(store).stats.tasks, 1);

  await run(autopilot, limit);
  await run(autopilot, limit);
  assert.equal(stepCommits(store).length, 3);
  assert.equal(stateOf(store).stats.tasks, 3);
  assert.deepEqual(labelsOf(ai), ["autopilot:concept", "autopilot:plan", "autopilot:plan-review"], "a step of the plan and a step of the review count like any other, and none is repeated");
  const state = stateOf(store);
  assert.equal(state.status, "paused");
  assert.equal(state.message, "Step done as requested: paused.");
  const ended = runEnded(events);
  assert.deepEqual(ended.map((event) => [event.status, event.code]), [["paused", "stepLimit"], ["paused", "stepLimit"], ["paused", "stepLimit"]], "every run says why it stopped, in a way a client can translate");
  assert.equal(ended[0].message, "Step done as requested: paused.");
});

test("the message of the limit is in the language of the book, and says how many steps for more than one", async () => {
  const store = new MemoryBookStore(seedBookFiles({ language: "it" }));
  const { session: autopilot } = session(store, fakeAi());
  await run(autopilot, { ...THREE, limits: { steps: 1 } });
  assert.equal(stateOf(store).message, "Passo eseguito come richiesto: in pausa.");
  await run(autopilot, { limits: { steps: 2 } });
  assert.equal(stateOf(store).message, "2 passi eseguiti come richiesto: in pausa.");
  assert.equal(stateOf(store).stats.tasks, 3);

  const english = new MemoryBookStore(seedBookFiles());
  const { session: other } = session(english, fakeAi());
  await run(other, { ...THREE, limits: { steps: 3 } });
  assert.equal(stateOf(english).message, "3 steps done as requested: paused.");
});

test("a run of one chapter completes exactly one chapter, and the next one the following chapter", async () => {
  const store = new MemoryBookStore(seedBookFiles());
  const ai = fakeAi();
  const { session: autopilot, events } = session(store, ai);
  await run(autopilot, { ...THREE, limits: { chapters: 1 } });
  let state = stateOf(store);
  assert.equal(state.status, "paused");
  assert.deepEqual(state.plan.chapters.map((chapter) => chapter.status), ["done", "planned", "planned"]);
  assert.equal(labelsOf(ai).at(-1), "autopilot:consolidate:1");
  assert.equal(state.message, "1 chapter completed in this session.");
  assert.deepEqual([runEnded(events)[0].status, runEnded(events)[0].code], ["paused", "chapterLimit"]);

  await run(autopilot, { limits: { chapters: 1 } });
  state = stateOf(store);
  assert.deepEqual(state.plan.chapters.map((chapter) => chapter.status), ["done", "done", "planned"], "the next run starts with chapter 2: the limit counts the chapters of this run");
  assert.equal(labelsOf(ai).filter((label) => label === "autopilot:consolidate:1").length, 1, "chapter 1 was not done again");

  await run(autopilot, { limits: { chapters: 1 } });
  assert.deepEqual(stateOf(store).plan.chapters.map((chapter) => chapter.status), ["done", "done", "done"]);
  assert.equal(stateOf(store).status, "paused", "the judgement of the whole book is the next step");
  await run(autopilot);
  assert.equal(stateOf(store).status, "completed");
});

test("the stricter of the limit of the run and the option chaptersPerRun is the one that counts", async () => {
  for (const [perRun, chapters, done] of [[3, 1, 1], [1, 3, 1], [2, 2, 2], [0, 2, 2], [2, undefined, 2]]) {
    const store = new MemoryBookStore(seedBookFiles());
    const ai = fakeAi();
    const { session: autopilot, events } = session(store, ai);
    await run(autopilot, { brief: THREE.brief, options: { ...FAST, chaptersPerRun: perRun }, ...(chapters === undefined ? {} : { limits: { chapters } }) });
    const state = stateOf(store);
    assert.equal(state.plan.chapters.filter((chapter) => chapter.status === "done").length, done, `chaptersPerRun ${perRun}, limit ${chapters}`);
    assert.equal(state.status, "paused");
    assert.equal(runEnded(events)[0].code, "chapterLimit");
    assert.equal(state.options.chaptersPerRun, perRun, "the persisted option is left as it was");
  }
});

test("a step that fails does not count, a step that is cancelled does not count, and nothing is counted for a step that is repeated", async () => {
  // The second step fails once with an error that is retried: the run still makes two saved steps.
  const store = new MemoryBookStore(seedBookFiles());
  const base = fakeAi();
  let failed = false;
  const ai = {
    calls: base.calls,
    async complete(request) {
      if (!failed && request.label === "autopilot:plan") {
        failed = true;
        throw new AiProviderError("overloaded", 503, true);
      }
      return base.complete(request);
    },
  };
  const { session: autopilot, events } = session(store, ai);
  await run(autopilot, { ...THREE, limits: { steps: 2 } });
  assert.equal(failed, true);
  assert.equal(stateOf(store).stats.tasks, 2, "concept and plan: the failed attempt is not a step");
  assert.equal(stepCommits(store).length, 2);
  assert.ok(events.some((event) => event.type === "insight" && event.code === "failureRetry"));
  assert.ok((await readStoredAutopilot(store)).activities.some((activity) => activity.status === "failed"), "the failed attempt is in the log, and it was not counted");
  assert.equal(runEnded(events).at(-1).code, "stepLimit");

  // A step that is abandoned by a pause is not counted either.
  const second = new MemoryBookStore(seedBookFiles());
  const slow = fakeAi({ delayMs: 40 });
  const { session: other, events: otherEvents } = session(second, slow);
  await other.start({ ...THREE, limits: { steps: 1 } });
  await sleep(10);
  other.pause("now");
  await other.waitForIdle();
  assert.ok(otherEvents.some((event) => event.type === "task-finished" && event.activity.status === "cancelled"));
  assert.equal(stateOf(second).stats.tasks, 0, "nothing was saved");
  assert.equal(runEnded(otherEvents).at(-1).code, undefined, "and the run stopped because it was paused, not because of the limit");
  await run(other, { limits: { steps: 1 } });
  assert.equal(stateOf(second).stats.tasks, 1, "the next run of one step makes its own step");
});

test("a limit never takes the place of the reason the run stops anyway", async () => {
  const store = new MemoryBookStore(seedBookFiles());
  const { session: autopilot, events } = session(store, fakeAi());
  const start = { brief: THREE.brief, options: { ...FAST, pauseAfterPlan: true }, limits: { steps: 1 } };
  await run(autopilot, start);
  await run(autopilot, { limits: { steps: 1 } });
  await run(autopilot, { limits: { steps: 1 } });
  const state = stateOf(store);
  assert.equal(state.stats.tasks, 3, "concept, plan, review of the plan");
  assert.equal(state.plan.awaitingAuthor, true);
  assert.equal(state.message, "The plan is ready: read it and resume when you want.", "the plan waits for the author: that is what the run says");
  assert.equal(runEnded(events).at(-1).code, undefined);

  const finished = new MemoryBookStore(seedBookFiles());
  const { session: last } = session(finished, fakeAi({ chapters: 1 }));
  await run(last, { ...ONE, limits: { chapters: 1 } });
  assert.equal(stateOf(finished).status, "paused", "the chapter is the limit: the judgement of the book is left for the next run");
  await run(last, { limits: { steps: 1 } });
  assert.equal(stateOf(finished).status, "completed", "the last step ends the book, and the book is complete, whatever the limit");
  assert.equal(stateOf(finished).message, "The book is complete.");
});

test("a value that is not a whole number above zero is no limit", async () => {
  for (const limits of [{ steps: 0 }, { steps: -1 }, { steps: 1.5 }, { steps: Number.NaN }, { steps: Number.POSITIVE_INFINITY }, { steps: "1" }, { steps: null }, { chapters: 0 }, { chapters: -2 }, { chapters: 0.5 }, {}, null, [], "1", 3]) {
    const store = new MemoryBookStore(seedBookFiles());
    const { session: autopilot } = session(store, fakeAi({ chapters: 1 }));
    await run(autopilot, { ...ONE, limits });
    assert.equal(stateOf(store).status, "completed", JSON.stringify(limits));
  }
  assert.equal(typeof normalizeRunLimits, "function");
  assert.deepEqual(normalizeRunLimits({ steps: 2, chapters: 3 }), { steps: 2, chapters: 3 });
  assert.deepEqual(normalizeRunLimits({ steps: 2 }), { steps: 2 });
  assert.deepEqual(normalizeRunLimits({ steps: 2, chapters: 0 }), { steps: 2 }, "only the one that is meant");
  for (const value of [undefined, null, {}, { steps: 0, chapters: -1 }, { steps: "2" }, { steps: 1.5 }, [], "x", 4]) assert.equal(normalizeRunLimits(value), undefined, JSON.stringify(value));
});

test("the limit is visible while the run goes on, and is gone when it ends", async () => {
  const store = new MemoryBookStore(seedBookFiles());
  const { session: autopilot, events } = session(store, fakeAi());
  const states = () => events.filter((event) => event.type === "state").map((event) => event.state);
  await run(autopilot, { ...THREE, limits: { steps: 4, chapters: 1 } });

  const withLimits = states().filter((summary) => summary.limits);
  assert.ok(withLimits.length >= 4, "every summary of the run carries it");
  assert.ok(withLimits.every((summary) => summary.limits.steps === 4 && summary.limits.chapters === 1));
  const counts = withLimits.map((summary) => summary.limits.stepsDone);
  assert.deepEqual([...new Set(counts)], [0, 1, 2, 3, 4], "the count of the saved steps goes up one at a time, from the start of the run");
  assert.deepEqual(counts, [...counts].sort((left, right) => left - right), "and never goes back");
  assert.equal(withLimits.at(-1).limits.stepsDone, 4);
  assert.equal(withLimits.at(-1).limits.chaptersDone, 0);
  assert.equal(states().at(-1).limits, null, "the summary of a run that ended has no limit: it is over");
  const snapshot = await autopilot.snapshot();
  assert.equal(snapshot.summary.limits, null);
  assert.equal(snapshot.state.status, "paused");

  const none = new MemoryBookStore(seedBookFiles());
  const { session: free, events: freeEvents } = session(none, fakeAi({ chapters: 1 }));
  await run(free, ONE);
  assert.ok(freeEvents.filter((event) => event.type === "state").every((event) => event.state.limits === null), "no limit, nothing to show");

  // The effective limit of chapters is the stricter one, also when it is the option that makes it.
  const strict = new MemoryBookStore(seedBookFiles());
  const { session: option, events: optionEvents } = session(strict, fakeAi());
  await run(option, { brief: THREE.brief, options: { ...FAST, chaptersPerRun: 1 } });
  const shown = optionEvents.filter((event) => event.type === "state").map((event) => event.state.limits).filter(Boolean);
  assert.ok(shown.length > 0);
  assert.ok(shown.every((limits) => limits.chapters === 1 && limits.steps === undefined));
  assert.equal(shown.at(-1).chaptersDone, 1);
});

test("the limit shows live to a client that connects during the run", async () => {
  const store = new MemoryBookStore(seedBookFiles());
  const ai = fakeAi({ delayMs: 30 });
  const { session: autopilot } = session(store, ai);
  await autopilot.start({ ...THREE, limits: { steps: 2 } });
  const snapshot = await autopilot.snapshot();
  assert.equal(snapshot.running, true);
  assert.deepEqual([snapshot.summary.limits.steps, snapshot.summary.limits.chapters], [2, undefined]);
  assert.ok(snapshot.summary.limits.stepsDone <= 1, "the first step is still being made, or has just been saved");
  await autopilot.waitForIdle();
  assert.equal(stateOf(store).stats.tasks, 2);
});

test("the limits are for this run only: they are not saved, not in the options and not in the next run", async () => {
  const store = new MemoryBookStore(seedBookFiles());
  const ai = fakeAi({ chapters: 1 });
  const { session: autopilot } = session(store, ai);
  await run(autopilot, { ...ONE, limits: { steps: 1, chapters: 1 } });
  assert.ok(!store.files.get(STATE).includes("limits"), "nothing of it in the state file");
  assert.ok(!JSON.stringify(stateOf(store).options).includes("limits"));
  assert.ok(!store.files.get(ACTIVITY).includes("limits"));
  await autopilot.configure({ options: { chaptersPerRun: 0 }, limits: { steps: 1 } });
  assert.ok(!store.files.get(STATE).includes("limits"), "nor does configure keep it");

  await run(autopilot);
  assert.equal(stateOf(store).status, "completed", "a run started without limits has none: the one of the run before is forgotten");
});

test("when the chapter limit and a pause at the end of the chapter coincide, the request that was made is the one reported", async () => {
  const store = new MemoryBookStore(seedBookFiles());
  const { session: autopilot, events } = session(store, fakeAi());
  when(autopilot, started("write", 1), () => autopilot.pause("after-chapter"));
  await run(autopilot, { ...THREE, limits: { chapters: 1 } });
  assert.equal(stateOf(store).message, "Chapter 1 completed: paused, as you asked.");
  assert.equal(runEnded(events)[0].code, "chapterPause");
});

test("a pause the author asks for wins over the limit when both are due at the same step", async () => {
  const store = new MemoryBookStore(seedBookFiles());
  const { session: autopilot, events } = session(store, fakeAi());
  when(autopilot, started("concept"), () => autopilot.pause("after-step"));
  await run(autopilot, { ...THREE, limits: { steps: 1 } });
  assert.equal(stateOf(store).stats.tasks, 1);
  assert.equal(runEnded(events)[0].code, undefined, "the run stopped because it was paused");
  assert.equal(stateOf(store).message, null);
});
