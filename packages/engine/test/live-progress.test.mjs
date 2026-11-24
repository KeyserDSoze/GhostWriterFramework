import test from "node:test";
import assert from "node:assert/strict";
import * as engine from "../dist/index.js";
import { MemoryBookStore, createFakeAutopilotAi, seedBookFiles } from "../dist/testing/index.js";

// What a client shows of the step that runs while its model answers, as the events of a real run replay it: one rule (`applyLiveProgress`) for the
// session's `snapshot().live` and for the web app. The text shown never goes back to nothing within a call, its count never goes down within an
// attempt, and nothing of a call is shown as another's. These sequences are the ones that made the panels of the web app flicker (engine 0.1.14).

const { AutopilotSession, applyLiveProgress, normalizeLive, startLive, parseAutopilotState } = engine;
const STATE = "autopilot/state.json";
const FAST = { readers: false, readersOnPlan: false, specialists: false, pauseAfterPlan: false };
const BOOK = { brief: { idea: "x", targetChapters: 1, scenesPerChapter: 1, wordsPerScene: 300 }, options: FAST };

const ACTIVITY = { id: "activity_concept", runId: "run-1", task: "concept", phase: "concept", title: "Designing the concept of the book", reason: "", next: "", status: "running", startedAt: "2026-11-24T10:00:00.000Z" };
const CONCEPT = JSON.stringify({ logline: "A glassmaker's daughter must expose the harbor's oldest lie before the tide takes the town.", premise: "In a harbor town built on glass, Mira discovers the lighthouse keeps a secret, and that the council profits from the silence of everyone who works the furnaces along the quay.", themes: ["truth", "inheritance", "silence"], tone: "Melancholic, tense", conflict: "Mira against the council that profits from the lie." });
const tail = (text) => text.slice(-700);

/** The events of one structured call as the 0.1.14 runner said them: its JSON every 350 ms, its numbers every second (with the client's own count, and the same tail). */
function alternation({ seconds = 10, callSeq, callId, json = CONCEPT, extra = 24 } = {}) {
  const events = [];
  const steps = Math.floor((seconds * 1000) / 350);
  let nextNumbers = 1000;
  for (let step = 1; step <= steps; step += 1) {
    const at = step * 350;
    const written = json.slice(0, Math.round((json.length * step) / steps));
    events.push({ at, event: { activityId: ACTIVITY.id, kind: "json", characters: written.length, preview: tail(written), ...(callSeq ? { callSeq } : {}), ...(callId ? { callId } : {}) } });
    if (at >= nextNumbers) {
      nextNumbers += 1000;
      events.push({ at, event: { activityId: ACTIVITY.id, bytes: written.length * 3, characters: written.length + extra, preview: tail(written), ...(callSeq ? { callSeq } : {}), ...(callId ? { callId } : {}) } });
    }
  }
  return events.map((entry) => entry.event);
}

/** Replays `events` from `live` and gives every state the panels would draw from. */
function replay(events, live = startLive(ACTIVITY)) {
  const states = [];
  for (const event of events) {
    live = applyLiveProgress(live, event);
    states.push(live);
  }
  return states;
}

/** What the panels show: the tail once there is one, else «answering N KB» while the bytes arrive, else nothing. */
const shown = (live) => (live.preview ? `text:${live.preview}` : live.bytes !== undefined ? `answering:${live.bytes}` : "nothing");

test("a structured step that streams its JSON for ten seconds: once its tail is shown it stays, its count never goes down, and its bytes stay too", () => {
  const states = replay(alternation({ callSeq: 1 }));
  const first = states.findIndex((live) => live.preview !== "");
  assert.equal(first, 0, "the first JSON is shown at once");
  for (const [index, live] of states.entries()) {
    assert.notEqual(live.preview, "", `state ${index}: the tail never goes back to nothing`);
    assert.equal(live.json, true, `state ${index}: it is the JSON of the reply`);
    if (index > 0) assert.ok(live.characters >= states[index - 1].characters, `state ${index}: ${live.characters} after ${states[index - 1].characters}`);
  }
  const numbers = states.filter((live) => live.bytes !== undefined);
  assert.ok(numbers.length >= 8, "the numbers of the reply are kept with its text");
  assert.ok(states.slice(states.findIndex((live) => live.bytes !== undefined)).every((live) => live.bytes !== undefined), "once said, the bytes stay for the call");
  assert.equal(states.at(-1).preview, tail(CONCEPT));
  assert.equal(states.at(-1).characters, CONCEPT.length, "one count, the JSON's: not the client's larger one of the numbers events");
});

test("the numbers of a structured reply never put a tail on screen: not the one of the call before, not their own", () => {
  const states = replay([
    { activityId: ACTIVITY.id, callSeq: 1, kind: "json", characters: 40, preview: "{\"logline\": \"A glassmaker's daughter\"" },
    { activityId: ACTIVITY.id, callSeq: 2, bytes: 900, characters: 12, preview: "{\"logline\": \"A glassmaker's daughter\"" },
    { activityId: ACTIVITY.id, callSeq: 2, bytes: 1900, characters: 40, preview: "{\"logline\": \"A glassmaker's daughter\"" },
    { activityId: ACTIVITY.id, callSeq: 2, kind: "json", characters: 10, preview: "{\"chapters" },
  ]);
  assert.deepEqual(states.map(shown), ["text:{\"logline\": \"A glassmaker's daughter\"", "answering:900", "answering:1900", "text:{\"chapters"]);
  assert.deepEqual(states.map((live) => live.callSeq), [1, 2, 2, 2]);
});

test("a new attempt of the call: the text of the one before stays until the new one writes, then the new one takes its place", () => {
  const first = alternation({ seconds: 4, callSeq: 1 });
  const second = alternation({ seconds: 4, callSeq: 1, json: CONCEPT.replace("glassmaker", "lens grinder") });
  const states = replay([...first, { activityId: ACTIVITY.id, callSeq: 1, kind: "json", characters: 0, preview: "" }, ...second]);
  assert.ok(states.every((live) => live.preview !== ""), "never nothing on screen, the restart included");
  const drops = states.filter((live, index) => index > 0 && live.characters < states[index - 1].characters);
  assert.equal(drops.length, 1, "the count starts again once, where the new attempt's text replaces the old one");
  assert.ok(drops[0].preview.includes("lens grinder") || drops[0].preview.length < 60);
  assert.ok(states.at(-1).preview.includes("lens grinder"));
});

test("a new call of the same step (a step that tries again, or asks something else): nothing of the call before is shown as the new one's", () => {
  const states = replay([...alternation({ seconds: 3, callSeq: 1, callId: "activity_concept-0001" }), ...alternation({ seconds: 3, callSeq: 2, callId: "activity_concept-0002", json: "{\"title\":\"The Glass Harbor\",\"pitch\":\"A town of glass.\"}" })]);
  const start = states.findIndex((live) => live.callSeq === 2);
  assert.ok(start > 0);
  for (const live of states.slice(start)) {
    assert.ok(!live.preview.includes("glassmaker"), `the concept is not shown during the next call: ${live.preview.slice(0, 40)}`);
    assert.equal(live.callId, "activity_concept-0002");
  }
  const second = states.slice(start);
  for (const [index, live] of second.entries()) if (index > 0) assert.ok(live.characters >= second[index - 1].characters);
});

test("a prose call and then a structured one in the same step: the scene is not shown while the summary streams", () => {
  const scene = "The keeper climbed the stairs counting the steps under his breath, and on every landing the wind changed its note.";
  for (const named of [true, false]) {
    const ids = (callSeq) => (named ? { callSeq } : {});
    const states = replay([
      { activityId: ACTIVITY.id, ...ids(1), characters: 60, preview: scene.slice(0, 60) },
      { activityId: ACTIVITY.id, ...ids(1), characters: scene.length, preview: scene },
      { activityId: ACTIVITY.id, ...ids(2), bytes: 300, characters: 40, preview: "" },
      { activityId: ACTIVITY.id, ...ids(2), kind: "json", characters: 20, preview: "{\"summary\":\"The kee" },
      { activityId: ACTIVITY.id, ...ids(2), bytes: 700, characters: 80, preview: "{\"summary\":\"The kee" },
    ]);
    assert.deepEqual(states.map(shown), [`text:${scene.slice(0, 60)}`, `text:${scene}`, "answering:300", "text:{\"summary\":\"The kee", "text:{\"summary\":\"The kee"], named ? "named calls" : "an engine that names no calls");
    assert.deepEqual(states.map((live) => live.json === true), [false, false, false, true, true]);
    assert.deepEqual(states.map((live) => live.characters), [60, scene.length, 40, 20, 20], "the count of the summary is its JSON's once it streams");
  }
});

test("an engine that names no calls: a structured reply after another is told by its count going back", () => {
  const states = replay([...alternation({ seconds: 2 }), { activityId: ACTIVITY.id, kind: "json", characters: 9, preview: "{\"chapter" }]);
  assert.equal(states.at(-1).preview, "{\"chapter");
  assert.equal(states.at(-1).characters, 9);
});

test("an engine that names no calls: the numbers of the next structured reply going back say that it began, and the reply before is not shown as its text", () => {
  const first = alternation({ seconds: 3 });
  const stale = first.at(-1).preview;
  const states = replay([
    ...first,
    // The 0.1.14 runner: the numbers of the next call carry the tail of the call before.
    { activityId: ACTIVITY.id, bytes: 120, characters: 30, preview: stale },
    { activityId: ACTIVITY.id, kind: "json", characters: 9, preview: "{\"chapter" },
    { activityId: ACTIVITY.id, bytes: 400, characters: 40, preview: "{\"chapter" },
  ]);
  assert.deepEqual(states.slice(-3).map(shown), ["answering:120", "text:{\"chapter", "text:{\"chapter"]);
  assert.deepEqual(states.slice(-3).map((live) => live.characters), [30, 9, 9]);
});

test("a shorter JSON of the same call (a new attempt) takes the place of the old one, and the bytes of the old attempt go with it", () => {
  const states = replay([
    { activityId: ACTIVITY.id, callSeq: 1, kind: "json", characters: 40, preview: "{\"logline\": \"A glassmaker's daughter\"" },
    { activityId: ACTIVITY.id, callSeq: 1, bytes: 900, characters: 40, preview: "{\"logline\": \"A glassmaker's daughter\"" },
    { activityId: ACTIVITY.id, callSeq: 1, kind: "json", characters: 0, preview: "" },
    { activityId: ACTIVITY.id, callSeq: 1, bytes: 30, characters: 0, preview: "" },
    { activityId: ACTIVITY.id, callSeq: 1, kind: "json", characters: 4, preview: "{\"lo" },
    { activityId: ACTIVITY.id, callSeq: 1, bytes: 60, characters: 4, preview: "{\"lo" },
  ]);
  assert.deepEqual(states.map(shown), [
    "text:{\"logline\": \"A glassmaker's daughter\"",
    "text:{\"logline\": \"A glassmaker's daughter\"",
    "text:{\"logline\": \"A glassmaker's daughter\"",
    "text:{\"logline\": \"A glassmaker's daughter\"",
    "text:{\"lo",
    "text:{\"lo",
  ]);
  assert.deepEqual(states.map((live) => live.bytes), [undefined, 900, 900, 30, undefined, 60]);
  assert.deepEqual(states.map((live) => live.characters), [40, 40, 40, 40, 4, 4]);
});

test("a progress without a preview (a host that leaves it out) keeps the text that is shown, with the new count", () => {
  const states = replay([
    { activityId: ACTIVITY.id, callSeq: 1, characters: 20, preview: "The keeper climbed." },
    { activityId: ACTIVITY.id, callSeq: 1, characters: 80 },
  ]);
  assert.deepEqual(states.map((live) => [live.preview, live.characters]), [["The keeper climbed.", 20], ["The keeper climbed.", 80]]);
});

test("a progress of another step changes nothing, and a live part read from elsewhere keeps only what it may say", () => {
  const live = applyLiveProgress(startLive(ACTIVITY), { activityId: ACTIVITY.id, kind: "json", characters: 4, preview: "{\"lo" });
  assert.equal(applyLiveProgress(live, { activityId: "activity_other", characters: 99, preview: "other" }), live);
  assert.deepEqual(normalizeLive({ activity: ACTIVITY, characters: 12, preview: "abc", json: true, bytes: 30, callSeq: 2, callId: "c", extra: "dropped" }), { activity: ACTIVITY, characters: 12, preview: "abc", json: true, bytes: 30, callSeq: 2, callId: "c" });
  assert.deepEqual(normalizeLive({ activity: ACTIVITY, characters: -1, preview: 5, bytes: "x" }), { activity: ACTIVITY, characters: 0, preview: "" });
  assert.equal(normalizeLive({ characters: 1 }), null);
  assert.equal(normalizeLive(null), null);
});

// ─── Through the real runner and session ─────────────────────────────────────

function fakeClock(start = Date.parse("2026-11-24T10:00:00.000Z")) {
  const clock = { t: start, now: () => new Date(clock.t) };
  return clock;
}
const pause = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * The fake AI, answering the way the engine's client streams: a prose reply as its text grows (`onText`), a structured one as its JSON grows
 * (`onStructuredText`) and as numbers (`onProgress`, with its own count of text and arguments), one after the other, a quarter of a second of the fake
 * clock apart. `look` is called after each piece.
 */
function streamingAi(clock, look) {
  const base = createFakeAutopilotAi({ reviewVerdict: () => "approve", scenes: 1 });
  return {
    calls: base.calls,
    async complete(request) {
      const reply = await base.complete({ ...request, onText: undefined, onProgress: undefined, onStructuredText: undefined });
      const streamed = request.json ? JSON.stringify(reply.json) : reply.text;
      const pieces = request.json?.name === "book_concept" ? 40 : 8;
      for (let step = 1; step <= pieces; step += 1) {
        clock.t += 250;
        const written = streamed.slice(0, Math.round((streamed.length * step) / pieces));
        if (request.json) {
          request.onStructuredText?.(written);
          request.onProgress?.({ bytes: written.length * 3, events: step, characters: written.length + 24 });
        } else {
          request.onText?.(written);
        }
        if (step % 10 === 0) await pause(360);
        await look(request);
      }
      return reply;
    },
  };
}

async function runWith(steps) {
  const clock = fakeClock();
  const store = new MemoryBookStore(seedBookFiles({ chapters: 1 }));
  const seen = [];
  let session = null;
  const ai = streamingAi(clock, async (request) => {
    const live = (await session.snapshot()).live;
    if (live) seen.push({ label: request.label, live });
  });
  session = new AutopilotSession({ bookId: "book", store, ai, host: "server", hostLabel: "test", retryDelayMs: 0, now: clock.now });
  const events = [];
  session.subscribe((event) => events.push(event));
  await session.start({ ...BOOK, limits: { steps } });
  await session.waitForIdle();
  return { store, seen, events, progress: events.filter((event) => event.type === "task-progress") };
}

test("through the runner and the session: snapshot().live keeps the concept on screen while it streams, with the JSON's count", async () => {
  const { store, seen, progress } = await runWith(1);
  assert.equal(parseAutopilotState(store.files.get(STATE)).status, "paused", parseAutopilotState(store.files.get(STATE)).lastError?.message);
  assert.ok(progress.some((event) => event.kind === "json") && progress.some((event) => event.bytes !== undefined), "both kinds of progress were said");
  assert.ok(progress.every((event) => event.callSeq === 1), "every progress names its call");
  for (const event of progress.filter((entry) => entry.bytes !== undefined)) {
    const json = progress.filter((entry) => entry.kind === "json" && entry.seq < event.seq).at(-1);
    if (json) assert.ok(event.characters >= json.characters, `the numbers say the JSON's count (${event.characters}), not the client's own`);
  }
  const concept = seen.filter((entry) => entry.live.activity.task === "concept");
  const shownAt = concept.findIndex((entry) => entry.live.preview !== "");
  assert.ok(shownAt >= 0);
  for (const [index, entry] of concept.slice(shownAt).entries()) {
    assert.notEqual(entry.live.preview, "", `sample ${index}: the tail stays`);
    assert.equal(entry.live.json, true);
    if (index > 0) assert.ok(entry.live.characters >= concept[shownAt + index - 1].live.characters);
  }
});

test("through the runner: the scene a step wrote is not shown while it asks for its summary, the summary's own JSON is", async () => {
  const { seen, progress, events } = await runWith(12);
  const write = events.find((event) => event.type === "task-started" && event.activity.task === "write");
  assert.ok(write, "the run reached a scene");
  const ofWrite = progress.filter((event) => event.activityId === write.activity.id);
  assert.ok(ofWrite.some((event) => event.callSeq === 1 && event.kind === undefined && event.bytes === undefined && event.preview), "the scene streams as prose, call 1");
  assert.ok(ofWrite.some((event) => event.callSeq === 2 && event.kind === "json"), "its summary streams its JSON, call 2");
  const summary = seen.filter((entry) => entry.live.activity.id === write.activity.id && entry.label.includes("scene-summary"));
  assert.ok(summary.length > 0);
  for (const entry of summary) {
    assert.equal(entry.live.callSeq, 2);
    assert.ok(entry.live.preview === "" || entry.live.preview.startsWith("{"), `nothing of the scene during its summary: ${entry.live.preview.slice(0, 40)}`);
  }
  assert.ok(summary.some((entry) => entry.live.json === true && entry.live.preview.startsWith("{")));
});

test("a JSON that starts again is said at once, however soon after the last one", async () => {
  const clock = fakeClock();
  const store = new MemoryBookStore(seedBookFiles({ chapters: 1 }));
  const base = createFakeAutopilotAi({ reviewVerdict: () => "approve", scenes: 1 });
  const ai = {
    calls: base.calls,
    async complete(request) {
      if (request.json?.name === "book_concept" && request.onStructuredText) {
        request.onStructuredText("{\"logline\": \"A first attempt");
        request.onStructuredText("");
        // The new attempt's text keeps the pace of the call: it is said once a third of a second has passed.
        request.onStructuredText("{\"lo");
        await pause(360);
        request.onStructuredText("{\"logline\": \"A second");
      }
      return base.complete({ ...request, onStructuredText: undefined });
    },
  };
  const session = new AutopilotSession({ bookId: "book", store, ai, host: "server", hostLabel: "test", retryDelayMs: 0, now: clock.now });
  const events = [];
  session.subscribe((event) => events.push(event));
  await session.start({ ...BOOK, limits: { steps: 1 } });
  await session.waitForIdle();
  const json = events.filter((event) => event.type === "task-progress" && event.kind === "json").map((event) => event.preview);
  assert.deepEqual(json, ["{\"logline\": \"A first attempt", "", "{\"logline\": \"A second"], "the restart within 350 ms of the first, and the new attempt at its pace");
  // And what a client shows: the first attempt until the new one writes, then the new one.
  const progress = events.filter((event) => event.type === "task-progress");
  const started = startLive(events.find((event) => event.type === "task-started").activity);
  const states = progress.map((_, index) => progress.slice(0, index + 1).reduce((state, event) => applyLiveProgress(state, event), started));
  assert.deepEqual(states.map((state) => state.preview), ["{\"logline\": \"A first attempt", "{\"logline\": \"A first attempt", "{\"logline\": \"A second"]);
});
