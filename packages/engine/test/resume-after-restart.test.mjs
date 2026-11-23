import test from "node:test";
import assert from "node:assert/strict";
import * as engine from "../dist/index.js";
import { MemoryBookStore, createFakeAutopilotAi, seedBookFiles } from "../dist/testing/index.js";

// New exports are read from the namespace so that, before they exist, each test fails on its own.
const { AutopilotBusyError, AutopilotSession, createAutopilotState, normalizeAutopilotState, parseAutopilotState, serializeAutopilotState } = engine;

// ─── «Resume after a restart»: what the engine keeps for a server that stopped while a run went on ──────────────────────
// The option (`options.resumeAfterRestart`) is the author's, off unless turned on. The server's stop pauses the run with its own word in the
// state (`stoppedBy: "server-shutdown"`), which a pause of the author never writes and any start, or a pause of the author, takes away. What
// the server does with them when it starts again is the server's (its tests); here, what the session offers it.

const STATE = "autopilot/state.json";
const FAST = { readers: false, readersOnPlan: false, specialists: false, pauseAfterPlan: false };
const TWO = { brief: { idea: "x", targetChapters: 2, scenesPerChapter: 1, wordsPerScene: 300 }, options: FAST };
const HELD = "autopilot:write:1.1";

const fakeAi = () => createFakeAutopilotAi({ chapters: 2, scenes: 1, reviewVerdict: () => "approve" });
const stateOf = (store) => parseAutopilotState(store.files.get(STATE));
const runEnded = (events) => events.filter((event) => event.type === "run-ended");
const insights = (events, code) => events.filter((event) => event.type === "insight" && event.code === code);

function newSession(store, ai, extra = {}) {
  const events = [];
  const session = new AutopilotSession({ bookId: "book", store, ai, host: "server", hostLabel: "test server", hostId: "server-1", retryDelayMs: 0, ...extra });
  session.subscribe((event) => events.push(event));
  return { session, events };
}

function deferred() {
  let resolve = () => undefined;
  const promise = new Promise((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

/** The fake AI, holding the first request labelled `label` until `release()` (or until the run abandons it); `reached` says it is held. */
function holdingAi(label = HELD) {
  const base = fakeAi();
  const gate = deferred();
  const reached = deferred();
  let held = false;
  return {
    calls: base.calls,
    reached: reached.promise,
    release: () => gate.resolve(),
    async complete(request) {
      if (!held && request.label === label) {
        held = true;
        reached.resolve();
        await new Promise((resolve, reject) => {
          gate.promise.then(resolve);
          request.signal?.addEventListener("abort", () => reject(request.signal.reason), { once: true });
        });
      }
      return base.complete(request);
    },
  };
}

/** A book whose run is held in the middle of its first scene: the run is active, four steps are saved. */
async function heldRun({ options = {}, language = "en", extra = {} } = {}) {
  const store = new MemoryBookStore(seedBookFiles({ language }));
  const ai = holdingAi();
  const { session, events } = newSession(store, ai, extra);
  await session.start({ brief: TWO.brief, options: { ...FAST, ...options } });
  await ai.reached;
  return { store, ai, session, events };
}

/** A book whose run the server's stop paused: the state says `stoppedBy: "server-shutdown"`. */
async function stoppedByServer(options = { resumeAfterRestart: true }) {
  const run = await heldRun({ options });
  assert.equal(run.session.stopForShutdown(), true);
  await run.session.waitForIdle();
  assert.equal(stateOf(run.store).stoppedBy, "server-shutdown");
  return run;
}

/** A state file as a host left it: `change` edits a new state of the book. */
function withState(change, files = seedBookFiles()) {
  const state = change(createAutopilotState(new Date(), TWO.brief, { ...FAST, resumeAfterRestart: true }));
  return new MemoryBookStore({ ...files, [STATE]: serializeAutopilotState(state) });
}

const minutesAgo = (minutes) => new Date(Date.now() - minutes * 60_000).toISOString();
const runner = (extra = {}) => ({ host: "server", label: "test server", hostId: "server-1", runId: "run_old", startedAt: minutesAgo(30), heartbeatAt: minutesAgo(1), ...extra });

// ─── The option ─────────────────────────────────────────────────────────────

test("options.resumeAfterRestart is off unless the author turns it on: absent in the defaults, in a new state and in a file that does not say it", () => {
  assert.equal(engine.DEFAULT_OPTIONS.resumeAfterRestart, undefined, "off by default");
  assert.deepEqual(engine.normalizeOptions({}), engine.DEFAULT_OPTIONS, "an empty request adds nothing");
  assert.equal(createAutopilotState(new Date()).options.resumeAfterRestart, undefined, "a new book has it off");
  const older = JSON.parse(serializeAutopilotState(createAutopilotState(new Date())));
  delete older.options.resumeAfterRestart;
  assert.equal(normalizeAutopilotState(older).options.resumeAfterRestart, undefined, "a file of an older engine reads off");
  assert.ok(engine.LIVE_AUTOPILOT_OPTIONS.includes("resumeAfterRestart"), "it can change while a run goes on");
});

test("options.resumeAfterRestart is read as every switch of the options: true turns it on, false off, and what is neither leaves it as it was", () => {
  const on = engine.normalizeOptions({ resumeAfterRestart: true });
  assert.equal(on.resumeAfterRestart, true);
  assert.equal(engine.normalizeOptions({ resumeAfterRestart: "true" }).resumeAfterRestart, true, "a hand-edited file that says it in words");
  assert.equal("resumeAfterRestart" in engine.normalizeOptions({ resumeAfterRestart: false }, on), false, "false turns it off, and off is written as nothing");
  for (const odd of [1, 0, "yes", "", null, {}, [], "TRUE"]) {
    assert.equal(engine.normalizeOptions({ resumeAfterRestart: odd }, on).resumeAfterRestart, true, `${JSON.stringify(odd)} leaves it on`);
    assert.equal(engine.normalizeOptions({ resumeAfterRestart: odd }).resumeAfterRestart, undefined, `${JSON.stringify(odd)} leaves it off`);
  }
  const saved = parseAutopilotState(serializeAutopilotState(createAutopilotState(new Date(), {}, { resumeAfterRestart: true })));
  assert.equal(saved.options.resumeAfterRestart, true, "it is saved with the other options");
});

test("options.resumeAfterRestart changes while a run goes on, and the run keeps the author's value in every state it saves after", async () => {
  const { store, ai, session } = await heldRun();
  const changed = await session.updateOptions({ resumeAfterRestart: true });
  assert.equal(changed.options.resumeAfterRestart, true, "saved at once, while the step is held");
  assert.equal(stateOf(store).options.resumeAfterRestart, true);
  await assert.rejects(() => session.updateOptions({ resumeAfterRestart: false, readers: true }), AutopilotBusyError, "with a setting that cannot change during a run, nothing of the request is applied");
  assert.equal(stateOf(store).options.resumeAfterRestart, true);
  ai.release();
  await session.waitForIdle();
  const done = stateOf(store);
  assert.equal(done.status, "completed", done.lastError?.message);
  assert.equal(done.options.resumeAfterRestart, true, "the steps saved after the change did not take it back");
  const off = await session.updateOptions({ resumeAfterRestart: false });
  assert.equal("resumeAfterRestart" in off.options, false, "turned off with no run");
});

// ─── The server's stop ──────────────────────────────────────────────────────

test("stoppedBy as a file says it: only `server-shutdown`, only on a paused state; anything else is no word at all", () => {
  const base = JSON.parse(serializeAutopilotState(createAutopilotState(new Date())));
  assert.equal(normalizeAutopilotState({ ...base, status: "paused", stoppedBy: "server-shutdown" }).stoppedBy, "server-shutdown");
  assert.equal("stoppedBy" in normalizeAutopilotState({ ...base, status: "paused" }), false, "a missing field is none (null), as in older files");
  for (const status of ["running", "idle", "completed", "error", "waiting-author"]) {
    assert.equal("stoppedBy" in normalizeAutopilotState({ ...base, status, stoppedBy: "server-shutdown" }), false, `not on a ${status} state`);
  }
  for (const odd of ["SERVER-SHUTDOWN", " server-shutdown", "author", "", null, 1, true, ["server-shutdown"], { by: "server-shutdown" }]) {
    assert.equal("stoppedBy" in normalizeAutopilotState({ ...base, status: "paused", stoppedBy: odd }), false, JSON.stringify(odd));
  }
});

test("the server's stop pauses the run now and says so in the state: stoppedBy server-shutdown, its message, and the code of the end of the run", async () => {
  const { store, session, events } = await heldRun();
  assert.equal(session.stopForShutdown(), true);
  await session.waitForIdle();
  const state = stateOf(store);
  assert.equal(state.status, "paused");
  assert.equal(state.stoppedBy, "server-shutdown");
  assert.equal(state.message, "Paused because the server stopped.");
  assert.equal(state.runner, null);
  assert.equal(runEnded(events).at(-1).code, "serverShutdown");
  assert.equal(session.stopForShutdown(), false, "with nothing running there is nothing to stop");

  const italian = await heldRun({ language: "it" });
  italian.session.stopForShutdown();
  await italian.session.waitForIdle();
  assert.equal(stateOf(italian.store).message, "In pausa perché il server si è fermato.", "in the language of the book");
});

test("a pause of the author never writes the server's word: now, at the end of the step, and one asked before the server's stop", async () => {
  for (const [what, pause] of [["now", (session) => session.pause("now")], ["after the step, then the server's stop", (session) => {
    session.pause("after-step");
    session.stopForShutdown();
  }], ["at the end of the chapter, then the server's stop", (session) => {
    session.pause("after-chapter");
    session.stopForShutdown();
  }]]) {
    const { store, session, events } = await heldRun();
    pause(session);
    await session.waitForIdle();
    const state = stateOf(store);
    assert.equal(state.status, "paused", what);
    assert.equal("stoppedBy" in state, false, what);
    assert.notEqual(state.message, "Paused because the server stopped.", what);
    assert.notEqual(runEnded(events).at(-1).code, "serverShutdown", what);
  }
});

test("the server's stop of a start in flight pauses the run as soon as it exists, with the server's word; a pause of the author asked first stays the author's", async () => {
  const store = new MemoryBookStore(seedBookFiles());
  const { session } = newSession(store, fakeAi());
  const starting = session.start(TWO);
  assert.equal(session.stopForShutdown(), true, "a start in flight is stopped");
  await starting;
  await session.waitForIdle();
  assert.equal(stateOf(store).status, "paused");
  assert.equal(stateOf(store).stoppedBy, "server-shutdown");

  const other = new MemoryBookStore(seedBookFiles());
  const { session: second } = newSession(other, fakeAi());
  const again = second.start(TWO);
  second.pause("now");
  second.stopForShutdown();
  await again;
  await second.waitForIdle();
  assert.equal(stateOf(other).status, "paused");
  assert.equal("stoppedBy" in stateOf(other), false);
});

test("any start takes the server's word away: a resume, and a single step", async () => {
  const { store, session } = await stoppedByServer();
  const ai = holdingAi("autopilot:director-review:1");
  const { session: resumed, events } = newSession(store, ai);
  await resumed.start();
  await ai.reached;
  assert.equal(stateOf(store).status, "running");
  assert.equal("stoppedBy" in stateOf(store), false, "gone as soon as the run saved its start");
  assert.equal(insights(events, "resumedAfterRestart").length, 0, "a resume of the author says nothing of a restart");
  resumed.stopForShutdown();
  await resumed.waitForIdle();
  assert.equal(stateOf(store).stoppedBy, "server-shutdown", "stopped again by the server");

  await session.start({ limits: { steps: 1 } });
  await session.waitForIdle();
  assert.equal(stateOf(store).status, "paused", "one step, then paused as asked");
  assert.equal("stoppedBy" in stateOf(store), false);
});

test("a pause of the author with nothing running takes the server's word away (forgetStopCause); with nothing to take away it writes nothing", async () => {
  const { store, session } = await stoppedByServer();
  const version = stateOf(store).version;
  assert.equal(session.pause("after-step"), false, "nothing runs: nothing to pause, and pause() itself writes nothing");
  assert.equal(stateOf(store).version, version);
  const forgot = await session.forgetStopCause();
  assert.equal(forgot.status, "paused");
  assert.equal("stoppedBy" in forgot, false);
  assert.equal("stoppedBy" in stateOf(store), false, "the file says so");
  assert.equal(stateOf(store).version, version + 1, "one write");
  assert.equal(await session.restartResumeCause(), null, "a server that starts again does not resume it");
  assert.equal(await session.forgetStopCause(), null, "a second time there is nothing to take away");
  assert.equal(stateOf(store).version, version + 1, "and nothing is written");

  const empty = new MemoryBookStore(seedBookFiles());
  assert.equal(await newSession(empty, fakeAi()).session.forgetStopCause(), null);
  assert.equal(empty.files.has(STATE), false, "a book without a state does not get one");
  const corrupt = new MemoryBookStore({ ...seedBookFiles(), [STATE]: "{ not json" });
  assert.equal(await newSession(corrupt, fakeAi()).session.forgetStopCause(), null, "a state that cannot be read is no error here");
  assert.equal(corrupt.files.get(STATE), "{ not json", "and it is left as it is");

  const { ai, session: active } = await heldRun();
  assert.equal(await active.forgetStopCause(), null, "a run that is active has nothing to take away");
  ai.release();
  await active.waitForIdle();
});

test("a start of the host after a restart says so first, in the language of the book; no other start does", async () => {
  for (const [language, title] of [["en", "Resumed by itself after the server restarted."], ["it", "Ripreso da solo dopo il riavvio del server."]]) {
    const store = new MemoryBookStore(seedBookFiles({ language }));
    const { session, events } = newSession(store, fakeAi());
    await session.start({ ...TWO, afterRestart: true, limits: { steps: 1 } });
    await session.waitForIdle();
    const said = insights(events, "resumedAfterRestart");
    assert.equal(said.length, 1, language);
    assert.equal(said[0].title, title);
    assert.equal(said[0].tone, "info");
    const order = events.map((event) => event.type === "insight" ? event.code : event.type);
    assert.ok(order.indexOf("run-started") < order.indexOf("resumedAfterRestart"), "right after the run started");
    assert.ok(order.indexOf("resumedAfterRestart") < order.indexOf("task-started"), "before its first step");
  }
});

// ─── What a server that starts again finds ──────────────────────────────────

test("restartResumeCause: a run going on when the host stopped, or paused by the server's stop, with the option on; nothing else", async () => {
  const cause = (store, extra) => newSession(store, fakeAi(), extra).session.restartResumeCause();
  assert.equal(await cause(new MemoryBookStore(seedBookFiles())), null, "no state");
  assert.equal(await cause(withState((state) => ({ ...state, status: "paused", stoppedBy: "server-shutdown" }))), "server-shutdown");
  assert.equal(await cause(withState((state) => ({ ...state, status: "paused" }))), null, "a pause of the author, or of the run itself");
  assert.equal(await cause(withState((state) => ({ ...state, status: "paused", stoppedBy: "server-shutdown", options: { ...state.options, resumeAfterRestart: undefined } }))), null, "the option off");
  assert.equal(await cause(withState((state) => ({ ...state, status: "running", runner: runner() }))), "interrupted", "this server's runner, its process gone");
  assert.equal(await cause(withState((state) => ({ ...state, status: "running", runner: runner({ heartbeatAt: minutesAgo(40) }) }))), "interrupted", "a runner silent for too long");
  assert.equal(await cause(withState((state) => ({ ...state, status: "running", runner: runner({ host: "browser", hostId: "device-1", label: "a browser" }) }))), null, "another host's run that is alive");
  assert.equal(await cause(withState((state) => ({ ...state, status: "running", runner: runner({ host: "browser", hostId: "device-1", label: "a browser", heartbeatAt: minutesAgo(40) }) }))), "interrupted", "another host's run, silent for too long");
  assert.equal(await cause(withState((state) => ({ ...state, status: "running", runner: runner({ hostId: "server-2" }) }))), null, "another server's run that is alive");
  for (const status of ["idle", "completed", "error", "waiting-author"]) {
    assert.equal(await cause(withState((state) => ({ ...state, status, runner: null }))), null, status);
  }
  assert.equal(await cause(new MemoryBookStore({ ...seedBookFiles(), [STATE]: "{ not json" })), null, "a state that cannot be read");

  const { store } = await stoppedByServer();
  const ai = holdingAi("autopilot:director-review:1");
  const { session: active } = newSession(store, ai);
  await active.start();
  await ai.reached;
  assert.equal(await active.restartResumeCause(), null, "a run active here");
  active.pause("now");
  await active.waitForIdle();
});

test("holdAfterRestart: the run waits for the author with the reason in its message, a running state is paused, and the server's word goes", async () => {
  const paused = withState((state) => ({ ...state, status: "paused", stoppedBy: "server-shutdown", message: "Paused because the server stopped." }));
  const { session } = newSession(paused, fakeAi());
  const held = await session.holdAfterRestart({ times: 3, hours: 24 });
  assert.equal(held.status, "paused");
  assert.equal("stoppedBy" in held, false);
  assert.equal(held.message, "Not resumed after the server restart: the autopilot already resumed by itself 3 times in the last 24 hours. Resume it when you are ready.");
  assert.deepEqual([stateOf(paused).status, stateOf(paused).message, "stoppedBy" in stateOf(paused)], [held.status, held.message, false], "and it is what the file says");
  assert.equal(await session.restartResumeCause(), null, "only the author resumes it now");
  const version = stateOf(paused).version;
  assert.equal(await session.holdAfterRestart({ times: 3, hours: 24 }), null, "a second time there is nothing to hold");
  assert.equal(stateOf(paused).version, version, "and nothing is written");

  const running = withState((state) => ({ ...state, status: "running", runner: runner() }), seedBookFiles({ language: "it" }));
  const italian = await newSession(running, fakeAi()).session.holdAfterRestart({ times: 3, hours: 24 });
  assert.equal(italian.status, "paused");
  assert.equal(italian.runner, null);
  assert.equal(italian.message, "Non ripreso dopo il riavvio del server: l'autopilot si è già ripreso da solo 3 volte nelle ultime 24 ore. Riprendilo quando vuoi.");

  const authorPaused = withState((state) => ({ ...state, status: "paused", message: "Mine." }));
  const before = authorPaused.files.get(STATE);
  assert.equal(await newSession(authorPaused, fakeAi()).session.holdAfterRestart({ times: 3, hours: 24 }), null, "a pause of the author is left as it is");
  assert.equal(authorPaused.files.get(STATE), before);
  const empty = new MemoryBookStore(seedBookFiles());
  assert.equal(await newSession(empty, fakeAi()).session.holdAfterRestart({ times: 3, hours: 24 }), null);
  assert.equal(empty.files.has(STATE), false, "a book without a state does not get one");
});

// ─── Through the client of the personal server ──────────────────────────────

/** A personal server that announces `features`, answers every other request with a snapshot, and remembers each one. */
function fakeServer(features) {
  const log = [];
  const fetch = async (input, init = {}) => {
    const url = new URL(input);
    log.push({ method: init.method ?? "GET", path: url.pathname, body: init.body === undefined ? undefined : JSON.parse(init.body) });
    if (url.pathname === "/api/v1/info") return Response.json({ name: "narrarium-server", apiVersion: 1, serverVersion: "0.1.11", engineVersion: "0.1.11", serverId: "s", label: "Test", git: true, features, publicKey: "k", fingerprint: "f", supervised: false });
    return Response.json({ bookId: "b", state: null, summary: null, activities: [], live: null, running: false, host: null });
  };
  return { fetch, log };
}

const serverClient = (server) => new engine.NarrariumServerClient({ baseUrl: "http://127.0.0.1:24242", token: "nrs_me", fetch: server.fetch });
const WITH = ["autopilot", "autopilot-controls", "autopilot-retry", "autopilot-auto-resume"];
const WITHOUT = ["autopilot", "autopilot-controls", "autopilot-retry"];

test("a server says it resumes runs after a restart with the feature autopilot-auto-resume; reading it never throws", () => {
  assert.equal(engine.SERVER_FEATURE_AUTOPILOT_AUTO_RESUME, "autopilot-auto-resume");
  assert.equal(engine.serverSupportsAutopilotAutoResume({ features: WITH }), true);
  assert.equal(engine.serverSupportsAutopilotAutoResume(WITH), true, "a list of features is read as well");
  assert.equal(engine.serverSupportsAutopilotAutoResume({ features: WITHOUT }), false);
  for (const odd of [null, undefined, {}, { features: "autopilot-auto-resume" }, "autopilot-auto-resume", 7]) assert.equal(engine.serverSupportsAutopilotAutoResume(odd), false, JSON.stringify(odd));
});

test("the client never sends resumeAfterRestart, true or false, to a server that does not announce autopilot-auto-resume: it refuses before sending anything", async () => {
  const calls = [
    (api) => api.updateAutopilotOptions("b", { resumeAfterRestart: true }),
    (api) => api.updateOptions("b", { resumeAfterRestart: false }),
    (api) => api.configureAutopilot("b", { options: { resumeAfterRestart: true } }),
    (api) => api.startAutopilot("b", { options: { pauseAfterPlan: false, resumeAfterRestart: false } }),
    (api) => api.updateAutopilotOptions("b", { longRetry: { everyMinutes: 15, cycles: 3 }, resumeAfterRestart: true }),
  ];
  for (const call of calls) {
    const old = fakeServer(WITHOUT);
    const error = await call(serverClient(old)).then(() => null, (failure) => failure);
    assert.ok(error instanceof engine.ServerRequestError, String(error));
    assert.deepEqual([error.status, error.code], [501, "feature_unavailable"]);
    assert.match(error.message, /autopilot-auto-resume/);
    assert.deepEqual(old.log.map((request) => request.path), ["/api/v1/info"], "only the server's features were asked, once: nothing was sent");

    const current = fakeServer(WITH);
    await call(serverClient(current));
    const sent = current.log.find((request) => request.path !== "/api/v1/info");
    assert.ok(JSON.stringify(sent.body).includes("resumeAfterRestart"), "a server that has it gets the request, with the setting in it");
  }
  const plain = fakeServer(WITHOUT);
  await serverClient(plain).updateAutopilotOptions("b", { pauseAfterEachChapter: true });
  assert.deepEqual(plain.log.map((request) => request.path), ["/api/v1/books/b/autopilot/options"], "a request without the setting does not ask for the features");
});
