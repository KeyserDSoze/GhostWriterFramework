import test, { after, before } from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import * as engine from "../dist/index.js";

const { AiProviderError, createFetchAi, pickAiRuntimeConfig } = engine;

const COMPLETE = ["stop", "tool_calls", "function_call", "end_turn", "stop_sequence", "tool_use", "eos"];
const TRUNCATED = ["length", "max_tokens", "max_output_tokens", "model_length", "context_length_exceeded"];
const FILTERED = ["content_filter", "safety", "blocked", "recitation", "prohibited_content"];
const FAILED = ["error", "failed", "abort", "aborted", "cancelled"];

/** Crafted server-sent events are served by a real HTTP server on 127.0.0.1; each request takes the next script. */
let server;
let port = 0;
const scripts = [];
const closed = [];

before(async () => {
  server = http.createServer((request, response) => {
    request.resume();
    request.on("end", async () => {
      const script = scripts.shift() ?? { chunks: [] };
      const gone = new Promise((resolve) => response.on("close", resolve));
      closed.push(gone);
      response.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-cache" });
      for (const chunk of script.chunks) {
        if (response.destroyed) return;
        response.write(chunk);
        await new Promise((resolve) => setTimeout(resolve, 2));
      }
      if (!script.hang) response.end();
    });
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  port = server.address().port;
});

after(async () => {
  server.closeAllConnections();
  await new Promise((resolve) => server.close(resolve));
});

const data = (value) => `data: ${typeof value === "string" ? value : JSON.stringify(value)}\n\n`;
const content = (text) => data({ choices: [{ delta: { content: text } }] });
const finish = (reason) => data({ choices: [{ delta: {}, finish_reason: reason }] });
const usage = (prompt, completion) => data({ choices: [], usage: { prompt_tokens: prompt, completion_tokens: completion } });
const DONE = "data: [DONE]\n\n";

function client(integrations = 1) {
  return createFetchAi(pickAiRuntimeConfig({
    costCurrency: "EUR",
    aiIntegrations: Array.from({ length: integrations }, (_, index) => ({
      id: `i${index}`,
      name: `I${index}`,
      provider: "openai",
      endpoint: `http://127.0.0.1:${port}/v1`,
      apiKey: "",
      // A client that wrongly waits for a stream that never ends fails in seconds instead of minutes.
      requestTimeoutMs: 4000,
      chatModels: [{ id: `m${index}`, name: `m${index}`, capabilities: ["default"], pricing: { inputPerMTok: 1, outputPerMTok: 2 } }],
    })),
  }));
}

/** Serves `chunks` as the reply and returns what `complete()` produced: `value` or `error`. */
async function ask(chunks, { hang = false, ai = client() } = {}) {
  scripts.push({ chunks, hang });
  const previews = [];
  const outcome = await ai.complete({ capability: "autopilot", label: "t", system: "s", user: "u", onText: (text) => previews.push(text) })
    .then((value) => ({ value }), (error) => ({ error }));
  return { ...outcome, previews };
}

test("replies that finished for a known reason are accepted, with or without the [DONE] marker", async () => {
  for (const reason of [...COMPLETE, "STOP", " End_Turn "]) {
    for (const done of [true, false]) {
      const outcome = await ask([content("Hel"), content("lo"), finish(reason), usage(10, 2), ...(done ? [DONE] : [])]);
      assert.equal(outcome.error, undefined, `${reason} (done=${done}): ${outcome.error?.message}`);
      assert.equal(outcome.value.text, "Hello", reason);
      assert.deepEqual(outcome.value.usage, { inputTokens: 10, outputTokens: 2, cachedInputTokens: 0 });
    }
  }
  const unmarked = await ask([content("No reason at all."), DONE]);
  assert.equal(unmarked.value?.text, "No reason at all.", "no finish reason but a proper end: as before");
});

test("an unknown finish reason is trusted only when the stream also ended with [DONE]", async () => {
  const accepted = await ask([content("Whole scene."), finish("some_new_reason"), usage(5, 3), DONE]);
  assert.equal(accepted.error, undefined, accepted.error?.message);
  assert.equal(accepted.value.text, "Whole scene.");

  const rejected = await ask([content("Half a sce"), finish("some_new_reason"), usage(5, 3)]);
  assert.equal(rejected.value, undefined, "partial text is never returned as a reply");
  assert.ok(rejected.error instanceof AiProviderError);
  assert.equal(rejected.error.retryable, true);
  assert.equal(rejected.error.truncated, undefined);
  assert.match(rejected.error.message, /unexpected finish reason/i);
  assert.match(rejected.error.message, /some_new_reason/);
  assert.deepEqual(rejected.error.usage, { inputTokens: 5, outputTokens: 3, cachedInputTokens: 0 }, "the failure carries its usage");
});

test("a reply cut by any known limit is the existing truncation error", async () => {
  for (const reason of [...TRUNCATED, "MAX_TOKENS"]) {
    const outcome = await ask([content("cut"), finish(reason), usage(50, 4000), DONE]);
    assert.equal(outcome.value, undefined, reason);
    assert.ok(outcome.error instanceof AiProviderError, reason);
    assert.equal(outcome.error.truncated, true, reason);
    assert.equal(outcome.error.retryable, false, reason);
    assert.match(outcome.error.message, /cut by the output token limit\. Nothing was applied\./, reason);
    assert.equal(outcome.error.usage.outputTokens, 4000, reason);
  }
  const reasoning = await ask([data({ choices: [{ delta: { reasoning_content: "Let me think" } }] }), finish("max_tokens"), DONE]);
  assert.match(reasoning.error.message, /used its output limit while reasoning/);
  assert.equal(reasoning.error.truncated, true);
});

test("a filtered reply is a provider error that is not retried", async () => {
  for (const reason of [...FILTERED, "SAFETY"]) {
    const outcome = await ask([content("Half a sce"), finish(reason), usage(20, 5), DONE]);
    assert.equal(outcome.value, undefined, reason);
    assert.ok(outcome.error instanceof AiProviderError, reason);
    assert.equal(outcome.error.retryable, false, reason);
    assert.equal(outcome.error.truncated, undefined, reason);
    assert.match(outcome.error.message, /filtered the reply content/, reason);
    assert.deepEqual(outcome.error.usage, { inputTokens: 20, outputTokens: 5, cachedInputTokens: 0 }, reason);
  }
});

test("an explicit failure reason rejects the reply as a retryable provider error", async () => {
  for (const reason of FAILED) {
    for (const done of [true, false]) {
      const outcome = await ask([content("Half a sce"), finish(reason), ...(done ? [DONE] : [])]);
      assert.equal(outcome.value, undefined, `${reason} (done=${done})`);
      assert.ok(outcome.error instanceof AiProviderError, reason);
      assert.equal(outcome.error.retryable, true, reason);
      assert.equal(outcome.error.truncated, undefined, reason);
      assert.ok(outcome.error.message.includes(reason), `${reason}: ${outcome.error.message}`);
    }
  }
});

test("an error object in the stream rejects the reply wherever it appears, with the provider's message", async () => {
  const failure = { error: { message: "context overflow", type: "server_error" } };
  const layouts = {
    "first chunk": [data(failure), content("never"), finish("stop"), DONE],
    "after some content, then [DONE]": [content("Half a sce"), data(failure), DONE],
    "after some content, then the stream closes": [content("Half a sce"), data(failure)],
    "after the finish chunk": [content("Whole"), finish("stop"), data(failure), DONE],
    "between the usage and [DONE]": [content("Whole"), finish("stop"), usage(5, 3), data(failure), DONE],
  };
  for (const [name, chunks] of Object.entries(layouts)) {
    const outcome = await ask(chunks);
    assert.equal(outcome.value, undefined, name);
    assert.ok(outcome.error instanceof AiProviderError, name);
    assert.match(outcome.error.message, /context overflow/, name);
    assert.equal(outcome.error.retryable, true, name);
  }
});

test("a stream error is retried unless its status or code says authentication or invalid request", async () => {
  const permanent = [
    { error: { message: "Incorrect API key provided", type: "invalid_request_error", code: "invalid_api_key" } },
    { error: { message: "bad key", code: 401 } },
    { error: { message: "no access", type: "authentication_error" } },
    { error: { message: "bad body", status: 400 } },
    { error: { message: "forbidden here", status_code: 403 } },
  ];
  const transient = [
    { error: { message: "slow down", code: 429 } },
    { error: { message: "try later", status: 503 } },
    { error: { message: "boom", type: "server_error", code: null } },
    { error: { message: "hiccup" } },
    { error: "overloaded" },
  ];
  for (const failure of permanent) {
    const outcome = await ask([content("Half"), data(failure)]);
    assert.ok(outcome.error instanceof AiProviderError, JSON.stringify(failure));
    assert.equal(outcome.error.retryable, false, JSON.stringify(failure));
    assert.ok(outcome.error.message.includes(typeof failure.error === "string" ? failure.error : failure.error.message), outcome.error.message);
  }
  for (const failure of transient) {
    const outcome = await ask([content("Half"), data(failure)]);
    assert.ok(outcome.error instanceof AiProviderError, JSON.stringify(failure));
    assert.equal(outcome.error.retryable, true, JSON.stringify(failure));
    assert.ok(outcome.error.message.includes(typeof failure.error === "string" ? failure.error : failure.error.message), outcome.error.message);
  }
  const numeric = await ask([data({ error: { message: "rate limited", code: 429 } })]);
  assert.equal(numeric.error.status, 429, "a numeric status is kept on the error");
});

test("chunks that merely carry a null error, or that are not JSON, do not fail a good reply", async () => {
  const outcome = await ask([
    data({ choices: [{ delta: { content: "Hi" } }], error: null }),
    ": keep-alive comment\n\n",
    data("[PING]"),
    data({ choices: [{ delta: { content: " there" }, finish_reason: "stop" }], error: null }),
    DONE,
  ]);
  assert.equal(outcome.error, undefined, outcome.error?.message);
  assert.equal(outcome.value.text, "Hi there");
});

test("a failed reply carries what it cost, and a fallback model adds it to its own cost", async () => {
  const failed = await ask([content("Half a sce"), finish("error"), usage(1000, 10), DONE]);
  assert.ok(failed.error instanceof AiProviderError);
  assert.deepEqual(failed.error.usage, { inputTokens: 1000, outputTokens: 10, cachedInputTokens: 0 });
  assert.equal(failed.error.cost, (1000 * 1 + 10 * 2) / 1_000_000);
  assert.equal(failed.error.model, "m0");
  assert.equal(failed.error.provider, "openai");

  scripts.push({ chunks: [content("Half a sce"), finish("error"), usage(100, 5), DONE] }, { chunks: [content("Whole"), finish("stop"), usage(200, 7), DONE] });
  const response = await client(2).complete({ capability: "autopilot", label: "t", system: "s", user: "u", onText: () => undefined });
  assert.equal(response.text, "Whole");
  assert.equal(response.model, "m1");
  assert.deepEqual(response.usage, { inputTokens: 300, outputTokens: 12, cachedInputTokens: 0 });
});

test("the stream is closed when an error chunk ends it early, even if the server never finishes", async () => {
  const before = closed.length;
  const outcome = await ask([content("Half a sce"), data({ error: { message: "context overflow", type: "server_error" } })], { hang: true });
  assert.match(outcome.error.message, /context overflow/);
  const gone = closed[before];
  const winner = await Promise.race([gone.then(() => "closed"), new Promise((resolve) => setTimeout(() => resolve("still open"), 3000))]);
  assert.equal(winner, "closed", "the client released the connection");
});

test("the same finish rules apply to a reply that is not streamed, where a complete body counts as ended", async () => {
  const config = pickAiRuntimeConfig({ aiIntegrations: [{ id: "a", name: "A", provider: "openai", endpoint: "http://127.0.0.1:1/v1", apiKey: "", chatModels: [{ id: "1", name: "m", capabilities: ["default"] }] }] });
  const answer = (finishReason) => createFetchAi(config, {
    fetch: async () => Response.json({ choices: [{ message: { content: "A whole scene." }, finish_reason: finishReason }], usage: { prompt_tokens: 9, completion_tokens: 4 } }),
  }).complete({ capability: "autopilot", label: "t", system: "s", user: "u" }).then((value) => ({ value }), (error) => ({ error }));

  for (const reason of [...COMPLETE, "some_new_reason", null, "", { not: "a string" }]) {
    const outcome = await answer(reason);
    assert.equal(outcome.error, undefined, `${JSON.stringify(reason)}: ${outcome.error?.message}`);
    assert.equal(outcome.value.text, "A whole scene.");
  }
  for (const reason of TRUNCATED) {
    const outcome = await answer(reason);
    assert.equal(outcome.error?.truncated, true, reason);
    assert.equal(outcome.error.retryable, false, reason);
  }
  for (const reason of FILTERED) {
    const outcome = await answer(reason);
    assert.equal(outcome.error?.retryable, false, reason);
    assert.match(outcome.error.message, /filtered/, reason);
  }
  for (const reason of FAILED) {
    const outcome = await answer(reason);
    assert.equal(outcome.error?.retryable, true, reason);
    assert.equal(outcome.error.truncated, undefined, reason);
  }
});

test("classifyFinishReason: the closed lists, the [DONE] rule, case and spacing", () => {
  const classify = engine.classifyFinishReason;
  assert.equal(typeof classify, "function", "exported for tests");
  for (const ended of [true, false]) {
    for (const reason of COMPLETE) assert.equal(classify(reason, ended), "complete", reason);
    for (const reason of TRUNCATED) assert.equal(classify(reason, ended), "truncated", reason);
    for (const reason of FILTERED) assert.equal(classify(reason, ended), "filtered", reason);
    for (const reason of FAILED) assert.equal(classify(reason, ended), "failed", reason);
    assert.equal(classify("MAX_TOKENS", ended), "truncated");
    assert.equal(classify(" Content-Filter ", ended), "filtered");
  }
  assert.equal(classify("something_else", true), "complete");
  assert.equal(classify("something_else", false), "unexpected");
  assert.equal(classify("", true), "complete");
  assert.equal(classify("", false), "incomplete");
});
