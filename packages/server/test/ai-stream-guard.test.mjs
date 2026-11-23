import test, { after, before } from "node:test";
import assert from "node:assert/strict";
import { AiStreamInterruptedError, classifyRetry, createFetchAi } from "narrarium-engine";
import * as testing from "../dist/testing.mjs";
import { WORDS_TEXT, startFakeLlmProxy } from "../../engine/test/llmproxy-fake.mjs";

// The fake LlmProxy of the engine's tests (a real HTTP server that says what LlmProxy's source says), called through the server's outbound guard: the `fetch` that the published server
// wears (`installOutboundNetwork`, on node:http, which limits the connection and nothing after it). The engine's client must give the same outcomes through it as through Node's own `fetch`
// (undici): the same text, the same typed failure with what had arrived and what the transport saw, the same retries. Node's `fetch` cuts a body that is silent for 300 s whatever the engine's idle
// limit says (measured: `BodyTimeoutError` at 300.9 s on Node 22 and 24); the guard does not, and these tests show that it is the engine's idle limit that decides.

const KEY = "sk-test-SECRET-0123456789";
const ASK = { capability: "autopilot", label: "t", system: "SYS", user: "USR", onText: () => undefined };

let fake;
let restore;
const undici = globalThis.fetch;

before(async () => {
  fake = await startFakeLlmProxy({ gap: 100 });
});
after(async () => {
  restore?.();
  await fake.close();
});

function clientFor(scenario, extra = {}) {
  const ends = [];
  const integration = { id: "p", name: "LlmProxy", provider: "openai", endpoint: fake.base(scenario), apiKey: KEY, chatModels: [{ id: "m", name: "muse-glimmer-30b", capabilities: ["default"] }], idleTimeoutMs: 5000, requestTimeoutMs: 5000, ...extra };
  return { ai: createFetchAi({ aiIntegrations: [integration] }, { minimumTimeoutMs: 1, onAttemptEnd: (end) => ends.push(end) }), ends };
}

/** What a call comes to, in the words a person compares: the same call through two `fetch`es must come to the same. */
async function summary(scenario, extra = {}) {
  const { ai, ends } = clientFor(scenario, extra);
  const before = fake.requests.length;
  try {
    const response = await ai.complete(ASK);
    return { ok: true, text: response.text, usage: response.usage, usageKnown: response.usageKnown, requests: fake.requests.length - before, end: ends.at(-1).transport?.end };
  } catch (error) {
    return {
      ok: false,
      name: error.name,
      how: error.how,
      message: error.message,
      status: error.status,
      retryable: error.retryable,
      transient: error.transient,
      retryAfterMs: error.retryAfterMs,
      partialText: error.partialText,
      usageKnown: error.usageKnown,
      timedOut: error.timedOut,
      retry: classifyRetry(error),
      transport: error.transport && { status: error.transport.status, end: error.transport.end, usageReceived: error.transport.usageReceived, usageRequested: error.transport.usageRequested, finishReason: error.transport.finishReason, requestId: error.transport.requestId, hasBytes: error.transport.bytes > 0, hasTail: Boolean(error.transport.tail) },
      requests: fake.requests.length - before,
    };
  }
}

const SCENARIOS = [
  "plain", "cr-only", "awkward-chunks", "one-byte-chunks", "comments", "eof-after-finish-no-done",
  "reset-mid-answer", "drop-mid-answer", "reset-mid-event", "reset-after-headers", "reset-mid-tool-call", "eof-mid-answer", "eof-mid-event",
  "error-event", "error-event-named", "error-event-in-choice", "finish-abort", "finish-unknown",
  "output-capped", "empty-reply", "rate-limited", "capacity-exhausted", "bad-key", "cloudflare-524", "refuses-usage-option",
];

test("the guard and Node's fetch give the engine's client the same outcome for every case, with the typed failure and what the transport saw", async () => {
  const through = {};
  for (const scenario of SCENARIOS) through[scenario] = await summary(scenario);
  restore = testing.installOutboundNetwork(() => [fake.origin]);
  assert.notEqual(globalThis.fetch, undici, "the guard is what `fetch` is now");
  for (const scenario of SCENARIOS) {
    const guarded = await summary(scenario);
    assert.deepEqual(guarded, through[scenario], scenario);
  }
  // And they are what they should be.
  assert.equal(through.plain.ok, true);
  assert.equal(through["reset-mid-answer"].name, "AiStreamInterruptedError");
  assert.equal(through["reset-mid-answer"].how, "lost");
  assert.equal(through["reset-mid-answer"].partialText, "Il gabbiano è già ");
  assert.equal(through["reset-after-headers"].how, "lost");
  assert.equal(through["refuses-usage-option"].requests, 2);
});

test("a stream that goes quiet is cut by the engine's idle limit and by nothing else: with what had arrived, and as a failure of the moment", async () => {
  assert.notEqual(globalThis.fetch, undici);
  const { ai } = clientFor("dead-silence", { idleTimeoutMs: 400 });
  const started = Date.now();
  const error = await ai.complete(ASK).then(() => null, (failure) => failure);
  assert.equal(error.timedOut, true);
  assert.equal(error.timeout.phase, "idle");
  assert.ok(Date.now() - started < 3000);
  assert.equal(error.partialText, "Il gabbiano è già volato ");
  assert.equal(error.transient, true);
  assert.equal(error.transport.end, "timeout");
});

test("a stream that is slow but alive is never cut, and a pause shorter than the idle limit is nothing", async () => {
  const slow = await summary("slow-steady", { idleTimeoutMs: 1000 });
  assert.equal(slow.ok, true);
  const pause = await summary("pause-in-the-middle", { idleTimeoutMs: 1500 });
  assert.equal(pause.ok, true);
  assert.equal(pause.text, "Prima parte. Seconda parte.");
  const comments = await summary("keep-alive-comments", { idleTimeoutMs: 600 });
  assert.equal(comments.ok, true);
  assert.equal(comments.text, WORDS_TEXT);
});

test("a cut stream through the guard carries no key in anything it keeps", async () => {
  const { ai, ends } = clientFor("echo-key");
  const error = await ai.complete(ASK).then(() => null, (failure) => failure);
  assert.ok(error instanceof AiStreamInterruptedError, error?.message);
  const everything = JSON.stringify({ message: error.message, partialText: error.partialText, transport: error.transport, ends });
  assert.ok(!everything.includes(KEY));
  for (let at = 0; at + 8 <= KEY.length; at += 1) assert.ok(!everything.includes(KEY.slice(at, at + 8)), `a fragment of the key: ${KEY.slice(at, at + 8)}`);
  assert.match(error.partialText, /The key is \[redacted\]/);
});
