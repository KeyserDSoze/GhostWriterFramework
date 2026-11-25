import test from "node:test";
import assert from "node:assert/strict";
import * as engine from "../dist/index.js";
import { ASK, JSON_ASK, recording } from "./transport-fakes.mjs";

// The API version of an Azure OpenAI request is the model's own, else its integration's, else the default: `effectiveApiVersion` is the one place that says it, and the client, the trail
// of the attempts, the records and the configuration of a personal server all follow it. A fallback in another integration or another model is asked with its own.

const { DEFAULT_AZURE_API_VERSION, buildChatRequest, createFetchAi, effectiveApiVersion, pickAiRuntimeConfig, planAttempts, redactAiRuntimeConfig, classifyAutopilotError } = engine;

const azure = (extra = {}) => ({ id: "az", name: "Azure GW", provider: "azure_openai", endpoint: "https://res.openai.azure.com", apiKey: "k-azure-secret-123456", ...extra });
const modelOf = (name, extra = {}) => ({ id: name, name, capabilities: ["default"], ...extra });
const answer = (text = "ok") => Response.json({ choices: [{ message: { content: text }, finish_reason: "stop" }], usage: { prompt_tokens: 5, completion_tokens: 2 } });
const toolAnswer = (value) => Response.json({ choices: [{ message: { tool_calls: [{ id: "c", type: "function", function: { name: "result", arguments: JSON.stringify(value) } }] }, finish_reason: "tool_calls" }], usage: { prompt_tokens: 5, completion_tokens: 2 } });
const versionOfUrl = (url) => new URL(url).searchParams.get("api-version");
const deploymentOfUrl = (url) => /\/deployments\/([^/]+)\//.exec(url)?.[1];

test("the version of a request is the model's own, else its integration's, else the default; whitespace is no version; the v1 API has none in its address; another provider has no version", () => {
  const integration = azure({ apiVersion: "2025-01-01-preview" });
  assert.equal(effectiveApiVersion(integration, { apiVersion: "2024-10-21" }), "2024-10-21", "the model's own wins");
  assert.equal(effectiveApiVersion(integration, {}), "2025-01-01-preview", "a model without its own inherits");
  assert.equal(effectiveApiVersion(integration, { apiVersion: "   " }), "2025-01-01-preview", "an empty field inherits");
  assert.equal(effectiveApiVersion(integration, null), "2025-01-01-preview");
  assert.equal(effectiveApiVersion(integration), "2025-01-01-preview");
  assert.equal(effectiveApiVersion(azure(), { apiVersion: " 2024-06-01 " }), "2024-06-01", "trimmed");
  assert.equal(effectiveApiVersion(azure(), undefined), DEFAULT_AZURE_API_VERSION, "no version anywhere: the default");
  assert.equal(effectiveApiVersion(azure({ apiVersion: "" }), {}), DEFAULT_AZURE_API_VERSION);
  assert.equal(effectiveApiVersion(azure({ endpoint: "https://res.openai.azure.com/openai/v1/", apiVersion: "2025-01-01-preview" }), { apiVersion: "2024-10-21" }), "v1", "the v1 API takes no api-version");
  assert.equal(effectiveApiVersion({ provider: "openai", endpoint: "https://x.test/v1", apiVersion: "2025-01-01" }, { apiVersion: "2025-02-02" }), undefined, "a provider that has no version");
  assert.equal(effectiveApiVersion({ provider: "github_models", apiVersion: "x" }, {}), undefined);
});

test("the address, the output-limit parameter and the forced tool choice follow the version of the model that is asked, not only the integration's", () => {
  const integration = azure({ apiVersion: "2025-01-01-preview" });
  const build = (candidate, request = ASK) => buildChatRequest({ integration, ...candidate }, { ...request, maxOutputTokens: 800 });
  const inherits = build({ model: "dep-a" });
  const own = build({ model: "dep-b", apiVersion: "2024-02-01" });
  assert.equal(versionOfUrl(inherits.url), "2025-01-01-preview");
  assert.equal(deploymentOfUrl(inherits.url), "dep-a");
  assert.equal(versionOfUrl(own.url), "2024-02-01");
  assert.equal(deploymentOfUrl(own.url), "dep-b");
  assert.equal(inherits.apiVersion, "2025-01-01-preview");
  assert.equal(own.apiVersion, "2024-02-01");
  // An old API version does not know `max_completion_tokens` (from 2024-09-01) and only knows the named form of `tool_choice` (before 2024-06-01): per model, within one integration.
  assert.equal("max_completion_tokens" in inherits.body, true);
  assert.equal("max_tokens" in own.body, true);
  assert.equal("max_completion_tokens" in own.body, false);
  const asks = { ...JSON_ASK };
  assert.equal(build({ model: "dep-a" }, asks).body.tool_choice, "required");
  assert.deepEqual(build({ model: "dep-b", apiVersion: "2024-02-01" }, asks).body.tool_choice, { type: "function", function: { name: "result" } });
  // The v1 API: no api-version in the address, and the version is said as `v1`.
  const v1 = buildChatRequest({ integration: azure({ endpoint: "https://res.openai.azure.com/openai/v1" }), model: "dep-c", apiVersion: "2024-02-01" }, ASK);
  assert.equal(v1.url, "https://res.openai.azure.com/openai/v1/chat/completions");
  assert.equal(v1.apiVersion, "v1");
  // A provider without a version carries none.
  const plain = buildChatRequest({ integration: { id: "o", name: "O", provider: "openai", endpoint: "http://o.test/v1", apiKey: "" }, model: "m", apiVersion: "2025-01-01" }, ASK);
  assert.equal(plain.apiVersion, undefined);
  assert.equal(plain.url, "http://o.test/v1/chat/completions");
});

test("the client asks each model with its own version, whatever order they are asked in, and every attempt says the version it sent: the primary and the fallback of another integration", async () => {
  const config = {
    aiIntegrations: [
      azure({ id: "a", name: "Azure A", endpoint: "https://a.openai.azure.com", apiVersion: "2025-01-01-preview", chatModels: [modelOf("luna", { apiVersion: "2024-10-21" }), modelOf("sol")] }),
      azure({ id: "b", name: "Azure B", endpoint: "https://b.openai.azure.com", chatModels: [modelOf("mira")] }),
    ],
    taskRouting: { autopilot: { primary: { integrationId: "a", model: "luna" }, fallbacks: [{ integrationId: "a", model: "sol" }, { integrationId: "b", model: "mira" }] } },
  };
  const { fetch, calls } = recording((entry) => (entry.url.includes("mira") ? answer("done") : new Response(JSON.stringify({ error: { message: "nope" } }), { status: 500, headers: { "content-type": "application/json" } })));
  const attempts = [];
  const ends = [];
  const response = await createFetchAi(config, { fetch, onAttempt: (attempt) => attempts.push(attempt), onAttemptEnd: (end) => ends.push(end) }).complete(ASK);
  assert.equal(response.text, "done");
  assert.deepEqual(calls.map((call) => [call.url.slice(8, 9), deploymentOfUrl(call.url), versionOfUrl(call.url)]), [["a", "luna", "2024-10-21"], ["a", "sol", "2025-01-01-preview"], ["b", "mira", DEFAULT_AZURE_API_VERSION]]);
  assert.deepEqual(attempts.map((attempt) => [attempt.integrationId, attempt.model, attempt.apiVersion]), [["a", "luna", "2024-10-21"], ["a", "sol", "2025-01-01-preview"], ["b", "mira", DEFAULT_AZURE_API_VERSION]]);
  assert.equal(ends.length, 3);
});

test("the trail of a failed call says the version of every attempt: on the error's target, on its route, in the detail of the run and in the records of the call", async () => {
  const config = {
    aiIntegrations: [azure({ apiVersion: "2025-01-01-preview", chatModels: [modelOf("luna", { apiVersion: "2024-10-21" }), modelOf("sol")] })],
    taskRouting: { autopilot: { primary: { integrationId: "az", model: "luna" }, fallbacks: [{ integrationId: "az", model: "sol" }] } },
  };
  const { fetch } = recording(() => new Response(JSON.stringify({ error: { message: "The deployment does not exist." } }), { status: 404, headers: { "content-type": "application/json" } }));
  const error = await createFetchAi(config, { fetch }).complete(ASK).then(() => null, (failure) => failure);
  assert.ok(error);
  assert.equal(error.target.apiVersion, "2025-01-01-preview", "the last attempt's");
  assert.deepEqual(error.route.map((step) => [step.model, step.apiVersion]), [["luna", "2024-10-21"], ["sol", "2025-01-01-preview"]]);
  const { errorDetail } = engine.autopilotErrorFields(error);
  assert.equal(errorDetail.apiVersion, "2025-01-01-preview");
  assert.deepEqual(errorDetail.route.map((step) => step.apiVersion), ["2024-10-21", "2025-01-01-preview"]);
  assert.equal(engine.normalizeErrorDetail({ apiVersion: "2025-01-01-preview", status: 404 }).apiVersion, "2025-01-01-preview");
  assert.equal(engine.normalizeErrorDetail({ apiVersion: "x y; drop table", status: 404 }).apiVersion, undefined, "a word that is no version is not kept");
  assert.equal(classifyAutopilotError(error).detail.apiVersion, "2025-01-01-preview");
});

test("the records of a call keep the version of each attempt, beside its model", async () => {
  const records = new engine.MemoryAiCallStore();
  const { MemoryBookStore, createFakeAutopilotAi, seedBookFiles } = await import("../dist/testing/index.js");
  const base = createFakeAutopilotAi({ reviewVerdict: () => "approve", scenes: 1, words: 200 });
  const config = {
    aiIntegrations: [azure({ apiVersion: "2025-01-01-preview", chatModels: [modelOf("luna", { apiVersion: "2024-10-21" })] })],
    taskRouting: Object.fromEntries(["autopilot", "director", "reader-evaluation", "reader-evaluation-summary", "review", "simple-tasks"].map((capability) => [capability, { primary: { integrationId: "az", model: "luna" }, fallbacks: [] }])),
  };
  let reply = null;
  const { fetch } = recording((entry) => {
    const tool = entry.body.tools?.[0]?.function?.name;
    return tool ? toolAnswer(reply.json) : answer(reply.text);
  });
  const client = createFetchAi(config, { fetch });
  const ai = { calls: base.calls, async complete(request) { reply = await base.complete({ ...request, onText: undefined, onProgress: undefined, onStructuredText: undefined }); return client.complete(request); } };
  const session = new engine.AutopilotSession({ bookId: "book", store: new MemoryBookStore(seedBookFiles({ chapters: 1 })), ai, host: "server", hostLabel: "test", retryDelayMs: 0, calls: records, callsSecrets: () => [] });
  await session.start({ brief: { idea: "A harbor.", targetChapters: 1, scenesPerChapter: 1, wordsPerScene: 300 }, options: { readers: false, readersOnPlan: false, specialists: false, pauseAfterPlan: false }, limits: { steps: 1 } });
  await session.waitForIdle();
  const tasks = await records.listTasks("book", { limit: 10 });
  assert.ok(tasks.tasks.length >= 1);
  const task = await records.readTask("book", tasks.tasks[0].activityId);
  const attempts = task.calls.flatMap((call) => call.attempts ?? []);
  assert.ok(attempts.length >= 1, "the call has its attempt");
  for (const attempt of attempts) assert.equal(attempt.apiVersion, "2024-10-21");
});

test("old settings without the field keep working and round-trip; a model's version is kept when set, trimmed, and an empty one is the same as none; the safe view says it", () => {
  const oldSettings = { aiIntegrations: [azure({ apiVersion: "2025-01-01-preview", chatModels: [modelOf("luna"), modelOf("sol")] })] };
  const picked = pickAiRuntimeConfig(oldSettings);
  assert.deepEqual(picked.aiIntegrations[0].chatModels.map((model) => "apiVersion" in model), [false, false], "no field is made up");
  assert.deepEqual(pickAiRuntimeConfig(picked), picked, "a picked configuration is picked again as it is");
  assert.equal(effectiveApiVersion(picked.aiIntegrations[0], picked.aiIntegrations[0].chatModels[0]), "2025-01-01-preview", "an old configuration asks as it always did");

  const withOverride = pickAiRuntimeConfig({ aiIntegrations: [azure({ apiVersion: "2025-01-01-preview", chatModels: [modelOf("luna", { apiVersion: " 2024-10-21 " }), modelOf("sol", { apiVersion: "  " }), modelOf("mira", { apiVersion: 5 })] })] });
  const models = withOverride.aiIntegrations[0].chatModels;
  assert.equal(models[0].apiVersion, "2024-10-21");
  assert.equal("apiVersion" in models[1], false, "an empty field is no field");
  assert.equal("apiVersion" in models[2], false, "what is not text is no version");
  assert.deepEqual(pickAiRuntimeConfig(withOverride), withOverride, "round trip, with the field too");
  assert.deepEqual(pickAiRuntimeConfig(JSON.parse(JSON.stringify(withOverride))), withOverride, "and through the JSON a personal server stores, read again");
  assert.equal(JSON.parse(JSON.stringify(withOverride)).aiIntegrations[0].chatModels[0].apiVersion, "2024-10-21");

  const view = redactAiRuntimeConfig(withOverride);
  assert.equal(view.integrations[0].apiVersion, "2025-01-01-preview");
  assert.deepEqual(view.integrations[0].models.map((model) => model.apiVersion), ["2024-10-21", undefined, undefined]);
  assert.ok(!JSON.stringify(view).includes("k-azure-secret"), "the safe view still has no key");
});

test("a candidate carries the version of its model, and the plan builds each request with it", () => {
  const config = pickAiRuntimeConfig({
    aiIntegrations: [azure({ apiVersion: "2025-01-01-preview", chatModels: [modelOf("luna", { apiVersion: "2024-10-21" }), modelOf("sol")] })],
    taskRouting: { autopilot: { primary: { integrationId: "az", model: "luna" }, fallbacks: [{ integrationId: "az", model: "sol" }] } },
  });
  const plan = planAttempts(config, ASK);
  assert.deepEqual(plan.attempts.map((attempt) => [attempt.candidate.model, attempt.candidate.apiVersion, attempt.built.apiVersion, versionOfUrl(attempt.built.url)]), [["luna", "2024-10-21", "2024-10-21", "2024-10-21"], ["sol", undefined, "2025-01-01-preview", "2025-01-01-preview"]]);
});
