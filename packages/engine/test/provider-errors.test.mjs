import test from "node:test";
import assert from "node:assert/strict";
import * as engine from "../dist/index.js";
import { MemoryBookStore, createFakeAutopilotAi, seedBookFiles } from "../dist/testing/index.js";
import { ASK, JSON_ASK, integration, recording } from "./transport-fakes.mjs";

// What a provider says when it refuses a request, read the same whatever its shape and shown whole; and the one refusal that the engine handles by itself: a provider that refuses a thinking level
// because the request carries function tools («Function tools with reasoning_effort are not supported for gpt-6-luna in /v1/chat/completions…») is asked again, once, without the level, and the model
// is remembered, so that every later request with tools goes without a level while a request without tools keeps its own.

const { MemoryAiCallStore, AutopilotSession, clipWithEllipsis, createFetchAi, createModelMemory, describeErrorBody, errorBodyOfObject, normalizeErrorBody, parseErrorBody, pickAiRuntimeConfig, redactSecrets, refusesThinkingWithTools, suggestsResponsesApi } = engine;

const MESSAGE = (model) => `Function tools with reasoning_effort are not supported for ${model} in /v1/chat/completions. To use function tools, use /v1/responses or set reasoning_effort to 'none'.`;
const OWNER_BODY = (model = "gpt-6-luna") => JSON.stringify({ error: { message: MESSAGE(model), type: "invalid_request_error", param: "reasoning_effort", code: null } });
const KEY = "sk-test-SECRET-0123456789";
const refusal = (model, status = 400) => new Response(OWNER_BODY(model), { status, headers: { "content-type": "application/json" } });
const reply = (text = "ok") => Response.json({ choices: [{ message: { content: text }, finish_reason: "stop" }], usage: { prompt_tokens: 12, completion_tokens: 3 } });
const toolReply = (value = { ok: true }) => Response.json({ choices: [{ message: { tool_calls: [{ id: "c1", type: "function", function: { name: "result", arguments: JSON.stringify(value) } }] }, finish_reason: "tool_calls" }], usage: { prompt_tokens: 12, completion_tokens: 3 } });
const SCHEMA_ASK = { ...JSON_ASK };
const model = (name, extra = {}) => ({ id: name, name, capabilities: ["default"], ...extra });
const configOf = ({ models = ["gpt-6-luna", "gpt-6.2-sol"], thinking = "high", extra = {}, modelExtra = {} } = {}) => ({
  aiIntegrations: [integration({ id: "az", name: "AzureOpenAi-GW", endpoint: "http://gw.test/v1", thinking, chatModels: models.map((name) => model(name, modelExtra[name] ?? {})), ...extra })],
  taskRouting: { autopilot: { primary: { integrationId: "az", model: models[0] }, fallbacks: models.slice(1).map((name) => ({ integrationId: "az", model: name })) } },
});
const only = (name) => ({ aiIntegrations: configOf({ models: [name] }).aiIntegrations, taskRouting: { autopilot: { primary: { integrationId: "az", model: name }, fallbacks: [] } } });

// ─── The body of an error, read ─────────────────────────────────────────────

test("the body of the owner's refusal is shown whole: the message as the provider wrote it, its type, its param, and no code where it has none", () => {
  const body = parseErrorBody(400, OWNER_BODY());
  assert.deepEqual(body, { status: 400, shape: "openai", message: MESSAGE("gpt-6-luna"), type: "invalid_request_error", param: "reasoning_effort" });
  assert.equal(describeErrorBody(body), `HTTP 400 — ${MESSAGE("gpt-6-luna")} [type: invalid_request_error, param: reasoning_effort]`);
  // The same refusal for another model reads the same, and the rule never depends on the name of the model.
  const sol = parseErrorBody(400, OWNER_BODY("gpt-6.2-sol"));
  assert.equal(sol.message, MESSAGE("gpt-6.2-sol"));
  assert.equal(refusesThinkingWithTools(body), true);
  assert.equal(refusesThinkingWithTools(sol), true);
  assert.equal(refusesThinkingWithTools(parseErrorBody(400, OWNER_BODY("a-model-with-any-name-at-all-42"))), true);
  assert.equal(suggestsResponsesApi(body), true, "its words tell to use /v1/responses");
  assert.equal(suggestsResponsesApi(parseErrorBody(400, JSON.stringify({ error: { message: "Bad schema" } }))), false);
});

test("the shapes of the other providers are read: Azure, Anthropic, Gemini (also in a list), and a plain message, a detail (a text, or the list of FastAPI), an error that is a text", () => {
  assert.deepEqual(parseErrorBody(400, JSON.stringify({ error: { code: "BadRequest", message: "Invalid request.", innererror: { code: "ResponsibleAIPolicyViolation" } } })), { status: 400, shape: "azure", message: "Invalid request.", type: "ResponsibleAIPolicyViolation", code: "BadRequest" });
  assert.deepEqual(parseErrorBody(401, JSON.stringify({ error: { code: "401", message: "Access denied due to invalid subscription key." } })), { status: 401, shape: "azure", message: "Access denied due to invalid subscription key.", code: "401" });
  assert.deepEqual(parseErrorBody(529, JSON.stringify({ type: "error", error: { type: "overloaded_error", message: "Overloaded" } })), { status: 529, shape: "anthropic", message: "Overloaded", type: "overloaded_error" });
  const gemini = { error: { code: 400, message: "Invalid JSON payload received.", status: "INVALID_ARGUMENT" } };
  assert.deepEqual(parseErrorBody(400, JSON.stringify(gemini)), { status: 400, shape: "gemini", message: "Invalid JSON payload received.", type: "INVALID_ARGUMENT", code: "400" });
  assert.equal(parseErrorBody(400, JSON.stringify([gemini])).message, "Invalid JSON payload received.", "a list with the error in it");
  assert.deepEqual(parseErrorBody(400, JSON.stringify({ message: "Model not found" })), { status: 400, shape: "message", message: "Model not found" });
  assert.deepEqual(parseErrorBody(404, JSON.stringify({ detail: "Not Found" })), { status: 404, shape: "detail", message: "Not Found" });
  assert.equal(parseErrorBody(422, JSON.stringify({ detail: [{ loc: ["body", "tools", 0], msg: "field required", type: "missing" }, { loc: ["body", "model"], msg: "none is not an allowed value" }] })).message, "body.tools.0: field required; body.model: none is not an allowed value");
  assert.deepEqual(parseErrorBody(400, JSON.stringify({ error: "Unknown model" })), { status: 400, shape: "message", message: "Unknown model" });
  assert.equal(parseErrorBody(400, JSON.stringify({ error: { message: "Plain" } })).shape, "openai");
});

test("a body that is not one of those is shown as it is, with the status: a text, the page of a gateway, a JSON that nobody knows; and a body with nothing in it says only the status", () => {
  assert.deepEqual(parseErrorBody(400, "upstream connect error or disconnect/reset before headers"), { status: 400, shape: "text", raw: "upstream connect error or disconnect/reset before headers" });
  assert.equal(describeErrorBody(parseErrorBody(400, "upstream connect error")), "HTTP 400 — upstream connect error");
  const page = "<!DOCTYPE html><html><head><title>502 Bad Gateway</title></head><body><center><h1>502 Bad Gateway</h1></center><hr>nginx</body></html>";
  const html = parseErrorBody(502, page);
  assert.equal(html.shape, "html");
  assert.match(html.message, /an HTML page from a gateway or a proxy \("502 Bad Gateway"\), not an answer of the provider/);
  assert.ok(html.raw.includes("nginx"), "the page itself is kept, cut, for whoever wants to read it");
  const unknown = parseErrorBody(400, JSON.stringify({ result: "nope", n: 3 }));
  assert.deepEqual(unknown, { status: 400, shape: "text", raw: JSON.stringify({ result: "nope", n: 3 }) });
  for (const empty of ["", "   \n", undefined]) {
    const body = parseErrorBody(400, empty);
    assert.deepEqual(body, { status: 400, shape: "empty" });
    assert.equal(describeErrorBody(body), "HTTP 400, no body");
  }
});

test("nothing is cut but with an ellipsis, and never inside a character: a long message at two thousand characters, a huge body at two kilobytes", () => {
  const long = parseErrorBody(400, JSON.stringify({ error: { message: `${"a".repeat(1990)} the end of the first sentence. And a second one that does not fit.` } }));
  assert.ok(long.message.length <= 2000 && long.message.length > 1900, `${long.message.length}`);
  assert.ok(long.message.endsWith("…"));
  const huge = parseErrorBody(500, "x".repeat(200_000));
  assert.equal(huge.shape, "text");
  assert.ok(huge.raw.length <= 2048 && huge.raw.endsWith("…"), `${huge.raw.length}`);
  const short = "Short and whole.";
  assert.equal(parseErrorBody(400, JSON.stringify({ error: { message: short } })).message, short, "what fits is never touched");
  // A pair of UTF-16 units at the edge is not cut in two.
  const edge = clipWithEllipsis(`${"a".repeat(9)}😀😀😀`, 11);
  assert.ok(!/[\ud800-\udbff]$/.test(edge.slice(0, -1)), "no lone high surrogate before the ellipsis");
  assert.equal(clipWithEllipsis("short", 100), "short");
});

test("the keys are taken out of every word: the key of the integration, a bearer token, a signature of a query, the keys of a query, an sk- key, in the message and in the body that is kept as it is", () => {
  const redact = (text) => redactSecrets(text, [KEY]);
  const said = `Bad request to https://x.blob.core.windows.net/c?sv=2024&sig=AbC123%2Fdef&se=2026 with Authorization: Bearer abcdef1234567890 and api_key=hunter2hunter2 and ${KEY} and ?key=AIzaSyDUMMYDUMMYDUMMYDUMMYDUMMYDUMMYDUM and sk-live-ABCDEFGH12345678`;
  const asJson = parseErrorBody(400, JSON.stringify({ error: { message: said, type: "invalid_request_error" } }), redact);
  const asText = parseErrorBody(400, said, redact);
  for (const body of [asJson, asText]) {
    const text = JSON.stringify(body);
    for (const secret of ["AbC123", "abcdef1234567890", "hunter2hunter2", KEY, "AIzaSyDUMMY", "sk-live-ABCDEFGH12345678"]) assert.ok(!text.includes(secret), `${secret} is not in ${body.shape}`);
    assert.ok(text.includes("[redacted]"));
  }
  assert.ok((asJson.message).includes("sv=2024"), "what is not a key is kept");
});

test("an error object inside a stream, or a text, says its words the same way, with the status the stream had", () => {
  assert.deepEqual(errorBodyOfObject({ error: { message: "Overloaded", type: "overloaded_error", code: "529" } }, 200), { status: 200, shape: "openai", message: "Overloaded", type: "overloaded_error", code: "529" });
  assert.deepEqual(errorBodyOfObject({ message: "The server had an error", type: "server_error" }, 200), { status: 200, shape: "openai", message: "The server had an error", type: "server_error" });
  assert.equal(errorBodyOfObject("plain words", 200).message, "plain words");
  assert.equal(errorBodyOfObject(null, 200), undefined);
  assert.equal(errorBodyOfObject({}, 200), undefined);
});

test("a body read from elsewhere keeps only what is valid, cleaned and cut", () => {
  assert.equal(normalizeErrorBody({ status: 400, shape: "openai", message: `Bad ${KEY}`, extra: "x" }, (text) => redactSecrets(text, [KEY])).message, "Bad [redacted]");
  assert.equal(normalizeErrorBody({ status: 99, shape: "openai", message: "x" }), undefined);
  assert.equal(normalizeErrorBody({ status: 400, shape: "weird", message: "x" }), undefined);
  assert.equal(normalizeErrorBody("x"), undefined);
  assert.equal(normalizeErrorBody({ status: 400, shape: "text", raw: "x".repeat(5000) }).raw.length, 2048);
});

test("only this refusal is the class: the value of a level, other 400s, other statuses and words that name neither the level nor the tools are not", () => {
  const body = (message, extra = {}) => ({ status: 400, shape: "openai", message, ...extra });
  assert.equal(refusesThinkingWithTools(body("Unsupported value: 'xhigh' is not supported with the 'gpt-5' model. Supported values are: 'low', 'medium', 'high'.", { param: "reasoning_effort" })), false, "the value of the level is another thing");
  assert.equal(refusesThinkingWithTools(body("Invalid schema for function 'result': 'additionalProperties' is required.")), false);
  assert.equal(refusesThinkingWithTools(body("max_tokens is too large", { param: "max_tokens" })), false);
  assert.equal(refusesThinkingWithTools(body("Function tools are not supported for this deployment.")), false, "tools alone, with no level named");
  assert.equal(refusesThinkingWithTools(body("Unsupported parameter: 'reasoning_effort' is not supported with this model.", { param: "reasoning_effort" })), false, "a model that takes no level at all says nothing of tools: it is the other class");
  assert.equal(refusesThinkingWithTools({ ...body(MESSAGE("m")), status: 500 }), false);
  assert.equal(refusesThinkingWithTools({ ...body(MESSAGE("m")), status: 422 }), true, "a gateway may say it with a 422");
  assert.equal(refusesThinkingWithTools(body("Function calling is incompatible with the reasoning_effort parameter.")), true);
  assert.equal(refusesThinkingWithTools(body("Tools cannot be combined with reasoning.", { param: "reasoning_effort" })), true, "the parameter names the level");
  assert.equal(refusesThinkingWithTools(body("The tool call failed", { param: "reasoning_effort" })), false, "the words say nothing of a refusal");
  assert.equal(refusesThinkingWithTools(undefined), false);
});

// ─── Through the client ─────────────────────────────────────────────────────

/**
 * The providers as the documentation of Azure OpenAI describes the models that refuse a thinking level with function tools on Chat Completions («Function tools with reasoning_effort are not supported for … in
 * /v1/chat/completions. To use function tools, use /v1/responses or set reasoning_effort to 'none'.»), by family. `omit` (gpt-5.6-sol): the request is taken with the level left out, and with none. `none`
 * (gpt-6-luna): only with none, a request that leaves the level out is refused as well. `responses` (gpt-6.2-sol): never, and none is refused for its value. A request without tools is answered.
 */
const FAMILY = { "gpt-6-luna": "none", "gpt-6.2-sol": "responses", "gpt-5.6-sol": "omit" };
const noneRefusal = () => new Response(JSON.stringify({ error: { message: "Unsupported value: 'reasoning_effort' does not support 'none' with this model.", type: "invalid_request_error", param: "reasoning_effort", code: "unsupported_value" } }), { status: 400, headers: { "content-type": "application/json" } });
function provider(families = FAMILY, { valueRefusal = true } = {}) {
  return recording((entry) => {
    const sent = entry.body.model;
    const family = families[sent] ?? "omit";
    if (!entry.body.tools) return reply("prose");
    const level = entry.body.reasoning_effort;
    if (family === "omit") return level && level !== "none" ? refusal(sent) : toolReply();
    if (family === "none") return level === "none" ? toolReply() : refusal(sent);
    return level === "none" && valueRefusal ? noneRefusal() : refusal(sent);
  });
}
const levelsOf = (calls) => calls.map((call) => call.body.reasoning_effort);
const trail = (attempts) => attempts.map((attempt) => [attempt.attempt, attempt.thinkingMode, attempt.thinkingWhy]);

test("gpt-5.6-sol, which takes tools with the level left out: asked again once without the level, remembered, and the next request with tools carries no level while a request without tools keeps it", async () => {
  const { fetch, calls } = provider();
  const memory = createModelMemory();
  const learned = [];
  const attempts = [];
  const ends = [];
  const ai = createFetchAi(only("gpt-5.6-sol"), { fetch, memory, onLearned: (learning) => learned.push(learning), onAttempt: (attempt) => attempts.push(attempt), onAttemptEnd: (end) => ends.push(end) });

  const first = await ai.complete(SCHEMA_ASK);
  assert.deepEqual(first.json, { ok: true });
  assert.deepEqual(levelsOf(calls), ["high", undefined], "asked again, once, and it answered");
  assert.equal(learned.length, 1);
  assert.deepEqual([learned[0].kind, learned[0].integrationId, learned[0].integrationName, learned[0].model, learned[0].off], ["no-thinking-with-tools", "az", "AzureOpenAi-GW", "gpt-5.6-sol", "omit"]);
  assert.equal(learned[0].body.message, MESSAGE("gpt-5.6-sol"), "the provider's words, whole");
  assert.deepEqual([learned[0].body.type, learned[0].body.param], ["invalid_request_error", "reasoning_effort"]);
  assert.equal(memory.noThinkingWithTools("az", "gpt-5.6-sol"), true);
  assert.equal(memory.noThinkingWithTools("az", "another-model"), undefined);
  assert.equal(memory.learned.length, 1);

  // The trail says what happened: the request that was refused, with the words of the provider, and the one that worked.
  assert.deepEqual(trail(attempts), [[1, "high", undefined], [2, "not-sent", "tools"]]);
  assert.equal(ends[0].outcome, "failed");
  assert.equal(ends[0].status, 400);
  assert.equal(ends[0].errorBody.message, MESSAGE("gpt-5.6-sol"));
  assert.equal(ends[1].outcome, "ok");
  assert.ok(attempts[1].notes.some((note) => /refuses a thinking level when the request carries function tools/.test(note)));

  // The next request with tools asks once, without the level, and says so from the start.
  attempts.length = 0;
  await ai.complete(SCHEMA_ASK);
  assert.deepEqual(levelsOf(calls), ["high", undefined, undefined], "one request, no refusal");
  assert.deepEqual(trail(attempts), [[1, "not-sent", "tools"]]);
  assert.equal(learned.length, 1, "it is learned once");

  // A request without tools to the same model keeps the level it was configured with.
  attempts.length = 0;
  assert.equal((await ai.complete(ASK)).text, "prose");
  assert.equal(calls[3].body.reasoning_effort, "high");
  assert.deepEqual(attempts.map((attempt) => [attempt.thinkingMode, attempt.thinkingWhy]), [["high", undefined]]);
});

test("gpt-6-luna, which refuses a request with tools that leaves the level out as well, and takes none: asked without the level, then with none, and remembered as a model that takes none", async () => {
  const { fetch, calls } = provider();
  const memory = createModelMemory();
  const learned = [];
  const attempts = [];
  const ends = [];
  const ai = createFetchAi(only("gpt-6-luna"), { fetch, memory, onLearned: (learning) => learned.push(learning), onAttempt: (attempt) => attempts.push(attempt), onAttemptEnd: (end) => ends.push(end) });

  const first = await ai.complete(SCHEMA_ASK);
  assert.deepEqual(first.json, { ok: true });
  assert.deepEqual(levelsOf(calls), ["high", undefined, "none"], "the level, no level, none");
  assert.deepEqual(ends.map((end) => end.outcome), ["failed", "failed", "ok"]);
  assert.deepEqual(trail(attempts), [[1, "high", undefined], [2, "not-sent", "tools"], [3, "none", "tools"]]);
  assert.deepEqual(attempts.map((attempt) => attempt.attempt), [1, 2, 3], "every request counts");
  assert.equal(learned.length, 1, "learned when it answered, and once");
  assert.equal(learned[0].off, "none");
  assert.equal(learned[0].body.message, MESSAGE("gpt-6-luna"), "the provider's words of the first refusal");
  assert.equal(memory.noThinkingWithTools("az", "gpt-6-luna"), "none");
  assert.ok(attempts[2].notes.some((note) => /was replaced by "none"/.test(note)));

  // The next request with tools is asked with none at once; a request without tools keeps its level.
  attempts.length = 0;
  await ai.complete(SCHEMA_ASK);
  assert.deepEqual(levelsOf(calls), ["high", undefined, "none", "none"]);
  assert.deepEqual(trail(attempts), [[1, "none", "tools"]]);
  assert.equal((await ai.complete(ASK)).text, "prose");
  assert.equal(calls[4].body.reasoning_effort, "high");
});

test("a model that was chosen no level for is refused all the same, and is asked with none: the level left out is a request that it refuses too", async () => {
  const { fetch, calls } = provider();
  const memory = createModelMemory();
  const attempts = [];
  const ai = createFetchAi(configOf({ models: ["gpt-6-luna"], thinking: "automatic" }), { fetch, memory, onAttempt: (attempt) => attempts.push(attempt) });
  assert.deepEqual((await ai.complete(SCHEMA_ASK)).json, { ok: true });
  assert.deepEqual(levelsOf(calls), [undefined, "none"], "the request that left the level out was the first: it is not asked again that way");
  assert.deepEqual(trail(attempts), [[1, "automatic", undefined], [2, "none", "tools"]]);
  assert.equal(memory.noThinkingWithTools("az", "gpt-6-luna"), "none");
});

test("gpt-6.2-sol, which takes function tools on the Responses API only: asked three ways, refused each time, the error says its words and what was tried, and nothing is learned", async () => {
  const { fetch, calls } = provider();
  const memory = createModelMemory();
  const learned = [];
  const failure = await createFetchAi(only("gpt-6.2-sol"), { fetch, memory, onLearned: (learning) => learned.push(learning) }).complete(SCHEMA_ASK).then(() => null, (error) => error);
  assert.deepEqual(levelsOf(calls), ["high", undefined, "none"]);
  assert.ok(failure);
  assert.equal(failure.status, 400);
  assert.equal(failure.body.message, "Unsupported value: 'reasoning_effort' does not support 'none' with this model.", "the provider's last words");
  assert.match(failure.message, /HTTP 400 — Unsupported value: 'reasoning_effort' does not support 'none' with this model\. \[type: invalid_request_error, param: reasoning_effort, code: unsupported_value\]\. Narrarium asked again without a thinking level and with "none", and the model still refuses function tools on this endpoint: the provider says to use \/v1\/responses for them\.$/);
  assert.ok(!/Nothing was applied/.test(failure.message), "the remedy of a level that the author chose is not for a level that the engine did");
  assert.deepEqual(failure.route.map((step) => [step.outcome, step.status, step.body?.param]), [["failed", 400, "reasoning_effort"], ["failed", 400, "reasoning_effort"], ["failed", 400, "reasoning_effort"]], "every request is in the trail");
  assert.deepEqual(learned, [], "no way answered: nothing is learned");
  assert.equal(memory.noThinkingWithTools("az", "gpt-6.2-sol"), undefined);
  assert.equal((await createFetchAi(only("gpt-6.2-sol"), { fetch, memory }).complete(ASK)).text, "prose", "a request without tools is answered, with its level");
  assert.equal(levelsOf(calls).at(-1), "high");
});

test("the models are learned one by one: what one model teaches is not taught to the other, and each is remembered by the integration and the model", async () => {
  const { fetch, calls } = provider();
  const memory = createModelMemory();
  const config = configOf({ models: ["gpt-5.6-sol", "gpt-6-luna"] });
  await createFetchAi(config, { fetch, memory }).complete(SCHEMA_ASK);
  assert.deepEqual([memory.noThinkingWithTools("az", "gpt-5.6-sol"), memory.noThinkingWithTools("az", "gpt-6-luna")], [true, undefined]);
  const luna = { ...config, taskRouting: { autopilot: { primary: { integrationId: "az", model: "gpt-6-luna" }, fallbacks: [] } } };
  await createFetchAi(luna, { fetch, memory }).complete(SCHEMA_ASK);
  assert.equal(calls.at(-3).body.reasoning_effort, "high", "the other model keeps its level, with tools, until it says otherwise");
  assert.deepEqual([memory.noThinkingWithTools("az", "gpt-5.6-sol"), memory.noThinkingWithTools("az", "gpt-6-luna")], [true, "none"]);
});

test("a model that is set not to think with tools in its configuration is never sent a level with them (or is sent none), and is not refused: no request is wasted, and without tools it keeps the level", async () => {
  const { fetch, calls } = provider();
  const config = pickAiRuntimeConfig(configOf({ models: ["gpt-5.6-sol", "gpt-6-luna"], modelExtra: { "gpt-5.6-sol": { noThinkingWithTools: true }, "gpt-6-luna": { noThinkingWithTools: "none" } } }));
  assert.deepEqual(config.aiIntegrations[0].chatModels.map((entry) => entry.noThinkingWithTools), [true, "none"], "the configuration keeps both");
  const attempts = [];
  const ai = createFetchAi(config, { fetch, onAttempt: (attempt) => attempts.push(attempt) });
  await ai.complete(SCHEMA_ASK);
  assert.deepEqual(levelsOf(calls), [undefined]);
  assert.deepEqual(trail(attempts), [[1, "not-sent", "tools"]]);
  await ai.complete(ASK);
  assert.equal(calls[1].body.reasoning_effort, "high");

  const luna = { ...config, taskRouting: { autopilot: { primary: { integrationId: "az", model: "gpt-6-luna" }, fallbacks: [] } } };
  attempts.length = 0;
  await createFetchAi(luna, { fetch, onAttempt: (attempt) => attempts.push(attempt) }).complete(SCHEMA_ASK);
  assert.deepEqual(levelsOf(calls).slice(2), ["none"]);
  assert.deepEqual(trail(attempts), [[1, "none", "tools"]]);

  const odd = (value) => pickAiRuntimeConfig({ aiIntegrations: [{ ...configOf().aiIntegrations[0], chatModels: [{ ...model("m"), noThinkingWithTools: value }] }] }).aiIntegrations[0].chatModels[0].noThinkingWithTools;
  assert.deepEqual(["yes", false, "omit", 1, null].map(odd), [undefined, undefined, undefined, undefined, undefined], "only true and none are values");
  assert.deepEqual(engine.redactAiRuntimeConfig(config).integrations[0].models.map((entry) => entry.noThinkingWithTools), [true, "none"], "the safe view says them");
});

test("a model set to be asked with the level left out that refuses it too is asked with none, and learned as a model that takes none: the author's setting is not made wrong", async () => {
  const { fetch, calls } = provider();
  const memory = createModelMemory();
  const learned = [];
  const config = pickAiRuntimeConfig(configOf({ models: ["gpt-6-luna"], modelExtra: { "gpt-6-luna": { noThinkingWithTools: true } } }));
  await createFetchAi(config, { fetch, memory, onLearned: (learning) => learned.push(learning) }).complete(SCHEMA_ASK);
  assert.deepEqual(levelsOf(calls), [undefined, "none"], "the level left out is the first request: it is not asked again that way");
  assert.deepEqual(learned.map((learning) => learning.off), ["none"]);
  await createFetchAi(config, { fetch, memory }).complete(SCHEMA_ASK);
  assert.deepEqual(levelsOf(calls), [undefined, "none", "none"], "what the memory knows is better than the setting");
});

test("a model asked with none that its provider refuses for the tools is asked without a level, and that is what is learned", async () => {
  const { fetch, calls } = recording((entry) => (entry.body.tools && entry.body.reasoning_effort === "none" ? refusal("gpt-5.6-sol") : toolReply()));
  const memory = createModelMemory();
  const config = pickAiRuntimeConfig(configOf({ models: ["gpt-5.6-sol"], modelExtra: { "gpt-5.6-sol": { noThinkingWithTools: "none" } } }));
  await createFetchAi(config, { fetch, memory }).complete(SCHEMA_ASK);
  assert.deepEqual(levelsOf(calls), ["none", undefined]);
  assert.equal(memory.noThinkingWithTools("az", "gpt-5.6-sol"), true);
});

test("none is sent only to a model that takes its level as reasoning_effort: a model with another thinking parameter, or one that does not reason, is asked without a level, and no way is asked twice", async () => {
  for (const extra of [{ reasoningParameter: "chat_template_kwargs.reasoning_strength" }, { supportsReasoning: false }, { reasoningParameter: "none" }]) {
    const { fetch, calls } = recording(() => refusal("gpt-6-luna"));
    const failure = await createFetchAi(configOf({ models: ["gpt-6-luna"], modelExtra: { "gpt-6-luna": extra } }), { fetch }).complete(SCHEMA_ASK).then(() => null, (error) => error);
    assert.ok(failure);
    assert.ok(calls.every((call) => call.body.reasoning_effort !== "none"), JSON.stringify(extra));
    assert.ok(calls.length <= 2, `${JSON.stringify(extra)}: ${calls.length} requests`);
  }
});

test("without a memory of the host the call that learns it asks again every time: the client never needs one to work", async () => {
  const { fetch, calls } = provider();
  const ai = createFetchAi(only("gpt-6-luna"), { fetch });
  await ai.complete(SCHEMA_ASK);
  await ai.complete(SCHEMA_ASK);
  assert.equal(calls.length, 6, "the level, no level and none, twice");
});

test("a call brings its own memory, which wins over the client's, and says what it learned to its own listener", async () => {
  const { fetch, calls } = provider();
  const own = createModelMemory([{ integrationId: "az", model: "gpt-6-luna", how: "none" }]);
  const learned = [];
  await createFetchAi(only("gpt-6-luna"), { fetch, memory: createModelMemory() }).complete({ ...SCHEMA_ASK, memory: own, onLearned: (learning) => learned.push(learning) });
  assert.deepEqual(levelsOf(calls), ["none"], "the memory of the call knew it already");
  assert.deepEqual(learned, []);
  assert.deepEqual(own.learned, [], "what a host knew is not a learning");
});

test("a memory does not forget a better way: none is not made omit again, and a learning of none replaces omit", () => {
  const memory = createModelMemory();
  const body = { status: 400, shape: "openai", message: "m" };
  const learning = (off) => ({ kind: "no-thinking-with-tools", integrationId: "az", integrationName: "A", model: "m", off, body });
  memory.learn(learning("omit"));
  assert.equal(memory.noThinkingWithTools("az", "m"), true);
  memory.learn(learning("none"));
  assert.equal(memory.noThinkingWithTools("az", "m"), "none");
  memory.learn(learning("omit"));
  assert.equal(memory.noThinkingWithTools("az", "m"), "none");
  assert.deepEqual(memory.learned.map((entry) => entry.off), ["none"], "one entry for a model");
});

test("only this refusal is asked again: any other 400 fails at once with its words; a provider that keeps refusing is asked each way once, and no more; a refusal of the value of the level is the end", async () => {
  const other = recording(() => new Response(JSON.stringify({ error: { message: "Invalid schema for function 'result'.", type: "invalid_request_error", param: "tools[0].function.parameters", code: "invalid_function_parameters" } }), { status: 400, headers: { "content-type": "application/json" } }));
  const failure = await createFetchAi(only("gpt-6-luna"), { fetch: other.fetch }).complete(SCHEMA_ASK).then(() => null, (error) => error);
  assert.equal(other.calls.length, 1, "not swallowed");
  assert.equal(failure.body.message, "Invalid schema for function 'result'.");
  assert.deepEqual([failure.body.type, failure.body.param, failure.body.code], ["invalid_request_error", "tools[0].function.parameters", "invalid_function_parameters"]);
  assert.match(failure.message, /HTTP 400 — Invalid schema for function 'result'\. \[type: invalid_request_error, param: tools\[0\]\.function\.parameters, code: invalid_function_parameters\]/);

  const stubborn = recording(() => refusal("gpt-6-luna"));
  const refused = await createFetchAi(only("gpt-6-luna"), { fetch: stubborn.fetch, memory: createModelMemory() }).complete(SCHEMA_ASK).then(() => null, (error) => error);
  assert.deepEqual(levelsOf(stubborn.calls), ["high", undefined, "none"], "each way once, and no more");
  assert.equal(refused.body.message, MESSAGE("gpt-6-luna"));
  assert.deepEqual(refused.route.map((step) => [step.position, step.outcome, step.status, step.body?.param]), [[0, "failed", 400, "reasoning_effort"], [0, "failed", 400, "reasoning_effort"], [0, "failed", 400, "reasoning_effort"]], "every request is in the trail, with the provider's words");

  // A refusal of the value of none ends it at once, as another 400 does.
  const valueRefused = recording((entry) => (entry.body.reasoning_effort === "none" ? noneRefusal() : refusal("gpt-6-luna")));
  await createFetchAi(only("gpt-6-luna"), { fetch: valueRefused.fetch }).complete(SCHEMA_ASK).then(() => null, (error) => error);
  assert.deepEqual(levelsOf(valueRefused.calls), ["high", undefined, "none"]);

  // Without tools, the same words are not this refusal: the request is not asked again.
  const prose = recording(() => refusal("gpt-6-luna"));
  const proseFailure = await createFetchAi(only("gpt-6-luna"), { fetch: prose.fetch }).complete(ASK).then(() => null, (error) => error);
  assert.equal(prose.calls.length, 1);
  assert.ok(proseFailure);
});

test("the same refusal from a fallback: the primary that fails, then the fallback that is refused once and answers, and the model that was learned is the fallback's", async () => {
  const config = configOf({ models: ["gpt-6-luna", "gpt-5.6-sol"] });
  const { fetch, calls } = recording((entry) => {
    if (entry.body.model === "gpt-6-luna") return new Response(JSON.stringify({ error: { message: "The primary is down." } }), { status: 500, headers: { "content-type": "application/json" } });
    return entry.body.tools && "reasoning_effort" in entry.body ? refusal("gpt-5.6-sol") : toolReply({ ok: "fallback" });
  });
  const memory = createModelMemory();
  const attempts = [];
  const response = await createFetchAi(config, { fetch, memory, onAttempt: (attempt) => attempts.push(attempt) }).complete(SCHEMA_ASK);
  assert.deepEqual(response.json, { ok: "fallback" });
  assert.deepEqual(calls.map((call) => [call.body.model, "reasoning_effort" in call.body]), [["gpt-6-luna", true], ["gpt-5.6-sol", true], ["gpt-5.6-sol", false]]);
  assert.deepEqual([memory.noThinkingWithTools("az", "gpt-6-luna"), memory.noThinkingWithTools("az", "gpt-5.6-sol")], [undefined, true]);
  assert.deepEqual(attempts.map((attempt) => [attempt.attempt, attempt.index, attempt.model, attempt.thinkingMode]), [[1, 0, "gpt-6-luna", "high"], [2, 1, "gpt-5.6-sol", "high"], [3, 1, "gpt-5.6-sol", "not-sent"]]);
});

test("the retries of a refusal run for the time their first request had: the routing time that was left to a fallback is not taken from a candidate that is asked again", async () => {
  const { fetch } = provider();
  const config = { ...only("gpt-6-luna"), routingExecution: { maxTotalDurationMs: 1 } };
  const response = await createFetchAi(config, { fetch }).complete(SCHEMA_ASK);
  assert.deepEqual(response.json, { ok: true });
});

test("the words of a provider that refuses are shown whole in the error whatever the status: a 502 page, a body with nothing in it, a text, a huge body and one with a key", async () => {
  const failureOf = async (init, body) => {
    const { fetch } = recording(() => new Response(body, init));
    return createFetchAi(only("gpt-6-luna"), { fetch }).complete(ASK).then(() => null, (error) => error);
  };
  const empty = await failureOf({ status: 400 }, "");
  assert.match(empty.message, /: HTTP 400, no body$/);
  assert.equal(empty.body.shape, "empty");
  const page = await failureOf({ status: 502, headers: { "content-type": "text/html" } }, "<html><head><title>502 Bad Gateway</title></head><body>nginx</body></html>");
  assert.match(page.message, /HTTP 502 — an HTML page from a gateway or a proxy \("502 Bad Gateway"\)/);
  assert.equal(page.transient, true);
  const text = await failureOf({ status: 400 }, "upstream connect error or disconnect/reset before headers. reset reason: connection termination");
  assert.match(text.message, /HTTP 400 — upstream connect error or disconnect\/reset before headers\. reset reason: connection termination\./);
  const huge = await failureOf({ status: 500 }, "z".repeat(300_000));
  assert.ok(huge.body.raw.length <= 2048 && huge.body.raw.endsWith("…"));
  assert.ok(huge.message.length < 2300);
  const keyed = await failureOf({ status: 401 }, JSON.stringify({ error: { message: `Incorrect API key provided: ${KEY}. Use https://x.test/v1?api_key=${KEY}&sig=SECRETSIG123`, type: "invalid_request_error" } }));
  for (const secret of [KEY, "SECRETSIG123"]) {
    assert.ok(!keyed.message.includes(secret) && !JSON.stringify(keyed.body).includes(secret), `no ${secret}`);
  }
  assert.match(keyed.body.message, /Incorrect API key provided: \[redacted\]/);
  const long = await failureOf({ status: 400 }, JSON.stringify({ error: { message: "It is " + "very ".repeat(600) + "long.", type: "invalid_request_error" } }));
  assert.ok(long.body.message.length <= 2000 && long.body.message.endsWith("…"));
});

test("an error inside a stream says its words too, whole", async () => {
  const stream = new Response(`data: ${JSON.stringify({ error: { message: `The server is overloaded. ${"Please retry later. ".repeat(40)}`, type: "server_error", code: "overloaded" } })}\n\ndata: [DONE]\n\n`, { status: 200, headers: { "content-type": "text/event-stream" } });
  const { fetch } = recording(() => stream);
  const failure = await createFetchAi(only("gpt-6-luna"), { fetch }).complete(ASK).then(() => null, (error) => error);
  assert.ok(failure);
  assert.equal(failure.body.type, "server_error");
  assert.equal(failure.body.code, "overloaded");
  assert.ok(failure.body.message.length > 600, "not cut at four hundred characters");
  assert.ok(failure.message.includes("Please retry later. Please retry later."));
});

// ─── The model's api-version and the learned flag do not touch each other ───

test("the API version of a model and the flag of a model are independent: the version is the model's through the refusal and both retries, and the flag does not change which version a model is asked with", async () => {
  const config = {
    aiIntegrations: [{ id: "az", name: "Azure GW", provider: "azure_openai", endpoint: "https://res.openai.azure.com", apiKey: KEY, apiVersion: "2025-01-01-preview", thinking: "high", chatModels: [model("gpt-6-luna", { apiVersion: "2025-04-01-preview" }), model("gpt-5.6-sol")] }],
    taskRouting: { autopilot: { primary: { integrationId: "az", model: "gpt-6-luna" }, fallbacks: [{ integrationId: "az", model: "gpt-5.6-sol" }] } },
  };
  const versionOf = (url) => new URL(url).searchParams.get("api-version");
  const luna = (entry) => entry.url.includes("gpt-6-luna");
  const { fetch, calls } = recording((entry) => {
    if (!entry.body.tools) return reply();
    const level = entry.body.reasoning_effort;
    if (luna(entry)) return level === "none" ? toolReply() : refusal("gpt-6-luna");
    return level && level !== "none" ? refusal("gpt-5.6-sol") : toolReply();
  });
  const memory = createModelMemory();
  const attempts = [];
  const ai = createFetchAi(config, { fetch, memory, onAttempt: (attempt) => attempts.push(attempt) });
  await ai.complete(SCHEMA_ASK);
  assert.deepEqual(calls.map((call) => [luna(call) ? "luna" : "sol", versionOf(call.url), call.body.reasoning_effort]), [["luna", "2025-04-01-preview", "high"], ["luna", "2025-04-01-preview", undefined], ["luna", "2025-04-01-preview", "none"]], "every retry is asked with the same version");
  assert.deepEqual(attempts.map((attempt) => attempt.apiVersion), Array(3).fill("2025-04-01-preview"));
  // The model next to it keeps both its version and its level, until it says otherwise.
  const sol = { ...config, taskRouting: { autopilot: { primary: { integrationId: "az", model: "gpt-5.6-sol" }, fallbacks: [] } } };
  await createFetchAi(sol, { fetch, memory }).complete(SCHEMA_ASK);
  assert.deepEqual(calls.slice(3).map((call) => [versionOf(call.url), call.body.reasoning_effort]), [["2025-01-01-preview", "high"], ["2025-01-01-preview", undefined]]);
  assert.equal(engine.effectiveApiVersion(config.aiIntegrations[0], { apiVersion: "2025-04-01-preview" }), "2025-04-01-preview");
  const flagged = pickAiRuntimeConfig({ aiIntegrations: [{ ...config.aiIntegrations[0], chatModels: [{ ...model("gpt-6-luna", { apiVersion: "2025-04-01-preview", noThinkingWithTools: "none" }) }] }] });
  assert.deepEqual([flagged.aiIntegrations[0].chatModels[0].apiVersion, flagged.aiIntegrations[0].chatModels[0].noThinkingWithTools], ["2025-04-01-preview", "none"], "both survive the configuration together");
});

// ─── Through the runner and the session ─────────────────────────────────────

const CAPABILITIES = ["autopilot", "director", "reader-evaluation", "reader-evaluation-summary", "review", "simple-tasks"];
const FAST = { readers: false, readersOnPlan: false, specialists: false, pauseAfterPlan: false };

function sessionRun({ language, steps = 2, extra = {}, name = "gpt-5.6-sol" } = {}) {
  const base = createFakeAutopilotAi({ reviewVerdict: () => "approve", scenes: 1, words: 200 });
  let answer = null;
  const config = { aiIntegrations: configOf({ models: [name] }).aiIntegrations, taskRouting: Object.fromEntries(CAPABILITIES.map((capability) => [capability, { primary: { integrationId: "az", model: name }, fallbacks: [] }])) };
  const { fetch, calls } = recording((entry) => {
    if (entry.body.tools) {
      const level = entry.body.reasoning_effort;
      const refused = FAMILY[name] === "none" ? level !== "none" : level && level !== "none";
      if (refused) return refusal(name);
    }
    const tool = entry.body.tools?.[0]?.function?.name;
    return tool ? toolReply(answer.json) : reply(answer.text);
  });
  const client = createFetchAi(config, { fetch });
  const ai = {
    calls: base.calls,
    async complete(request) {
      answer = await base.complete({ ...request, onText: undefined, onProgress: undefined, onStructuredText: undefined });
      return client.complete(request);
    },
  };
  const session = new AutopilotSession({ bookId: "book", store: new MemoryBookStore(seedBookFiles({ chapters: 1, ...(language ? { language } : {}) })), ai, host: "server", hostLabel: "test", retryDelayMs: 0, ...extra });
  const events = [];
  session.subscribe((event) => events.push(event));
  return {
    calls,
    events,
    session,
    async run() {
      await session.start({ brief: { idea: "A harbor.", targetChapters: 1, scenesPerChapter: 1, wordsPerScene: 300 }, options: FAST, limits: { steps } });
      await session.waitForIdle();
    },
  };
}

test("through the runner: the session learns the model once, says it as an event and as a notice with the words of the provider and both ways out, and later calls go without the level at once", async () => {
  const { calls, events, run, session } = sessionRun();
  await run();
  const learned = events.filter((event) => event.type === "model-learned");
  assert.equal(learned.length, 1, "learned once for the whole run");
  assert.deepEqual([learned[0].learned, learned[0].integrationId, learned[0].integrationName, learned[0].model, learned[0].off, learned[0].responses], ["no-thinking-with-tools", "az", "AzureOpenAi-GW", "gpt-5.6-sol", "omit", true]);
  assert.equal(learned[0].body.message, MESSAGE("gpt-5.6-sol"));
  assert.equal(learned[0].body.param, "reasoning_effort");
  const notices = events.filter((event) => event.type === "insight" && event.code === "modelLearned");
  assert.equal(notices.length, 1);
  assert.equal(notices[0].title, "gpt-5.6-sol: thinking is turned off when tools are used; the provider said so");
  assert.ok(notices[0].detail.includes(MESSAGE("gpt-5.6-sol")), "the provider's own words");
  assert.match(notices[0].detail, /It says to use the Responses API for this model \(\/v1\/responses\) or to turn thinking off when tools are used\./);
  assert.match(notices[0].detail, /Narrarium turned thinking off for the requests that carry tools, for this model only; requests without tools keep their thinking\./);
  assert.equal(notices[0].tone, "warning");
  assert.equal(notices[0].model, "gpt-5.6-sol", "a page says it in its own language with the name of the model");

  // One refusal for the whole run: every request with tools after the first two carries no level.
  const withTools = calls.filter((call) => call.body.tools);
  assert.deepEqual(withTools.map((call) => "reasoning_effort" in call.body), [true, false, false], "the refused request, the one asked again, and the step that came after");
  assert.ok(events.filter((event) => event.type === "task-finished" && event.activity.status === "succeeded").length >= 2, "the steps went on");

  // The live attempt says it as the request is sent, and the session keeps it for a client that connects later.
  const attempts = events.filter((event) => event.type === "call-attempt");
  assert.deepEqual([attempts[0].thinking, attempts[0].thinkingWhy], ["high", undefined]);
  assert.deepEqual([attempts[1].thinking, attempts[1].thinkingWhy, attempts[1].attempt], ["not-sent", "tools", 2]);
  assert.ok(attempts.slice(1).every((event) => event.thinking === "not-sent" && event.thinkingWhy === "tools"));
  const snapshot = await session.snapshot();
  assert.deepEqual(snapshot.learned.map((entry) => [entry.integrationId, entry.model, entry.kind]), [["az", "gpt-5.6-sol", "no-thinking-with-tools"]]);
  assert.ok(session.recentEvents(0).some((event) => event.type === "model-learned"), "kept in the replay of the session");
});

test("through the runner, for a model that takes none: the event says it, the notice says it asks with none, and later calls with tools carry none at once", async () => {
  const { calls, events, run, session } = sessionRun({ name: "gpt-6-luna" });
  await run();
  const learned = events.filter((event) => event.type === "model-learned");
  assert.equal(learned.length, 1);
  assert.equal(learned[0].off, "none");
  const notice = events.find((event) => event.type === "insight" && event.code === "modelLearned");
  assert.match(notice.detail, /it asks with reasoning_effort «none», the one value the model takes with them/);
  const levels = calls.filter((call) => call.body.tools).map((call) => call.body.reasoning_effort);
  assert.deepEqual(levels.slice(0, 4), ["high", undefined, "none", "none"], "the level, no level, none, and the next step with none at once");
  const attempts = events.filter((event) => event.type === "call-attempt");
  assert.deepEqual(attempts.slice(0, 3).map((event) => [event.thinking, event.thinkingWhy]), [["high", undefined], ["not-sent", "tools"], ["none", "tools"]]);
  const snapshot = await session.snapshot();
  assert.deepEqual(snapshot.learned.map((entry) => [entry.model, entry.off]), [["gpt-6-luna", "none"]]);
});

test("the notice is said in the language of the book, and says the one way out when the provider does not tell to use /v1/responses", async () => {
  const { events, run } = sessionRun({ language: "it" });
  await run();
  const notice = events.find((event) => event.type === "insight" && event.code === "modelLearned");
  assert.equal(notice.title, "gpt-5.6-sol: il thinking è disattivato quando si usano i tool; lo ha detto il provider");
  assert.match(notice.detail, /Dice di usare l'API Responses per questo modello \(\/v1\/responses\) oppure di disattivare il thinking quando si usano i tool\./);
  assert.ok(notice.detail.includes(MESSAGE("gpt-5.6-sol")));

  assert.equal(suggestsResponsesApi({ status: 400, shape: "openai", message: "Function tools with reasoning_effort are not supported for gpt-5.6-sol." }), false);
});

test("the records keep the provider's words of the refused request, as the first attempt of its call, and the request that worked as the second", async () => {
  const records = new MemoryAiCallStore();
  const { run } = sessionRun({ steps: 1, extra: { calls: records, callsSecrets: () => [KEY] } });
  await run();
  const tasks = await records.listTasks("book", { limit: 10 });
  const task = await records.readTask("book", tasks.tasks[0].activityId);
  const attempts = task.calls[0].attempts;
  assert.deepEqual(attempts.map((attempt) => attempt.outcome), ["failed", "ok"]);
  assert.equal(attempts[0].error.body.message, MESSAGE("gpt-5.6-sol"));
  assert.deepEqual([attempts[0].error.body.type, attempts[0].error.body.param], ["invalid_request_error", "reasoning_effort"]);
  assert.equal(attempts[0].error.status, 400);
  assert.ok(!JSON.stringify(attempts).includes(KEY));
});
