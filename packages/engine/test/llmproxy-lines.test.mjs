import test from "node:test";
import assert from "node:assert/strict";
import * as engine from "../dist/index.js";

// The line reader and the usage reader at the level of bytes, without a server: the chunks are given by hand, so that the cut falls exactly where a test says.

const { createFetchAi, AiStreamInterruptedError } = engine;
const encoder = new TextEncoder();
const config = (extra = {}) => ({ aiIntegrations: [{ id: "p", name: "LlmProxy", provider: "openai", endpoint: "http://llm.test/v1", apiKey: "sk-test-SECRET-0123456789", chatModels: [{ id: "m", name: "muse-glimmer-30b", capabilities: ["default"] }], ...extra }] });
const ASK = { capability: "autopilot", label: "t", system: "s", user: "u" };
const delta = (content) => ({ choices: [{ index: 0, delta: { content }, finish_reason: null }] });
const finish = { choices: [{ index: 0, delta: {}, finish_reason: "stop" }] };

/** A reply whose body is these chunks, each one read on its own (strings are encoded, byte arrays are sent as they are). */
function chunks(...pieces) {
  let at = 0;
  return new Response(new ReadableStream({
    pull(controller) {
      if (at < pieces.length) {
        const piece = pieces[at++];
        controller.enqueue(typeof piece === "string" ? encoder.encode(piece) : piece);
      } else controller.close();
    },
  }), { status: 200, headers: { "content-type": "text/event-stream" } });
}

const run = (reply, extra) => createFetchAi(config(extra), { minimumTimeoutMs: 1, fetch: async () => reply() }).complete({ ...ASK, onText: () => undefined }).then((response) => ({ response }), (error) => ({ error }));

test("a line end cut between two chunks is one end: a carriage return at the end of a chunk and the line feed at the start of the next", async () => {
  // One event whose JSON is on two `data:` lines: an end that counted twice would be an empty line between them, and the event would be lost.
  const { response, error } = await run(() => chunks('data: {"choices":[{"index":0,"delta":\r', '\ndata: {"content":"Hi"},"finish_reason":null}]}\r\n\r', "\ndata: [DONE]\r\n\r\n"));
  assert.equal(error, undefined, error?.message);
  assert.equal(response.text, "Hi");
});

test("every cut of a CRLF stream gives the same text: the chunks may fall anywhere", async () => {
  const body = [delta("Il gab"), delta("biano "), delta("è già"), finish].map((item) => `data: ${JSON.stringify(item)}\r\n\r\n`).join("") + "data: [DONE]\r\n\r\n";
  const bytes = encoder.encode(body);
  for (let cut = 1; cut < bytes.length; cut += 1) {
    const { response, error } = await run(() => chunks(bytes.subarray(0, cut), bytes.subarray(cut)));
    assert.equal(error, undefined, `cut at ${cut}: ${error?.message}`);
    assert.equal(response.text, "Il gabbiano è già", `cut at ${cut}`);
  }
});

test("a stream of bare carriage returns ends its events too, the last one without anything after it", async () => {
  const { response, error } = await run(() => chunks(`data: ${JSON.stringify(delta("Hi"))}\r\r`, `data: ${JSON.stringify(finish)}\r\rdata: [DONE]\r`));
  assert.equal(error, undefined, error?.message);
  assert.equal(response.text, "Hi");
});

test("an `event: error` is a failure, whatever its data is: an object, a message, an error object, nothing", async () => {
  const failure = async (data) => (await run(() => chunks(`data: ${JSON.stringify(delta("Half "))}\n\n`, `event: error\ndata:${data}\n\n`, "data: [DONE]\n\n"))).error;
  for (const [data, words] of [['{"message":"The model crashed","code":"internal_error"}', /The model crashed/], ['{"error":{"message":"overloaded, try again"}}', /overloaded, try again/], [" the runtime died", /the runtime died/], ["", /error event without details/]]) {
    const error = await failure(data);
    assert.ok(error instanceof AiStreamInterruptedError, `${data}: ${error?.message}`);
    assert.match(error.message, words);
    assert.equal(error.partialText, "Half ");
    assert.equal(error.transient, true);
  }
  const bare = (await run(() => chunks(`data: ${JSON.stringify(delta("Half "))}\n\n`, "event: error\n\n", "data: [DONE]\n\n"))).error;
  assert.ok(bare instanceof AiStreamInterruptedError, bare?.message);
  assert.match(bare.message, /error event without details/);
  // Before any word it is the provider failing at the start: its old rules.
  const first = (await run(() => chunks('event: error\ndata: {"message":"bad request","code":400}\n\n'))).error;
  assert.ok(!(first instanceof AiStreamInterruptedError));
  assert.equal(first.retryable, false);
});

test("the tokens are read under every name providers give them, and the cached ones under theirs", async () => {
  const counted = async (usage) => (await run(() => chunks(`data: ${JSON.stringify(delta("Hi"))}\n\n`, `data: ${JSON.stringify(finish)}\n\n`, `data: ${JSON.stringify({ choices: [], usage })}\n\n`, "data: [DONE]\n\n"))).response;
  const cases = [
    [{ prompt_tokens: 100, completion_tokens: 20, prompt_tokens_details: { cached_tokens: 60 } }, { inputTokens: 100, outputTokens: 20, cachedInputTokens: 60 }],
    [{ input_tokens: 100, output_tokens: 20, input_tokens_details: { cached_tokens: 60 } }, { inputTokens: 100, outputTokens: 20, cachedInputTokens: 60 }],
    [{ prompt_tokens: 100, completion_tokens: 20, prompt_cache_hit_tokens: 60 }, { inputTokens: 100, outputTokens: 20, cachedInputTokens: 60 }],
    [{ input_tokens: 100, output_tokens: 20, cache_read_input_tokens: 60 }, { inputTokens: 100, outputTokens: 20, cachedInputTokens: 60 }],
    [{ prompt_tokens: "100", completion_tokens: -3 }, { inputTokens: 0, outputTokens: 0, cachedInputTokens: 0 }],
  ];
  for (const [usage, expected] of cases) {
    const response = await counted(usage);
    if (expected.inputTokens === 0) {
      assert.equal(response.usageKnown, false, "values that are not counts are no count: the tokens are an estimate");
      continue;
    }
    assert.deepEqual(response.usage, expected, JSON.stringify(usage));
    assert.equal(response.usageKnown, true);
  }
});

test("a count of zero never replaces the count that was read, wherever it comes", async () => {
  const real = { prompt_tokens: 120, completion_tokens: 44 };
  const zeros = { prompt_tokens: 0, completion_tokens: 0, total_tokens: 0 };
  const { response } = await run(() => chunks(`data: ${JSON.stringify({ ...delta("Hi"), usage: real })}\n\n`, `data: ${JSON.stringify({ ...finish, usage: zeros })}\n\n`, `data: ${JSON.stringify({ choices: [], usage: zeros })}\n\n`, "data: [DONE]\n\n"));
  assert.deepEqual(response.usage, { inputTokens: 120, outputTokens: 44, cachedInputTokens: 0 });
  assert.equal(response.usageKnown, true);
});

test("a refusal of `stream_options` is a 400 or a 422 that names it or `include_usage`, and nothing else is taken for one", async () => {
  const refuse = (status, message) => {
    const bodies = [];
    const fetch = async (_url, init) => {
      const body = JSON.parse(init.body);
      bodies.push(body);
      return "stream_options" in body
        ? new Response(JSON.stringify({ error: { message } }), { status, headers: { "content-type": "application/json" } })
        : chunks(`data: ${JSON.stringify(delta("Hi"))}\n\n`, `data: ${JSON.stringify(finish)}\n\n`, "data: [DONE]\n\n");
    };
    return createFetchAi(config(), { minimumTimeoutMs: 1, fetch }).complete({ ...ASK, onText: () => undefined }).then((response) => ({ response, bodies }), (error) => ({ error, bodies }));
  };
  for (const [status, message] of [[400, "Unknown parameter: 'stream_options'."], [422, "Extra inputs are not permitted: stream_options.include_usage"], [400, "include_usage is not supported by this endpoint"]]) {
    const { response, error, bodies } = await refuse(status, message);
    assert.equal(error, undefined, `${status} ${message}: ${error?.message}`);
    assert.equal(response.text, "Hi");
    assert.equal(bodies.length, 2, message);
  }
  for (const [status, message] of [[400, "max_tokens is too large"], [401, "Incorrect API key: stream_options"], [429, "include_usage rate limit"], [500, "stream_options crashed"]]) {
    const { error, bodies } = await refuse(status, message);
    assert.ok(error, `${status} ${message}`);
    assert.equal(bodies.length, 1, `${status} ${message}: asked once`);
  }
});

test("a refusal that comes again for the request without the option is the provider's answer, not a loop: the call ends with it", async () => {
  let calls = 0;
  const fetch = async () => {
    calls += 1;
    return new Response(JSON.stringify({ error: { message: "Unrecognized request argument supplied: stream_options" } }), { status: 400, headers: { "content-type": "application/json" } });
  };
  const error = await createFetchAi(config(), { minimumTimeoutMs: 1, fetch }).complete({ ...ASK, onText: () => undefined }).then(() => null, (failure) => failure);
  assert.equal(calls, 2, "asked again once, and no more");
  assert.equal(error.status, 400);
  assert.match(error.message, /set "Streaming" of the integration "LlmProxy" to "off"/);
});

// ─── The output-limit parameter a model refuses ──────────────────────────────

const LIMIT_ASK = { ...ASK, maxOutputTokens: 900, onText: () => undefined };

/** A model that takes only `accepted` as its output limit, and refuses the other with `message`. */
function limitServer(accepted, message, status = 400) {
  const bodies = [];
  const fetch = async (_url, init) => {
    const body = JSON.parse(init.body);
    bodies.push(body);
    const refused = accepted === "max_completion_tokens" ? "max_tokens" : "max_completion_tokens";
    return refused in body
      ? new Response(JSON.stringify({ error: { message, type: "invalid_request_error", param: refused, code: "unsupported_parameter" } }), { status, headers: { "content-type": "application/json" } })
      : chunks(`data: ${JSON.stringify(delta("Hi"))}\n\n`, `data: ${JSON.stringify(finish)}\n\n`, "data: [DONE]\n\n");
  };
  return { bodies, fetch };
}

test("a model that refuses max_tokens is asked again with max_completion_tokens, and the limit is kept", async () => {
  const { bodies, fetch } = limitServer("max_completion_tokens", "Unsupported parameter: 'max_tokens' is not supported with this model. Use 'max_completion_tokens' instead.");
  const response = await createFetchAi(config(), { minimumTimeoutMs: 1, fetch }).complete(LIMIT_ASK);
  assert.equal(response.text, "Hi");
  assert.equal(bodies.length, 2);
  assert.equal(bodies[0].max_tokens, 900);
  assert.equal(bodies[1].max_tokens, undefined);
  assert.equal(bodies[1].max_completion_tokens, 900);
});

test("a model that refuses max_completion_tokens is asked again with max_tokens", async () => {
  // The name rules send max_completion_tokens to gpt-5: an older API that does not know it is the reverse case.
  const { bodies, fetch } = limitServer("max_tokens", "Unrecognized request argument supplied: max_completion_tokens");
  const gpt5 = config({ chatModels: [{ id: "m", name: "gpt-5", capabilities: ["default"] }] });
  const response = await createFetchAi(gpt5, { minimumTimeoutMs: 1, fetch }).complete(LIMIT_ASK);
  assert.equal(response.text, "Hi");
  assert.equal(bodies.length, 2);
  assert.equal(bodies[0].max_completion_tokens > 900, true, "the reasoning margin is on top of the limit");
  assert.equal(bodies[1].max_completion_tokens, undefined);
  assert.equal(bodies[1].max_tokens, bodies[0].max_completion_tokens);
});

test("what a model refused is remembered by the set the client shares, so the next call sends the right parameter at once", async () => {
  const { bodies, fetch } = limitServer("max_completion_tokens", "Unsupported parameter: 'max_tokens' is not supported with this model. Use 'max_completion_tokens' instead.");
  const usageOptionRefusals = new Set();
  const ai = createFetchAi(config(), { minimumTimeoutMs: 1, fetch, usageOptionRefusals });
  await ai.complete(LIMIT_ASK);
  await ai.complete(LIMIT_ASK);
  assert.equal(bodies.length, 3, "two requests for the first call, one for the second");
  assert.equal(bodies[2].max_completion_tokens, 900);
  assert.equal(bodies[2].max_tokens, undefined);
});

test("gpt-6 and later are sent max_completion_tokens from the start", async () => {
  for (const name of ["gpt-6", "gpt-6-luna", "gpt-7-mini"]) {
    const bodies = [];
    const fetch = async (_url, init) => {
      bodies.push(JSON.parse(init.body));
      return chunks(`data: ${JSON.stringify(delta("Hi"))}\n\n`, `data: ${JSON.stringify(finish)}\n\n`, "data: [DONE]\n\n");
    };
    await createFetchAi(config({ chatModels: [{ id: "m", name, capabilities: ["default"] }] }), { minimumTimeoutMs: 1, fetch }).complete(LIMIT_ASK);
    assert.equal("max_tokens" in bodies[0], false, name);
    assert.equal("max_completion_tokens" in bodies[0], true, name);
  }
});

test("a refusal of the output limit that the provider repeats is not a loop, and another 400 is not taken for one", async () => {
  let calls = 0;
  const always = async () => {
    calls += 1;
    return new Response(JSON.stringify({ error: { message: "Unsupported parameter: 'max_tokens' is not supported with this model. Use 'max_completion_tokens' instead." } }), { status: 400, headers: { "content-type": "application/json" } });
  };
  const error = await createFetchAi(config(), { minimumTimeoutMs: 1, fetch: always }).complete(LIMIT_ASK).then(() => null, (failure) => failure);
  assert.equal(calls, 2, "asked again once");
  assert.equal(error.status, 400);

  for (const [status, message] of [[400, "max_tokens is too large"], [401, "Unsupported parameter: 'max_tokens'"], [500, "Unsupported parameter: 'max_tokens'"]]) {
    let asked = 0;
    const refuse = async () => { asked += 1; return new Response(JSON.stringify({ error: { message } }), { status, headers: { "content-type": "application/json" } }); };
    const failure = await createFetchAi(config(), { minimumTimeoutMs: 1, fetch: refuse }).complete(LIMIT_ASK).then(() => null, (cause) => cause);
    assert.ok(failure, `${status} ${message}`);
    assert.equal(asked, 1, `${status} ${message}: asked once`);
  }
});
