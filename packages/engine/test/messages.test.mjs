// A host that has a conversation (the web app's Copilot) gives the engine its messages: roles, and content that is text or parts (text and images).
// Everything else a request does is unchanged, and a request that has no messages is built exactly as it always was.
import test from "node:test";
import assert from "node:assert/strict";
import * as engine from "../dist/index.js";
import { ASK, DONE, JSON_ASK, SCHEMA, call, configOf, content, finish, integration, reasoning, recording, sse, usage } from "./transport-fakes.mjs";

const { AiPromptTooLargeError, IMAGE_TOKEN_ESTIMATE, buildChatRequest, createFetchAi, estimateMessageTokens, likelyMessageTokens, pickAiRuntimeConfig } = engine;

const PNG = "data:image/png;base64,iVBORw0KGgo=";
const candidate = (extra = {}) => ({ integration: pickAiRuntimeConfig({ aiIntegrations: [integration()] }).aiIntegrations[0], model: "muse-glimmer-30b", ...extra });
const CONVERSATION = [
  { role: "system", content: "You are the Copilot." },
  { role: "user", content: [{ type: "text", text: "Hello" }] },
  { role: "assistant", content: "Hi, how can I help?" },
  { role: "user", content: [{ type: "text", text: "What is in this picture?" }, { type: "image", dataUrl: PNG }] },
];
const ASK_MESSAGES = { ...ASK, system: "", user: "", messages: CONVERSATION };
const ok = (text = "done") => sse([content(text), finish("stop"), usage(10, 3), DONE]);

// ─── The request that is built ──────────────────────────────────────────────

test("a request with messages sends them as they are, in their order and with their roles: system, user and assistant", () => {
  const built = buildChatRequest(candidate(), ASK_MESSAGES);
  assert.deepEqual(built.body.messages.map((message) => message.role), ["system", "user", "assistant", "user"]);
  assert.equal(built.body.messages[0].content, "You are the Copilot.");
  assert.equal(built.body.messages[2].content, "Hi, how can I help?");
});

test("the content of a message that is parts goes out in the OpenAI format: text parts as they are, an image as an image_url with its data URL", () => {
  const built = buildChatRequest(candidate(), ASK_MESSAGES);
  assert.deepEqual(built.body.messages[1].content, [{ type: "text", text: "Hello" }], "a text part is a text part, as it was when the site sent its own requests");
  assert.deepEqual(built.body.messages[3].content, [{ type: "text", text: "What is in this picture?" }, { type: "image_url", image_url: { url: PNG } }]);
});

test("when there are messages, `system` and `user` are not sent: they are only what a host that has none gives", () => {
  const built = buildChatRequest(candidate(), { ...ASK, system: "NOT SENT SYSTEM", user: "NOT SENT USER", messages: CONVERSATION });
  assert.equal(JSON.stringify(built.body).includes("NOT SENT"), false);
});

test("no messages, or an empty list of them, is the request it always was: the system prompt and the user prompt", () => {
  const plain = buildChatRequest(candidate(), ASK);
  assert.deepEqual(plain.body.messages, [{ role: "system", content: "SYS" }, { role: "user", content: "USR" }]);
  assert.deepEqual(buildChatRequest(candidate(), { ...ASK, messages: [] }).body, plain.body);
  assert.deepEqual(buildChatRequest(candidate(), { ...ASK, messages: undefined }).body, plain.body);
});

test("an attempt tells its hook the conversation it sends, with the JSON instruction of a model without tools in it", async () => {
  const seen = async (config, request) => {
    const reported = [];
    const fake = recording((entry) => (entry.body.tools ? sse([call("{\"ok\":true}", { name: "result" }), finish("tool_calls"), DONE]) : ok("{\"ok\": true}")));
    await createFetchAi(config, { fetch: fake.fetch, onAttempt: (attempt) => reported.push(attempt.messages) }).complete(request);
    return reported[0];
  };
  assert.deepEqual(await seen(configOf(), { ...ASK_MESSAGES, json: SCHEMA }), CONVERSATION, "a model with tools gets the messages as they are");
  const off = { chatModels: [{ id: "m", name: "muse-glimmer-30b", capabilities: ["default"], supportsToolCalls: false }] };
  const without = await seen(configOf(off, { toolsOnly: false }), { ...ASK_MESSAGES, json: SCHEMA });
  assert.equal(without.length, 4);
  assert.match(without[0].content, /^You are the Copilot\.\n\nReply with ONLY one JSON object/);
  assert.deepEqual(without.slice(1), CONVERSATION.slice(1), "and nothing else changes");
});

test("the JSON instruction goes into the first system message, whatever its content is, and into a system message of its own when there is none", () => {
  const parts = [{ role: "system", content: [{ type: "text", text: "Be brief." }] }, { role: "user", content: "Go" }];
  const asParts = buildChatRequest(candidate({ supportsToolCalls: false }), { ...ASK, system: "", user: "", json: SCHEMA, messages: parts });
  assert.equal(asParts.body.messages[0].content.length, 2, "the instruction is one more text part");
  assert.deepEqual(asParts.body.messages[0].content[0], { type: "text", text: "Be brief." });
  assert.match(asParts.body.messages[0].content[1].text, /^Reply with ONLY one JSON object/);

  const none = buildChatRequest(candidate({ supportsToolCalls: false }), { ...ASK, system: "", user: "", json: SCHEMA, messages: [{ role: "user", content: "Go" }] });
  assert.deepEqual(none.body.messages.map((message) => message.role), ["system", "user"]);
  assert.match(none.body.messages[0].content, /^Reply with ONLY one JSON object/);

  const later = buildChatRequest(candidate({ supportsToolCalls: false }), { ...ASK, system: "", user: "", json: SCHEMA, messages: [{ role: "user", content: "Go" }, { role: "system", content: "Late rule." }] });
  assert.equal(later.body.messages[0].content, "Go", "the first message is not touched when it is not a system message");
  assert.match(later.body.messages[1].content, /^Late rule\.\n\nReply with ONLY one JSON object/);
});

test("the messages of the request are never changed by building it", () => {
  const before = JSON.stringify(CONVERSATION);
  buildChatRequest(candidate({ supportsToolCalls: false }), { ...ASK_MESSAGES, json: SCHEMA });
  assert.equal(JSON.stringify(CONVERSATION), before);
});

// ─── What a prompt weighs ───────────────────────────────────────────────────

test("an image weighs what the site has always counted for one, 4096 tokens, whatever its data URL says; a part of text weighs its words", () => {
  assert.equal(IMAGE_TOKEN_ESTIMATE, 4_096);
  const text = "abcdefgh";
  assert.equal(likelyMessageTokens([{ content: text }]), 4 + 2);
  assert.equal(likelyMessageTokens([{ content: [{ type: "text", text }] }]), 4 + 2, "a text part weighs what the same text does");
  assert.equal(likelyMessageTokens([{ content: [{ type: "text", text }, { type: "image", dataUrl: PNG }] }]), 4 + 2 + 4_096);
  assert.equal(likelyMessageTokens([{ content: [{ type: "image", dataUrl: `data:image/png;base64,${"A".repeat(500_000)}` }] }]), 4 + 4_096, "the size of the picture does not matter");
  assert.equal(estimateMessageTokens([{ content: [{ type: "text", text }, { type: "image", dataUrl: PNG }] }]), 4 + 8 + 4_096, "the upper bound counts bytes, and an image the same");
  assert.equal(estimateMessageTokens([{ content: text }]), 4 + 8);
});

test("a window that cannot hold the images of a prompt is refused before anything is sent, and one that can is not", async () => {
  const image = { type: "image", dataUrl: PNG };
  const small = { chatModels: [{ id: "m", name: "muse-glimmer-30b", capabilities: ["default"], maxInputTokens: 8_000, maxOutputTokens: 1_000 }] };
  const ask = (images) => ({ ...ASK, system: "", user: "", messages: [{ role: "user", content: [{ type: "text", text: "Describe." }, ...Array(images).fill(image)] }] });
  const one = recording(() => ok());
  await createFetchAi(configOf(small), { fetch: one.fetch }).complete(ask(1));
  assert.equal(one.calls.length, 1, "one picture fits");

  const two = recording(() => ok());
  await assert.rejects(createFetchAi(configOf(small), { fetch: two.fetch }).complete(ask(2)), (error) => error instanceof AiPromptTooLargeError && error.estimatedTokens > 8_192);
  assert.equal(two.calls.length, 0, "two do not, and nothing was sent");
});

// ─── A whole call ───────────────────────────────────────────────────────────

test("a call with a conversation reaches the provider as the OpenAI request a vision model takes, and streams like every other", async () => {
  const fake = recording(() => ok("A cat."));
  const response = await createFetchAi(configOf(), { fetch: fake.fetch }).complete(ASK_MESSAGES);
  assert.equal(response.text, "A cat.");
  const [{ body }] = fake.calls;
  assert.equal(body.stream, true);
  assert.deepEqual(body.messages.map((message) => message.role), ["system", "user", "assistant", "user"]);
  assert.deepEqual(body.messages[3].content[1], { type: "image_url", image_url: { url: PNG } });
});

test("the hook of an attempt is given the conversation that is sent, as copies: a listener cannot change a word of what goes out", async () => {
  const fake = recording(() => ok());
  const seen = [];
  const ai = createFetchAi(configOf(), {
    fetch: fake.fetch,
    onAttempt: (attempt) => {
      seen.push(JSON.parse(JSON.stringify(attempt.messages)));
      attempt.messages[0].content = "TAMPERED";
      attempt.messages[3].content[0].text = "TAMPERED";
      attempt.messages[3].content.push({ type: "text", text: "TAMPERED" });
    },
  });
  await ai.complete(ASK_MESSAGES);
  assert.deepEqual(seen[0], CONVERSATION, "the hook is told roles and parts, the image included");
  assert.equal(JSON.stringify(fake.calls[0].body).includes("TAMPERED"), false);
  assert.equal(JSON.stringify(CONVERSATION).includes("TAMPERED"), false, "and the host's own messages are not touched either");
});

test("a request with no messages still tells its hook the two messages it has always sent", async () => {
  const fake = recording(() => ok());
  const seen = [];
  await createFetchAi(configOf(), { fetch: fake.fetch, onAttempt: (attempt) => seen.push(attempt.messages) }).complete(ASK);
  assert.deepEqual(seen[0], [{ role: "system", content: "SYS" }, { role: "user", content: "USR" }]);
});

test("a structured call with a conversation asks for the function, and a model without tools is asked for JSON in the system message", async () => {
  const withTools = recording(() => sse([call("{\"ok\":true}", { name: "result" }), finish("tool_calls"), DONE]));
  const response = await createFetchAi(configOf(), { fetch: withTools.fetch }).complete({ ...ASK_MESSAGES, json: SCHEMA });
  assert.deepEqual(response.json, { ok: true });
  assert.equal(withTools.calls[0].body.tool_choice, "required");
  assert.equal(JSON.stringify(withTools.calls[0].body.messages).includes("Reply with ONLY one JSON object"), false);

  const noTools = recording(() => ok("{\"ok\": true}"));
  const off = { chatModels: [{ id: "m", name: "muse-glimmer-30b", capabilities: ["default"], supportsToolCalls: false }] };
  const answer = await createFetchAi(configOf(off, { toolsOnly: false }), { fetch: noTools.fetch }).complete({ ...ASK_MESSAGES, json: SCHEMA });
  assert.deepEqual(answer.json, { ok: true });
  assert.equal("tools" in noTools.calls[0].body, false);
  assert.match(noTools.calls[0].body.messages[0].content, /^You are the Copilot\.\n\nReply with ONLY one JSON object/);
});

// ─── What an attempt says of how its reply ended ────────────────────────────

/** The `onAttemptEnd` events of a call, and what it ended with. */
async function ends(handler, request = ASK, config = configOf()) {
  const fake = recording(handler);
  const events = [];
  const outcome = await createFetchAi(config, { fetch: fake.fetch, onAttemptEnd: (end) => events.push(end) }).complete(request).then((value) => ({ value }), (error) => ({ error }));
  return { events, outcome };
}

test("an attempt that was read says how the provider ended it and how much of the reply and of its reasoning there was, never the words", async () => {
  const { events } = await ends(() => sse([reasoning("secret chain of thought"), content("Once"), finish("stop"), usage(10, 40), DONE]));
  assert.equal(events.length, 1);
  assert.equal(events[0].outcome, "ok");
  assert.equal(events[0].finishReason, "stop");
  assert.equal(events[0].replyCharacters, 4);
  assert.equal(events[0].reasoningCharacters, 23);
  assert.equal(JSON.stringify(events).includes("chain of thought"), false);
});

test("the reasoning of a reply that came whole counts too: the field of the message and a <think> block in its text", async () => {
  const whole = await ends(() => Response.json({ choices: [{ message: { content: "<think>hmm</think>Here it is.", reasoning_content: "long" }, finish_reason: "stop" }], usage: { prompt_tokens: 3, completion_tokens: 9 } }));
  assert.equal(whole.events[0].finishReason, "stop");
  assert.equal(whole.events[0].replyCharacters, "Here it is.".length);
  assert.equal(whole.events[0].reasoningCharacters, "long".length + "hmm".length);
});

test("an attempt the engine refuses after reading it, because it was cut or filtered, still says how it ended", async () => {
  const cut = await ends(() => sse([reasoning("secret chain of thought"), content("Once"), finish("length"), usage(10, 4000), DONE]));
  assert.equal(cut.events[0].outcome, "failed");
  assert.deepEqual([cut.events[0].finishReason, cut.events[0].replyCharacters, cut.events[0].reasoningCharacters], ["length", 4, 23]);
  assert.equal(cut.events[0].usage.outputTokens, 4000);

  const filtered = await ends(() => sse([content("I cannot"), finish("content_filter"), DONE]));
  assert.equal(filtered.events[0].outcome, "failed");
  assert.equal(filtered.events[0].finishReason, "content_filter");
  assert.equal(filtered.events[0].replyCharacters, "I cannot".length);

  const unfinished = await ends(() => Response.json({ choices: [{ message: { content: "<think>cut while reason" }, finish_reason: "length" }] }));
  assert.deepEqual([unfinished.events[0].finishReason, unfinished.events[0].replyCharacters, unfinished.events[0].reasoningCharacters], ["length", 0, "cut while reason".length]);
});

test("a structured reply counts the characters of the arguments of its function, and `{}` is none", async () => {
  const args = "{\"ok\":true}";
  const full = await ends(() => sse([call(args, { name: "result" }), finish("tool_calls"), DONE]), JSON_ASK);
  assert.equal(full.events[0].outcome, "ok");
  assert.equal(full.events[0].finishReason, "tool_calls");
  assert.equal(full.events[0].replyCharacters, args.length);
  const empty = await ends(() => sse([call("{}", { name: "result" }), finish("stop"), DONE]), JSON_ASK);
  assert.equal(empty.events[0].outcome, "failed", "the engine rejects it");
  assert.equal(empty.events[0].replyCharacters, 0);
});

test("a reply that said no reason has an empty one, and an attempt that never got a reply says nothing of it", async () => {
  const none = await ends(() => sse([content("Hi"), DONE]));
  assert.equal(none.events[0].finishReason, "");
  assert.equal(none.events[0].replyCharacters, 2);

  const refused = await ends(() => new Response(JSON.stringify({ error: { message: "busy" } }), { status: 503, headers: { "content-type": "application/json" } }));
  assert.equal(refused.events[0].outcome, "failed");
  for (const key of ["finishReason", "replyCharacters", "reasoningCharacters"]) assert.equal(key in refused.events[0], false, key);

  const lost = await ends(() => { throw new TypeError("Failed to fetch"); });
  for (const key of ["finishReason", "replyCharacters", "reasoningCharacters"]) assert.equal(key in lost.events[0], false, key);
});

test("the facts of a finished attempt are not in the way of a host that does not ask: the reply and its usage are as they were", async () => {
  const { outcome } = await ends(() => sse([content("Fine."), finish("stop"), usage(5, 2), DONE]));
  assert.equal(outcome.value.text, "Fine.");
  assert.deepEqual(outcome.value.usage, { inputTokens: 5, outputTokens: 2, cachedInputTokens: 0 });
});
