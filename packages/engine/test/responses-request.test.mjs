import test from "node:test";
import assert from "node:assert/strict";
import * as engine from "../dist/index.js";

// A model whose `apiProtocol` is `responses` is asked through the Responses API: `input` and `max_output_tokens` and `reasoning.effort` where Chat Completions has `messages`, a limit parameter of
// its family and `reasoning_effort`, function tools that are flat, and a request that is not stored. The request of the Azure portal's playground (captured by the owner) is what the first test builds.

const { AiProviderError, attemptThinking, buildChatRequest, planAttempts, reasoningEffortOf, withToolsRule } = engine;

const azure = (extra = {}) => ({ id: "az", name: "oai-gw-002", provider: "azure_openai", endpoint: "https://oai-gw-002.openai.azure.com", apiKey: "k-azure-secret-123456", ...extra });
const openai = (extra = {}) => ({ id: "oa", name: "OpenAI", provider: "openai", endpoint: "https://api.openai.com/v1", apiKey: "sk-openai-secret-987654", ...extra });
const responsesOf = (integration, extra = {}) => ({ integration, model: "gpt-5.2", apiProtocol: "responses", ...extra });
const SCHEMA = { name: "write_scene", description: "Write the scene.", parameters: { type: "object", properties: { text: { type: "string" } }, required: ["text"] } };
const PLAIN = { system: "You are an AI assistant that helps people find information.", user: "rispondi solo con ok", maxOutputTokens: 300 };

const part = (type, text) => ({ type, text });

test("the request of the Azure portal's playground is the one that is built, with the address that the owner captured and what a manuscript needs on top of it", () => {
  const built = buildChatRequest(responsesOf(azure(), { thinking: "low" }), PLAIN);
  assert.equal(built.url, "https://oai-gw-002.openai.azure.com/openai/responses?api-version=2025-04-01-preview");
  assert.equal(built.protocol, "responses");
  assert.deepEqual(built.headers, { "content-type": "application/json", accept: "text/event-stream", "api-key": "k-azure-secret-123456" });
  assert.deepEqual(built.body, {
    model: "gpt-5.2",
    input: [
      { role: "developer", content: [part("input_text", "You are an AI assistant that helps people find information.")] },
      { role: "user", content: [part("input_text", "rispondi solo con ok")] },
    ],
    max_output_tokens: 12_300,
    reasoning: { effort: "low" },
    store: false,
    stream: true,
  });
  assert.equal(JSON.stringify(Object.keys(built.body)), JSON.stringify(["model", "input", "max_output_tokens", "reasoning", "store", "stream"]));
  assert.equal(built.stream, true);
  assert.equal(built.useTools, false);
  assert.equal(built.thinking, "low");
  assert.equal(built.apiVersion, "2025-04-01-preview");
  assert.equal(built.outputLimit, 12_300, "the limit counts the reasoning, so a model that reasons gets the margin it always got");
  assert.deepEqual(built.messages.map((message) => message.role), ["system", "user"], "the messages are kept in the engine's form, for the hooks and the estimates");
  assert.ok(!("messages" in built.body) && !("stream_options" in built.body) && !("max_completion_tokens" in built.body) && !("reasoning_effort" in built.body) && !("text" in built.body), "none of what Chat Completions has");
  assert.deepEqual(JSON.parse(JSON.stringify(built)).body, built.body);
});

test("the address is built from the integration the way its provider has it, and the model's own address is used as typed", () => {
  const url = (integration, extra) => buildChatRequest(responsesOf(integration, extra), PLAIN).url;
  assert.equal(url(azure(), {}), "https://oai-gw-002.openai.azure.com/openai/responses?api-version=2025-04-01-preview");
  assert.equal(url(azure({ apiVersion: "2024-10-21" }), {}), "https://oai-gw-002.openai.azure.com/openai/responses?api-version=2025-04-01-preview", "a version that predates the API is not used for it");
  assert.equal(url(azure({ apiVersion: "2025-03-01-preview" }), { apiVersion: "preview" }), "https://oai-gw-002.openai.azure.com/openai/responses?api-version=preview", "the model's own version wins");
  assert.equal(url(azure({ endpoint: "https://oai-gw-002.openai.azure.com/openai/v1/" }), {}), "https://oai-gw-002.openai.azure.com/openai/v1/responses", "the v1 API has no version in its address");
  assert.equal(url(openai(), {}), "https://api.openai.com/v1/responses");
  assert.equal(buildChatRequest(responsesOf(openai()), PLAIN).headers.authorization, "Bearer sk-openai-secret-987654");
  const own = "https://gw.test/proxy/openai/v1/responses?api-version=preview&x=1";
  const owned = buildChatRequest(responsesOf(azure(), { endpointUrl: own, apiVersion: "2025-03-01-preview" }), PLAIN);
  assert.equal(owned.url, own);
  assert.equal(owned.apiVersion, undefined);
  assert.equal(owned.headers["api-key"], "k-azure-secret-123456");
  assert.throws(() => buildChatRequest(responsesOf({ id: "g", name: "GitHub Models", provider: "github_models", apiKey: "ghp_token_123456" }), PLAIN), (error) => error instanceof AiProviderError && /no Responses API/.test(error.message));
  assert.equal(buildChatRequest(responsesOf({ id: "g", name: "GitHub Models", provider: "github_models", apiKey: "ghp_token_123456" }, { endpointUrl: "https://proxy.test/responses" }), PLAIN).url, "https://proxy.test/responses");
});

test("a request that does not stream is asked for as JSON and carries no stream flag; the output limit and the temperature follow the same rules as Chat Completions", () => {
  const built = buildChatRequest(responsesOf(azure({ streamMode: "off" }), { model: "gpt-4.1", maxOutputTokens: 500 }), { ...PLAIN, maxOutputTokens: 4000, temperature: 0.7 });
  assert.equal(built.stream, false);
  assert.equal(built.headers.accept, "application/json");
  assert.deepEqual(built.body, {
    model: "gpt-4.1",
    input: [{ role: "developer", content: [part("input_text", PLAIN.system)] }, { role: "user", content: [part("input_text", PLAIN.user)] }],
    max_output_tokens: 500,
    temperature: 0.7,
    store: false,
  }, "a model that does not reason is sent the temperature, and its own maximum caps the limit");
  const reasoning = buildChatRequest(responsesOf(azure(), { thinking: "medium" }), { ...PLAIN, temperature: 0.7 });
  assert.ok(!("temperature" in reasoning.body), "a reasoning model takes no custom temperature");
  const unlimited = buildChatRequest(responsesOf(openai(), { model: "gpt-4.1" }), { system: "s", user: "u" });
  assert.ok(!("max_output_tokens" in unlimited.body), "no limit asked, none sent");
  const unstreamed = buildChatRequest(responsesOf(openai(), { supportsStreaming: false }), PLAIN);
  assert.equal(unstreamed.stream, false);
  assert.ok(unstreamed.notes.some((note) => /not streaming/.test(note)));
});

test("a forced function is a flat tool that is not strict, forced with required, beside the thinking level, which the Responses API takes with tools", () => {
  const built = buildChatRequest(responsesOf(azure(), { thinking: "high", noThinkingWithTools: true }), { ...PLAIN, json: SCHEMA });
  assert.equal(built.useTools, true);
  assert.deepEqual(built.body.tools, [{ type: "function", name: "write_scene", description: "Write the scene.", parameters: SCHEMA.parameters, strict: false }]);
  assert.equal(built.body.tool_choice, "required");
  assert.deepEqual(built.body.reasoning, { effort: "high" }, "a model that refuses a level with tools on Chat Completions is sent it on the Responses API");
  assert.equal(built.thinking, "high");
  assert.equal(built.thinkingWhy, undefined);
  assert.equal(built.notes, undefined);
  assert.equal(JSON.stringify(built.body).includes("\"function\":{"), false, "no `function` object: the Responses API's tools are flat");
  // The same candidate on Chat Completions is asked as it always was.
  const chat = buildChatRequest({ integration: azure(), model: "gpt-5.2", thinking: "high", noThinkingWithTools: true }, { ...PLAIN, json: SCHEMA });
  assert.equal(chat.protocol, "chat-completions");
  assert.equal(chat.thinking, undefined);
  assert.equal(chat.thinkingWhy, "tools");
  assert.deepEqual(chat.body.tools, [{ type: "function", function: SCHEMA }]);
  // `none` is no way of the Responses API either: nothing in it asks for it.
  const none = buildChatRequest(responsesOf(azure(), { thinking: "low", noThinkingWithTools: "none" }), { ...PLAIN, json: SCHEMA });
  assert.deepEqual(none.body.reasoning, { effort: "low" });
});

test("a model without tool calls gets the schema in the developer message, and no tools, exactly as on Chat Completions", () => {
  const built = buildChatRequest(responsesOf(openai(), { supportsToolCalls: false }), { ...PLAIN, json: SCHEMA });
  assert.equal(built.useTools, false);
  assert.ok(!("tools" in built.body) && !("tool_choice" in built.body));
  assert.match(built.body.input[0].content[0].text, /^You are an AI assistant that helps people find information\.\n\nReply with ONLY one JSON object/);
  assert.match(built.body.input[0].content[0].text, /write_scene/);
});

test("the levels of thinking: sent as reasoning.effort when there is one to send, and left out, with the reason, when the model cannot take it", () => {
  const level = (extra, integration = azure()) => buildChatRequest(responsesOf(integration, extra), PLAIN);
  for (const value of ["low", "medium", "high", "xhigh"]) assert.deepEqual(level({ thinking: value }).body.reasoning, { effort: value });
  assert.ok(!("reasoning" in level({ thinking: "automatic" }).body), "automatic sends nothing");
  assert.ok(!("reasoning" in level({}).body), "no level, none sent");
  assert.deepEqual(level({}, azure({ thinking: "medium" })).body.reasoning, { effort: "medium" }, "the integration's level is the default");
  const declared = level({ thinking: "high", supportsReasoning: false });
  assert.ok(!("reasoning" in declared.body));
  assert.match(declared.notes[0], /not reasoning/);
  const none = level({ thinking: "high", reasoningParameter: "none" });
  assert.ok(!("reasoning" in none.body));
  assert.match(none.notes[0], /thinking parameter set to "none"/);
  const template = level({ thinking: "high", reasoningParameter: "chat_template_kwargs.reasoning_strength" });
  assert.ok(!("reasoning" in template.body) && !("chat_template_kwargs" in template.body), "the chat template is Chat Completions' only");
  assert.match(template.notes[0], /only Chat Completions has/);
  assert.equal(template.reasoningParameter, undefined);
  const chat = buildChatRequest({ integration: azure(), model: "muse", reasoningParameter: "chat_template_kwargs.reasoning_strength", thinking: "high" }, PLAIN);
  assert.deepEqual(chat.body.chat_template_kwargs, { reasoning_strength: "high" }, "on Chat Completions it still goes there");
});

test("the chip and the rules say the same as the request: with the Responses API, the level goes with tools and noThinkingWithTools is not used", () => {
  const candidate = (extra) => ({ integration: azure(), thinking: "high", ...extra });
  assert.equal(withToolsRule({ apiProtocol: "responses", noThinkingWithTools: true }), undefined);
  assert.equal(withToolsRule({ apiProtocol: "responses", noThinkingWithTools: "none" }), undefined);
  assert.equal(withToolsRule({ noThinkingWithTools: true }), true);
  assert.equal(withToolsRule({ apiProtocol: undefined, noThinkingWithTools: "none" }), "none");
  assert.equal(attemptThinking(candidate({ noThinkingWithTools: true }), true), "not-sent");
  assert.equal(attemptThinking(candidate({ noThinkingWithTools: true, apiProtocol: "responses" }), true), "high");
  assert.equal(attemptThinking(candidate({ noThinkingWithTools: "none" }), true), "none");
  assert.equal(attemptThinking(candidate({ noThinkingWithTools: "none", apiProtocol: "responses" }), true), "high");
  assert.equal(attemptThinking(candidate({ apiProtocol: "responses", reasoningParameter: "chat_template_kwargs.reasoning_strength" }), false), "not-sent");
  assert.equal(attemptThinking(candidate({ reasoningParameter: "chat_template_kwargs.reasoning_strength" }), false), "high");
  assert.equal(reasoningEffortOf(candidate({ apiProtocol: "responses" })), "high");
});

test("what the author wrote and what the assistant said before go in as the Responses API wants them: typed parts, images as input_image, and output_text for the assistant", () => {
  const png = "data:image/png;base64,AAAA";
  const messages = [
    { role: "system", content: "Be brief." },
    { role: "user", content: [{ type: "text", text: "What is this?" }, { type: "image", dataUrl: png }] },
    { role: "assistant", content: "A harbor." },
    { role: "user", content: "Thanks." },
  ];
  const built = buildChatRequest(responsesOf(openai(), { model: "gpt-4.1" }), { system: "", user: "", messages });
  assert.deepEqual(built.body.input, [
    { role: "developer", content: [part("input_text", "Be brief.")] },
    { role: "user", content: [part("input_text", "What is this?"), { type: "input_image", image_url: png }] },
    { role: "assistant", content: [part("output_text", "A harbor.")] },
    { role: "user", content: [part("input_text", "Thanks.")] },
  ]);
  assert.deepEqual(built.messages.map((message) => message.role), ["system", "user", "assistant", "user"]);
  assert.deepEqual(messages[1].content, [{ type: "text", text: "What is this?" }, { type: "image", dataUrl: png }], "what the host gave is not changed");
});

test("the router counts the prompt of a Responses request from the same messages as on Chat Completions, and the tools in the form they go in", () => {
  const route = (integration) => planAttempts({
    aiIntegrations: [integration],
    taskRouting: { autopilot: { primary: { integrationId: integration.id, model: "gpt-5.2" }, fallbacks: [] } },
  }, { ...PLAIN, capability: "autopilot", label: "t", json: SCHEMA }).attempts[0];
  const model = { id: "m", name: "gpt-5.2", capabilities: ["default"], supportsToolCalls: true };
  const chat = route(azure({ chatModels: [model] }));
  const responses = route(azure({ chatModels: [{ ...model, apiProtocol: "responses" }] }));
  assert.equal(chat.built.protocol, "chat-completions");
  assert.equal(responses.built.protocol, "responses");
  assert.ok(chat.inputTokens > 40);
  assert.ok(Math.abs(responses.inputTokens - chat.inputTokens) <= 4, `${responses.inputTokens} against ${chat.inputTokens}: only the form of the tool differs`);
  const plain = (integration) => planAttempts({ aiIntegrations: [integration], taskRouting: { autopilot: { primary: { integrationId: integration.id, model: "gpt-5.2" }, fallbacks: [] } } }, { ...PLAIN, capability: "autopilot", label: "t" }).attempts[0];
  assert.equal(plain(azure({ chatModels: [{ ...model, apiProtocol: "responses" }] })).inputTokens, plain(azure({ chatModels: [model] })).inputTokens, "without a tool, the count is the same");
});
