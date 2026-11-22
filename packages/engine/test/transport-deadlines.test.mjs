import test from "node:test";
import assert from "node:assert/strict";
import * as engine from "../dist/index.js";
import { ASK, COMMENT, DONE, JSON_ASK, call, configOf, content, eventStream, failWith, finish, forever, hang, integration, jsonStream, live, recording, settle, sse, track, trackTimers, usage } from "./transport-fakes.mjs";

const { AiProviderError, createFetchAi } = engine;

const fail = (status, message = "failed") => new Response(JSON.stringify({ error: { message } }), { status, headers: { "content-type": "application/json" } });
const toolReply = (value) => Response.json({ choices: [{ message: { tool_calls: [{ function: { name: "result", arguments: JSON.stringify(value) } }] }, finish_reason: "tool_calls" }] });

// ─── E1-1: three deadlines instead of one ───────────────────────────────────

test("the deadlines and the limits are exported with the values the engine promises", () => {
  assert.equal(engine.DEFAULT_REQUEST_TIMEOUT_MS, 600_000);
  assert.equal(engine.MIN_REQUEST_TIMEOUT_MS, 30_000);
  assert.equal(engine.DEFAULT_IDLE_TIMEOUT_MS, 600_000);
  assert.equal(engine.MIN_IDLE_TIMEOUT_MS, 30_000);
  assert.equal(engine.MAX_IDLE_TIMEOUT_MS, 3_600_000);
  assert.equal(engine.TOTAL_REQUEST_CAP_MS, 4 * 60 * 60 * 1000);
  assert.equal(engine.MAX_STREAM_TRANSPORT_BYTES, 256_000_000);
  assert.equal(engine.MAX_STREAM_REASONING_CHARACTERS, 16_000_000);
});

for (const [name, fetch] of [["a fetch that honours its signal, like the real one", hang], ["a fetch that never settles whatever its signal says", forever]]) {
  test(`start: nothing answers within the provider timeout (${name})`, async () => {
    const attempts = [];
    const ends = [];
    const ai = createFetchAi(configOf({ requestTimeoutMs: 120 }), { fetch, minimumTimeoutMs: 1, onAttempt: (attempt) => attempts.push(attempt), onAttemptEnd: (end) => ends.push(end) });
    const startedAt = Date.now();
    const error = await ai.complete(ASK).then(() => null, (failure) => failure);
    const took = Date.now() - startedAt;
    assert.ok(error instanceof AiProviderError, String(error));
    assert.equal(error.timedOut, true);
    assert.equal(error.retryable, true, "a timeout is retried as before");
    assert.equal(error.transient, true);
    assert.deepEqual(error.timeout, { phase: "start", ms: 120 });
    assert.equal(error.message, "openai muse-glimmer-30b: the provider did not start answering within 120 ms (the \"Provider timeout\" of the integration \"LlmProxy\")");
    assert.ok(took >= 100 && took < 3_000, `it gave up after ${took} ms`);
    assert.equal(ends[0].outcome, "failed");
    assert.equal(ends[0].failureKind, "timeout");
    assert.equal(ends[0].timeoutMs, 120, "the limit that ran out");
    assert.equal(ends[0].timeoutPhase, "start");
    assert.equal(attempts[0].timeoutMs, 120);
  });
}

test("start: a timeout under the minimum is raised to it, and the error and the hooks say so", async () => {
  const attempts = [];
  const ends = [];
  const ai = createFetchAi(configOf({ requestTimeoutMs: 50 }), { fetch: hang, minimumTimeoutMs: 200, onAttempt: (attempt) => attempts.push(attempt), onAttemptEnd: (end) => ends.push(end) });
  const startedAt = Date.now();
  const error = await ai.complete(ASK).then(() => null, (failure) => failure);
  assert.ok(Date.now() - startedAt >= 180, "it waited for the minimum, not for the 50 ms that were written");
  assert.deepEqual(error.timeout, { phase: "start", ms: 200, raisedFrom: 50 });
  assert.equal(error.message, "openai muse-glimmer-30b: the provider did not start answering within 200 ms (the \"Provider timeout\" of the integration \"LlmProxy\" was 50 ms and was raised to the 200 ms minimum)");
  assert.deepEqual(attempts[0].timeouts, { startMs: 200, idleMs: 600_000, capMs: 14_400_000, raised: { from: 50 } });
  assert.equal(attempts[0].timeoutMs, 200);
  assert.equal(ends[0].timeoutMs, 200);
});

test("the owner's case: a provider timeout of 6 s is raised to 30 s, and nothing stops the call at 6 s", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout", "Date"] });
  const attempts = [];
  const ai = createFetchAi(configOf({ requestTimeoutMs: 6_000 }), { fetch: hang, onAttempt: (attempt) => attempts.push(attempt) });
  const outcome = track(ai.complete(ASK));
  await settle();
  assert.deepEqual(attempts[0].timeouts, { startMs: 30_000, idleMs: 600_000, capMs: 14_400_000, raised: { from: 6_000 } });
  assert.equal(attempts[0].timeoutMs, 30_000);
  t.mock.timers.tick(6_000);
  await settle();
  assert.equal(outcome.done, false, "the old client gave up here");
  t.mock.timers.tick(23_999);
  await settle();
  assert.equal(outcome.done, false);
  t.mock.timers.tick(1);
  await settle();
  assert.equal(outcome.done, true);
  assert.deepEqual(outcome.error.timeout, { phase: "start", ms: 30_000, raisedFrom: 6_000 });
  assert.equal(outcome.error.message, "openai muse-glimmer-30b: the provider did not start answering within 30 s (the \"Provider timeout\" of the integration \"LlmProxy\" was 6 s and was raised to the 30 s minimum)");
});

test("start: an integration without a timeout of its own waits the engine's 600 s, a host can change that, and the message says where to change it", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout", "Date"] });
  const attempts = [];
  const run = (options = {}) => track(createFetchAi(configOf(), { fetch: hang, onAttempt: (attempt) => attempts.push(attempt), ...options }).complete(ASK));

  const plain = run();
  await settle();
  t.mock.timers.tick(599_999);
  await settle();
  assert.equal(plain.done, false);
  t.mock.timers.tick(1);
  await settle();
  assert.deepEqual(plain.error.timeout, { phase: "start", ms: 600_000 });
  assert.equal(plain.error.message, "openai muse-glimmer-30b: the provider did not start answering within 600 s (the default provider timeout; the integration \"LlmProxy\" can change it with its \"Provider timeout\")");

  const hosted = run({ defaultTimeoutMs: 90_000 });
  await settle();
  t.mock.timers.tick(89_999);
  await settle();
  assert.equal(hosted.done, false);
  t.mock.timers.tick(1);
  await settle();
  assert.deepEqual(hosted.error.timeout, { phase: "start", ms: 90_000 });
  assert.deepEqual(attempts.map((attempt) => attempt.timeouts.startMs), [600_000, 90_000]);
});

test("the start deadline is over once the answer begins: a slow stream is not cut at the provider timeout", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout", "Date"] });
  const stream = live();
  const ai = createFetchAi(configOf({ requestTimeoutMs: 40_000 }), { fetch: async (_url, init) => (failWith(stream, init.signal), eventStream(stream.body)) });
  const outcome = track(ai.complete({ ...ASK, onText: () => undefined }));
  await settle();
  for (let piece = 0; piece < 5; piece += 1) {
    stream.send(content(`piece ${piece}. `));
    await settle();
    t.mock.timers.tick(20_000);
    await settle();
    assert.equal(outcome.done, false, `after ${(piece + 1) * 20} s of a stream that is alive`);
  }
  stream.send(finish("stop"), DONE);
  await settle();
  assert.equal(outcome.error, undefined, outcome.error?.message);
  assert.equal(outcome.value.text, "piece 0. piece 1. piece 2. piece 3. piece 4. ");
});

test("idle: the silence between two pieces of a stream ends the call, and every byte, a comment too, starts the count again", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout", "Date"] });
  const stream = live();
  const ends = [];
  // The fetch ignores its signal: only the client's own release can close the stream.
  const ai = createFetchAi(configOf({ idleTimeoutMs: 45_000 }), { fetch: async () => eventStream(stream.body), onAttemptEnd: (end) => ends.push(end) });
  const outcome = track(ai.complete({ ...ASK, onText: () => undefined }));
  await settle();
  stream.send(content("Hel"));
  await settle();
  t.mock.timers.tick(44_000);
  await settle();
  stream.send(COMMENT);
  await settle();
  t.mock.timers.tick(44_000);
  await settle();
  assert.equal(outcome.done, false, "a keep-alive comment is activity");
  stream.send(content("lo"));
  await settle();
  t.mock.timers.tick(44_999);
  await settle();
  assert.equal(outcome.done, false);
  t.mock.timers.tick(1);
  await settle();
  assert.equal(outcome.done, true);
  assert.ok(outcome.error instanceof AiProviderError);
  assert.deepEqual(outcome.error.timeout, { phase: "idle", ms: 45_000 });
  assert.equal(outcome.error.timedOut, true);
  assert.equal(outcome.error.retryable, true);
  assert.equal(outcome.error.transient, true);
  assert.equal(outcome.error.message, "openai muse-glimmer-30b: the provider sent nothing for 45 s while answering (the \"Idle timeout\" of the integration \"LlmProxy\")");
  assert.equal(stream.state.cancels, 1, "the stream was released");
  assert.equal(ends[0].timeoutMs, 45_000);
  assert.equal(ends[0].timeoutPhase, "idle");
  assert.equal(outcome.error.model, "muse-glimmer-30b", "the model had started to answer: what it used is accounted for");
  assert.equal(outcome.error.usageKnown, false);
  assert.ok(outcome.error.usage.outputTokens > 0);
});

test("idle: the default is 600 s, it can be set on the integration, and it never goes under 30 s or over an hour", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout", "Date"] });
  const attempts = [];
  const answerThenSilence = (config) => {
    const stream = live();
    const ai = createFetchAi(config, { fetch: async () => eventStream(stream.body), onAttempt: (attempt) => attempts.push(attempt) });
    const outcome = track(ai.complete({ ...ASK, onText: () => undefined }));
    return { stream, outcome };
  };
  const first = answerThenSilence(configOf());
  await settle();
  first.stream.send(content("x"));
  await settle();
  t.mock.timers.tick(599_999);
  await settle();
  assert.equal(first.outcome.done, false);
  t.mock.timers.tick(1);
  await settle();
  assert.deepEqual(first.outcome.error.timeout, { phase: "idle", ms: 600_000 });
  assert.equal(first.outcome.error.message, "openai muse-glimmer-30b: the provider sent nothing for 600 s while answering (the default idle timeout; the integration \"LlmProxy\" can change it with its \"Idle timeout\")");

  for (const [written, used] of [[5_000, 30_000], [9_999_999, 3_600_000], [120_000, 120_000]]) {
    attempts.length = 0;
    const run = answerThenSilence(configOf({ idleTimeoutMs: written }));
    await settle();
    assert.equal(attempts[0].timeouts.idleMs, used, `${written} ms is used as ${used} ms`);
    run.stream.send(content("x"));
    await settle();
    t.mock.timers.tick(used - 1);
    await settle();
    assert.equal(run.outcome.done, false, `${written}: still alive just before ${used} ms`);
    t.mock.timers.tick(1);
    await settle();
    assert.deepEqual(run.outcome.error.timeout, { phase: "idle", ms: used }, String(written));
  }
});

test("total: a provider that keeps sending bytes is still cut at four hours", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout", "Date"] });
  const stream = live();
  const ends = [];
  const ai = createFetchAi(configOf(), { fetch: async () => eventStream(stream.body), onAttemptEnd: (end) => ends.push(end) });
  const outcome = track(ai.complete({ ...ASK, onText: () => undefined }));
  await settle();
  for (let step = 1; step <= 48; step += 1) {
    stream.send(content("."));
    await settle();
    t.mock.timers.tick(300_000);
    await settle();
    if (step < 48) assert.equal(outcome.done, false, `after ${step * 5} minutes`);
  }
  assert.equal(outcome.done, true, "four hours of a live stream are over");
  assert.ok(outcome.error instanceof AiProviderError);
  assert.deepEqual(outcome.error.timeout, { phase: "total", ms: 14_400_000 });
  assert.equal(outcome.error.timedOut, true);
  assert.equal(outcome.error.message, "openai muse-glimmer-30b: the provider did not finish within 4 h (the longest one request may take: it cannot be changed)");
  assert.equal(stream.state.cancels, 1);
  assert.equal(ends[0].timeoutPhase, "total");
});

test("streamMode off keeps one absolute deadline: the provider timeout covers the whole call, the body too", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout", "Date"] });
  const body = live();
  const ai = createFetchAi(configOf({ streamMode: "off", requestTimeoutMs: 40_000 }), { fetch: async () => jsonStream(body.body) });
  const outcome = track(ai.complete(ASK));
  await settle();
  body.send("{\"choices\":[{\"message\":{\"content\":\"A whole sc");
  await settle();
  t.mock.timers.tick(39_999);
  await settle();
  assert.equal(outcome.done, false);
  t.mock.timers.tick(1);
  await settle();
  assert.equal(outcome.done, true);
  assert.deepEqual(outcome.error.timeout, { phase: "start", ms: 40_000 });
  assert.equal(body.state.cancels, 1, "the body was released");
});

// ─── The author's signal wins over everything ───────────────────────────────

test("the author's signal wins: a call cancelled while it waits for the answer is a cancel, and no other candidate is tried", async () => {
  const ends = [];
  const controller = new AbortController();
  const { fetch, calls } = recording((entry) => hang(entry.url, entry.init));
  const cfg = { aiIntegrations: [integration({ requestTimeoutMs: 5_000 }), integration({ id: "q", name: "Second", endpoint: "http://second.test/v1", chatModels: [{ id: "m2", name: "second", capabilities: ["default"] }] })] };
  const ai = createFetchAi(cfg, { fetch, minimumTimeoutMs: 1, onAttemptEnd: (end) => ends.push(end) });
  const pending = ai.complete({ ...ASK, signal: controller.signal }).then(() => null, (failure) => failure);
  setTimeout(() => controller.abort(), 25);
  const error = await pending;
  assert.equal(error.name, "AbortError");
  assert.equal(error instanceof AiProviderError, false);
  assert.equal(error.timedOut, undefined);
  assert.equal(calls.length, 1, "a cancel does not move on to the fallback");
  assert.equal(ends.length, 1);
  assert.equal(ends[0].outcome, "cancelled");
  assert.equal(ends[0].failureKind, "cancelled");
  assert.equal(ends[0].timeoutMs, undefined);
});

test("the author's signal wins during the stream: a cancel, never a timeout, and the connection is released even if the fetch ignores its signal", async () => {
  const stream = live();
  const ends = [];
  const controller = new AbortController();
  const ai = createFetchAi(configOf({ idleTimeoutMs: 60_000 }), { fetch: async () => eventStream(stream.body), onAttemptEnd: (end) => ends.push(end) });
  const pending = ai.complete({ ...ASK, signal: controller.signal, onText: () => undefined }).then(() => null, (failure) => failure);
  await settle();
  stream.send(content("Half a scene"));
  await settle();
  controller.abort();
  const error = await pending;
  assert.equal(error.name, "AbortError");
  assert.equal(error instanceof AiProviderError, false);
  assert.equal(stream.state.cancels, 1, "the reader was released");
  assert.equal(ends[0].outcome, "cancelled");
  assert.equal(ends[0].streamed, true);
});

test("the author's signal wins over a deadline that runs out at the same moment, in either order", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout", "Date"] });
  for (const order of ["the deadline first", "the author first"]) {
    const controller = new AbortController();
    const outcome = track(createFetchAi(configOf({ requestTimeoutMs: 40_000 }), { fetch: hang }).complete({ ...ASK, signal: controller.signal }));
    await settle();
    if (order === "the deadline first") {
      t.mock.timers.tick(40_000);
      controller.abort();
    } else {
      controller.abort();
      t.mock.timers.tick(40_000);
    }
    await settle();
    assert.equal(outcome.error?.name, "AbortError", order);
    assert.equal(outcome.error?.timedOut, undefined, order);
  }
});

// ─── Nothing stays behind ───────────────────────────────────────────────────

test("no timer is left after a call, however it ended", async () => {
  const outcomes = [
    ["a stream that finishes", () => ({ fetch: async () => sse([content("Hi"), finish("stop"), usage(1, 1), DONE]), request: { ...ASK, onText: () => undefined } })],
    ["a structured stream", () => ({ fetch: async () => sse([call("", { name: "result" }), call("{\"ok\":true}"), finish("tool_calls"), DONE]), request: JSON_ASK })],
    ["a JSON reply", () => ({ fetch: async () => Response.json({ choices: [{ message: { content: "Hi" }, finish_reason: "stop" }] }), request: ASK })],
    ["a JSON reply with streaming off", () => ({ extra: { streamMode: "off" }, fetch: async () => Response.json({ choices: [{ message: { content: "Hi" }, finish_reason: "stop" }] }), request: ASK })],
    ["an HTTP error", () => ({ fetch: async () => fail(500, "boom"), request: ASK })],
    ["a connection that fails", () => ({ fetch: async () => { throw new TypeError("fetch failed"); }, request: ASK })],
    ["a start timeout", () => ({ extra: { requestTimeoutMs: 30 }, fetch: hang, request: ASK })],
    ["a start timeout of a fetch that ignores its signal", () => ({ extra: { requestTimeoutMs: 30 }, fetch: forever, request: ASK })],
    ["an idle timeout", () => {
      const stream = live();
      return { extra: { idleTimeoutMs: 30 }, fetch: async () => (stream.send(content("Hi")), eventStream(stream.body)), request: { ...ASK, onText: () => undefined } };
    }],
    ["a stream that breaks", () => {
      const stream = live();
      return { fetch: async () => (stream.send(content("Hi")), setImmediate(() => stream.fail(new TypeError("terminated"))), eventStream(stream.body)), request: { ...ASK, onText: () => undefined } };
    }],
    ["a cancel during the stream", () => {
      const stream = live();
      const controller = new AbortController();
      return { fetch: async () => (stream.send(content("Hi")), setImmediate(() => controller.abort()), eventStream(stream.body)), request: { ...ASK, onText: () => undefined, signal: controller.signal } };
    }],
  ];
  for (const [name, make] of outcomes) {
    const { fetch, request, extra } = make();
    const timers = trackTimers();
    try {
      await createFetchAi(configOf(extra), { fetch, minimumTimeoutMs: 1 }).complete(request).then(() => null, () => null);
      await settle();
    } finally {
      timers.restore();
    }
    assert.equal(timers.pending.size, 0, `${name}: ${timers.pending.size} timer(s) left`);
  }
});

// ─── Routing limits are unchanged ───────────────────────────────────────────

test("a later candidate runs for the time the routing limit leaves, which no minimum raises, and the error says so", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout", "Date"] });
  const attempts = [];
  const cfg = {
    aiIntegrations: [
      integration({ id: "a", name: "First", endpoint: "http://a.test/v1" }),
      integration({ id: "b", name: "Second", endpoint: "http://b.test/v1", requestTimeoutMs: 6_000 }),
    ],
    routingExecution: { maxTotalDurationMs: 150 },
  };
  const { fetch, calls } = recording((entry) => (entry.url.includes("a.test") ? fail(503, "first down") : hang(entry.url, entry.init)));
  const ai = createFetchAi(cfg, { fetch, onAttempt: (attempt) => attempts.push(attempt) });
  const outcome = track(ai.complete(ASK));
  await settle();
  assert.equal(calls.length, 2, "the second candidate started: time remained");
  assert.deepEqual(attempts[0].timeouts, { startMs: 600_000, idleMs: 600_000, capMs: 14_400_000 }, "the first candidate runs for its own timeouts whatever the total");
  assert.deepEqual(attempts[1].timeouts, { startMs: 150, idleMs: 150, capMs: 150 }, "the routing limit is not raised to the 30 s minimum: it caps the whole call");
  assert.equal(attempts[1].timeoutMs, 150);
  t.mock.timers.tick(149);
  await settle();
  assert.equal(outcome.done, false);
  t.mock.timers.tick(1);
  await settle();
  assert.equal(outcome.done, true);
  assert.ok(outcome.error instanceof AiProviderError);
  assert.deepEqual(outcome.error.timeout, { phase: "total", ms: 150 });
  assert.match(outcome.error.message, /^openai muse-glimmer-30b: request timed out: /);
  assert.match(outcome.error.message, /150 ms left of the total routing time \(maxTotalDurationMs\)/);
});

// ─── E1-6: what the hooks say ───────────────────────────────────────────────

test("the attempt that is about to be sent carries its three deadlines and its streaming mode", async () => {
  const attempts = [];
  const record = (extra, options = {}) => createFetchAi(configOf(extra), { fetch: async () => Response.json({ choices: [{ message: { content: "Hi" }, finish_reason: "stop" }] }), onAttempt: (attempt) => attempts.push(attempt), ...options }).complete(ASK);
  await record({});
  await record({ streamMode: "off", idleTimeoutMs: 90_000, requestTimeoutMs: 45_000 });
  await record({ streamMode: "auto" }, { defaultTimeoutMs: 100_000 });
  assert.deepEqual(attempts.map((attempt) => attempt.streamMode), ["auto", "off", "auto"]);
  assert.deepEqual(attempts[0].timeouts, { startMs: 600_000, idleMs: 600_000, capMs: 14_400_000 });
  assert.deepEqual(attempts[1].timeouts, { startMs: 45_000, idleMs: 90_000, capMs: 14_400_000 });
  assert.equal(attempts[2].timeouts.startMs, 100_000);
  assert.equal(attempts[0].stream, true, "every chat request streams by default");
  assert.equal(attempts[1].stream, false, "streamMode off never streams");
});

test("the end of an attempt says whether the reply was streamed, when its first byte came and whether the function was called", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout", "Date"] });
  const ends = [];
  const onAttemptEnd = (end) => ends.push(end);

  // A structured request answered by a streamed function call, after 1.2 s of silence.
  const stream = live();
  const streamed = track(createFetchAi(configOf(), { fetch: async (_url, init) => (failWith(stream, init.signal), eventStream(stream.body)), onAttemptEnd }).complete(JSON_ASK));
  await settle();
  t.mock.timers.tick(1_234);
  stream.send(call("", { name: "result" }), call("{\"ok\":true}"));
  await settle();
  t.mock.timers.tick(500);
  stream.send(finish("tool_calls"), DONE);
  await settle();
  assert.equal(streamed.error, undefined, streamed.error?.message);
  assert.equal(ends[0].outcome, "ok");
  assert.equal(ends[0].streamed, true);
  assert.equal(ends[0].firstByteMs, 1_234);
  assert.equal(ends[0].toolCalled, true);
  assert.equal(ends[0].durationMs, 1_734);

  // The same request answered with a JSON body after 800 ms: not streamed; the reply is the first byte.
  const delayed = track(createFetchAi(configOf(), { fetch: async () => { await new Promise((resolve) => setTimeout(resolve, 800)); return toolReply({ ok: true }); }, onAttemptEnd }).complete(JSON_ASK));
  await settle();
  t.mock.timers.tick(800);
  await settle();
  assert.equal(delayed.error, undefined, delayed.error?.message);
  assert.equal(ends[1].streamed, false);
  assert.equal(ends[1].firstByteMs, 800);
  assert.equal(ends[1].toolCalled, true);

  // A structured request that the model answered in the text: no function was called. A plain request has no such thing.
  await createFetchAi(configOf(), { fetch: async () => sse([content("{\"ok\":true}"), finish("stop"), DONE]), onAttemptEnd }).complete(JSON_ASK);
  await createFetchAi(configOf(), { fetch: async () => sse([content("Prose."), finish("stop"), DONE]), onAttemptEnd }).complete({ ...ASK, onText: () => undefined });
  assert.equal(ends[2].toolCalled, false);
  assert.equal(ends[2].streamed, true);
  assert.equal(ends[3].toolCalled, undefined);
  assert.equal("toolCalled" in ends[3], false);

  // A call that got nothing before its deadline: not streamed, no first byte, nothing to say about the function.
  const silent = track(createFetchAi(configOf({ requestTimeoutMs: 40_000 }), { fetch: hang, onAttemptEnd }).complete(JSON_ASK));
  await settle();
  t.mock.timers.tick(40_000);
  await settle();
  assert.equal(silent.done, true);
  assert.equal(ends[4].outcome, "failed");
  assert.equal(ends[4].streamed, false);
  assert.equal(ends[4].firstByteMs, undefined);
  assert.equal("toolCalled" in ends[4], false);
});

test("a timeout is still a transient failure that is retried, whatever the deadline was", async () => {
  const outcomes = [];
  for (const [phase, extra, make] of [
    ["start", { requestTimeoutMs: 30 }, () => ({ fetch: hang })],
    ["idle", { idleTimeoutMs: 40 }, () => {
      const stream = live();
      return { fetch: async () => (stream.send(content("Hi")), eventStream(stream.body)) };
    }],
  ]) {
    const { fetch } = make();
    const error = await createFetchAi(configOf(extra), { fetch, minimumTimeoutMs: 1 }).complete({ ...ASK, onText: () => undefined }).then(() => null, (failure) => failure);
    outcomes.push([phase, error.timeout?.phase, engine.classifyAutopilotError(error).kind, error.retryable, error.transient]);
  }
  assert.deepEqual(outcomes, [["start", "start", "timeout", true, true], ["idle", "idle", "timeout", true, true]]);
});

test("nothing secret is in a timeout: the message names the integration and the setting, never the key or the endpoint", async () => {
  const secretEndpoint = "http://secret-host.example:8123/v1/secret-path?key=QUERYSECRET789";
  const error = await createFetchAi(configOf({ requestTimeoutMs: 30, endpoint: secretEndpoint }), { fetch: hang, minimumTimeoutMs: 1 }).complete(ASK).then(() => null, (failure) => failure);
  const everything = JSON.stringify({ message: error.message, timeout: error.timeout, target: error.target });
  for (const secret of ["sk-test-SECRET-0123456789", "QUERYSECRET789", "secret-path", "secret-host.example:8123/v1"]) assert.equal(everything.includes(secret), false, secret);
});

// ─── More of the same: fallbacks, late replies, JSON bodies, odd values ─────

test("a timeout moves on to the next candidate, which has deadlines of its own", async () => {
  const ends = [];
  const attempts = [];
  const cfg = { aiIntegrations: [integration({ id: "a", name: "First", endpoint: "http://a.test/v1", requestTimeoutMs: 40 }), integration({ id: "b", name: "Second", endpoint: "http://b.test/v1", idleTimeoutMs: 90_000 })] };
  const { fetch, calls } = recording((entry) => (entry.url.includes("a.test") ? hang(entry.url, entry.init) : sse([content("Second answered."), finish("stop"), DONE])));
  const response = await createFetchAi(cfg, { fetch, minimumTimeoutMs: 1, onAttempt: (attempt) => attempts.push(attempt), onAttemptEnd: (end) => ends.push(end) }).complete({ ...ASK, onText: () => undefined });
  assert.equal(response.text, "Second answered.");
  assert.equal(calls.length, 2);
  assert.deepEqual(ends.map((end) => [end.outcome, end.failureKind, end.timeoutPhase, end.streamed]), [["failed", "timeout", "start", false], ["ok", undefined, undefined, true]]);
  assert.deepEqual(attempts.map((attempt) => [attempt.timeouts.startMs, attempt.timeouts.idleMs]), [[40, 600_000], [600_000, 90_000]]);
});

test("a reply that arrives after the call gave up is dropped, and its body is let go", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout", "Date"] });
  const late = live();
  let arrive;
  const fetch = () => new Promise((resolve) => {
    arrive = () => resolve(eventStream(late.body));
  });
  const outcome = track(createFetchAi(configOf({ requestTimeoutMs: 40_000 }), { fetch }).complete(ASK));
  await settle();
  t.mock.timers.tick(40_000);
  await settle();
  assert.deepEqual(outcome.error?.timeout, { phase: "start", ms: 40_000 });
  assert.equal(late.state.cancels, 0);
  arrive();
  await settle();
  assert.equal(late.state.cancels, 1, "the stream that came too late was cancelled, not left open");
});

test("a server that ignores `stream` and answers a JSON body that then stalls is cut by the idle deadline, and the body is released", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout", "Date"] });
  const body = live();
  const ai = createFetchAi(configOf({ idleTimeoutMs: 45_000, requestTimeoutMs: 40_000 }), { fetch: async () => jsonStream(body.body) });
  const outcome = track(ai.complete(ASK));
  await settle();
  body.send("{\"choices\":[{\"message\":{\"content\":\"A whole sc");
  await settle();
  for (let step = 0; step < 4; step += 1) {
    t.mock.timers.tick(40_000);
    body.send("ene");
    await settle();
    assert.equal(outcome.done, false, "the 40 s of the start deadline are over, and the body keeps arriving");
  }
  t.mock.timers.tick(44_999);
  await settle();
  assert.equal(outcome.done, false);
  t.mock.timers.tick(1);
  await settle();
  assert.deepEqual(outcome.error?.timeout, { phase: "idle", ms: 45_000 });
  assert.equal(body.state.cancels, 1);
});

test("a minimum that is not a positive number is ignored, and a provider timeout over the cap is the cap (no timer overflows)", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout", "Date"] });
  const attempts = [];
  for (const minimumTimeoutMs of [0, -5, Number.NaN, "10"]) {
    await createFetchAi(configOf({ requestTimeoutMs: 1_000 }), { fetch: async () => Response.json({ choices: [{ message: { content: "Hi" }, finish_reason: "stop" }] }), minimumTimeoutMs, onAttempt: (attempt) => attempts.push(attempt) }).complete(ASK);
  }
  assert.deepEqual(attempts.map((attempt) => attempt.timeouts.startMs), [30_000, 30_000, 30_000, 30_000], "the minimum stays 30 s");

  // 100 billion milliseconds does not fit a timer (the platform would fire it at once): it is limited to the four hours.
  const outcome = track(createFetchAi(configOf({ requestTimeoutMs: 100_000_000_000 }), { fetch: hang, onAttempt: (attempt) => attempts.push(attempt) }).complete(ASK));
  await settle();
  assert.equal(attempts.at(-1).timeouts.startMs, 14_400_000);
  t.mock.timers.tick(14_399_999);
  await settle();
  assert.equal(outcome.done, false);
  t.mock.timers.tick(1);
  await settle();
  assert.deepEqual(outcome.error?.timeout, { phase: "total", ms: 14_400_000 });
});

test("a provider timeout beyond what a timer can hold is not an instant timeout (the platform fires such a timer after 1 ms)", async () => {
  const fetch = (_url, init) => new Promise((resolve, reject) => {
    const timer = setTimeout(() => resolve(Response.json({ choices: [{ message: { content: "Hi" }, finish_reason: "stop" }] })), 40);
    init.signal.addEventListener("abort", () => {
      clearTimeout(timer);
      reject(init.signal.reason);
    }, { once: true });
  });
  const response = await createFetchAi(configOf({ requestTimeoutMs: 100_000_000_000 }), { fetch }).complete(ASK);
  assert.equal(response.text, "Hi");
});
