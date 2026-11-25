import test from "node:test";
import assert from "node:assert/strict";
import * as engine from "../dist/index.js";
import { ASK, recording } from "./transport-fakes.mjs";

// Where a request went and how it was asked is in the trail of every call: the attempt that is about to be sent, the route and the target of an error, the detail the autopilot keeps of a failure and the records of a
// call. A model with an address of its own is told by the origin and the path of that address; its query (which may hold a key) is nowhere; and a model asked through the Responses API says so. The protocol and the path
// are said only when they are not what Chat Completions and an integration's own base are: what no word says is what it always was.

const { classifyAutopilotError, createFetchAi, normalizeErrorDetail } = engine;

const KEY = "k-azure-secret-123456";
const QUERY_SECRET = "SUPER-SECRET-QUERY-KEY-987654";
const OWN = `https://gw.example.com/proxy/openai/responses?api-version=2025-04-01-preview&key=${QUERY_SECRET}`;
const azure = (extra = {}) => ({ id: "az", name: "Azure GW", provider: "azure_openai", endpoint: "https://res.openai.azure.com", apiKey: KEY, ...extra });
const modelOf = (name, extra = {}) => ({ id: name, name, capabilities: ["default"], ...extra });
const configOf = (models, extra = {}) => ({
  aiIntegrations: [azure({ chatModels: models, ...extra })],
  taskRouting: { autopilot: { primary: { integrationId: "az", model: models[0].name }, fallbacks: models.slice(1).map((entry) => ({ integrationId: "az", model: entry.name })) } },
});
const refused = () => new Response(JSON.stringify({ error: { message: "The deployment does not exist." } }), { status: 404, headers: { "content-type": "application/json" } });
const responseBody = (text) => Response.json({ id: "resp_1", object: "response", status: "completed", output: [{ id: "msg_1", type: "message", status: "completed", role: "assistant", content: [{ type: "output_text", text }] }], usage: { input_tokens: 5, output_tokens: 2 } });

test("an attempt says the protocol it is made through, and the address that a model has of its own without its query; one that says neither keeps its integration's base and no protocol", async () => {
  const config = configOf([modelOf("own", { apiProtocol: "responses", endpointUrl: OWN }), modelOf("built", { apiProtocol: "responses" }), modelOf("plain")]);
  const attempts = [];
  const { fetch } = recording(() => refused());
  await createFetchAi(config, { fetch, onAttempt: (attempt) => attempts.push(attempt) }).complete(ASK).then(() => null, () => null);
  assert.deepEqual(attempts.map((attempt) => [attempt.model, attempt.protocol, attempt.endpoint, attempt.apiVersion]), [
    ["own", "responses", "https://gw.example.com/proxy/openai/responses", undefined],
    ["built", "responses", "https://res.openai.azure.com", "2025-04-01-preview"],
    ["plain", undefined, "https://res.openai.azure.com", "2024-10-21"],
  ]);
  assert.ok(!("protocol" in attempts[2]), "no protocol key for Chat Completions");
  assert.equal(JSON.stringify(attempts).includes(QUERY_SECRET), false, "the query of the address is in no report");
});

test("the trail of a failed call says the protocol and the address of every attempt, on the error's target, on its route and in the detail of the run, and nowhere a query or a key", async () => {
  const config = configOf([modelOf("own", { apiProtocol: "responses", endpointUrl: OWN }), modelOf("plain")]);
  const { fetch } = recording(() => refused());
  const error = await createFetchAi(config, { fetch }).complete(ASK).then(() => null, (failure) => failure);
  assert.ok(error);
  assert.deepEqual(error.target, { provider: "azure_openai", model: "plain", integrationId: "az", endpoint: "https://res.openai.azure.com", apiVersion: "2024-10-21" }, "the last attempt's: Chat Completions says no protocol");
  assert.deepEqual(error.route.map((step) => [step.model, step.protocol, step.endpoint, step.path, step.apiVersion]), [
    ["own", "responses", "https://gw.example.com", "/proxy/openai/responses", undefined],
    ["plain", undefined, "https://res.openai.azure.com", undefined, "2024-10-21"],
  ]);
  const firstOnly = await createFetchAi(configOf([modelOf("own", { apiProtocol: "responses", endpointUrl: OWN })]), { fetch }).complete(ASK).then(() => null, (failure) => failure);
  assert.deepEqual(firstOnly.target, { provider: "azure_openai", model: "own", integrationId: "az", endpoint: "https://gw.example.com", protocol: "responses", path: "/proxy/openai/responses" });
  const { errorDetail } = engine.autopilotErrorFields(firstOnly);
  assert.deepEqual([errorDetail.endpoint, errorDetail.path, errorDetail.protocol, errorDetail.apiVersion], ["https://gw.example.com", "/proxy/openai/responses", "responses", undefined]);
  assert.deepEqual(errorDetail.route.map((step) => [step.protocol, step.path]), [["responses", "/proxy/openai/responses"]]);
  assert.deepEqual([classifyAutopilotError(firstOnly).detail.path, classifyAutopilotError(firstOnly).detail.protocol], ["/proxy/openai/responses", "responses"]);
  for (const shown of [error.route, error.target, firstOnly.route, firstOnly.target, errorDetail, firstOnly.message]) assert.equal(JSON.stringify(shown).includes(QUERY_SECRET), false);
});

test("a candidate that is left out says its protocol and its address too: the trail of a route has every candidate told the same way", async () => {
  const config = configOf([modelOf("own", { apiProtocol: "responses", endpointUrl: OWN, supportsToolCalls: false }), modelOf("plain")]);
  const { fetch } = recording(() => refused());
  const error = await createFetchAi(config, { fetch }).complete({ ...ASK, json: { name: "result", description: "d", parameters: { type: "object", properties: {} } } }).then(() => null, (failure) => failure);
  const skipped = error.route.find((step) => step.model === "own");
  assert.equal(skipped.outcome, "left-out");
  assert.deepEqual([skipped.protocol, skipped.endpoint, skipped.path], ["responses", "https://gw.example.com", "/proxy/openai/responses"]);
});

test("a detail read from a file keeps the protocol only as `responses` and the path only as the path of an address, cleaned of anything that is a key", () => {
  assert.deepEqual(normalizeErrorDetail({ status: 404, protocol: "responses", path: "/openai/responses", endpoint: "https://gw.example.com/with/a/path?key=1" }), { status: 404, endpoint: "https://gw.example.com", path: "/openai/responses", protocol: "responses" });
  assert.equal(normalizeErrorDetail({ status: 404, protocol: "chat-completions" }).protocol, undefined, "Chat Completions is what no word says");
  assert.equal(normalizeErrorDetail({ status: 404, protocol: "Responses" }).protocol, undefined);
  for (const path of ["openai/responses", "/a?key=1", "/a#frag", "/a b", "https://x.test/a", `/${"a".repeat(300)}`, "/sk-abcdefghijklmnopqrstuvwxyz0123456789ABCDEFGH/responses", 5, null]) {
    assert.equal(normalizeErrorDetail({ status: 404, path }).path, undefined, String(path));
  }
  const step = normalizeErrorDetail({ status: 404, route: [{ position: 0, model: "m", outcome: "failed", protocol: "responses", path: "/x/responses", endpoint: "https://gw.example.com/x/responses" }] }).route[0];
  assert.deepEqual([step.protocol, step.path, step.endpoint], ["responses", "/x/responses", "https://gw.example.com"]);
});

test("the records of a call keep the protocol of each attempt, beside its model, and still no path", async () => {
  const records = new engine.MemoryAiCallStore();
  const { MemoryBookStore, createFakeAutopilotAi, seedBookFiles } = await import("../dist/testing/index.js");
  const base = createFakeAutopilotAi({ reviewVerdict: () => "approve", scenes: 1, words: 200 });
  const config = {
    aiIntegrations: [azure({ streamMode: "off", chatModels: [modelOf("gpt-5.2", { apiProtocol: "responses", endpointUrl: OWN })] })],
    taskRouting: Object.fromEntries(["autopilot", "director", "reader-evaluation", "reader-evaluation-summary", "review", "simple-tasks"].map((capability) => [capability, { primary: { integrationId: "az", model: "gpt-5.2" }, fallbacks: [] }])),
  };
  let reply = null;
  const { fetch } = recording((entry) => {
    const tool = entry.body.tools?.[0]?.name;
    if (!tool) return responseBody(reply.text);
    return Response.json({ id: "resp_1", object: "response", status: "completed", output: [{ id: "fc_1", type: "function_call", status: "completed", call_id: "call_1", name: tool, arguments: JSON.stringify(reply.json) }], usage: { input_tokens: 5, output_tokens: 2 } });
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
  for (const attempt of attempts) {
    assert.equal(attempt.protocol, "responses");
    assert.equal(attempt.endpoint, "https://gw.example.com", "the origin, as ever");
    assert.equal(attempt.apiVersion, undefined, "an address of its own has no version of ours");
  }
  assert.equal(JSON.stringify(task).includes(QUERY_SECRET), false);
  assert.equal(JSON.stringify(task).includes("/proxy/openai/responses"), false, "a record never keeps a path");
});
