import test from "node:test";
import assert from "node:assert/strict";
import * as engine from "../dist/index.js";
import { MemoryBookStore, createFakeAutopilotAi, seedBookFiles } from "../dist/testing/index.js";

// New exports are read from the namespace so that, before they exist, each test fails on its own.
const { AutopilotRun, AutopilotSession, MAX_CONSTRAINTS, applyIntervention, createAutopilotState, parseAutopilotState, readStoredAutopilot } = engine;

const STATE = "autopilot/state.json";
const FAST = { readers: false, readersOnPlan: false, pauseAfterPlan: false };
const ONE_CHAPTER = { brief: { idea: "x", targetChapters: 1, scenesPerChapter: 1, wordsPerScene: 300 }, options: FAST };
const TWO_CHAPTERS = { brief: { idea: "x", targetChapters: 2, scenesPerChapter: 1, wordsPerScene: 300 }, options: { ...FAST, specialists: false } };
const TWO_CHAPTERS_REVIEWED = { brief: TWO_CHAPTERS.brief, options: FAST };
const TWO_CHAPTERS_STORM = { brief: TWO_CHAPTERS.brief, options: FAST };

function session(store, ai, extra = {}) {
  const events = [];
  const instance = new AutopilotSession({ bookId: "book-1", store, ai, host: "server", hostLabel: "test-host", hostId: "server-1", retryDelayMs: 0, ...extra });
  instance.subscribe((event) => events.push(event));
  return { session: instance, events };
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

/** A store whose commits are applied one after the other, as every real host does: two writers can never both pass the same check. */
class AtomicStore extends MemoryBookStore {
  tail = Promise.resolve();
  commit(changes, message) {
    const run = this.tail.then(() => super.commit(changes, message));
    this.tail = run.then(() => undefined, () => undefined);
    return run;
  }
}

const labelsOf = (ai) => ai.calls.map((call) => call.label);
const occurrences = (text, needle) => text.split(needle).length - 1;

/** The AI calls of the same book when nobody intervenes. */
async function baselineLabels(start = ONE_CHAPTER, options = {}) {
  const store = new MemoryBookStore(seedBookFiles());
  const ai = createFakeAutopilotAi(options);
  const { session: autopilot } = session(store, ai);
  await autopilot.start(start);
  await autopilot.waitForIdle();
  return labelsOf(ai);
}

/** Pauses the run after the first step of this kind has been saved. */
function pauseAfter(autopilot, taskKind) {
  return autopilot.subscribe((event) => {
    if (event.type === "task-finished" && event.activity.task === taskKind && event.activity.status === "succeeded") autopilot.pause("after-step");
  });
}

// ─── Q2: interventions are saved at once ────────────────────────────────────

test("an intervention made during a step is in the saved state before the step ends, and another session sees it", async () => {
  const store = new MemoryBookStore(seedBookFiles());
  const { ai, gate, reached } = holdingAi((request, call) => call === 1);
  const { session: autopilot } = session(store, ai);
  await autopilot.start(ONE_CHAPTER);
  await reached;

  const returned = await autopilot.intervene({ scope: "from_now", text: "Never use the word suddenly." });
  assert.equal(returned, null, "the live run owns the answer: nothing to render, as before");
  const saved = stateOf(store);
  assert.deepEqual(saved.constraints, ["Never use the word suddenly."], "saved at once");
  assert.equal(saved.interventions.length, 1);
  assert.equal(saved.interventions[0].status, "applied");
  assert.equal(saved.status, "running", "the run's own lease is untouched");
  assert.ok(saved.runner, "and so is its runner");
  assert.equal(ai.calls.length, 0, "the request of the step is still being held");

  const reader = new AutopilotSession({ bookId: "book-1", store, ai: createFakeAutopilotAi(), host: "browser", hostLabel: "Browser", hostId: "device-1" });
  const seen = (await reader.snapshot()).state;
  assert.deepEqual(seen.constraints, ["Never use the word suddenly."], "another session reads it from the book");
  assert.equal(seen.status, "running");

  gate.resolve();
  await autopilot.waitForIdle();
  assert.equal(ai.calls.filter((call) => call.label === "autopilot:concept").length, 1, "the step in flight was made once");
  const final = stateOf(store);
  assert.equal(final.status, "completed");
  assert.deepEqual(final.constraints, ["Never use the word suddenly."], "kept once, not duplicated by the step's commit");
  assert.equal(final.interventions.length, 1);
});

test("two interventions in the same step are both saved at once, merged by the step's commit, and cost no AI call", async () => {
  const labels = await baselineLabels();
  const store = new MemoryBookStore(seedBookFiles());
  const { ai, gate, reached } = holdingAi((request, call) => call === 1);
  const { session: autopilot, events } = session(store, ai);
  await autopilot.start(ONE_CHAPTER);
  await reached;
  await autopilot.intervene({ scope: "next_step", text: "Open the plan with a storm." });
  await autopilot.intervene({ scope: "from_now", text: "Never use the word suddenly." });
  const saved = stateOf(store);
  assert.equal(saved.interventions.length, 2, "both are saved before the step ends");
  assert.deepEqual(saved.interventions.map((entry) => entry.status), ["pending", "applied"]);
  assert.equal(new Set(saved.interventions.map((entry) => entry.id)).size, 2);
  assert.equal((await autopilot.snapshot()).state.interventions.length, 2);

  gate.resolve();
  await autopilot.waitForIdle();
  assert.deepEqual(labelsOf(ai), labels, "no AI call was repeated or added");
  assert.ok(!events.some((event) => event.type === "insight" && event.code === "conflictRetry"), "the step did not conflict with the author's saves");
  const final = stateOf(store);
  assert.equal(final.status, "completed");
  assert.equal(final.interventions.length, 2, "neither was lost, neither doubled");
  assert.deepEqual(final.constraints, ["Never use the word suddenly."]);
  const concept = ai.calls.find((call) => call.label === "autopilot:concept");
  const plan = ai.calls.find((call) => call.label === "autopilot:plan");
  assert.doesNotMatch(concept.user, /storm/, "the step in flight never saw them");
  assert.equal(occurrences(plan.user, "Open the plan with a storm."), 1, "the note went to the next step that accepts notes, once");
  assert.equal(occurrences(plan.user, "Never use the word suddenly."), 1, "and the rule appears once in its prompt");
  const note = final.interventions.find((entry) => entry.scope === "next_step");
  assert.equal(note.status, "applied");
});

test("a heartbeat that rewrote the state file between the author's save and the step's commit does not lose the save", async () => {
  const store = new AtomicStore(seedBookFiles());
  const { ai, gate, reached } = holdingAi((request, call) => call === 1);
  const { session: autopilot, events } = session(store, ai, { persistHeartbeatMs: 8, heartbeatMs: 0 });
  await autopilot.start(ONE_CHAPTER);
  await reached;
  await autopilot.intervene({ scope: "from_now", text: "Never use the word suddenly." });
  const saves = store.commits.length;
  await waitFor(() => store.commits.slice(saves).some((commit) => commit.message === "Autopilot: heartbeat"), "a heartbeat after the save");
  gate.resolve();
  await autopilot.waitForIdle();
  assert.equal(ai.calls.filter((call) => call.label === "autopilot:concept").length, 1, "the step was not repeated");
  assert.ok(!events.some((event) => event.type === "insight" && event.code === "conflictRetry"));
  const final = stateOf(store);
  assert.deepEqual(final.constraints, ["Never use the word suddenly."]);
  assert.equal(final.interventions.length, 1);
  assert.equal(final.status, "completed");
});

test("a crash right after an intervention loses nothing: a new session sees the pending note and delivers it to the next writing step", async () => {
  const store = new MemoryBookStore(seedBookFiles());
  const reached = deferred();
  const base = createFakeAutopilotAi();
  const dying = {
    calls: base.calls,
    async complete(request) {
      if (request.label === "autopilot:write:1.1") {
        reached.resolve();
        return new Promise(() => undefined);
      }
      return base.complete(request);
    },
  };
  const first = session(store, dying);
  await first.session.start(ONE_CHAPTER);
  await reached.promise;
  await first.session.intervene({ scope: "next_step", text: "Mira must find the torn letter." });
  // The process dies here: the first session is never used again.

  const ai = createFakeAutopilotAi();
  const second = session(store, ai);
  const snapshot = await second.session.snapshot();
  assert.equal(snapshot.state.status, "paused", "the run of a process that is gone is shown as interrupted");
  assert.deepEqual(snapshot.state.interventions.filter((entry) => entry.status === "pending").map((entry) => entry.text), ["Mira must find the torn letter."], "the note is waiting");
  await second.session.start();
  await second.session.waitForIdle();
  const carrying = ai.calls.filter((call) => /torn letter/.test(call.user));
  assert.deepEqual(carrying.map((call) => call.label), ["autopilot:write:1.1"], "delivered to the writing step, and to nothing else");
  assert.equal(occurrences(carrying[0].user, "torn letter"), 1);
  const final = stateOf(store);
  assert.equal(final.status, "completed");
  const note = final.interventions[0];
  assert.equal(note.status, "applied");
  const { activities } = await readStoredAutopilot(store);
  assert.equal(activities.find((activity) => activity.id === note.appliedBy).task, "write");
});

test("an intervention that arrives while the run closes is not lost", async () => {
  class Closing extends MemoryBookStore {
    onFinish = null;
    async commit(changes, message) {
      if (message === "Autopilot: paused" && this.onFinish) {
        const hook = this.onFinish;
        this.onFinish = null;
        await hook();
      }
      return super.commit(changes, message);
    }
  }
  const store = new Closing(seedBookFiles());
  const { session: autopilot } = session(store, createFakeAutopilotAi({ delayMs: 30 }));
  let returned;
  store.onFinish = async () => {
    returned = await autopilot.intervene({ scope: "from_now", text: "Never use the word suddenly." });
  };
  await autopilot.start(ONE_CHAPTER);
  await sleep(10);
  autopilot.pause("after-step");
  await autopilot.waitForIdle();
  assert.equal(returned, null);
  const saved = stateOf(store);
  assert.equal(saved.status, "paused", "the run did close");
  assert.deepEqual(saved.constraints, ["Never use the word suddenly."], "the rule is in the state that closed the run");
  assert.equal(saved.interventions.length, 1);
  assert.equal(saved.runner, null);
  assert.equal(autopilot.running, false);
});

test("interrupt: true still restarts the step with the intervention, and the intervention is saved before the restart", async () => {
  const store = new MemoryBookStore(seedBookFiles());
  const ai = createFakeAutopilotAi({ delayMs: 60 });
  const { session: autopilot, events } = session(store, ai);
  await autopilot.start(ONE_CHAPTER);
  await sleep(15);
  await autopilot.intervene({ scope: "from_now", text: "Everything happens in winter.", interrupt: true });
  assert.deepEqual(stateOf(store).constraints, ["Everything happens in winter."], "saved when intervene() returns, not when the step is over");
  await autopilot.waitForIdle();
  const concepts = ai.calls.filter((call) => call.label === "autopilot:concept");
  assert.equal(concepts.length, 2, "the interrupted step is repeated");
  assert.doesNotMatch(concepts[0].user, /winter/);
  assert.equal(occurrences(concepts[1].user, "Everything happens in winter."), 1, "the repeat carries the rule once");
  assert.ok(events.some((event) => event.type === "task-finished" && event.activity.status === "cancelled"));
  assert.ok(events.some((event) => event.type === "insight" && event.code === "interventionInterrupt"));
  assert.ok(!events.some((event) => event.type === "insight" && event.code === "interventionQueued"));
  const final = stateOf(store);
  assert.equal(final.status, "completed");
  assert.deepEqual(final.constraints, ["Everything happens in winter."]);
  assert.equal(final.interventions.length, 1);
});

test("a next_step note with interrupt: true reaches the repeated step once and is applied by it", async () => {
  const store = new MemoryBookStore(seedBookFiles());
  const ai = createFakeAutopilotAi({ delayMs: 60 });
  const { session: autopilot } = session(store, ai);
  await autopilot.start(ONE_CHAPTER);
  await sleep(15);
  await autopilot.intervene({ scope: "next_step", text: "Open with a storm.", interrupt: true });
  await autopilot.waitForIdle();
  const concepts = ai.calls.filter((call) => call.label === "autopilot:concept");
  assert.equal(concepts.length, 2);
  assert.equal(occurrences(concepts[1].user, "Open with a storm."), 1);
  assert.ok(!ai.calls.some((call) => call.label !== "autopilot:concept" && /Open with a storm/.test(call.user)), "no other step got it");
  const final = stateOf(store);
  assert.equal(final.interventions[0].status, "applied");
});

test("a rule added mid-step arrives in the prompt of the next step exactly once, and in no earlier one", async () => {
  const store = new MemoryBookStore(seedBookFiles());
  const { ai, gate, reached } = holdingAi((request) => request.label === "autopilot:plan");
  const { session: autopilot } = session(store, ai);
  await autopilot.start(ONE_CHAPTER);
  await reached;
  await autopilot.intervene({ scope: "from_now", text: "Never use the word suddenly." });
  gate.resolve();
  await autopilot.waitForIdle();
  const labels = labelsOf(ai);
  assert.equal(labels.filter((label) => label === "autopilot:plan").length, 1, "the plan step was not repeated");
  const planned = labels.indexOf("autopilot:plan");
  const before = ai.calls.slice(0, planned + 1);
  const after = ai.calls.slice(planned + 1);
  assert.ok(before.every((call) => !call.user.includes("Never use the word suddenly.")), "neither the step before nor the one in flight had it");
  assert.equal(after[0].label, "autopilot:plan-review");
  assert.equal(occurrences(after[0].user, "Never use the word suddenly."), 1, "the very next step has it, once");
  const withRule = after.filter((call) => call.user.includes("Never use the word suddenly."));
  assert.ok(withRule.length >= 4, "and the later ones too");
  for (const call of withRule) assert.equal(occurrences(call.user, "Never use the word suddenly."), 1, `once in ${call.label}`);
  assert.deepEqual(stateOf(store).constraints, ["Never use the word suddenly."], "and the state holds it once");
});

test("a rewrite request made while a step runs behaves as it did when it was handed over in memory: its effects land on the state the step produced", async () => {
  const store = new MemoryBookStore(seedBookFiles());
  const { ai, gate, reached } = holdingAi((request) => request.label === "autopilot:scenes:2", { reviewVerdict: () => "approve" });
  const { session: autopilot, events } = session(store, ai);
  await autopilot.start(TWO_CHAPTERS);
  await reached;
  await autopilot.intervene({ scope: "rewrite", text: "Make Orrin kinder." });
  const saved = stateOf(store);
  assert.ok(saved.revision, "the revision exists in the saved state at once");
  assert.ok(saved.constraints.includes("Make Orrin kinder."));
  gate.resolve();
  await autopilot.waitForIdle();
  const labels = labelsOf(ai);
  assert.equal(labels.filter((label) => label === "autopilot:scenes:2").length, 1, "the step in flight was not repeated");
  assert.equal(labels.filter((label) => label === "autopilot:impact").length, 1, "the director analyzed the impact");
  assert.equal(labels.filter((label) => label === "autopilot:revise:1.1").length, 1, "and the scene was rewritten");
  assert.ok(!events.some((event) => event.type === "insight" && event.code === "conflictRetry"));
  const final = stateOf(store);
  assert.equal(final.status, "completed");
  assert.equal(final.revision, null);
  assert.deepEqual(final.constraints, ["Make Orrin kinder."]);
});

test("a rewrite request made while the director approves the plan reopens it with the author's note, as before", async () => {
  const store = new MemoryBookStore(seedBookFiles());
  const { ai, gate, reached } = holdingAi((request) => request.label === "autopilot:plan-review");
  const { session: autopilot } = session(store, ai);
  await autopilot.start(ONE_CHAPTER);
  await reached;
  await autopilot.intervene({ scope: "rewrite", text: "Make the plan darker." });
  gate.resolve();
  await autopilot.waitForIdle();
  const labels = labelsOf(ai);
  assert.equal(labels.filter((label) => label === "autopilot:plan-review").length, 2, "the first review was not repeated; the revised plan was reviewed again");
  const plans = ai.calls.filter((call) => call.label === "autopilot:plan");
  assert.equal(plans.length, 2, "the plan was made again");
  assert.match(plans[1].user, /Revise the chapter plan[\s\S]*Make the plan darker\./);
  assert.equal(stateOf(store).status, "completed");
});

test("a change of anything other than the author's parts during a step is still a conflict: the step is repeated on the latest state, as before", async () => {
  const store = new MemoryBookStore(seedBookFiles());
  const { ai, gate, reached } = holdingAi((request, call) => call === 1);
  const { session: autopilot, events } = session(store, ai);
  await autopilot.start(ONE_CHAPTER);
  await reached;
  const other = new AutopilotSession({ bookId: "book-1", store, ai: createFakeAutopilotAi(), host: "server", hostLabel: "test-host", hostId: "server-1" });
  await other.configure({ options: { budgetLimit: 77 } });
  gate.resolve();
  await autopilot.waitForIdle();
  assert.equal(ai.calls.filter((call) => call.label === "autopilot:concept").length, 2, "the step was repeated once");
  assert.ok(events.some((event) => event.type === "insight" && event.code === "conflictRetry"));
  const final = stateOf(store);
  assert.equal(final.options.budgetLimit, 77, "the other change survived");
  assert.equal(final.status, "completed");
});

test("a run used on its own keeps the in-memory path: the intervention is saved with the step, and never lost", async () => {
  const store = new MemoryBookStore(seedBookFiles());
  const { ai, gate, reached } = holdingAi((request, call) => call === 1);
  const emitted = [];
  const run = new AutopilotRun({ bookId: "book-1", store, ai, host: "server", hostLabel: "test-host", retryDelayMs: 0, emit: (event) => emitted.push(event) });
  const done = run.execute(ONE_CHAPTER);
  await reached;
  run.intervene({ scope: "next_step", text: "Open the plan with a storm." });
  assert.equal(stateOf(store).interventions.length, 0, "a bare run only keeps it in memory until the step is saved");
  gate.resolve();
  const final = await done;
  assert.equal(final.status, "completed");
  assert.equal(stateOf(store).interventions.length, 1);
  assert.equal(occurrences(ai.calls.find((call) => call.label === "autopilot:plan").user, "Open the plan with a storm."), 1);
});

// ─── the merge itself ───────────────────────────────────────────────────────

function runningState() {
  const at = new Date("2026-03-01T10:00:00.000Z");
  const base = createAutopilotState(at);
  return {
    ...base,
    status: "running",
    runner: { host: "server", label: "home", runId: "run-1", startedAt: at.toISOString(), heartbeatAt: at.toISOString() },
    constraints: ["Keep it short.", "No adverbs."],
    version: 3,
  };
}

test("reconcileAuthorChanges: the author's parts are carried into the state of the step, the run wins on everything else", () => {
  const { reconcileAuthorChanges } = engine;
  assert.equal(typeof reconcileAuthorChanges, "function", "exported");
  const at = new Date("2026-03-01T10:05:00.000Z");
  const base = runningState();
  const working = { ...base, stats: { ...base.stats, tasks: 4, aiCalls: 9 }, phase: "write", version: 4 };
  let stored = applyIntervention(base, { scope: "next_step", text: "Open with a storm." }, at, "a step");
  stored = applyIntervention(stored, { scope: "from_now", text: "Short chapters." }, at, "a step");
  stored = { ...stored, version: 6, updatedAt: at.toISOString(), runner: { ...stored.runner, heartbeatAt: at.toISOString() } };

  const merged = reconcileAuthorChanges(working, base, stored);
  assert.equal(merged.foreign, false);
  assert.deepEqual(merged.state.constraints, ["Keep it short.", "No adverbs.", "Short chapters."]);
  assert.deepEqual(merged.state.interventions.map((entry) => entry.text), ["Open with a storm.", "Short chapters."]);
  assert.deepEqual(merged.state.interventions.map((entry) => entry.id), stored.interventions.map((entry) => entry.id), "the entries keep their ids");
  assert.equal(merged.state.stats.tasks, 4, "the run's work is kept");
  assert.equal(merged.state.phase, "write");

  const again = reconcileAuthorChanges(merged.state, base, stored);
  assert.deepEqual(again.state.interventions.map((entry) => entry.id), merged.state.interventions.map((entry) => entry.id), "merging twice adds nothing twice");
  assert.deepEqual(again.state.constraints, merged.state.constraints);

  const applied = { ...working, interventions: [{ id: "n1", scope: "next_step", text: "Old note", createdAt: "x", during: "y", status: "applied", appliedAt: "z", appliedBy: "activity-1" }] };
  const baseWithNote = { ...base, interventions: [{ id: "n1", scope: "next_step", text: "Old note", createdAt: "x", during: "y", status: "pending" }] };
  const kept = reconcileAuthorChanges(applied, baseWithNote, { ...baseWithNote, version: 5 });
  assert.equal(kept.state.interventions[0].status, "applied", "a note the step consumed stays applied, and is not added again");
  assert.equal(kept.state.interventions.length, 1);
});

test("reconcileAuthorChanges: rules the author edited or removed are taken as they are, and the run's own additions stay", () => {
  const { reconcileAuthorChanges } = engine;
  const base = runningState();
  const edited = reconcileAuthorChanges(base, base, { ...base, constraints: ["Keep it brief.", "No adverbs."], version: 4 });
  assert.equal(edited.foreign, false);
  assert.deepEqual(edited.state.constraints, ["Keep it brief.", "No adverbs."]);
  const removed = reconcileAuthorChanges(base, base, { ...base, constraints: ["No adverbs."], version: 4 });
  assert.deepEqual(removed.state.constraints, ["No adverbs."]);
  const both = reconcileAuthorChanges({ ...base, constraints: [...base.constraints, "Added by the run."] }, base, { ...base, constraints: ["No adverbs."], version: 4 });
  assert.deepEqual(both.state.constraints, ["No adverbs.", "Added by the run."]);
  const untouched = reconcileAuthorChanges({ ...base, constraints: [...base.constraints, "Added by the run."] }, base, { ...base, version: 4 });
  assert.deepEqual(untouched.state.constraints, ["Keep it short.", "No adverbs.", "Added by the run."]);
});

test("reconcileAuthorChanges: a heartbeat is nothing, a rewrite lands on the state the step produced, anything else is foreign", () => {
  const { reconcileAuthorChanges } = engine;
  const base = runningState();
  const beat = { ...base, version: 4, updatedAt: "2026-03-01T10:30:00.000Z", runner: { ...base.runner, heartbeatAt: "2026-03-01T10:30:00.000Z" } };
  const quiet = reconcileAuthorChanges(base, base, beat);
  assert.equal(quiet.foreign, false);
  assert.deepEqual(quiet.state, base, "nothing to carry over");

  for (const [name, change] of [
    ["the options", (state) => ({ ...state, options: { ...state.options, budgetLimit: 5 } })],
    ["the brief", (state) => ({ ...state, brief: { ...state.brief, idea: "other" } })],
    ["the status", (state) => ({ ...state, status: "paused" })],
    ["the runner", (state) => ({ ...state, runner: { ...state.runner, runId: "run-2" } })],
    ["the stats", (state) => ({ ...state, stats: { ...state.stats, tasks: 99 } })],
    ["the question", (state) => ({ ...state, question: { id: "q", kind: "director", question: "?", context: "", options: [], askedAt: "x" } })],
  ]) assert.equal(reconcileAuthorChanges(base, base, change(base)).foreign, true, name);

  const at = new Date("2026-03-01T10:05:00.000Z");
  const written = (state) => ({ ...state, plan: { chapters: [{ number: 1, title: "A", slug: "001-a", summary: "", goal: "", pov: [], keyEvents: [], reveals: [], status: "done", scenes: [{ number: 1, title: "S", goal: "", beats: [], characters: [], status: "reviewed", revisions: 0 }] }], approved: true, rounds: 0, revisionNotes: [], readerReactions: [], readersDone: true, awaitingAuthor: false }, finalDone: true });
  const writtenBase = written(base);
  const stored = applyIntervention(writtenBase, { scope: "rewrite", text: "Make Orrin kinder." }, at, "a step");
  assert.ok(stored.revision && stored.finalDone === false);
  const merged = reconcileAuthorChanges({ ...writtenBase, finalDone: true }, writtenBase, stored);
  assert.equal(merged.foreign, false);
  assert.equal(merged.state.revision.instruction, "Make Orrin kinder.");
  assert.equal(merged.state.revision.targets, null);
  assert.equal(merged.state.finalDone, false, "the book has to be reviewed again after the rewrite");
  assert.ok(merged.state.constraints.includes("Make Orrin kinder."));
  assert.equal(merged.state.interventions.length, 1);
});

// ─── Q3: a note goes to one writing step ────────────────────────────────────

test("a note recorded before the chapter closes survives the closing and reaches the next writing step once", async () => {
  const store = new MemoryBookStore(seedBookFiles());
  const ai = createFakeAutopilotAi({ reviewVerdict: () => "approve" });
  const { session: autopilot } = session(store, ai);
  const off = pauseAfter(autopilot, "director-review");
  await autopilot.start(TWO_CHAPTERS);
  await autopilot.waitForIdle();
  off();
  const paused = stateOf(store);
  assert.equal(paused.review.verdict, "approve", "the next step is the closing of chapter 1");
  await autopilot.intervene({ scope: "next_step", text: "In the next scene Mira must find the torn letter." });
  const mark = ai.calls.length;
  await autopilot.start();
  await autopilot.waitForIdle();

  const carrying = ai.calls.slice(mark).filter((call) => /torn letter/.test(call.user));
  assert.deepEqual(carrying.map((call) => call.label), ["autopilot:scenes:2"], "only the next step that writes got it, and none before");
  assert.equal(occurrences(carrying[0].user, "torn letter"), 1);
  const final = stateOf(store);
  const note = final.interventions.find((entry) => /torn letter/.test(entry.text));
  assert.equal(note.status, "applied");
  const { activities } = await readStoredAutopilot(store);
  const applier = activities.find((activity) => activity.id === note.appliedBy);
  assert.equal(applier.task, "scenes", "applied by the step that delivered it");
  assert.equal(applier.chapterNumber, 2);
  const closing = activities.find((activity) => activity.task === "consolidate" && activity.chapterNumber === 1);
  assert.deepEqual(closing.interventionIds ?? [], [], "the closing took no note");
  assert.equal(activities.filter((activity) => (activity.interventionIds ?? []).includes(note.id)).length, 1, "and exactly one step lists it");
});

test("a note recorded before a repair is not delivered to the repair, and is delivered once to the writing step that follows", async () => {
  const store = new MemoryBookStore(seedBookFiles());
  const ai = createFakeAutopilotAi();
  const { session: autopilot } = session(store, ai);
  const off = pauseAfter(autopilot, "director-review");
  await autopilot.start(TWO_CHAPTERS_REVIEWED);
  await autopilot.waitForIdle();
  off();
  assert.equal(stateOf(store).review.verdict, "revise", "the director asked for a fix: the next step is the repair");
  await autopilot.intervene({ scope: "next_step", text: "In the next scene Mira must find the torn letter." });
  await autopilot.start();
  await autopilot.waitForIdle();

  const repair = ai.calls.find((call) => call.label === "autopilot:repair:1.1");
  assert.ok(repair, "the repair ran");
  assert.equal(occurrences(repair.user, "torn letter"), 0, "a repair of a scene that is already written is not told about the next one");
  const carrying = ai.calls.filter((call) => /torn letter/.test(call.user));
  assert.deepEqual(carrying.map((call) => call.label), ["autopilot:scenes:2"]);
  assert.equal(occurrences(carrying[0].user, "torn letter"), 1);
  const final = stateOf(store);
  const note = final.interventions.find((entry) => /torn letter/.test(entry.text));
  assert.equal(note.status, "applied");
  const { activities } = await readStoredAutopilot(store);
  assert.equal(activities.find((activity) => activity.id === note.appliedBy).task, "scenes");
  assert.equal(activities.filter((activity) => (activity.interventionIds ?? []).includes(note.id)).length, 1, "no other step lists it");
});

test("a note delivered to a rewrite for the author's revision is in its prompt once, and applied by it", async () => {
  const store = new MemoryBookStore(seedBookFiles());
  const ai = createFakeAutopilotAi({ reviewVerdict: () => "approve" });
  const { session: autopilot } = session(store, ai);
  await autopilot.start(ONE_CHAPTER);
  await autopilot.waitForIdle();
  assert.equal(stateOf(store).status, "completed");
  await autopilot.intervene({ scope: "rewrite", text: "Make Orrin kinder." });
  const off = pauseAfter(autopilot, "impact");
  await autopilot.start();
  await autopilot.waitForIdle();
  off();
  assert.ok(stateOf(store).revision?.targets?.length, "the impact is known; the rewrite is next");
  await autopilot.intervene({ scope: "next_step", text: "Keep the lighthouse offstage." });
  await autopilot.start();
  await autopilot.waitForIdle();

  const revise = ai.calls.find((call) => call.label === "autopilot:revise:1.1");
  assert.equal(occurrences(revise.user, "Keep the lighthouse offstage."), 1, "once, not as an instruction and again as a note");
  const final = stateOf(store);
  const note = final.interventions.find((entry) => entry.scope === "next_step");
  assert.equal(note.status, "applied");
  const { activities } = await readStoredAutopilot(store);
  assert.equal(activities.find((activity) => activity.id === note.appliedBy).task, "revise");
  assert.equal(final.status, "completed");
});

function plannerContext() {
  const snapshot = { files: new Map(), book: { title: "B", language: "en", description: "" }, chapters: [], canon: [], personaPaths: [], ghostwriterSlugs: [], hasDirector: false };
  return { snapshot, director: engine.defaultDirector("en"), readers: [], language: "en", storyDesignThin: false };
}

test("the steps that write accept notes; the closing of a chapter, the repair and the reviews do not", () => {
  const scene = (status) => ({ number: 1, title: "S", goal: "", beats: [], characters: [], status, slug: "001-s", path: "chapters/001-a/001-s.md", revisions: 0 });
  const chapter = (status, sceneStatus) => ({ number: 1, title: "A", slug: "001-a", summary: "", goal: "", pov: [], keyEvents: [], reveals: [], status, scenes: sceneStatus ? [scene(sceneStatus)] : [] });
  const review = { chapterNumber: 1, round: 1, readersPending: [], readerScores: [], readersSummaryDone: false, findings: [], specialistsDone: true, directorDone: true, verdict: "revise", decisions: [], repairQueue: [], previousFixes: [], history: [] };
  const state = (extra = {}, chapters = [chapter("review", "written")]) => ({
    ...createAutopilotState(new Date(0), { idea: "x", targetChapters: 1 }),
    concept: { done: true, generated: false, secrets: [] },
    plan: { chapters, approved: true, rounds: 0, revisionNotes: [], readerReactions: [], readersDone: true, awaitingAuthor: false },
    ...extra,
  });
  const next = (value) => {
    const step = engine.nextStep(value, plannerContext());
    assert.equal(step.kind, "task", JSON.stringify(step));
    return step.task;
  };

  assert.deepEqual([next(state({}, [chapter("planned")])).kind, next(state({}, [chapter("planned")])).acceptsNotes], ["scenes", true]);
  assert.deepEqual([next(state({}, [chapter("writing", "planned")])).kind, next(state({}, [chapter("writing", "planned")])).acceptsNotes], ["write", true]);
  assert.deepEqual([next({ ...createAutopilotState(new Date(0)) }).kind, next({ ...createAutopilotState(new Date(0)) }).acceptsNotes], ["concept", true]);
  assert.deepEqual([next({ ...createAutopilotState(new Date(0)), concept: { done: true, generated: false, secrets: [] } }).kind], ["plan"]);
  assert.equal(next({ ...createAutopilotState(new Date(0)), concept: { done: true, generated: false, secrets: [] } }).acceptsNotes, true);
  const revising = state({ revision: { id: "r", instruction: "x", createdAt: "x", targets: [{ chapterNumber: 1, sceneNumber: 1, instruction: "y" }], cursor: 0 } }, [chapter("done", "reviewed")]);
  assert.deepEqual([next(revising).kind, next(revising).acceptsNotes], ["revise", true]);

  const repairing = state({ review: { ...review, repairQueue: [1] } });
  assert.deepEqual([next(repairing).kind, next(repairing).acceptsNotes], ["repair", false], "a repair applies the director's fixes to a scene that is written");
  const closing = state({ review });
  assert.deepEqual([next(closing).kind, next(closing).acceptsNotes], ["consolidate", false], "closing a chapter writes no prose");
  for (const [kind, value] of [
    ["specialists", state({ review: { ...review, specialistsDone: false, directorDone: false } })],
    ["director-review", state({ review: { ...review, directorDone: false } })],
    ["plan-review", state({ plan: { chapters: [chapter("planned")], approved: false, rounds: 0, revisionNotes: [], readerReactions: [], readersDone: true, awaitingAuthor: false } })],
    ["impact", state({ revision: { id: "r", instruction: "x", createdAt: "x", targets: null, cursor: 0 } }, [chapter("done", "reviewed")])],
    ["final", state({}, [chapter("done", "reviewed")])],
  ]) assert.deepEqual([next(value).kind, next(value).acceptsNotes], [kind, false], kind);
});

// ─── Q4: rules can be edited, removed and are capped ────────────────────────

async function pausedBookWithRules(...rules) {
  const store = new MemoryBookStore(seedBookFiles());
  const ai = createFakeAutopilotAi();
  const { session: autopilot, events } = session(store, ai);
  for (const text of rules) await autopilot.intervene({ scope: "from_now", text });
  return { store, ai, autopilot, events };
}

const ruleError = (code, pattern) => (error) => error?.code === code && pattern.test(error.message) && error.name === "AutopilotRuleError";

test("a rule can be edited in place and removed; the summary follows, the next prompt has the new text and not the old one", async () => {
  const { store, ai, autopilot, events } = await pausedBookWithRules("Never use the word suddenly.", "No adverbs.");
  assert.equal(typeof autopilot.updateRule, "function", "a session method");
  assert.equal(typeof autopilot.removeRule, "function", "a session method");
  const edited = await autopilot.updateRule(0, "Never use the word abruptly.", "Never use the word suddenly.");
  assert.deepEqual(edited.constraints, ["Never use the word abruptly.", "No adverbs."], "in place: the other rule keeps its place");
  assert.deepEqual(stateOf(store).constraints, ["Never use the word abruptly.", "No adverbs."], "saved");
  const summary = events.filter((event) => event.type === "state").at(-1).state;
  assert.equal(summary.constraints, 2, "the summary of the saved change");

  const removed = await autopilot.removeRule(1, "No adverbs.");
  assert.deepEqual(removed.constraints, ["Never use the word abruptly."]);
  assert.equal(events.filter((event) => event.type === "state").at(-1).state.constraints, 1, "the count in the summary follows");

  await autopilot.start(ONE_CHAPTER);
  await autopilot.waitForIdle();
  assert.ok(ai.calls.length > 5);
  for (const call of ai.calls) {
    assert.doesNotMatch(call.user, /suddenly|No adverbs/, `the old rules are gone from ${call.label}`);
  }
  const concept = ai.calls.find((call) => call.label === "autopilot:concept");
  assert.equal(occurrences(concept.user, "Never use the word abruptly."), 1);
  assert.deepEqual(stateOf(store).constraints, ["Never use the word abruptly."]);
});

test("a rule changed in the meantime is not overwritten or removed: the stale text is refused with a clear error and nothing is written", async () => {
  const { store, autopilot } = await pausedBookWithRules("Never use the word suddenly.", "No adverbs.");
  const commits = store.commits.length;
  const before = store.files.get(STATE);

  await assert.rejects(() => autopilot.updateRule(0, "Something else.", "An older version of the rule."), ruleError("rule_changed", /changed/i));
  await assert.rejects(() => autopilot.removeRule(1, "An older version of the rule."), ruleError("rule_changed", /changed/i));
  assert.equal(store.commits.length, commits, "nothing was committed");
  assert.equal(store.files.get(STATE), before);

  // Two people edit the same rule: whoever saved first wins, the other is told.
  const other = new AutopilotSession({ bookId: "book-1", store, ai: createFakeAutopilotAi(), host: "browser", hostLabel: "Browser", hostId: "device-1" });
  await other.updateRule(0, "Never use the word abruptly.", "Never use the word suddenly.");
  await assert.rejects(() => autopilot.updateRule(0, "Mine.", "Never use the word suddenly."), ruleError("rule_changed", /changed/i));
  assert.deepEqual(stateOf(store).constraints, ["Never use the word abruptly.", "No adverbs."]);

  // Without an expected text the operation applies to whatever is at that place.
  await autopilot.updateRule(1, "No adverbs at all.");
  assert.deepEqual(stateOf(store).constraints, ["Never use the word abruptly.", "No adverbs at all."]);
});

test("updating or removing a rule that is not there, an empty one, or a copy of another is refused", async () => {
  const { store, autopilot } = await pausedBookWithRules("Never use the word suddenly.", "No adverbs.");
  const before = store.files.get(STATE);
  await assert.rejects(() => autopilot.updateRule(2, "x"), ruleError("rule_not_found", /rule/i));
  await assert.rejects(() => autopilot.updateRule(-1, "x"), ruleError("rule_not_found", /rule/i));
  await assert.rejects(() => autopilot.removeRule(5), ruleError("rule_not_found", /rule/i));
  await assert.rejects(() => autopilot.updateRule(0, "   "), /empty/i);
  await assert.rejects(() => autopilot.updateRule(0, "No adverbs."), ruleError("rule_duplicate", /already/i));
  assert.equal(store.files.get(STATE), before, "nothing was written");
  const same = await autopilot.updateRule(0, "  Never use the word suddenly.  ");
  assert.deepEqual(same.constraints, ["Never use the word suddenly.", "No adverbs."], "the same text, trimmed, changes nothing");
});

test("a rule is capped at 800 characters: longer text is refused with the limit in the message, never cut", async () => {
  assert.equal(engine.MAX_RULE_CHARACTERS, 800, "exported");
  const { store, autopilot } = await pausedBookWithRules("Never use the word suddenly.");
  const exact = "x".repeat(800);
  await autopilot.intervene({ scope: "from_now", text: exact });
  assert.equal(stateOf(store).constraints.at(-1).length, 800, "800 is fine");
  const before = store.files.get(STATE);
  const commits = store.commits.length;

  const tooLong = "y".repeat(801);
  for (const scope of ["from_now", "rewrite"]) {
    await assert.rejects(() => autopilot.intervene({ scope, text: tooLong }), ruleError("rule_too_long", /800/), scope);
  }
  await assert.rejects(() => autopilot.updateRule(0, tooLong, "Never use the word suddenly."), ruleError("rule_too_long", /800 characters/));
  await assert.rejects(() => autopilot.intervene({ scope: "from_now", text: `${" ".repeat(50)}${tooLong}` }), ruleError("rule_too_long", /800/), "the spaces around it do not count, the text does");
  assert.equal(store.files.get(STATE), before, "nothing was written, nothing cut");
  assert.equal(store.commits.length, commits);

  const note = await autopilot.intervene({ scope: "next_step", text: "z".repeat(3000) });
  assert.equal(note.interventions.at(-1).text.length, 3000, "a note is used once and is not a rule: it keeps its length");
  assert.equal(note.constraints.length, 2);

  const run = new AutopilotRun({ bookId: "book-1", store: new MemoryBookStore(seedBookFiles()), ai: createFakeAutopilotAi(), host: "server", hostLabel: "t", emit: () => undefined });
  assert.throws(() => run.intervene({ scope: "from_now", text: tooLong }), ruleError("rule_too_long", /800/), "a bare run refuses it when it is handed over, not when a step later drains it");
  assert.equal(MAX_CONSTRAINTS, 80, "the cap on the number of rules is unchanged");
});

test("rules saved by older versions (a plain array of strings) are valid and can be edited", async () => {
  const state = JSON.stringify({ schemaVersion: 1, status: "paused", constraints: ["Old rule one.", "Old rule two."], interventions: [], brief: { idea: "x" } });
  const store = new MemoryBookStore({ ...seedBookFiles(), [STATE]: state });
  const { session: autopilot } = session(store, createFakeAutopilotAi());
  assert.deepEqual((await autopilot.snapshot()).state.constraints, ["Old rule one.", "Old rule two."]);
  const updated = await autopilot.updateRule(1, "New rule two.", "Old rule two.");
  assert.deepEqual(updated.constraints, ["Old rule one.", "New rule two."]);
  assert.deepEqual(stateOf(store).constraints, ["Old rule one.", "New rule two."]);
  assert.ok(Array.isArray(JSON.parse(store.files.get(STATE)).constraints), "still an array of strings on disk");
  assert.ok(JSON.parse(store.files.get(STATE)).constraints.every((rule) => typeof rule === "string"));
});

test("a rule edited or removed while a step runs is saved at once, merged by the step's commit, and the next prompt has the new text only", async () => {
  const store = new MemoryBookStore(seedBookFiles());
  const { ai, gate, reached } = holdingAi((request) => request.label === "autopilot:plan");
  const { session: autopilot, events } = session(store, ai);
  await autopilot.intervene({ scope: "from_now", text: "Never use the word suddenly." });
  await autopilot.intervene({ scope: "from_now", text: "No adverbs." });
  await autopilot.start(ONE_CHAPTER);
  await reached;
  await autopilot.updateRule(0, "Never use the word abruptly.", "Never use the word suddenly.");
  await autopilot.removeRule(1, "No adverbs.");
  assert.deepEqual(stateOf(store).constraints, ["Never use the word abruptly."], "saved before the step ends");
  gate.resolve();
  await autopilot.waitForIdle();
  assert.equal(ai.calls.filter((call) => call.label === "autopilot:plan").length, 1, "the step was not repeated");
  assert.ok(!events.some((event) => event.type === "insight" && event.code === "conflictRetry"));
  assert.deepEqual(stateOf(store).constraints, ["Never use the word abruptly."], "the step's commit did not bring the old rules back");
  const later = ai.calls.slice(ai.calls.findIndex((call) => call.label === "autopilot:plan") + 1);
  assert.ok(later.length > 3);
  const afterPlan = later.filter((call) => call.user.includes("Binding author rules"));
  assert.ok(afterPlan.length > 0);
  for (const call of afterPlan) {
    assert.match(call.user, /Never use the word abruptly\./, call.label);
    assert.doesNotMatch(call.user, /suddenly|No adverbs/, call.label);
  }
});

test("an answer to the director's question is a one-time note, unless the author asks for a rule", async () => {
  const asking = () => {
    const base = createFakeAutopilotAi();
    return {
      calls: base.calls,
      async complete(request) {
        if (request.json?.name !== "plan_review") return base.complete(request);
        base.calls.push(request);
        const json = { verdict: "approve", score: 8, summary: "Good plan.", strengths: [], changes: [], guidance: [], questionForAuthor: { question: "Should Orrin be redeemed?", options: ["Yes", "No"] } };
        return { text: JSON.stringify(json), json, usage: { inputTokens: 100, outputTokens: 50, cachedInputTokens: 0 }, model: "fake-model", provider: "fake", cost: 0.001, currency: "USD" };
      },
    };
  };
  const answered = async (answer) => {
    const store = new MemoryBookStore(seedBookFiles());
    const ai = asking();
    const { session: autopilot } = session(store, ai);
    await autopilot.start(ONE_CHAPTER);
    await autopilot.waitForIdle();
    const question = stateOf(store).question;
    assert.equal(question.question, "Should Orrin be redeemed?");
    const after = await autopilot.answer({ questionId: question.id, ...answer });
    return { store, ai, autopilot, after };
  };

  const note = await answered({ answer: "No, never.", accept: false });
  assert.deepEqual(note.after.constraints, [], "by default the answer is a note, as before");
  assert.deepEqual(note.after.interventions.map((entry) => [entry.scope, entry.status]), [["next_step", "pending"]]);

  const rule = await answered({ answer: "No, never.", accept: false, asRule: true });
  assert.deepEqual(rule.after.constraints, ["Answer to the director's question «Should Orrin be redeemed?»: No, never."], "asRule makes it a permanent rule");
  assert.ok(!rule.after.interventions.some((entry) => entry.status === "pending"), "and not also a note");
  assert.equal(rule.after.interventions.length, 1);
  assert.equal(rule.after.interventions[0].scope, "from_now");
  assert.equal(rule.after.question, null);
  await rule.autopilot.start();
  await rule.autopilot.waitForIdle();
  const writing = rule.ai.calls.find((call) => call.label === "autopilot:scenes:1");
  assert.equal(occurrences(writing.user, "Should Orrin be redeemed?"), 1, "the rule is in every later prompt, once");
  const write = rule.ai.calls.find((call) => call.label === "autopilot:write:1.1");
  assert.equal(occurrences(write.user, "Should Orrin be redeemed?"), 1, "still there for the next step: a rule is not used up");

  const accepted = await answered({ answer: "No, never.", accept: true, asRule: true });
  assert.deepEqual(accepted.after.constraints, [], "accepting the work records nothing, whatever asRule says");

  const store = new MemoryBookStore(seedBookFiles());
  const ai = asking();
  const { session: autopilot } = session(store, ai);
  await autopilot.start(ONE_CHAPTER);
  await autopilot.waitForIdle();
  const question = stateOf(store).question;
  const before = store.files.get(STATE);
  await assert.rejects(() => autopilot.answer({ questionId: question.id, answer: "n".repeat(900), asRule: true }), ruleError("rule_too_long", /800/));
  assert.equal(store.files.get(STATE), before, "a rule that is too long is refused and the question stays open");
  assert.equal(stateOf(store).question.id, question.id);
});

// ─── a storm of saves while a run works ─────────────────────────────────────

/** A small deterministic generator, so that a failing storm can be replayed. */
function seeded(seed) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

async function storm(seed, { risky }) {
  const random = seeded(seed * 7919);
  const store = new AtomicStore(seedBookFiles());
  const ai = createFakeAutopilotAi({ delayMs: 4, reviewVerdict: () => "approve" });
  const { session: autopilot, events } = session(store, ai, { persistHeartbeatMs: 2 + Math.floor(random() * 5), heartbeatMs: 3 });
  await autopilot.start({ brief: { idea: "x", targetChapters: 2, scenesPerChapter: 1, wordsPerScene: 300 }, options: { readers: false, readersOnPlan: false, pauseAfterPlan: false } });
  const rules = [];
  const notes = [];
  const rewrites = [];
  let counter = 0;
  while (autopilot.running) {
    await sleep(Math.floor(random() * 6));
    if (!autopilot.running) break;
    counter += 1;
    const pick = random();
    if (pick < 0.3) {
      const text = `notetoken${counter}x`;
      await autopilot.intervene({ scope: "next_step", text, interrupt: risky && random() < 0.1 });
      notes.push(text);
    } else if (pick < 0.55) {
      const text = `ruletoken${counter}x`;
      await autopilot.intervene({ scope: "from_now", text, interrupt: risky && random() < 0.1 });
      rules.push(text);
    } else if (pick < 0.6 && risky) {
      const text = `rewritetoken${counter}x`;
      await autopilot.intervene({ scope: "rewrite", text });
      rules.push(text);
      rewrites.push(text);
    } else if (pick < 0.8 && rules.length) {
      const index = Math.floor(random() * rules.length);
      const text = `editedtoken${counter}x`;
      await autopilot.updateRule(index, text, rules[index]);
      rules[index] = text;
    } else if (rules.length) {
      const index = Math.floor(random() * rules.length);
      await autopilot.removeRule(index, rules[index]);
      rules.splice(index, 1);
    } else {
      await autopilot.snapshot();
    }
  }
  await autopilot.waitForIdle();
  return { store, ai, events, rules, notes, rewrites, counter, state: stateOf(store), activities: (await readStoredAutopilot(store)).activities };
}

test("a storm of interventions and rule edits while a run works: nothing is lost, delivered twice or repeated, whatever the timing", async () => {
  const labels = await baselineLabels(TWO_CHAPTERS_STORM, { delayMs: 4, reviewVerdict: () => "approve" });
  for (const seed of [1, 2, 3, 4, 5, 6]) {
    const { ai, events, rules, notes, counter, state, activities } = await storm(seed, { risky: false });
    const where = `seed ${seed}, ${counter} operations`;
    assert.equal(state.status, "completed", `${where}: ${state.lastError?.message}`);
    assert.deepEqual(labelsOf(ai), labels, `${where}: the AI was called exactly as without the storm`);
    assert.ok(!events.some((event) => event.type === "insight" && ["conflictRetry", "failureRetry"].includes(event.code)), `${where}: no step was repeated`);
    assert.deepEqual(state.constraints, rules, `${where}: the rules are what the author left`);
    const saved = state.interventions.filter((entry) => entry.scope === "next_step");
    assert.deepEqual(saved.map((entry) => entry.text), notes, `${where}: every note is saved, in order`);
    for (const note of saved) {
      const listing = activities.filter((activity) => (activity.interventionIds ?? []).includes(note.id));
      const carrying = ai.calls.filter((call) => call.user.includes(note.text));
      if (note.status === "applied") {
        assert.equal(listing.length, 1, `${where}: ${note.text} is applied by one step`);
        assert.equal(carrying.length, 1, `${where}: ${note.text} reached one request`);
        assert.equal(carrying[0].label.replace(/:.*/, ""), "autopilot", where);
        assert.equal(listing[0].task, ["concept", "plan", "scenes", "write", "revise"].find((task) => carrying[0].label.startsWith(`autopilot:${task}`)), `${where}: and that request is the step that applied it`);
      } else {
        assert.deepEqual([listing.length, carrying.length], [0, 0], `${where}: a note that was never delivered is still pending`);
      }
    }
  }
});

test("the same storm with rewrite requests and interrupts: every save is kept and the book is still completed", async () => {
  for (const seed of [11, 12, 13, 14]) {
    const { events, rules, notes, rewrites, counter, state } = await storm(seed, { risky: true });
    const where = `seed ${seed}, ${counter} operations`;
    assert.equal(state.status, "completed", `${where}: ${state.lastError?.message}`);
    assert.deepEqual(state.constraints, rules, `${where}: the rules are what the author left`);
    assert.equal(state.interventions.filter((entry) => entry.scope === "next_step").length, notes.length, `${where}: every note is saved`);
    assert.equal(state.interventions.filter((entry) => entry.scope === "rewrite").length, rewrites.length, `${where}: every rewrite request is saved`);
    assert.ok(!events.some((event) => event.type === "insight" && event.code === "failureRetry"), where);
  }
});
