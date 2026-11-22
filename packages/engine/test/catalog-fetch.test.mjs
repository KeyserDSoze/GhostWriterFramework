import test, { after, before } from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import * as engine from "../dist/index.js";
import { DETAILS_EXAMPLE, KEY, LMSTUDIO_MODELS, MODALITIES_EXAMPLE, MODELS_EXAMPLE, MUSE, OWNER_DETAILS, OWNER_IDS, OWNER_MODALITIES, OWNER_MODELS, gateway, integration, json, llmProxy, ownerGateway } from "./catalog-fakes.mjs";
import { jsonStream, live, settle, sleep, track, trackTimers } from "./transport-fakes.mjs";

// New exports are read from the namespace so that, before they exist, each test fails on its own.
const { AiCatalogError, effectiveAiBase, fetchLmStudioModels, fetchModelCatalog, parseModelDetails, parseModalities } = engine;

const failure = (promise) => promise.then(() => null, (error) => error);
const refusal = (error, reason, status) => error instanceof AiCatalogError && error.name === "AiCatalogError" && error.reason === reason && (status === undefined || error.status === status);
const unknownEntry = (id) => ({ id, type: "unknown", capabilities: {} });

// ─── What it asks, and how ──────────────────────────────────────────────────

test("it asks the list first and then, together, the two companions, each as a plain GET that carries nothing but the key and what it accepts", async () => {
  const order = [];
  let release;
  const bothAsked = new Promise((resolve) => { release = resolve; });
  const gw = gateway({
    "/v1/models": () => (order.push("list"), OWNER_MODELS),
    "/v1/models/details": async () => { order.push("details"); await bothAsked; return OWNER_DETAILS; },
    "/v1/modalities": async () => { order.push("modalities"); release(); return OWNER_MODALITIES; },
  });
  let timer;
  const deadline = new Promise((resolve) => { timer = setTimeout(() => resolve("timed out"), 3000); });
  const catalog = await Promise.race([fetchModelCatalog(llmProxy(), { fetch: gw.fetch }), deadline]);
  clearTimeout(timer);
  assert.notEqual(catalog, "timed out", "one request after the other would wait for ever for the second to be asked");
  assert.deepEqual(order, ["list", "details", "modalities"]);
  assert.deepEqual(gw.calls.map((call) => call.url), ["http://llm.test/v1/models", "http://llm.test/v1/models/details", "http://llm.test/v1/modalities"]);
  for (const call of gw.calls) {
    assert.equal(call.init.method, "GET");
    assert.equal(call.init.credentials, "omit", "no cookie");
    assert.equal(call.init.redirect, "error", "no redirect is followed");
    assert.equal(call.init.cache, "no-store");
    assert.equal(call.init.referrerPolicy, "no-referrer");
    assert.equal(call.init.body, undefined);
    assert.ok(call.init.signal instanceof AbortSignal);
    assert.deepEqual(Object.keys(call.init.headers).sort(), ["accept", "authorization"], "the key, and what is accepted: nothing else");
    assert.equal(call.init.headers.authorization, `Bearer ${KEY}`);
    assert.equal(call.init.headers.accept, "application/json");
    assert.equal(call.url.includes(KEY), false, "the key is in the header, never in the address");
  }
});

test("an endpoint that needs no key is asked without any header of authorization", async () => {
  const gw = ownerGateway();
  await fetchModelCatalog(llmProxy({ apiKey: "" }), { fetch: gw.fetch });
  for (const call of gw.calls) assert.deepEqual(Object.keys(call.init.headers), ["accept"]);
});

test("the base is the one the chat requests use: the endpoint, or OpenAI's own, trailing slashes aside", async () => {
  const cases = [
    [{ endpoint: "http://llm.test/v1" }, "http://llm.test/v1/models"],
    [{ endpoint: "http://llm.test/v1///" }, "http://llm.test/v1/models"],
    [{ endpoint: "https://gateway.example.com/openai/v1/" }, "https://gateway.example.com/openai/v1/models"],
    [{ endpoint: "http://127.0.0.1:1234" }, "http://127.0.0.1:1234/models"],
    [{ endpoint: undefined }, "https://api.openai.com/v1/models"],
  ];
  for (const [extra, expected] of cases) {
    const gw = gateway({});
    const target = integration(extra);
    await failure(fetchModelCatalog(target, { fetch: gw.fetch }));
    assert.equal(gw.calls[0].url, expected);
    assert.equal(gw.calls[0].url, `${effectiveAiBase(target)}/models`, "one rule for the chat and for the catalog");
  }
});

test("an Azure OpenAI, a GitHub Models and a Microsoft 365 integration have no list to read: a typed refusal, and nothing is sent", async () => {
  const gw = ownerGateway();
  const refused = {
    azure_openai: /deployment/i,
    github_models: /GitHub Models/i,
    m365_copilot: /Microsoft 365/i,
  };
  for (const [provider, pattern] of Object.entries(refused)) {
    const error = await failure(fetchModelCatalog(integration({ provider, endpoint: "https://x.openai.azure.com" }), { fetch: gw.fetch }));
    assert.ok(refusal(error, "unsupported"), `${provider}: ${error}`);
    assert.match(error.message, pattern, provider);
    assert.match(error.message, /by hand|catalog/i);
    assert.equal(error.message.includes(KEY), false);
  }
  assert.equal(gw.calls.length, 0, "nobody was asked");
});

// ─── What it gives ──────────────────────────────────────────────────────────

test("the owner's gateway: the three answers become one catalog, sorted, with the models of every kind and where it came from", async () => {
  const gw = ownerGateway();
  const catalog = await fetchModelCatalog(llmProxy(), { fetch: gw.fetch });
  assert.deepEqual(catalog.source, { models: true, details: true, modalities: true });
  assert.deepEqual(catalog.models.map((entry) => entry.id), [...OWNER_IDS].sort());
  const details = parseModelDetails(OWNER_DETAILS);
  const byId = new Map(catalog.models.map((entry) => [entry.id, entry]));
  for (const entry of details) assert.deepEqual(byId.get(entry.id), entry, `${entry.id} is what /models/details says`);
  assert.deepEqual(byId.get("muse-glimmer-30b"), {
    id: "muse-glimmer-30b",
    type: "chat",
    contextWindow: 131072,
    maxOutputTokens: 8192,
    inputModalities: ["text", "image"],
    outputModalities: ["text"],
    capabilities: { streaming: true, tools: true, vision: true, reasoning: true },
  });
  assert.deepEqual(catalog.models.map((entry) => entry.type).sort(), ["chat", "chat", "embedding", "image", "speech", "transcription"], "the models that are not chat come with their type, so that a table of tools can be filled");
  assert.deepEqual(catalog.modalities.map((group) => group.type), ["chat", "image", "speech", "transcription", "embedding", "realtime", "classifier"], "and what the gateway offers, with the kinds that run nothing");
  assert.deepEqual(catalog.modalities, parseModalities(OWNER_MODALITIES));
});

test("when /models/details is not there the catalog is what /models says, with what /modalities adds; when neither is, the ids alone", async () => {
  const noDetails = ownerGateway({ "/v1/models/details": json({ error: { message: "nope" } }, 404) });
  const some = await fetchModelCatalog(llmProxy(), { fetch: noDetails.fetch });
  assert.deepEqual(some.source, { models: true, details: false, modalities: true });
  assert.deepEqual(some.models.find((entry) => entry.id === "muse-glimmer-30b"), parseModelDetails({ data: [MUSE] })[0], "/modalities knows each running model as /models/details does");

  const onlyList = gateway({ "/v1/models": OWNER_MODELS });
  const bare = await fetchModelCatalog(llmProxy(), { fetch: onlyList.fetch });
  assert.deepEqual(bare.source, { models: true, details: false, modalities: false });
  assert.deepEqual(bare.models, [...OWNER_IDS].sort().map(unknownEntry), "an id that only /models lists has an unknown type and no capability said");
  assert.equal("modalities" in bare, false);
  assert.deepEqual(onlyList.calls.map((call) => call.path), ["/v1/models", "/v1/models/details", "/v1/modalities"], "both were asked");
});

test("a /modalities, or a /models/details, that is not what it should be is ignored, and the other one is still used", async () => {
  const wrong = [
    () => json({ data: "nope" }),
    () => json({ error: { message: "x" } }),
    () => json([]),
    () => new Response("{invalid", { status: 200, headers: { "content-type": "application/json" } }),
    () => new Response("<html>login</html>", { status: 200, headers: { "content-type": "text/html" } }),
    () => new Response(new Uint8Array([0xff, 0xfe, 0xfd]), { status: 200, headers: { "content-type": "application/json" } }),
    () => new Response(null, { status: 200 }),
    () => json({ data: [] }, 500),
  ];
  const muse = parseModelDetails({ data: [MUSE] })[0];
  const sorted = [...OWNER_IDS].sort();
  for (const make of wrong) {
    const brokenModalities = await fetchModelCatalog(llmProxy(), { fetch: ownerGateway({ "/v1/modalities": make }).fetch });
    assert.deepEqual(brokenModalities.source, { models: true, details: true, modalities: false });
    assert.deepEqual(brokenModalities.models.map((entry) => entry.id), sorted);
    assert.deepEqual(brokenModalities.models.find((entry) => entry.id === "muse-glimmer-30b"), muse, "the details are still there");
    assert.equal("modalities" in brokenModalities, false);

    const brokenDetails = await fetchModelCatalog(llmProxy(), { fetch: ownerGateway({ "/v1/models/details": make }).fetch });
    assert.deepEqual(brokenDetails.source, { models: true, details: false, modalities: true });
    assert.deepEqual(brokenDetails.models.find((entry) => entry.id === "muse-glimmer-30b"), muse, "and what /modalities knows is used");

    const neither = await fetchModelCatalog(llmProxy(), { fetch: ownerGateway({ "/v1/models/details": make, "/v1/modalities": make }).fetch });
    assert.deepEqual(neither.source, { models: true, details: false, modalities: false });
    assert.deepEqual(neither.models, sorted.map(unknownEntry));
  }
});

test("every way the two companions can go wrong is silent: an error status, a dead connection, a hang, a body that is too big", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout", "Date"] });
  const ways = {
    "401": () => json({ error: { message: `bad key ${KEY}` } }, 401),
    "500": () => json({ error: { message: "boom" } }, 500),
    "a dead connection": () => { throw new TypeError(`fetch failed: ${KEY}`); },
    "a body that is too big": () => new Response("x".repeat(10), { status: 200, headers: { "content-type": "application/json", "content-length": "700000" } }),
    "a stream that fails": () => { const stream = live(); stream.send("{\"data\":"); stream.fail(new Error("reset")); return jsonStream(stream.body); },
  };
  for (const [name, way] of Object.entries(ways)) {
    const gw = ownerGateway({ "/v1/models/details": way, "/v1/modalities": way });
    const catalog = await fetchModelCatalog(llmProxy(), { fetch: gw.fetch });
    assert.deepEqual(catalog.source, { models: true, details: false, modalities: false }, name);
    assert.equal(catalog.models.length, OWNER_IDS.length, name);
    assert.equal(JSON.stringify(catalog).includes(KEY), false, name);
  }
  const hanging = ownerGateway({ "/v1/models/details": () => new Promise(() => undefined), "/v1/modalities": () => new Promise(() => undefined) });
  const pending = track(fetchModelCatalog(llmProxy(), { fetch: hanging.fetch, timeoutMs: 1000 }));
  await settle();
  t.mock.timers.tick(1000);
  await settle();
  assert.equal(pending.error, undefined, pending.error?.message);
  assert.equal(pending.done, true, "a companion that never answers does not hold the catalog");
  assert.deepEqual(pending.value.source, { models: true, details: false, modalities: false });
});

test("what the companions say wins over what /modalities says, which wins over /models; an id they add is in the catalog; the catalog never passes 2000", async () => {
  const details = { data: [
    { id: "both", type: "chat", context_window: 32768, max_output_tokens: 4096, capabilities: { tools: true } },
    { id: "only-details", type: "image" },
  ] };
  const modalities = { data: [{ type: "chat", endpoints: ["/v1/chat/completions"], models: [
    { id: "both", type: "chat", context_window: 16384, max_output_tokens: 2048, input_modalities: ["text", "image"], capabilities: { streaming: true, tools: false } },
    { id: "only-modalities", capabilities: { reasoning: true } },
  ] }] };
  const gw = gateway({ "/v1/models": { data: [{ id: "only-list" }, { id: "both" }] }, "/v1/models/details": details, "/v1/modalities": modalities });
  const catalog = await fetchModelCatalog(llmProxy(), { fetch: gw.fetch });
  assert.deepEqual(catalog.models.map((entry) => entry.id), ["both", "only-details", "only-list", "only-modalities"], "sorted, and the ids of the companions are there");
  const byId = new Map(catalog.models.map((entry) => [entry.id, entry]));
  assert.deepEqual(byId.get("both"), { id: "both", type: "chat", contextWindow: 32768, maxOutputTokens: 4096, inputModalities: ["text", "image"], capabilities: { streaming: true, tools: true } }, "field by field: the details first, what only /modalities says next");
  assert.deepEqual(byId.get("only-list"), unknownEntry("only-list"));
  assert.deepEqual(byId.get("only-details"), { id: "only-details", type: "image", capabilities: {} });
  assert.deepEqual(byId.get("only-modalities"), { id: "only-modalities", type: "chat", capabilities: { reasoning: true } }, "a model without a type is of the type of its group");

  const crowded = gateway({
    "/v1/models": { data: Array.from({ length: 2000 }, (_, index) => ({ id: `m${String(index).padStart(4, "0")}` })) },
    "/v1/models/details": { data: Array.from({ length: 600 }, (_, index) => ({ id: `extra-${index}`, type: "chat" })) },
  });
  assert.equal((await fetchModelCatalog(llmProxy(), { fetch: crowded.fetch })).models.length, 2000);
});

// ─── When the list cannot be had ────────────────────────────────────────────

test("an answer of error to /models is a typed error that says why and what to do, asks nothing more, never reads the body and never names the key", async () => {
  const table = [
    [401, "unauthorized", /refused the API key \(HTTP 401\)/, /Check the key/],
    [403, "unauthorized", /HTTP 403/, /key/],
    [404, "not-found", /no list of models at its address \(HTTP 404\)/, /\/v1/],
    [429, "rate-limited", /limiting requests \(HTTP 429\)/, /again/],
    [500, "server-error", /failed while listing its models \(HTTP 500\)/, /try again/i],
    [502, "server-error", /HTTP 502/, /try again/i],
    [503, "server-error", /HTTP 503/, /try again/i],
    [400, "http-error", /answered HTTP 400/, /by hand/],
    [405, "http-error", /answered HTTP 405/, /by hand/],
    [410, "http-error", /answered HTTP 410/, /by hand/],
    [302, "http-error", /answered HTTP 302/, /by hand/],
  ];
  for (const [status, reason, said, remedy] of table) {
    const body = live();
    body.send(JSON.stringify({ error: { message: `Incorrect API key provided: ${KEY}. Also: the proxy says LEAKED-WORDS.` } }));
    const gw = gateway({ "/v1/models": () => new Response(body.body, { status, headers: { "content-type": "application/json" } }) });
    const error = await failure(fetchModelCatalog(llmProxy(), { fetch: gw.fetch }));
    assert.ok(refusal(error, reason, status), `${status}: ${error}`);
    assert.match(error.message, said, String(status));
    assert.match(error.message, remedy, String(status));
    assert.match(error.message, /"LlmProxy"/, "it says which integration");
    for (const poison of [KEY, "LEAKED-WORDS", "Incorrect API key"]) assert.equal(error.message.includes(poison), false, `${status}: ${poison}`);
    assert.equal(gw.calls.length, 1, "the companions are not asked when the list failed");
    assert.equal(body.state.cancels, 1, "the body was let go, not read");
  }
});

test("a connection that cannot be made is `unreachable`, with the causes a browser cannot tell apart, and the error of the connection is not quoted", async () => {
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
    const error = await failure(fetchModelCatalog(llmProxy(), { fetch: gw.fetch }));
    assert.ok(refusal(error, "unreachable"), String(thrown));
    assert.match(error.message, /Could not reach "LlmProxy"/);
    assert.match(error.message, /CORS/, "a browser cannot tell a blocked request from a server that is off, and says so");
    assert.match(error.message, /redirect/i);
    assert.match(error.message, /address/);
    assert.equal("status" in error && error.status !== undefined, false);
    assert.equal(error.message.includes(KEY), false);
    assert.equal(error.message.includes("ECONNREFUSED"), false, "the words of the connection are not repeated");
    assert.equal(gw.calls.length, 1);
  }
});

test("an answer that is not a list of models is `invalid`, an empty list is `empty`, a list that is too long is `too-large`; none of them quotes what it got", async () => {
  const bodies = {
    invalid: [
      () => new Response("{invalid", { status: 200, headers: { "content-type": "application/json" } }),
      () => new Response(`<html>sk-live-LEAKED-0123456789</html>`, { status: 200, headers: { "content-type": "text/html" } }),
      () => new Response("[]", { status: 200, headers: { "content-type": "text/plain" } }),
      () => new Response(null, { status: 200 }),
      () => new Response(new Uint8Array([0xff, 0xfe, 0xfd]), { status: 200, headers: { "content-type": "application/json" } }),
      () => json(null),
      () => json([]),
      () => json({ data: "sk-live-LEAKED-0123456789" }),
      () => json({ data: [{ id: "valid" }, { id: "sk-live-LEAKED-0123456789\u0000" }] }),
      () => json({ data: [{ id: "__proto__" }] }),
    ],
    empty: [() => json({ object: "list", data: [] })],
    "too-large": [() => json({ data: Array.from({ length: 2001 }, (_, index) => ({ id: `m${index}` })) })],
  };
  for (const [reason, makers] of Object.entries(bodies)) {
    for (const make of makers) {
      const gw = gateway({ "/v1/models": make });
      const error = await failure(fetchModelCatalog(llmProxy(), { fetch: gw.fetch }));
      assert.ok(refusal(error, reason), `${reason}: ${error}`);
      assert.match(error.message, /"LlmProxy"/);
      assert.match(error.message, /by hand/);
      assert.equal(error.message.includes("LEAKED"), false);
      assert.equal(gw.calls.length, 1);
    }
  }
  const advice = {
    invalid: /not a list of models/,
    empty: /lists no models/,
    "too-large": /more than 2000/,
  };
  for (const [reason, pattern] of Object.entries(advice)) {
    const gw = gateway({ "/v1/models": bodies[reason][0] });
    assert.match((await failure(fetchModelCatalog(llmProxy(), { fetch: gw.fetch }))).message, pattern, reason);
  }
});

test("a body that is too big is refused as `too-large`: by what it says it weighs, and by what it really weighs, and it is let go either way", async () => {
  const says = (length) => new Response(JSON.stringify(OWNER_MODELS), { status: 200, headers: { "content-type": "application/json", "content-length": length } });
  const byHeader = await failure(fetchModelCatalog(llmProxy(), { fetch: gateway({ "/v1/models": () => says("600001") }).fetch }));
  assert.ok(refusal(byHeader, "too-large"), String(byHeader));
  assert.match(byHeader.message, /600 KB/);
  assert.equal(engine.CATALOG_MAX_BYTES, 600_000);
  const byBadHeader = await failure(fetchModelCatalog(llmProxy(), { fetch: gateway({ "/v1/models": () => says("not a number") }).fetch }));
  assert.ok(refusal(byBadHeader, "invalid"), String(byBadHeader));

  const stream = live();
  const lying = new Response(stream.body, { status: 200, headers: { "content-type": "application/json", "content-length": "1" } });
  const pending = track(fetchModelCatalog(llmProxy(), { fetch: gateway({ "/v1/models": () => lying }).fetch }));
  await settle();
  stream.send(new Uint8Array(400_000));
  await settle();
  assert.equal(pending.done, false, "400 KB is still within the limit");
  stream.send(new Uint8Array(200_001));
  await settle();
  assert.ok(refusal(pending.error, "too-large"), String(pending.error));
  assert.equal(stream.state.cancels, 1, "the reader was released as soon as the limit was passed");

  const exact = new Uint8Array(600_000).fill(32);
  const text = new TextEncoder().encode(JSON.stringify(OWNER_MODELS));
  exact.set(text);
  const fits = await fetchModelCatalog(llmProxy(), { fetch: gateway({ "/v1/models": () => new Response(exact, { status: 200, headers: { "content-type": "application/json" } }) }).fetch });
  assert.equal(fits.models.length, OWNER_IDS.length, "600 000 bytes are within the limit");
});

test("a body that is not JSON by its type is not read at all", async () => {
  for (const type of ["text/html", "text/plain", "application/octet-stream", "image/png"]) {
    const stream = live();
    stream.send("{\"data\":[{\"id\":\"a\"}]}");
    const gw = gateway({ "/v1/models": () => new Response(stream.body, { status: 200, headers: { "content-type": type } }) });
    const error = await failure(fetchModelCatalog(llmProxy(), { fetch: gw.fetch }));
    assert.ok(refusal(error, "invalid"), type);
    assert.equal(stream.state.cancels, 1, `${type}: let go unread`);
  }
  for (const type of ["application/json", "application/json; charset=utf-8", "application/vnd.api+json", "Application/JSON"]) {
    const gw = gateway({ "/v1/models": () => new Response(JSON.stringify(MODELS_EXAMPLE), { status: 200, headers: { "content-type": type } }) });
    assert.deepEqual((await fetchModelCatalog(llmProxy(), { fetch: gw.fetch })).models.map((entry) => entry.id), ["agic-code-fast"], type);
  }
});

// ─── Time ───────────────────────────────────────────────────────────────────

test("an endpoint that does not answer within 8 s, or goes silent for 8 s while it answers, is a timeout that says so, and the reader is let go", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout", "Date"] });
  assert.equal(engine.CATALOG_TIMEOUT_MS, 8000);
  const silent = gateway({ "/v1/models": () => new Promise(() => undefined) });
  const first = track(fetchModelCatalog(llmProxy(), { fetch: silent.fetch }));
  await settle();
  t.mock.timers.tick(7_999);
  await settle();
  assert.equal(first.done, false);
  t.mock.timers.tick(1);
  await settle();
  assert.ok(refusal(first.error, "timeout"), String(first.error));
  assert.match(first.error.message, /"LlmProxy" did not answer within 8 s/);
  assert.match(first.error.message, /try again/i);
  assert.equal(silent.calls.length, 1);

  const stream = live();
  stream.send("{\"data\":[{\"id\":");
  const quiet = gateway({ "/v1/models": () => jsonStream(stream.body) });
  const second = track(fetchModelCatalog(llmProxy(), { fetch: quiet.fetch }));
  await settle();
  t.mock.timers.tick(7_999);
  await settle();
  assert.equal(second.done, false);
  t.mock.timers.tick(1);
  await settle();
  assert.ok(refusal(second.error, "timeout"), String(second.error));
  assert.match(second.error.message, /"LlmProxy" stopped sending its models for 8 s/);
  assert.equal(stream.state.cancels, 1, "the connection was let go");
});

test("no timer outlives a call, however it ended", async () => {
  const timers = trackTimers();
  try {
    const gw = ownerGateway();
    await fetchModelCatalog(llmProxy(), { fetch: gw.fetch });
    await failure(fetchModelCatalog(llmProxy(), { fetch: gateway({ "/v1/models": json({}, 401) }).fetch }));
    await failure(fetchModelCatalog(llmProxy(), { fetch: gateway({ "/v1/models": () => new Promise(() => undefined) }).fetch, timeoutMs: 20 }));
    await fetchModelCatalog(llmProxy(), { fetch: gateway({ "/v1/models": OWNER_MODELS, "/v1/models/details": () => new Promise(() => undefined) }).fetch, timeoutMs: 20 });
    const aborted = new AbortController();
    const pending = failure(fetchModelCatalog(llmProxy(), { fetch: gateway({ "/v1/models": () => new Promise(() => undefined) }).fetch, signal: aborted.signal }));
    await settle();
    aborted.abort();
    await pending;
    await settle();
  } finally {
    timers.restore();
  }
  assert.equal(timers.pending.size, 0, `${timers.pending.size} timer(s) left`);
});

test("the silence that is watched is the silence between two pieces, not the whole reading: a slow gateway that goes on sending is waited for", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout", "Date"] });
  const text = JSON.stringify(OWNER_MODELS);
  const pieces = Array.from({ length: 6 }, (_, index) => text.slice(Math.floor((index * text.length) / 6), Math.floor(((index + 1) * text.length) / 6)));
  const stream = live();
  const gw = gateway({ "/v1/models": () => jsonStream(stream.body) });
  const pending = track(fetchModelCatalog(llmProxy(), { fetch: gw.fetch }));
  await settle();
  for (const piece of pieces) {
    t.mock.timers.tick(5_000);
    stream.send(piece);
    await settle();
  }
  stream.end();
  await settle();
  assert.equal(pending.error, undefined, pending.error?.message);
  assert.equal(pending.value.models.length, OWNER_IDS.length, "thirty seconds in all, never eight in silence");
});

test("an endpoint that never stops trickling is stopped after 60 s all the same, as a timeout that says how long it went on", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout", "Date"] });
  const stream = live();
  stream.send(" ");
  const gw = gateway({ "/v1/models": () => jsonStream(stream.body) });
  const pending = track(fetchModelCatalog(llmProxy(), { fetch: gw.fetch }));
  await settle();
  for (let second = 0; second < 70 && !pending.done; second += 5) {
    t.mock.timers.tick(5_000);
    stream.send(" ");
    await settle();
  }
  assert.ok(refusal(pending.error, "timeout"), String(pending.error));
  assert.match(pending.error.message, /took longer than 60 s/);
  assert.equal(stream.state.cancels, 1);
  assert.equal(engine.CATALOG_TOTAL_CAP_MS, 60_000);
});

test("the time of a request is the host's to choose", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout", "Date"] });
  const gw = gateway({ "/v1/models": () => new Promise(() => undefined) });
  const pending = track(fetchModelCatalog(llmProxy(), { fetch: gw.fetch, timeoutMs: 2500 }));
  await settle();
  t.mock.timers.tick(2_499);
  await settle();
  assert.equal(pending.done, false);
  t.mock.timers.tick(1);
  await settle();
  assert.ok(refusal(pending.error, "timeout"));
  assert.match(pending.error.message, /within 2\.5 s/);
});

test("the time a host asks for is bounded: a timer that cannot count that far would fire at once, so a request asked to wait for ever is not stopped by it", async () => {
  const delays = [];
  const realSet = globalThis.setTimeout;
  globalThis.setTimeout = (callback, delay, ...rest) => (delays.push(delay), realSet(callback, delay, ...rest));
  try {
    for (const timeoutMs of [1e12, Number.MAX_SAFE_INTEGER, Number.POSITIVE_INFINITY, 2 ** 31]) {
      const catalog = await fetchModelCatalog(llmProxy(), { fetch: ownerGateway().fetch, timeoutMs });
      assert.equal(catalog.models.length, OWNER_IDS.length, String(timeoutMs));
    }
  } finally {
    globalThis.setTimeout = realSet;
  }
  assert.ok(delays.length > 0);
  for (const delay of delays) assert.ok(delay <= 2_147_483_647, `a timer of ${delay} ms`);
});

// ─── Cancelling ─────────────────────────────────────────────────────────────

test("a request that was cancelled before it began sends nothing; one cancelled while it waits, or reads, or while the companions are asked, is an AbortError, never a catalog", async () => {
  const early = new AbortController();
  early.abort();
  const none = ownerGateway();
  const before = await failure(fetchModelCatalog(llmProxy(), { fetch: none.fetch, signal: early.signal }));
  assert.equal(before?.name, "AbortError");
  assert.equal(none.calls.length, 0);

  const waiting = new AbortController();
  const hung = gateway({ "/v1/models": (call) => new Promise((_resolve, reject) => call.init.signal.addEventListener("abort", () => reject(call.init.signal.reason), { once: true })) });
  const first = track(fetchModelCatalog(llmProxy(), { fetch: hung.fetch, signal: waiting.signal }));
  await settle();
  waiting.abort();
  await settle();
  assert.equal(first.error?.name, "AbortError");

  const reading = new AbortController();
  const stream = live();
  stream.send("{\"data\":[");
  const slow = gateway({ "/v1/models": (call) => (call.init.signal.addEventListener("abort", () => stream.fail(call.init.signal.reason), { once: true }), jsonStream(stream.body)) });
  const second = track(fetchModelCatalog(llmProxy(), { fetch: slow.fetch, signal: reading.signal }));
  await settle();
  reading.abort();
  await settle();
  assert.equal(second.error?.name, "AbortError");
  assert.equal(slow.calls.length, 1);

  const optional = new AbortController();
  const pending = gateway({ "/v1/models": OWNER_MODELS, "/v1/models/details": () => new Promise(() => undefined), "/v1/modalities": () => new Promise(() => undefined) });
  const third = track(fetchModelCatalog(llmProxy(), { fetch: pending.fetch, signal: optional.signal }));
  await settle();
  assert.equal(third.done, false, "it waits for the companions");
  optional.abort();
  await settle();
  assert.equal(third.error?.name, "AbortError", "a catalog that was asked to stop is not delivered");
});

// ─── No secret ──────────────────────────────────────────────────────────────

test("no key is in a result, in an error, or in the name of an error, however the integration is named and whatever the server says", async () => {
  const named = llmProxy({ name: `My ${KEY} gateway` });
  const answers = {
    "an error": () => json({ error: { message: `key ${KEY}` } }, 401),
    "a body": () => json({ data: [{ id: `${KEY}\u0000` }] }),
    "a dead connection": () => { throw new TypeError(KEY); },
    "a catalog": () => OWNER_MODELS,
  };
  for (const [name, answer] of Object.entries(answers)) {
    const gw = gateway({ "/v1/models": answer, "/v1/models/details": () => json({ error: KEY }, 500) });
    let seen;
    try {
      seen = await fetchModelCatalog(named, { fetch: gw.fetch });
      assert.ok(Array.isArray(seen.models), `${name}: a catalog`);
    } catch (error) {
      assert.ok(error instanceof AiCatalogError, `${name}: a typed error, not ${error}`);
      seen = { message: error.message, name: error.name, reason: error.reason, stack: error.stack?.split("\n")[0] };
    }
    assert.equal(JSON.stringify(seen).includes(KEY), false, name);
    assert.equal(JSON.stringify(seen).includes(encodeURIComponent(KEY)), false, name);
  }
});

// ─── A real server, a real fetch ────────────────────────────────────────────

let server;
let port;
const hits = [];
const behaviours = new Map();

const gatewayRoutes = {
  "/v1/models": () => ({ type: "application/json", body: JSON.stringify(OWNER_MODELS) }),
  "/v1/models/details": () => ({ type: "application/json", body: JSON.stringify(OWNER_DETAILS) }),
  "/v1/modalities": () => ({ type: "application/json", body: JSON.stringify(OWNER_MODALITIES) }),
};

before(async () => {
  server = http.createServer((request, response) => {
    hits.push({ path: request.url, headers: request.headers });
    const custom = behaviours.get(request.url);
    if (request.url === "/redirect/v1/models") {
      response.writeHead(302, { location: "/v1/models" });
      response.end();
      return;
    }
    if (custom) {
      custom(request, response);
      return;
    }
    const route = gatewayRoutes[request.url];
    if (!route) {
      response.writeHead(404, { "content-type": "application/json" });
      response.end(JSON.stringify({ error: { message: "nope" } }));
      return;
    }
    const { type, body } = route();
    response.writeHead(200, { "content-type": type });
    response.end(body);
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  port = server.address().port;
});

after(async () => {
  server.closeAllConnections();
  await new Promise((resolve) => server.close(resolve));
});

const local = (extra = {}) => llmProxy({ endpoint: `http://127.0.0.1:${port}/v1`, ...extra });

test("real server: with the real fetch the three answers become the catalog, and the server is sent no cookie, only the key", async () => {
  hits.length = 0;
  const catalog = await fetchModelCatalog(local());
  assert.deepEqual(catalog.source, { models: true, details: true, modalities: true });
  assert.equal(catalog.models.length, OWNER_IDS.length);
  assert.deepEqual(hits.map((hit) => hit.path).sort(), ["/v1/models", "/v1/models/details", "/v1/modalities"].sort(), "the list and the two companions, each once");
  for (const hit of hits) {
    assert.equal(hit.headers.authorization, `Bearer ${KEY}`);
    assert.equal(hit.headers.cookie, undefined);
    assert.equal(hit.headers.referer, undefined);
  }
});

test("real server: a redirect is refused, not followed: the endpoint it points to is never asked", async () => {
  hits.length = 0;
  const error = await failure(fetchModelCatalog(local({ endpoint: `http://127.0.0.1:${port}/redirect/v1` })));
  assert.ok(refusal(error, "unreachable"), String(error));
  assert.match(error.message, /redirect/i);
  assert.deepEqual(hits.map((hit) => hit.path), ["/redirect/v1/models"], "one request, and no second one to /v1/models");
  assert.equal(error.message.includes(KEY), false);
});

test("real server: an endpoint that is down is `unreachable`, and one that answers 404 is `not-found`", async () => {
  const closed = http.createServer();
  await new Promise((resolve) => closed.listen(0, "127.0.0.1", resolve));
  const { port: freePort } = closed.address();
  await new Promise((resolve) => closed.close(resolve));
  const down = await failure(fetchModelCatalog(llmProxy({ endpoint: `http://127.0.0.1:${freePort}/v1` })));
  assert.ok(refusal(down, "unreachable"), String(down));
  const missing = await failure(fetchModelCatalog(local({ endpoint: `http://127.0.0.1:${port}/nothing-here/v1` })));
  assert.ok(refusal(missing, "not-found", 404), String(missing));
});

test("real server: a silence in the middle of the list is a timeout, the connection is closed, and a reader that is cancelled closes it too", async () => {
  const closed = [];
  behaviours.set("/v1/models", (request, response) => {
    closed.push(new Promise((resolve) => response.on("close", resolve)));
    response.writeHead(200, { "content-type": "application/json" });
    response.write("{\"data\":[{\"id\":\"a\"},");
  });
  try {
    const startedAt = Date.now();
    const error = await failure(fetchModelCatalog(local(), { timeoutMs: 250 }));
    assert.ok(refusal(error, "timeout"), String(error));
    assert.ok(Date.now() - startedAt < 3000);
    assert.equal(await Promise.race([closed[0].then(() => true), sleep(3000).then(() => false)]), true, "the client let the connection go");

    const controller = new AbortController();
    const pending = failure(fetchModelCatalog(local(), { signal: controller.signal }));
    await sleep(100);
    controller.abort();
    assert.equal((await pending)?.name, "AbortError");
    assert.equal(await Promise.race([closed[1].then(() => true), sleep(3000).then(() => false)]), true, "and so did the author's cancel");
  } finally {
    behaviours.delete("/v1/models");
  }
});

test("real server: a body over the limit is refused, whatever it says it weighs", async () => {
  behaviours.set("/v1/models", (request, response) => {
    response.writeHead(200, { "content-type": "application/json" });
    response.end(JSON.stringify({ data: [{ id: "x".repeat(250) }], padding: "p".repeat(700_000) }));
  });
  try {
    const error = await failure(fetchModelCatalog(local()));
    assert.ok(refusal(error, "too-large"), String(error));
  } finally {
    behaviours.delete("/v1/models");
  }
});

// ─── LM Studio: its own list, on this computer only ─────────────────────────

test("fetchLmStudioModels: the native list of an LM Studio on this computer, with no companion request and nothing but a plain GET", async () => {
  const gw = gateway({ "/api/v1/models": LMSTUDIO_MODELS });
  for (const endpoint of ["http://localhost:1234/v1", "http://127.0.0.1:1234/v1/", "http://[::1]:1234/v1", "http://localhost:1234"]) {
    gw.calls.length = 0;
    const models = await fetchLmStudioModels(integration({ endpoint, apiKey: "" }), { fetch: gw.fetch });
    assert.deepEqual(models.map((model) => model.key), ["qwen/qwen3-4b", "openai/gpt-oss-20b", "plain-model"], endpoint);
    assert.equal(gw.calls.length, 1);
    assert.equal(new URL(gw.calls[0].url).pathname, "/api/v1/models", "at the root of the server, whatever path the endpoint has");
    assert.equal(gw.calls[0].init.method, "GET");
    assert.equal(gw.calls[0].init.credentials, "omit");
    assert.equal(gw.calls[0].init.redirect, "error");
    assert.deepEqual(Object.keys(gw.calls[0].init.headers), ["accept"], "no key where there is none");
  }
  gw.calls.length = 0;
  await fetchLmStudioModels(integration({ endpoint: "http://localhost:1234/v1", apiKey: KEY }), { fetch: gw.fetch });
  assert.equal(gw.calls[0].init.headers.authorization, `Bearer ${KEY}`, "a token that is configured is sent: to this computer only");
});

test("fetchLmStudioModels: it reads nothing from a server that is not this computer, and says nothing when it cannot read: the caller keeps what it knew", async () => {
  const gw = gateway({ "/api/v1/models": LMSTUDIO_MODELS });
  for (const target of [
    integration({ endpoint: "https://llm.example.com/v1" }),
    integration({ endpoint: "http://192.168.1.20:1234/v1" }),
    integration({ endpoint: "http://localhost.evil.example/v1" }),
    integration({ endpoint: "http://user:pass@localhost:1234/v1" }),
    integration({ provider: "azure_openai", endpoint: "http://localhost:1234" }),
    integration({ endpoint: "not an address" }),
  ]) assert.equal(await fetchLmStudioModels(target, { fetch: gw.fetch }), undefined, target.endpoint);
  assert.equal(gw.calls.length, 0, "no request left this computer, or was made at all");
  const local = integration({ endpoint: "http://localhost:1234/v1", apiKey: "" });
  const broken = [
    gateway({}),
    gateway({ "/api/v1/models": json({ error: "x" }, 500) }),
    gateway({ "/api/v1/models": () => { throw new TypeError("fetch failed"); } }),
    gateway({ "/api/v1/models": new Response("<html>", { status: 200, headers: { "content-type": "text/html" } }) }),
    gateway({ "/api/v1/models": json({ models: "nope" }) }),
    gateway({ "/api/v1/models": () => new Response("x", { status: 200, headers: { "content-type": "application/json", "content-length": "700000" } }) }),
  ];
  for (const one of broken) assert.equal(await fetchLmStudioModels(local, { fetch: one.fetch }), undefined);
  const aborted = new AbortController();
  aborted.abort();
  assert.equal((await failure(fetchLmStudioModels(local, { fetch: gw.fetch, signal: aborted.signal })))?.name, "AbortError");
});

test("fetchLmStudioModels: a silence is a silence of 8 s here too", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout", "Date"] });
  const gw = gateway({ "/api/v1/models": () => new Promise(() => undefined) });
  const pending = track(fetchLmStudioModels(integration({ endpoint: "http://localhost:1234/v1", apiKey: "" }), { fetch: gw.fetch }));
  await settle();
  t.mock.timers.tick(8_000);
  await settle();
  assert.equal(pending.done, true);
  assert.equal(pending.value, undefined);
});

test("the contract's own example and a gateway with a different shape of list: what a provider that is not OpenAI sends is a typed error, never a half catalog", async () => {
  const sample = gateway({ "/v1/models": MODELS_EXAMPLE, "/v1/models/details": DETAILS_EXAMPLE, "/v1/modalities": MODALITIES_EXAMPLE });
  const catalog = await fetchModelCatalog(llmProxy(), { fetch: sample.fetch });
  assert.deepEqual(catalog.models.map((entry) => entry.id), ["agic-code-fast", "muse"], "the models of the three answers of the contract, as they are written there");
  const shapes = {
    "a bare array (Together AI)": [{ id: "a", object: "model", type: "chat" }],
    "models and names, with a token for the next page (Cohere)": { models: [{ name: "command-a", endpoints: ["chat"] }], next_page_token: "t" },
    "names instead of ids (Ollama's own list)": { models: [{ name: "llama3:8b", model: "llama3:8b" }] },
  };
  for (const [name, body] of Object.entries(shapes)) {
    const error = await failure(fetchModelCatalog(llmProxy(), { fetch: gateway({ "/v1/models": body }).fetch }));
    assert.ok(refusal(error, "invalid"), name);
  }
});

test("a list that comes in pages (Anthropic's, which has ids) is refused as too large and not read as the whole catalog; its last page is the catalog", async () => {
  const page = { data: [{ type: "model", id: "claude-a", display_name: "Claude A" }], first_id: "claude-a", has_more: true, last_id: "claude-a" };
  const paged = gateway({ "/v1/models": page });
  const error = await failure(fetchModelCatalog(llmProxy(), { fetch: paged.fetch }));
  assert.ok(refusal(error, "too-large"), String(error));
  assert.match(error.message, /\"LlmProxy\" is too large to be read/);
  assert.match(error.message, /more than 2000 models, or it comes in pages/);
  assert.match(error.message, /by hand/);
  assert.equal(error.message.includes("claude"), false);
  assert.equal(paged.calls.length, 1, "there is no catalog, so the companions are not asked");
  const last = await fetchModelCatalog(llmProxy(), { fetch: gateway({ "/v1/models": { ...page, has_more: false } }).fetch });
  assert.deepEqual(last.models.map((entry) => entry.id), ["claude-a"]);
});
