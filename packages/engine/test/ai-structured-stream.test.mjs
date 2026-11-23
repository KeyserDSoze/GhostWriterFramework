import test, { after, before } from "node:test";
import assert from "node:assert/strict";
import * as engine from "../dist/index.js";
import { startFakeLlmProxy } from "./llmproxy-fake.mjs";

// A structured reply streams its JSON: `onStructuredText` receives the arguments of the function as they grow (the same reset rule as `onText`),
// through the client, against the fake LlmProxy over a real connection. Plain text never reaches it, and nothing of it goes in the request.

const KEY = "sk-test-SECRET-0123456789";
const SCHEMA = { name: "result", description: "A result", parameters: { type: "object", properties: { ok: { type: "boolean" }, note: { type: "string" } }, required: ["ok"] } };
const ASK = { capability: "autopilot", label: "structured", system: "SYS", user: "USR", json: SCHEMA };
const FULL = '{"ok":true,"note":"Il gabbiano è già volato via — 你好 😀"}';

let fake;
before(async () => {
  fake = await startFakeLlmProxy({ gap: 40, silence: 400 });
});
after(async () => {
  await fake.close();
});

function integration(id, scenario) {
  return { id, name: id, provider: "openai", endpoint: fake.base(scenario), apiKey: KEY, chatModels: [{ id: "m", name: "muse-glimmer-30b", capabilities: ["default"] }], idleTimeoutMs: 5000, requestTimeoutMs: 5000 };
}

function clientFor(integrations, options = {}) {
  return engine.createFetchAi({ aiIntegrations: integrations }, { minimumTimeoutMs: 1, ...options });
}

/** The values a call reported as its structured text, and its outcome: the response, or the error. */
async function streamed(integrations, request = {}, options = {}) {
  const values = [];
  const texts = [];
  const attempts = [];
  const ends = [];
  const ai = clientFor(integrations, { ...options });
  const outcome = await ai.complete({
    ...ASK,
    ...request,
    onStructuredText: (value) => values.push(value),
    onText: (value) => texts.push(value),
    onAttempt: (attempt) => attempts.push(attempt),
    onAttemptEnd: (end) => ends.push(end),
  }).then((response) => ({ response }), (error) => ({ error }));
  return { ...outcome, values, texts, attempts, ends };
}

test("a structured reply streams its arguments: each value is the whole JSON so far, and no text is reported", async () => {
  const { response, values, texts } = await streamed([integration("p", "tool-call")]);
  assert.deepEqual(response.json, JSON.parse(FULL));
  assert.ok(values.length >= 2, `the JSON arrives in pieces: ${values.length} values`);
  assert.equal(values.at(-1), FULL, "the last value is the whole reply");
  for (let index = 1; index < values.length; index += 1) assert.ok(values[index].startsWith(values[index - 1]), "each value grows from the one before");
  assert.deepEqual(texts, [], "a structured reply is no prose for onText");
});

test("a structured reply that arrives in one piece is reported once, whole", async () => {
  const { response, values } = await streamed([integration("p", "tool-call-whole-first")]);
  assert.deepEqual(response.json, { ok: true, note: "x" });
  assert.deepEqual(values, ['{"ok":true,"note":"x"}']);
});

test("a stream that is cut keeps the arguments that arrived: they are reported, and the error keeps them", async () => {
  const { error, values } = await streamed([integration("p", "reset-mid-tool-call")]);
  assert.ok(error instanceof engine.AiStreamInterruptedError, error?.message);
  assert.equal(error.partialText, '{"ok":true,');
  assert.ok(values.includes('{"ok":true,'), "the arguments that arrived were reported before the failure");
  assert.equal(values.at(-1), "", "and then the failed attempt is reset to empty, as the text of a prose reply is");
});

test("a candidate that fails is a new attempt: the value starts again from empty, and the attempts say which one answered", async () => {
  const { response, values, attempts, ends } = await streamed([integration("cut", "tool-call-cut-then-ok"), integration("ok", "tool-call")]);
  assert.deepEqual(response.json, JSON.parse(FULL));
  const reset = values.indexOf("");
  assert.ok(reset > 0, "the failed candidate's text is reset with an empty value");
  assert.equal(values.at(-1), FULL);
  assert.equal(values.slice(reset + 1).every((value, index, all) => index === 0 || value.startsWith(all[index - 1])), true, "after the reset, the value grows again");
  assert.deepEqual(attempts.map((attempt) => attempt.integrationId), ["cut", "ok"]);
  assert.deepEqual(ends.map((end) => end.outcome), ["failed", "ok"]);
  assert.equal(ends[0].transport?.end, "reset", "the first attempt says how its stream ended");
});

test("the attempt hooks of a request are reports, not part of what is sent: the request is the same with and without them", async () => {
  await streamed([integration("p", "tool-call")]);
  const withHooks = fake.requests.at(-1).body;
  const bare = clientFor([integration("p", "tool-call")]);
  await bare.complete(ASK);
  const without = fake.requests.at(-1).body;
  assert.deepEqual(withHooks, without);
  assert.equal(JSON.stringify(withHooks).includes("onStructuredText"), false);
});
