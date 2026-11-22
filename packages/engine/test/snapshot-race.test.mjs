import test from "node:test";
import assert from "node:assert/strict";
import * as engine from "../dist/index.js";
import { MemoryBookStore, createFakeAutopilotAi, seedBookFiles } from "../dist/testing/index.js";

const { AutopilotSession, parseAutopilotState } = engine;

const STATE = "autopilot/state.json";
const INTERRUPTED = "Interrupted: resume to continue from the last saved step.";
const ONE_CHAPTER = { brief: { idea: "x", targetChapters: 1, scenesPerChapter: 1, wordsPerScene: 300 }, options: { readers: false, readersOnPlan: false, pauseAfterPlan: false } };

function deferred() {
  let resolve = () => undefined;
  const promise = new Promise((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

/** A store whose next read of the autopilot state returns what the file held when the read began, but only after the test lets it. */
class SlowStateStore extends MemoryBookStore {
  slow = null;

  slowDownNextStateRead() {
    const begun = deferred();
    const release = deferred();
    this.slow = { begun, release };
    return { begun: begun.promise, release: () => release.resolve() };
  }

  async read(path) {
    const file = await super.read(path);
    if (path === STATE && this.slow) {
      const { begun, release } = this.slow;
      this.slow = null;
      begun.resolve();
      await release.promise;
    }
    return file;
  }
}

/** Holds the first request until `gate.resolve()`; `reached` says it is being held. */
function holdingFirstRequest() {
  const base = createFakeAutopilotAi();
  const gate = deferred();
  const reached = deferred();
  let held = false;
  return {
    gate,
    reached: reached.promise,
    ai: {
      calls: base.calls,
      async complete(request) {
        if (!held) {
          held = true;
          reached.resolve();
          await gate.promise;
        }
        return base.complete(request);
      },
    },
  };
}

function newSession(store, ai) {
  return new AutopilotSession({ bookId: "book-1", store, ai, host: "server", hostLabel: "test-host", hostId: "server-1", retryDelayMs: 0 });
}

const stateOf = (store) => parseAutopilotState(store.files.get(STATE));

test("a snapshot that was reading the state when the run ended shows how the run ended, not an interruption", async () => {
  const store = new SlowStateStore(seedBookFiles());
  const { ai, gate, reached } = holdingFirstRequest();
  const session = newSession(store, ai);
  await session.start(ONE_CHAPTER);
  await reached;
  assert.equal(stateOf(store).status, "running");

  // The read starts while the step is in flight: it gets the state of a run that is going on.
  const slow = store.slowDownNextStateRead();
  const pending = session.snapshot();
  await slow.begun;

  // The author's pause: the step ends and the run ends with it, while the snapshot is still reading.
  assert.equal(session.pause("after-step"), true);
  gate.resolve();
  await session.waitForIdle();
  assert.equal(session.running, false);
  assert.equal(stateOf(store).status, "paused");

  slow.release();
  const snapshot = await pending;

  assert.equal(snapshot.running, false);
  assert.equal(snapshot.state.status, "paused");
  assert.equal(snapshot.state.message, null, "the pause the author asked for leaves no message: it is not an interruption");
  assert.notEqual(snapshot.state.message, INTERRUPTED);
  assert.equal(snapshot.state.runner, null);
  assert.deepEqual(snapshot.state, stateOf(store), "the snapshot is the state the run left, not the one it had a moment before");
  assert.equal(snapshot.summary.status, "paused");
});

test("a snapshot taken while a run ends agrees with the one taken right after", async () => {
  const store = new SlowStateStore(seedBookFiles());
  const { ai, gate, reached } = holdingFirstRequest();
  const session = newSession(store, ai);
  await session.start(ONE_CHAPTER);
  await reached;

  const slow = store.slowDownNextStateRead();
  const pending = session.snapshot();
  await slow.begun;
  session.pause("after-step");
  gate.resolve();
  await session.waitForIdle();
  slow.release();

  const during = await pending;
  const after = await session.snapshot();
  assert.deepEqual({ running: during.running, status: during.state.status, message: during.state.message }, { running: after.running, status: after.state.status, message: after.state.message });
});

test("a snapshot that was reading the state when a run began does not say the run goes on over the state of one that is not", async () => {
  const store = new SlowStateStore(seedBookFiles());
  const { ai, gate, reached } = holdingFirstRequest();
  const session = newSession(store, ai);

  // Nothing has run yet: the read gets a book without an autopilot state.
  const slow = store.slowDownNextStateRead();
  const pending = session.snapshot();
  await slow.begun;

  await session.start(ONE_CHAPTER);
  await reached;
  slow.release();
  const snapshot = await pending;

  assert.equal(snapshot.running, true);
  assert.equal(snapshot.state?.status, "running", "a snapshot that says a run is going on carries the state of that run");
  assert.equal(snapshot.host, "server");

  session.pause("now");
  gate.resolve();
  await session.waitForIdle();
});

test("a snapshot taken while nothing changes is read once", async () => {
  const store = new SlowStateStore(seedBookFiles());
  const { ai, gate, reached } = holdingFirstRequest();
  const session = newSession(store, ai);
  await session.start(ONE_CHAPTER);
  await reached;

  let reads = 0;
  const read = store.read.bind(store);
  store.read = async (path) => {
    if (path === STATE) reads += 1;
    return read(path);
  };
  const snapshot = await session.snapshot();
  assert.equal(reads, 1, "a run that neither began nor ended during the read needs no second read");
  assert.equal(snapshot.running, true);
  assert.equal(snapshot.state.status, "running");

  session.pause("now");
  gate.resolve();
  await session.waitForIdle();
});
