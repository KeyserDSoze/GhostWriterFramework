import test, { after, before } from "node:test";
import assert from "node:assert/strict";
import * as engine from "../dist/index.js";
import { MemoryBookStore, createFakeAutopilotAi, seedBookFiles } from "../dist/testing/index.js";
import { WORDS_TEXT, startFakeLlmProxy } from "./llmproxy-fake.mjs";

// What the run does with a stream that was cut: it is a failure of the moment, so it is repeated as one (the same words twice do not stop it), the
// failed calls are counted as the estimates they are, and what the transport saw is kept in the run's own record, with no key in it.

const KEY = "sk-test-SECRET-0123456789";
const { AiProviderError, AiStreamInterruptedError, AutopilotSession, createFetchAi } = engine;
const ONE_SCENE = { brief: { idea: "x", targetChapters: 1, scenesPerChapter: 1, wordsPerScene: 300 }, options: { readers: false, readersOnPlan: false, pauseAfterPlan: false } };

let fake;
before(async () => {
  fake = await startFakeLlmProxy({ gap: 100 });
});
after(async () => {
  await fake.close();
});

const clientFor = (scenario, extra = {}) => createFetchAi(
  { aiIntegrations: [{ id: "p", name: "LlmProxy", provider: "openai", endpoint: fake.base(scenario), apiKey: KEY, chatModels: [{ id: "m", name: "muse-glimmer-30b", capabilities: ["default"] }], ...extra }] },
  { minimumTimeoutMs: 1 },
);

/** The error the client really gives for a scenario. */
async function errorOf(scenario) {
  const error = await clientFor(scenario).complete({ capability: "autopilot", label: "t", system: "s", user: "u", onText: () => undefined }).then(() => null, (failure) => failure);
  assert.ok(error instanceof AiStreamInterruptedError, `${scenario}: ${error?.message}`);
  return error;
}

function reply(json) {
  return { text: JSON.stringify(json), json, usage: { inputTokens: 100, outputTokens: 50, cachedInputTokens: 0 }, model: "fake-model", provider: "fake", cost: 0.001, currency: "USD" };
}

/** The fake AI with the replies to one label replaced: `script(request, seen)` returns undefined (the default reply), an error to throw or a response. */
function scripted(script) {
  const base = createFakeAutopilotAi();
  return {
    calls: base.calls,
    async complete(request) {
      const seen = base.calls.filter((call) => call.label === request.label).length;
      const custom = script(request, seen);
      if (custom === undefined) return base.complete(request);
      base.calls.push(request);
      if (custom instanceof Error) throw custom;
      return custom;
    },
  };
}

async function run(ai) {
  const store = new MemoryBookStore(seedBookFiles({ chapters: 1 }));
  const emitted = [];
  const session = new AutopilotSession({ bookId: "book", store, ai, host: "server", hostLabel: "test", retryDelayMs: 20, random: () => 0.5 });
  session.subscribe((event) => emitted.push(event));
  await session.start(ONE_SCENE);
  await session.waitForIdle();
  return { state: (await session.snapshot()).state, events: emitted, store };
}

const retriesOf = (emitted) => emitted.filter((event) => event.type === "insight" && event.code === "failureRetry");
const concepts = (ai) => ai.calls.filter((call) => call.label === "autopilot:concept");

test("a stream that is cut is repeated like any failure of the moment: the same words twice do not stop the run", async () => {
  const cut = await errorOf("reset-mid-answer");
  const ai = scripted((request, seen) => (request.label === "autopilot:concept" && seen < 3 ? cut : undefined));
  const { state, events } = await run(ai);
  assert.equal(state.status, "completed", state.lastError?.message);
  assert.equal(concepts(ai).length, 4, "three failures with the same message, and the fourth call answered");
  assert.equal(retriesOf(events).length, 3);
});

test("the failures the runtime reports in a stream, and its aborts, are repeated the same way", async () => {
  for (const scenario of ["error-event", "finish-abort", "eof-mid-answer", "error-event-in-choice"]) {
    const cut = await errorOf(scenario);
    const ai = scripted((request, seen) => (request.label === "autopilot:concept" && seen < 2 ? cut : undefined));
    const { state } = await run(ai);
    assert.equal(state.status, "completed", `${scenario}: ${state.lastError?.message}`);
    assert.equal(concepts(ai).length, 3, scenario);
  }
});

test("a failure before the model wrote a word keeps its rule: the same deterministic failure twice stops the run", async () => {
  const stuck = scripted((request) => (request.label === "autopilot:concept" ? new AiProviderError("openai m: the provider reported an error during the reply — context too long", 500, true) : undefined));
  const { state } = await run(stuck);
  assert.equal(state.status, "error");
  assert.equal(concepts(stuck).length, 2);
});

test("a stream that is cut every time ends the run after three retries, with the transport's record in the state and no key anywhere", async () => {
  const before = fake.requests.length;
  const { state, store } = await run(clientFor("reset-mid-answer"));
  assert.equal(state.status, "error");
  assert.equal(fake.requests.length - before, 4, "the first call and three retries, the structured request of the concept each time");
  const last = state.lastError;
  assert.equal(last.errorKind, "network");
  assert.match(last.message, /the connection with the provider was lost while it was answering/);
  const transport = last.errorDetail.transport;
  assert.equal(transport.status, 200);
  assert.equal(transport.end, "reset");
  assert.ok(transport.bytes > 0 && transport.chunks > 0 && transport.events > 0);
  assert.equal(transport.usageReceived, false);
  assert.equal(transport.usageRequested, true);
  assert.equal(transport.requestId, "0b7f0a52-6f0e-4a9e-9d57-7e8b3c0d7a11");
  assert.ok(transport.partialCharacters > 0);
  assert.ok(transport.tail.length > 0 && transport.tail.length <= 300);
  // Every failed step of the run carries the same record, the retried ones included, and the files hold no key.
  const { activities } = await engine.readStoredAutopilot(store);
  const failed = activities.filter((activity) => activity.status === "failed");
  assert.equal(failed.length, 4);
  assert.ok(failed.every((activity) => activity.errorDetail?.transport?.end === "reset" && activity.errorDetail.transport.status === 200));
  assert.ok(!JSON.stringify(state).includes(KEY), "no key in the state");
  assert.ok(!JSON.stringify(activities).includes(KEY), "no key in the activity log");
  // The four calls that were cut are counted, and counted as the estimates they are: this is what «calls without token count» is.
  assert.equal(state.stats.aiCalls, 4);
  assert.equal(state.stats.usageUnknownCalls, 4);
  assert.ok(state.stats.outputTokens > 0, "what the model wrote before the cut was counted");
});

test("a server that fails twice and then answers is a call that works: the cut ones are retried by the client's caller, not hidden by it", async () => {
  const before = fake.requests.length;
  const ai = clientFor("reset-twice-then-ok");
  const request = { capability: "autopilot", label: "t", system: "s", user: "u", onText: () => undefined };
  const first = await ai.complete(request).then(() => null, (failure) => failure);
  assert.ok(first instanceof AiStreamInterruptedError);
  const second = await ai.complete(request).then(() => null, (failure) => failure);
  assert.ok(second instanceof AiStreamInterruptedError);
  assert.equal(first.message, second.message, "the same words twice, as the runner sees them");
  const third = await ai.complete(request);
  assert.equal(third.text, WORDS_TEXT);
  assert.equal(fake.requests.length - before, 3);
});
