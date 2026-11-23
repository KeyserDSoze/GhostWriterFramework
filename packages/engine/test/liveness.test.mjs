import test from "node:test";
import assert from "node:assert/strict";
import * as engine from "../dist/index.js";
import { MemoryBookStore, createFakeAutopilotAi, seedBookFiles } from "../dist/testing/index.js";

// New exports are read from the namespace so that, before they exist, each test fails on its own.
const { AutopilotSession, BookConflictError, RUNNER_STALE_MINUTES, parseAutopilotState, runnerActivity, runnerHeartbeatAgeMs } = engine;

const STATE = "autopilot/state.json";
const ACTIVITY = "autopilot/activity.json";
const HEARTBEAT = "Autopilot: heartbeat";
const FAST = { readers: false, readersOnPlan: false, pauseAfterPlan: false };
const ONE_CHAPTER = { brief: { idea: "x", targetChapters: 1, scenesPerChapter: 1, wordsPerScene: 300 }, options: FAST };
const TWO_CHAPTERS = { brief: { idea: "x", targetChapters: 2, scenesPerChapter: 1, wordsPerScene: 300 }, options: FAST };

function session(store, ai, extra = {}) {
  const events = [];
  const instance = new AutopilotSession({ bookId: "book-1", store, ai, host: "server", hostLabel: "test-host", hostId: "server-1", retryDelayMs: 0, ...extra });
  instance.subscribe((event) => events.push(event));
  return { session: instance, events };
}

function otherHost(store, now) {
  return new AutopilotSession({ bookId: "book-1", store, ai: createFakeAutopilotAi(), host: "browser", hostLabel: "Browser", hostId: "device-1", retryDelayMs: 0, ...(now ? { now } : {}) });
}

function stateOf(store) {
  return parseAutopilotState(store.files.get(STATE));
}

function deferred() {
  let resolve = () => undefined;
  const promise = new Promise((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

async function waitFor(predicate, what, timeoutMs = 4000) {
  const deadline = Date.now() + timeoutMs;
  while (!(await predicate())) {
    if (Date.now() > deadline) assert.fail(`Timed out waiting for ${what}.`);
    await sleep(4);
  }
}

/** A clock the test moves by hand: simulated minutes pass in no real time at all. */
function manualClock(start = "2026-03-01T10:00:00.000Z") {
  let time = Date.parse(start);
  return {
    now: () => new Date(time),
    advance(ms) {
      time += ms;
    },
    get time() {
      return time;
    },
  };
}

/** The fake AI, where every call first waits for `before(call number, request)`. */
function gatedAi(before, options = {}) {
  const base = createFakeAutopilotAi(options);
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

/** An AI whose request never answers, but stops when it is abandoned. */
function hangingAi() {
  const ai = {
    calls: [],
    complete(request) {
      ai.calls.push(request);
      return new Promise((_, reject) => {
        request.signal?.addEventListener("abort", () => reject(request.signal.reason), { once: true });
      });
    },
  };
  return ai;
}

const heartbeatsOf = (store) => store.commits.filter((commit) => commit.message === HEARTBEAT);

/** Takes the book from a run that is alive; a write that lands between the start's read and its commit is simply tried again, as a host would. */
async function takeOver(autopilot) {
  for (let attempt = 0; ; attempt += 1) {
    try {
      return await autopilot.start({ force: true });
    } catch (error) {
      if (!(error instanceof BookConflictError) || attempt >= 5) throw error;
    }
  }
}

// ─── (c) what the interfaces can read ───────────────────────────────────────

test("runnerHeartbeatAgeMs tells the interfaces how old the runner's heartbeat is; runnerActivity keeps its 20-minute limit", () => {
  assert.equal(typeof runnerHeartbeatAgeMs, "function", "exported");
  const at = new Date("2026-03-01T10:00:00.000Z");
  const running = (heartbeatAt) => ({ status: "running", runner: { host: "server", label: "home", runId: "run-1", startedAt: "2026-03-01T09:00:00.000Z", heartbeatAt } });
  assert.equal(runnerHeartbeatAgeMs(running("2026-03-01T09:59:30.000Z"), at), 30_000);
  assert.equal(runnerHeartbeatAgeMs(running("2026-03-01T10:00:00.000Z"), at), 0);
  assert.equal(runnerHeartbeatAgeMs(running("2026-03-01T10:05:00.000Z"), at), 0, "a clock that runs ahead never makes the age negative");
  assert.equal(runnerHeartbeatAgeMs({ status: "paused", runner: null }, at), null, "nobody runs");
  assert.equal(runnerHeartbeatAgeMs(null, at), null);
  assert.equal(runnerHeartbeatAgeMs(running("not a date"), at), null, "a heartbeat nobody can read has no age");
  const recent = running(new Date(Date.now() - 5000).toISOString());
  const age = runnerHeartbeatAgeMs(recent);
  assert.ok(age >= 4900 && age < 15_000, `the clock defaults to now: ${age}`);
  assert.equal(runnerHeartbeatAgeMs({ runner: running("2026-03-01T09:59:00.000Z").runner }, at), 60_000, "the summary of a live event works as well as the state");

  assert.equal(RUNNER_STALE_MINUTES, 20, "the limit itself is unchanged");
  assert.equal(runnerActivity(running("2026-03-01T09:40:00.000Z"), at), "active", "exactly 20 minutes is still alive");
  assert.equal(runnerActivity(running("2026-03-01T09:39:59.000Z"), at), "stale");
  assert.equal(runnerActivity({ status: "paused", runner: null }, at), "none");
});

// ─── (b) a long step keeps its lease ────────────────────────────────────────

test("a step that lasts longer than the stale limit stays 'active' for another host's snapshot, and the AI is called once", async () => {
  const clock = manualClock();
  const store = new MemoryBookStore(seedBookFiles({ chapters: 1 }));
  const reached = deferred();
  const release = deferred();
  const ai = gatedAi((call) => {
    if (call !== 1) return undefined;
    reached.resolve();
    return release.promise;
  });
  const { session: autopilot, events } = session(store, ai, { now: clock.now, persistHeartbeatMs: 20, heartbeatMs: 0 });
  await autopilot.start(ONE_CHAPTER);
  await reached.promise;
  const startedAt = clock.time;
  const viewer = otherHost(store, clock.now);

  for (let minutes = 5; minutes <= 35; minutes += 5) {
    clock.advance(5 * 60_000);
    const due = clock.time;
    await waitFor(() => Date.parse(stateOf(store).runner?.heartbeatAt ?? "") >= due, `a heartbeat saved after ${minutes} simulated minutes`);
    const seen = (await viewer.snapshot()).state;
    assert.equal(seen.status, "running", `${minutes} minutes into the step`);
    assert.equal(runnerActivity(seen, clock.now()), "active", `${minutes} minutes into the step`);
    assert.ok(runnerHeartbeatAgeMs(seen, clock.now()) < 5 * 60_000 + 1, "the age the interfaces show is small");
  }
  assert.ok(clock.time - startedAt > RUNNER_STALE_MINUTES * 60_000, "the step outlived the stale limit");
  assert.equal(ai.calls.length, 0, "the request of the step is still being held: the heartbeats asked for nothing");
  release.resolve();
  await autopilot.waitForIdle();
  assert.equal(ai.calls.filter((call) => call.label === "autopilot:concept").length, 1, "the long step was made once");
  const final = stateOf(store);
  assert.equal(final.status, "completed");
  assert.equal(final.runner, null);
  assert.ok(!events.some((event) => event.type === "insight" && (event.code === "conflictRetry" || event.code === "failureRetry")), "no step was repeated");
});

test("without the persisted heartbeat the same long step looks interrupted to another host (the control of the test above)", async () => {
  const clock = manualClock();
  const store = new MemoryBookStore(seedBookFiles({ chapters: 1 }));
  const reached = deferred();
  const release = deferred();
  const ai = gatedAi((call) => {
    if (call !== 1) return undefined;
    reached.resolve();
    return release.promise;
  });
  const { session: autopilot } = session(store, ai, { now: clock.now, persistHeartbeatMs: 0, heartbeatMs: 0 });
  await autopilot.start(ONE_CHAPTER);
  await reached.promise;
  clock.advance(25 * 60_000);
  await sleep(60);
  const seen = (await otherHost(store, clock.now).snapshot()).state;
  assert.equal(runnerActivity(stateOf(store), clock.now()), "stale", "the file says nothing for 25 minutes");
  assert.equal(seen.status, "paused");
  assert.match(seen.message, /Interrupted/);
  release.resolve();
  await autopilot.waitForIdle();
});

async function runWholeBook(extra, start = TWO_CHAPTERS, aiOptions = { delayMs: 8 }) {
  const store = new MemoryBookStore(seedBookFiles({ chapters: 1 }));
  const ai = createFakeAutopilotAi(aiOptions);
  const { session: autopilot, events } = session(store, ai, extra);
  await autopilot.start(start);
  await autopilot.waitForIdle();
  return { store, ai, events, state: stateOf(store) };
}

test("heartbeats at every few milliseconds never add, repeat or fail an AI call or a step commit", async () => {
  const baseline = await runWholeBook({ persistHeartbeatMs: 0, heartbeatMs: 0 });
  assert.equal(baseline.state.status, "completed");
  assert.equal(heartbeatsOf(baseline.store).length, 0, "a switched-off heartbeat writes nothing");

  const beating = await runWholeBook({ persistHeartbeatMs: 3, heartbeatMs: 2 });
  assert.equal(beating.state.status, "completed");
  assert.ok(heartbeatsOf(beating.store).length >= 3, `heartbeats were saved: ${heartbeatsOf(beating.store).length}`);
  assert.deepEqual(beating.ai.calls.map((call) => call.label), baseline.ai.calls.map((call) => call.label), "the same AI calls, in the same order");
  assert.deepEqual(beating.store.commits.filter((commit) => commit.message !== HEARTBEAT).map((commit) => commit.message), baseline.store.commits.map((commit) => commit.message), "the same commits apart from the heartbeats");
  assert.equal(beating.state.stats.aiCalls, baseline.state.stats.aiCalls);
  assert.equal(beating.state.stats.tasks, baseline.state.stats.tasks);
  assert.equal(beating.state.stats.failures, 0);
  assert.ok(!beating.events.some((event) => event.type === "insight" && (event.code === "conflictRetry" || event.code === "failureRetry")), "no step was repeated");
  assert.ok(!beating.events.some((event) => event.type === "task-finished" && event.activity.status !== "succeeded"));
  assert.equal(beating.state.runner, null);
  assert.notEqual(beating.store.commits.at(-1).message, HEARTBEAT, "the run's own end is the last word");
});

test("a heartbeat is written at most once per period, only while a step is in flight, and never when the step is short", async () => {
  class Timed extends MemoryBookStore {
    heartbeatTimes = [];
    async commit(changes, message) {
      if (message === HEARTBEAT) this.heartbeatTimes.push(Date.now());
      return super.commit(changes, message);
    }
  }
  const store = new Timed(seedBookFiles({ chapters: 1 }));
  const ai = createFakeAutopilotAi({ delayMs: 320 });
  const { session: autopilot } = session(store, ai, { persistHeartbeatMs: 70, heartbeatMs: 0 });
  autopilot.subscribe((event) => {
    if (event.type === "task-finished") autopilot.pause("after-step");
  });
  const startedAt = Date.now();
  await autopilot.start(ONE_CHAPTER);
  await autopilot.waitForIdle();
  const elapsed = Date.now() - startedAt;
  assert.equal(ai.calls.length, 1, "one step of about 320 ms");
  const times = store.heartbeatTimes;
  assert.ok(times.length >= 1 && times.length <= Math.floor(elapsed / 70) + 1, `${times.length} heartbeats for a step of ${elapsed} ms and a 70 ms period`);
  for (let index = 1; index < times.length; index += 1) assert.ok(times[index] - times[index - 1] >= 65, `heartbeats ${times[index] - times[index - 1]} ms apart`);
  assert.equal(stateOf(store).status, "paused");
  assert.equal(store.commits.at(-1).message, "Autopilot: paused", "nothing is written after the run closed");
  await sleep(150);
  assert.equal(store.heartbeatTimes.length, times.length, "no heartbeat after the run ended");

  const short = await runWholeBook({ persistHeartbeatMs: 5000, heartbeatMs: 0 }, ONE_CHAPTER, { delayMs: 1 });
  assert.equal(short.state.status, "completed");
  assert.equal(heartbeatsOf(short.store).length, 0, "a run whose steps are shorter than the period writes none");
});

test("a heartbeat never overlaps the step's own commit or the run's closing commit, and never makes them fail", async () => {
  class Windows extends MemoryBookStore {
    inFlight = [];
    overlaps = [];
    failed = [];
    async commit(changes, message) {
      if (this.inFlight.length) this.overlaps.push([message, ...this.inFlight]);
      this.inFlight.push(message);
      try {
        if (message !== HEARTBEAT) await sleep(25);
        return await super.commit(changes, message);
      } catch (error) {
        this.failed.push([message, error.message]);
        throw error;
      } finally {
        this.inFlight.splice(this.inFlight.indexOf(message), 1);
      }
    }
  }
  const store = new Windows(seedBookFiles({ chapters: 1 }));
  const { session: autopilot, events } = session(store, createFakeAutopilotAi({ delayMs: 6 }), { persistHeartbeatMs: 4, heartbeatMs: 0 });
  await autopilot.start(ONE_CHAPTER);
  await autopilot.waitForIdle();
  assert.equal(stateOf(store).status, "completed");
  assert.ok(heartbeatsOf(store).length >= 3, "the heartbeats really ran");
  assert.deepEqual(store.overlaps.filter((entry) => entry.includes(HEARTBEAT)), [], "no heartbeat started while another commit was being written, and none was overtaken by one");
  assert.deepEqual(store.failed.filter(([message]) => message !== HEARTBEAT), [], "no step commit or closing commit was rejected");
  assert.ok(!events.some((event) => event.type === "insight" && event.code === "conflictRetry"));
});

test("a heartbeat that conflicts is ignored and tried again at the next tick; the run is untouched", async () => {
  class Conflicting extends MemoryBookStore {
    attempts = 0;
    async commit(changes, message) {
      if (message === HEARTBEAT) {
        this.attempts += 1;
        throw new BookConflictError("File changed since it was read: autopilot/state.json", STATE);
      }
      return super.commit(changes, message);
    }
  }
  const baseline = await runWholeBook({ persistHeartbeatMs: 0, heartbeatMs: 0 }, ONE_CHAPTER);
  const store = new Conflicting(seedBookFiles({ chapters: 1 }));
  const ai = createFakeAutopilotAi({ delayMs: 8 });
  const { session: autopilot, events } = session(store, ai, { persistHeartbeatMs: 3, heartbeatMs: 0 });
  await autopilot.start(ONE_CHAPTER);
  await autopilot.waitForIdle();
  assert.equal(stateOf(store).status, "completed");
  assert.ok(store.attempts >= 3, `it was tried again: ${store.attempts} attempts`);
  assert.equal(heartbeatsOf(store).length, 0, "none of them was saved");
  assert.deepEqual(ai.calls.map((call) => call.label), baseline.ai.calls.map((call) => call.label));
  assert.ok(!events.some((event) => event.type === "insight" && ["takenOver", "conflictRetry", "failureRetry", "unexpectedStop"].includes(event.code)), "a conflicting heartbeat is no event at all");
});

test("a store that fails while the heartbeat is written does not stop the run either", async () => {
  class Broken extends MemoryBookStore {
    async commit(changes, message) {
      if (message === HEARTBEAT) throw new Error("IndexedDB: transaction aborted");
      return super.commit(changes, message);
    }
  }
  const store = new Broken(seedBookFiles({ chapters: 1 }));
  const ai = createFakeAutopilotAi({ delayMs: 8 });
  const { session: autopilot, events } = session(store, ai, { persistHeartbeatMs: 3, heartbeatMs: 0 });
  await autopilot.start(ONE_CHAPTER);
  await autopilot.waitForIdle();
  assert.equal(stateOf(store).status, "completed");
  assert.equal(stateOf(store).stats.failures, 0);
  assert.ok(!events.some((event) => event.type === "insight" && ["failureRetry", "unexpectedStop"].includes(event.code)));
});

// ─── the lease is still lost to another runner, and found out sooner ────────

test("another runner taking the book during a long step is still detected when the step ends: the old run writes nothing", async () => {
  const store = new MemoryBookStore(seedBookFiles({ chapters: 1 }));
  const reached = deferred();
  const release = deferred();
  const aiA = gatedAi((call) => {
    if (call !== 1) return undefined;
    reached.resolve();
    return release.promise;
  });
  const holdB = holdingAi((request, call) => call === 3);
  const a = session(store, aiA, { persistHeartbeatMs: 25, heartbeatMs: 0 });
  const b = session(store, holdB.ai, { host: "browser", hostLabel: "Browser", hostId: "device-1", persistHeartbeatMs: 0, heartbeatMs: 0 });
  await a.session.start(ONE_CHAPTER);
  await reached.promise;
  await takeOver(b.session);
  await holdB.reached;
  const stateBefore = store.files.get(STATE);
  const activityBefore = store.files.get(ACTIVITY);
  const commitsBefore = store.commits.length;

  release.resolve();
  await a.session.waitForIdle();
  assert.equal(store.files.get(STATE), stateBefore, "the old run left the new owner's state alone");
  assert.equal(store.files.get(ACTIVITY), activityBefore);
  assert.equal(store.commits.length, commitsBefore, "and wrote nothing at all");
  const taken = a.events.filter((event) => event.type === "insight" && event.code === "takenOver");
  assert.equal(taken.length, 1, "reported once");
  const ended = a.events.filter((event) => event.type === "run-ended");
  assert.equal(ended.length, 1);
  assert.equal(ended[0].code, "takenOver");

  holdB.gate.resolve();
  await b.session.waitForIdle();
  assert.equal(stateOf(store).status, "completed", "the new owner finished the book");
});

test("a heartbeat that finds another runner's id stops the old run at once: its request in flight is abandoned and nothing more is written", async () => {
  const store = new MemoryBookStore(seedBookFiles({ chapters: 1 }));
  const aiA = hangingAi();
  const holdB = holdingAi((request, call) => call === 1);
  const a = session(store, aiA, { persistHeartbeatMs: 140, heartbeatMs: 0 });
  const b = session(store, holdB.ai, { host: "browser", hostLabel: "Browser", hostId: "device-1", persistHeartbeatMs: 0, heartbeatMs: 0 });
  await a.session.start(ONE_CHAPTER);
  await waitFor(() => aiA.calls.length === 1, "the old run's first request");
  await takeOver(b.session);
  await holdB.reached;
  const stateBefore = store.files.get(STATE);
  const commitsBefore = store.commits.length;
  const heartbeatsBefore = heartbeatsOf(store).length;

  await waitFor(() => !a.session.running, "the old run noticing it lost the book", 3000);
  assert.equal(aiA.calls.length, 1, "the old request was abandoned, not repeated");
  assert.equal(store.files.get(STATE), stateBefore, "the new owner's state was not touched");
  assert.equal(store.commits.length, commitsBefore, "the old run wrote nothing after the takeover");
  assert.equal(a.events.filter((event) => event.type === "insight" && event.code === "takenOver").length, 1);
  const ended = a.events.find((event) => event.type === "run-ended");
  assert.equal(ended.code, "takenOver");
  assert.equal(ended.status, "paused");
  assert.equal(heartbeatsOf(store).length, heartbeatsBefore, "the heartbeat that found the other runner wrote nothing");

  holdB.gate.resolve();
  await b.session.waitForIdle();
  assert.equal(stateOf(store).status, "completed");
});

test("a heartbeat does not bring back a runner that somebody else cleared", async () => {
  const store = new MemoryBookStore(seedBookFiles({ chapters: 1 }));
  const reached = deferred();
  const release = deferred();
  const ai = gatedAi((call) => {
    if (call !== 1) return undefined;
    reached.resolve();
    return release.promise;
  });
  const { session: autopilot } = session(store, ai, { persistHeartbeatMs: 15, heartbeatMs: 0 });
  await autopilot.start(ONE_CHAPTER);
  await reached.promise;
  store.write(STATE, `${JSON.stringify({ ...stateOf(store), status: "paused", runner: null })}\n`);
  const heartbeatsBefore = heartbeatsOf(store).length;
  await sleep(80);
  assert.equal(stateOf(store).runner, null, "nobody owns the book: the heartbeat leaves it so");
  assert.equal(heartbeatsOf(store).length, heartbeatsBefore, "and writes nothing");
  release.resolve();
  await autopilot.waitForIdle();
});

// ─── (a) the live signal ────────────────────────────────────────────────────

test("while a run is active the session emits a state event every heartbeatMs with the current heartbeat, and nothing else is saved", async () => {
  const store = new MemoryBookStore(seedBookFiles({ chapters: 1 }));
  const reached = deferred();
  const release = deferred();
  const ai = gatedAi((call) => {
    if (call !== 1) return undefined;
    reached.resolve();
    return release.promise;
  });
  const { session: autopilot, events } = session(store, ai, { heartbeatMs: 15, persistHeartbeatMs: 0 });
  await autopilot.start(ONE_CHAPTER);
  await reached.promise;
  const stored = stateOf(store).runner.heartbeatAt;
  const mark = events.length;
  await waitFor(() => events.slice(mark).filter((event) => event.type === "state" && event.state.runner).length >= 4, "four live state events");

  const beats = events.slice(mark).filter((event) => event.type === "state" && event.state.runner);
  const stamps = beats.map((event) => Date.parse(event.state.runner.heartbeatAt));
  assert.ok(stamps.every((stamp, index) => index === 0 || stamp > stamps[index - 1]), "every event carries a newer heartbeat than the one before");
  assert.ok(stamps[0] > Date.parse(stored), "the live heartbeat is newer than the one in the file");
  assert.equal(beats[0].state.status, "running");
  assert.equal(beats[0].state.runner.runId, stateOf(store).runner.runId);
  assert.equal(stateOf(store).runner.heartbeatAt, stored, "the file was not written for them");
  const known = new Set(["run-started", "run-ended", "task-started", "task-progress", "task-finished", "insight", "state", "sync"]);
  assert.deepEqual([...new Set(events.map((event) => event.type))].filter((type) => !known.has(type)), [], "no new type of event");

  const snapshot = await autopilot.snapshot();
  assert.ok(Date.parse(snapshot.state.runner.heartbeatAt) >= stamps.at(-1), "the snapshot of a running session reports the live heartbeat");
  assert.equal(snapshot.running, true);
  assert.ok(runnerHeartbeatAgeMs(snapshot.state) < 2000, "so the age shown to the author is small");

  release.resolve();
  await autopilot.waitForIdle();
  const count = events.length;
  await sleep(80);
  assert.equal(events.length, count, "no event after the run ended");
  assert.equal(events.filter((event) => event.type === "state").at(-1).state.runner, null, "the last state is the closed run's");
  assert.equal(stateOf(store).status, "completed");
});

test("the live heartbeats are not kept in the replay buffer: they do not push the meaningful events out", async () => {
  const store = new MemoryBookStore(seedBookFiles({ chapters: 1 }));
  const ai = createFakeAutopilotAi({ delayMs: 80 });
  const { session: autopilot, events } = session(store, ai, { heartbeatMs: 2, persistHeartbeatMs: 0 });
  await autopilot.start(ONE_CHAPTER);
  await autopilot.waitForIdle();
  const isBeat = (event) => event.type === "state" && event.state.runner && event.state.status === "running";
  const beats = events.filter(isBeat);
  const replay = autopilot.recentEvents();
  const steps = stateOf(store).stats.tasks;
  assert.ok(beats.length > steps * 4, `${beats.length} state events with a runner went by for ${steps} steps`);
  assert.ok(replay.filter(isBeat).length <= steps + 2, `${replay.filter(isBeat).length} of them were kept: only the ones the run itself emits`);
  assert.ok(replay.some((event) => event.type === "run-started"), "the start of the run is still in the buffer");
  assert.deepEqual(replay.map((event) => event.seq), [...replay.map((event) => event.seq)].sort((left, right) => left - right), "what is kept stays in order");
});

test("a start that fails, a pause and a run that ends all leave no heartbeat behind", async () => {
  class Unavailable extends MemoryBookStore {
    async read() {
      throw new Error("working copy unavailable");
    }
  }
  const failing = session(new Unavailable(seedBookFiles({ chapters: 1 })), createFakeAutopilotAi(), { heartbeatMs: 5, persistHeartbeatMs: 5 });
  await assert.rejects(() => failing.session.start(ONE_CHAPTER), /working copy unavailable/);
  await sleep(40);
  assert.equal(failing.events.length, 0, "a start that failed emits nothing, not even a heartbeat");

  const store = new MemoryBookStore(seedBookFiles({ chapters: 1 }));
  const { session: autopilot, events } = session(store, createFakeAutopilotAi({ delayMs: 30 }), { heartbeatMs: 5, persistHeartbeatMs: 5 });
  await autopilot.start(ONE_CHAPTER);
  autopilot.pause("now");
  await autopilot.waitForIdle();
  const count = events.length;
  const commits = store.commits.length;
  await sleep(60);
  assert.equal(events.length, count, "no event after a pause");
  assert.equal(store.commits.length, commits, "no commit after a pause");
});
