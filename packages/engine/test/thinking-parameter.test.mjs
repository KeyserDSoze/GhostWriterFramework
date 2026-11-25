import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import * as engine from "../dist/index.js";
import { ASK, JSON_ASK, SCHEMA, integration, recording } from "./transport-fakes.mjs";

// New exports are read from the namespace so that, before they exist, each test fails on its own.
const { AI_REASONING_PARAMETERS, AiProviderError, applyReasoningLevel, buildChatRequest, createFetchAi, normalizeReasoningParameter, pickAiRuntimeConfig, redactAiRuntimeConfig, resolveAiCandidates, suggestedReasoningParameter } = engine;

const TEMPLATE = "chat_template_kwargs.reasoning_strength";
const MODEL = "muse-glimmer-30b";
const LEVELS = ["low", "medium", "high", "xhigh"];
const PROSE = { system: "S", user: "U" };
const STRUCTURED = { system: "S", user: "U", json: SCHEMA };
const OLD_MODEL_KEYS = ["capabilities", "id", "maxInputTokens", "maxOutputTokens", "name", "pricing", "supportsToolCalls", "underlyingModel"];

/** What the engine built before the thinking parameter existed (commit 97656c0), captured from that very build: see the note in the file. */
const golden = JSON.parse(readFileSync(new URL("./fixtures/thinking-parameter-golden.json", import.meta.url), "utf8"));

const reply = (text = "Hi") => Response.json({ choices: [{ message: { content: text }, finish_reason: "stop" }] });
const answer = (entry) => (entry.body.tools
  ? Response.json({ choices: [{ message: { tool_calls: [{ function: { name: "result", arguments: "{\"ok\":true}" } }] }, finish_reason: "tool_calls" }] })
  : reply("Fine."));
const failing = (status, error) => new Response(JSON.stringify({ error }), { status, headers: { "content-type": "application/json" } });
const hostOf = (entry) => new URL(entry.url).hostname.replace(".test", "");

/** A configuration with one model that sets `flags`, in an integration that says `integrationExtra`. */
const withModel = (flags = {}, integrationExtra = {}, more = {}) => ({ aiIntegrations: [integration({ chatModels: [{ id: "m", name: MODEL, capabilities: ["default"], ...flags }], ...integrationExtra })], ...more });
const candidateOf = (flags, integrationExtra, more) => resolveAiCandidates(pickAiRuntimeConfig(withModel(flags, integrationExtra, more)), "autopilot")[0];
/** A candidate built by hand, as a host that tests its configuration against `buildChatRequest` does. */
const candidate = (extra = {}, integrationExtra = {}) => ({ integration: integration(integrationExtra), model: MODEL, ...extra });

const PROVIDERS = [
  ["an OpenAI-compatible endpoint", {}],
  ["Azure OpenAI", { provider: "azure_openai", endpoint: "https://x.openai.azure.com", apiVersion: "2024-10-21" }],
  ["GitHub Models", { provider: "github_models", endpoint: undefined }],
];

// ─── The configuration ──────────────────────────────────────────────────────

test("a model's thinking parameter is one of three exact words, which the configuration keeps; anything else it drops, and absent is how it always was", () => {
  assert.deepEqual([...AI_REASONING_PARAMETERS], ["reasoning_effort", TEMPLATE, "none"], "the closed list is exported for the screens that offer it");
  for (const value of AI_REASONING_PARAMETERS) {
    assert.equal(pickAiRuntimeConfig(withModel({ reasoningParameter: value })).aiIntegrations[0].chatModels[0].reasoningParameter, value, value);
    assert.equal(normalizeReasoningParameter(value), value);
  }
  const junk = ["", " none", "none ", "None", "NONE", "reasoning-effort", "reasoning_strength", "chat_template_kwargs", "chat_template_kwargs.reasoning_effort", "Chat_Template_Kwargs.Reasoning_Strength", "effort", "default", null, undefined, 0, 1, true, false, Number.NaN, {}, [], ["none"], { value: "none" }];
  for (const value of junk) {
    assert.equal("reasoningParameter" in pickAiRuntimeConfig(withModel({ reasoningParameter: value })).aiIntegrations[0].chatModels[0], false, JSON.stringify(value));
    assert.equal(normalizeReasoningParameter(value), undefined, JSON.stringify(value));
  }
  const old = pickAiRuntimeConfig(withModel({ supportsToolCalls: false, maxInputTokens: 8192, maxOutputTokens: 1024 })).aiIntegrations[0].chatModels[0];
  assert.deepEqual(Object.keys(old).sort(), OLD_MODEL_KEYS, "a configuration that does not say it is picked exactly as it was");
  const picked = pickAiRuntimeConfig(withModel({ reasoningParameter: TEMPLATE, supportsReasoning: true, supportsToolCalls: true }));
  assert.deepEqual(pickAiRuntimeConfig(JSON.parse(JSON.stringify(picked))), picked, "picking again changes nothing: what a server saves is what it reads");
});

test("the safe view shows the thinking parameter of the model that sets one, nothing for a model that does not, and still no key", () => {
  for (const value of AI_REASONING_PARAMETERS) {
    const view = redactAiRuntimeConfig(pickAiRuntimeConfig(withModel({ reasoningParameter: value })));
    assert.deepEqual(view.integrations[0].models, [{ name: MODEL, capabilities: ["default"], reasoningParameter: value }], value);
    assert.equal(JSON.stringify(view).includes("sk-test-SECRET"), false);
  }
  assert.deepEqual(redactAiRuntimeConfig(pickAiRuntimeConfig(withModel())).integrations[0].models, [{ name: MODEL, capabilities: ["default"] }], "a model that sets nothing is shown as it always was");
  assert.deepEqual(redactAiRuntimeConfig(withModel({ reasoningParameter: "bogus" })).integrations[0].models, [{ name: MODEL, capabilities: ["default"] }], "what a configuration that was not picked says wrongly is not shown");
  const view = redactAiRuntimeConfig(pickAiRuntimeConfig(withModel({ supportsToolCalls: true, supportsStreaming: false, supportsReasoning: true, supportsVision: true, maxInputTokens: 131072, maxOutputTokens: 8192, reasoningParameter: TEMPLATE })));
  assert.deepEqual(view.integrations[0].models[0], { name: MODEL, capabilities: ["default"], supportsToolCalls: true, supportsStreaming: false, supportsReasoning: true, supportsVision: true, maxInputTokens: 131072, maxOutputTokens: 8192, reasoningParameter: TEMPLATE }, "next to what a model declares");
});

test("a candidate carries the thinking parameter of its model, with or without a route, and has no such key when its model sets none", () => {
  for (const value of AI_REASONING_PARAMETERS) {
    assert.equal(candidateOf({ reasoningParameter: value }).reasoningParameter, value, value);
    const routed = candidateOf({ reasoningParameter: value }, {}, { taskRouting: { autopilot: { primary: { integrationId: "p", model: MODEL, thinking: "high" } } } });
    assert.equal(routed.reasoningParameter, value, `${value}, routed`);
    assert.equal(routed.thinking, "high");
  }
  assert.equal("reasoningParameter" in candidateOf({}), false);
  assert.equal("reasoningParameter" in candidateOf({ reasoningParameter: "bogus" }), false);
});

// ─── A model with no thinking parameter is called as it always was ─────────

test("a candidate with no thinking parameter, or with reasoning_effort, builds byte for byte the 72 requests that the engine built before the parameter existed", () => {
  assert.ok(golden.requests.length >= 60);
  assert.ok(golden.requests.filter((entry) => entry.expected.includes("\"reasoning_effort\"")).length >= 30, "the golden has the levels in it, sent");
  // What goes on the wire and how it is asked: `apiVersion` is what the request says of itself (the version an Azure address carries, which is in the address), not a byte of it.
  const built = (candidate, request) => {
    const { apiVersion: _said, ...wire } = buildChatRequest(candidate, request);
    return JSON.stringify(wire);
  };
  for (const entry of golden.requests) {
    assert.equal(built(entry.candidate, entry.request), entry.expected, entry.name);
    assert.equal(built({ ...entry.candidate, reasoningParameter: undefined }, entry.request), entry.expected, `${entry.name}: undefined`);
    assert.equal(built({ ...entry.candidate, reasoningParameter: "reasoning_effort" }, entry.request), entry.expected, `${entry.name}: reasoning_effort, said`);
    assert.equal(built({ ...entry.candidate, reasoningParameter: "bogus" }, entry.request), entry.expected, `${entry.name}: a word the engine does not know is no word`);
  }
});

test("through the client, with the configuration a host sends, the bytes on the wire (address, headers and the body as a string) are those of before", async () => {
  assert.ok(golden.wires.length >= 5);
  for (const entry of golden.wires) {
    for (const said of [undefined, "reasoning_effort"]) {
      const config = JSON.parse(JSON.stringify(entry.config));
      if (said) for (const target of config.aiIntegrations) for (const model of target.chatModels) model.reasoningParameter = said;
      const { fetch, calls } = recording(answer);
      await createFetchAi(pickAiRuntimeConfig(config), { fetch }).complete(entry.request);
      assert.equal(calls[0].url, entry.wire.url, entry.name);
      assert.equal(calls[0].init.body, entry.wire.body, `${entry.name} (${said ?? "not said"})`);
      assert.deepEqual(calls[0].init.headers, entry.wire.headers, entry.name);
    }
  }
});

test("a model that is known to take its level as a chat-template argument is still called with reasoning_effort until its author says otherwise: the hint changes nothing by itself", () => {
  const built = buildChatRequest(candidate({ thinking: "high" }), PROSE);
  assert.equal(built.body.reasoning_effort, "high");
  assert.equal("chat_template_kwargs" in built.body, false);
  assert.equal(suggestedReasoningParameter(MODEL), TEMPLATE, "the hint is there");
  assert.equal("reasoningParameter" in candidateOf({}, { thinking: "high" }), false, "and nothing in the configuration has taken it");
});

// ─── The chat-template argument ─────────────────────────────────────────────

test("chat_template_kwargs.reasoning_strength sends the level as that argument and not as reasoning_effort, where reasoning_effort goes, and changes nothing else", () => {
  for (const [name, extra] of PROVIDERS) {
    for (const level of LEVELS) {
      for (const [kind, request] of [["prose", { ...PROSE, maxOutputTokens: 800, temperature: 0.7 }], ["structured", { ...STRUCTURED, maxOutputTokens: 600, outputBoost: 3 }]]) {
        const plain = buildChatRequest(candidate({ thinking: level }, extra), request);
        const templated = buildChatRequest(candidate({ thinking: level, reasoningParameter: TEMPLATE }, extra), request);
        const label = `${name} / ${level} / ${kind}`;
        assert.deepEqual(templated.body.chat_template_kwargs, { reasoning_strength: level }, label);
        assert.equal("reasoning_effort" in templated.body, false, `${label}: the OpenAI field is not sent`);
        assert.deepEqual(Object.keys(templated.body), Object.keys(plain.body).map((key) => (key === "reasoning_effort" ? "chat_template_kwargs" : key)), `${label}: in the place where reasoning_effort goes`);
        const { reasoning_effort: _effort, ...otherKeys } = plain.body;
        const { chat_template_kwargs: _kwargs, ...sameKeys } = templated.body;
        assert.deepEqual(sameKeys, otherKeys, `${label}: nothing else moves`);
        assert.equal(templated.thinking, level, label);
        assert.equal(templated.reasoningParameter, TEMPLATE, `${label}: the request says where the level went`);
        assert.equal("reasoningParameter" in plain, false, `${label}: and the default says nothing`);
        const { body: _a, reasoningParameter: _b, ...restTemplated } = templated;
        const { body: _c, ...restPlain } = plain;
        assert.deepEqual(restTemplated, restPlain, `${label}: url, headers, stream, tools and limit are the same`);
        assert.equal("notes" in templated, false);
      }
    }
  }
  const quiet = buildChatRequest(candidate({ thinking: "automatic", reasoningParameter: TEMPLATE }), PROSE);
  assert.equal("chat_template_kwargs" in quiet.body, false, "automatic sends nothing, whatever the parameter");
  assert.equal("reasoningParameter" in quiet, false);
  assert.equal("notes" in quiet, false);
  const integrationLevel = buildChatRequest(candidate({ reasoningParameter: TEMPLATE }, { thinking: "xhigh" }), PROSE);
  assert.deepEqual(integrationLevel.body.chat_template_kwargs, { reasoning_strength: "xhigh" }, "the level of the integration travels the same way");
  assert.equal(JSON.stringify(buildChatRequest(candidate({ reasoningParameter: TEMPLATE }), PROSE).body), JSON.stringify(buildChatRequest(candidate(), PROSE).body), "no level, no argument: the body is the one it always was");
});

test("with none, no level is sent at all, even when the task or the integration asks for one, and the request says why", () => {
  const noLevel = buildChatRequest(candidate(), PROSE);
  for (const [who, built] of [
    ["the task", buildChatRequest(candidate({ thinking: "high", reasoningParameter: "none" }), PROSE)],
    ["the integration", buildChatRequest(candidate({ reasoningParameter: "none" }, { thinking: "xhigh" }), PROSE)],
  ]) {
    assert.deepEqual(built.body, noLevel.body, `${who}: the body is the one of a request that asks for nothing`);
    assert.equal("reasoning_effort" in built.body, false);
    assert.equal("chat_template_kwargs" in built.body, false);
    assert.equal("thinking" in built, false, `${who}: nothing was sent, so the request carries no level`);
    assert.equal("reasoningParameter" in built, false);
    assert.equal(built.notes.length, 1);
    assert.match(built.notes[0], new RegExp(`^The thinking level "${who === "the task" ? "high" : "xhigh"}" was not sent: "${MODEL}" has its thinking parameter set to "none"\\.$`), who);
  }
  for (const quiet of [buildChatRequest(candidate({ thinking: "automatic", reasoningParameter: "none" }), PROSE), buildChatRequest(candidate({ reasoningParameter: "none" }), PROSE)]) {
    assert.equal("notes" in quiet, false, "no level was asked for: nothing to say");
  }
  const structured = buildChatRequest(candidate({ thinking: "low", reasoningParameter: "none" }), STRUCTURED);
  assert.equal(structured.useTools, true, "the function is forced all the same");
  assert.equal("reasoning_effort" in structured.body || "chat_template_kwargs" in structured.body, false);
});

test("what a model declares of its reasoning still counts: a model declared as not reasoning is sent no level whatever its parameter, and one declared as reasoning is sent it as its parameter says", () => {
  for (const parameter of [undefined, "reasoning_effort", TEMPLATE]) {
    const built = buildChatRequest(candidate({ thinking: "high", supportsReasoning: false, ...(parameter ? { reasoningParameter: parameter } : {}) }), PROSE);
    assert.equal("reasoning_effort" in built.body || "chat_template_kwargs" in built.body, false, String(parameter));
    assert.deepEqual(built.notes, [`The thinking level "high" was not sent: "${MODEL}" is declared as not reasoning (supportsReasoning is off).`], String(parameter));
  }
  const both = buildChatRequest(candidate({ thinking: "high", supportsReasoning: false, reasoningParameter: "none" }), PROSE);
  assert.equal(both.notes.length, 1, "one reason is said, not two");
  assert.match(both.notes[0], /thinking parameter set to "none"/, "the author's own word on the parameter is the one that is said");
  const reasoning = buildChatRequest(candidate({ thinking: "high", supportsReasoning: true, reasoningParameter: TEMPLATE }, {}), { ...PROSE, maxOutputTokens: 1000 });
  assert.deepEqual(reasoning.body.chat_template_kwargs, { reasoning_strength: "high" });
  assert.equal(reasoning.outputLimit, 13_000, "the margin of a model that reasons is the same, whatever its parameter");
});

test("applyReasoningLevel puts the level where the parameter says, and merges with the chat-template arguments that are already there", () => {
  const into = (parameter, body = { model: "m" }) => {
    applyReasoningLevel(body, parameter, "high");
    return body;
  };
  assert.deepEqual(into(undefined), { model: "m", reasoning_effort: "high" });
  assert.deepEqual(into("reasoning_effort"), { model: "m", reasoning_effort: "high" });
  assert.deepEqual(into(TEMPLATE), { model: "m", chat_template_kwargs: { reasoning_strength: "high" } });
  assert.deepEqual(into("none"), { model: "m" });
  assert.deepEqual(into("bogus"), { model: "m", reasoning_effort: "high" }, "a word that is not one is the default");

  const original = { enable_thinking: true, reasoning_strength: "low", other: { nested: 1 } };
  const body = into(TEMPLATE, { model: "m", chat_template_kwargs: original });
  assert.deepEqual(body.chat_template_kwargs, { enable_thinking: true, reasoning_strength: "high", other: { nested: 1 } }, "the other arguments stay, and the level is the one that was asked");
  assert.deepEqual(original, { enable_thinking: true, reasoning_strength: "low", other: { nested: 1 } }, "the object that was there is not changed");
  assert.notEqual(body.chat_template_kwargs, original);
  assert.deepEqual(Object.keys(body), ["model", "chat_template_kwargs"]);
  for (const odd of ["text", 5, null, undefined, [], ["reasoning_strength"], true]) {
    assert.deepEqual(into(TEMPLATE, { chat_template_kwargs: odd }).chat_template_kwargs, { reasoning_strength: "high" }, `${JSON.stringify(odd)} is no set of arguments`);
  }
  assert.deepEqual(into("none", { chat_template_kwargs: original }).chat_template_kwargs, original, "none touches nothing");
  const polluting = JSON.parse("{\"__proto__\": {\"polluted\": true}, \"keep\": 1}");
  const merged = into(TEMPLATE, { chat_template_kwargs: polluting }).chat_template_kwargs;
  assert.equal(({}).polluted, undefined);
  assert.equal(merged.keep, 1);
  assert.equal(merged.reasoning_strength, "high");
});

// ─── Through the client ─────────────────────────────────────────────────────

test("through the client the three parameters reach the wire, and the attempt says where the level went (only when it is not reasoning_effort)", async () => {
  const run = async (flags) => {
    const attempts = [];
    const { fetch, calls } = recording(answer);
    await createFetchAi(pickAiRuntimeConfig(withModel(flags, { thinking: "high" })), { fetch, onAttempt: (attempt) => attempts.push(attempt) }).complete(ASK);
    await createFetchAi(pickAiRuntimeConfig(withModel(flags, { thinking: "high" })), { fetch, onAttempt: (attempt) => attempts.push(attempt) }).complete(JSON_ASK);
    return { bodies: calls.map((entry) => entry.body), attempts };
  };
  const byDefault = await run({});
  const effort = await run({ reasoningParameter: "reasoning_effort" });
  const template = await run({ reasoningParameter: TEMPLATE });
  const none = await run({ reasoningParameter: "none" });

  for (const body of [...byDefault.bodies, ...effort.bodies]) assert.equal(body.reasoning_effort, "high");
  assert.deepEqual(effort.bodies, byDefault.bodies, "said or not, the same requests");
  for (const attempt of [...byDefault.attempts, ...effort.attempts]) {
    assert.equal(attempt.thinking, "high");
    assert.equal("reasoningParameter" in attempt, false, "the default needs no word");
    assert.equal("notes" in attempt, false);
  }
  for (const body of template.bodies) {
    assert.deepEqual(body.chat_template_kwargs, { reasoning_strength: "high" });
    assert.equal("reasoning_effort" in body, false);
  }
  for (const attempt of template.attempts) {
    assert.equal(attempt.thinking, "high");
    assert.equal(attempt.reasoningParameter, TEMPLATE);
    assert.equal("notes" in attempt, false);
  }
  for (const body of none.bodies) assert.equal("reasoning_effort" in body || "chat_template_kwargs" in body, false);
  for (const attempt of none.attempts) {
    assert.equal("thinking" in attempt, false);
    assert.equal("reasoningParameter" in attempt, false);
    assert.deepEqual(attempt.notes, [`The thinking level "high" was not sent: "${MODEL}" has its thinking parameter set to "none".`]);
  }
});

test("the parameter belongs to the model: two models of a route, each called as its own parameter says, with the level of its own target", async () => {
  const cfg = pickAiRuntimeConfig({
    aiIntegrations: [
      integration({ id: "a", name: "Alpha", endpoint: "http://a.test/v1", chatModels: [{ id: "a1", name: "alpha-model", capabilities: ["default"], reasoningParameter: TEMPLATE }] }),
      integration({ id: "b", name: "Beta", endpoint: "http://b.test/v1", chatModels: [{ id: "b1", name: "beta-model", capabilities: ["default"] }] }),
    ],
    taskRouting: { autopilot: { primary: { integrationId: "a", model: "alpha-model", thinking: "xhigh" }, fallbacks: [{ integrationId: "b", model: "beta-model", thinking: "low" }] } },
  });
  const { fetch, calls } = recording((entry) => (hostOf(entry) === "a" ? failing(500, { message: "down" }) : reply("Second.")));
  const response = await createFetchAi(cfg, { fetch }).complete(ASK);
  assert.equal(response.text, "Second.");
  assert.deepEqual(calls.map((entry) => [hostOf(entry), entry.body.reasoning_effort, entry.body.chat_template_kwargs]), [["a", undefined, { reasoning_strength: "xhigh" }], ["b", "low", undefined]]);
});

// ─── A provider that refuses it ─────────────────────────────────────────────

const refused = (flags, error, extra = {}) => createFetchAi(pickAiRuntimeConfig(withModel(flags, { thinking: "high" })), { fetch: async () => failing(extra.status ?? 400, error) }).complete(ASK).then(() => null, (failure) => failure);
const remedyOf = (error) => error.message.slice(error.message.indexOf("Nothing was applied."));

test("a 400 that names the chat-template argument is a permanent error that names the model's setting and what to set it to, and keeps what the provider said", async () => {
  for (const message of [
    "chat_template_kwargs: Extra inputs are not permitted",
    "Unrecognized request argument supplied: chat_template_kwargs",
    "Unknown chat template kwarg reasoning_strength for this model",
    "Template error: 'reasoning_strength' is undefined",
    "reasoning strength is not supported by this endpoint",
  ]) {
    const error = await refused({ reasoningParameter: TEMPLATE }, { message });
    assert.ok(error instanceof AiProviderError, String(error));
    assert.equal(error.status, 400);
    assert.equal(error.retryable, false, message);
    assert.notEqual(error.transient, true);
    assert.match(error.message, /^openai muse-glimmer-30b: the model does not accept a thinking level/, message);
    assert.match(error.message, /HTTP 400/, "what the provider said is still there");
    assert.ok(error.message.includes(message.slice(0, 20)), message);
    const remedy = remedyOf(error);
    assert.match(remedy, /Set "Thinking parameter" of the model "muse-glimmer-30b" in AI Integrations to "reasoning_effort"/, message);
    assert.match(remedy, /or to "none"/, message);
    assert.doesNotMatch(remedy, /chat_template_kwargs/, "it does not offer what was just refused");
    assert.match(remedy, /or set thinking to "Automatic" for this task in the AI Router, or for the integration "LlmProxy" in AI Integrations\.$/, message);
  }
});

test("a 400 that names reasoning_effort says the same, offering the chat-template argument and none, and the old words of the remedy are all still there", async () => {
  for (const flags of [{}, { reasoningParameter: "reasoning_effort" }]) {
    const error = await refused(flags, { message: "Unrecognized request argument supplied: reasoning_effort" });
    assert.equal(error.retryable, false);
    assert.match(error.message, /^openai muse-glimmer-30b: the model does not accept a thinking level/);
    const remedy = remedyOf(error);
    assert.match(remedy, /Set "Thinking parameter" of the model "muse-glimmer-30b" in AI Integrations to "chat_template_kwargs\.reasoning_strength"/);
    assert.match(remedy, /or to "none"/);
    assert.match(remedy, /set thinking to "Automatic" for this task/i, "the words that E2 said are there");
    assert.match(remedy, /integration "LlmProxy"/);
    assert.doesNotMatch(remedy, /to "reasoning_effort"/, "it does not offer what was just refused");
  }
  const named = await refused({ reasoningParameter: TEMPLATE }, { message: "Unsupported parameter: 'reasoning_effort'" });
  assert.match(named.message, /does not accept a thinking level/, "a provider that complains of the other name is understood: the remedy is the same setting");
  assert.match(remedyOf(named), /to "reasoning_effort"/);
});

test("both names are understood in the provider's message and in the param of its error object, for a 400 and for a 422", async () => {
  const cases = [
    ["a message with the name of the OpenAI field", { message: "unknown field reasoning_effort" }],
    ["a message with the name of the argument", { message: "unknown field chat_template_kwargs" }],
    ["a message with the name of the key", { message: "unknown template argument reasoning_strength" }],
    ["a param with the OpenAI field", { message: "Invalid value: 'xhigh'.", param: "reasoning_effort", code: "unsupported_value" }],
    ["a param with the argument", { message: "Invalid value: 'xhigh'.", param: "chat_template_kwargs", code: "unsupported_value" }],
    ["a param with the whole path", { message: "Invalid value: 'xhigh'.", param: "chat_template_kwargs.reasoning_strength" }],
    ["a param with the key", { message: "Invalid value: 'xhigh'.", param: "reasoning_strength" }],
  ];
  for (const flags of [{}, { reasoningParameter: TEMPLATE }]) {
    for (const [name, error] of cases) {
      for (const status of [400, 422]) {
        const failure = await refused(flags, error, { status });
        assert.match(failure.message, /does not accept a thinking level/, `${name} / ${status} / ${JSON.stringify(flags)}`);
        assert.equal(failure.retryable, false);
        assert.equal(failure.status, status);
      }
    }
  }
});

test("when no level was sent, nothing is blamed on the setting: with none, with automatic, on a server error, or for a 400 about something else", async () => {
  const names = { message: "chat_template_kwargs reasoning_strength reasoning_effort are all unknown" };
  const none = await refused({ reasoningParameter: "none" }, names);
  assert.doesNotMatch(none.message, /thinking level|Thinking parameter/, "nothing was sent: it is not the setting to blame");
  const automatic = await createFetchAi(pickAiRuntimeConfig(withModel({ reasoningParameter: TEMPLATE }, { thinking: "automatic" })), { fetch: async () => failing(400, names) }).complete(ASK).then(() => null, (failure) => failure);
  assert.doesNotMatch(automatic.message, /thinking level|Thinking parameter/);
  const noLevel = await createFetchAi(pickAiRuntimeConfig(withModel({ reasoningParameter: TEMPLATE })), { fetch: async () => failing(400, names) }).complete(ASK).then(() => null, (failure) => failure);
  assert.doesNotMatch(noLevel.message, /thinking level|Thinking parameter/);
  const server = await refused({ reasoningParameter: TEMPLATE }, { message: "chat_template_kwargs exploded" }, { status: 500 });
  assert.doesNotMatch(server.message, /thinking level/, "a server error is not a refusal of the parameter");
  assert.equal(server.retryable, true);
  const other = await refused({ reasoningParameter: TEMPLATE }, { message: "max_tokens is too large" });
  assert.doesNotMatch(other.message, /thinking level/);
  assert.match(other.message, /HTTP 400 — max_tokens is too large/);
  const template = await refused({ reasoningParameter: TEMPLATE }, { message: "this model has no chat template" });
  assert.doesNotMatch(template.message, /thinking level/, "a complaint about the chat template is not one about its arguments");
  const echoed = await refused({ reasoningParameter: TEMPLATE }, { message: "max_tokens is too large", param: "max_tokens", request: { chat_template_kwargs: { reasoning_strength: "high" } } });
  assert.doesNotMatch(echoed.message, /thinking level/, "a provider that echoes the request is not refusing the level");
});

test("when a model refuses its level as the chat-template argument, the next candidate is tried, with its own parameter", async () => {
  const cfg = pickAiRuntimeConfig({
    aiIntegrations: [
      integration({ id: "a", name: "Alpha", endpoint: "http://a.test/v1", chatModels: [{ id: "a1", name: "alpha-model", capabilities: ["default"], reasoningParameter: TEMPLATE }] }),
      integration({ id: "b", name: "Beta", endpoint: "http://b.test/v1", chatModels: [{ id: "b1", name: "beta-model", capabilities: ["default"] }] }),
    ],
    taskRouting: { autopilot: { primary: { integrationId: "a", model: "alpha-model", thinking: "xhigh" }, fallbacks: [{ integrationId: "b", model: "beta-model", thinking: "xhigh" }] } },
  });
  const { fetch, calls } = recording((entry) => (hostOf(entry) === "a" ? failing(400, { message: "chat_template_kwargs: Extra inputs are not permitted" }) : reply("Answered.")));
  const response = await createFetchAi(cfg, { fetch }).complete(ASK);
  assert.equal(response.text, "Answered.");
  assert.deepEqual(calls.map((entry) => [hostOf(entry), entry.body.reasoning_effort, entry.body.chat_template_kwargs]), [["a", undefined, { reasoning_strength: "xhigh" }], ["b", "xhigh", undefined]]);
});

// ─── The hint ───────────────────────────────────────────────────────────────

test("the hint knows Muse Glimmer by the names that its sources give it, and nothing else", () => {
  // The names of the sources: Meta's pages (the Hugging Face repositories `meta-models/Muse-Glimmer-30B` and `-GGUF`, the served names `muse-glimmer` and
  // `muse-glimmer-30B`, the Ollama tag `muse-glimmer:30b-mlx`) and LlmProxy's tests and logs (`unsloth/Muse-Glimmer-30B-GGUF`, `meta-muse-glimmer`).
  for (const name of [
    "muse-glimmer", "muse-glimmer-30b", "muse-glimmer-30B", "Muse-Glimmer-30B", "MUSE-GLIMMER-30B-GGUF", "muse_glimmer", "muse glimmer 30b", "muse-glimmer30b", "  muse-glimmer-30b  ",
    "meta-models/Muse-Glimmer-30B", "meta-models/Muse-Glimmer-30B-GGUF:Q4_K_M", "unsloth/Muse-Glimmer-30B-GGUF", "RadixArk/Muse-Glimmer-NVFP4", "hf.co/meta-models/Muse-Glimmer-30B-GGUF:Q4_K_M",
    "muse-glimmer:30b-mlx", "meta-muse-glimmer", "meta-muse-glimmer-30b", "Meta_Muse_Glimmer", "meta/muse-glimmer",
  ]) assert.equal(suggestedReasoningParameter(name), TEMPLATE, name);
  for (const name of [
    "gpt-4o", "o3-mini", "gpt-5", "claude-sonnet", "qwen3-30b", "meta-llama/Llama-3.3-70B-Instruct", "llama-3.3-70b", "gpt-oss-20b", "deepseek-r1",
    "muse", "glimmer", "muse-spark", "muse-spark-open-816b-a42b", "meta-models/Muse-Spark-Open-816B-A42B", "meta-muse", "meta-muse-spark", "meta-models", "muse-glimmerx", "muse-glimmering", "amuse-glimmer", "my-muse-glimmer", "not-muse-glimmer-at-all",
    "", "   ", "/", "muse-glimmer/", "__proto__", "constructor",
  ]) assert.equal(suggestedReasoningParameter(name), undefined, JSON.stringify(name));
  for (const hostile of [undefined, null, 0, 5, true, {}, [], ["muse-glimmer"], () => "muse-glimmer", Symbol("x")]) assert.equal(suggestedReasoningParameter(hostile), undefined, String(typeof hostile));
  assert.equal(suggestedReasoningParameter("x".repeat(100_000)), undefined, "a long name costs nothing");
  assert.equal(suggestedReasoningParameter(`${"a/".repeat(50_000)}muse-glimmer`), TEMPLATE, "and a long path is still read to its last part");
  for (const name of ["muse-glimmer-30b", "gpt-4o"]) assert.ok([undefined, ...AI_REASONING_PARAMETERS].includes(suggestedReasoningParameter(name)), "it says a value the configuration knows, or nothing");
});

test("the hint reads the model that is declared underneath, as the engine does for a deployment: the declared model is what it really is", () => {
  assert.equal(suggestedReasoningParameter("my-deployment", "muse-glimmer-30b"), TEMPLATE);
  assert.equal(suggestedReasoningParameter("muse-glimmer-30b", "gpt-4o"), undefined, "a name that says one thing over a model that is another is the other");
  assert.equal(suggestedReasoningParameter("muse-glimmer-30b", ""), TEMPLATE, "a blank is no declaration");
  assert.equal(suggestedReasoningParameter("muse-glimmer-30b", "   "), TEMPLATE);
  assert.equal(suggestedReasoningParameter("muse-glimmer-30b", undefined), TEMPLATE);
  assert.equal(suggestedReasoningParameter("muse-glimmer-30b", null), TEMPLATE);
  assert.equal(suggestedReasoningParameter("muse-glimmer-30b", 5), TEMPLATE, "what is not a text is no declaration");
  assert.equal(suggestedReasoningParameter("my-deployment", "gpt-4o"), undefined);
});
