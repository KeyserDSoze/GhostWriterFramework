import test, { after, before } from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import * as engine from "../dist/index.js";
import { KEY, OWNER_DETAILS, OWNER_MODALITIES, OWNER_MODELS, integration } from "./catalog-fakes.mjs";
import { ASK, JSON_ASK } from "./transport-fakes.mjs";

// New exports are read from the namespace so that, before they exist, each test fails on its own.
const { AiCatalogError, createFetchAi, fetchModelCatalog, modelFieldsFromCatalogEntry, pickAiRuntimeConfig, probeEndpoint } = engine;

// A local server that behaves as LlmProxy's contract says (docs/api-contract.md): the three catalog endpoints, the same API key as the rest of /v1,
// the OpenAI-style envelope for errors, and chat completions that stream as server-sent events when they are asked to.

let server;
let port;
const chats = [];

const send = (response, status, value) => {
  response.writeHead(status, { "content-type": "application/json" });
  response.end(JSON.stringify(value));
};

function chat(body, response) {
  const tool = body.tools?.[0]?.function;
  const usage = { prompt_tokens: 120, completion_tokens: 30 };
  if (!body.stream) {
    send(response, 200, tool
      ? { choices: [{ message: { tool_calls: [{ function: { name: tool.name, arguments: JSON.stringify({ ok: true }) } }] }, finish_reason: "tool_calls" }], usage }
      : { choices: [{ message: { content: "A whole scene." }, finish_reason: "stop" }], usage });
    return;
  }
  response.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-cache" });
  const frame = (value) => response.write(`data: ${JSON.stringify(value)}\n\n`);
  if (tool) {
    frame({ choices: [{ delta: { tool_calls: [{ index: 0, id: "call_1", type: "function", function: { name: tool.name, arguments: "{\"ok\":" } }] } }] });
    frame({ choices: [{ delta: { tool_calls: [{ index: 0, function: { arguments: "true}" } }] } }] });
    frame({ choices: [{ delta: {}, finish_reason: "tool_calls" }] });
  } else {
    frame({ choices: [{ delta: { content: "A stre" } }] });
    frame({ choices: [{ delta: { content: "amed scene." } }] });
    frame({ choices: [{ delta: {}, finish_reason: "stop" }] });
  }
  frame({ choices: [], usage });
  response.end("data: [DONE]\n\n");
}

before(async () => {
  server = http.createServer((request, response) => {
    const parts = [];
    request.on("data", (part) => parts.push(part));
    request.on("end", () => {
      if (request.headers.authorization !== `Bearer ${KEY}`) {
        send(response, 401, { error: { message: "Invalid API key.", type: "authentication_error", code: "invalid_api_key" } });
        return;
      }
      if (request.method === "GET" && request.url === "/v1/models") return send(response, 200, OWNER_MODELS);
      if (request.method === "GET" && request.url === "/v1/models/details") return send(response, 200, OWNER_DETAILS);
      if (request.method === "GET" && request.url === "/v1/modalities") return send(response, 200, OWNER_MODALITIES);
      if (request.method === "POST" && request.url === "/v1/chat/completions") {
        const body = JSON.parse(Buffer.concat(parts).toString("utf8"));
        chats.push({ body, headers: request.headers });
        return chat(body, response);
      }
      return send(response, 404, { error: { message: "No such route.", type: "invalid_request_error", code: "not_found" } });
    });
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  port = server.address().port;
});

after(async () => {
  server.closeAllConnections();
  await new Promise((resolve) => server.close(resolve));
});

const gateway = (extra = {}) => integration({ endpoint: `http://127.0.0.1:${port}/v1`, ...extra });
const MUSE = "muse-glimmer-30b";
const LEGACY = "legacy-8b";

/** What a screen does with a catalog: the chat models of the endpoint, each with what the gateway declares for it. */
async function modelsOf(target) {
  const catalog = await fetchModelCatalog(target);
  return catalog.models.filter((entry) => entry.type === "chat").map((entry) => ({ id: entry.id, name: entry.id, capabilities: ["default"], ...modelFieldsFromCatalogEntry(entry) }));
}

const routed = (chatModels, more = {}, target = gateway()) => pickAiRuntimeConfig({
  aiIntegrations: [{ ...target, chatModels }],
  taskRouting: { autopilot: { primary: { integrationId: target.id, model: MUSE } }, review: { primary: { integrationId: target.id, model: LEGACY } } },
  ...more,
});

test("the owner's gateway, end to end: the catalog is read from the gateway, becomes the models of the integration, and the calls that follow say what the gateway declared", async () => {
  const chatModels = await modelsOf(gateway());
  assert.deepEqual(chatModels.map((model) => model.name), [LEGACY, MUSE], "the chat models of the gateway; its embedding, image, speech and transcription models are not offered as writers");
  assert.deepEqual(chatModels.find((model) => model.name === MUSE), { id: MUSE, name: MUSE, capabilities: ["default"], maxInputTokens: 131072, maxOutputTokens: 8192, supportsToolCalls: true, supportsStreaming: true, supportsReasoning: true, supportsVision: true });
  assert.deepEqual(chatModels.find((model) => model.name === LEGACY), { id: LEGACY, name: LEGACY, capabilities: ["default"] }, "everything false and null: nothing is imported, and nothing is taken away");

  chats.length = 0;
  const ai = createFetchAi(routed(chatModels));
  const written = await ai.complete({ ...ASK, maxOutputTokens: 1000, onText: () => undefined });
  assert.equal(written.text, "A streamed scene.");
  assert.equal(chats[0].body.model, MUSE);
  assert.equal(chats[0].body.stream, true, "the model streams: the call streams");
  assert.equal(chats[0].body.max_tokens, 8192, "a reasoning model gets the margin for its reasoning, up to the largest answer the gateway declared");
  assert.equal(chats[0].headers.authorization, `Bearer ${KEY}`);

  const structured = await ai.complete({ ...JSON_ASK, maxOutputTokens: 1000 });
  assert.deepEqual(structured.json, { ok: true }, "the function that arrived in pieces is one answer");
  assert.equal(chats[1].body.stream, true);
  assert.equal(chats[1].body.tool_choice, "required");

  const other = await ai.complete({ ...JSON_ASK, capability: "review", maxOutputTokens: 1000 });
  assert.deepEqual(other.json, { ok: true });
  assert.equal(chats[2].body.model, LEGACY);
  assert.equal(chats[2].body.stream, true, "a model that the gateway does not declare as streaming goes on streaming: `false` there is what nobody declared");
  assert.equal(chats[2].body.max_tokens, 4096, "and has no margin and no ceiling of its own");
  assert.equal(chats[2].body.tool_choice, "required");
});

test("the author's own word still wins over the gateway's: a model flagged as not streaming is called without a stream, and a level of thinking that a model does not take is not sent", async () => {
  const chatModels = (await modelsOf(gateway())).map((model) => (model.name === MUSE ? { ...model, supportsStreaming: false } : { ...model, supportsReasoning: false }));
  chats.length = 0;
  const attempts = [];
  const ai = createFetchAi(routed(chatModels, {}, gateway({ thinking: "high" })), { onAttempt: (attempt) => attempts.push(attempt) });
  const first = await ai.complete({ ...ASK, maxOutputTokens: 1000 });
  assert.equal(first.text, "A whole scene.", "a reply that came whole, read whole");
  assert.equal(chats[0].body.model, MUSE);
  assert.equal("stream" in chats[0].body, false);
  assert.equal(chats[0].body.reasoning_effort, "high", "muse reasons: the level is sent");
  assert.deepEqual(attempts[0].notes, [`Streaming was not used: "${MUSE}" is declared as not streaming (supportsStreaming is off).`]);

  const second = await ai.complete({ ...ASK, capability: "review", maxOutputTokens: 1000 });
  assert.equal(second.text, "A streamed scene.", "the other model streams");
  assert.equal(chats[1].body.model, LEGACY);
  assert.equal(chats[1].body.stream, true);
  assert.equal("reasoning_effort" in chats[1].body, false, "declared as not reasoning: no level, so nothing for the provider to refuse");
  assert.deepEqual(attempts[1].notes, [`The thinking level "high" was not sent: "${LEGACY}" is declared as not reasoning (supportsReasoning is off).`]);
});

test("the probe and the catalog tell a wrong key from a server that is off, with the real fetch", async () => {
  const wrongKey = gateway({ apiKey: "sk-test-WRONG-0123456789" });
  const refused = await probeEndpoint(wrongKey);
  assert.equal(refused.outcome, "http-error");
  assert.equal(refused.httpStatus, 401);
  assert.match(refused.message, /refused the API key/);
  const error = await fetchModelCatalog(wrongKey).then(() => null, (failure) => failure);
  assert.ok(error instanceof AiCatalogError && error.reason === "unauthorized" && error.status === 401, String(error));
  assert.equal(error.message.includes("WRONG"), false, "the key that was refused is not in what is said of it");
  const fine = await probeEndpoint(gateway());
  assert.equal(fine.outcome, "ok");
  assert.equal(fine.models, 6);
});
