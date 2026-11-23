import test from "node:test";
import assert from "node:assert/strict";
import * as engine from "../dist/index.js";

// The recorder turns the cumulative text of a streamed reply into writes: appends every 2 seconds or 16 KiB, the rest at the end. It never throws
// a store failure into its caller, never waits for the store, and keeps no key, no address with its path, and no text beyond its limits.

const BOOK = "book-1";
const MiB = 1024 * 1024;
const KiB = 1024;

/** A clock that moves only when the test says so, and runs the timers it set when their time comes. */
function fakeClock(start = 1_000_000) {
  let now = start;
  let nextId = 1;
  const timers = new Map();
  return {
    now: () => now,
    setTimer(callback, ms) {
      const id = nextId++;
      timers.set(id, { at: now + ms, callback });
      return id;
    },
    clearTimer(id) {
      timers.delete(id);
    },
    advance(ms) {
      now += ms;
      for (const [id, timer] of [...timers]) {
        if (timer.at <= now && timers.has(id)) {
          timers.delete(id);
          timer.callback();
        }
      }
    },
    pending: () => timers.size,
  };
}

function recorderFor(store, extra = {}) {
  return new engine.CallRecorder({
    store,
    bookId: BOOK,
    accountScope: null,
    runId: "run_1",
    activityId: "activity_abc",
    seq: 1,
    stepAttempt: 1,
    task: "write",
    chapter: 3,
    scene: 2,
    label: "Write the scene",
    capability: "autopilot",
    host: "browser",
    system: "You are the ghostwriter.",
    user: "Write the scene.",
    ...extra,
  });
}

function attemptReport(index, textAttempt, overrides = {}) {
  return {
    index,
    textAttempt,
    provider: "openai",
    model: "gpt-test",
    integrationId: "int-1",
    endpoint: "https://api.openai.com/v1/chat/completions",
    stream: true,
    tools: false,
    firstByteMs: 120,
    durationMs: 900,
    outcome: "ok",
    finishReason: "stop",
    reasoningCharacters: null,
    usage: { inputTokens: 10, outputTokens: 20, cachedInputTokens: 0 },
    usageKnown: true,
    cost: 0.01,
    costKnown: true,
    currency: "USD",
    transport: null,
    error: null,
    partialCharacters: null,
    ...overrides,
  };
}

/** Counts the bytes that the store is given, and wraps a store with an optional failure or delay. */
function counting(store, { appendFails = null, gate = null } = {}) {
  const counter = { appends: 0, appendedBytes: 0 };
  const wrapped = {
    begin: (input) => store.begin(input),
    end: (callId, final) => store.end(callId, final),
    append: async (callId, attempt, offset, text) => {
      counter.appends += 1;
      counter.appendedBytes += Buffer.byteLength(text);
      if (gate) await gate;
      if (appendFails) throw appendFails;
      return store.append(callId, attempt, offset, text);
    },
  };
  return { wrapped, counter };
}

test("the reply is written as it streams and kept whole at the end, with its attempt and its usage", async () => {
  const store = new engine.MemoryAiCallStore();
  const clock = fakeClock();
  const recorder = recorderFor(store, { clock });
  let text = "";
  for (let i = 0; i < 40; i += 1) {
    text += "word ".repeat(100);
    recorder.onText(text);
  }
  await recorder.idle();
  const live = await store.readText(BOOK, recorder.callId, "response", 0, 1);
  assert.ok(live.size >= 16 * KiB - 300 && live.size < text.length, `checkpoints at 16 KiB, not at the end: ${live.size}`);
  assert.ok(text.startsWith(live.text), "what is kept is the start of the reply");
  assert.equal(live.complete, false);

  await recorder.finish("ok", [attemptReport(1, 1)]);
  const whole = await store.readText(BOOK, recorder.callId, "response", 0, 1);
  assert.equal(whole.text, text);
  assert.equal(whole.complete, true);
  const { calls, header } = await store.readTask(BOOK, "activity_abc");
  assert.equal(header.calls, 1);
  const [call] = calls;
  assert.equal(call.status, "ok");
  assert.equal(call.response.partial, false);
  assert.equal(call.response.text.bytes, Buffer.byteLength(text));
  assert.equal(call.attempts[0].text.storedBytes, Buffer.byteLength(text));
  assert.equal(call.attempts[0].endpoint, "https://api.openai.com", "the address keeps only its origin");
  assert.equal(call.timing.firstTextAt !== null, true);
  assert.equal(call.timing.endedAt !== null, true);
});

test("a checkpoint waits for two seconds of a short reply, and for the holdback of its newest characters", async () => {
  const store = new engine.MemoryAiCallStore();
  const clock = fakeClock();
  const recorder = recorderFor(store, { clock });
  recorder.onText("a".repeat(1000));
  await recorder.idle();
  assert.equal(clock.pending(), 1, "a timer waits for the next checkpoint");
  assert.equal((await store.readText(BOOK, recorder.callId, "response", 0, 1)).size, 0, "the call is kept, and no text is sent yet");
  clock.advance(1999);
  await recorder.idle();
  assert.equal((await store.readText(BOOK, recorder.callId, "response", 0, 1)).size, 0, "not yet two seconds");
  clock.advance(1);
  await recorder.idle();
  const live = await store.readText(BOOK, recorder.callId, "response", 0, 1);
  assert.equal(live.size, 1000 - engine.AI_CALL_HOLDBACK_CHARACTERS, "the newest characters wait for the next checkpoint");
  await recorder.finish("ok", [attemptReport(1, 1)]);
  assert.equal((await store.readText(BOOK, recorder.callId, "response", 0, 1)).size, 1000);
});

test("a shorter text starts a new provider attempt, and an empty text resets: each attempt keeps its own reply", async () => {
  const store = new engine.MemoryAiCallStore();
  const recorder = recorderFor(store, { clock: fakeClock() });
  recorder.onText("Hello wo");
  recorder.onText("Hello");
  recorder.onText("");
  recorder.onText("Final answer");
  await recorder.finish("ok", [attemptReport(1, 1, { outcome: "failed", error: { name: "AiStreamInterruptedError", message: "The connection was lost.", status: 200, transient: true, timedOut: false } }), attemptReport(2, 2, { outcome: "failed" }), attemptReport(3, 3)]);
  assert.equal((await store.readText(BOOK, recorder.callId, "response", 0, 1)).text, "Hello wo");
  assert.equal((await store.readText(BOOK, recorder.callId, "response", 0, 2)).text, "Hello");
  assert.equal((await store.readText(BOOK, recorder.callId, "response", 0, 3)).text, "Final answer");
  assert.equal((await store.readText(BOOK, recorder.callId, "response", 0)).text, "Final answer", "the last attempt is the default");
  const { calls } = await store.readTask(BOOK, "activity_abc");
  assert.deepEqual(calls[0].attempts.map((attempt) => attempt.text.bytes), [8, 5, 12]);
  assert.equal(calls[0].attempts[0].error.name, "AiStreamInterruptedError");
  assert.equal(calls[0].response.text.characters, 12);
});

test("a store that throws never reaches the caller: the first failure is reported once, and the call still ends", async () => {
  const store = new engine.MemoryAiCallStore();
  const failing = counting(store, { appendFails: Object.assign(new Error("The disk is full."), { name: "QuotaExceededError" }) }).wrapped;
  const reports = [];
  const recorder = recorderFor(failing, { clock: fakeClock(), onError: (error) => reports.push(error) });
  let text = "";
  for (let i = 0; i < 50; i += 1) {
    text += "x".repeat(1024);
    recorder.onText(text);
  }
  await recorder.finish("ok", [attemptReport(1, 1)]);
  assert.equal(reports.length, 1);
  assert.equal(reports[0].name, "QuotaExceededError");
  const { calls } = await store.readTask(BOOK, "activity_abc");
  assert.equal(calls[0].status, "ok");
});

test("a slow store never blocks the caller, and no text is lost when live checkpoints are dropped", async () => {
  const store = new engine.MemoryAiCallStore();
  let open;
  const gate = new Promise((resolve) => {
    open = resolve;
  });
  const { wrapped, counter } = counting(store, { gate });
  const recorder = recorderFor(wrapped, { clock: fakeClock() });
  let text = "";
  for (let i = 0; i < 100; i += 1) {
    text += `${String(i).padStart(4, "0")}`.padEnd(4096, "é");
    recorder.onText(text);
  }
  assert.equal(counter.appends, 0, "nothing reached the store while it was closed");
  open();
  await recorder.finish("ok", [attemptReport(1, 1)]);
  assert.equal((await store.readText(BOOK, recorder.callId, "response", 0, 1)).text, text);
});

test("keys, tokens, headers and addresses never reach the store, in any string of the record", async () => {
  const store = new engine.MemoryAiCallStore();
  const recorder = recorderFor(store, {
    clock: fakeClock(),
    label: "Write for hunter2-long-secret",
    system: "You are the ghostwriter. Key: sk-test-SECRETKEY-123456. Also hunter2-long-secret.",
    user: "Authorization: Bearer abc.def.ghi123456 and https://user:pw@api.example.com/v1/x?key=QQQQQQQQ",
    secrets: ["hunter2-long-secret"],
  });
  recorder.onText("Reply with Bearer zzzzzzzzzz and hunter2-long-secret.");
  await recorder.finish("failed", [
    attemptReport(1, 1, {
      endpoint: "https://api.example.com/v1/chat?api_key=SECRET123",
      outcome: "failed",
      error: { name: "Error", message: "Request failed for https://api.example.com/v1?key=SECRET123 with hunter2-long-secret", status: 401, transient: false, timedOut: false },
      transport: { status: 401, streamed: false, tail: 'data: {"error":"bad key sk-live-AAAAAAAAAAAAAAAA"}', end: "closed", requestId: "req-1" },
    }),
  ]);
  const { calls } = await store.readTask(BOOK, "activity_abc");
  const everything = JSON.stringify(calls) + (await store.readText(BOOK, recorder.callId, "system", 0)).text + (await store.readText(BOOK, recorder.callId, "user", 0)).text + (await store.readText(BOOK, recorder.callId, "response", 0, 1)).text;
  for (const secret of ["SECRETKEY", "hunter2-long-secret", "SECRET123", "pw@", "QQQQQQQQ", "zzzzzzzzzz", "sk-live-AAA", "abc.def.ghi123456"]) assert.equal(everything.includes(secret), false, secret);
  assert.equal(calls[0].attempts[0].endpoint, "https://api.example.com");
  assert.match((await store.readText(BOOK, recorder.callId, "system", 0)).text, /\[redacted\]/);
  assert.equal(calls[0].status, "failed");
  assert.equal(calls[0].response.partial, true, "a reply that stopped halfway is partial");
});

test("a long system or user keeps its first megabyte and says so; a long reply keeps its head and its last 256 KiB", async () => {
  const store = new engine.MemoryAiCallStore();
  const recorder = recorderFor(store, { clock: fakeClock(), system: "S".repeat(MiB + 512 * KiB) });
  const pieces = [];
  for (let i = 0; i < 768; i += 1) pieces.push(`${String(i).padStart(6, "0")}`.padEnd(4096, "x"));
  let text = "";
  for (const piece of pieces) {
    text += piece;
    recorder.onText(text);
  }
  await recorder.finish("ok", [attemptReport(1, 1)]);
  const { calls } = await store.readTask(BOOK, "activity_abc");
  const [call] = calls;
  assert.deepEqual(call.request.system, { characters: MiB + 512 * KiB, bytes: MiB + 512 * KiB, storedBytes: MiB, truncated: true });
  assert.equal(call.dropped, "limit");
  assert.equal((await store.readText(BOOK, recorder.callId, "system", 0)).size, MiB);
  assert.equal(call.attempts[0].text.bytes, 3 * MiB);
  assert.equal(call.attempts[0].text.storedBytes, 2 * MiB);
  assert.equal(call.attempts[0].text.truncated, true);
  const kept = await store.readText(BOOK, recorder.callId, "response", 0, 1);
  assert.equal(kept.size, 2 * MiB);
  assert.equal(kept.text.slice(0, 7 * 256 * KiB), text.slice(0, 7 * 256 * KiB), "the head is kept");
  assert.equal(kept.text.slice(-256 * KiB), text.slice(-256 * KiB), "the end is kept");
  assert.equal(call.storedBytes, MiB + 16 + 2 * MiB, "the system, the user (16 bytes) and the kept reply");
});

test("a reply of many characters is kept whole in bytes, and no character is split", async () => {
  const store = new engine.MemoryAiCallStore();
  const recorder = recorderFor(store, { clock: fakeClock() });
  const unit = "a€😀é";
  let text = "";
  for (let i = 0; i < 320_000; i += 1) {
    text += unit;
    if (i % 997 === 0) recorder.onText(text);
  }
  recorder.onText(text);
  await recorder.finish("ok", [attemptReport(1, 1)]);
  const kept = await store.readText(BOOK, recorder.callId, "response", 0, 1);
  assert.ok(!kept.text.includes("\uFFFD"), "no character was cut");
  assert.equal(Buffer.byteLength(kept.text), kept.size);
  assert.ok(kept.size <= 2 * MiB);
  assert.ok(text.endsWith(kept.text.slice(-300)));
  const { calls } = await store.readTask(BOOK, "activity_abc");
  assert.equal(calls[0].attempts[0].text.bytes, Buffer.byteLength(text));
});

test("recording a 2 MiB reply in 4 KB pieces appends each byte once: the bytes appended are the bytes kept", async () => {
  const store = new engine.MemoryAiCallStore();
  const clock = fakeClock();
  const { wrapped, counter } = counting(store);
  const recorder = recorderFor(wrapped, { clock });
  const piece = "p".repeat(4096);
  let text = "";
  const started = performance.now();
  for (let i = 0; i < (2 * MiB) / 4096; i += 1) {
    text += piece;
    recorder.onText(text);
    clock.advance(10);
  }
  await recorder.finish("ok", [attemptReport(1, 1)]);
  const elapsed = performance.now() - started;
  assert.equal(counter.appendedBytes, 2 * MiB, "each byte is appended once, and nothing is copied again");
  assert.ok(counter.appends < 2 * MiB / (16 * KiB) + 8, `checkpoints every 16 KiB: ${counter.appends} appends`);
  assert.ok(elapsed < 5000, `took ${elapsed} ms`);
  assert.equal((await store.readText(BOOK, recorder.callId, "response", 0, 1)).size, 2 * MiB);
});

test("the offsets are contiguous: a repeated append leaves the text as it was", async () => {
  const store = new engine.MemoryAiCallStore();
  const recorder = recorderFor(store, { clock: fakeClock() });
  recorder.onText("0123456789".repeat(100));
  await recorder.finish("ok", [attemptReport(1, 1)]);
  const before = await store.readText(BOOK, recorder.callId, "response", 0, 1);
  await store.append(recorder.callId, 1, 0, "0123456789");
  const after = await store.readText(BOOK, recorder.callId, "response", 0, 1);
  assert.equal(after.text, before.text);
});

test("the recorder never throws on a bad call and refuses an id that is not safe", () => {
  assert.throws(() => recorderFor(new engine.MemoryAiCallStore(), { activityId: "activity/with/slash" }), TypeError);
  const recorder = recorderFor(new engine.MemoryAiCallStore(), { clock: fakeClock() });
  assert.doesNotThrow(() => recorder.onText(undefined));
  assert.equal(engine.isSafeAiCallId(recorder.callId), true);
  assert.equal(engine.aiCallIdOf("activity_x", 12), "activity_x-0012");
});
