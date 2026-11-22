import test, { after, before } from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import * as engine from "../dist/index.js";
import { ASK, COMMENT, DONE, JSON_ASK, SCHEMA, call, configOf, content, data, encoder, eventStream, failWith, finish, integration, live, reasoning, recording, settle, sleep, sse, track, usage } from "./transport-fakes.mjs";

const { AiProviderError, buildChatRequest, createFetchAi } = engine;

const fail = (status, message = "failed") => new Response(JSON.stringify({ error: { message } }), { status, headers: { "content-type": "application/json" } });
const toolReply = (value) => Response.json({ choices: [{ message: { tool_calls: [{ function: { name: "result", arguments: JSON.stringify(value) } }] }, finish_reason: "tool_calls" }] });
const candidate = (extra = {}) => ({ integration: integration(extra), model: "muse-glimmer-30b" });
const length = (...chunks) => chunks.reduce((total, chunk) => total + encoder.encode(chunk).byteLength, 0);

const ANSWER = { ok: true, note: "A note with “quotes”, a \\ backslash, a \n newline and an emoji 😀" };
const ARGS = JSON.stringify(ANSWER);
const PIECES = [ARGS.slice(0, 7), ARGS.slice(7, 20), ARGS.slice(20, 41), ARGS.slice(41)];
const FUNCTION_CALL = () => [call("", { name: "result" }), ...PIECES.map((piece) => call(piece))];

// ─── E1-2: the request streams, the function included ───────────────────────

test("a structured request streams like any other: the forced function and the stream travel together", () => {
  const built = buildChatRequest(candidate(), { system: "SYS", user: "USR", json: SCHEMA });
  assert.equal(built.stream, true);
  assert.equal(built.useTools, true, "the function is still forced");
  assert.equal(built.body.stream, true);
  assert.deepEqual(built.body.stream_options, { include_usage: true });
  assert.deepEqual(built.body.tools, [{ type: "function", function: SCHEMA }]);
  assert.equal(built.body.tool_choice, "required");
  assert.equal(built.headers.accept, "text/event-stream");
});

test("the JSON asked in the prompt streams too, and a plain request needs no listener to stream", () => {
  const noTools = buildChatRequest({ ...candidate(), supportsToolCalls: false }, { system: "SYS", user: "USR", json: SCHEMA });
  assert.equal(noTools.useTools, false);
  assert.equal(noTools.stream, true);
  assert.equal(noTools.body.stream, true);
  assert.equal("tools" in noTools.body, false);
  const plain = buildChatRequest(candidate(), { system: "SYS", user: "USR" });
  assert.equal(plain.stream, true, "every chat request streams in auto mode");
  assert.deepEqual(plain.body.stream_options, { include_usage: true });
  assert.equal(plain.headers.accept, "text/event-stream");
});

test("streamMode off never streams, not even for a request with a listener for the text", () => {
  for (const request of [{ system: "SYS", user: "USR" }, { system: "SYS", user: "USR", onText: () => undefined }, { system: "SYS", user: "USR", json: SCHEMA }, { system: "SYS", user: "USR", json: SCHEMA, onText: () => undefined }]) {
    const built = buildChatRequest(candidate({ streamMode: "off" }), request);
    assert.equal(built.stream, false);
    assert.equal("stream" in built.body, false);
    assert.equal("stream_options" in built.body, false);
    assert.equal(built.headers.accept, "application/json");
    assert.equal(built.useTools, Boolean(request.json));
  }
});

test("only off turns streaming off: auto, nothing and anything else stream", () => {
  for (const streamMode of ["auto", undefined, "sse", "", null, 7]) assert.equal(buildChatRequest(candidate({ streamMode }), { system: "SYS", user: "USR", json: SCHEMA }).stream, true, String(streamMode));
});

test("the reply to a structured request arrives in pieces: the arguments of the function are joined and become the reply", async () => {
  const { fetch, calls } = recording(() => sse([...FUNCTION_CALL(), finish("tool_calls"), usage(120, 45), DONE]));
  const texts = [];
  const response = await createFetchAi(configOf(), { fetch }).complete({ ...JSON_ASK, onText: (text) => texts.push(text) });
  assert.deepEqual(response.json, ANSWER);
  assert.equal(response.text, ARGS);
  assert.deepEqual(response.usage, { inputTokens: 120, outputTokens: 45, cachedInputTokens: 0 });
  assert.equal(response.usageKnown, true);
  assert.equal(calls[0].body.stream, true);
  assert.deepEqual(calls[0].body.stream_options, { include_usage: true });
  assert.equal(calls[0].init.headers.accept, "text/event-stream");
  assert.deepEqual(texts, [], "onText is for prose: the arguments of a function never go to it");
});

test("a provider that leaves out the index of the call, or repeats the name in every piece, is understood", async () => {
  const withoutIndex = [call("", { name: "result", index: undefined }), ...PIECES.map((piece) => call(piece, { index: undefined })), finish("tool_calls"), DONE];
  assert.deepEqual((await createFetchAi(configOf(), { fetch: async () => sse(withoutIndex) }).complete(JSON_ASK)).json, ANSWER);
  const repeated = [...PIECES.map((piece) => call(piece, { name: "result" })), finish("tool_calls"), DONE];
  assert.deepEqual((await createFetchAi(configOf(), { fetch: async () => sse(repeated) }).complete(JSON_ASK)).json, ANSWER);
});

test("a provider whose last piece carries the whole message with its function calls is understood, with or without pieces before it", async () => {
  const message = (args) => data({ choices: [{ index: 0, message: { role: "assistant", content: null, tool_calls: [{ id: "call_1", type: "function", function: { name: "result", arguments: args } }] }, finish_reason: "tool_calls" }] });
  const only = await createFetchAi(configOf(), { fetch: async () => sse([message(ARGS), usage(10, 5), DONE]) }).complete(JSON_ASK);
  assert.deepEqual(only.json, ANSWER);
  assert.deepEqual(only.usage, { inputTokens: 10, outputTokens: 5, cachedInputTokens: 0 });
  const after = await createFetchAi(configOf(), { fetch: async () => sse([...FUNCTION_CALL(), message(ARGS), DONE]) }).complete(JSON_ASK);
  assert.deepEqual(after.json, ANSWER, "pieces and then the whole message: the same arguments, once");
  const closedWithoutDone = await createFetchAi(configOf(), { fetch: async () => sse([message(ARGS)]) }).complete(JSON_ASK);
  assert.deepEqual(closedWithoutDone.json, ANSWER, "its finish reason makes it complete");
});

test("when several calls are streamed the first is taken and the others are ignored, unless another one is the function that was asked for", async () => {
  const interleaved = [call("{\"ok\":", { name: "result", index: 0 }), call("{\"other\":1}", { name: "other", index: 1 }), call("true}", { index: 0 }), finish("tool_calls"), DONE];
  assert.deepEqual((await createFetchAi(configOf(), { fetch: async () => sse(interleaved) }).complete(JSON_ASK)).json, { ok: true }, "the arguments of two calls are never glued together");

  const requested = [call("{\"zzz\":1}", { name: "other_function", index: 0 }), call("{\"ok\":false}", { name: "result", index: 1 }), finish("tool_calls"), DONE];
  assert.deepEqual((await createFetchAi(configOf(), { fetch: async () => sse(requested) }).complete(JSON_ASK)).json, { ok: false }, "the call of the requested function");

  const unnamed = [call("{\"ok\":true}", { name: "fn_a", index: 0 }), call("{\"ok\":false}", { name: "fn_b", index: 1 }), finish("tool_calls"), DONE];
  assert.deepEqual((await createFetchAi(configOf(), { fetch: async () => sse(unnamed) }).complete(JSON_ASK)).json, { ok: true }, "no call has the requested name: the first");

  const firstIsEmpty = [call("", { name: "result", index: 0 }), call("{\"ok\":true}", { name: "result", index: 1 }), finish("tool_calls"), DONE];
  assert.deepEqual((await createFetchAi(configOf(), { fetch: async () => sse(firstIsEmpty) }).complete(JSON_ASK)).json, { ok: true }, "an empty call carries no answer");
});

test("the reply is the same whatever the network cuts: a character or an event in two, byte by byte", async () => {
  const wire = [...FUNCTION_CALL(), finish("tool_calls"), usage(3, 2), DONE].join("");
  const bytes = encoder.encode(wire);
  for (const size of [1, 2, 3, 5, 7, 13, 64, bytes.length]) {
    const chunks = [];
    for (let at = 0; at < bytes.length; at += size) chunks.push(bytes.slice(at, at + size));
    const fetch = async () => eventStream(new ReadableStream({ start(controller) { for (const chunk of chunks) controller.enqueue(chunk); controller.close(); } }));
    const response = await createFetchAi(configOf(), { fetch }).complete(JSON_ASK);
    assert.deepEqual(response.json, ANSWER, `chunks of ${size} byte(s)`);
    assert.deepEqual(response.usage, { inputTokens: 3, outputTokens: 2, cachedInputTokens: 0 });
  }
});

test("a reply without token counts is estimated from the characters of the arguments", async () => {
  const response = await createFetchAi(configOf(), { fetch: async () => sse([...FUNCTION_CALL(), finish("tool_calls"), DONE]) }).complete(JSON_ASK);
  assert.equal(response.usageKnown, false);
  assert.equal(response.usage.outputTokens, Math.ceil(ARGS.length / 4));
  assert.ok(response.usage.inputTokens > 0);
});

test("a model that answers a structured request in its text, streamed, still gives the JSON", async () => {
  const texts = [];
  const response = await createFetchAi(configOf(), { fetch: async () => sse([content("Sure: "), content(JSON.stringify(ANSWER)), finish("stop"), DONE]) }).complete({ ...JSON_ASK, onText: (text) => texts.push(text) });
  assert.deepEqual(response.json, ANSWER);
  assert.deepEqual(texts, [], "and its text is no prose for the listener");
});

test("a JSON body in answer to a streaming structured request is read whole", async () => {
  const { fetch, calls } = recording(() => toolReply(ANSWER));
  const response = await createFetchAi(configOf(), { fetch }).complete(JSON_ASK);
  assert.equal(calls[0].body.stream, true, "the request did ask for a stream");
  assert.deepEqual(response.json, ANSWER);
});

test("streamMode off: nothing is asked to stream, the JSON body is read, and the text of a plain request reaches its listener once, whole", async () => {
  const structured = recording(() => toolReply(ANSWER));
  assert.deepEqual((await createFetchAi(configOf({ streamMode: "off" }), { fetch: structured.fetch }).complete(JSON_ASK)).json, ANSWER);
  assert.equal("stream" in structured.calls[0].body, false);
  assert.equal(structured.calls[0].init.headers.accept, "application/json");

  const texts = [];
  const prose = recording(() => Response.json({ choices: [{ message: { content: "A whole reply." }, finish_reason: "stop" }], usage: { prompt_tokens: 7, completion_tokens: 3 } }));
  const response = await createFetchAi(configOf({ streamMode: "off" }), { fetch: prose.fetch }).complete({ ...ASK, onText: (text) => texts.push(text) });
  assert.equal(response.text, "A whole reply.");
  assert.equal("stream" in prose.calls[0].body, false);
  assert.deepEqual(texts, ["A whole reply."]);
});

test("prose is unchanged: it streams, the listener gets the text so far, and the usage is the provider's", async () => {
  const { fetch, calls } = recording(() => sse([content("Hel"), content("lo "), content("there."), finish("stop"), usage(10, 3), DONE]));
  const texts = [];
  const response = await createFetchAi(configOf(), { fetch }).complete({ ...ASK, onText: (text) => texts.push(text) });
  assert.equal(response.text, "Hello there.");
  assert.deepEqual(texts, ["Hel", "Hello ", "Hello there."]);
  assert.deepEqual(response.usage, { inputTokens: 10, outputTokens: 3, cachedInputTokens: 0 });
  assert.equal(calls[0].body.stream, true);

  const silent = recording(() => sse([content("No listener."), finish("stop"), DONE]));
  assert.equal((await createFetchAi(configOf(), { fetch: silent.fetch }).complete(ASK)).text, "No listener.");
  assert.equal(silent.calls[0].body.stream, true, "a request without a listener streams too");
});

// ─── E1-3: unusual closures and the safety limits ───────────────────────────

test("a structured stream closed without [DONE] and without a finish reason is incomplete, and what it used is not lost", async () => {
  const stream = live();
  const ai = createFetchAi(configOf(), { fetch: async (_url, init) => (failWith(stream, init.signal), eventStream(stream.body)) });
  const pending = ai.complete(JSON_ASK).then(() => null, (failure) => failure);
  await settle();
  stream.send(...FUNCTION_CALL());
  await settle();
  stream.end();
  const error = await pending;
  assert.ok(error instanceof AiProviderError, String(error));
  assert.match(error.message, /stream ended before the reply was complete/);
  assert.equal(error.retryable, true);
  assert.equal(error.transient, true);
  assert.equal(error.model, "muse-glimmer-30b");
  assert.equal(error.usageKnown, false);
  assert.equal(error.usage.outputTokens, Math.ceil(ARGS.length / 4));
});

test("a structured stream is complete with [DONE] alone, or with a finish reason alone", async () => {
  const withDone = await createFetchAi(configOf(), { fetch: async () => sse([...FUNCTION_CALL(), DONE]) }).complete(JSON_ASK);
  assert.deepEqual(withDone.json, ANSWER);
  const withReason = await createFetchAi(configOf(), { fetch: async () => sse([...FUNCTION_CALL(), finish("tool_calls")]) }).complete(JSON_ASK);
  assert.deepEqual(withReason.json, ANSWER);
});

test("an error in a structured stream is the provider's error, and the stream is released", async () => {
  const stream = live();
  const ai = createFetchAi(configOf(), { fetch: async () => eventStream(stream.body) });
  const pending = ai.complete(JSON_ASK).then(() => null, (failure) => failure);
  await settle();
  stream.send(call("{\"ok\"", { name: "result" }), data({ error: { message: "context overflow", type: "server_error" } }));
  const error = await pending;
  assert.ok(error instanceof AiProviderError);
  assert.match(error.message, /context overflow/);
  assert.equal(error.retryable, true);
  assert.equal(stream.state.cancels, 1);
});

test("the stream is released when the reply ends with [DONE] but the server keeps the connection open", async () => {
  const stream = live();
  const ai = createFetchAi(configOf(), { fetch: async () => eventStream(stream.body) });
  const pending = ai.complete(JSON_ASK);
  await settle();
  stream.send(...FUNCTION_CALL(), finish("tool_calls"), DONE);
  assert.deepEqual((await pending).json, ANSWER);
  assert.equal(stream.state.cancels, 1);
});

test("a reasoning loop is stopped at 16 million characters, with what to do about it, and what it used is accounted for", async () => {
  const bytes = encoder.encode(reasoning("t".repeat(1_000_000)));
  let sent = 0;
  let cancels = 0;
  const body = new ReadableStream({
    pull(controller) {
      sent += 1;
      controller.enqueue(bytes);
      if (sent >= 40) controller.close();
    },
    cancel() {
      cancels += 1;
    },
  });
  const ai = createFetchAi(configOf({ chatModels: [{ id: "m", name: "muse-glimmer-30b", capabilities: ["default"], pricing: { inputPerMTok: 1, outputPerMTok: 2 } }] }), { fetch: async () => eventStream(body) });
  const error = await ai.complete(JSON_ASK).then(() => null, (failure) => failure);
  assert.ok(error instanceof AiProviderError, String(error));
  assert.match(error.message, /^openai muse-glimmer-30b: the model's reasoning passed the safety limit of 16 million characters/);
  assert.match(error.message, /Lower the thinking effort of the model or choose another one/);
  assert.equal(error.retryable, false, "the same loop would come back: the run must not repeat it by itself");
  assert.equal(error.truncated, undefined);
  assert.ok(sent >= 17 && sent <= 20, `${sent} chunks were read`);
  assert.equal(cancels, 1);
  assert.equal(error.usageKnown, false);
  assert.ok(error.usage.outputTokens >= 4_000_000, "the reasoning is counted");
  assert.ok(error.cost > 8, "and billed at the model's price");
});

test("a stream that never ends is stopped at 256 MB of transport, with what to do about it", async () => {
  const line = encoder.encode(`: ${"x".repeat(999_997)}\n`);
  assert.equal(line.byteLength, 1_000_000);
  let sent = 0;
  let cancels = 0;
  const body = new ReadableStream({
    pull(controller) {
      sent += 1;
      controller.enqueue(line);
      if (sent >= 400) controller.close();
    },
    cancel() {
      cancels += 1;
    },
  });
  const error = await createFetchAi(configOf(), { fetch: async () => eventStream(body) }).complete(JSON_ASK).then(() => null, (failure) => failure);
  assert.ok(error instanceof AiProviderError, String(error));
  assert.match(error.message, /^openai muse-glimmer-30b: the stream passed the safety limit of 256 MB/);
  assert.match(error.message, /Lower the thinking effort of the model or choose another one/);
  assert.equal(error.retryable, false);
  assert.ok(sent >= 257 && sent <= 260, `${sent} chunks were read`);
  assert.equal(cancels, 1);
});

test("a streamed function call that is cut by the output limit is the usual truncation, and arguments that say nothing are rejected with the fields named", async () => {
  const cut = await createFetchAi(configOf(), { fetch: async () => sse([call("", { name: "result" }), call("{\"ok\":tr"), finish("length"), usage(80, 4096), DONE]) }).complete(JSON_ASK).then(() => null, (failure) => failure);
  assert.ok(cut instanceof AiProviderError);
  assert.equal(cut.truncated, true);
  assert.equal(cut.retryable, false);
  assert.match(cut.message, /cut by the output token limit/);
  assert.equal(cut.usage.outputTokens, 4096);

  const wrong = await createFetchAi(configOf(), { fetch: async () => sse([call("", { name: "result" }), call("{\"foo\":1}"), finish("tool_calls"), usage(80, 6), DONE]) }).complete(JSON_ASK).then(() => null, (failure) => failure);
  assert.ok(wrong instanceof engine.AiReplyRejectedError);
  assert.equal(wrong.retryable, true);
  assert.match(wrong.message, /none of the expected fields/);
  assert.match(wrong.message, /"ok"/);
  assert.deepEqual(wrong.usage, { inputTokens: 80, outputTokens: 6, cachedInputTokens: 0 }, "a rejected reply still says what it cost");

  const empty = await createFetchAi(configOf(), { fetch: async () => sse([call("", { name: "result" }), call("{}"), finish("tool_calls"), DONE]) }).complete(JSON_ASK).then(() => null, (failure) => failure);
  assert.ok(empty instanceof engine.AiReplyRejectedError);
  assert.match(empty.message, /empty arguments/);
});

// ─── The messages and the remedy for a provider that cannot stream ──────────

test("a 400 that talks about streaming or functions says how to switch streaming off; any other 400 stays as it was", async () => {
  const failure = (message, extra, request = JSON_ASK) => createFetchAi(configOf(extra), { fetch: async () => fail(400, message) }).complete(request).then(() => null, (error) => error);

  const stream = await failure("Streaming is not supported with tools");
  assert.match(stream.message, /HTTP 400 — Streaming is not supported with tools/);
  assert.match(stream.message, /If this provider cannot stream its replies, set "Streaming" of the integration "LlmProxy" to "off"/);
  assert.equal(stream.retryable, false);

  const options = await failure("Unrecognized request argument supplied: stream_options");
  assert.match(options.message, /set "Streaming" of the integration "LlmProxy" to "off"/);

  const ordinary = await failure("max_tokens is too large");
  assert.doesNotMatch(ordinary.message, /Streaming/);

  const off = await failure("Streaming is not supported with tools", { streamMode: "off" });
  assert.doesNotMatch(off.message, /set "Streaming"/, "it was not asked to stream");
});

test("a connection that is lost while the provider answers is told with what to check", async () => {
  const stream = live();
  const ai = createFetchAi(configOf(), { fetch: async () => eventStream(stream.body) });
  const pending = ai.complete({ ...ASK, onText: () => undefined }).then(() => null, (failure) => failure);
  await settle();
  stream.send(content("Half a sc"));
  await settle();
  stream.fail(new TypeError("terminated"));
  const error = await pending;
  assert.ok(error instanceof AiProviderError);
  assert.match(error.message, /the connection with the provider was lost while it was answering, so the reply could not be read/);
  assert.match(error.message, /proxy or the tunnel/);
  assert.equal(error.retryable, true);
  assert.equal(error.transient, true);
  assert.equal(engine.classifyAutopilotError(error).kind, "network");
  assert.equal(error.model, "muse-glimmer-30b");
});

// ─── E1-4: progress of a reply, without the reply ───────────────────────────

test("onProgress reports how much has arrived at most every 250 ms, and never what was said", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout", "Date"] });
  const stream = live();
  const seen = [];
  const ai = createFetchAi(configOf(), { fetch: async (_url, init) => (failWith(stream, init.signal), eventStream(stream.body)) });
  const outcome = track(ai.complete({ ...JSON_ASK, onProgress: (info) => seen.push({ ...info }) }));
  await settle();

  const SECRET = "THE-TEXT-OF-THE-REPLY";
  const first = call("", { name: "result" });
  const second = call(`{"ok":true,"note":"${SECRET}`);
  const third = call(" goes on and on");
  const fourth = call(" and on\"}");
  stream.send(first, second);
  await settle();
  assert.equal(seen.length, 1, "the first piece is reported at once, the next one is within 250 ms");
  assert.deepEqual(seen[0], { bytes: length(first), events: 1, characters: 0 });

  t.mock.timers.tick(100);
  stream.send(third);
  await settle();
  assert.equal(seen.length, 1, "100 ms later: nothing yet");

  t.mock.timers.tick(150);
  stream.send(fourth);
  await settle();
  assert.equal(seen.length, 2, "250 ms after the last report");
  assert.deepEqual(seen[1], { bytes: length(first, second, third, fourth), events: 4, characters: `{"ok":true,"note":"${SECRET} goes on and on and on"}`.length });

  t.mock.timers.tick(100);
  stream.send(COMMENT);
  await settle();
  assert.equal(seen.length, 2);
  t.mock.timers.tick(200);
  stream.send(COMMENT);
  await settle();
  assert.equal(seen.length, 3, "a keep-alive comment is bytes, not an event");
  assert.deepEqual(seen[2], { bytes: length(first, second, third, fourth, COMMENT, COMMENT), events: 4, characters: seen[1].characters });

  stream.send(finish("tool_calls"), DONE);
  await settle();
  assert.equal(outcome.error, undefined, outcome.error?.message);
  for (const info of seen) assert.deepEqual(Object.keys(info).sort(), ["bytes", "characters", "events"]);
  assert.equal(JSON.stringify(seen).includes(SECRET), false, "no content in it: only numbers");
});

test("onProgress counts the characters of a plain reply too, is not called for a JSON body or when streaming is off, and a listener that throws breaks nothing", async () => {
  const seen = [];
  const prose = await createFetchAi(configOf(), { fetch: async () => sse([content("Hello "), content("world."), finish("stop"), DONE]) }).complete({ ...ASK, onProgress: (info) => { seen.push({ ...info }); throw new Error("a listener that fails"); } });
  assert.equal(prose.text, "Hello world.");
  assert.ok(seen.length >= 1);
  assert.equal(seen[0].characters, "Hello ".length);

  const silent = [];
  await createFetchAi(configOf(), { fetch: async () => toolReply(ANSWER) }).complete({ ...JSON_ASK, onProgress: (info) => silent.push(info) });
  await createFetchAi(configOf({ streamMode: "off" }), { fetch: async () => toolReply(ANSWER) }).complete({ ...JSON_ASK, onProgress: (info) => silent.push(info) });
  assert.deepEqual(silent, []);
});

// ─── A real server: real fetch, real streams, real connections ──────────────

let server;
let port = 0;
const scripts = [];
const received = [];
const closed = [];

before(async () => {
  server = http.createServer((request, response) => {
    const parts = [];
    request.on("data", (part) => parts.push(part));
    request.on("end", async () => {
      const script = scripts.shift() ?? { steps: [] };
      received.push({ headers: request.headers, body: JSON.parse(Buffer.concat(parts).toString("utf8") || "{}") });
      closed.push(new Promise((resolve) => response.on("close", resolve)));
      // A wait ends with the connection: nothing is left running when the client lets go.
      const wait = (ms) => new Promise((resolve) => {
        const timer = setTimeout(resolve, ms);
        response.once("close", () => {
          clearTimeout(timer);
          resolve();
        });
      });
      if (script.delay) await wait(script.delay);
      if (response.destroyed) return;
      response.writeHead(200, { "content-type": script.type ?? "text/event-stream", "cache-control": "no-cache" });
      for (const step of script.steps) {
        if (response.destroyed) return;
        if (typeof step === "number") await wait(step);
        else response.write(step);
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

const real = (extra = {}, options = {}) => createFetchAi({ aiIntegrations: [integration({ endpoint: `http://127.0.0.1:${port}/v1`, ...extra })] }, { minimumTimeoutMs: 1, ...options });
const released = async (index, within = 3_000) => Promise.race([closed[index].then(() => true), sleep(within).then(() => false)]);

test("real server: a structured reply streams in over a real connection", async () => {
  scripts.push({ steps: [...FUNCTION_CALL().flatMap((piece) => [piece, 3]), finish("tool_calls"), usage(50, 20), DONE] });
  const before = received.length;
  const response = await real().complete(JSON_ASK);
  assert.deepEqual(response.json, ANSWER);
  assert.deepEqual(response.usage, { inputTokens: 50, outputTokens: 20, cachedInputTokens: 0 });
  assert.equal(received[before].body.stream, true);
  assert.equal(received[before].body.tool_choice, "required");
  assert.equal(received[before].headers.accept, "text/event-stream");
});

test("real server: a server that ignores `stream` and answers a JSON body is read whole", async () => {
  scripts.push({ type: "application/json", steps: [JSON.stringify({ choices: [{ message: { tool_calls: [{ function: { name: "result", arguments: ARGS } }] }, finish_reason: "tool_calls" }] })] });
  assert.deepEqual((await real().complete(JSON_ASK)).json, ANSWER);
});

test("real server: a silence in the stream ends the call as an idle timeout, and the connection is closed", async () => {
  const index = received.length;
  scripts.push({ steps: [content("Hi"), 10_000], hang: true });
  const startedAt = Date.now();
  const error = await real({ idleTimeoutMs: 200 }).complete({ ...ASK, onText: () => undefined }).then(() => null, (failure) => failure);
  const took = Date.now() - startedAt;
  assert.deepEqual(error?.timeout, { phase: "idle", ms: 200 });
  assert.ok(took >= 150 && took < 3_000, `${took} ms`);
  assert.equal(await released(index), true, "the client let the connection go");
});

test("real server: keep-alive comments keep a slow stream alive for longer than the idle timeout", async () => {
  scripts.push({ steps: [content("Slow "), 150, COMMENT, 150, COMMENT, 150, COMMENT, 150, COMMENT, 150, COMMENT, 150, content("model."), finish("stop"), DONE] });
  const startedAt = Date.now();
  const response = await real({ idleTimeoutMs: 600 }).complete({ ...ASK, onText: () => undefined });
  assert.equal(response.text, "Slow model.");
  assert.ok(Date.now() - startedAt >= 700, "the call lasted longer than the idle timeout");
});

test("real server: a server that does not send its headers in time is a start timeout, and the connection is closed", async () => {
  const index = received.length;
  scripts.push({ delay: 5_000, steps: [] });
  const error = await real({ requestTimeoutMs: 150 }).complete(JSON_ASK).then(() => null, (failure) => failure);
  assert.deepEqual(error?.timeout, { phase: "start", ms: 150 });
  assert.equal(await released(index), true);
});

test("real server: the author cancels during the stream and the connection is closed", async () => {
  const index = received.length;
  scripts.push({ steps: [content("Hi"), 10_000], hang: true });
  const controller = new AbortController();
  const pending = real().complete({ ...ASK, onText: () => undefined, signal: controller.signal }).then(() => null, (failure) => failure);
  await sleep(100);
  controller.abort();
  const error = await pending;
  assert.equal(error.name, "AbortError");
  assert.equal(await released(index), true);
});
