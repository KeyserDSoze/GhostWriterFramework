import test from "node:test";
import assert from "node:assert/strict";
import * as engine from "../dist/index.js";
import { MemoryBookStore, createFakeAutopilotAi, seedBookFiles } from "../dist/testing/index.js";

// New exports are read from the namespace so that, before they exist, each test fails on its own.
const { AiProviderError, AutopilotRun, AutopilotSession, parseAutopilotState } = engine;

const STATE = "autopilot/state.json";
const FAST = { readers: false, readersOnPlan: false, specialists: false, pauseAfterPlan: false };
const THREE = { brief: { idea: "x", targetChapters: 3, scenesPerChapter: 1, wordsPerScene: 300 }, options: FAST };

/** Three chapters of one scene each: concept, plan, review of the plan, then scenes, write, director-review and consolidate for every chapter, and the final review. */
const fakeAi = (extra = {}) => createFakeAutopilotAi({ chapters: 3, scenes: 1, reviewVerdict: () => "approve", ...extra });

function session(store, ai, extra = {}) {
  const events = [];
  const instance = new AutopilotSession({ bookId: "book-1", store, ai, host: "server", hostLabel: "test-host", hostId: "server-1", retryDelayMs: 0, ...extra });
  instance.subscribe((event) => events.push(event));
  return { session: instance, events };
}

const stateOf = (store) => parseAutopilotState(store.files.get(STATE));
const labelsOf = (ai) => ai.calls.map((call) => call.label);
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

async function waitFor(predicate, what, timeoutMs = 3000) {
  const deadline = Date.now() + timeoutMs;
  while (!(await predicate())) {
    if (Date.now() > deadline) assert.fail(`Timed out waiting for ${what}.`);
    await sleep(4);
  }
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

/** Holds the first request for which `match` is true until `gate.resolve()` (or until the run abandons it); `reached` says it is being held. */
function holdingAi(match, options = {}) {
  const gate = deferred();
  const reached = deferred();
  let held = false;
  const ai = gatedAi((call, request) => {
    if (held || !match(request, call)) return undefined;
    held = true;
    reached.resolve();
    return new Promise((resolve, reject) => {
      gate.promise.then(resolve);
      request.signal?.addEventListener("abort", () => reject(request.signal.reason), { once: true });
    });
  }, options);
  return { ai, gate, reached: reached.promise };
}

/** The AI fails the first time it is asked for `label`, with `error`. */
function failingOnce(label, error) {
  const base = fakeAi();
  let failed = false;
  return {
    calls: base.calls,
    async complete(request) {
      if (!failed && request.label === label) {
        failed = true;
        throw error;
      }
      return base.complete(request);
    },
  };
}

/** Runs `action` once, as soon as the event `match` recognises is emitted. */
function when(autopilot, match, action) {
  let done = false;
  autopilot.subscribe((event) => {
    if (done || !match(event)) return;
    done = true;
    action(event);
  });
}

const started = (task, chapter, scene) => (event) => event.type === "task-started"
  && event.activity.task === task
  && (chapter === undefined || event.activity.chapterNumber === chapter)
  && (scene === undefined || event.activity.sceneNumber === scene);

const chapterStatuses = (state) => state.plan.chapters.map((chapter) => chapter.status);
const runEnded = (events) => events.filter((event) => event.type === "run-ended");

/** What the pause that is waiting is, as a client sees it. */
async function pendingOf(autopilot) {
  return (await autopilot.snapshot()).summary?.pausePending;
}

/** The AI calls of the same book when nobody pauses it. */
async function baselineLabels() {
  const ai = fakeAi();
  const { session: autopilot } = session(new MemoryBookStore(seedBookFiles({ chapters: 3 })), ai);
  await autopilot.start(THREE);
  await autopilot.waitForIdle();
  return labelsOf(ai);
}

// ─── Q1: the pause at the end of the chapter ────────────────────────────────

test("a pause at the end of the chapter, asked in the middle of chapter 1, ends the run right after chapter 1 is closed: not before, not after", async () => {
  const store = new MemoryBookStore(seedBookFiles({ chapters: 3 }));
  const ai = fakeAi();
  const { session: autopilot, events } = session(store, ai);
  let accepted;
  when(autopilot, started("write", 1, 1), () => {
    accepted = autopilot.pause("after-chapter");
  });
  await autopilot.start(THREE);
  await autopilot.waitForIdle();

  assert.equal(accepted, true);
  const state = stateOf(store);
  assert.equal(state.status, "paused");
  assert.deepEqual(chapterStatuses(state), ["done", "planned", "planned"], "chapter 1 is closed, chapter 2 is not started");
  assert.equal(labelsOf(ai).at(-1), "autopilot:consolidate:1", "the last call is the closing of chapter 1");
  for (const label of ["autopilot:scenes:1", "autopilot:write:1.1", "autopilot:director-review:1"]) assert.ok(labelsOf(ai).includes(label), `${label} ran: the chapter was finished, not cut short`);
  assert.ok(!labelsOf(ai).some((label) => /:2(\.|$)/.test(label)), "and nothing of chapter 2 started");
  assert.equal(state.message, "Chapter 1 completed: paused, as you asked.");
  assert.equal(state.runner, null);
  assert.match(store.files.get("chapters/001-chapter-title-1/chapter.md"), /summary: Mira confronts Orrin\./, "the closing of the chapter was saved");
  const ended = runEnded(events);
  assert.equal(ended.length, 1);
  assert.deepEqual([ended[0].status, ended[0].message, ended[0].code], ["paused", state.message, "chapterPause"], "the client can translate the stop by its code");
  assert.equal(events.filter((event) => event.type === "task-finished" && event.activity.status !== "succeeded").length, 0, "no step was cancelled for it");
});

test("the message is in the language of the book, and a request made while the first step of a chapter runs waits for that chapter", async () => {
  const store = new MemoryBookStore(seedBookFiles({ chapters: 3, language: "it" }));
  const ai = fakeAi();
  const { session: autopilot, events } = session(store, ai);
  when(autopilot, started("scenes", 2), () => autopilot.pause("after-chapter"));
  await autopilot.start(THREE);
  await autopilot.waitForIdle();

  const state = stateOf(store);
  assert.deepEqual(chapterStatuses(state), ["done", "done", "planned"], "the chapter whose scenes were being planned is the one that is finished");
  assert.equal(state.message, "Capitolo 2 completato: in pausa, come hai chiesto.");
  assert.equal(runEnded(events)[0].code, "chapterPause");
  assert.ok(!labelsOf(ai).some((label) => /:3(\.|$)/.test(label)), "chapter 3 never started");
});

test("asked between two chapters, the run stops at the boundary without starting the next chapter", async () => {
  const store = new MemoryBookStore(seedBookFiles({ chapters: 3 }));
  const ai = fakeAi();
  const holder = {};
  let asked = false;
  const hooks = {
    // The first thing a run does after closing chapter 1: nothing of chapter 2 has started yet.
    beforeStep: async () => {
      if (asked || !ai.calls.some((call) => call.label === "autopilot:consolidate:1")) return;
      asked = true;
      holder.session.pause("after-chapter");
    },
  };
  const { session: autopilot, events } = session(store, ai, { hooks });
  holder.session = autopilot;
  await autopilot.start(THREE);
  await autopilot.waitForIdle();

  assert.equal(asked, true);
  const state = stateOf(store);
  assert.equal(state.status, "paused");
  assert.deepEqual(chapterStatuses(state), ["done", "planned", "planned"]);
  assert.ok(!labelsOf(ai).includes("autopilot:scenes:2"), "the next chapter was not started: no money spent on it");
  assert.equal(state.message, "Chapter 1 completed: paused, as you asked.", "the chapter this run just closed is the one it says");
  assert.equal(runEnded(events)[0].code, "chapterPause");
});

test("asked while the chapter is being closed, or while its publishing hook runs, the run still ends after the closing and the publishing", async () => {
  for (const [where, trigger] of [
    ["during the closing step", (autopilot) => when(autopilot, started("consolidate", 1), () => autopilot.pause("after-chapter"))],
    ["during the publishing hook", null],
  ]) {
    const store = new MemoryBookStore(seedBookFiles({ chapters: 3 }));
    const ai = fakeAi();
    const log = [];
    const holder = {};
    const hooks = {
      afterChapter: async ({ chapterNumber }) => {
        log.push(`published ${chapterNumber}`);
        if (!trigger && chapterNumber === 1) holder.session.pause("after-chapter");
      },
    };
    const { session: autopilot, events } = session(store, ai, { hooks });
    holder.session = autopilot;
    trigger?.(autopilot);
    autopilot.subscribe((event) => {
      if (event.type === "run-ended") log.push("run ended");
    });
    await autopilot.start(THREE);
    await autopilot.waitForIdle();

    assert.deepEqual(log, ["published 1", "run ended"], `${where}: the chapter is published before the run pauses, and the run ends once`);
    const state = stateOf(store);
    assert.deepEqual(chapterStatuses(state), ["done", "planned", "planned"], where);
    assert.equal(state.message, "Chapter 1 completed: paused, as you asked.", where);
    assert.equal(runEnded(events)[0].code, "chapterPause", where);
  }
});

test("with no chapter in progress (concept, plan) the pause at the end of the chapter is the pause after the step, and at the final judgement the book is simply complete", async () => {
  for (const kind of ["concept", "plan"]) {
    const outcomes = [];
    for (const mode of ["after-step", "after-chapter"]) {
      const store = new MemoryBookStore(seedBookFiles({ chapters: 3 }));
      const ai = fakeAi();
      const { session: autopilot, events } = session(store, ai);
      when(autopilot, started(kind), () => autopilot.pause(mode));
      await autopilot.start(THREE);
      await autopilot.waitForIdle();
      const state = stateOf(store);
      outcomes.push({ status: state.status, phase: state.phase, message: state.message, labels: labelsOf(ai), ended: runEnded(events).map((event) => [event.status, event.message, event.code]), tasks: state.stats.tasks });
    }
    assert.deepEqual(outcomes[1], outcomes[0], `${kind}: the same outcome`);
    assert.equal(outcomes[1].message, null, `${kind}: there is no chapter to say`);
    assert.equal(outcomes[1].ended[0][2], undefined, `${kind}: and no code for a chapter`);
  }

  // The last step of the book: after it there is nothing to pause before, and the run says what the planner says, that the book is complete.
  const finished = new MemoryBookStore(seedBookFiles({ chapters: 3 }));
  const last = fakeAi();
  const { session: closing, events: closingEvents } = session(finished, last);
  when(closing, started("final"), () => closing.pause("after-chapter"));
  await closing.start(THREE);
  await closing.waitForIdle();
  assert.equal(stateOf(finished).status, "completed");
  assert.equal(stateOf(finished).message, "The book is complete.");
  assert.equal(labelsOf(last).at(-1), "director:book", "the director's judgement of the whole book is the last call");
  assert.equal(runEnded(closingEvents)[0].code, undefined);
  assert.equal(await pendingOf(closing), null, "and nothing is left waiting");
  const store = new MemoryBookStore(seedBookFiles({ chapters: 3 }));
  const ai = fakeAi();
  const { session: autopilot } = session(store, ai);
  when(autopilot, started("plan"), () => autopilot.pause("after-chapter"));
  await autopilot.start(THREE);
  await autopilot.waitForIdle();
  const state = stateOf(store);
  assert.equal(state.status, "paused");
  assert.equal(state.plan.chapters.length, 3, "the plan step that was running was saved");
  assert.equal(state.plan.approved, false, "and the next one (the director's review of the plan) did not start");
  assert.ok(!labelsOf(ai).includes("autopilot:plan-review"));
});

test("requests combine: the pause after the step wins over the pause at the end of the chapter, and stopping now wins over both", async () => {
  const { ai, gate, reached } = holdingAi((request) => request.label === "autopilot:write:1.1");
  const store = new MemoryBookStore(seedBookFiles({ chapters: 3 }));
  const { session: autopilot } = session(store, ai);
  await autopilot.start(THREE);
  await reached;
  assert.equal(await pendingOf(autopilot), null, "nothing is waiting yet");

  assert.equal(autopilot.pause("after-chapter"), true);
  assert.equal(await pendingOf(autopilot), "after-chapter");
  assert.equal(autopilot.pause("after-step"), true);
  assert.equal(await pendingOf(autopilot), "after-step", "it stops sooner, so it is what happens");
  assert.equal(autopilot.pause("after-chapter"), true);
  assert.equal(await pendingOf(autopilot), "after-step", "and a later, looser request does not undo it");
  gate.resolve();
  await autopilot.waitForIdle();
  let state = stateOf(store);
  assert.equal(state.status, "paused");
  assert.notEqual(state.plan.chapters[0].status, "done", "it stopped right after the step, in the middle of chapter 1");
  assert.equal(state.message, null);
  assert.ok(!labelsOf(ai).includes("autopilot:consolidate:1"));

  const now = holdingAi((request) => request.label === "autopilot:write:1.1");
  const second = new MemoryBookStore(seedBookFiles({ chapters: 3 }));
  const { session: other, events } = session(second, now.ai);
  await other.start(THREE);
  await now.reached;
  other.pause("after-chapter");
  other.pause("now");
  await other.waitForIdle();
  state = stateOf(second);
  assert.equal(state.status, "paused");
  assert.ok(events.some((event) => event.type === "task-finished" && event.activity.status === "cancelled"), "the request in flight was abandoned");
  assert.equal(await pendingOf(other), null, "nothing is waiting after a pause that already happened");
});

test("a pause that is waiting can be cancelled: the run goes on to the end, and a pause that already happened cannot", async () => {
  for (const mode of ["after-chapter", "after-step"]) {
    const { ai, gate, reached } = holdingAi((request) => request.label === "autopilot:write:1.1");
    const store = new MemoryBookStore(seedBookFiles({ chapters: 3 }));
    const { session: autopilot } = session(store, ai);
    assert.equal(autopilot.cancelPause(), false, "nothing runs: nothing to cancel");
    await autopilot.start(THREE);
    await reached;
    assert.equal(autopilot.cancelPause(), false, "a run with nothing pending: nothing to cancel");
    autopilot.pause(mode);
    assert.equal(autopilot.cancelPause(), true, `${mode} was waiting`);
    assert.equal(await pendingOf(autopilot), null);
    assert.equal(autopilot.cancelPause(), false, "once is enough");
    gate.resolve();
    await autopilot.waitForIdle();
    const state = stateOf(store);
    assert.equal(state.status, "completed", `${mode}: nothing stopped the run`);
    assert.deepEqual(chapterStatuses(state), ["done", "done", "done"]);
  }

  const { ai, reached } = holdingAi((request) => request.label === "autopilot:write:1.1");
  const store = new MemoryBookStore(seedBookFiles({ chapters: 3 }));
  const { session: autopilot } = session(store, ai);
  await autopilot.start(THREE);
  await reached;
  autopilot.pause("now");
  assert.equal(autopilot.cancelPause(), false, "stopping now has already happened");
  await autopilot.waitForIdle();
  assert.equal(stateOf(store).status, "paused");
});

test("asked before the run has started, the pause works like the others and can be cancelled too; and resuming repeats nothing", async () => {
  const baseline = await baselineLabels();
  const store = new MemoryBookStore(seedBookFiles({ chapters: 3 }));
  const ai = fakeAi();
  const { session: autopilot, events } = session(store, ai);
  when(autopilot, started("write", 1, 1), () => autopilot.pause("after-step"));
  await autopilot.start(THREE);
  await autopilot.waitForIdle();
  assert.ok(["writing", "review"].includes(stateOf(store).plan.chapters[0].status), "stopped in the middle of chapter 1: it has been started and is not closed");

  const resuming = autopilot.start();
  assert.equal(autopilot.pause("after-chapter"), true, "accepted while the start is in flight");
  await resuming;
  await autopilot.waitForIdle();
  let state = stateOf(store);
  assert.equal(state.status, "paused");
  assert.deepEqual(chapterStatuses(state), ["done", "planned", "planned"], "the run took chapter 1 to its end");
  assert.equal(state.message, "Chapter 1 completed: paused, as you asked.");
  assert.equal(runEnded(events).at(-1).code, "chapterPause");

  const cancelled = autopilot.start();
  assert.equal(autopilot.pause("after-chapter"), true);
  assert.equal(autopilot.cancelPause(), true, "a request that is waiting for the run to exist can be cancelled too");
  await cancelled;
  await autopilot.waitForIdle();
  state = stateOf(store);
  assert.equal(state.status, "completed", "nothing paused it: it went on from chapter 2, not from the start");
  assert.deepEqual(labelsOf(ai), baseline, "the three runs together made exactly the calls of one uninterrupted run: nothing repeated, nothing skipped");
});

test("resuming after the pause continues with chapter 2 and repeats nothing", async () => {
  const baseline = await baselineLabels();
  const store = new MemoryBookStore(seedBookFiles({ chapters: 3 }));
  const ai = fakeAi();
  const { session: autopilot } = session(store, ai);
  when(autopilot, started("write", 1, 1), () => autopilot.pause("after-chapter"));
  await autopilot.start(THREE);
  await autopilot.waitForIdle();
  const first = labelsOf(ai).length;
  assert.equal(stateOf(store).status, "paused");

  await autopilot.start();
  await autopilot.waitForIdle();
  assert.equal(labelsOf(ai)[first], "autopilot:scenes:2", "the first call of the second run is the first step of chapter 2");
  assert.equal(stateOf(store).status, "completed");
  assert.deepEqual(labelsOf(ai), baseline, "nothing repeated, nothing skipped");
});

test("the pause that is waiting is in the summary, in the snapshot and in a state event whenever it changes, and is never saved", async () => {
  const { ai, gate, reached } = holdingAi((request) => request.label === "autopilot:write:1.1");
  const store = new MemoryBookStore(seedBookFiles({ chapters: 3 }));
  const { session: autopilot, events } = session(store, ai);
  const states = () => events.filter((event) => event.type === "state");
  assert.equal((await autopilot.snapshot()).summary ?? null, null, "no state, no summary");
  await autopilot.start(THREE);
  await reached;
  const before = states().length;
  assert.equal(states().at(-1).state.pausePending, null, "the summaries of a run say that nothing is waiting");

  autopilot.pause("after-chapter");
  assert.equal(states().length, before + 1, "a change of the pause is a state event");
  const event = states().at(-1).state;
  assert.equal(event.pausePending, "after-chapter");
  assert.equal(event.status, "running", "it is the summary of the run, not a fragment");
  assert.ok(event.runner, "with its runner");
  const snapshot = await autopilot.snapshot();
  assert.equal(snapshot.summary.pausePending, "after-chapter", "a client that connects now sees it");
  assert.equal(snapshot.summary.status, "running");
  assert.equal(snapshot.state.status, "running");

  autopilot.pause("after-chapter");
  assert.equal(states().length, before + 1, "no event when nothing changed");
  autopilot.pause("after-step");
  assert.equal(states().at(-1).state.pausePending, "after-step");
  autopilot.cancelPause();
  assert.equal(states().at(-1).state.pausePending, null);
  assert.equal(states().length, before + 3, "one event per change");
  assert.ok(!store.files.get(STATE).includes("pausePending"), "nothing of it is saved in the state file");

  autopilot.pause("after-chapter");
  gate.resolve();
  await autopilot.waitForIdle();
  assert.equal(states().at(-1).state.status, "paused");
  assert.equal(states().at(-1).state.pausePending, null, "the last summary of a run that paused has nothing waiting");
  assert.equal((await autopilot.snapshot()).summary.pausePending, null);
  assert.ok(!store.files.get(STATE).includes("pausePending"));
});

test("the heartbeat of a live run goes on saying the pause that waits and the limits of the run", async () => {
  const { ai, gate, reached } = holdingAi((request) => request.label === "autopilot:write:1.1");
  const store = new MemoryBookStore(seedBookFiles({ chapters: 3 }));
  const { session: autopilot, events } = session(store, ai, { heartbeatMs: 5, persistHeartbeatMs: 0 });
  await autopilot.start({ ...THREE, limits: { steps: 50, chapters: 2 } });
  await reached;
  autopilot.pause("after-chapter");
  const mark = events.length;
  const beats = () => events.slice(mark).filter((event) => event.type === "state" && event.state.runner && event.state.status === "running");
  await waitFor(() => beats().length >= 4, "four heartbeats after the request");
  for (const { state } of beats()) {
    assert.equal(state.pausePending, "after-chapter");
    assert.deepEqual([state.limits.steps, state.limits.chapters], [50, 2]);
  }
  gate.resolve();
  await autopilot.waitForIdle();
});

test("a run answers the same requests as the session, and `now` cannot be undone", async () => {
  const run = new AutopilotRun({ bookId: "book-1", store: new MemoryBookStore(seedBookFiles({ chapters: 3 })), ai: fakeAi(), host: "server", hostLabel: "test-host", retryDelayMs: 0, emit: () => undefined });
  assert.equal(run.pausePending, null);
  assert.equal(run.cancelPause(), false);
  run.stopAfterChapter();
  assert.equal(run.pausePending, "after-chapter");
  run.stopAfterStep();
  assert.equal(run.pausePending, "after-step");
  run.stopAfterChapter();
  assert.equal(run.pausePending, "after-step", "the sooner request stays");
  assert.equal(run.cancelPause(), true);
  assert.equal(run.pausePending, null);
  assert.equal(run.cancelPause(), false);
  run.stopAfterChapter();
  run.stop();
  assert.equal(run.pausePending, null, "a stop that happened is not waiting");
  assert.equal(run.cancelPause(), false);
});

test("a pause at the end of the chapter does not cut the wait before a retry of a step of the chapter, but does cut the wait of a step with no chapter", async () => {
  // A step of chapter 1 fails and waits to be retried: the chapter still has to be finished, so the wait goes on.
  const store = new MemoryBookStore(seedBookFiles({ chapters: 3 }));
  const ai = failingOnce("autopilot:write:1.1", new AiProviderError("overloaded", 503, true));
  const { session: autopilot, events } = session(store, ai, { retryDelayMs: 60_000 });
  when(autopilot, (event) => event.type === "insight" && event.code === "failureRetry", () => autopilot.pause("after-chapter"));
  await autopilot.start(THREE);
  await waitFor(() => events.some((event) => event.type === "insight" && event.code === "failureRetry"), "the failure of the step");
  await sleep(60);
  assert.equal(autopilot.running, true, "still waiting to retry the step: the chapter is not finished");
  assert.equal(runEnded(events).length, 0);
  assert.equal(await pendingOf(autopilot), "after-chapter");
  autopilot.pause("after-step");
  await waitFor(() => !autopilot.running, "the wait to end when the pause after the step is asked");
  assert.equal(stateOf(store).status, "paused");

  // A step with no chapter (the concept) fails: there is no chapter to wait for, so it is the pause after the step and the wait ends.
  const second = new MemoryBookStore(seedBookFiles({ chapters: 3 }));
  const failing = failingOnce("autopilot:concept", new AiProviderError("overloaded", 503, true));
  const { session: other, events: otherEvents } = session(second, failing, { retryDelayMs: 60_000 });
  when(other, (event) => event.type === "insight" && event.code === "failureRetry", () => other.pause("after-chapter"));
  await other.start(THREE);
  await waitFor(() => !other.running, "the wait of a step with no chapter to end");
  const state = stateOf(second);
  assert.equal(state.status, "paused");
  assert.equal(state.concept.done, false, "the failed step was not saved");
  assert.equal(state.message, null);
  assert.equal(runEnded(otherEvents).length, 1);
});

test("the review of the chapter is part of it: readers, specialists, the director's round of fixes and the second review all happen before the pause", async () => {
  const store = new MemoryBookStore(seedBookFiles({ chapters: 3 }));
  // The director asks for changes in the first round and approves in the second: the chapter goes through a repair and a second review.
  const ai = createFakeAutopilotAi({ chapters: 3, scenes: 1 });
  const { session: autopilot } = session(store, ai);
  when(autopilot, started("write", 1, 1), () => autopilot.pause("after-chapter"));
  await autopilot.start({ brief: THREE.brief, options: { readers: true, maxReaders: 2, readersOnPlan: false, specialists: true, pauseAfterPlan: false } });
  await autopilot.waitForIdle();

  const labels = labelsOf(ai);
  assert.equal(labels.at(-1), "autopilot:consolidate:1", "the last call is still the closing of chapter 1");
  assert.equal(labels.filter((label) => label.startsWith("reader-evaluation:")).length, 2, "the two readers read the chapter");
  assert.ok(labels.includes("reader-evaluation-summary"));
  assert.equal(labels.filter((label) => label === "autopilot:specialists:1").length, 2, "and the specialists check it in both rounds");
  assert.equal(labels.filter((label) => label === "autopilot:director-review:1").length, 2, "the director judges it twice");
  assert.ok(labels.includes("autopilot:repair:1.1"), "with a round of fixes between");
  assert.ok(!labels.some((label) => /:2(\.|$)/.test(label)), "chapter 2 never started");
  const state = stateOf(store);
  assert.equal(state.status, "paused");
  assert.deepEqual(chapterStatuses(state), ["done", "planned", "planned"]);
  assert.equal(state.message, "Chapter 1 completed: paused, as you asked.");
});

test("a pause at the end of the chapter and the option to pause after every chapter say their own words, and the request is the one that is reported", async () => {
  const store = new MemoryBookStore(seedBookFiles({ chapters: 3 }));
  const ai = fakeAi();
  const { session: autopilot, events } = session(store, ai);
  when(autopilot, started("write", 1, 1), () => autopilot.pause("after-chapter"));
  await autopilot.start({ ...THREE, options: { ...FAST, pauseAfterEachChapter: true } });
  await autopilot.waitForIdle();
  assert.equal(stateOf(store).message, "Chapter 1 completed: paused, as you asked.", "the author asked for this pause just now");
  assert.equal(runEnded(events)[0].code, "chapterPause");

  await autopilot.start();
  await autopilot.waitForIdle();
  assert.equal(stateOf(store).message, "Chapter 2 approved: read it and resume.", "without a request the option speaks as it always did");
  assert.equal(runEnded(events).at(-1).code, undefined);
});
