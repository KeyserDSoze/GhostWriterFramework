import test from "node:test";
import assert from "node:assert/strict";
import * as engine from "../dist/index.js";
import { normalizeAttempt } from "../dist/autopilot/attempt.js";
import { MemoryBookStore, createFakeAutopilotAi, seedBookFiles } from "../dist/testing/index.js";
import { ASK, integration, recording } from "./transport-fakes.mjs";

// Which candidate of the route the call of the running step asks now, said while it runs: the `call-attempt` event, which the session and every client merge into the live part
// (`live.trying`) by one rule (`applyLiveAttempt`, with `applyLiveProgress` next to it in live.ts). The attempt survives the text and the numbers of the reply, goes with the call that
// is over, and is replaced by the next attempt of the call (a fallback); it is said whether or not the book keeps records, and it never carries a prompt, a reply or a key.

const { AutopilotSession, MemoryAiCallStore, aiCallIdOf, applyLiveAttempt, applyLiveProgress, createFetchAi, normalizeLive, startLive } = engine;

const ACTIVITY = { id: "activity_concept", runId: "run-1", task: "concept", phase: "concept", title: "Designing the concept of the book", reason: "", next: "", status: "running", startedAt: "2026-11-25T10:00:00.000Z" };
const KEY = "sk-test-SECRET-0123456789";

const trying = (extra = {}) => ({ attempt: 1, attempts: 2, candidateIndex: 0, candidateCount: 2, fallback: false, integrationId: "azure", integrationName: "AzureOpenAi-GW", provider: "azure_openai", model: "gpt-6-luna", thinking: "high", streamMode: "auto", ...extra });
const attemptEvent = (callSeq, extra = {}) => ({ activityId: ACTIVITY.id, ...(callSeq ? { callSeq } : {}), ...trying(extra) });
const FALLBACK = { attempt: 2, candidateIndex: 1, fallback: true, integrationId: "proxy", integrationName: "LlmProxy", provider: "openai", model: "muse-glimmer-30b", thinking: "medium" };
const progress = (callSeq, extra) => ({ activityId: ACTIVITY.id, ...(callSeq ? { callSeq } : {}), ...extra });
const tail = (text) => text.slice(-700);
const JSON_TEXT = JSON.stringify({ logline: "A glassmaker's daughter must expose the harbor's oldest lie before the tide takes the town.", themes: ["truth", "inheritance", "silence"], tone: "Melancholic, tense" });

/** The events of one structured call as the runner says them: its JSON every 350 ms, its numbers every second. */
function alternation(callSeq, { seconds = 6, json = JSON_TEXT } = {}) {
  const events = [];
  const steps = Math.floor((seconds * 1000) / 350);
  let numbers = 1000;
  for (let step = 1; step <= steps; step += 1) {
    const at = step * 350;
    const written = json.slice(0, Math.round((json.length * step) / steps));
    events.push(progress(callSeq, { kind: "json", characters: written.length, preview: tail(written) }));
    if (at >= numbers) {
      numbers += 1000;
      events.push(progress(callSeq, { bytes: written.length * 3, characters: written.length + 24, preview: tail(written) }));
    }
  }
  return events;
}

/** Replays events (a `call-attempt` or a `task-progress`) from `live`, and gives every state the panels would draw from. */
function replay(events, live = startLive(ACTIVITY)) {
  const states = [];
  for (const event of events) {
    live = "model" in event ? applyLiveAttempt(live, event) : applyLiveProgress(live, event);
    states.push(live);
  }
  return states;
}

// ─── The rule: replayed as the events of a real run say it ─────────────────

test("a call that asks a candidate says it: the live part keeps it with the names of the call, and a step that has asked nothing shows nothing", () => {
  const started = startLive(ACTIVITY);
  assert.equal("trying" in started, false, "nothing before the first request");
  const live = applyLiveAttempt(started, { ...attemptEvent(1), callId: "activity_concept-0001" });
  assert.deepEqual(live.trying, trying());
  assert.equal(live.callSeq, 1);
  assert.equal(live.callId, "activity_concept-0001");
  assert.equal(live.characters, 0);
  assert.equal(live.preview, "");
  assert.equal(live.activity, ACTIVITY);
});

test("the attempt stays through ten seconds of a structured reply that alternates its JSON and its numbers, and through the text of a prose call", () => {
  const states = replay([attemptEvent(1), ...alternation(1, { seconds: 10 })]);
  assert.ok(states.length > 25);
  for (const [index, live] of states.entries()) assert.deepEqual(live.trying, trying(), `state ${index}: the attempt is the one said`);
  assert.equal(states.at(-1).json, true);

  const prose = replay([
    attemptEvent(1),
    progress(1, { characters: 60, preview: "The keeper climbed the stairs counting" }),
    progress(1, { characters: 140, preview: "The keeper climbed the stairs counting the steps under his breath" }),
    progress(1, { characters: 0, preview: "" }),
    progress(1, { characters: 30, preview: "The keeper climbed" }),
  ]);
  for (const [index, live] of prose.entries()) assert.deepEqual(live.trying, trying(), `prose state ${index}`);
  assert.deepEqual(prose.map((live) => live.characters), [0, 60, 140, 140, 30], "the text rule is the one it was: the empty text of a new attempt changes nothing");
});

test("a retry shows the new attempt: the call goes on to its fallback, the new attempt replaces the old one, and the text of the one before stays until the new one writes", () => {
  const states = replay([
    attemptEvent(1),
    progress(1, { kind: "json", characters: 40, preview: "{\"logline\": \"A glassmaker's daughter\"" }),
    // The first candidate failed: the client says a new attempt begins, then asks the next candidate.
    progress(1, { kind: "json", characters: 0, preview: "" }),
    attemptEvent(1, FALLBACK),
    progress(1, { kind: "json", characters: 6, preview: "{\"logl" }),
  ]);
  assert.deepEqual(states.map((live) => live.trying.model), ["gpt-6-luna", "gpt-6-luna", "gpt-6-luna", "muse-glimmer-30b", "muse-glimmer-30b"]);
  assert.deepEqual(states.map((live) => live.trying.fallback), [false, false, false, true, true]);
  assert.deepEqual(states.map((live) => `${live.trying.attempt}/${live.trying.attempts}`), ["1/2", "1/2", "1/2", "2/2", "2/2"]);
  assert.deepEqual(states.map((live) => live.preview), ["", "{\"logline\": \"A glassmaker's daughter\"", "{\"logline\": \"A glassmaker's daughter\"", "{\"logline\": \"A glassmaker's daughter\"", "{\"logl"], "the text of the attempt before stays until the new one writes");
  assert.deepEqual(states.at(-1).trying, trying(FALLBACK));
});

test("a new call clears it: the text of the next call, which says no attempt (a host that does not say it, or a text that comes first), shows nothing of the one before", () => {
  const states = replay([
    attemptEvent(1),
    progress(1, { kind: "json", characters: 40, preview: "{\"logline\": \"A glassmaker's daughter\"" }),
    progress(2, { characters: 12, preview: "The keeper" }),
    progress(2, { characters: 40, preview: "The keeper climbed the stairs" }),
  ]);
  assert.ok(states[0].trying && states[1].trying);
  assert.equal(states[2].trying, undefined, "the call before is over, and what it asked with it");
  assert.equal(states[3].trying, undefined);
  assert.deepEqual(states.map((live) => live.callSeq), [1, 1, 2, 2]);
  assert.equal(states[2].preview, "The keeper", "nothing of the call before is shown as the new one's");
});

test("the first attempt of the next call starts that call from nothing and says its candidate: the text of the call before goes with it, and the new call's own text then keeps it", () => {
  const states = replay([
    attemptEvent(1),
    progress(1, { kind: "json", characters: 40, preview: "{\"logline\": \"A glassmaker's daughter\"" }),
    attemptEvent(2, { attempt: 1 }),
    progress(2, { characters: 12, preview: "The keeper" }),
    progress(2, { characters: 90, preview: "The keeper climbed the stairs" }),
  ]);
  assert.deepEqual(states.map((live) => live.callSeq), [1, 1, 2, 2, 2]);
  assert.deepEqual(states.map((live) => live.preview), ["", "{\"logline\": \"A glassmaker's daughter\"", "", "The keeper", "The keeper climbed the stairs"]);
  assert.deepEqual(states.map((live) => live.json === true), [false, true, false, false, false]);
  for (const live of states.slice(2)) assert.deepEqual(live.trying, trying({ attempt: 1 }));
  // The calls are told apart by their record when the book keeps them.
  const named = replay([{ ...attemptEvent(1), callId: "c-1" }, progress(1, { callId: "c-1", characters: 5, preview: "Hello" }), { ...attemptEvent(2), callId: "c-2" }]);
  assert.deepEqual(named.map((live) => [live.callId, live.preview]), [["c-1", ""], ["c-1", "Hello"], ["c-2", ""]]);
});

test("an event of another step, or one that does not say which candidate it is, changes nothing", () => {
  const live = applyLiveAttempt(startLive(ACTIVITY), attemptEvent(1));
  assert.equal(applyLiveAttempt(live, { ...attemptEvent(1, FALLBACK), activityId: "activity_other" }), live);
  assert.equal(applyLiveAttempt(live, { activityId: ACTIVITY.id, callSeq: 1, attempt: 2 }), live, "no model, no integration: nothing to show");
  assert.equal(applyLiveAttempt(live, { ...attemptEvent(1), model: "" }), live);
  assert.equal(applyLiveAttempt(live, { ...attemptEvent(1), candidateIndex: -1 }), live);
});

test("a live part read from elsewhere keeps the attempt it may say: the strings cut, the flag of the fallback from the place of the candidate, and nothing that does not say which candidate it is", () => {
  const kept = normalizeLive({ activity: ACTIVITY, characters: 12, preview: "abc", callSeq: 2, trying: { ...trying(FALLBACK), fallback: false, extra: "dropped", model: "m".repeat(400) } });
  assert.equal(kept.trying.fallback, true, "the place of the candidate says it, not a flag");
  assert.equal(kept.trying.model.length, 160);
  assert.equal("extra" in kept.trying, false);
  assert.equal(normalizeLive({ activity: ACTIVITY, trying: { attempt: 1 } }).trying, undefined);
  assert.equal(normalizeLive({ activity: ACTIVITY, trying: "x" }).trying, undefined);
  assert.equal("trying" in normalizeLive({ activity: ACTIVITY, characters: 1, preview: "" }), false, "a host that does not say it: nothing");
  assert.equal(normalizeAttempt({ ...trying({ attempt: 3, attempts: 1, candidateIndex: 2, candidateCount: 1 }) }).attempts, 3, "the attempt is never past the most the call can make");
  assert.equal(normalizeAttempt({ ...trying({ candidateIndex: 2, candidateCount: 1 }) }).candidateCount, 3);
  assert.equal(normalizeAttempt(trying({ thinking: "minimal" })).thinking, "minimal", "a level this engine does not know is kept: a client says the word");
  assert.equal(normalizeAttempt(trying({ streamMode: "weird" })).streamMode, "auto");
  assert.equal(normalizeAttempt(trying({ integrationName: "" })).integrationName, "azure", "an integration with no name is told by its id");
});

// ─── The client says what it is about to ask ───────────────────────────────

const ALL = ["default"];
const model = (name, extra = {}) => ({ id: name, name, capabilities: ALL, ...extra });
const failing = (status, message) => new Response(JSON.stringify({ error: { message } }), { status, headers: { "content-type": "application/json" } });
const hostOf = (entry) => new URL(entry.url).hostname.replace(".test", "");
const textReply = (text) => Response.json({ choices: [{ message: { content: text }, finish_reason: "stop" }], usage: { prompt_tokens: 20, completion_tokens: 10 } });
const toolReply = (name, value) => Response.json({ choices: [{ message: { tool_calls: [{ id: "c1", type: "function", function: { name, arguments: JSON.stringify(value) } }] }, finish_reason: "tool_calls" }], usage: { prompt_tokens: 20, completion_tokens: 10 } });

/** Alpha (the primary) and Beta (the fallback), in the order of the route. */
function twoModels({ primary = {}, fallback = {}, alpha = {}, beta = {}, ...config } = {}) {
  return {
    aiIntegrations: [
      integration({ id: "a", name: "Alpha", endpoint: "http://a.test/v1", chatModels: [model("alpha-model", primary)], ...alpha }),
      integration({ id: "b", name: "Beta", endpoint: "http://b.test/v1", chatModels: [model("beta-model", fallback)], ...beta }),
    ],
    taskRouting: { autopilot: { primary: { integrationId: "a", model: "alpha-model" }, fallbacks: [{ integrationId: "b", model: "beta-model" }] } },
    ...config,
  };
}

/** The reports of the attempts of one call, in the order they are made. */
async function attemptsOf(config, handlers, ask = ASK) {
  const reports = [];
  const { fetch } = recording((entry) => handlers[hostOf(entry)](entry));
  await createFetchAi(config, { fetch, onAttempt: (attempt) => reports.push(attempt) }).complete(ask).catch(() => undefined);
  return reports;
}

test("the client says which request of the call this is, of how many it can make, and the place of the candidate in a route of how many: the primary that fails, then the fallback", async () => {
  const reports = await attemptsOf(twoModels(), { a: () => failing(404, "The model does not exist."), b: () => textReply("hello") });
  assert.deepEqual(reports.map((report) => [report.integrationName, report.model, report.index, report.candidates, report.attempt, report.attempts]), [
    ["Alpha", "alpha-model", 0, 2, 1, 2],
    ["Beta", "beta-model", 1, 2, 2, 2],
  ]);
});

test("a primary that the plan leaves out (its context window cannot hold the prompt) makes the fallback the first request, and the report says so: the fallback, request 1 of 1, in a route of 2", async () => {
  const config = twoModels({ primary: { maxInputTokens: 1000 } });
  const reports = await attemptsOf(config, { a: () => failing(500, "never asked"), b: () => textReply("hello") }, { ...ASK, user: "word ".repeat(2000) });
  assert.deepEqual(reports.map((report) => [report.integrationName, report.index, report.candidates, report.attempt, report.attempts]), [["Beta", 1, 2, 1, 1]]);
});

test("the report says the thinking of the request in three words: the level that is sent, automatic when none is chosen, not sent when the model does not take the one that was", async () => {
  const modes = async (config) => (await attemptsOf(config, { a: () => textReply("ok"), b: () => textReply("ok") })).map((report) => [report.thinkingMode, report.thinking]);
  assert.deepEqual(await modes(twoModels({ alpha: { thinking: "high" } })), [["high", "high"]], "the integration's level");
  assert.deepEqual(await modes(twoModels()), [["automatic", undefined]], "none chosen");
  assert.deepEqual(await modes(twoModels({ alpha: { thinking: "automatic" } })), [["automatic", undefined]], "automatic is a choice, and nothing is sent");
  assert.deepEqual(await modes(twoModels({ alpha: { thinking: "high" }, primary: { supportsReasoning: false } })), [["not-sent", undefined]], "a model declared as not reasoning");
  assert.deepEqual(await modes(twoModels({ alpha: { thinking: "low" }, primary: { reasoningParameter: "none" } })), [["not-sent", undefined]], "a thinking parameter that is none");
  assert.deepEqual(await modes(twoModels({ alpha: { thinking: "xhigh" }, primary: { reasoningParameter: "chat_template_kwargs.reasoning_strength" } })), [["xhigh", "xhigh"]], "a level that goes as the argument of the template is sent");
  const route = twoModels({ alpha: { thinking: "high" }, taskRouting: { autopilot: { primary: { integrationId: "a", model: "alpha-model", thinking: "low" } } } });
  assert.deepEqual(await modes(route), [["low", "low"]], "a route target's own level wins over its integration's");
});

test("the name of an integration is said as the author wrote it, cleaned of the credentials of the configuration", async () => {
  const config = twoModels({ alpha: { name: `Alpha ${KEY}`, apiKey: KEY } });
  const [report] = await attemptsOf(config, { a: () => textReply("ok"), b: () => textReply("ok") });
  assert.ok(!report.integrationName.includes(KEY));
  assert.ok(report.integrationName.startsWith("Alpha"));
});

// ─── Through the real client, runner and session ────────────────────────────

const CAPABILITIES = ["autopilot", "director", "reader-evaluation", "reader-evaluation-summary", "review", "simple-tasks"];
const FAST = { readers: false, readersOnPlan: false, specialists: false, pauseAfterPlan: false };
const BOOK = { brief: { idea: "A harbor town.", targetChapters: 1, scenesPerChapter: 1, wordsPerScene: 300 }, options: FAST };

/** A route of Alpha then Beta for every capability the run asks with. */
function routedConfig({ alpha = {}, beta = {}, primary = {}, fallback = {} } = {}) {
  const route = { primary: { integrationId: "a", model: "alpha-model" }, fallbacks: [{ integrationId: "b", model: "beta-model" }] };
  return {
    ...twoModels({ alpha: { name: "Alpha", apiKey: KEY, streamMode: "off", thinking: "high", ...alpha }, beta: { name: "Beta", apiKey: KEY, ...beta }, primary, fallback }),
    taskRouting: Object.fromEntries(CAPABILITIES.map((capability) => [capability, route])),
  };
}

/**
 * The real client behind the real runner: the fake AI of the autopilot says what each call must answer, and the real `createFetchAi` asks a fake `fetch` for it, so that the attempts, their
 * reports and the events they become are the ones a real run has. `onRequest(host, body, live)` sees the live part of the session at the moment each request is sent.
 */
function routedRun({ config, alphaFails = false, onRequest, records = false, steps = 6 } = {}) {
  const base = createFakeAutopilotAi({ reviewVerdict: () => "approve", scenes: 1, words: 200 });
  let reply = null;
  let session = null;
  const asked = [];
  const { fetch } = recording(async (entry) => {
    const host = hostOf(entry);
    const live = (await session.snapshot()).live;
    asked.push({ host, model: entry.body.model, live });
    await onRequest?.(host, entry.body, live);
    if (host === "a" && alphaFails) return failing(404, "The model `alpha-model` does not exist or you do not have access to it.");
    const tool = entry.body.tools?.[0]?.function?.name;
    return tool ? toolReply(tool, reply.json) : textReply(reply.text);
  });
  const client = createFetchAi(config, { fetch });
  const ai = {
    calls: base.calls,
    async complete(request) {
      reply = await base.complete({ ...request, onText: undefined, onProgress: undefined, onStructuredText: undefined });
      return client.complete(request);
    },
  };
  const store = new MemoryBookStore(seedBookFiles({ chapters: 1 }));
  session = new AutopilotSession({ bookId: "book", store, ai, host: "server", hostLabel: "test", retryDelayMs: 0, ...(records ? { calls: new MemoryAiCallStore(), callsSecrets: () => [KEY] } : {}) });
  const events = [];
  session.subscribe((event) => events.push(event));
  const run = async () => {
    await session.start({ ...BOOK, limits: { steps } });
    await session.waitForIdle();
    return { events, asked, session, attempts: events.filter((event) => event.type === "call-attempt") };
  };
  return { run, session, events, asked, calls: base.calls };
}

test("through the client, the runner and the session: the primary that fails at once and then the fallback, said in that order, and snapshot().live says the candidate being asked at every request of the run", async () => {
  const { run } = routedRun({ config: routedConfig(), alphaFails: true });
  const { attempts, asked, events } = await run();
  assert.ok(attempts.length >= 4 && attempts.length % 2 === 0, `${attempts.length} attempts: two for each call`);
  for (let at = 0; at < attempts.length; at += 2) {
    const [first, second] = [attempts[at], attempts[at + 1]];
    assert.deepEqual([first.integrationName, first.model, first.candidateIndex, first.candidateCount, first.fallback, first.attempt, first.attempts], ["Alpha", "alpha-model", 0, 2, false, 1, 2]);
    assert.deepEqual([second.integrationName, second.model, second.candidateIndex, second.candidateCount, second.fallback, second.attempt, second.attempts], ["Beta", "beta-model", 1, 2, true, 2, 2]);
    assert.equal(first.callSeq, second.callSeq, "both attempts are of the same call");
    assert.equal(first.activityId, second.activityId);
    assert.deepEqual([first.thinking, first.streamMode, first.provider], ["high", "off", "openai"]);
    assert.deepEqual([second.thinking, second.streamMode], ["automatic", "auto"]);
  }
  assert.ok(attempts.some((event) => event.callSeq === 1) && attempts.some((event) => event.callSeq === 2), "the calls of a step are numbered from 1: a step that asks twice says call 1, then call 2");

  // What a client that connects at any moment of the run shows: at each request, the candidate that is being asked.
  assert.equal(asked.length, attempts.length);
  for (const [index, request] of asked.entries()) {
    const wanted = attempts[index];
    assert.ok(request.live?.trying, `request ${index}: the live part says what is asked`);
    assert.equal(request.live.trying.model, request.model, `request ${index}: the model asked is the model said`);
    assert.equal(request.live.trying.integrationName, wanted.integrationName);
    assert.equal(request.live.trying.fallback, request.host === "b");
    assert.equal(request.live.callSeq, wanted.callSeq);
  }
  assert.ok(events.filter((event) => event.type === "task-finished").length >= 3, "the run went on to the end of its steps, the fallback answering each call");
});

test("the attempt is said when the book keeps no records, and with them it names its call as the call events do; the events are kept for a client that connects later", async () => {
  const bare = await routedRun({ config: routedConfig() }).run();
  assert.ok(bare.attempts.length >= 3);
  assert.ok(bare.attempts.every((event) => event.callId === undefined && event.callSeq >= 1), "no records, no callId; callSeq always");
  assert.ok(bare.attempts.every((event) => event.fallback === false && event.attempt === 1 && event.model === "alpha-model"), "the primary answers: only the primary is asked");
  assert.equal(bare.events.some((event) => event.type === "call-started"), false);
  assert.ok(bare.session.recentEvents(0).some((event) => event.type === "call-attempt"), "kept in the replay of the session");

  const kept = await routedRun({ config: routedConfig(), alphaFails: true, records: true }).run();
  const started = kept.events.filter((event) => event.type === "call-started");
  assert.ok(started.length >= 3);
  for (const event of kept.attempts) {
    const call = started.find((entry) => entry.callId === event.callId);
    assert.ok(call, "the attempt names a call that started");
    assert.equal(call.activityId, event.activityId);
    assert.equal(event.callId, aiCallIdOf(event.activityId, event.callSeq), "the id of the call is the number of the call in its step");
  }
});

test("a call that asks the primary and gets its answer is said as the primary with the level it asked, and a new call of the step says its own attempt: nothing of the one before", async () => {
  const seen = [];
  const { run } = routedRun({ config: routedConfig(), onRequest: (_host, _body, live) => seen.push(live) });
  const { attempts } = await run();
  assert.deepEqual([...new Set(attempts.map((event) => `${event.fallback}:${event.thinking}:${event.attempt}`))], ["false:high:1"]);
  const byCall = new Map();
  for (const live of seen) byCall.set(`${live.activity.id}:${live.callSeq}`, live.trying);
  assert.ok(byCall.size >= 3, "several calls were asked");
  for (const trying of byCall.values()) assert.equal(trying.model, "alpha-model");
});

test("the events say names and numbers only: never a prompt, a reply, a key or the endpoint", async () => {
  const { run, calls } = routedRun({ config: routedConfig(), alphaFails: true, records: true });
  const { attempts, events } = await run();
  const allowed = new Set(["type", "bookId", "at", "seq", "activityId", "callId", "callSeq", "attempt", "attempts", "candidateIndex", "candidateCount", "fallback", "integrationId", "integrationName", "provider", "model", "thinking", "streamMode"]);
  assert.ok(attempts.length > 0);
  for (const event of attempts) {
    for (const key of Object.keys(event)) assert.ok(allowed.has(key), `no ${key} in a call-attempt`);
    const text = JSON.stringify(event);
    assert.ok(!text.includes(KEY), "no key");
    assert.ok(!text.includes("a.test") && !text.includes("b.test"), "no endpoint");
  }
  const everything = JSON.stringify(events.filter((event) => event.type === "call-attempt"));
  assert.ok(calls.length >= 3);
  for (const request of calls) for (const prompt of [request.system, request.user]) assert.ok(!everything.includes(prompt.slice(0, 60)), "no prompt");
});

test("a host whose AI reports an attempt without saying which candidate it is (an older client) says nothing: the run goes on, and the live part shows nothing", async () => {
  const base = createFakeAutopilotAi({ reviewVerdict: () => "approve", scenes: 1, words: 200 });
  const ai = {
    calls: base.calls,
    async complete(request) {
      request.onAttempt?.({ attemptId: "x", label: request.label, capability: request.capability, provider: "fake", model: "fake-model", integrationId: "fake", index: 0, messages: [], endpoint: null, stream: false, tools: false, timeoutMs: 1000, timeouts: { startMs: 1000, idleMs: 1000, capMs: 1000 }, streamMode: "auto", toolsOnly: true });
      return base.complete(request);
    },
  };
  const store = new MemoryBookStore(seedBookFiles({ chapters: 1 }));
  const session = new AutopilotSession({ bookId: "book", store, ai, host: "server", hostLabel: "test", retryDelayMs: 0 });
  const events = [];
  session.subscribe((event) => events.push(event));
  await session.start({ ...BOOK, limits: { steps: 1 } });
  await session.waitForIdle();
  assert.equal(events.some((event) => event.type === "call-attempt"), false);
  assert.ok(events.some((event) => event.type === "task-finished" && event.activity.status === "succeeded"));
  assert.equal((await session.snapshot()).live, null);
});

test("snapshot().live carries the attempt while the call is in flight and nothing once the step is over, so that a client that connects mid-step shows it at once", async () => {
  let release = null;
  const gate = new Promise((resolve) => { release = resolve; });
  let arrived = null;
  const reached = new Promise((resolve) => { arrived = resolve; });
  const { run, session } = routedRun({
    config: routedConfig(),
    alphaFails: true,
    steps: 1,
    onRequest: async (host) => {
      if (host !== "b") return;
      arrived();
      await gate;
    },
  });
  const finished = run();
  await reached;
  const live = (await session.snapshot()).live;
  assert.ok(live, "a step runs");
  assert.deepEqual([live.trying.integrationName, live.trying.model, live.trying.fallback, live.trying.attempt, live.trying.attempts, live.trying.candidateCount], ["Beta", "beta-model", true, 2, 2, 2]);
  assert.equal(live.callSeq, 1);
  // A client that connects now reads it as it reads any live part from a host.
  assert.deepEqual(normalizeLive(JSON.parse(JSON.stringify(live))).trying, live.trying);
  release();
  await finished;
  assert.equal((await session.snapshot()).live, null, "the step is over: nothing is in flight");
});
