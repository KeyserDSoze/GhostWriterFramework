import test from "node:test";
import assert from "node:assert/strict";
import * as engine from "../dist/index.js";
import { MemoryBookStore, createFakeAutopilotAi, seedBookFiles } from "../dist/testing/index.js";

// The records of the AI calls of a run, through the real runner: one record per AI call of a task, the reply as it streamed, the provider attempts,
// the task headers, the events (ids, sizes and times, never text), and what a failing store does to the run (it goes on without records).

const { AutopilotSession, AiReplyRejectedError, MemoryAiCallStore, parseAutopilotState } = engine;
const STATE = "autopilot/state.json";
const FAST = { readers: false, readersOnPlan: false, specialists: false, pauseAfterPlan: false };
const BOOK = { brief: { idea: "A harbor town.", targetChapters: 1, scenesPerChapter: 1, wordsPerScene: 300 }, options: FAST };
const USAGE = { inputTokens: 100, outputTokens: 50, cachedInputTokens: 0 };
const CALL_EVENTS = new Set(["call-started", "call-ended"]);

let attemptNumber = 0;

/** What the client reports for an attempt when it starts (`FetchAiAttempt`), for the fake AI. */
function attemptStart(request, index = 0) {
  attemptNumber += 1;
  return {
    attemptId: `attempt_${attemptNumber}`,
    label: request.label,
    capability: request.capability,
    provider: "fake",
    model: "fake-model",
    integrationId: "fake-integration",
    index,
    messages: [],
    endpoint: "https://fake.example.test/v1",
    stream: true,
    tools: Boolean(request.json),
    timeoutMs: 1000,
    timeouts: { startMs: 1000, idleMs: 1000, capMs: 1000 },
    streamMode: "auto",
    toolsOnly: true,
  };
}

/** What the client reports for an attempt that ended (`FetchAiAttemptEnd`), for the fake AI. */
function attemptEnd(start, extra = {}) {
  return {
    attemptId: start.attemptId,
    label: start.label,
    capability: start.capability,
    provider: "fake",
    model: "fake-model",
    integrationId: "fake-integration",
    index: start.index,
    outcome: "ok",
    usage: USAGE,
    usageKnown: true,
    cost: 0.001,
    costKnown: true,
    currency: "USD",
    streamed: true,
    firstByteMs: 12,
    durationMs: 30,
    finishReason: "stop",
    replyCharacters: 0,
    reasoningCharacters: 0,
    transport: { status: 200, bytes: 100, chunks: 2, events: 3, end: "done", usageReceived: true, usageRequested: true, tail: "data: [DONE]" },
    ...extra,
  };
}

/**
 * The fake AI, behaving as a streaming provider does: a structured reply is streamed as its JSON in two pieces, a prose reply as its text, and each call
 * reports one attempt. `onCall` may answer a call itself (it returns the response, or throws) before the fake does.
 */
function streamingAi({ onCall, window } = {}) {
  const base = createFakeAutopilotAi({ reviewVerdict: () => "approve", scenes: 1, words: 200 });
  return {
    calls: base.calls,
    async complete(request) {
      if (onCall) {
        const answered = await onCall(request, base);
        if (answered !== undefined) return answered;
      }
      const start = { ...attemptStart(request), ...(window ? { window } : {}) };
      request.onAttempt?.(start);
      const response = await base.complete(request);
      if (request.json && request.onStructuredText) {
        const text = JSON.stringify(response.json);
        request.onStructuredText(text.slice(0, Math.floor(text.length / 2)));
        request.onStructuredText(text);
      }
      request.onAttemptEnd?.(attemptEnd(start, { replyCharacters: JSON.stringify(response.json ?? response.text).length }));
      return response;
    },
  };
}

/** A store that counts every operation it is given, and the store behind it. */
function countingStore(store) {
  const counts = {};
  const wrapped = {};
  for (const name of ["begin", "append", "end", "saveTask", "prune", "readText", "readTask", "listTasks", "keep", "totals"]) {
    wrapped[name] = (...args) => {
      counts[name] = (counts[name] ?? 0) + 1;
      return store[name](...args);
    };
  }
  return { counts, store: wrapped };
}

function sessionFor(store, ai, extra = {}) {
  const events = [];
  const session = new AutopilotSession({ bookId: "book", store, ai, host: "server", hostLabel: "test", retryDelayMs: 0, ...extra });
  session.subscribe((event) => events.push(event));
  return { session, events };
}

async function runBook({ ai = streamingAi(), files = seedBookFiles({ chapters: 1 }), calls, extra = {}, options = BOOK } = {}) {
  const store = new MemoryBookStore(files);
  const { session, events } = sessionFor(store, ai, { ...(calls ? { calls, callsSecrets: () => ["sk-test-SECRET-000000"] } : {}), ...extra });
  await session.start(options);
  await session.waitForIdle();
  return { state: parseAutopilotState(store.files.get(STATE)), events, store, session };
}

const bookId = "book";

test("without a store nothing is recorded: no call events and no callId, and the run goes on as it always did", async () => {
  const { state, events } = await runBook();
  assert.equal(events.some((event) => CALL_EVENTS.has(event.type)), false);
  assert.ok(events.filter((event) => event.type === "task-progress").every((event) => !("callId" in event)));
  assert.equal(state.status, "completed", state.lastError?.message);
  assert.ok(events.some((event) => event.type === "task-progress" && event.kind === "json"), "the JSON of a structured step still streams");
});

test("each AI call of a task is recorded with its request as sent, its reply as it streamed, its attempt, and the header of its task", async () => {
  const records = new MemoryAiCallStore();
  const { state, events } = await runBook({ calls: records });
  assert.equal(state.status, "completed", state.lastError?.message);

  const started = events.filter((event) => event.type === "call-started");
  const ended = events.filter((event) => event.type === "call-ended");
  assert.ok(started.length >= 3 && started.length === ended.length, `${started.length} calls started and ${ended.length} ended`);
  for (const event of [...started, ...ended]) {
    for (const key of Object.keys(event)) assert.ok(!["text", "preview", "system", "user", "response", "tail"].includes(key), `no text in ${event.type}: ${key}`);
  }
  for (const event of ended) assert.equal(event.status, "ok");

  const tasks = await records.listTasks(bookId, { limit: 200 });
  assert.ok(tasks.tasks.length >= 3);
  for (const header of tasks.tasks) {
    assert.equal(header.status, "done");
    assert.ok(header.endedAt !== null && header.title.length > 0 && header.startedAt.length > 0);
    const task = await records.readTask(bookId, header.activityId);
    assert.ok(task.calls.length >= 1);
    assert.equal(task.header.calls, task.calls.length);
    for (const call of task.calls) {
      assert.equal(call.activityId, header.activityId);
      assert.equal(call.status, "ok");
      assert.equal(call.attempts.length, 1, "the attempt of the client, reported as it ran");
      assert.equal(call.attempts[0].provider, "fake");
      assert.equal(call.attempts[0].outcome, "ok");
      assert.equal(call.attempts[0].endpoint, "https://fake.example.test", "the origin of the address");
      const text = (await records.readText(bookId, call.callId, "response", 0, 1)).text;
      assert.equal(call.response.text.bytes, Buffer.byteLength(text));
      if (call.request.structured) assert.equal(typeof JSON.parse(text), "object", "the arguments are kept whole, as JSON");
      else assert.ok(text.length > 0, "the prose is kept");
      const system = await records.readText(bookId, call.callId, "system", 0);
      assert.ok(system.text.length > 0 && system.complete === true);
    }
  }
  const [writer] = tasks.tasks.filter((header) => header.kind === "write");
  assert.ok(writer, "the scene that was written has its header");
  assert.equal(writer.chapter, 1);
  assert.equal(writer.scene, 1);
});

test("the record of an attempt keeps the context window its model was judged by, and says whether it is the model's own or the default", async () => {
  for (const window of [{ tokens: 128_000, source: "default" }, { tokens: 32_000, source: "configured" }]) {
    const records = new MemoryAiCallStore();
    await runBook({ calls: records, ai: streamingAi({ window }) });
    const calls = (await Promise.all((await records.listTasks(bookId, { limit: 200 })).tasks.map((header) => records.readTask(bookId, header.activityId)))).flatMap((task) => task.calls);
    assert.ok(calls.length >= 3);
    for (const call of calls) assert.deepEqual(call.attempts[0].window, window);
  }
  const plain = new MemoryAiCallStore();
  await runBook({ calls: plain });
  const [header] = (await plain.listTasks(bookId, { limit: 1 })).tasks;
  const [call] = (await plain.readTask(bookId, header.activityId)).calls;
  assert.equal("window" in call.attempts[0], false, "an engine that did not say leaves it out");
  const odd = new MemoryAiCallStore();
  await runBook({ calls: odd, ai: streamingAi({ window: { tokens: -5, source: "default" } }) });
  const [oddHeader] = (await odd.listTasks(bookId, { limit: 1 })).tasks;
  assert.equal("window" in (await odd.readTask(bookId, oddHeader.activityId)).calls[0].attempts[0], false, "a figure that is not a window is not kept");
});

test("a candidate left out for its window records whether the window was the default, and the figures of the window", async () => {
  const step = (windowDefault) => ({ position: 0, integrationId: "big", integrationName: "Big", provider: "openai", model: "small-model", outcome: "left-out", leftOut: "context-window", promptTokens: 140_000, windowTokens: 118_000, ...(windowDefault ? { windowDefault: true } : {}) });
  for (const windowDefault of [true, false]) {
    const records = new MemoryAiCallStore();
    const ai = { calls: [], async complete(request) {
      const start = { ...attemptStart(request, 1), leftOut: [step(windowDefault)] };
      request.onAttempt?.(start);
      const response = await createFakeAutopilotAi({ reviewVerdict: () => "approve", scenes: 1, words: 200 }).complete(request);
      request.onAttemptEnd?.(attemptEnd(start, { replyCharacters: JSON.stringify(response.json ?? response.text).length }));
      return response;
    } };
    await runBook({ calls: records, ai });
    const [header] = (await records.listTasks(bookId, { limit: 1 })).tasks;
    const [call] = (await records.readTask(bookId, header.activityId)).calls;
    const skipped = call.attempts.find((attempt) => attempt.outcome === "skipped");
    assert.ok(skipped, "the candidate that was left out is in the record");
    assert.equal(skipped.skip.windowTokens, 118_000);
    assert.equal(skipped.skip.windowDefault, windowDefault ? true : undefined);
  }
});

test("the text of a structured step streams: the tail says the JSON so far, with its call, and the reply is kept whole", async () => {
  const records = new MemoryAiCallStore();
  const { events } = await runBook({ calls: records });
  const tails = events.filter((event) => event.type === "task-progress" && event.kind === "json");
  assert.ok(tails.length >= 1);
  for (const tail of tails) {
    assert.ok(tail.callId, "the tail names its call");
    assert.ok(!("bytes" in tail));
    assert.ok(tail.preview.length > 0 && tail.preview.length <= 700);
  }
  const calls = [];
  for (const header of (await records.listTasks(bookId, { limit: 200 })).tasks) {
    for (const call of (await records.readTask(bookId, header.activityId)).calls) if (call.request.structured) calls.push(call);
  }
  assert.ok(calls.length >= 1);
  for (const call of calls) {
    assert.ok(tails.some((tail) => tail.callId === call.callId), "its tail is in the events");
    const text = (await records.readText(bookId, call.callId, "response", 0, 1)).text;
    assert.equal(typeof JSON.parse(text), "object");
    assert.equal(typeof call.request.tool, "string", "the function that carries the reply is named");
  }
});

test("a store that fails ends the records for the run, once, and the run goes on: no step fails, and no call is recorded after the failure", async () => {
  for (const name of ["AiCallDiskFullError", "Error"]) {
    class FailingStore extends MemoryAiCallStore {
      async append() {
        throw Object.assign(new Error("The disk is full."), { name });
      }
    }
    const baseline = await runBook();
    const { state, events } = await runBook({ calls: new FailingStore() });
    assert.equal(state.status, baseline.state.status, state.lastError?.message);
    assert.equal(state.lastError, null);
    const insights = events.filter((event) => event.type === "insight" && event.code === "callsStoreFailed");
    assert.equal(insights.length, 1, "said once per run");
    assert.equal(insights[0].tone, "warning");
    if (name === "AiCallDiskFullError") assert.match(insights[0].title, /room/);
    else assert.match(insights[0].title, /could not be kept/);
    assert.ok(insights[0].detail?.includes("disk is full"));
    const at = events.indexOf(insights[0]);
    assert.equal(events.slice(at).some((event) => event.type === "call-started"), false, "no call starts after the records stopped");
  }
});

test("a crash in the middle of a stream ends the call as aborted, with the text that arrived, partial", async () => {
  const records = new MemoryAiCallStore();
  let stopped = false;
  const ai = streamingAi({
    onCall: (request) => {
      if (request.json) return undefined;
      return new Promise((_resolve, reject) => {
        const start = attemptStart(request);
        request.onAttempt(start);
        request.signal.addEventListener("abort", () => {
          request.onAttemptEnd(attemptEnd(start, { outcome: "cancelled", error: "The run was stopped." }));
          reject(new DOMException("The run was stopped.", "AbortError"));
        }, { once: true });
        request.onText("Il gabbiano è già volato via, e il porto");
      });
    },
  });
  const store = new MemoryBookStore(seedBookFiles({ chapters: 1 }));
  const { session, events } = sessionFor(store, ai, { calls: records, callsSecrets: () => [] });
  session.subscribe((event) => {
    if (event.type === "task-progress" && event.preview.includes("gabbiano") && !stopped) {
      stopped = true;
      session.pause("now");
    }
  });
  await session.start(BOOK);
  await session.waitForIdle();
  assert.equal(stopped, true, "the stream was in progress when the run stopped");
  const ended = events.find((event) => event.type === "call-ended" && event.status === "aborted");
  assert.ok(ended, "the call ended as aborted");
  assert.equal(ended.partial, true);
  const task = await records.readTask(bookId, ended.activityId);
  const call = task.calls.find((entry) => entry.callId === ended.callId);
  assert.equal(call.status, "aborted");
  assert.equal(call.response.partial, true);
  assert.equal((await records.readText(bookId, call.callId, "response", 0, 1)).text, "Il gabbiano è già volato via, e il porto");
  assert.equal(call.attempts[0].outcome, "aborted");
  assert.equal(call.timing.endedAt !== null, true);
  assert.equal(task.header.status, "stopped", "the task is stopped, not failed");
});

test("an attempt that fails after some text, and the next one that answers: each attempt maps to its own text attempt", async () => {
  const records = new MemoryAiCallStore();
  let first = true;
  const ai = streamingAi({
    onCall: async (request, base) => {
      if (request.json || !first) return undefined;
      first = false;
      const failed = attemptStart(request, 0);
      request.onAttempt(failed);
      request.onText("Il gabbiano ");
      request.onAttemptEnd(attemptEnd(failed, { outcome: "failed", failureKind: "provider", error: "The connection was lost.", transport: { end: "reset", streamed: true, bytes: 40, chunks: 1, events: 1, usageReceived: false, usageRequested: false } }));
      request.onText("");
      const answered = attemptStart(request, 1);
      request.onAttempt(answered);
      const response = await base.complete({ ...request, onText: undefined });
      request.onText(response.text);
      request.onAttemptEnd(attemptEnd(answered, { replyCharacters: response.text.length }));
      return response;
    },
  });
  const { state, events } = await runBook({ ai, calls: records });
  assert.equal(state.status, "completed", state.lastError?.message);
  const ended = events.find((event) => event.type === "call-ended" && event.attempts === 2);
  assert.ok(ended, "a call with two attempts");
  const task = await records.readTask(bookId, ended.activityId);
  const call = task.calls.find((entry) => entry.callId === ended.callId);
  assert.deepEqual(call.attempts.map((attempt) => attempt.textAttempt), [1, 2]);
  assert.deepEqual(call.attempts.map((attempt) => attempt.outcome), ["interrupted", "ok"]);
  assert.equal(call.attempts[0].text.bytes, Buffer.byteLength("Il gabbiano "), "the failed attempt keeps its text");
  assert.equal((await records.readText(bookId, call.callId, "response", 0, 1)).text, "Il gabbiano ");
  assert.equal(call.attempts[1].text.bytes, (await records.readText(bookId, call.callId, "response", 0, 2)).size, "the second attempt keeps its own reply");
  assert.equal(call.response.partial, false, "the call worked: its reply is whole");
});

test("a step that fails and is tried again: its calls count the attempt of the step, from 1, and the retry counts 2", async () => {
  const records = new MemoryAiCallStore();
  let failed = false;
  const ai = streamingAi({
    onCall: (request) => {
      if (request.json || failed) return undefined;
      failed = true;
      throw new AiReplyRejectedError("The reply was not usable.");
    },
  });
  const { state } = await runBook({ ai, calls: records });
  assert.equal(state.status, "completed", state.lastError?.message);
  const headers = (await records.listTasks(bookId, { limit: 200 })).tasks.filter((header) => header.kind === "write");
  assert.equal(headers.length, 2, "the failed scene and its retry");
  const [retry, original] = headers;
  const first = await records.readTask(bookId, original.activityId);
  const second = await records.readTask(bookId, retry.activityId);
  assert.equal(original.status, "failed");
  assert.equal(retry.status, "done");
  assert.ok(first.calls.every((call) => call.stepAttempt === 1));
  assert.ok(second.calls.every((call) => call.stepAttempt === 2));
  assert.equal(first.calls[0].status, "failed");
});

test("a 1,200-chapter book run with a small budget keeps its records within the budget, and the store is not read while it runs", async () => {
  const records = new MemoryAiCallStore();
  const counted = countingStore(records);
  const budget = 256 * 1024;
  const files = seedBookFiles({ chapters: 1200 });
  const started = performance.now();
  const { state, events } = await runBook({
    files,
    calls: counted.store,
    extra: { callsBudgetBytes: budget },
    options: { ...FAST, chaptersPerRun: 12 },
  });
  const elapsed = performance.now() - started;
  assert.equal(state.plan.chapters.length, 1200, "the whole book is planned");
  const calls = events.filter((event) => event.type === "call-started").length;
  assert.ok(calls > 20, `${calls} calls`);
  assert.equal(counted.counts.readText ?? 0, 0, "the texts are not read while the run goes on");
  assert.equal(counted.counts.listTasks ?? 0, 0);
  assert.equal(counted.counts.begin, calls, "one begin per call");
  assert.ok(counted.counts.append <= calls * 6 + 200, `${counted.counts.append} appends for ${calls} calls`);
  assert.ok(counted.counts.prune >= 1 && counted.counts.prune <= state.stats.tasks + 2, "one prune after each finished task");
  const totals = await records.totals(bookId);
  assert.ok(totals.bytes <= budget, `${totals.bytes} bytes kept, budget ${budget}`);
  assert.ok(totals.tasks < state.stats.tasks, "the oldest tasks were dropped");
  assert.equal(totals.pinnedTasks, 0);
  const kept = await records.listTasks(bookId, { limit: 200 });
  assert.equal(kept.tasks.length, Math.min(200, totals.tasks));
  assert.ok(elapsed < 600_000, `${elapsed} ms`);
});
