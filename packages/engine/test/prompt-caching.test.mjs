import test from "node:test";
import assert from "node:assert/strict";
import * as engine from "../dist/index.js";
import { ASK, JSON_ASK, recording } from "./transport-fakes.mjs";

// Prompt caching: what a model says of it (and what the engine learns), what a provider reports of it (the usage of every shape), what a request carries to help the provider find its cache
// (`prompt_cache_key`, `cache_control`), and the one refusal that is handled by itself: a provider that does not know the hint is asked again without it, and never sent it again.

const { buildChatRequest, createFetchAi, createModelMemory, estimateCost, normalizePromptCaching, pickAiRuntimeConfig, promptCacheHintFor, promptCacheKey, redactAiRuntimeConfig, refusesCacheHint, servedFromCache } = engine;

const AZURE = "https://res.openai.azure.com";
const integrationOf = (provider, endpoint, extra = {}) => ({ id: "i", name: "Main", provider, endpoint, apiKey: "sk-test-SECRET-0123456789", ...extra });
const modelOf = (name, extra = {}) => ({ id: name, name, capabilities: ["default"], ...extra });
const configOf = (integration, models, extra = {}) => ({
  aiIntegrations: [{ ...integration, chatModels: models }],
  taskRouting: { autopilot: { primary: { integrationId: integration.id, model: models[0].name }, fallbacks: [] } },
  ...extra,
});
const ok = (usage = { prompt_tokens: 2000, completion_tokens: 3 }, text = "ok") => Response.json({ choices: [{ message: { content: text }, finish_reason: "stop" }], usage });
const toolOk = (usage) => Response.json({ choices: [{ message: { tool_calls: [{ id: "c1", type: "function", function: { name: "result", arguments: JSON.stringify({ ok: true }) } }] }, finish_reason: "tool_calls" }], usage });
const refusalOf = (message, status = 400) => new Response(JSON.stringify({ error: { message, type: "invalid_request_error", param: null, code: null } }), { status, headers: { "content-type": "application/json" } });

// ─── What a model says of it ────────────────────────────────────────────────

test("a model says whether it caches: supported, unsupported or learned are kept, unknown is the absence of a value, and anything else is no value", () => {
  assert.deepEqual(["supported", "unsupported", "learned"].map(normalizePromptCaching), ["supported", "unsupported", "learned"]);
  for (const value of ["unknown", "yes", true, 1, null, undefined, "SUPPORTED"]) assert.equal(normalizePromptCaching(value), undefined);
  const config = pickAiRuntimeConfig({
    aiPromptCacheHints: false,
    aiIntegrations: [{
      id: "i", provider: "openai", apiKey: "k", endpoint: "https://api.openai.com/v1",
      chatModels: [
        { name: "a", capabilities: [], promptCaching: "supported", pricing: { inputPerMTok: 2, cachedPerMTok: 0.2, cacheWritePerMTok: 2.5, outputPerMTok: 8 } },
        { name: "b", capabilities: [], promptCaching: "unsupported" },
        { name: "c", capabilities: [], promptCaching: "learned" },
        { name: "d", capabilities: [], promptCaching: "unknown" },
        { name: "e", capabilities: [], promptCaching: 3, pricing: { cacheWritePerMTok: -1 } },
      ],
    }],
  });
  const models = config.aiIntegrations[0].chatModels;
  assert.deepEqual(models.map((model) => model.promptCaching), ["supported", "unsupported", "learned", undefined, undefined]);
  assert.deepEqual(models[0].pricing, { inputPerMTok: 2, cachedPerMTok: 0.2, cacheWritePerMTok: 2.5, outputPerMTok: 8 });
  assert.equal(models[4].pricing, undefined, "a price that is not a price is dropped");
  assert.equal(config.promptCacheHints, false);
  assert.equal(pickAiRuntimeConfig({ aiIntegrations: [] }).promptCacheHints, undefined, "a configuration saved before this existed has no word on it");
  assert.equal(pickAiRuntimeConfig({ promptCacheHints: true, aiIntegrations: [] }).promptCacheHints, true, "a configuration that was picked already says it as `promptCacheHints`");
  const safe = redactAiRuntimeConfig(config);
  assert.deepEqual(safe.integrations[0].models.map((model) => model.promptCaching), ["supported", "unsupported", "learned", undefined, undefined]);
  assert.equal(safe.promptCacheHints, false);
  assert.equal(redactAiRuntimeConfig({ aiIntegrations: [] }).promptCacheHints, true, "on unless the configuration turned it off");
});

// ─── What a provider reports, and what it costs ─────────────────────────────

const usageOf = async (usage, pricing) => {
  const { fetch } = recording(() => ok(usage));
  const integration = integrationOf("openai", "https://api.openai.com/v1");
  const response = await createFetchAi(configOf(integration, [modelOf("m", pricing ? { pricing } : {})]), { fetch }).complete(ASK);
  return response;
};

test("the usage of every shape says what was served from the cache: OpenAI, the Responses API, DeepSeek, and a provider that counts the cache apart from its input", async () => {
  assert.deepEqual((await usageOf({ prompt_tokens: 2000, completion_tokens: 3, prompt_tokens_details: { cached_tokens: 1280 } })).usage, { inputTokens: 2000, outputTokens: 3, cachedInputTokens: 1280 });
  assert.deepEqual((await usageOf({ input_tokens: 2000, output_tokens: 3, input_tokens_details: { cached_tokens: 1024 } })).usage, { inputTokens: 2000, outputTokens: 3, cachedInputTokens: 1024 });
  assert.deepEqual((await usageOf({ prompt_tokens: 2000, completion_tokens: 3, prompt_cache_hit_tokens: 1500, prompt_cache_miss_tokens: 500 })).usage, { inputTokens: 2000, outputTokens: 3, cachedInputTokens: 1500 });
  assert.deepEqual((await usageOf({ prompt_tokens: 2000, completion_tokens: 3, cache_read_input_tokens: 700 })).usage, { inputTokens: 2000, outputTokens: 3, cachedInputTokens: 700 }, "a gateway that says it besides the OpenAI fields");
  assert.deepEqual((await usageOf({ prompt_tokens: 2000, completion_tokens: 3 })).usage, { inputTokens: 2000, outputTokens: 3, cachedInputTokens: 0 }, "a provider that says nothing of a cache is as it always was: no field is added");
  assert.deepEqual((await usageOf({ prompt_tokens: 2000, completion_tokens: 3, cache_read_input_tokens: 1500, cache_creation_input_tokens: 400 })).usage, { inputTokens: 2000, outputTokens: 3, cachedInputTokens: 1500, cacheWriteInputTokens: 400 }, "a gateway of Anthropic's models says what it read and what it wrote");
  assert.deepEqual((await usageOf({ prompt_tokens: 2000, completion_tokens: 3, prompt_tokens_details: { cached_tokens: 0, cache_write_tokens: 1024 } })).usage, { inputTokens: 2000, outputTokens: 3, cachedInputTokens: 0, cacheWriteInputTokens: 1024 }, "Azure OpenAI says what it wrote too");
  assert.deepEqual((await usageOf({ prompt_tokens: 2000, completion_tokens: 3, prompt_tokens_details: { cached_tokens: 0, cache_write_tokens: 0 } })).usage, { inputTokens: 2000, outputTokens: 3, cachedInputTokens: 0 }, "and says nothing of a write when there was none");
});

test("the cost: cached tokens at the cached price, written tokens at the cache-write price, the rest at the input price; a model without those prices bills them as input", async () => {
  const pricing = { inputPerMTok: 10, cachedPerMTok: 1, cacheWritePerMTok: 12.5, outputPerMTok: 40 };
  const usage = { inputTokens: 10_000, outputTokens: 1_000, cachedInputTokens: 6_000, cacheWriteInputTokens: 2_000 };
  assert.ok(Math.abs(estimateCost(usage, pricing) - (2_000 * 10 + 6_000 * 1 + 2_000 * 12.5 + 1_000 * 40) / 1e6) < 1e-12);
  const cachedOnly = { inputPerMTok: 10, cachedPerMTok: 1, outputPerMTok: 40 };
  assert.ok(Math.abs(estimateCost(usage, cachedOnly) - (2_000 * 10 + 6_000 * 1 + 2_000 * 10 + 1_000 * 40) / 1e6) < 1e-12, "a write with no price of its own costs like input");
  assert.ok(Math.abs(estimateCost({ inputTokens: 10_000, outputTokens: 0, cachedInputTokens: 0 }, pricing) - 0.1) < 1e-12, "no cache is the plain price");
  assert.ok(Math.abs(estimateCost({ inputTokens: 100, outputTokens: 0, cachedInputTokens: 60, cacheWriteInputTokens: 900 }, pricing) - (60 * 1 + 40 * 12.5) / 1e6) < 1e-12, "a write that says more than the prompt is cut to the prompt");
  const priced = await usageOf({ prompt_tokens: 2000, completion_tokens: 0, prompt_tokens_details: { cached_tokens: 1500 } }, { inputPerMTok: 10, cachedPerMTok: 1, outputPerMTok: 40 });
  assert.ok(Math.abs(priced.cost - (500 * 10 + 1500 * 1) / 1e6) < 1e-12);
});

test("what a prefix is served: nothing under a thousand and twenty-four tokens, then whole steps of a hundred and twenty-eight", () => {
  assert.deepEqual([0, 500, 1023].map((tokens) => servedFromCache(tokens)), [0, 0, 0]);
  assert.deepEqual([1024, 1100, 1151, 1152, 2047, 2048].map((tokens) => servedFromCache(tokens)), [1024, 1024, 1024, 1152, 1920, 2048]);
  assert.equal(servedFromCache(5000, 3000), 3000, "never more than the prompt");
  assert.equal(servedFromCache(Number.NaN), 0);
});

// ─── The hint a request carries ─────────────────────────────────────────────

test("the key is a short name of the scope, the same for the same scope, and not the scope", () => {
  const key = promptCacheKey("my-secret-novel/review");
  assert.match(key, /^narrarium-[0-9a-f]{16}$/);
  assert.equal(promptCacheKey("my-secret-novel/review"), key);
  assert.notEqual(promptCacheKey("my-secret-novel/director"), key);
  assert.notEqual(promptCacheKey("another-novel/review"), key);
  assert.ok(!key.includes("novel"));
});

test("OpenAI and Azure OpenAI are sent prompt_cache_key over Chat Completions and the Responses API, when the host names the scope", () => {
  const azure = integrationOf("azure_openai", AZURE, { apiVersion: "2025-04-01-preview" });
  const scope = { cacheKey: "book/review" };
  const chat = buildChatRequest({ integration: azure, model: "gpt-5" }, { system: "S", user: "U", ...scope });
  assert.equal(chat.body.prompt_cache_key, promptCacheKey("book/review"));
  assert.equal(chat.cacheHint, "prompt_cache_key");
  const responses = buildChatRequest({ integration: azure, model: "gpt-5", apiProtocol: "responses" }, { system: "S", user: "U", ...scope });
  assert.equal(responses.body.prompt_cache_key, promptCacheKey("book/review"));
  const openai = buildChatRequest({ integration: integrationOf("openai", "https://api.openai.com/v1"), model: "gpt-5" }, { system: "S", user: "U", ...scope });
  assert.equal(openai.body.prompt_cache_key, promptCacheKey("book/review"));
  const bare = buildChatRequest({ integration: integrationOf("openai", undefined), model: "gpt-5" }, { system: "S", user: "U", ...scope });
  assert.equal(bare.body.prompt_cache_key, promptCacheKey("book/review"), "OpenAI without an endpoint is api.openai.com");
  // The same request without a scope carries nothing: the provider caches on its own.
  const plain = buildChatRequest({ integration: azure, model: "gpt-5" }, { system: "S", user: "U" });
  assert.equal("prompt_cache_key" in plain.body, false);
  assert.equal(plain.cacheHint, undefined);
  // And the words of the request are the same with and without the hint.
  assert.deepEqual(plain.messages, chat.messages);
});

test("no hint where it is not wanted: a model declared as not caching, a flag that is off, a gateway nobody said caches, GitHub Models", () => {
  const scope = { cacheKey: "book/review" };
  const has = (candidate, options) => "prompt_cache_key" in buildChatRequest(candidate, { system: "S", user: "U", ...scope }, options).body;
  const azure = integrationOf("azure_openai", AZURE);
  assert.equal(has({ integration: azure, model: "m" }), true);
  assert.equal(has({ integration: azure, model: "m", promptCaching: "unsupported" }), false, "the author said it does not");
  assert.equal(has({ integration: azure, model: "m", promptCacheHintsRefused: true }), false, "the provider refused it");
  assert.equal(has({ integration: azure, model: "m" }, { promptCacheHints: false }), false, "the flag is off");
  assert.equal(has({ integration: azure, model: "m" }, { promptCacheHints: true }), true);
  const gateway = integrationOf("openai", "https://llm.example.test/v1");
  assert.equal(has({ integration: gateway, model: "m" }), false, "a gateway that nobody said caches may refuse a field it does not know");
  assert.equal(has({ integration: gateway, model: "m", promptCaching: "supported" }), true, "unless the author says it takes it");
  assert.equal(has({ integration: gateway, model: "m", promptCaching: "learned" }), true);
  assert.equal(has({ integration: integrationOf("github_models", undefined), model: "m", promptCaching: "supported" }), false, "GitHub Models has none");
});

test("an Anthropic model is told where to cache: cache_control on the system message and where the stable start of the prompt ends, at an Anthropic address or a gateway that is said to pass it on, never to another model", () => {
  const openrouter = integrationOf("openai", "https://openrouter.ai/api/v1");
  const user = "STABLE START OF THE PROMPT|and what changes";
  const request = { system: "The system.", user, cacheBreak: user.indexOf("|") + 1, cacheKey: "book/review" };
  const built = buildChatRequest({ integration: openrouter, model: "anthropic/claude-sonnet-4.5" }, request);
  assert.equal(built.cacheHint, "cache_control");
  assert.equal("prompt_cache_key" in built.body, false, "an Anthropic model takes the block, not the key");
  assert.deepEqual(built.body.messages, [
    { role: "system", content: [{ type: "text", text: "The system.", cache_control: { type: "ephemeral" } }] },
    { role: "user", content: [{ type: "text", text: "STABLE START OF THE PROMPT|", cache_control: { type: "ephemeral" } }, { type: "text", text: "and what changes" }] },
  ]);
  assert.deepEqual(built.messages, [{ role: "system", content: "The system." }, { role: "user", content: user }], "what is reported of the request is its words, whole, with no block");
  // Without a break, only the system message is marked, and the user message is sent as it was.
  const nobreak = buildChatRequest({ integration: openrouter, model: "claude-sonnet-4.5" }, { system: "S", user });
  assert.deepEqual(nobreak.body.messages[1], { role: "user", content: user });
  // Parts a host marked are marked, up to the four breakpoints of the provider; an image is not a block of text.
  const parts = buildChatRequest({ integration: openrouter, model: "claude-opus-4" }, {
    system: "", user: "",
    messages: [
      { role: "system", content: [{ type: "text", text: "S1" }, { type: "text", text: "S2" }] },
      { role: "user", content: [{ type: "text", text: "A", cacheBreak: true }, { type: "image", dataUrl: "data:image/png;base64,AA==" }, { type: "text", text: "B", cacheBreak: true }, { type: "text", text: "C", cacheBreak: true }, { type: "text", text: "D", cacheBreak: true }, { type: "text", text: "E", cacheBreak: true }] },
    ],
  });
  const marked = parts.body.messages.flatMap((message) => message.content).filter((part) => part.cache_control).map((part) => part.text);
  assert.deepEqual(marked, ["S2", "A", "B", "C"], "four at most, in order");
  assert.deepEqual(parts.body.messages[1].content[1], { type: "image_url", image_url: { url: "data:image/png;base64,AA==" } });
  // A gateway that is not known to pass it on is not sent it unless the author says it caches; Azure and the Responses API never are.
  const gateway = integrationOf("openai", "https://llm.example.test/v1");
  assert.equal(buildChatRequest({ integration: gateway, model: "claude-sonnet-4.5" }, request).cacheHint, undefined);
  assert.equal(buildChatRequest({ integration: gateway, model: "claude-sonnet-4.5", promptCaching: "supported" }, request).cacheHint, "cache_control");
  assert.equal(buildChatRequest({ integration: integrationOf("azure_openai", AZURE), model: "claude-sonnet-4.5", promptCaching: "supported" }, request).cacheHint, undefined);
  assert.equal(buildChatRequest({ integration: openrouter, model: "claude-sonnet-4.5", apiProtocol: "responses" }, request).cacheHint, undefined);
  assert.equal(buildChatRequest({ integration: openrouter, model: "claude-sonnet-4.5", promptCaching: "unsupported" }, request).cacheHint, undefined);
  assert.equal(buildChatRequest({ integration: openrouter, model: "gpt-5" }, request).cacheHint, undefined, "a model of another family is sent neither: a gateway that nobody said caches may refuse the key");
});

test("the hint is a pure function of the model and its address", () => {
  const azure = { integration: { provider: "azure_openai" }, model: "m" };
  assert.equal(promptCacheHintFor(azure, "https://r.openai.azure.com/openai/v1/chat/completions", "chat-completions"), "prompt_cache_key");
  assert.equal(promptCacheHintFor({ ...azure, promptCaching: "unsupported" }, "https://r.openai.azure.com/x", "chat-completions"), undefined);
  assert.equal(promptCacheHintFor({ integration: { provider: "m365_copilot" }, model: "m", promptCaching: "supported" }, "https://x.test", "chat-completions"), undefined);
  assert.equal(promptCacheHintFor({ integration: { provider: "openai" }, model: "m" }, "not a url", "chat-completions"), undefined);
});

test("only a refusal that names the hint is a refusal of the hint", () => {
  const body = (message, extra = {}) => ({ status: 400, shape: "openai", message, ...extra });
  assert.equal(refusesCacheHint(body("Unrecognized request argument supplied: prompt_cache_key")), true);
  assert.equal(refusesCacheHint(body("Unknown parameter: 'prompt_cache_key'.", { param: "prompt_cache_key" })), true);
  assert.equal(refusesCacheHint(body("Extra inputs are not permitted", { param: "messages.0.content.0.cache_control" })), true);
  assert.equal(refusesCacheHint({ ...body("Extra inputs are not permitted: cache_control"), status: 422 }), true);
  assert.equal(refusesCacheHint(body("Unsupported value: 'prompt-cache-retention'")), true);
  assert.equal(refusesCacheHint(body("max_tokens is too large", { param: "max_tokens" })), false);
  assert.equal(refusesCacheHint({ ...body("prompt_cache_key"), status: 500 }), false);
  assert.equal(refusesCacheHint({ ...body("prompt_cache_key"), status: 401 }), false);
  assert.equal(refusesCacheHint(undefined), false);
});

// ─── Through the client ─────────────────────────────────────────────────────

const HINT_REFUSAL = "Unrecognized request argument supplied: prompt_cache_key";
const hintedAsk = { ...ASK, cacheKey: "book/review" };

test("a provider that refuses prompt_cache_key is asked again without it, once, and the model is learned not to take it: the call is not a failure, and the next request carries none", async () => {
  const { fetch, calls } = recording((entry) => ("prompt_cache_key" in entry.body ? refusalOf(HINT_REFUSAL) : ok()));
  const memory = createModelMemory();
  const learned = [];
  const ends = [];
  const integration = integrationOf("azure_openai", AZURE, { apiVersion: "2025-04-01-preview" });
  const ai = createFetchAi(configOf(integration, [modelOf("gpt-5")]), { fetch, memory, onLearned: (learning) => learned.push(learning), onAttemptEnd: (end) => ends.push(end) });

  const first = await ai.complete(hintedAsk);
  assert.equal(first.text, "ok");
  assert.deepEqual(calls.map((call) => "prompt_cache_key" in call.body), [true, false], "asked again, once, without it");
  assert.deepEqual(ends.map((end) => end.outcome), ["failed", "ok"], "the trail keeps the request that was refused, with the provider's words");
  assert.equal(ends[0].errorBody.message, HINT_REFUSAL);
  assert.equal(learned.length, 1);
  assert.deepEqual([learned[0].kind, learned[0].learned, learned[0].hint, learned[0].model], ["prompt-caching", "hints-rejected", "prompt_cache_key", "gpt-5"]);
  assert.equal(learned[0].body.message, HINT_REFUSAL);
  assert.equal(memory.promptCacheHintsRefused("i", "gpt-5"), true);
  assert.equal(memory.promptCacheHintsRefused("i", "other"), false);

  await ai.complete(hintedAsk);
  assert.deepEqual(calls.map((call) => "prompt_cache_key" in call.body), [true, false, false], "one request, no refusal");
  assert.equal(learned.length, 1, "it is learned once");
});

test("a host that keeps no memory asks again each time, and a refusal that is not the hint's is a failure as it ever was", async () => {
  const { fetch, calls } = recording((entry) => ("prompt_cache_key" in entry.body ? refusalOf(HINT_REFUSAL) : ok()));
  const integration = integrationOf("azure_openai", AZURE, { apiVersion: "2025-04-01-preview" });
  const ai = createFetchAi(configOf(integration, [modelOf("gpt-5")]), { fetch });
  await ai.complete(hintedAsk);
  await ai.complete(hintedAsk);
  assert.equal(calls.length, 4, "twice, each time with the hint and then without");

  const other = recording(() => refusalOf("max_tokens is too large", 400));
  await assert.rejects(createFetchAi(configOf(integration, [modelOf("gpt-5")]), { fetch: other.fetch }).complete(hintedAsk), /max_tokens is too large/);
  assert.equal(other.calls.length, 1, "not repeated: the hint was not what was refused");
});

test("a request that was refused with the hint and then refused without it fails with the second refusal, and teaches nothing", async () => {
  const { fetch, calls } = recording((entry) => ("prompt_cache_key" in entry.body ? refusalOf(HINT_REFUSAL) : refusalOf("The deployment does not exist.", 404)));
  const learned = [];
  const memory = createModelMemory();
  const integration = integrationOf("azure_openai", AZURE, { apiVersion: "2025-04-01-preview" });
  await assert.rejects(createFetchAi(configOf(integration, [modelOf("gpt-5")]), { fetch, memory, onLearned: (learning) => learned.push(learning) }).complete(hintedAsk), /does not exist/);
  assert.equal(calls.length, 2);
  assert.deepEqual(learned, []);
  assert.equal(memory.promptCacheHintsRefused("i", "gpt-5"), false);
});

test("a structured request that is refused for the hint is asked again with its function and its forced choice, and answers", async () => {
  const { fetch, calls } = recording((entry) => ("prompt_cache_key" in entry.body ? refusalOf(HINT_REFUSAL) : toolOk({ prompt_tokens: 10, completion_tokens: 2 })));
  const integration = integrationOf("azure_openai", AZURE, { apiVersion: "2025-04-01-preview" });
  const response = await createFetchAi(configOf(integration, [modelOf("gpt-5")]), { fetch }).complete({ ...JSON_ASK, cacheKey: "book/plan" });
  assert.deepEqual(response.json, { ok: true });
  assert.equal(calls.length, 2);
  assert.deepEqual(calls[1].body.tools, calls[0].body.tools);
  assert.deepEqual(calls[1].body.tool_choice, calls[0].body.tool_choice);
});

test("a response that reports tokens served from the cache teaches that the model caches, once, unless the author said otherwise", async () => {
  const cached = () => ok({ prompt_tokens: 2000, completion_tokens: 3, prompt_tokens_details: { cached_tokens: 1280 } });
  const run = async (promptCaching, memory = createModelMemory()) => {
    const { fetch, calls } = recording(cached);
    const learned = [];
    const gateway = integrationOf("openai", "https://llm.example.test/v1");
    const ai = createFetchAi(configOf(gateway, [modelOf("m", promptCaching ? { promptCaching } : {})]), { fetch, memory, onLearned: (learning) => learned.push(learning) });
    await ai.complete(hintedAsk);
    await ai.complete(hintedAsk);
    return { learned, calls, memory };
  };
  const unknown = await run(undefined);
  assert.equal(unknown.learned.length, 1, "once");
  assert.deepEqual([unknown.learned[0].kind, unknown.learned[0].learned, unknown.learned[0].inputTokens, unknown.learned[0].cachedInputTokens], ["prompt-caching", "cached", 2000, 1280]);
  assert.equal(unknown.memory.promptCaching("i", "m"), "learned");
  assert.deepEqual(unknown.calls.map((call) => "prompt_cache_key" in call.body), [false, true], "a gateway that nobody said caches is sent the key once it was learned to, and not before");
  assert.equal(unknown.memory.learned.length, 1);

  for (const said of ["supported", "unsupported", "learned"]) {
    const result = await run(said);
    assert.deepEqual(result.learned, [], `a model that says ${said} is learned nothing of`);
  }
  // A response that says nothing, or says none, teaches nothing.
  for (const usage of [{ prompt_tokens: 2000, completion_tokens: 3 }, { prompt_tokens: 2000, completion_tokens: 3, prompt_tokens_details: { cached_tokens: 0 } }]) {
    const { fetch } = recording(() => ok(usage));
    const learned = [];
    await createFetchAi(configOf(integrationOf("openai", "https://api.openai.com/v1"), [modelOf("m")]), { fetch, onLearned: (learning) => learned.push(learning) }).complete(hintedAsk);
    assert.deepEqual(learned, []);
  }
});

test("the flag turns the hints off for every model of a configuration", async () => {
  const { fetch, calls } = recording(() => ok());
  const integration = integrationOf("azure_openai", AZURE, { apiVersion: "2025-04-01-preview" });
  await createFetchAi(configOf(integration, [modelOf("gpt-5")], { promptCacheHints: false }), { fetch }).complete(hintedAsk);
  await createFetchAi(configOf(integration, [modelOf("gpt-5")], { promptCacheHints: true }), { fetch }).complete(hintedAsk);
  await createFetchAi(configOf(integration, [modelOf("gpt-5")]), { fetch }).complete(hintedAsk);
  assert.deepEqual(calls.map((call) => "prompt_cache_key" in call.body), [false, true, true]);
});

test("a call to a model that was learned to cache by the host's memory is sent the hint at a gateway, and a model the author said does not cache is not, whatever the memory says", async () => {
  const memory = createModelMemory();
  memory.learn({ kind: "prompt-caching", integrationId: "i", integrationName: "Main", model: "m", learned: "cached", inputTokens: 2000, cachedInputTokens: 1024 });
  memory.learn({ kind: "prompt-caching", integrationId: "i", integrationName: "Main", model: "n", learned: "cached", inputTokens: 2000, cachedInputTokens: 1024 });
  const { fetch, calls } = recording(() => ok());
  const gateway = integrationOf("openai", "https://llm.example.test/v1");
  const config = (name) => configOf(gateway, [modelOf(name, name === "n" ? { promptCaching: "unsupported" } : {})]);
  await createFetchAi(config("m"), { fetch, memory }).complete(hintedAsk);
  await createFetchAi(config("n"), { fetch, memory }).complete(hintedAsk);
  assert.deepEqual(calls.map((call) => "prompt_cache_key" in call.body), [true, false]);
});

// ─── The autopilot ──────────────────────────────────────────────────────────

test("the autopilot names the scope of each of its calls: this book and this task, the same for every chapter, and different for another book", async () => {
  const { AutopilotSession, promptTaskOf } = engine;
  const { MemoryBookStore, createFakeAutopilotAi, seedBookFiles } = await import("../dist/testing/index.js");
  assert.deepEqual(["autopilot:specialists:3", "autopilot:write:2.1", "reader-evaluation:mara", "reader-evaluation-summary", "autopilot:plan-review", "director:final"].map(promptTaskOf), ["autopilot:specialists", "autopilot:write", "reader-evaluation", "reader-evaluation-summary", "autopilot:plan-review", "director"]);
  const scopes = async (bookId) => {
    const ai = createFakeAutopilotAi();
    const session = new AutopilotSession({ bookId, store: new MemoryBookStore(seedBookFiles({ chapters: 2 })), ai, host: "server", hostLabel: "test", retryDelayMs: 0 });
    await session.start({ brief: { idea: "x", targetChapters: 2, scenesPerChapter: 1, wordsPerScene: 300 }, options: { readers: true, maxReaders: 1, readersOnPlan: false, specialists: true, pauseAfterPlan: false } });
    await session.waitForIdle();
    return ai.calls.map((call) => [call.label, call.cacheKey]);
  };
  const first = await scopes("book-one");
  assert.ok(first.length > 10);
  assert.ok(first.every(([, key]) => typeof key === "string" && key.startsWith("book-one/")), "every call names its book");
  const write = first.filter(([label]) => label.startsWith("autopilot:write:")).map(([, key]) => key);
  assert.ok(write.length >= 2 && new Set(write).size === 1 && write[0] === "book-one/autopilot:write", "the scenes of every chapter share one scope");
  assert.ok(new Set(first.map(([, key]) => key)).size > 4, "and each task has its own");
  const other = await scopes("book-two");
  assert.ok(other.every(([, key]) => key.startsWith("book-two/")));
});
