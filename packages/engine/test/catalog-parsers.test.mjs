import test from "node:test";
import assert from "node:assert/strict";
import * as engine from "../dist/index.js";
import { BGE, DETAILS_EXAMPLE, LEGACY, LMSTUDIO_MODELS, MODALITIES_EXAMPLE, MODELS_EXAMPLE, MUSE, OWNER_DETAILS, OWNER_IDS, OWNER_MODALITIES, OWNER_MODELS, detail } from "./catalog-fakes.mjs";

// New exports are read from the namespace so that, before they exist, each test fails on its own.
const { AiCatalogError, AI_MODEL_TYPES, lmStudioContext, modelFieldsFromCatalogEntry, parseLmStudioModels, parseModalities, parseModelDetails, parseModelList, tokenLimitsFromDetails } = engine;

const typed = (error, reason) => error instanceof AiCatalogError && error.name === "AiCatalogError" && error instanceof Error && (reason === undefined || error.reason === reason);
const entries = (count, make = (index) => ({ id: `model-${index}` })) => Array.from({ length: count }, (_, index) => make(index));

// ─── parseModelList: GET /models ────────────────────────────────────────────

test("parseModelList: the OpenAI list becomes the ids, sorted and without repeats", () => {
  assert.deepEqual(parseModelList({ object: "list", data: [{ id: "zeta" }, { id: "alpha" }, { id: "zeta" }, { id: "Beta" }] }), ["Beta", "alpha", "zeta"]);
  assert.deepEqual(parseModelList(MODELS_EXAMPLE), ["agic-code-fast"], "the contract's own example");
  assert.deepEqual(parseModelList(OWNER_MODELS), [...OWNER_IDS].sort(), "the owner's gateway");
  assert.deepEqual(parseModelList({ data: [{ id: "qwen/qwen3-4b" }, { id: "ünï-模型" }, { id: "gpt-4o-2024-08-06" }] }), ["gpt-4o-2024-08-06", "qwen/qwen3-4b", "ünï-模型"], "the ids are the provider's words, whatever they are");
  assert.equal(typeof AiCatalogError, "function");
});

test("parseModelList: the limits are those of BookWriter's fetchModels (2000 models, 256 characters), exact at the edge", () => {
  assert.equal(parseModelList({ data: entries(2000) }).length, 2000);
  assert.throws(() => parseModelList({ data: entries(2001) }), (error) => typed(error, "too-large"));
  assert.equal(parseModelList({ data: [{ id: "x".repeat(256) }] })[0].length, 256);
  assert.throws(() => parseModelList({ data: [{ id: "x".repeat(257) }] }), (error) => typed(error, "invalid"));
  assert.equal(engine.CATALOG_MAX_MODELS, 2000);
  assert.equal(engine.CATALOG_MAX_ID_LENGTH, 256);
});

test("parseModelList: a payload that is not a list of models is one typed error, never partial values", () => {
  const bad = [
    undefined, null, [], "text", 42, true, {}, { data: null }, { data: {} }, { data: "x" }, { object: "list" },
    { data: [null] }, { data: [42] }, { data: ["text"] }, { data: [[]] }, { data: [{}] },
    { data: [{ id: 17 }] }, { data: [{ id: {} }] }, { data: [{ id: [] }] }, { data: [{ id: null }] },
    { data: [{ id: "" }] }, { data: [{ id: "   " }] }, { data: [{ id: " leading" }] }, { data: [{ id: "trailing " }] },
    { data: [{ id: "a\nb" }] }, { data: [{ id: "a\u0000b" }] }, { data: [{ id: "a\u007fb" }] }, { data: [{ id: "a\u0085b" }] }, { data: [{ id: "tab\there" }] },
    { data: [{ id: "valid" }, { id: null }] },
    { data: [{ id: "__proto__" }] }, { data: [{ id: "constructor" }] }, { data: [{ id: "prototype" }] },
    { data: entries(10_000) },
  ];
  for (const payload of bad) assert.throws(() => parseModelList(payload), (error) => typed(error), JSON.stringify(payload)?.slice(0, 80));
  assert.throws(() => parseModelList({ data: [] }), (error) => typed(error, "empty"), "an empty list is no catalog: nothing is replaced by it");
});

test("parseModelList: a list that says it goes on is a page and not the catalog: it is refused, because the rest of it would never be seen", () => {
  // Anthropic's own `GET /v1/models` (verified against its documentation): entries with an id, 20 to a page by default, and `has_more`.
  const page = { data: [{ type: "model", id: "claude-a", display_name: "Claude A", created_at: "2026-01-01T00:00:00Z" }], first_id: "claude-a", has_more: true, last_id: "claude-a" };
  assert.throws(() => parseModelList(page), (error) => typed(error, "too-large") && /pages/.test(error.message) && /by hand/.test(error.message) && !error.message.includes("claude"));
  assert.deepEqual(parseModelList({ ...page, has_more: false }), ["claude-a"], "the last page is the whole catalog");
  for (const word of ["true", 1, null, undefined, {}, []]) assert.deepEqual(parseModelList({ ...page, has_more: word }), ["claude-a"], `has_more ${JSON.stringify(word)} says nothing: only the boolean does`);
  assert.throws(() => parseModelList({ data: [], has_more: true }), (error) => typed(error, "too-large"), "a page with nothing in it that goes on is still a page");
});

test("parseModelList: the message is the same for every payload, says what to do and never quotes the payload", () => {
  const poison = "sk-live-LEAKED-0123456789-ABCDEF";
  const hostile = [
    { data: [{ id: `${poison}\u0000` }] },
    { data: [{ id: `${poison} ` }] },
    { data: [{ id: poison.repeat(20) }] },
    { data: [{ id: 5, secret: poison }], note: poison },
    { data: poison },
    { [poison]: poison },
    { data: Array.from({ length: 5000 }, () => ({ id: poison })) },
  ];
  for (const payload of hostile) {
    const error = (() => { try { parseModelList(payload); } catch (failure) { return failure; } return null; })();
    assert.ok(typed(error), JSON.stringify(payload).slice(0, 60));
    assert.equal(error.message.includes("LEAKED"), false, error.message);
    assert.match(error.message, /by hand/i, "the remedy is there");
    assert.ok(error.message.length < 400);
  }
});

test("parseModelList: a proxy or a getter that throws is no way to crash the parser: it is a typed error too", () => {
  const trap = new Proxy({}, { get() { throw new Error("no property can be read"); } });
  assert.throws(() => parseModelList(trap), (error) => typed(error));
  assert.throws(() => parseModelList({ data: [trap] }), (error) => typed(error));
  const getter = { get data() { throw new Error("boom"); } };
  assert.throws(() => parseModelList(getter), (error) => typed(error));
  const holey = [{ id: "a" }];
  Object.defineProperty(holey, 1, { enumerable: true, get() { throw new Error("boom"); } });
  assert.throws(() => parseModelList({ data: holey }), (error) => typed(error));
});

// ─── parseModelDetails: GET /models/details ─────────────────────────────────

test("parseModelDetails: the contract's own example becomes an entry; a gateway that does not say the type has the type `unknown`", () => {
  assert.deepEqual(parseModelDetails(DETAILS_EXAMPLE), [{
    id: "muse",
    type: "unknown",
    contextWindow: 131072,
    maxOutputTokens: 8192,
    inputModalities: ["text", "image"],
    outputModalities: ["text"],
    capabilities: { streaming: true, tools: true, vision: true, reasoning: true },
  }]);
});

test("parseModelDetails: the owner's gateway, entry by entry: what is declared is there, `null` is absent and `false` stays false", () => {
  const parsed = parseModelDetails(OWNER_DETAILS);
  assert.deepEqual(parsed.map((entry) => [entry.id, entry.type]), [["muse-glimmer-30b", "chat"], ["legacy-8b", "chat"], ["bge-m3", "embedding"], ["flux-schnell", "image"], ["kokoro", "speech"], ["whisper-large", "transcription"]], "in the order received");
  assert.deepEqual(parsed[0], {
    id: "muse-glimmer-30b",
    type: "chat",
    contextWindow: 131072,
    maxOutputTokens: 8192,
    inputModalities: ["text", "image"],
    outputModalities: ["text"],
    capabilities: { streaming: true, tools: true, vision: true, reasoning: true },
  });
  assert.deepEqual(parsed[1], { id: "legacy-8b", type: "chat", inputModalities: ["text"], outputModalities: ["text"], capabilities: { streaming: false, tools: false, vision: false, reasoning: false } }, "nothing declared: no numbers at all, never a 0");
  assert.equal(parsed[2].contextWindow, 8192, "an embedding model has a context and no maximum answer");
  assert.equal("maxOutputTokens" in parsed[2], false);
  assert.deepEqual(parsed[2].outputModalities, ["embedding"]);
  assert.deepEqual(parsed[3].outputModalities, ["image"]);
  assert.deepEqual(parsed[5].inputModalities, ["audio"]);
});

test("parseModelDetails: a number is a whole number from 256 to 10 000 000, anything else is not declared (never a 0)", () => {
  const read = (context_window, max_output_tokens) => parseModelDetails({ data: [{ id: "m", context_window, max_output_tokens }] })[0];
  assert.equal(read(256, 256).contextWindow, 256);
  assert.equal(read(10_000_000, 10_000_000).maxOutputTokens, 10_000_000);
  for (const value of [null, undefined, 0, -1, -8192, 255, 10_000_001, Number.MAX_SAFE_INTEGER, Number.MAX_SAFE_INTEGER + 1, 8192.5, Number.NaN, Number.POSITIVE_INFINITY, Number.NEGATIVE_INFINITY, "8192", "131072 ", "", true, false, [], [8192], {}, { value: 8192 }]) {
    const entry = read(value, value);
    assert.equal("contextWindow" in entry, false, `context_window ${JSON.stringify(value)}`);
    assert.equal("maxOutputTokens" in entry, false, `max_output_tokens ${JSON.stringify(value)}`);
  }
  assert.equal(engine.CATALOG_MIN_TOKENS, 256);
  assert.equal(engine.CATALOG_MAX_TOKENS, 10_000_000);
});

test("parseModelDetails: a capability is a boolean or it is not declared", () => {
  const caps = (capabilities) => parseModelDetails({ data: [{ id: "m", capabilities }] })[0].capabilities;
  assert.deepEqual(caps({ streaming: true, tools: false, vision: true, reasoning: false }), { streaming: true, tools: false, vision: true, reasoning: false });
  assert.deepEqual(caps({ streaming: "yes", tools: 1, vision: null, reasoning: {} }), {});
  assert.deepEqual(caps({ streaming: true, extra: true, tools: [true] }), { streaming: true });
  for (const junk of [undefined, null, "x", 5, [], [true], true]) assert.deepEqual(caps(junk), {}, JSON.stringify(junk));
});

test("parseModelDetails: the type is one of the gateway's kinds, whatever the case; any other word is `unknown`", () => {
  const typeOf = (type) => parseModelDetails({ data: [{ id: "m", type }] })[0].type;
  for (const known of AI_MODEL_TYPES) assert.equal(typeOf(known), known);
  assert.deepEqual([...AI_MODEL_TYPES], ["chat", "image", "speech", "transcription", "embedding", "realtime", "classifier"]);
  assert.equal(typeOf(" Chat "), "chat");
  assert.equal(typeOf("EMBEDDING"), "embedding");
  for (const other of ["llm", "unknown", "audio", "", "chat completions", 5, null, undefined, {}, [], true, "__proto__"]) assert.equal(typeOf(other), "unknown", JSON.stringify(other));
});

test("parseModelDetails: the modalities are short lower-case words, a few of them; a list that is not one is not declared", () => {
  const modalities = (input_modalities, output_modalities) => parseModelDetails({ data: [{ id: "m", input_modalities, output_modalities }] })[0];
  assert.deepEqual(modalities(["Text", " image ", "text"], ["audio"]), { id: "m", type: "unknown", capabilities: {}, inputModalities: ["text", "image"], outputModalities: ["audio"] });
  const hostile = modalities([5, null, "", "x".repeat(33), "has space", "a\nb", "ok-one", {}, [], "__proto__", "constructor"], "text");
  assert.deepEqual(hostile.inputModalities, ["ok-one"], "what is not a short word is dropped, and so is a word that names a prototype");
  assert.equal(modalities(Array.from({ length: 100 }, (_, index) => `kind${index}`), []).inputModalities.length, 16, "at most 16");
  for (const junk of ["text", 5, null, {}, [], [5], [""]]) {
    const entry = modalities(junk, junk);
    assert.equal("inputModalities" in entry, false, JSON.stringify(junk));
    assert.equal("outputModalities" in entry, false);
  }
});

test("parseModelDetails: an entry that cannot be an entry is left out, the others stay, and nothing can be an id of a prototype", () => {
  const parsed = parseModelDetails({ data: [
    null, 7, "x", [], {}, { id: 3 }, { id: "" }, { id: " a" }, { id: "a\u0000" }, { id: "x".repeat(257) },
    { id: "__proto__", context_window: 8192 }, { id: "constructor" }, { id: "prototype" },
    { id: "good-1" }, { id: "good-2", type: "chat" },
  ] });
  assert.deepEqual(parsed.map((entry) => entry.id), ["good-1", "good-2"]);
  assert.deepEqual(parseModelDetails({ data: [{ id: "twice", context_window: 4096 }, { id: "twice", context_window: 8192 }] }).map((entry) => entry.contextWindow), [4096], "the first of an id is the one that is kept");
  assert.equal(Object.getPrototypeOf(parsed[0]), Object.prototype);
  assert.equal(({}).polluted, undefined);
});

test("parseModelDetails: 10 000 entries are cut at 2000, and a payload that is not a list is a typed error", () => {
  assert.equal(parseModelDetails({ data: entries(10_000) }).length, 2000);
  assert.deepEqual(parseModelDetails({ data: [] }), [], "a gateway with nothing running has a list with nothing in it");
  for (const bad of [undefined, null, [], "x", 5, {}, { data: null }, { data: "x" }, { data: {} }, { object: "list" }]) assert.throws(() => parseModelDetails(bad), (error) => typed(error, "invalid"), JSON.stringify(bad));
  const trap = new Proxy({}, { get() { throw new Error("no"); } });
  assert.throws(() => parseModelDetails(trap), (error) => typed(error));
  assert.doesNotThrow(() => parseModelDetails({ data: [trap, { id: "ok" }] }), "an entry that throws is an entry that is left out");
  assert.deepEqual(parseModelDetails({ data: [trap, { id: "ok" }] }).map((entry) => entry.id), ["ok"]);
});

// ─── parseModalities: GET /modalities ───────────────────────────────────────

test("parseModalities: the contract's own example: the types in the order received, the one with nothing running included", () => {
  assert.deepEqual(parseModalities(MODALITIES_EXAMPLE), [
    {
      type: "chat",
      endpoints: ["/v1/chat/completions", "/v1/responses"],
      inputModalities: ["text", "image"],
      outputModalities: ["text"],
      modelCount: 2,
      models: [{ id: "agic-code-fast", type: "chat", capabilities: { streaming: true } }],
    },
    { type: "image", endpoints: ["/v1/images/generations"], modelCount: 0, models: [] },
  ]);
});

test("parseModalities: the owner's gateway: seven types, in the order the gateway lists them, each with the models of its kind", () => {
  const groups = parseModalities(OWNER_MODALITIES);
  assert.deepEqual(groups.map((group) => group.type), ["chat", "image", "speech", "transcription", "embedding", "realtime", "classifier"]);
  assert.deepEqual(groups.map((group) => group.modelCount), [2, 1, 1, 1, 1, 0, 0]);
  assert.deepEqual(groups[0].models.map((model) => model.id), ["legacy-8b", "muse-glimmer-30b"]);
  assert.deepEqual(groups[0].inputModalities, ["text", "image"], "chat lists image because a running model has vision");
  assert.deepEqual(groups[0].models[1], parseModelDetails({ data: [MUSE] })[0], "each model is what /models/details says of it");
  assert.deepEqual(groups[5], { type: "realtime", endpoints: ["/v1/realtime"], inputModalities: ["audio", "text"], outputModalities: ["audio", "text"], modelCount: 0, models: [] });
  assert.deepEqual(groups[6].endpoints, ["/v1/systemone"]);
  const reversed = parseModalities({ data: [...OWNER_MODALITIES.data].reverse() });
  assert.deepEqual(reversed.map((group) => group.type), ["classifier", "realtime", "embedding", "transcription", "speech", "image", "chat"], "the order is the gateway's, not ours");
});

test("parseModalities: a model with no type of its own is of the type of its group, and an unknown group is kept as `unknown`", () => {
  const groups = parseModalities({ data: [
    { type: "embedding", endpoints: ["/v1/embeddings"], models: [{ id: "bge" }, { id: "odd", type: "chat" }] },
    { type: "teleport", endpoints: [], models: [{ id: "t" }] },
    { endpoints: [], models: [] },
  ] });
  assert.deepEqual(groups[0].models.map((model) => [model.id, model.type]), [["bge", "embedding"], ["odd", "chat"]]);
  assert.deepEqual(groups.map((group) => group.type), ["embedding", "unknown", "unknown"]);
  assert.equal(groups[1].models[0].type, "unknown");
});

test("parseModalities: the count is the gateway's when it is a count, else the models that were read", () => {
  const count = (model_count, models = [{ id: "a" }, { id: "b" }]) => parseModalities({ data: [{ type: "chat", model_count, models }] })[0].modelCount;
  assert.equal(count(7), 7);
  assert.equal(count(0), 0);
  for (const junk of [undefined, null, -1, 1.5, Number.NaN, "3", [], {}, 1e9, Number.MAX_SAFE_INTEGER]) assert.equal(count(junk), 2, JSON.stringify(junk));
});

test("parseModalities: the endpoints of a type are short paths, a few of them", () => {
  const endpointsOf = (endpoints) => parseModalities({ data: [{ type: "chat", endpoints, models: [] }] })[0].endpoints;
  assert.deepEqual(endpointsOf(["/v1/chat/completions", "/v1/chat/completions", "/v1/responses"]), ["/v1/chat/completions", "/v1/responses"]);
  assert.deepEqual(endpointsOf([5, null, "", "no-slash", "/with space", "/a\nb", "/" + "x".repeat(200), {}, "/ok"]), ["/ok"]);
  assert.equal(endpointsOf(Array.from({ length: 100 }, (_, index) => `/v1/e${index}`)).length, 16);
  for (const junk of ["/v1/x", 5, null, undefined, {}]) assert.deepEqual(endpointsOf(junk), [], JSON.stringify(junk));
});

test("parseModalities: hostile payloads are bounded: 32 types, 2000 models in a type, and a payload that is not a list is a typed error", () => {
  const many = parseModalities({ data: Array.from({ length: 10_000 }, () => ({ type: "chat", models: [] })) });
  assert.equal(many.length, 32);
  const crowded = parseModalities({ data: [{ type: "chat", models: entries(10_000) }] });
  assert.equal(crowded[0].models.length, 2000);
  assert.deepEqual(parseModalities({ data: [{ type: "chat", models: "nope" }] })[0].models, []);
  assert.deepEqual(parseModalities({ data: [null, 5, "x", [], { type: "chat", models: [] }] }).map((group) => group.type), ["chat"], "what is no group is left out");
  assert.deepEqual(parseModalities({ data: [] }), []);
  for (const bad of [undefined, null, [], "x", 5, {}, { data: null }, { data: "x" }]) assert.throws(() => parseModalities(bad), (error) => typed(error, "invalid"), JSON.stringify(bad));
});

// ─── tokenLimitsFromDetails: BookWriter's formula ───────────────────────────

test("tokenLimitsFromDetails: input is the window minus the declared answer; with no declared answer, minus a quarter of the window up to 4096", () => {
  const limits = (contextWindow, maxOutputTokens) => tokenLimitsFromDetails({ ...(contextWindow === undefined ? {} : { contextWindow }), ...(maxOutputTokens === undefined ? {} : { maxOutputTokens }) });
  // The cases of BookWriter's own tests (`ai-model-details.test.ts`).
  assert.deepEqual(limits(32768, 4096), { inputTokens: 28672, outputTokens: 4096 });
  assert.deepEqual(limits(32768, undefined), { inputTokens: 32768 - 4096 });
  assert.deepEqual(limits(undefined, 2048), { outputTokens: 2048 }, "an answer with no window is only the answer");
  assert.deepEqual(limits(undefined, undefined), {});
  assert.deepEqual(limits(1000, 5000), { inputTokens: 1000 - 250 }, "an answer that does not fit the window is not believed");
  // The real values of the owner's gateway.
  assert.deepEqual(limits(131072, 8192), { inputTokens: 122880, outputTokens: 8192 });
  assert.deepEqual(limits(131072, undefined), { inputTokens: 131072 - 4096 });
  assert.deepEqual(limits(8192, undefined), { inputTokens: 8192 - 2048 });
});

test("tokenLimitsFromDetails: an input that is not a usable number is not said, and an answer is never as big as its window", () => {
  const limits = (contextWindow, maxOutputTokens) => tokenLimitsFromDetails({ contextWindow, maxOutputTokens });
  assert.deepEqual(limits(256, undefined), {}, "256 − 64 is under the least a window may leave");
  assert.deepEqual(limits(300, undefined), {}, "300 − 75 = 225");
  assert.deepEqual(limits(400, undefined), { inputTokens: 300 });
  assert.deepEqual(limits(1000, 1000), { inputTokens: 750 }, "an answer as big as the window leaves no input: it is the guess that is used");
  assert.deepEqual(limits(1000, 999), { outputTokens: 999 }, "an answer that leaves an input of 1 leaves no input to say");
  for (const [window, answer] of [[256, 256], [300, 256], [512, 300], [10_000_000, 10_000_000], [5000, 4999], [262144, 262143]]) {
    const result = limits(window, answer);
    if ("inputTokens" in result) assert.ok(result.inputTokens >= 256 && result.inputTokens <= 10_000_000, `${window}/${answer}: ${JSON.stringify(result)}`);
    assert.ok(!("outputTokens" in result) || result.outputTokens < window, `${window}/${answer}`);
  }
  assert.deepEqual(tokenLimitsFromDetails({}), {});
  assert.deepEqual(tokenLimitsFromDetails({ contextWindow: "131072", maxOutputTokens: -1 }), {}, "what the parser would not have kept is not used");
  assert.deepEqual(tokenLimitsFromDetails(null), {});
  assert.deepEqual(tokenLimitsFromDetails("x"), {});
});

test("tokenLimitsFromDetails: on an entry that was read from the owner's gateway", () => {
  const [muse, legacy, bge] = parseModelDetails(OWNER_DETAILS);
  assert.deepEqual(tokenLimitsFromDetails(muse), { inputTokens: 122880, outputTokens: 8192 });
  assert.deepEqual(tokenLimitsFromDetails(legacy), {});
  assert.deepEqual(tokenLimitsFromDetails(bge), { inputTokens: 8192 - 2048 });
});

// ─── What an entry says about the model config ──────────────────────────────

test("modelFieldsFromCatalogEntry: the window is what the engine keeps as `maxInputTokens` (it subtracts the answer itself), never BookWriter's input", () => {
  const [muse] = parseModelDetails({ data: [MUSE] });
  assert.deepEqual(modelFieldsFromCatalogEntry(muse), {
    maxInputTokens: 131072,
    maxOutputTokens: 8192,
    supportsToolCalls: true,
    supportsStreaming: true,
    supportsReasoning: true,
    supportsVision: true,
  });
  assert.notEqual(modelFieldsFromCatalogEntry(muse).maxInputTokens, tokenLimitsFromDetails(muse).inputTokens, "the two are not the same number, and the difference is the answer that would be taken off twice");
});

test("modelFieldsFromCatalogEntry: only what the gateway declares is said: `false` is what it sends for what nobody declared, so it is never a restriction", () => {
  const [legacy] = parseModelDetails({ data: [LEGACY] });
  assert.deepEqual(legacy.capabilities, { streaming: false, tools: false, vision: false, reasoning: false });
  assert.deepEqual(modelFieldsFromCatalogEntry(legacy), {}, "a model that streams, with the box not ticked, must go on streaming");
  const mixed = parseModelDetails({ data: [detail("m", "chat", { context_window: 32768, capabilities: { streaming: false, tools: true, vision: null, reasoning: "x" } })] })[0];
  assert.deepEqual(modelFieldsFromCatalogEntry(mixed), { maxInputTokens: 32768, supportsToolCalls: true });
  assert.deepEqual(modelFieldsFromCatalogEntry({ id: "x", type: "unknown", capabilities: {} }), {}, "an id that only /models listed says nothing");
});

test("modelFieldsFromCatalogEntry: an answer that does not fit its window, or has none, follows the same rules as the limits", () => {
  const fields = (context_window, max_output_tokens) => modelFieldsFromCatalogEntry(parseModelDetails({ data: [{ id: "m", context_window, max_output_tokens }] })[0]);
  assert.deepEqual(fields(1000, 5000), { maxInputTokens: 1000 });
  assert.deepEqual(fields(null, 2048), { maxOutputTokens: 2048 });
  assert.deepEqual(fields(32768, null), { maxInputTokens: 32768 });
  assert.deepEqual(fields(null, null), {});
});

// ─── parseLmStudioModels: LM Studio GET /api/v1/models ──────────────────────

test("parseLmStudioModels: the models of LM Studio: the thinking levels each declares, and the context it loaded and can take", () => {
  const models = parseLmStudioModels(LMSTUDIO_MODELS);
  assert.deepEqual(models.map((model) => model.key), ["qwen/qwen3-4b", "openai/gpt-oss-20b", "plain-model"], "only the language models, in the order received");
  assert.deepEqual(models[0], { key: "qwen/qwen3-4b", reasoning: null, maxContext: 262144, loaded: [{ id: "qwen/qwen3-4b", contextLength: 8192 }] }, "off and on are no levels: the model has no level to choose");
  assert.deepEqual(models[1], { key: "openai/gpt-oss-20b", reasoning: { options: ["low", "medium", "high"], default: "medium" }, maxContext: 131072, loaded: [] }, "the levels come in the engine's own order");
  assert.deepEqual(models[2], { key: "plain-model", maxContext: 4096, loaded: [] }, "a server that says nothing of reasoning leaves it unknown");
});

test("parseLmStudioModels: a default is kept only when it is one of the levels the model allows; xhigh is a level", () => {
  const read = (reasoning) => parseLmStudioModels({ models: [{ type: "llm", key: "m", capabilities: { reasoning } }] })[0].reasoning;
  assert.deepEqual(read({ allowed_options: ["low", "high", "xhigh", "medium"], default: "high" }), { options: ["low", "medium", "high", "xhigh"], default: "high" });
  assert.deepEqual(read({ allowed_options: ["low", "medium"], default: "xhigh" }), { options: ["low", "medium"] }, "a default the model does not allow is dropped");
  assert.deepEqual(read({ allowed_options: ["low", "low", "bogus", 5, null, "LOW"] }), { options: ["low"] });
  for (const none of [{}, { allowed_options: [] }, { allowed_options: "low" }, { allowed_options: ["off", "on"] }, null, "low", 5, []]) assert.equal(read(none), null, JSON.stringify(none));
  assert.equal(parseLmStudioModels({ models: [{ type: "llm", key: "m", capabilities: [] }] })[0].reasoning, undefined, "no capabilities block: unknown");
  assert.equal(parseLmStudioModels({ models: [{ type: "llm", key: "m", capabilities: null }] })[0].reasoning, undefined);
});

test("parseLmStudioModels: the contexts are whole numbers from 256 to 10 000 000, and the instances that are loaded are few", () => {
  const read = (extra) => parseLmStudioModels({ models: [{ type: "llm", key: "m", ...extra }] })[0];
  assert.deepEqual(read({ max_context_length: 4096, loaded_instances: [{ id: "m", config: { context_length: 2048 } }] }), { key: "m", maxContext: 4096, loaded: [{ id: "m", contextLength: 2048 }] });
  for (const junk of [0, -1, 255, 10_000_001, 4096.5, "4096", null, Number.NaN, true, {}, []]) {
    const model = read({ max_context_length: junk, loaded_instances: [{ id: "m", config: { context_length: junk } }] });
    assert.equal("maxContext" in model, false, JSON.stringify(junk));
    assert.deepEqual(model.loaded, [{ id: "m" }], JSON.stringify(junk));
  }
  assert.deepEqual(read({ loaded_instances: "nope" }).loaded, []);
  assert.deepEqual(read({ loaded_instances: [null, 5, "x", [], {}, { id: "" }, { id: "ok" }] }).loaded, [{ id: "ok" }]);
  assert.equal(read({ loaded_instances: Array.from({ length: 100 }, (_, index) => ({ id: `i${index}` })) }).loaded.length, 16);
});

test("parseLmStudioModels: hostile data: 500 models at most, keys of 200 characters at most, no prototypes, and a payload that is not a list is a typed error", () => {
  const many = parseLmStudioModels({ models: Array.from({ length: 1000 }, (_, index) => ({ type: "llm", key: `m${index}` })) });
  assert.equal(many.length, 500);
  assert.equal(engine.LMSTUDIO_MAX_MODELS, 500);
  assert.equal(engine.LMSTUDIO_MAX_KEY_LENGTH, 200);
  const keys = parseLmStudioModels({ models: [
    { type: "llm", key: "x".repeat(200) }, { type: "llm", key: "x".repeat(201) }, { type: "llm", key: "  spaced  " }, { type: "llm", key: "" }, { type: "llm", key: "   " },
    { type: "llm", key: "__proto__" }, { type: "llm", key: "constructor" }, { type: "llm", key: "prototype" }, { type: "llm", key: 5 }, { type: "llm" }, { type: "LLM", key: "upper" },
    null, 7, "x", [], { type: "embedding", key: "emb" }, { type: "llm", key: "a\u0000b" },
  ] }).map((model) => model.key);
  assert.deepEqual(keys, ["x".repeat(200), "spaced"]);
  for (const bad of [undefined, null, [], "x", 5, {}, { models: null }, { models: "x" }, { models: {} }, { data: [] }]) assert.throws(() => parseLmStudioModels(bad), (error) => typed(error, "invalid"), JSON.stringify(bad));
  assert.deepEqual(parseLmStudioModels({ models: [] }), []);
});

test("lmStudioContext: the context of one model, found by its key or by the id of a loaded instance, as BookWriter finds it", () => {
  const models = parseLmStudioModels({ models: [
    { type: "llm", key: "a", max_context_length: 32768, loaded_instances: [{ id: "a", config: { context_length: 8192 } }, { id: "a:2", config: { context_length: 4096 } }] },
    { type: "llm", key: "b", max_context_length: 16384, loaded_instances: [] },
    { type: "llm", key: "c", loaded_instances: [{ id: "c" }] },
  ] });
  assert.deepEqual(lmStudioContext(models, "a"), { loaded: 8192, max: 32768 });
  assert.deepEqual(lmStudioContext(models, "a:2"), { loaded: 4096, max: 32768 }, "by the instance");
  assert.deepEqual(lmStudioContext(models, "b"), { max: 16384 }, "nothing loaded");
  assert.deepEqual(lmStudioContext(models, "c"), {});
  assert.equal(lmStudioContext(models, "nobody"), undefined);
  assert.equal(lmStudioContext([], "a"), undefined);
  const real = parseLmStudioModels(LMSTUDIO_MODELS);
  assert.deepEqual(lmStudioContext(real, "qwen/qwen3-4b"), { loaded: 8192, max: 262144 });
  assert.deepEqual(lmStudioContext(real, "openai/gpt-oss-20b"), { max: 131072 });
});

test("the catalog's names are exported, and the limits are the ones the documentation names", () => {
  for (const name of ["AiCatalogError", "AI_MODEL_TYPES", "CATALOG_MAX_MODELS", "CATALOG_MAX_ID_LENGTH", "CATALOG_MIN_TOKENS", "CATALOG_MAX_TOKENS", "CATALOG_MAX_BYTES", "CATALOG_TIMEOUT_MS", "LMSTUDIO_MAX_MODELS", "LMSTUDIO_MAX_KEY_LENGTH", "parseModelList", "parseModelDetails", "parseModalities", "tokenLimitsFromDetails", "modelFieldsFromCatalogEntry", "parseLmStudioModels", "lmStudioContext"]) assert.notEqual(engine[name], undefined, name);
});
