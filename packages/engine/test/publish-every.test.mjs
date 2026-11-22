import test from "node:test";
import assert from "node:assert/strict";
import * as engine from "../dist/index.js";
import { MemoryBookStore, createFakeAutopilotAi, seedBookFiles } from "../dist/testing/index.js";

// New exports are read from the namespace so that, before they exist, each test fails on its own.
const {
  AutopilotBusyError,
  AutopilotSession,
  DEFAULT_OPTIONS,
  createAutopilotState,
  effectivePublish,
  hostDefaultPublish,
  normalizeOptions,
  parseAutopilotState,
  readStoredAutopilot,
  reconcileAuthorChanges,
  serializeAutopilotState,
  summarizeAutopilotState,
} = engine;

const STATE = "autopilot/state.json";
const FAST = { readers: false, readersOnPlan: false, specialists: false, pauseAfterPlan: false };
const BRIEF = { idea: "x", targetChapters: 2, scenesPerChapter: 1, wordsPerScene: 300 };
const TWO = { brief: BRIEF, options: FAST };

/** Two chapters of one scene each: concept, plan, review of the plan, then scenes, write, director-review and consolidate for every chapter, and the final review: twelve steps. */
const fakeAi = (extra = {}) => createFakeAutopilotAi({ chapters: 2, scenes: 1, reviewVerdict: () => "approve", ...extra });

const ALL_STEPS = ["concept", "plan", "plan-review", "scenes:1", "write:1", "director-review:1", "consolidate:1", "scenes:2", "write:2", "director-review:2", "consolidate:2", "final"];

function session(store, ai, extra = {}) {
  const events = [];
  const instance = new AutopilotSession({ bookId: "book-1", store, ai, host: "server", hostLabel: "test-host", hostId: "server-1", retryDelayMs: 0, ...extra });
  instance.subscribe((event) => events.push(event));
  return { session: instance, events };
}

/** A host that counts what the engine asks of it: `log` is in order, `steps` and `chapters` are the calls of each hook. */
function recordingHost() {
  const log = [];
  const steps = [];
  const chapters = [];
  const hooks = {
    afterCommit: async ({ task }) => {
      const name = `${task.kind}${task.chapterNumber ? `:${task.chapterNumber}` : ""}`;
      steps.push(name);
      log.push(`step ${name}`);
    },
    afterChapter: async ({ chapterNumber }) => {
      chapters.push(chapterNumber);
      log.push(`chapter ${chapterNumber}`);
    },
  };
  return { hooks, log, steps, chapters };
}

const stateOf = (store) => parseAutopilotState(store.files.get(STATE));
const labelsOf = (ai) => ai.calls.map((call) => call.label);

async function run(autopilot, start) {
  await autopilot.start(start);
  await autopilot.waitForIdle();
}

function deferred() {
  let resolve = () => undefined;
  const promise = new Promise((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

/** The fake AI, where every call first waits for `before(call number, request)`. */
function gatedAi(before, options = {}) {
  const base = fakeAi(options);
  return {
    calls: base.calls,
    async complete(request) {
      await before(base.calls.length + 1, request);
      return base.complete(request);
    },
  };
}

/** Holds the first request for which `match` is true until `gate.resolve()`; `reached` says it is being held. */
function holdingAi(match, options = {}) {
  const gate = deferred();
  const reached = deferred();
  let held = false;
  const ai = gatedAi((call, request) => {
    if (held || !match(request, call)) return undefined;
    held = true;
    reached.resolve();
    return gate.promise;
  }, options);
  return { ai, gate, reached: reached.promise };
}

const holdLabel = (label) => holdingAi((request) => request.label === label);

// ─── The effective way of publishing ────────────────────────────────────────

test("the author's choice wins, then the host's, then what the old option says", () => {
  assert.equal(typeof effectivePublish, "function");
  const old = (syncAfterChapter) => ({ syncAfterChapter });
  assert.equal(effectivePublish(old(true)), "chapter", "nothing chosen: publish after every chapter if the option says so");
  assert.equal(effectivePublish(old(false)), "off");
  assert.equal(effectivePublish(old(true), "step"), "step", "the host's default beats the old option");
  assert.equal(effectivePublish(old(false), "chapter"), "chapter");
  assert.equal(effectivePublish(old(true), "off"), "off");
  for (const mode of ["off", "chapter", "step"]) {
    for (const syncAfterChapter of [true, false]) for (const host of [undefined, "off", "chapter", "step"]) assert.equal(effectivePublish({ publishEvery: mode, syncAfterChapter }, host), mode, `the author chose ${mode}`);
  }
  assert.equal(effectivePublish({ publishEvery: "weekly", syncAfterChapter: true }, "step"), "step", "a value nobody knows is not a choice");
  assert.equal(effectivePublish({ publishEvery: undefined, syncAfterChapter: false }, "bogus"), "off");
  assert.equal(effectivePublish(undefined, "step"), "step", "no options at all: the host's default");
  assert.equal(effectivePublish(null), "off");
});

test("a server host that says nothing publishes after every step, as it always did; a browser host follows the old option", () => {
  assert.equal(typeof hostDefaultPublish, "function");
  assert.equal(hostDefaultPublish("server"), "step");
  assert.equal(hostDefaultPublish("server", "off"), "off", "unless it says otherwise");
  assert.equal(hostDefaultPublish("server", "chapter"), "chapter");
  assert.equal(hostDefaultPublish("browser"), undefined, "the browser leaves it to the option syncAfterChapter");
  assert.equal(hostDefaultPublish("browser", "step"), "step");
  assert.equal(effectivePublish({ syncAfterChapter: true }, hostDefaultPublish("server")), "step");
  assert.equal(effectivePublish({ syncAfterChapter: true }, hostDefaultPublish("browser")), "chapter");
  assert.equal(effectivePublish({ syncAfterChapter: false }, hostDefaultPublish("browser")), "off");
});

test("publishEvery is a persisted option that is absent unless somebody chose it, and files from before it still read the same", () => {
  assert.ok(!("publishEvery" in DEFAULT_OPTIONS), "nothing chosen by default: the host decides");
  assert.ok(!("publishEvery" in normalizeOptions({})));
  assert.deepEqual(normalizeOptions({}), DEFAULT_OPTIONS, "an empty request changes nothing, and adds nothing");
  for (const mode of ["off", "chapter", "step"]) assert.equal(normalizeOptions({ publishEvery: mode }).publishEvery, mode);
  assert.equal(normalizeOptions({ publishEvery: "STEP" }).publishEvery, "step", "read as every other word of the options is");
  const chosen = normalizeOptions({ publishEvery: "step" });
  assert.equal(normalizeOptions({ publishEvery: "weekly" }, chosen).publishEvery, "step", "a value nobody knows leaves the choice as it was");
  assert.equal(normalizeOptions({ publishEvery: 3 }, chosen).publishEvery, "step");
  assert.equal(normalizeOptions({ readers: false }, chosen).publishEvery, "step", "and so does a request that does not mention it");
  assert.ok(!("publishEvery" in normalizeOptions({ publishEvery: null }, chosen)), "null takes the choice back: the host decides again");
  assert.ok(!("publishEvery" in normalizeOptions({ publishEvery: "weekly" })));

  const state = createAutopilotState(new Date(0), BRIEF, { publishEvery: "chapter" });
  assert.equal(parseAutopilotState(serializeAutopilotState(state)).options.publishEvery, "chapter", "it survives the file");
  const old = JSON.parse(serializeAutopilotState(createAutopilotState(new Date(0), BRIEF, { syncAfterChapter: false })));
  assert.ok(!("publishEvery" in old.options), "a state file of an older engine has no such key");
  const read = parseAutopilotState(JSON.stringify(old));
  assert.equal(read.options.syncAfterChapter, false);
  assert.ok(!("publishEvery" in read.options));
  assert.ok(!("publishEvery" in parseAutopilotState(JSON.stringify({ ...old, options: { ...old.options, publishEvery: "sometimes" } })).options), "a file with a value nobody knows reads as no choice");
});

// ─── The engine, not the host, decides when the hooks are called ────────────

test("every step, every chapter, or never: the hooks are called as the way of publishing says", async () => {
  const outcomes = {};
  for (const mode of ["step", "chapter", "off"]) {
    const store = new MemoryBookStore(seedBookFiles());
    const { hooks, log, steps, chapters } = recordingHost();
    const { session: autopilot, events } = session(store, fakeAi(), { hooks });
    await run(autopilot, { brief: BRIEF, options: { ...FAST, publishEvery: mode } });
    assert.equal(stateOf(store).status, "completed", mode);
    outcomes[mode] = { steps, chapters, log, sync: events.filter((event) => event.type === "sync").length };
  }
  assert.deepEqual(outcomes.step.steps, ALL_STEPS, "one call for every step that was saved");
  assert.deepEqual(outcomes.step.chapters, [1, 2], "and a last one when a chapter is closed, so that the chapter is published whole");
  assert.deepEqual(outcomes.step.log.slice(6, 9), ["step consolidate:1", "chapter 1", "step scenes:2"], "after the step that closes the chapter, and before the next step");
  assert.deepEqual(outcomes.chapter.steps, [], "no call per step");
  assert.deepEqual(outcomes.chapter.chapters, [1, 2], "one call per chapter");
  assert.deepEqual(outcomes.off.steps, []);
  assert.deepEqual(outcomes.off.chapters, [], "nothing at all");
  assert.deepEqual([outcomes.step.sync, outcomes.chapter.sync, outcomes.off.sync], [0, 0, 0], "and nothing to report when nothing failed");
});

test("the way the host publishes is the default of a run that has no choice of the author, whatever the host", async () => {
  for (const host of ["browser", "server"]) {
    for (const [defaultPublish, steps, chapters] of [["step", ALL_STEPS, [1, 2]], ["chapter", [], [1, 2]], ["off", [], []]]) {
      const store = new MemoryBookStore(seedBookFiles());
      const recorder = recordingHost();
      const { session: autopilot } = session(store, fakeAi(), { host, hostLabel: host, hostId: `${host}-1`, hooks: recorder.hooks, defaultPublish });
      await run(autopilot, TWO);
      assert.deepEqual([recorder.steps, recorder.chapters], [steps, chapters], `${host} with the default ${defaultPublish}`);
    }
  }

  // The author's choice beats the host's default, in both directions.
  const store = new MemoryBookStore(seedBookFiles());
  const recorder = recordingHost();
  const { session: autopilot } = session(store, fakeAi(), { hooks: recorder.hooks, defaultPublish: "step" });
  await run(autopilot, { brief: BRIEF, options: { ...FAST, publishEvery: "off" } });
  assert.deepEqual([recorder.steps, recorder.chapters], [[], []], "off, though the host would publish every step");
  const second = new MemoryBookStore(seedBookFiles());
  const other = recordingHost();
  const { session: asked } = session(second, fakeAi(), { hooks: other.hooks, defaultPublish: "off" });
  await run(asked, { brief: BRIEF, options: { ...FAST, publishEvery: "chapter" } });
  assert.deepEqual([other.steps, other.chapters], [[], [1, 2]], "every chapter, though the host would publish nothing");
});

test("a host that says nothing keeps what it always had: the server after every step, the browser after every chapter if the option is on", async () => {
  // The browser's hook is the one of the chapter; the option syncAfterChapter is all that says whether it is called.
  for (const [syncAfterChapter, chapters] of [[true, [1, 2]], [false, []]]) {
    const store = new MemoryBookStore(seedBookFiles());
    const log = [];
    const hooks = { afterChapter: async ({ chapterNumber }) => void log.push(chapterNumber) };
    const { session: autopilot } = session(store, fakeAi(), { host: "browser", hostLabel: "browser", hostId: "device-1", hooks });
    await run(autopilot, { brief: BRIEF, options: { ...FAST, syncAfterChapter } });
    assert.deepEqual(log, chapters, `browser, syncAfterChapter ${syncAfterChapter}`);
    assert.ok(!("publishEvery" in stateOf(store).options), "and nothing was saved that an older engine could not read");
  }

  // The server's hook is the one of the step, called for every step whatever the old option says.
  for (const syncAfterChapter of [true, false]) {
    const store = new MemoryBookStore(seedBookFiles());
    const log = [];
    const hooks = { afterCommit: async ({ task }) => void log.push(task.kind) };
    const { session: autopilot } = session(store, fakeAi(), { hooks });
    await run(autopilot, { brief: BRIEF, options: { ...FAST, syncAfterChapter } });
    assert.equal(log.length, 12, `server, syncAfterChapter ${syncAfterChapter}`);
  }

  // Files of an older engine: only syncAfterChapter, saved before the run.
  for (const syncAfterChapter of [true, false]) {
    const old = createAutopilotState(new Date(0), BRIEF, { ...FAST, syncAfterChapter });
    const store = new MemoryBookStore({ ...seedBookFiles(), [STATE]: serializeAutopilotState(old) });
    const log = [];
    const hooks = { afterChapter: async ({ chapterNumber }) => void log.push(chapterNumber) };
    const { session: autopilot } = session(store, fakeAi(), { host: "browser", hostLabel: "browser", hostId: "device-1", hooks });
    await run(autopilot);
    assert.deepEqual(log, syncAfterChapter ? [1, 2] : [], `an old file with syncAfterChapter ${syncAfterChapter}`);
  }
});

test("a publish that fails is reported as it always was, and never stops the run", async () => {
  const store = new MemoryBookStore(seedBookFiles());
  const hooks = {
    afterCommit: async () => {
      throw new Error("push refused");
    },
    afterChapter: async () => {
      throw new Error("publish refused");
    },
  };
  const { session: autopilot, events } = session(store, fakeAi(), { hooks });
  await run(autopilot, { brief: BRIEF, options: { ...FAST, publishEvery: "step" } });
  assert.equal(stateOf(store).status, "completed", "a failing publish is never a reason to stop");
  const sync = events.filter((event) => event.type === "sync");
  assert.equal(sync.filter((event) => event.code === "syncFailed").length, 12, "one for every step");
  assert.equal(sync.filter((event) => event.code === "publishFailed").length, 2, "one for every chapter");
  assert.ok(sync.every((event) => event.tone === "warning" && /refused/.test(event.detail)));

  const quiet = new MemoryBookStore(seedBookFiles());
  const { session: second, events: secondEvents } = session(quiet, fakeAi(), { hooks });
  await run(second, { brief: BRIEF, options: { ...FAST, publishEvery: "chapter" } });
  assert.deepEqual(secondEvents.filter((event) => event.type === "sync").map((event) => event.code), ["publishFailed", "publishFailed"], "with every chapter only the chapter's publish is asked for");
});

// ─── It can change while the run goes on ────────────────────────────────────

test("from every step to never, during the run: it holds from the end of the step that is running, which is neither repeated nor failed", async () => {
  const { ai, gate, reached } = holdLabel("autopilot:scenes:1");
  const store = new MemoryBookStore(seedBookFiles());
  const recorder = recordingHost();
  const { session: autopilot, events } = session(store, ai, { hooks: recorder.hooks });
  await autopilot.start({ brief: BRIEF, options: { ...FAST, publishEvery: "step" } });
  await reached;
  assert.deepEqual(recorder.steps, ["concept", "plan", "plan-review"], "published after every step so far");

  const saved = await autopilot.updateOptions({ publishEvery: "off" });
  assert.equal(saved.options.publishEvery, "off", "the saved state is what comes back");
  assert.equal(saved.status, "running", "and the run still owns the book");
  assert.equal(stateOf(store).options.publishEvery, "off", "it is saved at once, in the middle of the step");
  assert.equal(ai.calls.length, 3, "the request of the step is still being held");
  gate.resolve();
  await autopilot.waitForIdle();

  assert.equal(stateOf(store).status, "completed");
  assert.equal(stateOf(store).options.publishEvery, "off", "the run did not write the old value back");
  assert.deepEqual(recorder.steps, ["concept", "plan", "plan-review"], "the step that was running when it changed, and every step after it, are not published");
  assert.deepEqual(recorder.chapters, []);
  assert.equal(labelsOf(ai).filter((label) => label === "autopilot:scenes:1").length, 1, "the step that was running was not repeated");
  assert.ok(!events.some((event) => event.type === "insight" && (event.code === "conflictRetry" || event.code === "failureRetry")), "and did not fail or retry");
  const { activities } = await readStoredAutopilot(store);
  assert.ok(activities.every((activity) => activity.status === "succeeded"), "every activity succeeded");
});

test("from never to every step, and from every step to every chapter: the new way holds from the next gate", async () => {
  const turned = async (from, to, label) => {
    const { ai, gate, reached } = holdLabel(label);
    const store = new MemoryBookStore(seedBookFiles());
    const recorder = recordingHost();
    const { session: autopilot, events } = session(store, ai, { hooks: recorder.hooks });
    await autopilot.start({ brief: BRIEF, options: { ...FAST, publishEvery: from } });
    await reached;
    await autopilot.updateOptions({ publishEvery: to });
    gate.resolve();
    await autopilot.waitForIdle();
    assert.equal(stateOf(store).status, "completed");
    assert.ok(!events.some((event) => event.type === "insight" && event.code === "conflictRetry"));
    return recorder;
  };

  const opened = await turned("off", "step", "autopilot:scenes:1");
  assert.deepEqual(opened.steps, ALL_STEPS.slice(3), "from the end of the step that was running: it is published too");
  assert.deepEqual(opened.chapters, [1, 2]);

  const narrowed = await turned("step", "chapter", "autopilot:write:1.1");
  assert.deepEqual(narrowed.steps, ["concept", "plan", "plan-review", "scenes:1"], "the steps before the one that was running");
  assert.deepEqual(narrowed.chapters, [1, 2], "and the chapters, as chosen");

  const widened = await turned("chapter", "step", "autopilot:consolidate:1");
  assert.deepEqual(widened.steps, ALL_STEPS.slice(6), "the step that closes chapter 1 is the first one published");
  assert.deepEqual(widened.log.slice(0, 2), ["step consolidate:1", "chapter 1"], "and the chapter follows it");
  assert.deepEqual(widened.chapters, [1, 2]);
});

test("to be paused after every chapter can be turned on and off while the run goes on, and holds at the end of the chapter", async () => {
  const on = holdLabel("autopilot:write:1.1");
  const store = new MemoryBookStore(seedBookFiles());
  const { session: autopilot, events } = session(store, on.ai);
  await autopilot.start(TWO);
  await on.reached;
  const saved = await autopilot.updateOptions({ pauseAfterEachChapter: true });
  assert.equal(saved.options.pauseAfterEachChapter, true);
  on.gate.resolve();
  await autopilot.waitForIdle();
  let state = stateOf(store);
  assert.equal(state.status, "paused");
  assert.deepEqual(state.plan.chapters.map((chapter) => chapter.status), ["done", "planned"], "paused after chapter 1, as the option says");
  assert.equal(state.message, "Chapter 1 approved: read it and resume.");
  assert.equal(state.options.pauseAfterEachChapter, true);
  assert.equal(labelsOf(on.ai).filter((label) => label === "autopilot:write:1.1").length, 1, "the step that was running was not repeated");
  assert.ok(!events.some((event) => event.type === "insight" && event.code === "conflictRetry"));

  const off = holdLabel("autopilot:write:1.1");
  const second = new MemoryBookStore(seedBookFiles());
  const { session: other } = session(second, off.ai);
  await other.start({ brief: BRIEF, options: { ...FAST, pauseAfterEachChapter: true } });
  await off.reached;
  await other.updateOptions({ pauseAfterEachChapter: false });
  off.gate.resolve();
  await other.waitForIdle();
  state = stateOf(second);
  assert.equal(state.status, "completed", "nothing paused it: the option was turned off before the end of the chapter");
  assert.equal(state.options.pauseAfterEachChapter, false);
});

test("updateOptions changes the two settings, tells it in a state event and in the summary, writes nothing when nothing changes, and a value nobody knows changes nothing", async () => {
  const store = new MemoryBookStore(seedBookFiles());
  const { session: autopilot, events } = session(store, fakeAi(), { host: "browser", hostLabel: "browser", hostId: "device-1" });
  await run(autopilot, { brief: BRIEF, options: FAST, limits: { steps: 1 } });
  const summaries = () => events.filter((event) => event.type === "state").map((event) => event.state);
  assert.equal(summaries().at(-1).publish, "chapter", "a browser that says nothing, with the old option on, publishes after every chapter");
  assert.equal((await autopilot.snapshot()).summary.publish, "chapter");

  const commits = store.commits.length;
  const saved = await autopilot.updateOptions({ publishEvery: "step", pauseAfterEachChapter: true });
  assert.equal(store.commits.length, commits + 1, "one write");
  assert.deepEqual([saved.options.publishEvery, saved.options.pauseAfterEachChapter], ["step", true]);
  assert.deepEqual([stateOf(store).options.publishEvery, stateOf(store).options.pauseAfterEachChapter], ["step", true]);
  assert.equal(saved.version, stateOf(store).version, "the state it answers is the one that was saved");
  assert.equal(summaries().at(-1).publish, "step", "the new way is in the next summary");
  assert.equal((await autopilot.snapshot()).summary.publish, "step");

  const again = await autopilot.updateOptions({ publishEvery: "step", pauseAfterEachChapter: true });
  assert.equal(store.commits.length, commits + 1, "the same values write nothing");
  assert.equal(again.version, saved.version);
  const ignored = await autopilot.updateOptions({ publishEvery: "weekly", pauseAfterEachChapter: "maybe", banana: 1 });
  assert.equal(store.commits.length, commits + 1, "values nobody knows, and words that are no option, change nothing");
  assert.deepEqual([ignored.options.publishEvery, ignored.options.pauseAfterEachChapter], ["step", true]);

  const cleared = await autopilot.updateOptions({ publishEvery: null });
  assert.ok(!("publishEvery" in cleared.options), "null takes the choice back");
  assert.ok(!stateOf(store).options.publishEvery);
  assert.equal(summaries().at(-1).publish, "chapter", "and the host decides again");
  await autopilot.updateOptions({ publishEvery: "off" });
  assert.equal(summaries().at(-1).publish, "off");
  assert.equal((await autopilot.snapshot()).summary.publish, "off");
});

test("while the run goes on only the two settings can change: any other is refused as configure refuses it, and nothing of the request is applied", async () => {
  const { ai, gate, reached } = holdLabel("autopilot:scenes:1");
  const store = new MemoryBookStore(seedBookFiles());
  const { session: autopilot } = session(store, ai);
  await autopilot.start({ brief: BRIEF, options: { ...FAST, publishEvery: "step" } });
  await reached;
  await assert.rejects(() => autopilot.updateOptions({ chaptersPerRun: 5 }), AutopilotBusyError);
  await assert.rejects(() => autopilot.updateOptions({ publishEvery: "off", readers: true }), AutopilotBusyError, "a request with one setting that cannot change is refused whole");
  await assert.rejects(() => autopilot.configure({ options: { publishEvery: "off" } }), AutopilotBusyError, "as configure always did");
  assert.equal(stateOf(store).options.publishEvery, "step", "none of it was applied");
  assert.equal(stateOf(store).options.chaptersPerRun, 0);
  gate.resolve();
  await autopilot.waitForIdle();

  const quiet = new MemoryBookStore(seedBookFiles());
  const { session: idle } = session(quiet, fakeAi());
  await run(idle, { brief: BRIEF, options: FAST, limits: { steps: 1 } });
  const saved = await idle.updateOptions({ chaptersPerRun: 5, publishEvery: "chapter" });
  assert.deepEqual([saved.options.chaptersPerRun, saved.options.publishEvery], [5, "chapter"], "with the run over, any option can change, as with configure");
});

test("the settings that can change during a run, and only those, are the ones the author's changes carry into the step that is running", () => {
  assert.equal(typeof reconcileAuthorChanges, "function");
  const base = createAutopilotState(new Date(0), BRIEF, { ...FAST, publishEvery: "step" });
  const working = { ...structuredClone(base), stats: { ...base.stats, tasks: 1 } };

  const stored = { ...structuredClone(base), options: { ...base.options, publishEvery: "off", pauseAfterEachChapter: true } };
  const merged = reconcileAuthorChanges(working, base, stored);
  assert.equal(merged.foreign, false, "the author's change of these is not a conflict: the step is neither failed nor repeated");
  assert.equal(merged.state.options.publishEvery, "off");
  assert.equal(merged.state.options.pauseAfterEachChapter, true);
  assert.equal(merged.state.stats.tasks, 1, "and what the step did stays");
  assert.equal(working.options.publishEvery, "step", "the state of the run is not changed in place");

  const cleared = { ...structuredClone(base), options: Object.fromEntries(Object.entries(base.options).filter(([key]) => key !== "publishEvery")) };
  const taken = reconcileAuthorChanges(working, base, cleared);
  assert.equal(taken.foreign, false);
  assert.ok(!("publishEvery" in taken.state.options), "a choice taken back is taken back");

  const unchanged = reconcileAuthorChanges(working, base, structuredClone(base));
  assert.equal(unchanged.foreign, false);
  assert.equal(unchanged.state, working, "nothing to carry: the state of the step as it was");

  const other = { ...structuredClone(stored), options: { ...stored.options, readers: !base.options.readers } };
  assert.equal(reconcileAuthorChanges(working, base, other).foreign, true, "any other option that changed is still a conflict");
  const budget = { ...structuredClone(base), options: { ...base.options, chaptersPerRun: 3 } };
  assert.equal(reconcileAuthorChanges(working, base, budget).foreign, true);
});

test("the summary says how the book is published, whatever the host and whoever chose", async () => {
  const state = createAutopilotState(new Date(0), BRIEF, { syncAfterChapter: true });
  assert.equal(summarizeAutopilotState(state).publish, "chapter", "from the state alone: the old option");
  assert.equal(summarizeAutopilotState({ ...state, options: { ...state.options, syncAfterChapter: false } }).publish, "off");
  assert.equal(summarizeAutopilotState(state, { defaultPublish: "step" }).publish, "step", "with the host's default");
  assert.equal(summarizeAutopilotState({ ...state, options: { ...state.options, publishEvery: "off" } }, { defaultPublish: "step" }).publish, "off", "and the author's choice over it");
  assert.ok(!("pausePending" in summarizeAutopilotState(state)) && !("limits" in summarizeAutopilotState(state)), "a summary built from the file alone does not claim to know what only a run knows");

  const seen = {};
  for (const [name, extra, options] of [["server", { host: "server" }, FAST], ["browser", { host: "browser", hostLabel: "b", hostId: "d" }, FAST], ["host default", { defaultPublish: "off" }, FAST], ["the author", { defaultPublish: "off" }, { ...FAST, publishEvery: "chapter" }]]) {
    const store = new MemoryBookStore(seedBookFiles());
    const { session: autopilot, events } = session(store, fakeAi({ chapters: 1 }), extra);
    await run(autopilot, { brief: { ...BRIEF, targetChapters: 1 }, options, limits: { steps: 1 } });
    seen[name] = [...new Set(events.filter((event) => event.type === "state").map((event) => event.state.publish))];
  }
  assert.deepEqual(seen, { server: ["step"], browser: ["chapter"], "host default": ["off"], "the author": ["chapter"] });
});
