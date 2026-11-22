import test, { after, before } from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import * as engine from "../dist/index.js";
import { KEY, OWNER_IDS, OWNER_MODELS, gateway, integration, json, llmProxy, ownerGateway } from "./catalog-fakes.mjs";
import { jsonStream, live, settle, sleep, track, trackTimers } from "./transport-fakes.mjs";

// New exports are read from the namespace so that, before they exist, each test fails on its own.
const { AiCatalogError, probeEndpoint } = engine;

const failure = (promise) => promise.then(() => null, (error) => error);

// ─── An endpoint that answers ───────────────────────────────────────────────

test("an endpoint that answers 200 with its models is `ok`: the status, how long it took, how many models, and that nothing blocked the request", async (t) => {
  t.mock.timers.enable({ apis: ["Date"] });
  const gw = gateway({ "/v1/models": () => (t.mock.timers.tick(120), OWNER_MODELS) });
  const result = await probeEndpoint(llmProxy(), { fetch: gw.fetch });
  assert.deepEqual({ ...result, message: undefined }, { outcome: "ok", httpStatus: 200, latencyMs: 120, models: OWNER_IDS.length, cors: "ok", message: undefined });
  assert.match(result.message, /"LlmProxy" answered in 120 ms \(HTTP 200\) and lists 6 models\./);
  assert.equal(gw.calls.length, 1, "one short request to the list, and nothing else");
  const [call] = gw.calls;
  assert.equal(call.url, "http://llm.test/v1/models");
  assert.equal(call.init.method, "GET");
  assert.equal(call.init.credentials, "omit");
  assert.equal(call.init.redirect, "error");
  assert.equal(call.init.cache, "no-store");
  assert.equal(call.init.referrerPolicy, "no-referrer");
  assert.deepEqual(Object.keys(call.init.headers).sort(), ["accept", "authorization"]);
  assert.equal(call.init.headers.authorization, `Bearer ${KEY}`, "the key is what tells a gateway that refuses it from one that is off");
  const one = await probeEndpoint(llmProxy(), { fetch: gateway({ "/v1/models": { data: [{ id: "a" }] } }).fetch });
  assert.match(one.message, /lists 1 model\./);
});

test("an endpoint that needs no key is asked without one", async () => {
  const gw = ownerGateway();
  await probeEndpoint(llmProxy({ apiKey: "" }), { fetch: gw.fetch });
  assert.deepEqual(Object.keys(gw.calls[0].init.headers), ["accept"]);
});

test("a 200 that is not a list of models is still an answer: `ok`, with no count, and the advice that the address may not be the API", async () => {
  const bodies = [
    () => new Response("<html>Welcome</html>", { status: 200, headers: { "content-type": "text/html" } }),
    () => json({ hello: "world" }),
    () => json({ data: [{ id: "bad id with a \u0000 control" }] }),
    () => new Response("{invalid", { status: 200, headers: { "content-type": "application/json" } }),
    () => new Response(null, { status: 200 }),
  ];
  for (const body of bodies) {
    const result = await probeEndpoint(llmProxy(), { fetch: gateway({ "/v1/models": body }).fetch });
    assert.equal(result.outcome, "ok");
    assert.equal(result.httpStatus, 200);
    assert.equal(result.cors, "ok");
    assert.equal("models" in result, false);
    assert.match(result.message, /\(HTTP 200\), but not with a list of models/);
    assert.match(result.message, /\/v1/);
  }
});

test("a gateway with nothing running answers with an empty list: `ok`, with no model, and the advice to start one", async () => {
  const result = await probeEndpoint(llmProxy(), { fetch: gateway({ "/v1/models": { object: "list", data: [] } }).fetch });
  assert.equal(result.outcome, "ok");
  assert.equal(result.httpStatus, 200);
  assert.equal(result.models, 0);
  assert.match(result.message, /\(HTTP 200\) but lists no models/);
  assert.match(result.message, /start a model/);
});

test("an endpoint that answers with an error is reachable: `http-error` with its status, and a message that says what the status means and what to do", async () => {
  const table = [
    [401, /is reachable but refused the API key \(HTTP 401\)/, /Check the key/],
    [403, /is reachable but denied access \(HTTP 403\)/, /key/],
    [404, /is reachable but has no list of models at its address \(HTTP 404\)/, /\/v1/],
    [429, /is reachable but is limiting requests \(HTTP 429\)/, /again/],
    [500, /is reachable but failing \(HTTP 500\)/, /busy or restarting/],
    [503, /is reachable but failing \(HTTP 503\)/, /busy or restarting/],
    [400, /is reachable but answered HTTP 400/, /address/],
    [418, /is reachable but answered HTTP 418/, /address/],
  ];
  for (const [status, said, remedy] of table) {
    const body = live();
    body.send(JSON.stringify({ error: { message: `Incorrect API key provided: ${KEY}. LEAKED-WORDS` } }));
    const gw = gateway({ "/v1/models": () => new Response(body.body, { status, headers: { "content-type": "application/json" } }) });
    const result = await probeEndpoint(llmProxy(), { fetch: gw.fetch });
    assert.equal(result.outcome, "http-error", String(status));
    assert.equal(result.httpStatus, status);
    assert.equal(result.cors, "ok", "the answer got through: nothing blocks the request");
    assert.equal("models" in result, false);
    assert.equal(typeof result.latencyMs, "number");
    assert.match(result.message, said, String(status));
    assert.match(result.message, remedy, String(status));
    for (const poison of [KEY, "LEAKED-WORDS", "Incorrect API key"]) assert.equal(result.message.includes(poison), false, `${status}: ${poison}`);
    assert.equal(body.state.cancels, 1, "the body of an error is let go, not read");
  }
});

// ─── An endpoint that does not ──────────────────────────────────────────────

test("an endpoint that cannot be reached is `unreachable`, and the message says what a browser cannot: a blocked request looks exactly like a server that is off", async () => {
  const errors = [
    new TypeError("fetch failed"),
    Object.assign(new TypeError(`fetch failed: connect ECONNREFUSED http://user:${KEY}@llm.test/v1/models`), { cause: new Error(`Bearer ${KEY}`) }),
    new DOMException("NetworkError when attempting to fetch resource.", "NetworkError"),
    new Error("redirect mode is set to error"),
    "a string",
    undefined,
  ];
  for (const thrown of errors) {
    const gw = gateway({ "/v1/models": () => { throw thrown; } });
    const result = await probeEndpoint(llmProxy(), { fetch: gw.fetch });
    assert.equal(result.outcome, "unreachable", String(thrown));
    assert.equal(result.cors, "blocked-or-unreachable");
    assert.equal("httpStatus" in result, false);
    assert.equal("models" in result, false);
    assert.equal(typeof result.latencyMs, "number");
    assert.match(result.message, /Could not reach "LlmProxy": the connection failed\./);
    assert.match(result.message, /CORS/);
    assert.match(result.message, /looks exactly like a server that is off/);
    assert.match(result.message, /address is right/);
    assert.match(result.message, /redirect/i);
    for (const poison of [KEY, "ECONNREFUSED"]) assert.equal(result.message.includes(poison), false, poison);
  }
});

test("an endpoint that says nothing for 4 s is `unreachable` too, after the time the probe is given, and the time it took is said", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout", "Date"] });
  assert.equal(engine.PROBE_TIMEOUT_MS, 4000);
  const gw = gateway({ "/v1/models": () => new Promise(() => undefined) });
  const pending = track(probeEndpoint(llmProxy(), { fetch: gw.fetch }));
  await settle();
  t.mock.timers.tick(3_999);
  await settle();
  assert.equal(pending.done, false);
  t.mock.timers.tick(1);
  await settle();
  assert.equal(pending.error, undefined, pending.error?.message);
  assert.equal(pending.value.outcome, "unreachable");
  assert.equal(pending.value.latencyMs, 4000);
  assert.equal(pending.value.cors, "blocked-or-unreachable");
  assert.match(pending.value.message, /"LlmProxy" did not answer within 4 s/);
  assert.match(pending.value.message, /CORS/);
});

test("the time of the probe is the host's to choose", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout", "Date"] });
  const gw = gateway({ "/v1/models": () => new Promise(() => undefined) });
  const pending = track(probeEndpoint(llmProxy(), { fetch: gw.fetch, timeoutMs: 1500 }));
  await settle();
  t.mock.timers.tick(1_500);
  await settle();
  assert.equal(pending.value?.outcome, "unreachable");
  assert.match(pending.value.message, /within 1\.5 s/);
});

test("a body that never ends does not hold the probe: the answer is what the status says, the count is left out, and the body is let go", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout", "Date"] });
  const stream = live();
  stream.send("{\"data\":[{\"id\":\"a\"},");
  const gw = gateway({ "/v1/models": () => jsonStream(stream.body) });
  const pending = track(probeEndpoint(llmProxy(), { fetch: gw.fetch }));
  await settle();
  t.mock.timers.tick(4_000);
  await settle();
  assert.equal(pending.error, undefined, pending.error?.message);
  assert.equal(pending.done, true);
  assert.equal(pending.value.outcome, "ok");
  assert.equal(pending.value.httpStatus, 200);
  assert.equal("models" in pending.value, false);
  assert.equal(stream.state.cancels, 1);
  assert.match(pending.value.message, /\(HTTP 200\)/);
});

test("a body over 256 KB is not read to count its models: the endpoint answered, and that is what is said", async () => {
  const stream = live();
  const big = new Response(stream.body, { status: 200, headers: { "content-type": "application/json", "content-length": "300000" } });
  const result = await probeEndpoint(llmProxy(), { fetch: gateway({ "/v1/models": () => big }).fetch });
  assert.equal(result.outcome, "ok");
  assert.equal("models" in result, false);
  assert.equal(stream.state.cancels, 1);
  const lying = live();
  const pending = track(probeEndpoint(llmProxy(), { fetch: gateway({ "/v1/models": () => new Response(lying.body, { status: 200, headers: { "content-type": "application/json", "content-length": "1" } }) }).fetch }));
  await settle();
  lying.send(new Uint8Array(200_000));
  lying.send(new Uint8Array(100_000));
  await settle();
  assert.equal(pending.error, undefined);
  assert.equal(pending.value.outcome, "ok");
  assert.equal("models" in pending.value, false);
  assert.equal(lying.state.cancels, 1, "the reader was let go as soon as the limit was passed");
});

test("the time a host asks for is bounded: a timer that cannot count that far would fire at once", async () => {
  const delays = [];
  const realSet = globalThis.setTimeout;
  globalThis.setTimeout = (callback, delay, ...rest) => (delays.push(delay), realSet(callback, delay, ...rest));
  try {
    for (const timeoutMs of [1e12, Number.MAX_SAFE_INTEGER, Number.POSITIVE_INFINITY, 2 ** 31]) {
      const result = await probeEndpoint(llmProxy(), { fetch: ownerGateway().fetch, timeoutMs });
      assert.equal(result.outcome, "ok", String(timeoutMs));
    }
  } finally {
    globalThis.setTimeout = realSet;
  }
  assert.ok(delays.length > 0);
  for (const delay of delays) assert.ok(delay <= 2_147_483_647, `a timer of ${delay} ms`);
});

// ─── What it never does ─────────────────────────────────────────────────────

test("a probe that was cancelled is an AbortError, never a result, and one that was cancelled before it began sends nothing", async () => {
  const early = new AbortController();
  early.abort();
  const none = ownerGateway();
  assert.equal((await failure(probeEndpoint(llmProxy(), { fetch: none.fetch, signal: early.signal })))?.name, "AbortError");
  assert.equal(none.calls.length, 0);

  const controller = new AbortController();
  const hung = gateway({ "/v1/models": (call) => new Promise((_resolve, reject) => call.init.signal.addEventListener("abort", () => reject(call.init.signal.reason), { once: true })) });
  const pending = track(probeEndpoint(llmProxy(), { fetch: hung.fetch, signal: controller.signal }));
  await settle();
  controller.abort();
  await settle();
  assert.equal(pending.error?.name, "AbortError");

  const reading = new AbortController();
  const stream = live();
  stream.send("{\"data\":[");
  const slow = gateway({ "/v1/models": (call) => (call.init.signal.addEventListener("abort", () => stream.fail(call.init.signal.reason), { once: true }), jsonStream(stream.body)) });
  const second = track(probeEndpoint(llmProxy(), { fetch: slow.fetch, signal: reading.signal }));
  await settle();
  reading.abort();
  await settle();
  assert.equal(second.error?.name, "AbortError");
});

test("an Azure OpenAI, a GitHub Models and a Microsoft 365 integration have no list to ask: a typed refusal, and nothing is sent", async () => {
  const gw = ownerGateway();
  for (const provider of ["azure_openai", "github_models", "m365_copilot"]) {
    const error = await failure(probeEndpoint(integration({ provider, endpoint: "https://x.example.com" }), { fetch: gw.fetch }));
    assert.ok(error instanceof AiCatalogError && error.reason === "unsupported", provider);
    assert.equal(error.message.includes(KEY), false);
  }
  assert.equal(gw.calls.length, 0);
});

test("no key is in a result, whatever the integration is named and whatever the server says", async () => {
  const named = llmProxy({ name: `My ${KEY} gateway` });
  const answers = [
    () => json({ error: { message: `key ${KEY}` } }, 401),
    () => json({ data: [{ id: `${KEY}\u0000` }] }),
    () => { throw new TypeError(KEY); },
    () => OWNER_MODELS,
    () => new Response(KEY, { status: 503 }),
  ];
  for (const answer of answers) {
    const result = await probeEndpoint(named, { fetch: gateway({ "/v1/models": answer }).fetch });
    assert.equal(JSON.stringify(result).includes(KEY), false);
    assert.equal(JSON.stringify(result).includes(encodeURIComponent(KEY)), false);
  }
});

test("no timer outlives a probe, however it ended", async () => {
  const timers = trackTimers();
  try {
    await probeEndpoint(llmProxy(), { fetch: ownerGateway().fetch });
    await probeEndpoint(llmProxy(), { fetch: gateway({ "/v1/models": json({}, 503) }).fetch });
    await probeEndpoint(llmProxy(), { fetch: gateway({ "/v1/models": () => { throw new TypeError("x"); } }).fetch });
    await probeEndpoint(llmProxy(), { fetch: gateway({ "/v1/models": () => new Promise(() => undefined) }).fetch, timeoutMs: 20 });
    await settle();
  } finally {
    timers.restore();
  }
  assert.equal(timers.pending.size, 0, `${timers.pending.size} timer(s) left`);
});

// ─── A real server, a real fetch ────────────────────────────────────────────

let server;
let port;
const behaviours = new Map();

before(async () => {
  server = http.createServer((request, response) => {
    const custom = behaviours.get(request.url);
    if (custom) {
      custom(request, response);
      return;
    }
    if (request.url === "/v1/models") {
      response.writeHead(200, { "content-type": "application/json" });
      response.end(JSON.stringify(OWNER_MODELS));
      return;
    }
    response.writeHead(404, { "content-type": "application/json" });
    response.end("{}");
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  port = server.address().port;
});

after(async () => {
  server.closeAllConnections();
  await new Promise((resolve) => server.close(resolve));
});

const local = (extra = {}) => llmProxy({ endpoint: `http://127.0.0.1:${port}/v1`, ...extra });

test("real server: a server that runs is `ok`, one that answers 404 at that address is `http-error`, and one that is off is `unreachable`", async () => {
  const ok = await probeEndpoint(local());
  assert.equal(ok.outcome, "ok");
  assert.equal(ok.models, OWNER_IDS.length);
  assert.ok(ok.latencyMs >= 0 && ok.latencyMs < 3000);
  const wrong = await probeEndpoint(local({ endpoint: `http://127.0.0.1:${port}/nothing/v1` }));
  assert.equal(wrong.outcome, "http-error");
  assert.equal(wrong.httpStatus, 404);
  const closed = http.createServer();
  await new Promise((resolve) => closed.listen(0, "127.0.0.1", resolve));
  const { port: freePort } = closed.address();
  await new Promise((resolve) => closed.close(resolve));
  const off = await probeEndpoint(llmProxy({ endpoint: `http://127.0.0.1:${freePort}/v1` }));
  assert.equal(off.outcome, "unreachable");
  assert.equal(off.cors, "blocked-or-unreachable");
});

test("real server: a server that accepts the connection and says nothing is `unreachable` after the time the probe has, and the connection is closed", async () => {
  const closed = [];
  behaviours.set("/v1/models", (request, response) => {
    closed.push(new Promise((resolve) => response.on("close", resolve)));
  });
  try {
    const startedAt = Date.now();
    const result = await probeEndpoint(local(), { timeoutMs: 250 });
    assert.equal(result.outcome, "unreachable");
    assert.ok(Date.now() - startedAt >= 200 && Date.now() - startedAt < 3000);
    assert.equal(await Promise.race([closed[0].then(() => true), sleep(3000).then(() => false)]), true, "the client let the connection go");
  } finally {
    behaviours.delete("/v1/models");
  }
});
