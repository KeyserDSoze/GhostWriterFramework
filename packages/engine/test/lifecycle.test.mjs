import test from "node:test";
import assert from "node:assert/strict";
import * as engine from "../dist/index.js";
import { MemoryBookStore, createFakeAutopilotAi, seedBookFiles } from "../dist/testing/index.js";

// New exports are read from the namespace so that, before they exist, each test fails on its own.
const { AiProviderError, AutopilotBusyError, AutopilotSession, BookConflictError, isRetryableError, parseAutopilotState, readStoredAutopilot } = engine;

const STATE = "autopilot/state.json";
const ACTIVITY = "autopilot/activity.json";
const FAST = { readers: false, readersOnPlan: false, pauseAfterPlan: false };
const ONE_CHAPTER = { brief: { idea: "x", targetChapters: 1, scenesPerChapter: 1, wordsPerScene: 300 }, options: FAST };

function session(store, ai, extra = {}) {
  const events = [];
  const instance = new AutopilotSession({ bookId: "book-1", store, ai, host: "server", hostLabel: "test-host", hostId: "server-1", retryDelayMs: 0, ...extra });
  instance.subscribe((event) => events.push(event));
  return { session: instance, events };
}

function deferred() {
  let resolve = () => undefined;
  let reject = () => undefined;
  const promise = new Promise((done, fail) => {
    resolve = done;
    reject = fail;
  });
  return { promise, resolve, reject };
}

function stateOf(store) {
  return parseAutopilotState(store.files.get(STATE));
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

/** What a git merge leaves behind when two hosts committed `autopilot/state.json`. */
function conflicted(raw) {
  return `<<<<<<< HEAD\n${raw}=======\n${raw}>>>>>>> origin/main\n`;
}

// ─── A3: concurrent start() ─────────────────────────────────────────────────

test("two concurrent start() calls: the second is refused at once and the first run stays under control", async () => {
  const store = new MemoryBookStore(seedBookFiles());
  const ai = createFakeAutopilotAi({ delayMs: 30 });
  const { session: autopilot } = session(store, ai);
  const [first, second] = await Promise.allSettled([autopilot.start(ONE_CHAPTER), autopilot.start(ONE_CHAPTER)]);
  assert.equal(first.status, "fulfilled");
  assert.equal(second.status, "rejected");
  assert.ok(second.reason instanceof AutopilotBusyError, String(second.reason));
  assert.equal(autopilot.running, true, "the winner is still running");
  assert.ok(stateOf(store).runner, "the winner holds the lease");
  assert.equal(autopilot.pause("now"), true, "and it can be paused");
  await autopilot.waitForIdle();
  assert.equal(autopilot.running, false);
  const state = stateOf(store);
  assert.equal(state.status, "paused");
  assert.equal(state.runner, null);
});

test("a start that fails before the run exists releases the claim, so the session can start again", async () => {
  class FlakyRead extends MemoryBookStore {
    failures = 1;
    async read(path) {
      if (path === STATE && this.failures > 0) {
        this.failures -= 1;
        throw new Error("working copy unavailable");
      }
      return super.read(path);
    }
  }
  const store = new FlakyRead(seedBookFiles());
  const { session: autopilot } = session(store, createFakeAutopilotAi());
  await assert.rejects(() => autopilot.start(ONE_CHAPTER), /working copy unavailable/);
  assert.equal(autopilot.running, false);
  assert.equal(autopilot.pause("now"), false, "nothing to pause");
  await autopilot.start(ONE_CHAPTER);
  await autopilot.waitForIdle();
  assert.equal(stateOf(store).status, "completed");

  const busy = new MemoryBookStore(seedBookFiles());
  const other = session(busy, createFakeAutopilotAi({ delayMs: 30 }), { host: "browser", hostLabel: "Browser", hostId: "device-1" }).session;
  await other.start(ONE_CHAPTER);
  const { session: refused } = session(busy, createFakeAutopilotAi({ delayMs: 30 }));
  await assert.rejects(() => refused.start(), AutopilotBusyError);
  assert.equal(refused.running, false, "a refused start leaves nothing claimed");
  await refused.start({ force: true });
  assert.equal(refused.running, true);
  refused.pause("now");
  other.pause("now");
  await Promise.all([refused.waitForIdle(), other.waitForIdle()]);

  const conflicting = new MemoryBookStore(seedBookFiles());
  let conflicts = 1;
  conflicting.beforeCommit = () => {
    if (conflicts-- > 0) throw new BookConflictError("File changed since it was read: autopilot/state.json", STATE);
  };
  const { session: third } = session(conflicting, createFakeAutopilotAi());
  await assert.rejects(() => third.start(ONE_CHAPTER), BookConflictError);
  assert.equal(third.running, false, "a start whose first commit conflicts leaves nothing claimed");
  await third.start(ONE_CHAPTER);
  await third.waitForIdle();
});

test("while a start is in flight the session is running: the pause is kept, other commands are refused, idle waits for it", async () => {
  class GatedStore extends MemoryBookStore {
    gate = null;
    async read(path) {
      if (this.gate && path === STATE) {
        const gate = this.gate;
        this.gate = null;
        await gate.promise;
      }
      return super.read(path);
    }
  }
  const store = new GatedStore(seedBookFiles());
  const ai = createFakeAutopilotAi();
  const { session: autopilot, events } = session(store, ai);
  const gate = deferred();
  store.gate = gate;
  const starting = autopilot.start(ONE_CHAPTER);
  assert.equal(autopilot.running, true, "running from the first line of start()");
  assert.equal((await autopilot.snapshot()).running, true);
  assert.equal(autopilot.pause("now"), true, "the pause is remembered for the run that is about to exist");
  await assert.rejects(() => autopilot.start(ONE_CHAPTER), AutopilotBusyError);
  await assert.rejects(() => autopilot.configure({ options: { maxReaders: 2 } }), AutopilotBusyError);
  await assert.rejects(() => autopilot.answer({ questionId: "q", answer: "a" }), AutopilotBusyError);
  await assert.rejects(() => autopilot.reset(), AutopilotBusyError);
  let idle = false;
  const waiting = autopilot.waitForIdle().then(() => {
    idle = true;
  });
  await new Promise((resolve) => setTimeout(resolve, 15));
  assert.equal(idle, false, "idle waits for the start in flight");
  gate.resolve();
  await starting;
  await waiting;
  assert.equal(autopilot.running, false);
  assert.equal(stateOf(store).status, "paused");
  assert.equal(ai.calls.length, 0, "the pause came before the first step: nothing was billed");
  assert.ok(events.some((event) => event.type === "run-ended"));
});

test("an intervention sent while a start is in flight reaches the run that starts", async () => {
  class GatedStore extends MemoryBookStore {
    gate = null;
    async read(path) {
      if (this.gate && path === STATE) {
        const gate = this.gate;
        this.gate = null;
        await gate.promise;
      }
      return super.read(path);
    }
  }
  const store = new GatedStore(seedBookFiles());
  const { session: autopilot } = session(store, createFakeAutopilotAi({ delayMs: 20 }));
  const gate = deferred();
  store.gate = gate;
  const starting = autopilot.start(ONE_CHAPTER);
  const delivered = autopilot.intervene({ scope: "from_now", text: "Never use the word suddenly." });
  gate.resolve();
  await starting;
  assert.equal(await delivered, null, "handed to the live run, not written behind its back");
  await autopilot.waitForIdle();
  const state = stateOf(store);
  assert.equal(state.status, "completed");
  assert.ok(state.constraints.includes("Never use the word suddenly."));
});

// ─── A4: an unreadable state file is never replaced ─────────────────────────

async function pausedBookWithRules() {
  const store = new MemoryBookStore(seedBookFiles());
  const ai = createFakeAutopilotAi();
  const { session: autopilot, events } = session(store, ai);
  await autopilot.start({ brief: { idea: "x", targetChapters: 2, scenesPerChapter: 1, wordsPerScene: 300 }, options: { readers: false, readersOnPlan: false } });
  await autopilot.waitForIdle();
  await autopilot.intervene({ scope: "from_now", text: "Never use the word suddenly." });
  assert.equal(stateOf(store).constraints.length, 1);
  return { store, ai, autopilot, events };
}

test("an unreadable state file is never overwritten: start and every command refuse with a typed error, the snapshot explains, reset is the way out", async () => {
  assert.equal(typeof engine.AutopilotStateCorruptError, "function", "exported");
  const { store, ai, autopilot } = await pausedBookWithRules();
  const corrupt = conflicted(store.files.get(STATE));
  store.write(STATE, corrupt);
  const calls = ai.calls.length;
  const commits = store.commits.length;

  const stored = await readStoredAutopilot(store);
  assert.equal(stored.state, null);
  assert.equal(stored.corrupt?.path, STATE);
  assert.match(stored.corrupt.reason, /conflict/i);
  assert.ok(stored.stateHash, "the hash of the file is still reported");

  const typed = (error) => error instanceof engine.AutopilotStateCorruptError && /autopilot\/state\.json/.test(error.message) && /history/.test(error.message) && /reset/.test(error.message);
  await assert.rejects(() => autopilot.start({ brief: { targetChapters: 2 } }), typed);
  await assert.rejects(() => autopilot.start({ force: true }), typed);
  await assert.rejects(() => autopilot.intervene({ scope: "from_now", text: "Keep Orrin calm." }), typed);
  await assert.rejects(() => autopilot.answer({ questionId: "q", answer: "a" }), typed);
  await assert.rejects(() => autopilot.configure({ options: { budgetLimit: 5 } }), typed);
  assert.equal(autopilot.running, false, "a refused start leaves nothing claimed");
  assert.equal(store.files.get(STATE), corrupt, "the file is untouched");
  assert.equal(store.commits.length, commits, "nothing was committed");
  assert.equal(ai.calls.length, calls);

  const snapshot = await autopilot.snapshot();
  assert.equal(snapshot.state, null);
  assert.equal(snapshot.stateError?.code, "state_corrupt");
  assert.match(snapshot.stateError.message, /autopilot\/state\.json/);
  assert.equal(snapshot.running, false);

  await autopilot.reset();
  assert.equal(store.files.has(STATE), false, "reset deletes the unreadable file");
  const clean = await autopilot.snapshot();
  assert.equal(clean.state, null);
  assert.equal(clean.stateError, undefined);
  await autopilot.start({ brief: { idea: "again", targetChapters: 1, scenesPerChapter: 1 }, options: FAST });
  await autopilot.waitForIdle();
  assert.equal(stateOf(store).status, "completed", "the autopilot starts over");
});

test("what is unreadable: broken JSON and anything that is not an object; absent, blank and tolerated files are fine", async () => {
  const read = async (content) => readStoredAutopilot(new MemoryBookStore(content === undefined ? {} : { [STATE]: content }));
  assert.equal((await read(undefined)).corrupt, undefined, "absent");
  assert.equal((await read(undefined)).stateHash, null);
  assert.equal((await read("")).corrupt, undefined, "empty: nothing to protect");
  assert.equal((await read("  \n\t")).corrupt, undefined, "blank: nothing to protect");
  assert.equal((await read("{}")).corrupt, undefined, "an empty object is a tolerated hand edit");
  assert.ok((await read("{}")).state);
  for (const broken of ["{ \"status\": \"running\"", "not json at all", conflicted("{}\n"), "[]", "\"state\"", "42", "null"]) {
    const stored = await read(broken);
    assert.equal(stored.state, null, broken);
    assert.equal(stored.corrupt?.path, STATE, broken);
    assert.ok(stored.corrupt.reason.length > 0, broken);
    assert.ok(stored.stateHash, broken);
  }
  assert.match((await read(conflicted("{}\n"))).corrupt.reason, /conflict markers/);
});

test("a run never overwrites a state file that becomes unreadable while it runs", async () => {
  let corrupt = null;
  class Corrupting extends MemoryBookStore {
    async commit(changes, message) {
      const result = await super.commit(changes, message);
      if (this.commits.length === 2 && !corrupt) {
        corrupt = conflicted(this.files.get(STATE));
        this.write(STATE, corrupt);
      }
      return result;
    }
  }
  const store = new Corrupting(seedBookFiles());
  const { session: autopilot, events } = session(store, createFakeAutopilotAi());
  await autopilot.start(ONE_CHAPTER);
  await autopilot.waitForIdle();
  assert.ok(corrupt, "the scenario ran");
  assert.equal(store.files.get(STATE), corrupt, "the unreadable file was left alone");
  assert.equal(store.commits.length, 2, "nothing was committed after the corruption");
  assert.equal(autopilot.running, false);
  const ended = events.filter((event) => event.type === "run-ended");
  assert.equal(ended.length, 1, "the run is still closed for the listeners");
  assert.equal(ended[0].status, "error");
  assert.match(ended[0].message, /autopilot\/state\.json/);
  assert.ok(events.some((event) => event.type === "insight" && event.code === "unexpectedStop" && /history/.test(event.detail ?? "")));
});

test("a failing step never replaces an unreadable state file (persistFailure and finish)", async () => {
  const store = new MemoryBookStore(seedBookFiles());
  let corrupt = null;
  const ai = {
    calls: [],
    async complete(request) {
      this.calls.push(request);
      corrupt = conflicted(store.files.get(STATE));
      store.write(STATE, corrupt);
      throw new AiProviderError("invalid api key", 401, false);
    },
  };
  const { session: autopilot, events } = session(store, ai);
  await autopilot.start(ONE_CHAPTER);
  await autopilot.waitForIdle();
  assert.equal(store.files.get(STATE), corrupt, "the unreadable file was left alone");
  assert.deepEqual(store.commits.map((commit) => commit.message), ["Autopilot: started"], "the failed step recorded nothing");
  assert.equal(store.files.has(ACTIVITY), false);
  assert.equal(autopilot.running, false);
  assert.equal(events.filter((event) => event.type === "run-ended").length, 1);
});

test("a damaged activity log and a blank state file are tolerated: they hold nothing to protect", async () => {
  for (const [path, content] of [[ACTIVITY, "{ not json"], [STATE, "   \n"]]) {
    const store = new MemoryBookStore({ ...seedBookFiles(), [path]: content });
    const { session: autopilot } = session(store, createFakeAutopilotAi());
    await autopilot.start(ONE_CHAPTER);
    await autopilot.waitForIdle();
    assert.equal(stateOf(store).status, "completed", path);
    assert.ok((await readStoredAutopilot(store)).activities.length > 5, `${path}: the log starts again`);
  }
});

// ─── A8: a run that lost its lease stops without writing ────────────────────

/** A is mid-step when B takes over; B then holds at its third AI call, so nothing else writes while A ends. */
async function takenOverBook(aiA) {
  const store = new MemoryBookStore(seedBookFiles());
  const reached = deferred();
  const hold = deferred();
  const aiB = gatedAi((call) => {
    if (call !== 3) return undefined;
    reached.resolve();
    return hold.promise;
  });
  const a = session(store, aiA);
  const b = session(store, aiB, { host: "browser", hostLabel: "Browser", hostId: "device-1" });
  await a.session.start(ONE_CHAPTER);
  await b.session.start({ force: true });
  await reached.promise;
  assert.equal(stateOf(store).runner.host, "browser", "B owns the book");
  assert.equal(stateOf(store).stats.tasks, 2, "B wrote the concept and the plan");
  return { store, a, b, hold };
}

function assertQuietEnd(events) {
  const taken = events.filter((event) => event.type === "insight" && event.code === "takenOver");
  assert.equal(taken.length, 1, "the takeover is reported once");
  const ended = events.filter((event) => event.type === "run-ended");
  assert.equal(ended.length, 1);
  assert.notEqual(ended[0].status, "running", "a run that stopped does not claim to be running");
  assert.equal(ended[0].status, "paused");
  assert.equal(ended[0].code, "takenOver");
  assert.match(ended[0].message, /took over/);
}

test("a run that lost its lease and then fails writes nothing: the new owner's state is not clobbered", async () => {
  const fail = deferred();
  const aiA = {
    calls: [],
    async complete(request) {
      this.calls.push(request.label);
      await fail.promise;
      throw new AiProviderError("invalid api key", 401, false);
    },
  };
  const { store, a, b, hold } = await takenOverBook(aiA);
  const stateBefore = store.files.get(STATE);
  const activityBefore = store.files.get(ACTIVITY);

  fail.resolve();
  await a.session.waitForIdle();
  assert.equal(store.files.get(STATE), stateBefore, "A's older copy did not replace B's state");
  assert.equal(store.files.get(ACTIVITY), activityBefore, "nor did A add to the log");
  assert.equal(a.session.running, false);
  assertQuietEnd(a.events);

  hold.resolve();
  await b.session.waitForIdle();
  const final = stateOf(store);
  assert.equal(final.status, "completed", "B finished the whole book, reviews included");
  assert.equal(final.runner, null);
  assert.equal(final.plan.chapters[0].status, "done");
});

test("a run whose finished step conflicts with the new owner's state stops without writing", async () => {
  const release = deferred();
  const aiA = gatedAi(() => release.promise);
  const { store, a, b, hold } = await takenOverBook(aiA);
  const stateBefore = store.files.get(STATE);
  const activityBefore = store.files.get(ACTIVITY);

  release.resolve();
  await a.session.waitForIdle();
  assert.equal(store.files.get(STATE), stateBefore, "A's spend and failure record did not touch B's state");
  assert.equal(store.files.get(ACTIVITY), activityBefore);
  assert.ok(!store.commits.some((commit) => /\((failed|cancelled)\)$/.test(commit.message) || commit.message === "Autopilot: error"), "A committed nothing after the takeover");
  assertQuietEnd(a.events);

  hold.resolve();
  await b.session.waitForIdle();
  assert.equal(stateOf(store).status, "completed");
});

test("a run that finds another runner at the top of its loop stops without writing, and says it was taken over", async () => {
  const store = new MemoryBookStore(seedBookFiles());
  const hold = deferred();
  const holder = {};
  let afterTakeover = null;
  const hooks = {
    afterCommit: async ({ task }) => {
      if (task.kind !== "concept" || afterTakeover) return;
      await holder.b.start({ force: true });
      afterTakeover = store.files.get(STATE);
    },
  };
  const a = session(store, createFakeAutopilotAi(), { hooks });
  const b = session(store, gatedAi(() => hold.promise), { host: "browser", hostLabel: "Browser", hostId: "device-1" });
  holder.b = b.session;
  await a.session.start(ONE_CHAPTER);
  await a.session.waitForIdle();
  assert.ok(afterTakeover, "B took over between two steps of A");
  assert.equal(store.files.get(STATE), afterTakeover, "A wrote nothing after the takeover");
  assert.equal(a.session.running, false);
  assertQuietEnd(a.events);

  hold.resolve();
  await b.session.waitForIdle();
  assert.equal(stateOf(store).status, "completed");
  assert.equal(stateOf(store).plan.chapters[0].status, "done");
});

test("a stored runner of null (somebody paused or ended the run) may still be overwritten by the run's own end", async () => {
  const store = new MemoryBookStore(seedBookFiles());
  const ai = {
    calls: [],
    async complete(request) {
      this.calls.push(request);
      const state = JSON.parse(store.files.get(STATE));
      store.write(STATE, `${JSON.stringify({ ...state, status: "paused", runner: null })}\n`);
      throw new AiProviderError("invalid api key", 401, false);
    },
  };
  const { session: autopilot, events } = session(store, ai);
  await autopilot.start(ONE_CHAPTER);
  await autopilot.waitForIdle();
  const state = stateOf(store);
  assert.equal(state.status, "error");
  assert.match(state.lastError.message, /invalid api key/);
  assert.equal(state.runner, null);
  assert.ok(!events.some((event) => event.type === "insight" && event.code === "takenOver"));
  assert.equal(events.find((event) => event.type === "run-ended").status, "error");
});

// ─── A20: store failures at the top of the loop ─────────────────────────────

class FlakyStore extends MemoryBookStore {
  /** Reads of the state file that fail once the start and the first step are committed. */
  failStateReads = 0;
  /** Commits of the first step (they write the story design) that fail without being a conflict. */
  failStepCommits = 0;

  async read(path) {
    if (path === STATE && this.failStateReads > 0 && this.commits.length >= 2) {
      this.failStateReads -= 1;
      throw new Error("IndexedDB: the working copy is being refreshed");
    }
    return super.read(path);
  }

  async commit(changes, message) {
    if (this.failStepCommits > 0 && changes.some((change) => change.path === "story-design.md")) {
      this.failStepCommits -= 1;
      throw new Error("QuotaExceededError: the working copy is full");
    }
    return super.commit(changes, message);
  }
}

test("a transient store failure at the top of the loop is retried once and the run goes on", async () => {
  const store = new FlakyStore(seedBookFiles());
  store.failStateReads = 1;
  const { session: autopilot, events } = session(store, createFakeAutopilotAi());
  await autopilot.start(ONE_CHAPTER);
  await autopilot.waitForIdle();
  const state = stateOf(store);
  assert.equal(state.status, "completed");
  assert.equal(state.runner, null);
  assert.equal(state.lastError, null);
  const retry = events.find((event) => event.type === "insight" && event.code === "failureRetry");
  assert.ok(retry, "the retry is announced");
  assert.match(retry.detail, /working copy is being refreshed/);
  assert.ok(!events.some((event) => event.type === "insight" && event.code === "unexpectedStop"));
});

test("a store that keeps failing ends the run through the normal failure path: error recorded, run ended, lease released", async () => {
  const store = new FlakyStore(seedBookFiles());
  store.failStateReads = 2;
  const { session: autopilot, events } = session(store, createFakeAutopilotAi());
  await autopilot.start(ONE_CHAPTER);
  await autopilot.waitForIdle();
  const state = stateOf(store);
  assert.equal(state.status, "error");
  assert.equal(state.runner, null, "the lease is released");
  assert.match(state.lastError.message, /working copy is being refreshed/);
  assert.equal(state.stats.failures, 1);
  assert.equal(events.filter((event) => event.type === "insight" && event.code === "failureRetry").length, 1, "one retry, not more");
  const ended = events.filter((event) => event.type === "run-ended");
  assert.equal(ended.length, 1);
  assert.equal(ended[0].status, "error");
  assert.ok(!events.some((event) => event.type === "insight" && event.code === "unexpectedStop"));
  assert.equal(autopilot.running, false);
});

test("a store failure while a step commits is retried once like a network failure; other unclassified errors are still not", async () => {
  const store = new FlakyStore(seedBookFiles());
  store.failStepCommits = 1;
  const ai = createFakeAutopilotAi();
  const { session: autopilot, events } = session(store, ai);
  await autopilot.start(ONE_CHAPTER);
  await autopilot.waitForIdle();
  assert.equal(stateOf(store).status, "completed");
  assert.equal(ai.calls.filter((call) => call.label === "autopilot:concept").length, 2, "the failed step was repeated once");
  assert.ok(events.some((event) => event.type === "insight" && event.code === "failureRetry" && /working copy is full/.test(event.detail)));

  const persistent = new FlakyStore(seedBookFiles());
  persistent.failStepCommits = 2;
  const failed = session(persistent, createFakeAutopilotAi());
  await failed.session.start(ONE_CHAPTER);
  await failed.session.waitForIdle();
  assert.equal(stateOf(persistent).status, "error");
  assert.match(stateOf(persistent).lastError.message, /working copy is full/);

  assert.equal(isRetryableError(new Error("unclassified")), false, "the rule itself is unchanged for errors from elsewhere");
});

test("a store error is passed on unchanged, and a host that says it is not retryable is obeyed", async () => {
  const transient = new Error("IndexedDB: transaction aborted");
  const permanent = Object.assign(new Error("EROFS: the working copy is read-only"), { retryable: false });
  let failing = null;
  class Failing extends MemoryBookStore {
    async read(path) {
      if (path === STATE && failing && this.commits.length >= 2) {
        const error = failing;
        failing = null;
        throw error;
      }
      return super.read(path);
    }
  }
  failing = transient;
  const retried = session(new Failing(seedBookFiles()), createFakeAutopilotAi());
  await retried.session.start(ONE_CHAPTER);
  await retried.session.waitForIdle();
  assert.equal(retried.events.filter((event) => event.type === "insight" && event.code === "failureRetry").length, 1);
  assert.equal("retryable" in transient, false, "the host's error object was not modified");

  failing = permanent;
  const store = new Failing(seedBookFiles());
  const refused = session(store, createFakeAutopilotAi());
  await refused.session.start(ONE_CHAPTER);
  await refused.session.waitForIdle();
  assert.equal(refused.events.some((event) => event.type === "insight" && event.code === "failureRetry"), false, "not retried");
  assert.equal(stateOf(store).status, "error");
  assert.match(stateOf(store).lastError.message, /read-only/);
});

test("when the store cannot even be read to save the end, the run still ends and says so", async () => {
  class Down extends MemoryBookStore {
    down = false;
    async read(path) {
      if (this.down && path === STATE) throw new Error("IndexedDB: the working copy is gone");
      return super.read(path);
    }
    async commit(changes, message) {
      const result = await super.commit(changes, message);
      if (this.commits.length === 2) this.down = true;
      return result;
    }
  }
  const store = new Down(seedBookFiles());
  const { session: autopilot, events } = session(store, createFakeAutopilotAi());
  await autopilot.start(ONE_CHAPTER);
  await autopilot.waitForIdle();
  assert.equal(autopilot.running, false);
  assert.equal(events.filter((event) => event.type === "insight" && event.code === "failureRetry").length, 1);
  const failed = events.find((event) => event.type === "insight" && event.code === "finalStateFailed");
  assert.ok(failed, "the final state could not be saved, and that is reported");
  assert.match(failed.detail, /working copy is gone/);
  const ended = events.filter((event) => event.type === "run-ended");
  assert.equal(ended.length, 1);
  assert.equal(ended[0].status, "error");
  assert.ok(!events.some((event) => event.type === "insight" && event.code === "unexpectedStop"));
});

test("AutopilotRun used on its own also refuses an unreadable state file", async () => {
  const store = new MemoryBookStore({ ...seedBookFiles(), [STATE]: "{ \"status\": \"running\"" });
  const emitted = [];
  const run = new engine.AutopilotRun({ bookId: "book-1", store, ai: createFakeAutopilotAi(), host: "server", hostLabel: "test-host", retryDelayMs: 0, emit: (event) => emitted.push(event) });
  await assert.rejects(() => run.execute(ONE_CHAPTER), (error) => error instanceof engine.AutopilotStateCorruptError && error.path === STATE && error.code === "state_corrupt");
  assert.equal(store.files.get(STATE), "{ \"status\": \"running\"");
  assert.equal(store.commits.length, 0);
  assert.deepEqual(emitted, [], "a run that never started does not announce an end");
});

// ─── A23: pause and interrupt windows ───────────────────────────────────────

test("pause('now') between two steps stops the run before the next step is billed", async () => {
  class HookedStore extends MemoryBookStore {
    armed = false;
    fired = false;
    onFire = () => undefined;
    async commit(changes, message) {
      const result = await super.commit(changes, message);
      if (this.commits.length === 2) this.armed = true;
      return result;
    }
    async read(path) {
      const result = await super.read(path);
      if (this.armed && !this.fired && path === ACTIVITY) {
        this.fired = true;
        this.onFire();
      }
      return result;
    }
  }
  const store = new HookedStore(seedBookFiles());
  const base = createFakeAutopilotAi();
  let billed = 0;
  const ai = {
    calls: base.calls,
    async complete(request) {
      request.signal?.throwIfAborted();
      const reply = await base.complete(request);
      billed += 1;
      return reply;
    },
  };
  const { session: autopilot, events } = session(store, ai);
  store.onFire = () => autopilot.pause("now");
  await autopilot.start(ONE_CHAPTER);
  await autopilot.waitForIdle();
  assert.equal(store.fired, true, "the pause came while the loop was reading the state between two steps");
  assert.equal(billed, 1, "only the concept was billed");
  assert.equal(stateOf(store).status, "paused");
  assert.ok(!events.some((event) => event.type === "task-finished" && event.activity.status === "succeeded" && event.activity.task === "plan"));
});

test("an interrupt that arrives after its step is done does not turn a later abort into a repeat", async () => {
  const store = new MemoryBookStore(seedBookFiles());
  const base = createFakeAutopilotAi();
  let planCalls = 0;
  const ai = {
    calls: base.calls,
    async complete(request) {
      if (request.label === "autopilot:plan" && (planCalls += 1) === 1) {
        base.calls.push(request);
        throw new DOMException("The connection was closed.", "AbortError");
      }
      return base.complete(request);
    },
  };
  const holder = {};
  let fired = false;
  const hooks = {
    afterCommit: async ({ task }) => {
      if (task.kind === "concept" && !fired) {
        fired = true;
        await holder.session.intervene({ scope: "from_now", text: "Everything happens at night.", interrupt: true });
      }
    },
  };
  const { session: autopilot } = session(store, ai, { hooks });
  holder.session = autopilot;
  await autopilot.start(ONE_CHAPTER);
  await autopilot.waitForIdle();
  assert.equal(fired, true);
  assert.equal(planCalls, 1, "the abort that nobody asked for ends the run instead of repeating the step");
  assert.equal(stateOf(store).status, "paused");
});
