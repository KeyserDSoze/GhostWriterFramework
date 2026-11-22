import test from "node:test";
import assert from "node:assert/strict";
import * as engine from "../dist/index.js";
import { MemoryBookStore, createFakeAutopilotAi, seedBookFiles } from "../dist/testing/index.js";

const { AiProviderError, AutopilotSession, createFetchAi, pickAiRuntimeConfig } = engine;

const SCHEMA = { name: "result", description: "A result", parameters: { type: "object", properties: { ok: { type: "boolean" } }, required: ["ok"] } };

const encoder = new TextEncoder();
function sse(chunks) {
  return new ReadableStream({
    start(controller) {
      for (const chunk of chunks) controller.enqueue(encoder.encode(chunk));
      controller.close();
    },
  });
}
const events = (chunks) => new Response(sse(chunks), { status: 200, headers: { "content-type": "text/event-stream" } });
const data = (value) => `data: ${typeof value === "string" ? value : JSON.stringify(value)}\n\n`;
const DONE = "data: [DONE]\n\n";

const ok = (text = "ok", usage) => Response.json({ choices: [{ message: { content: text }, finish_reason: "stop" }], ...(usage ? { usage } : {}) });
const toolReply = (value) => Response.json({ choices: [{ message: { tool_calls: [{ function: { arguments: JSON.stringify(value) } }] }, finish_reason: "tool_calls" }] });
const fail = (status, message = "failed", headers = {}) => new Response(JSON.stringify({ error: { message } }), { status, headers: { "content-type": "application/json", ...headers } });

function integration(id, extra = {}) {
  return { id, name: id.toUpperCase(), provider: "openai", endpoint: `http://${id}.test/v1`, apiKey: `key-${id}`, chatModels: [{ id: `m-${id}`, name: `model-${id}`, capabilities: ["default"] }], ...extra };
}

/** A fetch that answers by host: `handlers.local(call)`, and records every call. */
function byHost(handlers) {
  const calls = [];
  const fetch = async (url, init) => {
    const call = { url: String(url), host: new URL(url).hostname, body: init?.body ? JSON.parse(init.body) : undefined, init };
    calls.push(call);
    const handler = handlers[call.host.replace(".test", "")];
    if (!handler) throw new Error(`unexpected host ${call.host}`);
    return handler(call);
  };
  return { fetch, calls };
}

const ASK = { capability: "autopilot", label: "t", system: "SYS", user: "USR" };

// ─── M1: one request builder ────────────────────────────────────────────────

const PROVIDERS = [
  {
    name: "openai with a custom endpoint",
    integration: { provider: "openai", endpoint: "http://localhost:1234/v1/", apiKey: "k" },
    url: () => "http://localhost:1234/v1/chat/completions",
    auth: { authorization: "Bearer k" },
  },
  {
    name: "openai default endpoint",
    integration: { provider: "openai", apiKey: "k" },
    url: () => "https://api.openai.com/v1/chat/completions",
    auth: { authorization: "Bearer k" },
  },
  {
    name: "azure deployments route",
    azure: true,
    integration: { provider: "azure_openai", endpoint: "https://res.openai.azure.com/", apiKey: "k", apiVersion: "2024-10-21" },
    url: (model) => `https://res.openai.azure.com/openai/deployments/${model}/chat/completions?api-version=2024-10-21`,
    auth: { "api-key": "k" },
  },
  {
    name: "azure /openai/v1",
    azure: true,
    integration: { provider: "azure_openai", endpoint: "https://res.openai.azure.com/openai/v1/", apiKey: "k" },
    url: () => "https://res.openai.azure.com/openai/v1/chat/completions",
    auth: { "api-key": "k" },
  },
  {
    name: "github models",
    integration: { provider: "github_models", apiKey: "k" },
    url: () => "https://models.github.ai/inference/chat/completions",
    auth: { authorization: "Bearer k" },
  },
];

const FAMILIES = [
  { name: "normal", model: "gpt-4o", limit: "max_tokens", temperature: true, margin: 0 },
  { name: "reasoning", model: "o3-mini", limit: "max_completion_tokens", temperature: false, margin: 12_000 },
];

// Streaming no longer depends on the request: `streamMode: "auto"` (the default) streams every request, the forced function
// included, and "off" never does. So the matrix has a `streamMode` dimension, and whether a listener is given no longer matters.
test("buildChatRequest: golden matrix of provider × model family × text/json × listener × streamMode", () => {
  assert.equal(typeof engine.buildChatRequest, "function", "exported");
  let cases = 0;
  for (const provider of PROVIDERS) {
    for (const family of FAMILIES) {
      for (const kind of ["text", "json"]) {
        for (const listener of [false, true]) {
          for (const streamMode of ["auto", "off"]) {
            const model = provider.azure ? "deploy-1" : family.model;
            const candidate = { integration: { id: "i", name: "I", ...provider.integration, ...(streamMode === "off" ? { streamMode } : {}) }, model, underlyingModel: provider.azure ? family.model : undefined };
            const request = { system: "SYS", user: "USR", maxOutputTokens: 1000, temperature: 0.4, ...(kind === "json" ? { json: SCHEMA } : {}), ...(listener ? { onText: () => undefined } : {}) };
            const built = engine.buildChatRequest(candidate, request);
            const label = `${provider.name} / ${family.name} / ${kind} / ${listener ? "listener" : "no listener"} / ${streamMode}`;
            const streamed = streamMode === "auto";
            const limit = (kind === "json" ? 4096 : 1000) + family.margin;
            assert.deepEqual(built.body, {
              model,
              messages: [{ role: "system", content: "SYS" }, { role: "user", content: "USR" }],
              [family.limit]: limit,
              ...(family.temperature ? { temperature: 0.4 } : {}),
              ...(kind === "json" ? { tools: [{ type: "function", function: SCHEMA }], tool_choice: "required" } : {}),
              ...(streamed ? { stream: true, stream_options: { include_usage: true } } : {}),
            }, label);
            assert.equal(built.url, provider.url(model), label);
            assert.deepEqual(built.headers, { "content-type": "application/json", accept: streamed ? "text/event-stream" : "application/json", ...provider.auth }, label);
            assert.equal(built.stream, streamed, label);
            assert.equal(built.useTools, kind === "json", label);
            cases += 1;
          }
        }
      }
    }
  }
  assert.equal(cases, 80);
});

test("buildChatRequest: a model without tools gets the JSON instruction in the system prompt, a key-less endpoint no auth, a proxy origin for GitHub Models", () => {
  const noTools = engine.buildChatRequest({ integration: { id: "i", name: "I", provider: "openai", endpoint: "http://x.test/v1", apiKey: "" }, model: "m", supportsToolCalls: false }, { system: "SYS", user: "USR", json: SCHEMA });
  assert.equal(noTools.useTools, false);
  assert.equal("tools" in noTools.body, false);
  assert.equal("tool_choice" in noTools.body, false);
  assert.match(noTools.body.messages[0].content, /^SYS\n\nReply with ONLY one JSON object/);
  assert.match(noTools.body.messages[0].content, /"ok"/);
  assert.deepEqual(noTools.headers, { "content-type": "application/json", accept: "text/event-stream" }, "a structured request streams too, so it accepts events");

  const proxied = engine.buildChatRequest({ integration: { id: "i", name: "I", provider: "github_models", apiKey: "k" }, model: "openai/gpt-4o" }, ASK, { githubModelsBaseUrl: "https://proxy.example/" });
  assert.equal(proxied.url, "https://proxy.example/inference/chat/completions");

  const azureOld = engine.buildChatRequest({ integration: { id: "i", name: "I", provider: "azure_openai", endpoint: "https://r.openai.azure.com", apiKey: "k", apiVersion: "2024-02-15-preview" }, model: "dep" }, { ...ASK, json: SCHEMA });
  assert.deepEqual(azureOld.body.tool_choice, { type: "function", function: { name: "result" } }, "named tool_choice before 2024-06-01");
});

test("buildChatRequest is pure: the same input gives the same output and nothing is shared", () => {
  const candidate = { integration: { id: "i", name: "I", provider: "openai", apiKey: "k" }, model: "gpt-4o" };
  const request = { ...ASK, json: SCHEMA, maxOutputTokens: 300 };
  const first = engine.buildChatRequest(candidate, request);
  const second = engine.buildChatRequest(candidate, request);
  assert.deepEqual(first, second);
  first.body.messages.push({ role: "user", content: "mutated" });
  assert.equal(engine.buildChatRequest(candidate, request).body.messages.length, 2);
});

test("createFetchAi sends exactly what buildChatRequest builds", async () => {
  const seen = [];
  const fetch = async (url, init) => {
    seen.push({ url: String(url), headers: init.headers, body: JSON.parse(init.body) });
    return ok("fine");
  };
  const cfg = pickAiRuntimeConfig({ aiIntegrations: [integration("a", { apiKey: "secret" })] });
  await createFetchAi(cfg, { fetch }).complete({ ...ASK, maxOutputTokens: 700, temperature: 0.6 });
  const candidate = engine.resolveAiCandidates(cfg, "autopilot")[0];
  const built = engine.buildChatRequest(candidate, { ...ASK, maxOutputTokens: 700, temperature: 0.6 });
  assert.deepEqual(seen[0], { url: built.url, headers: built.headers, body: built.body });
});

// ─── B20: Azure without underlyingModel ─────────────────────────────────────

test("Azure without an underlying model always sends an output limit: the deployment name decides, else the API version", () => {
  const limit = (model, apiVersion, underlyingModel) => engine.completionTokenLimit("azure_openai", model, 500, underlyingModel, apiVersion);
  assert.deepEqual(limit("prod-chat", "2024-10-21"), { max_completion_tokens: 500 }, "unknown identity, API >= 2024-09");
  assert.deepEqual(limit("prod-chat", "2024-09-01-preview"), { max_completion_tokens: 500 });
  assert.deepEqual(limit("prod-chat", "2024-06-01"), { max_tokens: 500 }, "unknown identity, older API");
  assert.deepEqual(limit("prod-chat", undefined), { max_completion_tokens: 500 }, "the engine's default API version is 2024-10-21");
  assert.deepEqual(limit("prod-chat", "v1"), { max_completion_tokens: 500 }, "the /openai/v1 API is newer than 2024-09");
  assert.deepEqual(limit("team-o3-mini", "2024-06-01"), { max_completion_tokens: 500 }, "a reasoning model named by the deployment");
  assert.deepEqual(limit("gpt-5-main", "2024-06-01"), { max_completion_tokens: 500 });
  assert.deepEqual(limit("anything", "2024-10-21", "gpt-4o"), { max_tokens: 500 }, "a declared classic model keeps max_tokens");
  assert.deepEqual(limit("anything", "2024-10-21", "o4-mini"), { max_completion_tokens: 500 });
  assert.deepEqual(engine.completionTokenLimit("openai", "gpt-4o", 500), { max_tokens: 500 }, "other providers are unchanged");
  assert.deepEqual(engine.completionTokenLimit("azure_openai", "prod-chat", 0, undefined, "2024-10-21"), {});
});

test("an Azure request for an unknown deployment carries an output limit", async () => {
  let body;
  const fetch = async (_url, init) => {
    body = JSON.parse(init.body);
    return ok();
  };
  const cfg = pickAiRuntimeConfig({ aiIntegrations: [{ id: "az", name: "Az", provider: "azure_openai", endpoint: "https://r.openai.azure.com", apiKey: "k", chatModels: [{ id: "1", name: "prod-chat", capabilities: ["default"] }] }] });
  await createFetchAi(cfg, { fetch }).complete({ ...ASK, maxOutputTokens: 900 });
  assert.equal(body.max_completion_tokens, 900);
  assert.equal("max_tokens" in body, false);
});

// ─── B21: wire format ───────────────────────────────────────────────────────

function oneModel(fetch, extra = {}) {
  return createFetchAi(pickAiRuntimeConfig({ aiIntegrations: [integration("a", { chatModels: [{ id: "1", name: "m", capabilities: ["default"], pricing: { inputPerMTok: 1, outputPerMTok: 2 } }] })], ...extra }), { fetch });
}

test("an event whose data spans several lines is joined with a newline", async () => {
  const fetch = async () => events([
    "data: {\"choices\":[{\"delta\":\ndata: {\"content\":\"Hello\"}}]}\n\n",
    data({ choices: [{ delta: {}, finish_reason: "stop" }] }),
    data({ choices: [], usage: { prompt_tokens: 3, completion_tokens: 1 } }),
    DONE,
  ]);
  const seen = [];
  const response = await oneModel(fetch).complete({ ...ASK, onText: (text) => seen.push(text) });
  assert.equal(response.text, "Hello");
  assert.equal(seen.at(-1), "Hello");
});

test("events without a blank line between them, and a data line followed by [DONE], still work", async () => {
  const fetch = async () => events([
    `data: ${JSON.stringify({ choices: [{ delta: { content: "A" } }] })}\n`,
    `data: ${JSON.stringify({ choices: [{ delta: { content: "B" }, finish_reason: "stop" }] })}\ndata: [DONE]\n`,
  ]);
  const response = await oneModel(fetch).complete({ ...ASK, onText: () => undefined });
  assert.equal(response.text, "AB");
});

test("a JSON reply to a streaming request (a server that ignores `stream`) is read as the reply", async () => {
  const fetch = async () => ok("Whole reply.", { prompt_tokens: 12, completion_tokens: 4 });
  const seen = [];
  const response = await oneModel(fetch).complete({ ...ASK, onText: (text) => seen.push(text) });
  assert.equal(response.text, "Whole reply.");
  assert.deepEqual(response.usage, { inputTokens: 12, outputTokens: 4, cachedInputTokens: 0 });
  assert.equal(seen.at(-1), "Whole reply.", "the reply still reaches the progress listener");
});

test("HTTP 200 with an error in the body is a provider error, retryable unless it says authentication or invalid request", async () => {
  const body = (payload) => async () => Response.json(payload);
  const transient = await oneModel(body({ error: { message: "Rate limit reached", code: 429 } })).complete(ASK).then(() => null, (error) => error);
  assert.ok(transient instanceof AiProviderError);
  assert.match(transient.message, /Rate limit reached/);
  assert.equal(transient.status, 429);
  assert.equal(transient.retryable, true);

  const permanent = await oneModel(body({ error: { message: "Incorrect API key provided", type: "invalid_request_error", code: "invalid_api_key" } })).complete(ASK).then(() => null, (error) => error);
  assert.ok(permanent instanceof AiProviderError);
  assert.match(permanent.message, /Incorrect API key/);
  assert.equal(permanent.retryable, false);

  const plain = await oneModel(body({ error: "model overloaded" })).complete(ASK).then(() => null, (error) => error);
  assert.match(plain.message, /model overloaded/);
  assert.equal(plain.retryable, true);

  const fine = await oneModel(async () => Response.json({ choices: [{ message: { content: "fine" }, finish_reason: "stop" }], error: null })).complete(ASK);
  assert.equal(fine.text, "fine", "a null error is no error");
});

// ─── M1: hooks ──────────────────────────────────────────────────────────────

test("onAttempt carries the effective request; onAttemptEnd reports the outcome, usage, cost, text and duration of every attempt", async () => {
  const attempts = [];
  const ends = [];
  const { fetch } = byHost({
    a: () => fail(503, "overloaded"),
    b: () => ok("Second wins.", { prompt_tokens: 100, completion_tokens: 10, prompt_tokens_details: { cached_tokens: 40 } }),
  });
  const cfg = pickAiRuntimeConfig({
    aiIntegrations: [
      integration("a", { chatModels: [{ id: "1", name: "first", capabilities: ["default"] }] }),
      integration("b", { chatModels: [{ id: "2", name: "second", capabilities: ["default"], pricing: { inputPerMTok: 1, cachedPerMTok: 0.5, outputPerMTok: 2 } }] }),
    ],
    costCurrency: "EUR",
  });
  const ai = createFetchAi(cfg, { fetch, onAttempt: (attempt) => attempts.push(attempt), onAttemptEnd: (end) => ends.push(end) });
  const response = await ai.complete({ ...ASK, maxOutputTokens: 300, temperature: 0.2 });
  assert.equal(response.text, "Second wins.");

  assert.equal(attempts.length, 2);
  assert.equal(ends.length, 2);
  assert.deepEqual(attempts.map((attempt) => [attempt.integrationId, attempt.model, attempt.index]), [["a", "first", 0], ["b", "second", 1]]);
  assert.deepEqual(attempts[0].messages, [{ role: "system", content: "SYS" }, { role: "user", content: "USR" }]);
  assert.equal(attempts[0].maxOutputTokens, 300);
  assert.equal(attempts[0].stream, true, "every chat request streams unless the integration's streamMode is off");
  assert.equal(attempts[0].tools, false);
  assert.equal(attempts[0].endpoint, "http://a.test/v1");
  assert.equal(typeof attempts[0].attemptId, "string");
  assert.notEqual(attempts[0].attemptId, attempts[1].attemptId);

  assert.deepEqual(ends.map((end) => end.attemptId), attempts.map((attempt) => attempt.attemptId), "each end carries its attempt's id");
  assert.equal(ends[0].outcome, "failed");
  assert.match(ends[0].error, /HTTP 503/);
  assert.equal(ends[0].status, 503);
  assert.equal(ends[0].failureKind, "provider");
  assert.equal(ends[0].usageKnown, false);
  assert.equal(typeof ends[0].durationMs, "number");
  assert.ok(ends[0].durationMs >= 0);
  assert.equal(ends[1].outcome, "ok");
  assert.equal(ends[1].text, "Second wins.");
  assert.deepEqual(ends[1].usage, { inputTokens: 100, outputTokens: 10, cachedInputTokens: 40 });
  assert.equal(ends[1].usageKnown, true);
  assert.equal(ends[1].costKnown, true);
  assert.equal(ends[1].cost, (60 * 1 + 40 * 0.5 + 10 * 2) / 1_000_000);
  assert.equal(ends[1].currency, "EUR");
});

test("with Tools only off the attempt shows the JSON instruction a model without tools receives, and a failed attempt still reports what it cost", async () => {
  const attempts = [];
  const ends = [];
  const fetch = async () => Response.json({ choices: [{ message: { content: "cut" }, finish_reason: "length" }], usage: { prompt_tokens: 500, completion_tokens: 40 } });
  const cfg = pickAiRuntimeConfig({ aiToolsOnly: false, aiIntegrations: [integration("a", { chatModels: [{ id: "1", name: "m", capabilities: ["default"], supportsToolCalls: false, pricing: { inputPerMTok: 1, outputPerMTok: 2 } }] })] });
  const error = await createFetchAi(cfg, { fetch, onAttempt: (attempt) => attempts.push(attempt), onAttemptEnd: (end) => ends.push(end) }).complete({ ...ASK, json: SCHEMA }).then(() => null, (failure) => failure);
  assert.equal(error.truncated, true);
  assert.match(attempts[0].messages[0].content, /Reply with ONLY one JSON object/);
  assert.equal(attempts[0].tools, false);
  assert.equal(ends[0].outcome, "failed");
  assert.deepEqual(ends[0].usage, { inputTokens: 500, outputTokens: 40, cachedInputTokens: 0 });
  assert.equal(ends[0].cost, (500 * 1 + 40 * 2) / 1_000_000);
});

test("an aborted attempt ends as cancelled and a timed out one as a timeout", async () => {
  const ends = [];
  const hang = (_url, init) => new Promise((_resolve, reject) => init.signal.addEventListener("abort", () => reject(init.signal.reason), { once: true }));
  const controller = new AbortController();
  // A timeout under 30 s is raised to 30 s when a call is made: these tests lower the minimum to count in milliseconds.
  const cfg = pickAiRuntimeConfig({ aiIntegrations: [integration("a", { requestTimeoutMs: 5000 })] });
  const pending = createFetchAi(cfg, { fetch: hang, minimumTimeoutMs: 1, onAttemptEnd: (end) => ends.push(end) }).complete({ ...ASK, signal: controller.signal }).then(() => null, (error) => error);
  setTimeout(() => controller.abort(), 20);
  const aborted = await pending;
  assert.equal(aborted.name, "AbortError");
  assert.equal(ends[0].outcome, "cancelled");
  assert.equal(ends[0].failureKind, "cancelled");

  const slow = pickAiRuntimeConfig({ aiIntegrations: [integration("a", { requestTimeoutMs: 30 })] });
  const timedOut = await createFetchAi(slow, { fetch: hang, minimumTimeoutMs: 1, onAttemptEnd: (end) => ends.push(end) }).complete(ASK).then(() => null, (error) => error);
  assert.ok(timedOut instanceof AiProviderError);
  assert.match(timedOut.message, /the provider did not start answering within 30 ms/, "the message says which deadline ran out");
  assert.equal(timedOut.retryable, true);
  assert.equal(ends[1].outcome, "failed");
  assert.equal(ends[1].failureKind, "timeout");
  assert.equal(ends[1].timeoutMs, 30);
});

test("a listener cannot change what is sent", async () => {
  let sentBody;
  const cfg = pickAiRuntimeConfig({ aiIntegrations: [integration("a")] });
  const ai = createFetchAi(cfg, {
    fetch: async (_url, init) => (sentBody = JSON.parse(init.body), ok("fine")),
    onAttempt: (attempt) => {
      attempt.messages[1].content = "TAMPERED";
      attempt.messages.push({ role: "user", content: "extra" });
    },
  });
  await ai.complete(ASK);
  assert.deepEqual(sentBody.messages, [{ role: "system", content: "SYS" }, { role: "user", content: "USR" }]);
});

test("a hook that throws never breaks the call", async () => {
  const cfg = pickAiRuntimeConfig({ aiIntegrations: [integration("a")] });
  const ai = createFetchAi(cfg, {
    fetch: async () => ok("fine"),
    onAttempt: () => {
      throw new Error("listener bug");
    },
    onAttemptEnd: () => {
      throw new Error("listener bug");
    },
  });
  assert.equal((await ai.complete(ASK)).text, "fine");
});

test("the default request timeout is the engine's 600 s for every host, and an integration or the host can change it", async () => {
  assert.equal(engine.DEFAULT_REQUEST_TIMEOUT_MS, 600_000);
  const timeouts = [];
  const attempt = (cfg, options = {}) => createFetchAi(cfg, { fetch: async () => ok(), onAttempt: (info) => timeouts.push(info.timeoutMs), ...options }).complete(ASK);
  await attempt(pickAiRuntimeConfig({ aiIntegrations: [integration("a")] }));
  await attempt(pickAiRuntimeConfig({ aiIntegrations: [integration("a", { requestTimeoutMs: 45_000 })] }));
  await attempt(pickAiRuntimeConfig({ aiIntegrations: [integration("a")] }), { defaultTimeoutMs: 90_000 });
  assert.deepEqual(timeouts, [600_000, 45_000, 90_000]);
});

// ─── M3: the routing policy reaches every host ──────────────────────────────

test("pickAiRuntimeConfig carries the privacy policy and the routing limits with the site's normalization and defaults", () => {
  const full = pickAiRuntimeConfig({
    aiIntegrations: [],
    fallbackDisclosure: { sameBoundaryOnly: true, requireAcknowledgement: false },
    routingExecution: { maxCandidates: 99, maxTotalDurationMs: 5, maxTokenAttempts: 10, maxEstimatedCost: 0 },
  });
  assert.deepEqual(full.fallbackDisclosure, { sameBoundaryOnly: true, requireAcknowledgement: false });
  assert.deepEqual(full.routingExecution, { maxCandidates: 8, maxTotalDurationMs: 1_000, maxTokenAttempts: 1_000, maxEstimatedCost: 0.01 });
  assert.equal(full.maxCandidates, 8, "the older top-level field keeps working");

  const wide = pickAiRuntimeConfig({ aiIntegrations: [], routingExecution: { maxCandidates: 2.7, maxTotalDurationMs: 9_999_999, maxTokenAttempts: 99_999_999, maxEstimatedCost: 99_999 } });
  assert.deepEqual(wide.routingExecution, { maxCandidates: 2, maxTotalDurationMs: 600_000, maxTokenAttempts: 2_000_000, maxEstimatedCost: 1_000 });

  const defaults = pickAiRuntimeConfig({ aiIntegrations: [], routingExecution: {}, fallbackDisclosure: {} });
  assert.deepEqual(defaults.routingExecution, { maxCandidates: 4, maxTotalDurationMs: 180_000, maxTokenAttempts: 200_000, maxEstimatedCost: 5 });
  assert.deepEqual(defaults.fallbackDisclosure, { sameBoundaryOnly: false, requireAcknowledgement: false });
  assert.deepEqual(engine.DEFAULT_ROUTING_EXECUTION, { maxCandidates: 4, maxTotalDurationMs: 180_000, maxTokenAttempts: 200_000, maxEstimatedCost: 5 });

  const garbage = pickAiRuntimeConfig({ aiIntegrations: [], routingExecution: { maxCandidates: "many", maxTotalDurationMs: null, maxTokenAttempts: Number.NaN }, fallbackDisclosure: { sameBoundaryOnly: "yes", requireAcknowledgement: 1 } });
  assert.deepEqual(garbage.routingExecution, { maxCandidates: 4, maxTotalDurationMs: 180_000, maxTokenAttempts: 200_000, maxEstimatedCost: 5 });
  assert.deepEqual(garbage.fallbackDisclosure, { sameBoundaryOnly: false, requireAcknowledgement: false });

  assert.deepEqual(pickAiRuntimeConfig(full), full, "picking again changes nothing (a server stores and reloads it)");
});

test("a configuration without the new fields keeps today's behavior: no policy, no total limits", () => {
  const legacy = pickAiRuntimeConfig({ aiIntegrations: [integration("a")], maxCandidates: 6 });
  assert.equal(legacy.fallbackDisclosure, undefined);
  assert.equal(legacy.routingExecution, undefined);
  assert.equal(legacy.maxCandidates, 6);
  assert.equal(pickAiRuntimeConfig({}).routingExecution, undefined);
  const redacted = engine.redactAiRuntimeConfig(pickAiRuntimeConfig({ aiIntegrations: [integration("a")], fallbackDisclosure: { sameBoundaryOnly: true }, routingExecution: {} }));
  assert.deepEqual(redacted.fallbackDisclosure, { sameBoundaryOnly: true, requireAcknowledgement: false });
  assert.equal(redacted.routingExecution.maxCandidates, 4);
  assert.equal(JSON.stringify(redacted).includes("key-a"), false);
});

function twoAccounts(extra = {}, handlers = {}) {
  const cfg = pickAiRuntimeConfig({
    aiIntegrations: [
      integration("local", { chatModels: [{ id: "1", name: "qwen", capabilities: ["default"] }] }),
      integration("cloud", { chatModels: [{ id: "2", name: "gpt-4o", capabilities: ["default"] }] }),
    ],
    taskRouting: { autopilot: { primary: { integrationId: "local", model: "qwen" }, fallbacks: [{ integrationId: "cloud", model: "gpt-4o" }] } },
    ...extra,
  });
  const host = byHost({ local: () => fail(500, "local model crashed"), cloud: () => ok("the manuscript was sent here"), ...handlers });
  return { cfg, ...host };
}

test("without a privacy policy a failing local primary still falls back to the cloud (today's behavior)", async () => {
  const { cfg, fetch, calls } = twoAccounts();
  const response = await createFetchAi(cfg, { fetch }).complete(ASK);
  assert.equal(response.text, "the manuscript was sent here");
  assert.deepEqual(calls.map((call) => call.host), ["local.test", "cloud.test"]);
});

test("sameBoundaryOnly: a fallback outside the primary's integration is never used, and the error says why", async () => {
  const { cfg, fetch, calls } = twoAccounts({ fallbackDisclosure: { sameBoundaryOnly: true, requireAcknowledgement: false } });
  const error = await createFetchAi(cfg, { fetch }).complete(ASK).then(() => null, (failure) => failure);
  assert.ok(error instanceof AiProviderError);
  assert.match(error.message, /local model crashed/);
  assert.match(error.message, /sameBoundaryOnly/);
  assert.deepEqual(calls.map((call) => call.host), ["local.test"], "the manuscript never reached the cloud");
  assert.equal(error.retryable, true, "the primary's failure keeps its own classification");
});

test("sameBoundaryOnly still allows fallbacks inside the primary's integration", async () => {
  const cfg = pickAiRuntimeConfig({
    aiIntegrations: [integration("local", { chatModels: [{ id: "1", name: "big", capabilities: ["default"] }, { id: "2", name: "small", capabilities: ["default"] }] }), integration("cloud")],
    taskRouting: { autopilot: { primary: { integrationId: "local", model: "big" }, fallbacks: [{ integrationId: "local", model: "small" }, { integrationId: "cloud", model: "model-cloud" }] } },
    fallbackDisclosure: { sameBoundaryOnly: true, requireAcknowledgement: true },
  });
  const models = [];
  const fetch = async (_url, init) => {
    const body = JSON.parse(init.body);
    models.push(body.model);
    return body.model === "big" ? fail(500, "big failed") : ok(`answered by ${body.model}`);
  };
  const response = await createFetchAi(cfg, { fetch }).complete(ASK);
  assert.equal(response.text, "answered by small");
  assert.deepEqual(models, ["big", "small"]);
});

test("requireAcknowledgement: a host that cannot ask never crosses the boundary (fail closed) and the error names the setting", async () => {
  const { cfg, fetch, calls } = twoAccounts({ fallbackDisclosure: { sameBoundaryOnly: false, requireAcknowledgement: true } });
  const error = await createFetchAi(cfg, { fetch }).complete(ASK).then(() => null, (failure) => failure);
  assert.ok(error instanceof AiProviderError);
  assert.match(error.message, /requireAcknowledgement/);
  assert.match(error.message, /Settings|turn it off|change it/i, "and how to change it");
  assert.match(error.message, /local model crashed/, "the primary's failure is not lost");
  assert.deepEqual(calls.map((call) => call.host), ["local.test"]);
});

test("requireAcknowledgement: the host's hook is asked before crossing, with the two sides, and decides", async () => {
  const asked = [];
  const run = async (answer) => {
    const { cfg, fetch, calls } = twoAccounts({ fallbackDisclosure: { sameBoundaryOnly: false, requireAcknowledgement: true } });
    const ai = createFetchAi(cfg, { fetch, acknowledgeFallback: async (from, to, info) => (asked.push({ from, to, info }), answer) });
    const outcome = await ai.complete(ASK).then((value) => ({ value }), (error) => ({ error }));
    return { ...outcome, hosts: calls.map((call) => call.host) };
  };
  const accepted = await run(true);
  assert.equal(accepted.value.text, "the manuscript was sent here");
  assert.deepEqual(accepted.hosts, ["local.test", "cloud.test"]);
  assert.equal(asked.length, 1);
  assert.equal(asked[0].from.integrationId, "local");
  assert.equal(asked[0].from.provider, "openai");
  assert.equal(asked[0].from.model, "qwen");
  assert.equal(asked[0].to.integrationId, "cloud");
  assert.equal(asked[0].to.model, "gpt-4o");
  assert.notEqual(asked[0].from.boundary, asked[0].to.boundary);
  assert.equal(asked[0].info.label, "t");

  const declined = await run(false);
  assert.ok(declined.error instanceof AiProviderError);
  assert.match(declined.error.message, /requireAcknowledgement/);
  assert.deepEqual(declined.hosts, ["local.test"], "declined: nothing is sent to the cloud");
  const truthyButNotTrue = await run("yes");
  assert.ok(truthyButNotTrue.error, "only an explicit true accepts");
});

test("requireAcknowledgement: a hook that throws cancels the whole call; same-account fallbacks never ask", async () => {
  const { cfg, fetch, calls } = twoAccounts({ fallbackDisclosure: { sameBoundaryOnly: false, requireAcknowledgement: true } });
  const cancelled = new DOMException("The author declined.", "AbortError");
  const error = await createFetchAi(cfg, { fetch, acknowledgeFallback: () => { throw cancelled; } }).complete(ASK).then(() => null, (failure) => failure);
  assert.equal(error, cancelled);
  assert.deepEqual(calls.map((call) => call.host), ["local.test"]);

  const sameAccount = pickAiRuntimeConfig({
    aiIntegrations: [integration("local", { chatModels: [{ id: "1", name: "big", capabilities: ["default"] }, { id: "2", name: "small", capabilities: ["default"] }] })],
    taskRouting: { autopilot: { primary: { integrationId: "local", model: "big" }, fallbacks: [{ integrationId: "local", model: "small" }] } },
    fallbackDisclosure: { sameBoundaryOnly: false, requireAcknowledgement: true },
  });
  let asks = 0;
  const response = await createFetchAi(sameAccount, { fetch: async (_url, init) => JSON.parse(init.body).model === "big" ? fail(500, "no") : ok("small answered"), acknowledgeFallback: () => (asks += 1, true) }).complete(ASK);
  assert.equal(response.text, "small answered");
  assert.equal(asks, 0);
});

test("requireAcknowledgement: every crossing is asked, and a crossing is judged against the last account content was sent to", async () => {
  const cfg = pickAiRuntimeConfig({
    aiIntegrations: [integration("a"), integration("b"), integration("b2", { chatModels: [{ id: "x", name: "model-b2", capabilities: ["default"] }] }), integration("c")],
    taskRouting: { autopilot: { primary: { integrationId: "a", model: "model-a" }, fallbacks: [{ integrationId: "b", model: "model-b" }, { integrationId: "b2", model: "model-b2" }, { integrationId: "c", model: "model-c" }] } },
    fallbackDisclosure: { sameBoundaryOnly: false, requireAcknowledgement: true },
  });
  const pairs = [];
  const { fetch, calls } = byHost({ a: () => fail(500, "a"), b: () => fail(500, "b"), b2: () => fail(500, "b2"), c: () => ok("c answered") });
  const response = await createFetchAi(cfg, { fetch, acknowledgeFallback: (from, to) => (pairs.push(`${from.integrationId}>${to.integrationId}`), true) }).complete(ASK);
  assert.equal(response.text, "c answered");
  assert.deepEqual(pairs, ["a>b", "b>b2", "b2>c"]);
  assert.equal(calls.length, 4);
});

// ─── M3: routing limits ─────────────────────────────────────────────────────

function chain(count, execution, handler, models = {}) {
  const cfg = {
    aiIntegrations: Array.from({ length: count }, (_, index) => integration(`n${index}`, { chatModels: [{ id: `${index}`, name: `m${index}`, capabilities: ["default"], ...models }] })),
    routingExecution: execution,
  };
  const calls = [];
  const fetch = async (url, init) => {
    const index = Number(/n(\d+)\.test/.exec(String(url))[1]);
    calls.push(index);
    return handler(index, init);
  };
  return { cfg, fetch, calls };
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

test("maxTotalDurationMs never interrupts the first candidate before its own timeout", async () => {
  const { cfg, fetch, calls } = chain(2, { maxTotalDurationMs: 40 }, async () => {
    await sleep(200);
    return ok("a slow, long scene");
  });
  const response = await createFetchAi(cfg, { fetch }).complete(ASK);
  assert.equal(response.text, "a slow, long scene", "5x the total limit and the first candidate still finishes");
  assert.deepEqual(calls, [0]);
});

test("later candidates start only while time remains in the total budget", async () => {
  const { cfg, fetch, calls } = chain(3, { maxTotalDurationMs: 80 }, async (index) => {
    await sleep(120);
    return fail(503, `n${index} overloaded`);
  });
  const error = await createFetchAi(cfg, { fetch }).complete(ASK).then(() => null, (failure) => failure);
  assert.deepEqual(calls, [0], "the first candidate used up the total time: no fallback starts");
  assert.match(error.message, /n0 overloaded/);
  assert.equal(error.retryable, true);
});

test("a later candidate runs only for the time that remains", async () => {
  const { cfg, fetch, calls } = chain(2, { maxTotalDurationMs: 150 }, async (index, init) => {
    if (index === 0) return fail(503, "first down");
    await new Promise((resolve, reject) => {
      const timer = setTimeout(resolve, 2_000);
      init.signal.addEventListener("abort", () => (clearTimeout(timer), reject(init.signal.reason)), { once: true });
    });
    return ok("too late");
  });
  const started = Date.now();
  const error = await createFetchAi(cfg, { fetch }).complete(ASK).then(() => null, (failure) => failure);
  assert.deepEqual(calls, [0, 1]);
  assert.ok(Date.now() - started < 1_500, "the second candidate was cut at the total limit");
  assert.ok(error instanceof AiProviderError);
  assert.match(error.message, /timed out/);
});

test("without routing limits (an older configuration) there is no total time limit", async () => {
  const { cfg, fetch, calls } = chain(2, undefined, async (index) => {
    await sleep(60);
    return index === 0 ? fail(503, "down") : ok("second");
  });
  assert.equal((await createFetchAi(cfg, { fetch }).complete(ASK)).text, "second");
  assert.deepEqual(calls, [0, 1]);
});

test("maxTokenAttempts: candidates are kept while the estimated attempts fit, and a first one that cannot fit refuses the call", async () => {
  const fits = chain(3, { maxTokenAttempts: 1_000 }, () => fail(503, "down"));
  await createFetchAi(fits.cfg, { fetch: fits.fetch }).complete({ ...ASK, maxOutputTokens: 400 }).then(() => null, () => null);
  assert.deepEqual(fits.calls, [0, 1], "2 attempts of about 420 tokens fit in 1000, a third does not");

  const refused = chain(2, { maxTokenAttempts: 100 }, () => ok());
  const error = await createFetchAi(refused.cfg, { fetch: refused.fetch }).complete({ ...ASK, maxOutputTokens: 400 }).then(() => null, (failure) => failure);
  assert.ok(error instanceof engine.AiRoutingBudgetError);
  assert.ok(error instanceof AiProviderError);
  assert.equal(error.retryable, false);
  assert.match(error.message, /first routing candidate exceeds/);
  assert.deepEqual(refused.calls, [], "nothing was sent");
});

test("maxEstimatedCost keeps candidates while the estimated cost fits", async () => {
  const priced = { pricing: { inputPerMTok: 1_000, outputPerMTok: 1_000 } };
  const fits = chain(3, { maxEstimatedCost: 1 }, () => fail(503, "down"), priced);
  await createFetchAi(fits.cfg, { fetch: fits.fetch }).complete({ ...ASK, maxOutputTokens: 400 }).then(() => null, () => null);
  assert.deepEqual(fits.calls, [0, 1], "about 0.42 per attempt: two fit in 1, a third does not");

  const refused = chain(1, { maxEstimatedCost: 0.1 }, () => ok(), priced);
  const error = await createFetchAi(refused.cfg, { fetch: refused.fetch }).complete({ ...ASK, maxOutputTokens: 400 }).then(() => null, (failure) => failure);
  assert.ok(error instanceof engine.AiRoutingBudgetError);
  assert.equal(error.retryable, false);

  const unlimited = chain(3, undefined, () => fail(503, "down"), priced);
  await createFetchAi(unlimited.cfg, { fetch: unlimited.fetch }).complete({ ...ASK, maxOutputTokens: 400 }).then(() => null, () => null);
  assert.deepEqual(unlimited.calls, [0, 1, 2], "no limits configured: every candidate is tried");
});

// ─── B19: maxInputTokens ────────────────────────────────────────────────────

test("maxInputTokens: a candidate whose window cannot hold the prompt is skipped, never sent a truncated prompt", async () => {
  const cfg = {
    aiIntegrations: [
      integration("small", { chatModels: [{ id: "1", name: "tiny", capabilities: ["default"], maxInputTokens: 1_000 }] }),
      integration("big", { chatModels: [{ id: "2", name: "roomy", capabilities: ["default"], maxInputTokens: 128_000 }] }),
    ],
  };
  const sent = [];
  const fetch = async (url, init) => {
    sent.push({ host: new URL(url).hostname, user: JSON.parse(init.body).messages[1].content });
    return ok("fine");
  };
  const prompt = "x".repeat(20_000);
  const response = await createFetchAi(cfg, { fetch }).complete({ ...ASK, user: prompt, maxOutputTokens: 500 });
  assert.equal(response.text, "fine");
  assert.deepEqual(sent.map((entry) => entry.host), ["big.test"]);
  assert.equal(sent[0].user, prompt, "the prompt is sent whole");
});

test("maxInputTokens: when no candidate can hold the prompt the error is final and gives the estimate and the roomiest model's margin", async () => {
  const cfg = { aiIntegrations: [integration("a", { chatModels: [{ id: "1", name: "m", capabilities: ["default"], maxInputTokens: 1_000 }] })] };
  let called = false;
  const error = await createFetchAi(cfg, { fetch: async () => (called = true, ok()) }).complete({ ...ASK, user: "x".repeat(20_000), maxOutputTokens: 500 }).then(() => null, (failure) => failure);
  assert.ok(error instanceof engine.AiPromptTooLargeError);
  assert.ok(error instanceof AiProviderError);
  assert.equal(error.retryable, false);
  assert.ok(error.estimatedTokens > 4_900 && error.estimatedTokens < 5_100, `estimate ${error.estimatedTokens}`);
  assert.equal(error.largestBudget, 1_000 - 50 - 500, "window minus the 5% safety margin minus the output reserve");
  assert.match(error.message, /about \d+ tokens/);
  assert.match(error.message, /largest input budget: 450 tokens/);
  assert.equal(called, false);
});

test("maxInputTokens: the output reserve counts, a model without a configured window gets the prompt whole", async () => {
  const cfg = { aiIntegrations: [integration("a", { chatModels: [{ id: "1", name: "m", capabilities: ["default"], maxInputTokens: 8_000 }] })] };
  const ask = (maxOutputTokens) => createFetchAi(cfg, { fetch: async () => ok("fine") }).complete({ ...ASK, user: "x".repeat(28_000), maxOutputTokens }).then((value) => value, (error) => error);
  assert.ok((await ask(2_000)) instanceof engine.AiPromptTooLargeError, "8000 - 400 safety - 2000 output leaves 5600 for a prompt of about 7000");
  assert.equal((await ask(100)).text, "fine", "8000 - 400 - 100 leaves 7500");

  const open = { aiIntegrations: [integration("a")] };
  assert.equal((await createFetchAi(open, { fetch: async () => ok("whole") }).complete({ ...ASK, user: "x".repeat(2_000_000) })).text, "whole");
});

test("maxInputTokens: the forced tool's schema counts against the window", async () => {
  const bigSchema = { name: "big", description: "d", parameters: { type: "object", properties: Object.fromEntries(Array.from({ length: 300 }, (_, index) => [`field${index}`, { type: "string", description: "x".repeat(40) }])), required: ["field0"] } };
  const cfg = { aiIntegrations: [integration("a", { chatModels: [{ id: "1", name: "m", capabilities: ["default"], maxInputTokens: 6_000, maxOutputTokens: 200 }] })] };
  const prompt = "x".repeat(4_000);
  const withTools = await createFetchAi(cfg, { fetch: async () => toolReply({ field0: "x" }) }).complete({ ...ASK, user: prompt, json: bigSchema, maxOutputTokens: 200 }).then((value) => value, (error) => error);
  assert.ok(withTools instanceof engine.AiPromptTooLargeError, "about 1000 tokens of prompt plus about 6400 of schema do not fit 6000 - 300 - 200");
  const plain = await createFetchAi(cfg, { fetch: async () => ok("fits") }).complete({ ...ASK, user: prompt, maxOutputTokens: 200 });
  assert.equal(plain.text, "fits", "the same prompt without the schema fits");
});

// ─── C16: the base every request starts with ────────────────────────────────

test("effectiveAiBase is origin and path as requests really use them, defaults included", () => {
  const base = engine.effectiveAiBase;
  assert.equal(typeof base, "function");
  assert.equal(base({ provider: "openai" }), "https://api.openai.com/v1");
  assert.equal(base({ provider: "openai", endpoint: "  http://localhost:1234/v1///  " }), "http://localhost:1234/v1");
  assert.equal(base({ provider: "openai", endpoint: "http://localhost:1234" }), "http://localhost:1234");
  assert.equal(base({ provider: "github_models" }), "https://models.github.ai/inference");
  assert.equal(base({ provider: "github_models" }, "https://proxy.example/"), "https://proxy.example/inference");
  assert.equal(base({ provider: "azure_openai", endpoint: "https://r.openai.azure.com/" }), "https://r.openai.azure.com");
  assert.equal(base({ provider: "azure_openai", endpoint: "https://r.openai.azure.com/openai/v1/" }), "https://r.openai.azure.com/openai/v1");
  assert.equal(base({ provider: "azure_openai" }), null, "an Azure integration needs an endpoint");
  assert.equal(base({ provider: "m365_copilot", endpoint: "https://x" }), null);
});

test("every request URL starts with its integration's effective base", () => {
  for (const provider of PROVIDERS) {
    const candidate = { integration: { id: "i", name: "I", ...provider.integration }, model: "deploy-1" };
    const built = engine.buildChatRequest(candidate, ASK);
    const base = engine.effectiveAiBase(candidate.integration);
    assert.ok(built.url.startsWith(`${base}/`), `${provider.name}: ${built.url} vs ${base}`);
  }
  const proxied = { id: "i", name: "I", provider: "github_models", apiKey: "k" };
  assert.ok(engine.buildChatRequest({ integration: proxied, model: "m" }, ASK, { githubModelsBaseUrl: "https://proxy.example" }).url.startsWith(`${engine.effectiveAiBase(proxied, "https://proxy.example")}/`));
});

test("the same book request builds the same wire request whichever host runs it", async () => {
  const recorded = [[], []];
  const cfg = pickAiRuntimeConfig({ aiIntegrations: [integration("a")], fallbackDisclosure: { sameBoundaryOnly: true, requireAcknowledgement: true }, routingExecution: {} });
  for (const [index, host] of ["browser", "server"].entries()) {
    const fetch = async (url, init) => (recorded[index].push({ url: String(url), headers: init.headers, body: init.body }), ok("fine", { prompt_tokens: 1, completion_tokens: 1 }));
    await createFetchAi(JSON.parse(JSON.stringify(cfg)), host === "browser" ? { fetch, acknowledgeFallback: () => true } : { fetch }).complete({ ...ASK, json: SCHEMA, maxOutputTokens: 500, temperature: 0.7 }).catch(() => undefined);
  }
  assert.deepEqual(recorded[0], recorded[1]);
  assert.equal(recorded[0].length, 1);
});

// ─── Planning: what the candidate list does around the edges ────────────────

test("a candidate that cannot be called at all (an Azure integration without an endpoint) fails over to the next one", async () => {
  const cfg = pickAiRuntimeConfig({ aiIntegrations: [
    { id: "az", name: "Az", provider: "azure_openai", apiKey: "k", chatModels: [{ id: "1", name: "dep", capabilities: ["default"] }] },
    integration("b"),
  ] });
  const ends = [];
  const response = await createFetchAi(cfg, { fetch: async () => ok("b answered"), onAttemptEnd: (end) => ends.push(end) }).complete(ASK);
  assert.equal(response.text, "b answered");
  assert.equal(ends.length, 2);
  assert.equal(ends[0].outcome, "failed");
  assert.match(ends[0].error, /has no endpoint/);
  assert.equal(ends[1].outcome, "ok");
});

test("requireAcknowledgement: a primary that cannot hold the prompt is skipped, and the account content goes to instead is still judged against it", async () => {
  const cfg = {
    aiIntegrations: [
      integration("local", { chatModels: [{ id: "1", name: "tiny", capabilities: ["default"], maxInputTokens: 1_000 }] }),
      integration("cloud"),
    ],
    fallbackDisclosure: { sameBoundaryOnly: false, requireAcknowledgement: true },
  };
  const prompt = "x".repeat(20_000);
  const asked = [];
  const attempts = [];
  const { fetch, calls } = byHost({ local: () => ok("never"), cloud: () => ok("the cloud answered") });
  const response = await createFetchAi(cfg, { fetch, acknowledgeFallback: (from, to) => (asked.push(`${from.integrationId}>${to.integrationId}`), true), onAttempt: (attempt) => attempts.push(attempt) }).complete({ ...ASK, user: prompt, maxOutputTokens: 100 });
  assert.equal(response.text, "the cloud answered");
  assert.deepEqual(asked, ["local>cloud"], "the manuscript is going to another account than the primary's, whether or not the primary was tried");
  assert.deepEqual(calls.map((call) => call.host), ["cloud.test"]);
  assert.equal(attempts[0].index, 1, "the index is the candidate's place in the route, not in the attempts");

  const withoutHook = await createFetchAi(cfg, { fetch }).complete({ ...ASK, user: prompt, maxOutputTokens: 100 }).then(() => null, (failure) => failure);
  assert.ok(withoutHook instanceof engine.AiFallbackBlockedError);
  assert.ok(withoutHook instanceof AiProviderError);
  assert.equal(withoutHook.retryable, false);
  assert.match(withoutHook.message, /requireAcknowledgement/);
  assert.equal(calls.length, 1, "nothing was sent to either account");
});

test("a total time that ran out says that fallbacks were not tried", async () => {
  const { cfg, fetch } = chain(2, { maxTotalDurationMs: 30 }, async () => {
    await sleep(80);
    return fail(503, "first down");
  });
  const error = await createFetchAi(cfg, { fetch }).complete(ASK).then(() => null, (failure) => failure);
  assert.match(error.message, /first down/);
  assert.match(error.message, /maxTotalDurationMs/);
});

test("the policy never changes the call when there is nothing to protect: one candidate, same account", async () => {
  const cfg = pickAiRuntimeConfig({ aiIntegrations: [integration("a")], fallbackDisclosure: { sameBoundaryOnly: true, requireAcknowledgement: true }, routingExecution: {} });
  const response = await createFetchAi(cfg, { fetch: async () => ok("fine") }).complete(ASK);
  assert.equal(response.text, "fine");
  const failing = await createFetchAi(cfg, { fetch: async () => fail(503, "down") }).complete(ASK).then(() => null, (error) => error);
  assert.doesNotMatch(failing.message, /sameBoundaryOnly|requireAcknowledgement/, "no fallback was excluded or blocked: no note");
});

test("the time a person takes to answer the acknowledgement does not count against the total time", async () => {
  const cfg = {
    aiIntegrations: [integration("a"), integration("b")],
    fallbackDisclosure: { sameBoundaryOnly: false, requireAcknowledgement: true },
    routingExecution: { maxTotalDurationMs: 100 },
  };
  const { fetch, calls } = byHost({ a: () => fail(503, "a down"), b: () => ok("b answered") });
  const response = await createFetchAi(cfg, { fetch, acknowledgeFallback: async () => { await sleep(250); return true; } }).complete(ASK);
  assert.equal(response.text, "b answered", "the dialog took 2.5 times the total, and the fallback still ran");
  assert.equal(calls.length, 2);
});

test("a whole book runs through the client with the site's defaults for the privacy policy and the routing limits, and every request carries what the server always sent", async () => {
  const fake = createFakeAutopilotAi();
  const requests = [];
  const fetch = async (_url, init) => {
    const body = JSON.parse(init.body);
    requests.push(body);
    const tool = body.tools?.[0]?.function;
    const out = await fake.complete({ capability: "autopilot", label: "provider", system: body.messages[0].content, user: body.messages[1].content, json: tool });
    if (tool) return Response.json({ choices: [{ message: { content: null, tool_calls: [{ function: { arguments: JSON.stringify(out.json) } }] }, finish_reason: "tool_calls" }], usage: { prompt_tokens: 100, completion_tokens: 50 } });
    if (body.stream) return events([data({ choices: [{ delta: { content: out.text } }] }), data({ choices: [{ delta: {}, finish_reason: "stop" }] }), data({ choices: [], usage: { prompt_tokens: 100, completion_tokens: 50 } }), DONE]);
    return Response.json({ choices: [{ message: { content: out.text }, finish_reason: "stop" }], usage: { prompt_tokens: 100, completion_tokens: 50 } });
  };
  const cfg = pickAiRuntimeConfig({
    aiIntegrations: [integration("a", { chatModels: [{ id: "1", name: "gpt-4o", capabilities: ["default"], maxInputTokens: 128_000, maxOutputTokens: 16_384, pricing: { inputPerMTok: 2.5, outputPerMTok: 10 } }] })],
    fallbackDisclosure: { sameBoundaryOnly: true, requireAcknowledgement: true },
    routingExecution: { maxCandidates: 4, maxTotalDurationMs: 180_000, maxTokenAttempts: 200_000, maxEstimatedCost: 5 },
  });
  const store = new MemoryBookStore(seedBookFiles());
  const session = new AutopilotSession({ bookId: "book", store, ai: createFetchAi(cfg, { fetch }), host: "browser", hostLabel: "test", retryDelayMs: 0 });
  await session.start({ brief: { idea: "x", targetChapters: 1, scenesPerChapter: 1, wordsPerScene: 300 }, options: { readers: false, readersOnPlan: false, pauseAfterPlan: false } });
  await session.waitForIdle();
  const state = (await session.snapshot()).state;
  assert.equal(state.status, "completed", state.lastError?.message);
  assert.equal(state.stats.usageUnknownCalls, undefined);
  assert.equal(state.stats.costUnknownCalls, undefined, "a priced model with reported usage is fully measured");

  const structured = requests.filter((body) => body.tools);
  const prose = requests.filter((body) => !body.tools);
  assert.ok(structured.length > 8 && prose.length >= 1);
  const summary = structured.find((body) => body.tools[0].function.name === "scene_summary");
  assert.equal(summary.max_tokens, 4_096, "a small structured task still gets the floor (the scene summary asks for 400)");
  const plan = structured.find((body) => body.tools[0].function.name === "chapter_plan");
  assert.equal(plan.temperature, 0.7, "the temperature the task sets is sent");
  assert.equal(plan.max_tokens, 9_000);
  assert.equal(prose[0].temperature, 0.8, "the ghostwriter's temperature reaches the model");
  assert.ok(structured.every((body) => body.tool_choice === "required"));
  assert.ok(prose.every((body) => body.stream === true));
});

function seeded(seed) {
  let state = seed;
  return () => {
    state = (state + 0x6d2b79f5) | 0;
    let value = Math.imul(state ^ (state >>> 15), 1 | state);
    value = (value + Math.imul(value ^ (value >>> 7), 61 | value)) ^ value;
    return ((value ^ (value >>> 14)) >>> 0) / 4294967296;
  };
}

test("the stream reader gives the same reply whatever the network chunking and the layout of the events", async () => {
  const alphabet = ["a", "b", " ", "é", "你", "😀", "\n", "\"", "\\", "{", "}", "data:", "&", "<", ">"];
  const cfg = pickAiRuntimeConfig({ aiIntegrations: [integration("a")] });
  const layouts = [
    (body) => `data: ${JSON.stringify(body)}\n\n`,
    (body) => `data:${JSON.stringify(body)}\r\n\r\n`,
    (body) => `: keep-alive\nevent: message\nid: 7\ndata: ${JSON.stringify(body)}\n\n`,
    (body) => `${JSON.stringify(body, null, 1).split("\n").map((line) => `data: ${line}`).join("\n")}\n\n`,
    (body) => `data: ${JSON.stringify(body)}\n`,
  ];
  for (let iteration = 0; iteration < 150; iteration += 1) {
    const random = seeded(iteration + 1);
    const pieces = ["x", ...Array.from({ length: 1 + Math.floor(random() * 10) }, () => Array.from({ length: 1 + Math.floor(random() * 6) }, () => alphabet[Math.floor(random() * alphabet.length)]).join(""))];
    const layout = layouts[iteration % layouts.length];
    const wire = [...pieces.map((piece) => layout({ choices: [{ delta: { content: piece } }] })), layout({ choices: [{ delta: {}, finish_reason: "stop" }] }), layout({ choices: [], usage: { prompt_tokens: 3, completion_tokens: 2 } }), "data: [DONE]\n\n"].join("");
    const bytes = encoder.encode(wire);
    const fetch = async () => {
      const chunks = [];
      for (let at = 0; at < bytes.length;) {
        const size = 1 + Math.floor(random() * 17);
        chunks.push(bytes.slice(at, at + size));
        at += size;
      }
      return new Response(new ReadableStream({ start(controller) { for (const chunk of chunks) controller.enqueue(chunk); controller.close(); } }), { status: 200, headers: { "content-type": "text/event-stream" } });
    };
    const seen = [];
    const response = await createFetchAi(cfg, { fetch }).complete({ ...ASK, onText: (text) => seen.push(text) });
    assert.equal(response.text, pieces.join(""), `iteration ${iteration}, layout ${iteration % layouts.length}`);
    assert.deepEqual(response.usage, { inputTokens: 3, outputTokens: 2, cachedInputTokens: 0 });
    assert.equal(seen.at(-1), pieces.join(""));
  }
});
