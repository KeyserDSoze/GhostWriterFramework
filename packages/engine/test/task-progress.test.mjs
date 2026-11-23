import test from "node:test";
import assert from "node:assert/strict";
import * as engine from "../dist/index.js";
import { MemoryBookStore, createFakeAutopilotAi, seedBookFiles } from "../dist/testing/index.js";
import { DONE, call, eventStream, finish, integration, live, usage } from "./transport-fakes.mjs";

const { AutopilotSession, NarrariumServerClient, ServerSentEventParser, createFetchAi, encodeServerSentEvent, parseAutopilotState } = engine;

const STATE = "autopilot/state.json";
const ACTIVITY = "autopilot/activity.json";
const FAST = { readers: false, readersOnPlan: false, specialists: false, pauseAfterPlan: false };
const BOOK = { brief: { idea: "x", targetChapters: 1, scenesPerChapter: 1, wordsPerScene: 300 }, options: FAST };

function fakeClock(start = Date.parse("2026-02-01T08:00:00.000Z")) {
  const clock = { t: start, now: () => new Date(clock.t) };
  return clock;
}

/**
 * The fake AI, but a structured request is answered the way a provider that streams answers it: `progress` reports to the request's
 * `onProgress`, each one `every` milliseconds of the fake clock after the last, before the reply. A prose request is left as it is.
 */
function streamingAi(clock, { reports = 40, every = 250, bytes = 1000, characters = 400, seen } = {}) {
  const base = createFakeAutopilotAi({ reviewVerdict: () => "approve", scenes: 1 });
  return {
    calls: base.calls,
    async complete(request) {
      if (request.json && request.onProgress) {
        for (let index = 1; index <= reports; index += 1) {
          clock.t += every;
          request.onProgress({ bytes: index * bytes, events: index, characters: index * characters });
        }
        await seen?.();
      }
      return base.complete(request);
    },
  };
}

function sessionFor(store, ai, clock) {
  const events = [];
  const session = new AutopilotSession({ bookId: "book", store, ai, host: "server", hostLabel: "test", retryDelayMs: 0, now: clock.now });
  session.subscribe((event) => events.push(event));
  return { session, events };
}

const progressOf = (events) => events.filter((event) => event.type === "task-progress");

// ─── E2-5: the progress of a structured step becomes an event ───────────────

test("a structured step that streams for ten seconds says so once a second: ten events, with numbers and without a word of the reply", async () => {
  const clock = fakeClock();
  const store = new MemoryBookStore(seedBookFiles({ chapters: 1 }));
  const { session, events } = sessionFor(store, streamingAi(clock), clock);
  await session.start({ ...BOOK, limits: { steps: 1 } });
  await session.waitForIdle();
  const started = events.find((event) => event.type === "task-started");
  const progress = progressOf(events);
  assert.equal(progress.length, 10, "40 reports in 10 seconds, one event for each second");
  for (const event of progress) {
    assert.equal(event.activityId, started.activity.id);
    assert.equal(event.preview, "", "no text: only numbers");
    assert.deepEqual(Object.keys(event).sort(), ["activityId", "at", "bookId", "bytes", "characters", "preview", "seq", "type"]);
    assert.ok(Number.isInteger(event.bytes) && Number.isInteger(event.characters));
  }
  assert.deepEqual(progress.map((event) => event.bytes), [1, 5, 9, 13, 17, 21, 25, 29, 33, 37].map((report) => report * 1000), "the report at the start of each second");
  assert.deepEqual(progress.map((event) => event.characters), [1, 5, 9, 13, 17, 21, 25, 29, 33, 37].map((report) => report * 400));
  const gaps = progress.slice(1).map((event, index) => Date.parse(event.at) - Date.parse(progress[index].at));
  assert.ok(gaps.every((gap) => gap >= 1000), `at least a second between two: ${gaps}`);
  assert.deepEqual(progress.map((event) => event.seq), [...progress.map((event) => event.seq)].sort((left, right) => left - right), "in order, like every event");
});

test("the first report of a step is said at once, and every step has its own count: a step does not wait for the one before", async () => {
  const clock = fakeClock();
  const store = new MemoryBookStore(seedBookFiles({ chapters: 1 }));
  const { session, events } = sessionFor(store, streamingAi(clock, { reports: 2, every: 100 }), clock);
  await session.start({ ...BOOK, limits: { steps: 3 } });
  await session.waitForIdle();
  const byStep = new Map();
  for (const event of progressOf(events)) byStep.set(event.activityId, [...(byStep.get(event.activityId) ?? []), event]);
  const finished = events.filter((event) => event.type === "task-finished").map((event) => event.activity.id);
  assert.ok(finished.length >= 3);
  assert.deepEqual([...byStep.keys()], finished, "every step that streams says something, in its own words");
  for (const sent of byStep.values()) assert.equal(sent.length, 1, "two reports 100 ms apart: the first is said, the second waits for its second");
});

test("nothing of it is saved: no commit, no number in the state or the log, and the replay buffer leaves it out", async () => {
  const quiet = fakeClock();
  const silentStore = new MemoryBookStore(seedBookFiles({ chapters: 1 }));
  const silent = sessionFor(silentStore, streamingAi(quiet, { reports: 0 }), quiet);
  await silent.session.start({ ...BOOK, limits: { steps: 2 } });
  await silent.session.waitForIdle();

  const clock = fakeClock();
  const store = new MemoryBookStore(seedBookFiles({ chapters: 1 }));
  const { session, events } = sessionFor(store, streamingAi(clock), clock);
  await session.start({ ...BOOK, limits: { steps: 2 } });
  await session.waitForIdle();
  assert.ok(progressOf(events).length >= 10);
  assert.equal(store.commits.length, silentStore.commits.length, "the progress cost the book not one commit");
  assert.deepEqual(store.commits.map((commit) => commit.paths), silentStore.commits.map((commit) => commit.paths));
  for (const file of [STATE, ACTIVITY]) {
    const text = store.files.get(file);
    assert.equal(text.includes("\"bytes\""), false, file);
    assert.equal(text.includes("task-progress"), false, file);
    assert.equal(text.includes("\"preview\""), false, file);
  }
  assert.equal(JSON.stringify(parseAutopilotState(store.files.get(STATE))).includes("\"bytes\""), false);
  assert.equal(session.recentEvents(0).some((event) => event.type === "task-progress"), false, "a client that connects later is not sent a stream of numbers");
});

test("snapshot().live carries the last value of the step in progress, and is empty when the step is over", async () => {
  const clock = fakeClock();
  const store = new MemoryBookStore(seedBookFiles({ chapters: 1 }));
  let during = null;
  let autopilot = null;
  const ai = streamingAi(clock, { seen: async () => { during ??= (await autopilot.snapshot()).live; } });
  const made = sessionFor(store, ai, clock);
  autopilot = made.session;
  await autopilot.start({ ...BOOK, limits: { steps: 1 } });
  await autopilot.waitForIdle();
  assert.ok(during, "a snapshot taken while the step ran has a live part");
  assert.equal(during.bytes, 37000, "the last number the step said");
  assert.equal(during.characters, 37 * 400);
  assert.equal(during.preview, "");
  assert.equal(during.activity.status, "running");
  assert.equal((await autopilot.snapshot()).live, null, "nothing runs any more");
});

test("a structured step and a prose step say their progress in the same event, the prose one with its text as it always did", async () => {
  const clock = fakeClock();
  const store = new MemoryBookStore(seedBookFiles({ chapters: 1 }));
  const { session, events } = sessionFor(store, streamingAi(clock, { reports: 4, every: 500 }), clock);
  await session.start(BOOK);
  await session.waitForIdle();
  assert.equal(parseAutopilotState(store.files.get(STATE)).status, "completed");
  const kinds = new Map(events.filter((event) => event.type === "task-started").map((event) => [event.activity.id, event.activity.task]));
  const prose = progressOf(events).filter((event) => !("bytes" in event));
  const numbers = progressOf(events).filter((event) => "bytes" in event);
  assert.ok(prose.some((event) => event.preview !== ""), "the scene that streams still shows its text");
  assert.ok(prose.every((event) => kinds.get(event.activityId) === "write" && typeof event.characters === "number"), "only a step that writes prose says its text, and it says no bytes");
  assert.ok(numbers.length > 0);
  assert.ok(numbers.every((event) => event.preview === "" && typeof event.bytes === "number"), "and a structured reply says numbers only");
  const inScene = new Set(prose.map((event) => event.activityId));
  assert.ok(numbers.some((event) => inScene.has(event.activityId)), "the step that writes the scene asks for its summary afterwards: both kinds of progress belong to the same step");
});

// ─── Through the real client ────────────────────────────────────────────────

test("through the engine's own client: a streamed function call reaches the run as its tail, as the JSON grows, and as numbers", async () => {
  const fake = createFakeAutopilotAi();
  const ai = createFetchAi({ aiIntegrations: [integration()] }, {
    fetch: async (_url, init) => {
      const body = JSON.parse(init.body);
      const tool = body.tools[0].function;
      const out = await fake.complete({ capability: "autopilot", label: "provider", system: body.messages[0].content, user: body.messages[1].content, json: tool });
      const arguments_ = JSON.stringify(out.json);
      const half = Math.floor(arguments_.length / 2);
      const pieces = [call(arguments_.slice(0, half), { name: tool.name }), call(arguments_.slice(half)), finish("tool_calls"), usage(100, 50), DONE];
      const stream = live();
      stream.send(...pieces);
      stream.end();
      return eventStream(stream.body);
    },
  });
  const store = new MemoryBookStore(seedBookFiles({ chapters: 1 }));
  const events = [];
  const session = new AutopilotSession({ bookId: "book", store, ai, host: "server", hostLabel: "test", retryDelayMs: 0 });
  session.subscribe((event) => events.push(event));
  await session.start({ ...BOOK, limits: { steps: 1 } });
  await session.waitForIdle();
  assert.equal(parseAutopilotState(store.files.get(STATE)).status, "paused", parseAutopilotState(store.files.get(STATE)).lastError?.message);
  const progress = progressOf(events);
  const numbers = progress.filter((event) => "bytes" in event);
  const tails = progress.filter((event) => event.kind === "json");
  assert.ok(numbers.length >= 1, "the first piece of the call was said");
  assert.ok(numbers[0].bytes > 0 && numbers[0].characters > 0);
  assert.ok(tails.length >= 1, "the JSON of the call is said as its tail");
  assert.ok(tails.every((event) => event.preview.length > 0 && !("bytes" in event)), "a tail is the end of the JSON so far, and says no bytes");
  assert.ok(tails.every((event) => event.preview.length <= 700), "at most the last 700 characters");
});

test("a provider that does not stream says nothing in between: its reply comes whole, and is said once when it has arrived", async () => {
  const fake = createFakeAutopilotAi();
  const ai = createFetchAi({ aiIntegrations: [integration({ streamMode: "off" })] }, {
    fetch: async (_url, init) => {
      const body = JSON.parse(init.body);
      const tool = body.tools[0].function;
      const out = await fake.complete({ capability: "autopilot", label: "provider", system: body.messages[0].content, user: body.messages[1].content, json: tool });
      return Response.json({ choices: [{ message: { tool_calls: [{ function: { name: tool.name, arguments: JSON.stringify(out.json) } }] }, finish_reason: "tool_calls" }], usage: { prompt_tokens: 1, completion_tokens: 1 } });
    },
  });
  const store = new MemoryBookStore(seedBookFiles({ chapters: 1 }));
  const events = [];
  const session = new AutopilotSession({ bookId: "book", store, ai, host: "server", hostLabel: "test", retryDelayMs: 0 });
  session.subscribe((event) => events.push(event));
  await session.start({ ...BOOK, limits: { steps: 1 } });
  await session.waitForIdle();
  assert.equal(parseAutopilotState(store.files.get(STATE)).status, "paused");
  const progress = progressOf(events);
  assert.equal(progress.filter((event) => "bytes" in event).length, 0, "no count while it waits");
  assert.ok(progress.length <= 1 && progress.every((event) => event.kind === "json"), "the whole reply is said once, as a tail");
});

// ─── The client of the server and what an older reader makes of it ──────────

const NEW_EVENT = { type: "task-progress", activityId: "activity_1", characters: 12_345, bytes: 98_765, preview: "", bookId: "my-book", at: "2026-02-01T08:00:01.000Z", seq: 41 };

test("the event travels as every other: the stream of the server carries it and the parser gives it back as it was", () => {
  const seen = [];
  const parser = new ServerSentEventParser((event, data) => seen.push([event, JSON.parse(data)]));
  parser.push(encodeServerSentEvent({ event: "autopilot", data: NEW_EVENT }, NEW_EVENT.seq));
  assert.deepEqual(seen, [["autopilot", NEW_EVENT]]);
});

test("the client of the server hands the host every message of the stream, the new event and a type it has never heard of included, and stops at none", async () => {
  const future = { type: "from-the-future", bookId: "my-book", at: "2026-02-01T08:00:02.000Z", seq: 42, anything: [1, 2, 3] };
  const frames = [
    encodeServerSentEvent({ event: "hello", data: { serverId: "s", at: "2026-02-01T08:00:00.000Z" } }),
    encodeServerSentEvent({ event: "autopilot", data: NEW_EVENT }, 41),
    encodeServerSentEvent({ event: "autopilot", data: future }, 42),
    "event: news-of-the-day\ndata: {\"headline\":\"x\"}\n\n",
    "event: autopilot\ndata: {this is not json\n\n",
    encodeServerSentEvent({ event: "heartbeat", data: { at: "2026-02-01T08:00:03.000Z" } }),
  ];
  const fetch = async () => new Response(frames.join(""), { status: 200, headers: { "content-type": "text/event-stream" } });
  const messages = [];
  await new NarrariumServerClient({ baseUrl: "http://127.0.0.1:24242", token: "nrs_me", fetch }).stream((message) => messages.push(message), new AbortController().signal);
  assert.deepEqual(messages.map((message) => message.event), ["hello", "autopilot", "autopilot", "news-of-the-day", "heartbeat"], "the frame that is not JSON is dropped; the others are all there");
  assert.deepEqual(messages[1].data, NEW_EVENT);
  assert.deepEqual(messages[2].data, future, "a host that does not know a type decides what to do with it: the client does not");
});

test("a reader written before the event grew still reads it: it finds a string where it looked for the preview and a number where it looked for the characters", () => {
  // What the web app's store did with every `task-progress` before bytes existed.
  const ingestOld = (live, event) => ({ ...live, characters: event.characters, preview: event.preview });
  const before = { activity: { id: "activity_1" }, characters: 0, preview: "" };
  const after = ingestOld(before, NEW_EVENT);
  assert.equal(after.characters, 12_345);
  assert.equal(typeof after.preview, "string");
  assert.equal(after.preview.length, 0);
});
