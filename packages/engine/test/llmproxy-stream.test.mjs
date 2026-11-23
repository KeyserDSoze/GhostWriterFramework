import test, { after, before } from "node:test";
import assert from "node:assert/strict";
import * as engine from "../dist/index.js";
import { WORDS_TEXT, startFakeLlmProxy } from "./llmproxy-fake.mjs";

// The engine's client against a fake LlmProxy (llmproxy-fake.mjs: a real HTTP server that says what LlmProxy's source says), over a real connection.
// Every test names a scenario of the fake and says what the client must do with it. The first group is what a healthy gateway sends in every
// shape it may come in; the others are what goes wrong, after the first byte (the stream is cut, the runtime reports a failure inside it, the
// provider goes quiet) and before it (the gateway's JSON errors), and what the client must keep of a reply that stopped halfway.

const KEY = "sk-test-SECRET-0123456789";
const REQUEST_ID = "0b7f0a52-6f0e-4a9e-9d57-7e8b3c0d7a11";
const SCHEMA = { name: "result", description: "A result", parameters: { type: "object", properties: { ok: { type: "boolean" }, note: { type: "string" } }, required: ["ok"] } };
const ASK = { capability: "autopilot", label: "t", system: "SYS", user: "USR" };
const usage = (input, output, cached = 0) => ({ inputTokens: input, outputTokens: output, cachedInputTokens: cached });

let fake;
before(async () => {
  fake = await startFakeLlmProxy({ gap: 100, silence: 400 });
});
after(async () => {
  await fake.close();
});

function clientFor(scenario, { idle = 5000, start = 5000, extra = {}, options = {} } = {}) {
  const ends = [];
  const integration = { id: "p", name: "LlmProxy", provider: "openai", endpoint: fake.base(scenario), apiKey: KEY, chatModels: [{ id: "m", name: "muse-glimmer-30b", capabilities: ["default"] }], idleTimeoutMs: idle, requestTimeoutMs: start, ...extra };
  const ai = engine.createFetchAi({ aiIntegrations: [integration] }, { minimumTimeoutMs: 1, onAttemptEnd: (end) => ends.push(end), ...options });
  return { ai, ends };
}

/** One call to a scenario: `{ response }` when it worked, `{ error }` when it did not, and the end records of its attempts. */
async function call(scenario, { request = {}, ...options } = {}) {
  const { ai, ends } = clientFor(scenario, options);
  const before = fake.requests.length;
  try {
    return { response: await ai.complete({ ...ASK, onText: () => undefined, ...request }), ends, requests: fake.requests.slice(before) };
  } catch (error) {
    return { error, ends, requests: fake.requests.slice(before) };
  }
}

const structured = { json: SCHEMA, onText: undefined };

// ─── What a healthy gateway sends, in every shape it may come in ────────────

const HEALTHY = {
  plain: usage(120, 44),
  "no-finish-reason": usage(120, 44),
  "usage-in-finish-chunk": usage(120, 44),
  "usage-null-everywhere": usage(120, 44),
  "usage-cached": usage(120, 44, 100),
  "usage-responses-names": usage(120, 44),
  "content-null": usage(5, 5),
  "reasoning-content": usage(120, 80),
  "reasoning-field": usage(120, 80),
  "long-reasoning": usage(120, 9100),
  "json-despite-stream": usage(120, 44),
  crlf: usage(120, 44),
  "cr-only": usage(120, 44),
  "no-space": usage(120, 44),
  "no-blank-lines": usage(120, 44),
  "last-line-without-newline": usage(120, 44),
  comments: usage(120, 44),
  "comments-crlf": usage(120, 44),
  "event-names": usage(120, 44),
  "one-byte-chunks": usage(120, 44),
  "awkward-chunks": usage(120, 44),
  gzip: usage(120, 44),
  "eof-after-finish-no-done": usage(120, 44),
};

for (const [scenario, tokens] of Object.entries(HEALTHY)) {
  test(`a healthy stream (${scenario}): the whole text, and the tokens the provider reported`, async () => {
    const { response, error, ends } = await call(scenario);
    assert.equal(error, undefined, error?.message);
    assert.equal(response.text, WORDS_TEXT);
    assert.deepEqual(response.usage, tokens);
    assert.equal(response.usageKnown, true, "the provider's own count is not an estimate");
    const end = ends.at(-1);
    assert.equal(end.outcome, "ok");
    assert.equal(end.transport.status, 200);
    assert.equal(end.transport.usageReceived, true);
    assert.equal(end.transport.usageRequested, true);
    assert.equal(end.transport.tail, undefined, "the record of an attempt that worked carries numbers, never the words of the stream");
    assert.equal(end.transport.requestId, REQUEST_ID);
    assert.ok(end.transport.bytes > 0 && end.transport.chunks > 0);
    // `end` is how the stream ended: a close with `[DONE]`, or without it (a stream that ended after its finish reason is accepted, as it always was).
    assert.equal(end.transport.end, scenario === "json-despite-stream" ? undefined : scenario === "eof-after-finish-no-done" ? "closed" : "done");
  });
}

test("a reply that carries no token count is estimated and says so: no usage chunk, or one of zeros", async () => {
  for (const scenario of ["eof-after-finish-before-usage", "usage-zero", "ignores-usage-option"]) {
    const { response, error, ends } = await call(scenario);
    assert.equal(error, undefined, `${scenario}: ${error?.message}`);
    assert.equal(response.text, WORDS_TEXT, scenario);
    assert.equal(response.usageKnown, false, scenario);
    assert.ok(response.usage.inputTokens > 0 && response.usage.outputTokens > 0, `${scenario}: an estimate, not nothing`);
    assert.equal(response.costKnown, false, scenario);
    assert.equal(ends.at(-1).usageKnown, false, scenario);
    assert.equal(ends.at(-1).transport.usageReceived, false, scenario);
  }
});

test("the text reaches the listener as it grows, and a listener that throws cannot break the stream", async () => {
  const seen = [];
  const { response, error } = await call("plain", { request: { onText: (text) => seen.push(text) } });
  assert.equal(error, undefined);
  assert.equal(response.text, WORDS_TEXT);
  assert.ok(seen.length > 5);
  assert.ok(seen.every((text, at) => at === 0 || text.startsWith(seen[at - 1])), "cumulative");
  assert.equal(seen.at(-1), WORDS_TEXT);

  const thrown = await call("plain", { request: { onText: () => { throw new Error("the host's listener broke"); } } });
  assert.equal(thrown.error, undefined, thrown.error?.message);
  assert.equal(thrown.response.text, WORDS_TEXT);
});

test("a structured reply streams as the arguments of a function, whatever the cut of the pieces", async () => {
  for (const scenario of ["tool-call", "tool-call-whole-first"]) {
    const { response, error } = await call(scenario, { request: structured });
    assert.equal(error, undefined, scenario);
    assert.deepEqual(response.json, scenario === "tool-call" ? { ok: true, note: "Il gabbiano è già volato via — 你好 😀" } : { ok: true, note: "x" });
    assert.deepEqual(response.usage, usage(120, 30));
  }
});

// ─── Time: what a slow model is, and what a dead one is ─────────────────────

test("a stream that keeps coming is never cut for being long, however short the idle limit is", async () => {
  const slow = await call("slow-steady", { idle: 1000 });
  assert.equal(slow.error, undefined, slow.error?.message);
  assert.ok(slow.ends.at(-1).durationMs > 1000, "the whole stream took longer than the idle limit");

  const pause = await call("pause-in-the-middle", { idle: 1500 });
  assert.equal(pause.error, undefined, pause.error?.message);
  assert.equal(pause.response.text, "Prima parte. Seconda parte.");
});

test("comments that keep the connection open keep the stream alive: the model is slow, the connection is not dead", async () => {
  const { response, error } = await call("keep-alive-comments", { idle: 600 });
  assert.equal(error, undefined, error?.message);
  assert.equal(response.text, WORDS_TEXT);
});

test("a gateway that sends its headers at once and then waits for the model's first token is watched by the idle limit, not by the start limit", async () => {
  // LlmProxy starts its response before the runtime says a word (`StartAsync`), so a long prefill is a silence of the stream: the idle timeout is its limit.
  const { response, error } = await call("late-first-token", { start: 100, idle: 3000 });
  assert.equal(error, undefined, error?.message);
  assert.equal(response.text, WORDS_TEXT);
  const dead = await call("late-first-token", { start: 3000, idle: 150 });
  assert.equal(dead.error?.timedOut, true);
  assert.equal(dead.error.timeout.phase, "idle");
});

test("a stream that goes quiet for good is cut by the idle limit, with what had arrived, and is retried as a failure of the moment", async () => {
  const { error, ends } = await call("dead-silence", { idle: 400 });
  assert.ok(error instanceof engine.AiProviderError);
  assert.equal(error.timedOut, true);
  assert.equal(error.timeout.phase, "idle");
  assert.equal(error.timeout.ms, 400);
  assert.equal(error.transient, true);
  assert.equal(error.retryable, true);
  assert.equal(error.partialText, "Il gabbiano è già volato ");
  assert.equal(error.usageKnown, false);
  assert.equal(error.transport.end, "timeout");
  assert.equal(error.transport.status, 200);
  assert.ok(error.transport.silentMs >= 350, `silent for ${error.transport.silentMs} ms`);
  assert.ok(error.transport.lastChunkAfterMs < 300);
  assert.equal(ends.at(-1).failureKind, "timeout");
  assert.equal(ends.at(-1).partialText, error.partialText);
  assert.equal(engine.classifyAutopilotError(error).kind, "timeout");
});

test("a gateway that never says a word after its headers is cut by the idle limit too, and says so", async () => {
  const { error } = await call("dead-silence-before-first-token", { idle: 300 });
  assert.equal(error.timedOut, true);
  assert.equal(error.timeout.phase, "idle");
  assert.equal(error.partialText, undefined);
  assert.equal(error.transport.status, 200);
  assert.equal(error.transport.bytes, 0);
  assert.equal(error.transport.chunks, 0);
});

// ─── A reply that stops halfway: what the client keeps, and what it says ────

const HALF = "Il gabbiano è già ";
const CUT = {
  // [how, how the transport says it ended, the text that had arrived, the finish reason it saw, whether a usage chunk came before the stream stopped]
  "error-event": ["provider-error", "error", "Il gabbiano è già volato "],
  "error-event-no-done": ["provider-error", "error", "Il gabbiano "],
  "error-event-string": ["provider-error", "error", "Il gabbiano "],
  "error-event-overloaded": ["provider-error", "error", "Il gabbiano "],
  "error-event-named": ["provider-error", "error", "Il gabbiano "],
  "error-event-in-choice": ["provider-error", "error", "Il gabbiano ", "error"],
  "finish-abort": ["provider-abort", "error", "Il gabbiano ", "abort", true],
  "finish-unknown": ["ended", "closed", WORDS_TEXT, "weird_reason", true],
  "eof-mid-answer": ["ended", "closed", HALF],
  "eof-mid-event": ["ended", "closed", HALF],
  "reset-mid-answer": ["lost", "reset", HALF],
  "reset-mid-event": ["lost", "reset", HALF],
  "drop-mid-answer": ["lost", "reset", HALF],
};

for (const [scenario, [how, end, partial, finish, counted = false]] of Object.entries(CUT)) {
  test(`a stream that stops after the answer began (${scenario}): a typed failure of the moment, with what had arrived`, async () => {
    const { error, ends } = await call(scenario);
    assert.ok(error instanceof engine.AiStreamInterruptedError, `${error?.name}: ${error?.message}`);
    assert.ok(error instanceof engine.AiProviderError);
    assert.equal(error.how, how);
    assert.equal(error.retryable, true);
    assert.equal(error.transient, true, "the run repeats it as it repeats any failure of the moment");
    assert.equal(error.partialText, partial, "what had arrived is not thrown away");
    assert.equal(error.usageKnown, counted, counted ? "the usage chunk came before the stream stopped" : "no usage chunk came: the tokens are an estimate, and say so");
    assert.ok(error.usage.outputTokens > 0 && error.usage.inputTokens > 0);
    assert.equal(error.model, "muse-glimmer-30b");
    // What the transport saw.
    const transport = error.transport;
    assert.equal(transport.status, 200, "the stream began with a 200: the status of the response is not the failure");
    assert.equal(transport.streamed, true);
    assert.ok(transport.bytes > 0 && transport.chunks > 0 && transport.events > 0);
    assert.equal(transport.end, end);
    assert.equal(transport.usageReceived, counted);
    assert.equal(transport.usageRequested, true);
    assert.equal(transport.finishReason, finish);
    assert.equal(transport.requestId, REQUEST_ID);
    assert.ok(transport.tail.length > 0 && transport.tail.length <= 300);
    assert.ok(transport.lastChunkAfterMs >= 0 && transport.silentMs >= 0 && !Number.isNaN(Date.parse(transport.lastChunkAt)));
    // The record of the attempt says the same, and the run reads it as a failure of the moment.
    const record = ends.at(-1);
    assert.equal(record.outcome, "failed");
    assert.equal(record.failureKind, "provider");
    assert.equal(record.partialText, partial);
    assert.deepEqual(record.transport, transport);
    assert.equal(record.usageKnown, counted);
    assert.deepEqual(engine.classifyRetry(error), { short: "transient", long: true });
    // A connection that was lost, or a stream that ended early, is a connection problem; a failure the runtime reports has its status, or its words (overloaded), to say what it is.
    const kind = engine.classifyAutopilotError(error).kind;
    if (how === "lost" || how === "ended") assert.equal(kind, "network");
    else assert.ok(["network", "provider"].includes(kind), kind);
  });
}

test("the tail of a stream that was cut says where: the half of an event is there as it came", async () => {
  for (const scenario of ["eof-mid-event", "reset-mid-event"]) {
    const { error } = await call(scenario);
    assert.ok(error.transport.tail.endsWith('"delta":{"content":"tagl'), `${scenario}: ${error.transport.tail}`);
    assert.equal(error.partialText, HALF, "the half event is not part of the text");
  }
  const { error } = await call("error-event");
  assert.match(error.transport.tail, /CUDA error: an illegal memory access/);
  assert.match(error.message, /the provider reported an error during the reply — CUDA error/);
  assert.equal(error.status, 500);
});

test("a connection that dies after the headers and before a word is a failure of the moment too, with nothing to keep", async () => {
  const { error } = await call("reset-after-headers");
  assert.ok(error instanceof engine.AiStreamInterruptedError, error?.message);
  assert.equal(error.how, "lost");
  assert.equal(error.transient, true);
  assert.equal(error.partialText, undefined);
  assert.equal(error.transport.status, 200);
  assert.equal(error.transport.bytes, 0);
  assert.equal(error.transport.end, "reset");
  assert.equal(error.usage, undefined, "no word came: nothing to estimate");
});

test("a stream that dies while the model only reasons keeps the count of what came, and no word of it: not in the text, not in the tail", async () => {
  const { error, ends } = await call("reset-after-reasoning");
  assert.ok(error instanceof engine.AiStreamInterruptedError, error?.message);
  assert.equal(error.partialText, undefined, "the reasoning is never kept");
  assert.equal(error.usageKnown, false);
  assert.ok(error.usage.outputTokens > 100, "but it is counted: the provider ran it");
  assert.ok(error.transport.events >= 200);
  assert.ok(error.transport.tail.length > 0 && error.transport.tail.length <= 300);
  assert.match(error.transport.tail, /"reasoning_content":"…"/, "the framing of the events is there, the words are not");
  assert.ok(!/pensiero/.test(JSON.stringify(ends)), "no word of the reasoning in the record");
  assert.ok(!/pensiero/.test(error.transport.tail));
  assert.equal(engine.classifyAutopilotError(error).detail.transport.tail, error.transport.tail);
});

test("a structured reply that is cut keeps the arguments that had arrived", async () => {
  const { error } = await call("reset-mid-tool-call", { request: structured });
  assert.ok(error instanceof engine.AiStreamInterruptedError, error?.message);
  assert.equal(error.how, "lost");
  assert.equal(error.partialText, '{"ok":true,');
  assert.equal(error.transient, true);
});

test("an invalid request that the runtime reports is final, before the model wrote a word and after it: after it, what had arrived is kept", async () => {
  const early = await call("error-event-bad-request");
  assert.ok(early.error instanceof engine.AiProviderError);
  assert.ok(!(early.error instanceof engine.AiStreamInterruptedError));
  assert.equal(early.error.retryable, false);
  assert.equal(early.error.status, 400);
  assert.equal(early.error.partialText, undefined);

  const late = await call("error-event-bad-request-late");
  assert.ok(!(late.error instanceof engine.AiStreamInterruptedError), "a 400 does not change by asking again");
  assert.equal(late.error.retryable, false);
  assert.equal(late.error.status, 400);
  assert.equal(late.error.partialText, "Il gabbiano ", "but what had arrived is not thrown away");
  assert.equal(late.error.transport.end, "error");
  assert.match(late.error.transport.tail, /maximum context length/);
});

// ─── A reply that is complete but is not used, and keeps what it is ─────────

test("reasoning is counted once when a runtime sends the same words as `reasoning_content` and as `reasoning`, and is never part of the reply", async () => {
  const both = await call("reasoning-both-names");
  assert.equal(both.error, undefined, both.error?.message);
  assert.equal(both.response.text, WORDS_TEXT);
  assert.equal(both.ends.at(-1).reasoningCharacters, "Pensiamo un momento.".length, "once, not twice");
  const one = await call("reasoning-content");
  assert.equal(one.ends.at(-1).reasoningCharacters, "Pensiamo un momento.".length);
  const other = await call("reasoning-field");
  assert.equal(other.ends.at(-1).reasoningCharacters, "Pensiamo un momento.".length);
  // The words are never in a record, and the estimate of a stream that was cut counts them once too.
  assert.ok(!JSON.stringify(both.ends).includes("Pensiamo"));
});

test("a reply cut by the output limit keeps its text and its count: the gateway's output budget ends a stream with `length`", async () => {
  const { error } = await call("output-capped");
  assert.equal(error.truncated, true);
  assert.equal(error.retryable, false);
  assert.equal(error.partialText, WORDS_TEXT);
  assert.deepEqual(error.usage, usage(120, 8192));
  assert.equal(error.usageKnown, true);
  assert.equal(error.transport.finishReason, "length");
  assert.equal(error.transport.end, "done");

  const reasoning = await call("reasoning-only-length");
  assert.equal(reasoning.error.truncated, true);
  assert.equal(reasoning.error.reasoningOnly, true);
  assert.equal(reasoning.error.partialText, undefined);
});

test("an empty reply and a filtered one are what they were", async () => {
  const empty = await call("empty-reply");
  assert.match(empty.error.message, /empty reply/);
  assert.equal(empty.error.retryable, true);
  assert.notEqual(empty.error.transient, true);
  const filtered = await call("finish-content-filter");
  assert.match(filtered.error.message, /filtered/);
  assert.equal(filtered.error.retryable, false);
  assert.equal(filtered.error.partialText, "Il gabbiano ");
});

// ─── What the gateway answers before the first byte ─────────────────────────

const GATEWAY = {
  // [status, retryable, transient, Retry-After in milliseconds]
  "rate-limited": [429, true, true, 7000],
  "token-budget": [429, true, true, 300_000],
  "capacity-exhausted": [503, true, true, 2000],
  "model-not-running": [503, true, true, undefined],
  "lease-lost-before-bytes": [503, true, true, 1000],
  "upstream-unreachable": [502, true, true, undefined],
  "upstream-timeout": [504, true, true, undefined],
  "stream-interrupted-before-bytes": [502, true, true, undefined],
  "bad-output-limit": [400, false, undefined, undefined],
  "unsupported-n": [400, false, undefined, undefined],
  "too-large": [413, false, undefined, undefined],
  "bad-key": [401, false, undefined, undefined],
  "origin-not-allowed": [403, false, undefined, undefined],
  "cloudflare-524": [524, true, true, undefined],
};

for (const [scenario, [status, retryable, transient, retryAfterMs]] of Object.entries(GATEWAY)) {
  test(`the gateway answers ${scenario} (${status}): ${retryable ? (transient ? "retried, as a failure of the moment" : "retried") : "final"}`, async () => {
    const { error, ends, requests } = await call(scenario);
    assert.ok(error instanceof engine.AiProviderError);
    assert.equal(error.status, status);
    assert.equal(error.retryable, retryable);
    assert.equal(error.transient, transient);
    assert.equal(error.retryAfterMs, retryAfterMs);
    assert.equal(error.transport.status, status);
    assert.equal(error.transport.requestId, scenario === "cloudflare-524" ? undefined : REQUEST_ID);
    assert.equal(requests.length, 1, "a refusal is not asked again by the client itself");
    assert.equal(ends.at(-1).status, status);
    assert.equal(ends.at(-1).transport.status, status);
    assert.ok(!error.message.includes(KEY));
  });
}

test("a gateway's own error page is said as what it is, not as its markup", async () => {
  const { error } = await call("cloudflare-524");
  assert.match(error.message, /HTTP 524 — an HTML page from a gateway or a proxy \("llm\.example\.com \| 524: A timeout occurred"\)/);
  assert.doesNotMatch(error.message, /<|DOCTYPE/);
  assert.deepEqual(engine.classifyRetry(error), { short: "transient", long: true });
});

// ─── `stream_options`: asked of every provider, and not asked again of one that refuses it ───

test("a provider that refuses `stream_options` is asked again without it, and its tokens are an estimate", async () => {
  const { response, error, ends, requests } = await call("refuses-usage-option");
  assert.equal(error, undefined, error?.message);
  assert.equal(response.text, WORDS_TEXT);
  assert.equal(response.usageKnown, false);
  assert.equal(requests.length, 2);
  assert.deepEqual(requests[0].body.stream_options, { include_usage: true });
  assert.equal(requests[0].body.stream, true);
  assert.equal("stream_options" in requests[1].body, false, "asked again without it");
  assert.equal(requests[1].body.stream, true, "and still as a stream");
  assert.equal(ends.length, 1, "one call, one attempt: the second request is not a second attempt");
  assert.equal(ends[0].transport.usageRequested, false, "the answered request did not ask for the usage");
  assert.equal(ends[0].transport.usageReceived, false);
  assert.deepEqual({ ...requests[1].body, stream_options: undefined, stream: undefined }, { ...requests[0].body, stream_options: undefined, stream: undefined }, "nothing else of the request changed");
});

test("the refusal is remembered where the host says: the next call of the same address does not ask again", async () => {
  const refusals = new Set();
  const first = await call("refuses-usage-option", { options: { usageOptionRefusals: refusals } });
  assert.equal(first.requests.length, 2);
  assert.equal(refusals.size, 1);
  const second = await call("refuses-usage-option", { options: { usageOptionRefusals: refusals } });
  assert.equal(second.error, undefined);
  assert.equal(second.requests.length, 1, "it went without `stream_options` at once");
  assert.equal("stream_options" in second.requests[0].body, false);
  assert.equal(second.ends[0].transport.usageRequested, false);
  // Another address, or a client with a memory of its own, asks again.
  const other = await call("refuses-usage-option", { options: { usageOptionRefusals: new Set() } });
  assert.equal(other.requests.length, 2);
  // The same client remembers it too, whatever the host gives it.
  const { ai } = clientFor("refuses-usage-option");
  const before = fake.requests.length;
  await ai.complete({ ...ASK, onText: () => undefined });
  await ai.complete({ ...ASK, onText: () => undefined });
  assert.equal(fake.requests.length - before, 3);
});

test("a provider that takes `stream_options` is asked once, with it, and reports its tokens", async () => {
  const { response, requests } = await call("plain", { options: { usageOptionRefusals: new Set() } });
  assert.equal(requests.length, 1);
  assert.deepEqual(requests[0].body.stream_options, { include_usage: true });
  assert.equal(response.usageKnown, true);
});

test("only a refusal that names `stream_options` is taken for one: any other 400 is final, and says where to switch streaming off", async () => {
  const { error, requests } = await call("bad-output-limit");
  assert.equal(requests.length, 1);
  assert.equal(error.status, 400);
  assert.equal(error.retryable, false);
});

// ─── No key in any diagnostic ───────────────────────────────────────────────

test("no credential comes out of a diagnostic: not in the tail, the partial text, the message or the record, however the window cuts it", async () => {
  const { error, ends } = await call("echo-key");
  assert.ok(error instanceof engine.AiStreamInterruptedError, error?.message);
  const everything = JSON.stringify({ error: { message: error.message, partialText: error.partialText, transport: error.transport }, ends });
  assert.ok(!everything.includes(KEY), "the key as it is");
  // No fragment of it either: a window that cuts through a key must not leave the end of it.
  for (let at = 0; at + 8 <= KEY.length; at += 1) assert.ok(!everything.includes(KEY.slice(at, at + 8)), `a fragment of the key: ${KEY.slice(at, at + 8)}`);
  assert.match(error.partialText, /The key is \[redacted\]/);
  assert.ok(error.transport.tail.length <= 300);
  const detail = engine.classifyAutopilotError(error).detail;
  assert.ok(!JSON.stringify(detail).includes(KEY));
  assert.equal(detail.transport.partialCharacters, error.partialText.length);
});

// ─── The detail a run keeps ─────────────────────────────────────────────────

test("a failed call leaves a short, sanitized detail for the run: the numbers, how it ended, the tail, no key and no reply", async () => {
  const { error } = await call("reset-mid-answer");
  const { kind, detail } = engine.classifyAutopilotError(error);
  assert.equal(kind, "network");
  assert.deepEqual(Object.keys(detail.transport).sort(), ["bytes", "chunks", "end", "events", "lastChunkAfterMs", "partialCharacters", "requestId", "silentMs", "status", "tail", "usageReceived", "usageRequested"].sort());
  assert.equal(detail.transport.status, 200);
  assert.equal(detail.transport.end, "reset");
  assert.equal(detail.transport.partialCharacters, HALF.length);
  assert.equal(detail.status, undefined, "the status of the detail is the failure's own, and a cut stream was a 200");
  // It goes through the state's reader as it is, and what a file adds to it is dropped.
  const read = engine.normalizeErrorDetail({ ...detail, transport: { ...detail.transport, tail: `${KEY} ${"z".repeat(500)}`, end: "exploded", bytes: -3, extra: "no", requestId: "bad id with spaces" } });
  assert.equal(read.transport.end, undefined);
  assert.equal(read.transport.bytes, undefined);
  assert.equal(read.transport.requestId, undefined);
  assert.equal(read.transport.extra, undefined);
  assert.ok(read.transport.tail.length <= 300);
  assert.ok(!read.transport.tail.includes(KEY));
  assert.equal(engine.normalizeErrorDetail({ transport: "nothing" }), undefined);
});
