import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import * as engine from "../dist/index.js";
import { JSON_ASK, ASK, eventStream, failWith, jsonStream, live, recording, settle, sse, track } from "./transport-fakes.mjs";

// A model that is asked through the Responses API has its reply read as events (`response.output_text.delta`, `response.function_call_arguments.delta`, `response.completed`…) by the same client that reads Chat Completions:
// the deadlines, the live JSON of a structured reply, the usage, the costs and the failures are the same. What the owner captured from the Azure portal (a reasoning item and a text, `owner-capture.sse`) is read
// as it came; the other streams are made here from the event shapes that the Azure and OpenAI documentation describe (see fixtures/responses/README.md): they are reasoned from it, and not captured from a deployment.

const { AiProviderError, AiStreamInterruptedError, ResponsesStreamReader, createFetchAi, readResponse, responseAsChat } = engine;

const KEY = "k-azure-secret-123456";
const CAPTURE = readFileSync(new URL("./fixtures/responses/owner-capture.sse", import.meta.url), "utf8");
const CAPTURED_REQUEST = JSON.parse(readFileSync(new URL("./fixtures/responses/owner-capture.request.json", import.meta.url), "utf8"));

// ─── The events, as the documentation describes them ────────────────────────

const frame = (value, named = true) => `${named ? `event: ${value.type}\n` : ""}data: ${JSON.stringify(value)}\n\n`;
const response = (extra = {}) => ({ id: "resp_1", object: "response", status: "in_progress", model: "gpt-5.2", output: [], usage: null, error: null, incomplete_details: null, ...extra });
const REASONING = { id: "rs_1", type: "reasoning", content: [], encrypted_content: "<ENCRYPTED>", summary: [] };
const USAGE = { input_tokens: 27, input_tokens_details: { cached_tokens: 5 }, output_tokens: 17, output_tokens_details: { reasoning_tokens: 10 }, total_tokens: 44 };
const messageItem = (text, status = "completed") => ({ id: "msg_1", type: "message", status, role: "assistant", content: [{ type: "output_text", annotations: [], text }] });
const callItem = (args, extra = {}) => ({ id: "fc_1", type: "function_call", status: "completed", call_id: "call_1", name: "result", arguments: args, ...extra });
const opening = () => [frame({ type: "response.created", response: response() }), frame({ type: "response.in_progress", response: response() })];
const reasoning = (index = 0) => [frame({ type: "response.output_item.added", output_index: index, item: { ...REASONING } }), frame({ type: "response.output_item.done", output_index: index, item: { ...REASONING } })];
const closing = (type, output, extra = {}, usage = USAGE) => frame({ type, response: response({ status: type === "response.completed" ? "completed" : type === "response.failed" ? "failed" : "incomplete", output, usage, ...extra }) });

/** A reply of text, in pieces: the events of the owner's capture, with as many deltas as there are pieces. */
function textStream(pieces, { thinking = true, usage = USAGE, index = thinking ? 1 : 0 } = {}) {
  const whole = pieces.join("");
  return [
    ...opening(),
    ...(thinking ? reasoning(0) : []),
    frame({ type: "response.output_item.added", output_index: index, item: { id: "msg_1", type: "message", status: "in_progress", content: [], role: "assistant" } }),
    frame({ type: "response.content_part.added", output_index: index, content_index: 0, item_id: "msg_1", part: { type: "output_text", annotations: [], text: "" } }),
    ...pieces.map((delta) => frame({ type: "response.output_text.delta", output_index: index, content_index: 0, item_id: "msg_1", delta })),
    frame({ type: "response.output_text.done", output_index: index, content_index: 0, item_id: "msg_1", text: whole }),
    frame({ type: "response.content_part.done", output_index: index, content_index: 0, item_id: "msg_1", part: { type: "output_text", annotations: [], text: whole } }),
    frame({ type: "response.output_item.done", output_index: index, item: messageItem(whole) }),
    closing("response.completed", [...(thinking ? [REASONING] : []), messageItem(whole)], {}, usage),
  ];
}

/** A forced function call, its arguments in pieces: the item is added with its name, the arguments are streamed, then ended, then the item is. */
function callStream(pieces, { index = 1, name = "result", usage = USAGE, deltas = true, thinking = true } = {}) {
  const args = pieces.join("");
  return [
    ...opening(),
    ...(thinking ? reasoning(0) : []),
    frame({ type: "response.output_item.added", output_index: index, item: { id: `fc_${index}`, type: "function_call", status: "in_progress", call_id: `call_${index}`, name, arguments: "" } }),
    ...(deltas ? pieces.map((delta) => frame({ type: "response.function_call_arguments.delta", output_index: index, item_id: `fc_${index}`, delta })) : []),
    frame({ type: "response.function_call_arguments.done", output_index: index, item_id: `fc_${index}`, arguments: args }),
    frame({ type: "response.output_item.done", output_index: index, item: callItem(args, { id: `fc_${index}`, call_id: `call_${index}`, name }) }),
    closing("response.completed", [...(thinking ? [REASONING] : []), callItem(args, { id: `fc_${index}`, call_id: `call_${index}`, name })], {}, usage),
  ];
}

/** The text cut into pieces of `size` characters: a stream is read the same whatever way the network cuts it. */
const pieces = (text, size) => Array.from({ length: Math.ceil(text.length / size) }, (_, at) => text.slice(at * size, (at + 1) * size));

// ─── A call through the client ───────────────────────────────────────────────

const model = (extra = {}) => ({ id: "m", name: "gpt-5.2", capabilities: ["default"], apiProtocol: "responses", ...extra });
const integrationOf = (extra = {}, modelExtra = {}) => ({ id: "az", name: "oai-gw-002", provider: "azure_openai", endpoint: "https://oai-gw-002.openai.azure.com", apiKey: KEY, chatModels: [model(modelExtra)], ...extra });
const configOf = (extra = {}, modelExtra = {}, more = {}) => ({ aiIntegrations: [integrationOf(extra, modelExtra)], taskRouting: { autopilot: { primary: { integrationId: "az", model: "gpt-5.2" }, fallbacks: [] } }, ...more });

/** Runs one call against a stream (or any answer of a fake fetch) and keeps what the hooks heard. */
async function call(answer, { request = ASK, config = configOf(), options = {} } = {}) {
  const texts = [];
  const structured = [];
  const attempts = [];
  const ends = [];
  const fake = recording(typeof answer === "function" ? answer : () => answer);
  const ai = createFetchAi(config, { fetch: fake.fetch, minimumTimeoutMs: 1, ...options });
  const outcome = await ai.complete({
    ...request,
    onText: (value) => texts.push(value),
    onStructuredText: (value) => structured.push(value),
    onAttempt: (attempt) => attempts.push(attempt),
    onAttemptEnd: (end) => ends.push(end),
  }).then((value) => ({ response: value }), (error) => ({ error }));
  return { ...outcome, texts, structured, attempts, ends, calls: fake.calls };
}

const STRUCTURED = { ok: true, note: "Il gabbiano è già volato via — 你好 😀" };

// ─── The owner's capture ────────────────────────────────────────────────────

test("what the owner captured from the Azure portal is read as it came: a reasoning item that shows nothing, then \"ok\", and the tokens of the response", async () => {
  const run = await call(sse([CAPTURE]), { config: configOf({}, { pricing: { inputPerMTok: 2, cachedPerMTok: 0.5, outputPerMTok: 8 } }) });
  assert.equal(run.error, undefined, run.error?.message);
  assert.equal(run.response.text, "ok");
  assert.deepEqual(run.texts, ["ok"], "the text reaches the listener as it is read");
  assert.deepEqual(run.response.usage, { inputTokens: 27, outputTokens: 17, cachedInputTokens: 0 });
  assert.equal(run.response.usageKnown, true);
  // The 10 tokens of reasoning are inside the 17 of the output (the provider bills them as output): they are priced as output, and nothing is added for them.
  assert.ok(Math.abs(run.response.cost - (27 / 1e6 * 2 + 17 / 1e6 * 8)) < 1e-12, String(run.response.cost));
  assert.equal(run.response.costKnown, true);
  assert.equal(run.ends[0].outcome, "ok");
  assert.equal(run.ends[0].transport.end, "done", "there is no [DONE] in this API: its last event is the end of the stream");
  assert.equal(run.ends[0].transport.events, 10);
  assert.equal(run.ends[0].transport.usageReceived, true);
  assert.equal(run.ends[0].transport.finishReason, "stop");
  assert.equal(run.ends[0].transport.streamed, true);
  assert.equal(run.calls.length, 1);
  assert.equal(run.calls[0].url, "https://oai-gw-002.openai.azure.com/openai/responses?api-version=2025-04-01-preview", "the address the owner's playground used");
});

test("the request the client sends has the fields of the owner's capture where they carry the same meaning, and what a manuscript needs on top of them", async () => {
  const run = await call(sse([CAPTURE]), { request: { ...ASK, system: CAPTURED_REQUEST.input[0].content[0].text, user: CAPTURED_REQUEST.input[1].content[0].text, maxOutputTokens: 300 }, config: configOf({}, { thinking: undefined }, { taskRouting: { autopilot: { primary: { integrationId: "az", model: "gpt-5.2", thinking: "low" }, fallbacks: [] } } }) });
  const sent = run.calls[0].body;
  assert.deepEqual(sent.input, CAPTURED_REQUEST.input, "the developer message and the user message, as the playground wrote them");
  assert.deepEqual(sent.reasoning, CAPTURED_REQUEST.reasoning);
  assert.equal(sent.model, CAPTURED_REQUEST.model);
  assert.equal(sent.stream, true);
  assert.equal(sent.store, false, "the playground stores its responses; a manuscript is not stored");
  assert.equal(typeof sent.max_output_tokens, "number");
  assert.equal(run.calls[0].init.headers["api-key"], KEY);
  assert.equal(run.calls[0].init.headers.accept, "text/event-stream");
  assert.equal(run.attempts[0].thinking, "low");
});

test("a stream is read the same whatever way the network cuts it: one event at a time, and a few characters at a time", async () => {
  for (const size of [1, 2, 3, 7, 64, 1000, CAPTURE.length]) {
    const run = await call(sse(pieces(CAPTURE, size)));
    assert.equal(run.error, undefined, `${size}: ${run.error?.message}`);
    assert.equal(run.response.text, "ok", String(size));
    assert.deepEqual(run.response.usage, { inputTokens: 27, outputTokens: 17, cachedInputTokens: 0 }, String(size));
  }
  const crlf = await call(sse([CAPTURE.replace(/\n/g, "\r\n")]));
  assert.equal(crlf.response.text, "ok", "with the line ends of a Windows server");
});

test("a long reply arrives in pieces: the listener hears the text grow, and the text is what the deltas say", async () => {
  const words = ["Il ", "gabbiano ", "è ", "già ", "volato ", "via", " — ", "你好 ", "😀"];
  const run = await call(sse(textStream(words)));
  assert.equal(run.response.text, words.join(""));
  assert.equal(run.texts.at(-1), words.join(""));
  for (let at = 1; at < run.texts.length; at += 1) assert.ok(run.texts[at].startsWith(run.texts[at - 1]), "each value grows from the one before");
  assert.ok(run.texts.length >= 5);
  assert.deepEqual(run.structured, [], "a plain reply is no structured text");
});

test("events that nothing here needs are ignored, and so are comments, a text that comes without an event line, and the [DONE] that a gateway adds", async () => {
  const odd = [
    ": keep-alive\n\n",
    ...opening(),
    frame({ type: "response.web_search_call.in_progress", output_index: 0, item_id: "ws_1" }),
    frame({ type: "response.something.new", payload: { a: 1 } }),
    ...textStream(["fine"]).slice(2, -1),
    frame({ type: "response.output_text.annotation.added", output_index: 1, content_index: 0, annotation: { type: "url_citation" } }),
    frame({ type: "response.completed", response: response({ status: "completed", output: [REASONING, messageItem("fine")], usage: USAGE }) }, false),
    "data: [DONE]\n\n",
  ];
  const run = await call(sse(odd));
  assert.equal(run.error, undefined, run.error?.message);
  assert.equal(run.response.text, "fine");
});

// ─── A forced function, with thinking ──────────────────────────────────────

test("the forced function is the structured reply, and it is sent together with a thinking level: the call is read from the deltas of its arguments, and its JSON grows as it is written", async () => {
  const args = JSON.stringify(STRUCTURED);
  const run = await call(sse(callStream(pieces(args, 6))), { request: JSON_ASK, config: configOf({}, {}, { taskRouting: { autopilot: { primary: { integrationId: "az", model: "gpt-5.2", thinking: "high" }, fallbacks: [] } } }) });
  assert.equal(run.error, undefined, run.error?.message);
  assert.deepEqual(run.response.json, STRUCTURED);
  assert.equal(run.response.text, args, "the arguments are the text of the reply, as with Chat Completions");
  assert.equal(run.structured.at(-1), args);
  for (let at = 1; at < run.structured.length; at += 1) assert.ok(run.structured[at].startsWith(run.structured[at - 1]), "each value of the live JSON grows from the one before");
  assert.ok(run.structured.length >= 4, `the JSON arrives in pieces: ${run.structured.length} values`);
  assert.deepEqual(run.texts, [], "a structured reply is no prose for onText");
  const sent = run.calls[0].body;
  assert.deepEqual(sent.reasoning, { effort: "high" }, "a thinking level with function tools: what Chat Completions refuses for some models");
  assert.equal(sent.tools.length, 1);
  assert.equal(sent.tools[0].type, "function");
  assert.equal(sent.tools[0].name, "result");
  assert.equal(sent.tool_choice, "required");
  assert.equal(run.attempts[0].tools, true);
  assert.equal(run.attempts[0].thinkingMode, "high");
  assert.equal(run.ends[0].toolCalled, true);
  assert.equal(run.ends[0].usageKnown, true);
  assert.deepEqual(run.response.usage, { inputTokens: 27, outputTokens: 17, cachedInputTokens: 5 }, "the cached tokens are the input_tokens_details.cached_tokens");
});

test("a function whose arguments arrive in one piece (no deltas: only the event that ends them, and the item) is read once, never twice", async () => {
  const args = JSON.stringify(STRUCTURED);
  const run = await call(sse(callStream([args], { deltas: false })), { request: JSON_ASK });
  assert.equal(run.error, undefined, run.error?.message);
  assert.deepEqual(run.response.json, STRUCTURED);
  assert.deepEqual(run.structured, [args], "reported once, whole");
});

test("what a server says again after the deltas (the whole arguments, the item, the last event) is not added to them", async () => {
  const args = JSON.stringify(STRUCTURED);
  for (const size of [1, 5, args.length]) {
    const run = await call(sse(callStream(pieces(args, size))), { request: JSON_ASK });
    assert.deepEqual(run.response.json, STRUCTURED, String(size));
    assert.equal(run.response.text, args, String(size));
  }
});

test("an output that a server numbers in another way than its events (a reasoning item left out of it) is not read twice", async () => {
  const args = JSON.stringify(STRUCTURED);
  const text = await call(sse([...textStream(["fine"]).slice(0, -1), closing("response.completed", [messageItem("fine")])]));
  assert.equal(text.response.text, "fine");
  const called = await call(sse([...callStream(pieces(args, 9)).slice(0, -1), closing("response.completed", [callItem(args)])]), { request: JSON_ASK });
  assert.deepEqual(called.response.json, STRUCTURED);
  assert.equal(called.response.text, args);
});

test("a server that streams no function at all and gives it whole in its last event is read from there", async () => {
  const args = JSON.stringify(STRUCTURED);
  const run = await call(sse([...opening(), closing("response.completed", [REASONING, callItem(args)])]), { request: JSON_ASK });
  assert.equal(run.error, undefined, run.error?.message);
  assert.deepEqual(run.response.json, STRUCTURED);
  const text = await call(sse([...opening(), closing("response.completed", [REASONING, messageItem("Whole.")])]));
  assert.equal(text.response.text, "Whole.");
  assert.deepEqual(text.texts, ["Whole."]);
});

test("more than one call: the first that carries arguments is the reply, and the others are never joined to it", async () => {
  const first = JSON.stringify({ ok: true, note: "first" });
  const second = JSON.stringify({ ok: false, note: "second" });
  const events = [
    ...opening(),
    ...reasoning(0),
    frame({ type: "response.output_item.added", output_index: 1, item: { id: "fc_1", type: "function_call", status: "in_progress", call_id: "call_1", name: "result", arguments: "" } }),
    ...pieces(first, 8).map((delta) => frame({ type: "response.function_call_arguments.delta", output_index: 1, item_id: "fc_1", delta })),
    frame({ type: "response.function_call_arguments.done", output_index: 1, item_id: "fc_1", arguments: first }),
    frame({ type: "response.output_item.added", output_index: 2, item: { id: "fc_2", type: "function_call", status: "in_progress", call_id: "call_2", name: "result", arguments: "" } }),
    ...pieces(second, 8).map((delta) => frame({ type: "response.function_call_arguments.delta", output_index: 2, item_id: "fc_2", delta })),
    frame({ type: "response.function_call_arguments.done", output_index: 2, item_id: "fc_2", arguments: second }),
    closing("response.completed", [REASONING, callItem(first, { id: "fc_1" }), callItem(second, { id: "fc_2", call_id: "call_2" })]),
  ];
  const run = await call(sse(events), { request: JSON_ASK });
  assert.equal(run.error, undefined, run.error?.message);
  assert.deepEqual(run.response.json, { ok: true, note: "first" });
  assert.equal(run.structured.at(-1), first, "the live JSON is the first call's, to the end");
  assert.ok(run.structured.every((value, at, all) => at === 0 || value.startsWith(all[at - 1])), "and it never goes back");
});

test("a model that answers in text instead of calling the function is refused when \"Tools only\" is on, exactly as with Chat Completions", async () => {
  const run = await call(sse(textStream(["{\"ok\":true}"])), { request: JSON_ASK });
  assert.ok(run.error instanceof engine.AiReplyRejectedError, String(run.error));
  assert.match(run.error.message, /answered in text instead of calling the function "result"/);
});

// ─── What ends a reply other than the answer ────────────────────────────────

test("a reply cut by the output limit while the model reasoned has no text: the error says the limit was spent reasoning, from the tokens the provider counted", async () => {
  const usage = { input_tokens: 27, output_tokens: 300, output_tokens_details: { reasoning_tokens: 300 }, total_tokens: 327 };
  const events = [...opening(), ...reasoning(0), closing("response.incomplete", [REASONING], { incomplete_details: { reason: "max_output_tokens" } }, usage)];
  const run = await call(sse(events), { config: configOf({}, { maxOutputTokens: 300 }), request: { ...ASK, maxOutputTokens: 200 } });
  assert.ok(run.error instanceof AiProviderError, String(run.error));
  assert.equal(run.error.truncated, true);
  assert.equal(run.error.reasoningOnly, true, "the model reasoned and wrote nothing");
  assert.equal(run.error.limitReached, true, "and its own maximum was already the limit");
  assert.match(run.error.message, /used its output limit while reasoning, before writing the reply/);
  assert.deepEqual(run.error.usage, { inputTokens: 27, outputTokens: 300, cachedInputTokens: 0 }, "what it used is counted and billed");
  assert.equal(run.error.usageKnown, true);
});

test("a reply cut by the output limit after some text keeps what arrived, and is not taken for a model that only reasoned", async () => {
  const events = [
    ...opening(),
    frame({ type: "response.output_item.added", output_index: 0, item: { id: "msg_1", type: "message", status: "in_progress", content: [], role: "assistant" } }),
    frame({ type: "response.output_text.delta", output_index: 0, content_index: 0, item_id: "msg_1", delta: "Half a sto" }),
    closing("response.incomplete", [messageItem("Half a sto", "incomplete")], { incomplete_details: { reason: "max_output_tokens" } }, { input_tokens: 9, output_tokens: 4, output_tokens_details: { reasoning_tokens: 0 } }),
  ];
  const run = await call(sse(events));
  assert.equal(run.error.truncated, true);
  assert.equal(run.error.reasoningOnly, undefined);
  assert.match(run.error.message, /the reply was cut by the output token limit/);
  assert.equal(run.error.partialText, "Half a sto");
});

test("a reply that the content filter stops, and a reply that is incomplete for a reason nobody knows, are failures that say so", async () => {
  const filtered = await call(sse([...opening(), closing("response.incomplete", [], { incomplete_details: { reason: "content_filter" } }, { input_tokens: 9, output_tokens: 0 })]));
  assert.ok(filtered.error instanceof AiProviderError);
  assert.match(filtered.error.message, /the provider filtered the reply content \(content_filter\)/);
  const odd = await call(sse([...opening(), closing("response.incomplete", [], { incomplete_details: { reason: "something_new" } })]));
  assert.ok(odd.error instanceof AiStreamInterruptedError, String(odd.error));
  assert.match(odd.error.message, /the provider ended the reply with the finish reason "incomplete"/);
});

test("a model that refuses says so, and its own words are in the error, cut when they are long; the next candidate is tried", async () => {
  const words = "I'm sorry, but I can't help with that request.";
  const refusal = [
    ...opening(),
    frame({ type: "response.output_item.added", output_index: 0, item: { id: "msg_1", type: "message", status: "in_progress", content: [], role: "assistant" } }),
    frame({ type: "response.content_part.added", output_index: 0, content_index: 0, item_id: "msg_1", part: { type: "refusal", refusal: "" } }),
    frame({ type: "response.refusal.delta", output_index: 0, content_index: 0, item_id: "msg_1", delta: words }),
    frame({ type: "response.refusal.done", output_index: 0, content_index: 0, item_id: "msg_1", refusal: words }),
    closing("response.completed", [{ id: "msg_1", type: "message", status: "completed", role: "assistant", content: [{ type: "refusal", refusal: words }] }], {}, { input_tokens: 9, output_tokens: 12 }),
  ];
  const run = await call(sse(refusal));
  assert.ok(run.error instanceof AiProviderError, String(run.error));
  assert.equal(run.error.message, `azure_openai gpt-5.2: the model refused to answer: "${words}".`);
  assert.equal(run.error.retryable, false);
  assert.deepEqual(run.error.usage, { inputTokens: 9, outputTokens: 12, cachedInputTokens: 0 }, "a refusal was billed");
  const long = "x".repeat(900);
  const cut = await call(sse([...opening(), closing("response.completed", [{ id: "msg_1", type: "message", status: "completed", role: "assistant", content: [{ type: "refusal", refusal: long }] }])]));
  assert.ok(cut.error.message.endsWith(`${"x".repeat(300)}…".`), cut.error.message.slice(-40));
  const second = { ...configOf(), aiIntegrations: [integrationOf({ chatModels: [model(), model({ id: "n", name: "gpt-4.1" })] })], taskRouting: { autopilot: { primary: { integrationId: "az", model: "gpt-5.2" }, fallbacks: [{ integrationId: "az", model: "gpt-4.1" }] } } };
  const answers = [sse(refusal), sse(textStream(["ok"], { thinking: false }))];
  const fell = await call((_entry, number) => answers[number - 1], { config: second });
  assert.equal(fell.response.text, "ok", "the fallback answers");
  assert.deepEqual(fell.ends.map((end) => end.outcome), ["failed", "ok"]);
});

test("a reply that finishes after reasoning with no text and no call is an empty reply that says the model reasoned", async () => {
  const run = await call(sse([...opening(), ...reasoning(0), closing("response.completed", [REASONING])]));
  assert.ok(run.error instanceof AiProviderError);
  assert.match(run.error.message, /the model finished after reasoning without a reply/);
  const nothing = await call(sse([...opening(), closing("response.completed", [], {}, { input_tokens: 4, output_tokens: 0 })]));
  assert.match(nothing.error.message, /the provider returned an empty reply/);
});

// ─── Failures ───────────────────────────────────────────────────────────────

test("a response that failed brings its error, in the provider's words, as the failure of the call: retried when it depends on the moment, and not when it does not", async () => {
  const failed = (error) => sse([...opening(), frame({ type: "response.failed", response: response({ status: "failed", error }) })]);
  const server = await call(failed({ code: "server_error", message: "The model produced invalid content." }));
  assert.ok(server.error instanceof AiProviderError, String(server.error));
  assert.match(server.error.message, /the provider reported an error during the reply — The model produced invalid content\. \[code: server_error\]/);
  assert.equal(server.error.body.code, "server_error");
  assert.equal(server.error.retryable, true, "a server error is asked again as any failure that is not one that never changes");
  assert.equal(server.error.transient, undefined, "but it is not said to depend on the moment: the same words could be a prompt that the model cannot take");
  assert.equal(server.ends[0].transport.end, "error");
  const user = await call(failed({ code: "user_error", message: "The request is not valid." }));
  assert.equal(user.error.retryable, false, "a user error would be the same every time");
  const nothing = await call(sse([...opening(), frame({ type: "response.failed", response: response({ status: "failed" }) })]));
  assert.ok(nothing.error instanceof AiProviderError);
  assert.match(nothing.error.message, /the response failed/);
});

test("an error in the middle of a stream that answered with 200 (the Azure shape, and the OpenAI one) stops the reply where it was, and what arrived is kept", async () => {
  const half = textStream(["Half of ", "the reply"]).slice(0, 8);
  const azure = frame({ type: "error", error: { type: "server_error", code: "internal_error", message: "An internal error occurred.", param: null } });
  const openai = frame({ type: "error", code: "rate_limit_exceeded", message: "Rate limit reached.", param: null, sequence_number: 9 });
  for (const [name, last, kind] of [["azure", azure, "server_error"], ["openai", openai, "rate_limit_exceeded"]]) {
    const run = await call(sse([...half, last]));
    assert.ok(run.error instanceof AiStreamInterruptedError, `${name}: ${run.error}`);
    assert.equal(run.error.partialText, "Half of the reply", name);
    assert.equal(run.error.body.code ?? run.error.body.type, kind === "server_error" ? "internal_error" : kind, name);
    assert.match(run.error.message, /the provider reported an error during the reply/, name);
  }
  const limited = await call(sse([...opening(), frame({ type: "error", error: { type: "too_many_requests", code: "429", message: "Too many requests. Retry in 3 seconds." } })]));
  assert.ok(limited.error instanceof AiProviderError);
  assert.equal(limited.error.transient, true, "too_many_requests is of the moment");
  assert.equal(limited.error.status, 429);
  const forbidden = await call(sse([...opening(), frame({ type: "error", error: { type: "forbidden", code: "forbidden", message: "Access denied." } })]));
  assert.equal(forbidden.error.retryable, false);
  const named = await call(sse([`event: error\ndata: ${JSON.stringify({ type: "error", code: "server_error", message: "Boom." })}\n\n`]));
  assert.match(named.error.message, /Boom\./, "an error named by its event line is read the same");
});

test("a stream that closes without a last event did not end: what arrived is kept, and the call fails as a stream that was cut", async () => {
  const run = await call(sse(textStream(["It was ", "going well"]).slice(0, 8)));
  assert.ok(run.error instanceof AiStreamInterruptedError, String(run.error));
  assert.match(run.error.message, /the stream ended before the reply was complete/);
  assert.equal(run.error.partialText, "It was going well");
  assert.equal(run.ends[0].transport.end, "closed");
  assert.equal(run.ends[0].usageKnown, false);
});

test("the answer of an HTTP error is read as it always is: the provider's words, whole, with its status, type, parameter and code", async () => {
  const body = { error: { message: "Unsupported value: 'reasoning.effort' does not support 'xhigh' with this model. Supported values are: 'low', 'medium' and 'high'.", type: "invalid_request_error", param: "reasoning.effort", code: "unsupported_value" } };
  const run = await call(new Response(JSON.stringify(body), { status: 400, headers: { "content-type": "application/json" } }), { config: configOf({}, {}, { taskRouting: { autopilot: { primary: { integrationId: "az", model: "gpt-5.2", thinking: "xhigh" }, fallbacks: [] } } }) });
  assert.ok(run.error instanceof AiProviderError);
  assert.equal(run.error.status, 400);
  assert.deepEqual(run.error.body, { status: 400, shape: "openai", message: body.error.message, type: "invalid_request_error", param: "reasoning.effort", code: "unsupported_value" });
  assert.match(run.error.message, /the model does not accept a thinking level/);
  assert.match(run.error.message, /Set "Thinking parameter" of the model "gpt-5\.2" in AI Integrations to "none" \(no level is sent\), or set thinking to "Automatic"/, "the Responses API has one field for the level: there is no other to offer");
  assert.ok(!/chat_template_kwargs/.test(run.error.message));
  assert.equal(run.calls.length, 1, "asked once");
});

test("a refusal of function tools with a thinking level is not asked again without one: that rule is Chat Completions' and the Responses API takes both", async () => {
  const body = { error: { message: "Function tools with reasoning_effort are not supported for gpt-6-luna in /v1/chat/completions. To use function tools, use /v1/responses or set reasoning_effort to 'none'.", type: "invalid_request_error", param: "reasoning_effort", code: null } };
  const run = await call(new Response(JSON.stringify(body), { status: 400, headers: { "content-type": "application/json" } }), { request: JSON_ASK, config: configOf({}, {}, { taskRouting: { autopilot: { primary: { integrationId: "az", model: "gpt-5.2", thinking: "high" }, fallbacks: [] } } }) });
  assert.ok(run.error instanceof AiProviderError);
  assert.equal(run.calls.length, 1, "no second request");
  assert.equal(run.ends.length, 1);
  assert.match(run.error.message, /Function tools with reasoning_effort are not supported/, "the provider's words are what the author reads");
});

// ─── The deadlines and the author's cancel are the same ────────────────────

test("a stream that goes silent is ended by the idle deadline, with what had arrived kept", async () => {
  const stream = live();
  const config = configOf({ idleTimeoutMs: 60 });
  const answered = call(async () => eventStream(stream.body), { config, options: { minimumTimeoutMs: 1 } });
  stream.send(...textStream(["Some words"]).slice(0, 7));
  await settle();
  const run = await answered;
  assert.ok(run.error instanceof AiProviderError, String(run.error));
  assert.equal(run.error.timedOut, true);
  assert.deepEqual(run.error.timeout, { phase: "idle", ms: 60 });
  assert.equal(run.error.partialText, "Some words");
  assert.equal(run.ends[0].timeoutPhase, "idle");
  assert.equal(stream.state.cancels, 1, "the body was released");
});

test("the author's cancel ends the call at once, the body is released and nothing else is asked", async () => {
  const stream = live();
  const controller = new AbortController();
  const fake = recording(async (_entry) => eventStream(stream.body));
  const ai = createFetchAi(configOf(), { fetch: fake.fetch, minimumTimeoutMs: 1 });
  const pending = track(ai.complete({ ...ASK, signal: controller.signal }));
  stream.send(...textStream(["Hello"]).slice(0, 6));
  await settle();
  assert.equal(pending.done, false);
  controller.abort(new DOMException("Cancelled.", "AbortError"));
  failWith(stream, controller.signal);
  await settle();
  assert.equal(pending.done, true);
  assert.equal(pending.error?.name, "AbortError");
  assert.equal(fake.calls.length, 1);
  assert.equal(stream.state.cancels >= 1, true);
});

// ─── A reply that is not streamed ───────────────────────────────────────────

test("a model that does not stream is answered with a JSON body: its text, its function call, its tokens and how it ended are read from it", async () => {
  const unstreamed = { streamMode: "off" };
  const body = response({ status: "completed", output: [REASONING, messageItem("Whole reply.")], usage: USAGE });
  const text = await call(jsonStream(JSON.stringify(body)), { config: configOf(unstreamed) });
  assert.equal(text.error, undefined, text.error?.message);
  assert.equal(text.response.text, "Whole reply.");
  assert.deepEqual(text.texts, ["Whole reply."], "a reply that comes whole still reaches the listener, once");
  assert.deepEqual(text.response.usage, { inputTokens: 27, outputTokens: 17, cachedInputTokens: 5 });
  assert.equal(text.calls[0].body.stream, undefined);
  assert.equal(text.calls[0].init.headers.accept, "application/json");
  assert.equal(text.attempts[0].stream, false);

  const args = JSON.stringify(STRUCTURED);
  const called = await call(jsonStream(JSON.stringify(response({ status: "completed", output: [REASONING, callItem(args)], usage: USAGE }))), { config: configOf(unstreamed), request: JSON_ASK });
  assert.deepEqual(called.response.json, STRUCTURED);
  assert.deepEqual(called.structured, [args]);

  const cut = await call(jsonStream(JSON.stringify(response({ status: "incomplete", incomplete_details: { reason: "max_output_tokens" }, output: [REASONING], usage: { input_tokens: 3, output_tokens: 50, output_tokens_details: { reasoning_tokens: 50 } } }))), { config: configOf(unstreamed) });
  assert.equal(cut.error.truncated, true);
  assert.equal(cut.error.reasoningOnly, true);

  const failed = await call(jsonStream(JSON.stringify(response({ status: "failed", error: { code: "server_error", message: "Boom." } }))), { config: configOf(unstreamed) });
  assert.ok(failed.error instanceof AiProviderError);
  assert.match(failed.error.message, /Boom\./);
});

test("a server that answers a streamed request with a JSON body is read as a whole, as Chat Completions is", async () => {
  const body = response({ status: "completed", output: [messageItem("As a body.")], usage: USAGE });
  const run = await call(jsonStream(JSON.stringify(body)));
  assert.equal(run.response.text, "As a body.");
  assert.equal(run.ends[0].transport.streamed, false);
});

// ─── The readers themselves ─────────────────────────────────────────────────

test("a response is told as one reply: what its status says about how it ended, its text, its calls, its reasoning and its refusal", () => {
  const read = (extra, status) => readResponse(response(extra), status);
  assert.equal(read({ status: "completed", output: [messageItem("a")] }).finishReason, "stop");
  assert.equal(read({ status: "completed", output: [callItem("{}")] }).finishReason, "tool_calls");
  assert.equal(read({ status: "incomplete", incomplete_details: { reason: "max_output_tokens" } }).finishReason, "length");
  assert.equal(read({ status: "incomplete", incomplete_details: { reason: "content_filter" } }).finishReason, "content_filter");
  assert.equal(read({ status: "incomplete", incomplete_details: { reason: "new" } }).finishReason, "incomplete");
  assert.equal(read({ status: "incomplete" }).finishReason, "incomplete");
  assert.equal(read({ status: "failed", error: { code: "x" } }).finishReason, "failed");
  assert.deepEqual(read({ status: "failed", error: { code: "x" } }).error, { code: "x" });
  assert.equal(read({ status: "cancelled" }).finishReason, "cancelled");
  assert.equal(read({ output: [messageItem("no status")] }).finishReason, "stop", "a server that says no status is read for its output");
  assert.equal(read({ status: "completed", output: [{ type: "message", content: [{ type: "refusal", refusal: "No." }] }] }).finishReason, "refusal");
  assert.equal(read({ status: "completed", output: [{ type: "message", content: [{ type: "refusal", refusal: "No." }, { type: "output_text", text: "But." }] }] }).finishReason, "stop", "a refusal beside a text is not a refusal");
  assert.equal(read({ status: "completed" }, "incomplete").finishReason, "incomplete", "the event that carried it wins over its own status");
  const reading = read({ status: "completed", output: [{ type: "reasoning", summary: [{ type: "summary_text", text: "abc" }], content: [{ type: "reasoning_text", text: "de" }] }, messageItem("one "), messageItem("two"), callItem("{\"a\":1}")], usage: USAGE });
  assert.equal(reading.text, "one two");
  assert.equal(reading.reasoningCharacters, 5);
  assert.equal(reading.reasoningTokens, 10);
  assert.deepEqual(reading.calls, [{ index: 3, name: "result", arguments: "{\"a\":1}" }]);
  assert.equal(readResponse(null).finishReason, "stop");
  assert.equal(readResponse("nope").text, "");
  assert.equal(readResponse({ output: "nope", usage: 3 }).usage, undefined);
  assert.deepEqual(responseAsChat(response({ status: "completed", output: [messageItem("hi"), callItem("{}")], usage: USAGE })).choices[0], { message: { content: "hi", tool_calls: [{ function: { name: "result", arguments: "{}" } }] }, finish_reason: "tool_calls" });
});

test("the reader tells each event as the piece of a reply it is, and says nothing for the rest", () => {
  const reader = new ResponsesStreamReader();
  const read = (value, name) => reader.read(value, name);
  assert.equal(read({ type: "response.created", response: response() }), undefined);
  assert.deepEqual(read({ type: "response.output_text.delta", output_index: 1, content_index: 0, delta: "ab" }), { choices: [{ delta: { content: "ab" } }] });
  assert.equal(read({ type: "response.output_text.delta", output_index: 1, delta: "" }), undefined);
  assert.equal(read({ type: "response.output_text.done", output_index: 1, content_index: 0, text: "ab" }), undefined, "the words that were read as deltas are not read again");
  assert.deepEqual(read({ type: "response.output_text.done", output_index: 2, content_index: 0, text: "whole" }), { choices: [{ delta: { content: "whole" } }] }, "and words that came only whole are");
  assert.deepEqual(read({ type: "response.reasoning_summary_text.delta", delta: "thinking" }), { choices: [], reasoningCharacters: 8 });
  assert.deepEqual(read({ type: "response.output_item.added", output_index: 3, item: { type: "function_call", name: "result", arguments: "" } }), { choices: [{ delta: { tool_calls: [{ index: 3, function: { name: "result" } }] } }] });
  assert.deepEqual(read({ type: "response.function_call_arguments.delta", output_index: 3, delta: "{\"a\"" }), { choices: [{ delta: { tool_calls: [{ index: 3, function: { arguments: "{\"a\"" } }] } }] });
  assert.deepEqual(read({ type: "response.function_call_arguments.done", output_index: 3, arguments: "{\"a\":1}" }), undefined, "the arguments are what the deltas said");
  assert.equal(read({ type: "response.output_item.added", output_index: 0, item: { type: "message" } }), undefined);
  assert.equal(read({ type: "response.mcp_call.in_progress" }), undefined);
  assert.equal(read(null), undefined);
  assert.equal(read("text"), undefined);
  assert.equal(reader.finished, false);
  const last = read({ type: "response.completed", response: response({ status: "completed", output: [], usage: USAGE }) });
  assert.equal(last.choices[0].finish_reason, "tool_calls", "the calls that were told are calls the reply has, even when its last event leaves them out");
  assert.equal(last.reasoningTokens, 10);
  assert.equal(reader.finished, true);
  assert.deepEqual(new ResponsesStreamReader().read({ choices: [] }, "response.output_text.delta"), undefined, "an event is read by its type, then by its name");
  const named = new ResponsesStreamReader().read({ delta: "named" }, "response.output_text.delta");
  assert.deepEqual(named, { choices: [{ delta: { content: "named" } }] });
});
