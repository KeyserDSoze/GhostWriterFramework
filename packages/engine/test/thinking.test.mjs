import test from "node:test";
import assert from "node:assert/strict";
import * as engine from "../dist/index.js";
import { MemoryBookStore, seedBookFiles } from "../dist/testing/index.js";
import { ASK, SCHEMA, integration, recording } from "./transport-fakes.mjs";

const { AiProviderError, AutopilotSession, buildChatRequest, createFetchAi, parseAutopilotState, pickAiRuntimeConfig, redactAiRuntimeConfig, resolveAiCandidates } = engine;

const LEVELS = ["low", "medium", "high", "xhigh"];
const ALL = ["automatic", ...LEVELS];

const reply = (text = "Hi") => Response.json({ choices: [{ message: { content: text }, finish_reason: "stop" }] });
const failing = (status, error) => new Response(JSON.stringify({ error }), { status, headers: { "content-type": "application/json" } });
const hostOf = (entry) => new URL(entry.url).hostname.replace(".test", "");

/** Two integrations in route order, `a` and `b`, each with one model; `extra` sets integration fields and the route. */
function config({ a = {}, b = {}, taskRouting } = {}) {
  return {
    aiIntegrations: [
      integration({ id: "a", name: "Alpha", endpoint: "http://a.test/v1", chatModels: [{ id: "a1", name: "alpha-model", capabilities: ["default"] }], ...a }),
      integration({ id: "b", name: "Beta", endpoint: "http://b.test/v1", chatModels: [{ id: "b1", name: "beta-model", capabilities: ["default"] }], ...b }),
    ],
    ...(taskRouting ? { taskRouting } : {}),
  };
}

const PRIMARY = { integrationId: "a", model: "alpha-model" };
const FALLBACK = { integrationId: "b", model: "beta-model" };

// ─── The configuration ──────────────────────────────────────────────────────

test("the thinking of an integration is one of the five levels; anything else is left out, and absent means nothing was chosen", () => {
  for (const level of ALL) assert.equal(pickAiRuntimeConfig(config({ a: { thinking: level } })).aiIntegrations[0].thinking, level, level);
  for (const garbage of ["max", "LOW", "High", "", "minimal", null, 0, 1, true, {}, []]) assert.equal("thinking" in pickAiRuntimeConfig(config({ a: { thinking: garbage } })).aiIntegrations[0], false, JSON.stringify(garbage));
  assert.equal("thinking" in pickAiRuntimeConfig(config()).aiIntegrations[0], false);
  assert.equal(typeof engine.AI_THINKING_LEVELS?.length, "number", "the closed list is exported for the screens that offer it");
  assert.deepEqual([...engine.AI_THINKING_LEVELS], ALL);
});

test("the thinking of a route target is read for the primary and every fallback, a bad value is dropped and the target is kept", () => {
  const picked = pickAiRuntimeConfig({
    ...config({ a: { thinking: "high" } }),
    taskRouting: {
      autopilot: { primary: { ...PRIMARY, thinking: "low" }, fallbacks: [{ ...FALLBACK, thinking: "xhigh" }, { ...PRIMARY, thinking: "bogus" }, { ...FALLBACK }] },
      director: { primary: { ...PRIMARY, thinking: "automatic" } },
    },
  });
  const route = picked.taskRouting.autopilot;
  assert.deepEqual(route.primary, { ...PRIMARY, thinking: "low" });
  assert.deepEqual(route.fallbacks, [{ ...FALLBACK, thinking: "xhigh" }, { ...PRIMARY }, { ...FALLBACK }]);
  assert.equal("thinking" in route.fallbacks[1], false);
  assert.equal(picked.taskRouting.director.primary.thinking, "automatic");
  assert.equal(picked.aiIntegrations[0].thinking, "high");
  assert.deepEqual(pickAiRuntimeConfig(JSON.parse(JSON.stringify(picked))), picked, "picking again changes nothing: what a server saves is what it reads");
});

test("the safe view shows the thinking of integrations and of route targets, and still no key", () => {
  const picked = pickAiRuntimeConfig({
    ...config({ a: { thinking: "medium" } }),
    taskRouting: { autopilot: { primary: { ...PRIMARY, thinking: "low" }, fallbacks: [{ ...FALLBACK }] } },
  });
  const view = redactAiRuntimeConfig(picked);
  assert.equal(view.integrations[0].thinking, "medium");
  assert.equal("thinking" in view.integrations[1], false);
  assert.deepEqual(view.taskRouting.autopilot, { primary: { ...PRIMARY, thinking: "low" }, fallbacks: [{ ...FALLBACK }] });
  assert.deepEqual(view.routedTasks, ["autopilot"]);
  assert.equal(JSON.stringify(view).includes("sk-test-SECRET"), false);
  assert.deepEqual(redactAiRuntimeConfig(pickAiRuntimeConfig(config())).taskRouting, {}, "no route, nothing to show");
});

// ─── The candidate carries it: the target's, else the integration's ─────────

test("a candidate's thinking is its route target's, else its integration's: the target wins, and automatic is a choice", () => {
  const cfg = pickAiRuntimeConfig({
    ...config({ a: { thinking: "high" }, b: { thinking: "automatic" } }),
    taskRouting: {
      autopilot: { primary: { ...PRIMARY, thinking: "low" }, fallbacks: [{ ...FALLBACK, thinking: "xhigh" }] },
      director: { primary: { ...PRIMARY }, fallbacks: [{ ...FALLBACK }] },
      review: { primary: { ...PRIMARY, thinking: "automatic" }, fallbacks: [] },
    },
  });
  assert.deepEqual(resolveAiCandidates(cfg, "autopilot").map((candidate) => candidate.thinking), ["low", "xhigh"], "the targets' own");
  assert.deepEqual(resolveAiCandidates(cfg, "director").map((candidate) => candidate.thinking), ["high", "automatic"], "inherited from the integrations, automatic included");
  assert.deepEqual(resolveAiCandidates(cfg, "review").map((candidate) => candidate.thinking), ["automatic"], "a target's automatic beats the integration's high");
});

test("without an explicit route the integration's thinking is the candidate's, and a candidate with none has no thinking at all", () => {
  const cfg = pickAiRuntimeConfig(config({ a: { thinking: "medium" } }));
  const candidates = resolveAiCandidates(cfg, "autopilot");
  assert.deepEqual(candidates.map((candidate) => [candidate.model, candidate.thinking]), [["alpha-model", "medium"], ["beta-model", undefined]]);
  assert.equal("thinking" in candidates[1], false, "no key: a candidate is as it was");
  const plain = resolveAiCandidates(pickAiRuntimeConfig(config()), "autopilot");
  assert.ok(plain.every((candidate) => !("thinking" in candidate)));
});

// ─── The request ────────────────────────────────────────────────────────────

const candidateOf = (provider, extra = {}, integrationExtra = {}) => ({ integration: { id: "i", name: "I", provider, apiKey: "k", ...(provider === "azure_openai" ? { endpoint: "https://r.openai.azure.com", apiVersion: "2024-10-21" } : {}), ...integrationExtra }, model: provider === "azure_openai" ? "deploy-1" : "m", ...extra });

test("reasoning_effort is sent for low, medium, high and xhigh, and for nothing else: automatic and an absent level send nothing", () => {
  for (const provider of ["openai", "azure_openai", "github_models"]) {
    const base = buildChatRequest(candidateOf(provider), { system: "S", user: "U", json: SCHEMA });
    assert.equal("reasoning_effort" in base.body, false, `${provider}: nothing chosen`);
    for (const level of ALL) {
      const built = buildChatRequest(candidateOf(provider, { thinking: level }), { system: "S", user: "U", json: SCHEMA });
      if (level === "automatic") {
        assert.deepEqual(built.body, base.body, `${provider}: automatic sends nothing`);
      } else {
        assert.equal(built.body.reasoning_effort, level, `${provider} ${level}`);
        const { reasoning_effort: _sent, ...rest } = built.body;
        assert.deepEqual(rest, base.body, `${provider} ${level}: nothing else in the body moves`);
      }
    }
  }
});

test("the candidate's level is the one sent; a hand-made candidate with only an integration level still sends it, and an invalid level sends nothing", () => {
  const send = (candidate) => buildChatRequest(candidate, { system: "S", user: "U" }).body.reasoning_effort;
  assert.equal(send(candidateOf("openai", { thinking: "low" }, { thinking: "high" })), "low", "the candidate's, resolved from its target, beats the integration's");
  assert.equal(send(candidateOf("openai", { thinking: "automatic" }, { thinking: "high" })), undefined, "automatic: not even when the integration has a level");
  assert.equal(send(candidateOf("openai", {}, { thinking: "medium" })), "medium", "a candidate that did not resolve it falls back to its integration");
  assert.equal(send(candidateOf("openai", {}, { thinking: "automatic" })), undefined);
  assert.equal(send(candidateOf("openai", { thinking: "max" })), undefined, "a level the engine does not know is never sent");
  assert.equal(send(candidateOf("openai", { thinking: null })), undefined);
});

test("the level is sent with a prose request and with a streamed or non streamed one alike, and a reasoning model keeps its other parameters", () => {
  const prose = buildChatRequest(candidateOf("openai", { thinking: "high" }), { system: "S", user: "U", maxOutputTokens: 500 });
  assert.equal(prose.body.reasoning_effort, "high");
  assert.equal(prose.body.max_tokens, 500);
  const off = buildChatRequest(candidateOf("openai", { thinking: "high" }, { streamMode: "off" }), { system: "S", user: "U" });
  assert.equal(off.body.reasoning_effort, "high");
  assert.equal("stream" in off.body, false);
  const reasoningModel = buildChatRequest({ ...candidateOf("openai", { thinking: "xhigh" }), model: "o3-mini" }, { system: "S", user: "U", maxOutputTokens: 500 });
  assert.equal(reasoningModel.body.reasoning_effort, "xhigh");
  assert.equal(typeof reasoningModel.body.max_completion_tokens, "number");
});

test("through the client: the level on the wire is the target's or the integration's, the attempt says which was sent, and a call without one says nothing", async () => {
  const cfg = pickAiRuntimeConfig({
    ...config({ a: { thinking: "high" } }),
    taskRouting: { director: { primary: { ...PRIMARY, thinking: "low" } }, review: { primary: { ...PRIMARY, thinking: "automatic" } }, autopilot: { primary: { ...PRIMARY } } },
  });
  const attempts = [];
  const { fetch, calls } = recording(() => reply());
  const ai = createFetchAi(cfg, { fetch, onAttempt: (attempt) => attempts.push(attempt) });
  for (const capability of ["director", "review", "autopilot"]) await ai.complete({ ...ASK, capability });
  assert.deepEqual(calls.map((entry) => entry.body.reasoning_effort), ["low", undefined, "high"]);
  assert.deepEqual(attempts.map((attempt) => attempt.thinking), ["low", undefined, "high"]);
  assert.equal("thinking" in attempts[1], false, "nothing was sent: the attempt carries no level");

  const none = [];
  await createFetchAi(config(), { fetch: async () => reply(), onAttempt: (attempt) => none.push(attempt) }).complete(ASK);
  assert.equal("thinking" in none[0], false);
});

test("a fallback has its own level: the primary's is not carried over to it", async () => {
  const cfg = pickAiRuntimeConfig({ ...config(), taskRouting: { autopilot: { primary: { ...PRIMARY, thinking: "high" }, fallbacks: [{ ...FALLBACK }] } } });
  const { fetch, calls } = recording((entry) => (hostOf(entry) === "a" ? failing(500, { message: "down" }) : reply("Second.")));
  const response = await createFetchAi(cfg, { fetch }).complete(ASK);
  assert.equal(response.text, "Second.");
  assert.deepEqual(calls.map((entry) => [hostOf(entry), entry.body.reasoning_effort]), [["a", "high"], ["b", undefined]]);
});

// ─── A provider that does not accept it ─────────────────────────────────────

const WITH_LEVEL = pickAiRuntimeConfig({ aiIntegrations: [integration({ thinking: "high" })] });
const rejected = (error, extra = {}) => createFetchAi(WITH_LEVEL, { fetch: async () => failing(extra.status ?? 400, error) }).complete(ASK).then(() => null, (failure) => failure);

test("a 400 about reasoning_effort is a permanent error that names the setting and keeps what the provider said", async () => {
  for (const message of [
    "Unrecognized request argument supplied: reasoning_effort",
    "Unsupported parameter: 'reasoning_effort' is not supported with this model.",
    "reasoning effort is not supported by this endpoint",
  ]) {
    const error = await rejected({ message });
    assert.ok(error instanceof AiProviderError, String(error));
    assert.equal(error.status, 400);
    assert.equal(error.retryable, false, message);
    assert.notEqual(error.transient, true);
    assert.match(error.message, /^openai muse-glimmer-30b: the model does not accept a thinking level/);
    assert.match(error.message, /set thinking to "Automatic" for this task/i);
    assert.match(error.message, /integration "LlmProxy"/);
    assert.match(error.message, /HTTP 400/, "what the provider said is still there");
    assert.ok(error.message.includes(message.slice(0, 20)), message);
  }
});

test("the provider may only name the parameter in its error object, and a 422 says the same as a 400", async () => {
  const byParam = await rejected({ message: "Invalid value: 'xhigh'. Supported values are: 'low', 'medium', and 'high'.", param: "reasoning_effort", code: "unsupported_value" });
  assert.match(byParam.message, /does not accept a thinking level/);
  assert.equal(byParam.retryable, false);
  const unprocessable = await rejected({ message: "unknown field reasoning_effort" }, { status: 422 });
  assert.match(unprocessable.message, /does not accept a thinking level/);
  assert.equal(unprocessable.retryable, false);
});

test("a 400 about something else is the plain error it was, and so is any error when no level was sent", async () => {
  const other = await rejected({ message: "max_tokens is too large" });
  assert.doesNotMatch(other.message, /thinking level/);
  assert.match(other.message, /HTTP 400 — max_tokens is too large/);
  const echoed = await rejected({ message: "max_tokens is too large", param: "max_tokens", request: { model: "m", reasoning_effort: "high", max_tokens: 99_999 } });
  assert.doesNotMatch(echoed.message, /thinking level/, "a provider that echoes the request is not refusing the level: what it names is the message and the parameter");
  const noLevel = await createFetchAi(config(), { fetch: async () => failing(400, { message: "Unrecognized request argument supplied: reasoning_effort" }) }).complete(ASK).then(() => null, (failure) => failure);
  assert.doesNotMatch(noLevel.message, /thinking level/, "the setting is automatic: it is not the one to blame");
  const automatic = await createFetchAi(pickAiRuntimeConfig({ aiIntegrations: [integration({ thinking: "automatic" })] }), { fetch: async () => failing(400, { message: "reasoning_effort is not supported" }) }).complete(ASK).then(() => null, (failure) => failure);
  assert.doesNotMatch(automatic.message, /thinking level/);
  const server = await rejected({ message: "reasoning_effort exploded" }, { status: 500 });
  assert.doesNotMatch(server.message, /thinking level/, "a server error is not a refusal of the parameter");
  assert.equal(server.retryable, true);
});

test("when a model refuses its level the next candidate is tried, and it need not have a level", async () => {
  const cfg = pickAiRuntimeConfig({ ...config(), taskRouting: { autopilot: { primary: { ...PRIMARY, thinking: "xhigh" }, fallbacks: [{ ...FALLBACK }] } } });
  const { fetch, calls } = recording((entry) => (hostOf(entry) === "a" ? failing(400, { message: "Unrecognized request argument supplied: reasoning_effort" }) : reply("Answered.")));
  const response = await createFetchAi(cfg, { fetch }).complete(ASK);
  assert.equal(response.text, "Answered.");
  assert.deepEqual(calls.map((entry) => [hostOf(entry), entry.body.reasoning_effort]), [["a", "xhigh"], ["b", undefined]]);
});

test("a run whose model refuses its level stops at once, once, saying what to change", async () => {
  const { fetch, calls } = recording(() => failing(400, { message: "Unrecognized request argument supplied: reasoning_effort" }));
  const ai = createFetchAi(WITH_LEVEL, { fetch });
  const store = new MemoryBookStore(seedBookFiles({ chapters: 1 }));
  const events = [];
  const session = new AutopilotSession({ bookId: "book", store, ai, host: "server", hostLabel: "test", retryDelayMs: 0 });
  session.subscribe((event) => events.push(event));
  await session.start({ brief: { idea: "x", targetChapters: 1, scenesPerChapter: 1, wordsPerScene: 300 }, options: { readers: false, readersOnPlan: false, pauseAfterPlan: false } });
  await session.waitForIdle();
  const state = parseAutopilotState(store.files.get("autopilot/state.json"));
  assert.equal(state.status, "error");
  assert.match(state.lastError.message, /does not accept a thinking level/);
  assert.equal(state.lastError.errorKind, "provider");
  assert.equal(state.lastError.errorDetail.status, 400);
  assert.equal(calls.length, 1, "the provider was asked once: a permanent error is not repeated");
  assert.equal(events.some((event) => event.type === "insight" && event.code === "failureRetry"), false);
  assert.equal(calls[0].body.reasoning_effort, "high");
});
