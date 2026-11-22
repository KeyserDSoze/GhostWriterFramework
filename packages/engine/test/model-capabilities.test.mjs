import test from "node:test";
import assert from "node:assert/strict";
import * as engine from "../dist/index.js";
import { MemoryBookStore, createFakeAutopilotAi, seedBookFiles } from "../dist/testing/index.js";
import { ASK, DONE, JSON_ASK, SCHEMA, call, content, finish, integration, jsonStream, recording, sse } from "./transport-fakes.mjs";

const { AiProviderError, AutopilotSession, buildChatRequest, createFetchAi, parseAutopilotState, pickAiRuntimeConfig, planAttempts, redactAiRuntimeConfig, requestOutputLimit, resolveAiCandidates } = engine;

const MODEL = "muse-glimmer-30b";
const reply = (text = "Hi") => Response.json({ choices: [{ message: { content: text }, finish_reason: "stop" }] });
const toolReply = (value) => Response.json({ choices: [{ message: { tool_calls: [{ function: { name: "result", arguments: JSON.stringify(value) } }] }, finish_reason: "tool_calls" }] });
const cut = (message = { content: "" }, usage = { prompt_tokens: 50, completion_tokens: 4000 }) => Response.json({ choices: [{ message, finish_reason: "length" }], usage });
const failing = (status, error) => new Response(JSON.stringify({ error }), { status, headers: { "content-type": "application/json" } });

/** A configuration with one model, which declares `flags`, in an integration that says `integrationExtra`. */
const withModel = (flags = {}, integrationExtra = {}, more = {}) => ({ aiIntegrations: [integration({ chatModels: [{ id: "m", name: MODEL, capabilities: ["default"], ...flags }], ...integrationExtra })], ...more });
const candidateOf = (flags, integrationExtra, more) => resolveAiCandidates(pickAiRuntimeConfig(withModel(flags, integrationExtra, more)), "autopilot")[0];

const OLD_MODEL_KEYS = ["capabilities", "id", "maxInputTokens", "maxOutputTokens", "name", "pricing", "supportsToolCalls", "underlyingModel"];

// ─── In the configuration ───────────────────────────────────────────────────

test("a model's streaming, reasoning and vision are booleans that the configuration keeps and anything else it drops; a model without them has no such keys", () => {
  for (const key of ["supportsStreaming", "supportsReasoning", "supportsVision"]) {
    for (const value of [true, false]) assert.equal(pickAiRuntimeConfig(withModel({ [key]: value })).aiIntegrations[0].chatModels[0][key], value, `${key} ${value}`);
    for (const junk of ["true", "false", "yes", 1, 0, null, {}, [], Number.NaN]) assert.equal(key in pickAiRuntimeConfig(withModel({ [key]: junk })).aiIntegrations[0].chatModels[0], false, `${key} ${JSON.stringify(junk)}`);
  }
  const old = pickAiRuntimeConfig(withModel({ supportsToolCalls: false, maxInputTokens: 8192, maxOutputTokens: 1024 })).aiIntegrations[0].chatModels[0];
  assert.deepEqual(Object.keys(old).sort(), OLD_MODEL_KEYS, "a configuration that says none of the three is picked exactly as it was");
  const all = pickAiRuntimeConfig(withModel({ supportsToolCalls: true, supportsStreaming: false, supportsReasoning: true, supportsVision: false, maxInputTokens: 131072, maxOutputTokens: 8192 }));
  assert.deepEqual(pickAiRuntimeConfig(JSON.parse(JSON.stringify(all))), all, "picking again changes nothing: what a server saves is what it reads");
});

test("the safe view shows the six things a model declares, and only the ones it declares, and still no key", () => {
  const picked = pickAiRuntimeConfig(withModel({ supportsToolCalls: false, supportsStreaming: false, supportsReasoning: true, supportsVision: true, maxInputTokens: 131072, maxOutputTokens: 8192 }));
  const view = redactAiRuntimeConfig(picked);
  assert.deepEqual(view.integrations[0].models, [{
    name: MODEL,
    capabilities: ["default"],
    supportsToolCalls: false,
    supportsStreaming: false,
    supportsReasoning: true,
    supportsVision: true,
    maxInputTokens: 131072,
    maxOutputTokens: 8192,
  }]);
  assert.deepEqual(redactAiRuntimeConfig(pickAiRuntimeConfig(withModel())).integrations[0].models, [{ name: MODEL, capabilities: ["default"] }], "a model that declares nothing is shown as it always was");
  const literal = redactAiRuntimeConfig(withModel({ supportsStreaming: "yes", supportsReasoning: 1, maxInputTokens: "big", maxOutputTokens: -5, supportsToolCalls: null }));
  assert.deepEqual(literal.integrations[0].models, [{ name: MODEL, capabilities: ["default"] }], "what is not a boolean or a number is not shown");
  assert.equal(JSON.stringify(view).includes("sk-test-SECRET"), false);
});

test("a candidate carries what its model declares, with or without a route, and a candidate whose model declares nothing has none of the new keys", () => {
  const flags = { supportsToolCalls: true, supportsStreaming: false, supportsReasoning: true, supportsVision: true };
  const plain = candidateOf({});
  for (const key of ["supportsStreaming", "supportsReasoning", "supportsVision"]) assert.equal(key in plain, false, key);
  const declared = candidateOf(flags);
  assert.deepEqual([declared.supportsToolCalls, declared.supportsStreaming, declared.supportsReasoning, declared.supportsVision], [true, false, true, true]);
  const routed = candidateOf(flags, {}, { taskRouting: { autopilot: { primary: { integrationId: "p", model: MODEL } } } });
  assert.deepEqual([routed.supportsStreaming, routed.supportsReasoning, routed.supportsVision], [false, true, true]);
  const half = candidateOf({ supportsReasoning: false });
  assert.equal("supportsStreaming" in half, false);
  assert.equal(half.supportsReasoning, false);
});

// ─── Streaming ──────────────────────────────────────────────────────────────

test("a model that declares it does not stream is not asked to: no `stream`, no `stream_options`, and the reply is asked for as a JSON body, whatever the integration says", () => {
  const request = { system: "S", user: "U" };
  const base = { integration: integration({ streamMode: "auto" }), model: MODEL };
  const streamed = buildChatRequest(base, request);
  assert.equal(streamed.stream, true);
  assert.equal(streamed.body.stream, true);
  assert.equal(streamed.headers.accept, "text/event-stream");
  for (const declared of [{ supportsStreaming: undefined }, { supportsStreaming: true }]) {
    assert.deepEqual(buildChatRequest({ ...base, ...declared }, request).body, streamed.body, "an undeclared or a declared stream is the stream it was");
  }
  const plain = buildChatRequest({ ...base, supportsStreaming: false }, request);
  assert.equal(plain.stream, false);
  assert.equal("stream" in plain.body, false);
  assert.equal("stream_options" in plain.body, false);
  assert.equal(plain.headers.accept, "application/json");
  const { stream: _stream, stream_options: _options, ...rest } = streamed.body;
  assert.deepEqual(plain.body, rest, "nothing else in the body moves");
  const structured = buildChatRequest({ ...base, supportsStreaming: false }, { ...request, json: SCHEMA });
  assert.equal("stream" in structured.body, false);
  assert.equal(structured.useTools, true, "the function is forced all the same");
  const off = buildChatRequest({ ...base, integration: integration({ streamMode: "off" }), supportsStreaming: true }, request);
  assert.equal(off.stream, false, "what the integration turned off a model does not turn on");
});

test("through the client: a model that does not stream is called without `stream` for prose and for a function, and says why in the note of its attempt", async () => {
  const attempts = [];
  const { fetch, calls } = recording((entry) => (entry.body.tools ? toolReply({ ok: true }) : reply("A whole scene.")));
  const ai = createFetchAi(pickAiRuntimeConfig(withModel({ supportsStreaming: false })), { fetch, onAttempt: (attempt) => attempts.push(attempt) });
  const prose = await ai.complete(ASK);
  const structured = await ai.complete(JSON_ASK);
  assert.equal(prose.text, "A whole scene.");
  assert.deepEqual(structured.json, { ok: true });
  for (const entry of calls) {
    assert.equal("stream" in entry.body, false);
    assert.equal("stream_options" in entry.body, false);
    assert.equal(entry.init.headers.accept, "application/json");
  }
  for (const attempt of attempts) {
    assert.equal(attempt.stream, false);
    assert.equal(attempt.streamMode, "auto", "the integration's own word is what it is");
    assert.deepEqual(attempt.notes, [`Streaming was not used: "${MODEL}" is declared as not streaming (supportsStreaming is off).`]);
  }
});

test("without the declaration, or with `streamMode: off` that already says it, a call is as it was and has no note", async () => {
  for (const [flags, extra] of [[{}, {}], [{ supportsStreaming: true }, {}], [{ supportsStreaming: false }, { streamMode: "off" }], [{ supportsStreaming: undefined }, {}]]) {
    const attempts = [];
    const { fetch, calls } = recording(() => reply("Hi"));
    await createFetchAi(pickAiRuntimeConfig(withModel(flags, extra)), { fetch, onAttempt: (attempt) => attempts.push(attempt) }).complete(ASK);
    assert.equal("notes" in attempts[0], false, JSON.stringify([flags, extra]));
    assert.equal(calls[0].body.stream === true, extra.streamMode !== "off", JSON.stringify([flags, extra]));
  }
});

test("a call that streams to a model that is not declared goes on as E1 made it: pieces of text, and the idle deadline", async () => {
  const texts = [];
  const response = await createFetchAi(pickAiRuntimeConfig(withModel({})), { fetch: async () => sse([content("Hel"), content("lo"), finish("stop"), DONE]) }).complete({ ...ASK, onText: (text) => texts.push(text) });
  assert.equal(response.text, "Hello");
  assert.deepEqual(texts, ["Hel", "Hello"]);
  const decl = await createFetchAi(pickAiRuntimeConfig(withModel({ supportsStreaming: false })), { fetch: async () => reply("Whole.") }).complete({ ...ASK, onText: (text) => texts.push(text) });
  assert.equal(decl.text, "Whole.");
  assert.deepEqual(texts.slice(2), ["Whole."], "a reply that came whole still reaches the listener once");
});

// ─── Reasoning: the margin ──────────────────────────────────────────────────

test("a model declared as reasoning gets the margin of output for its reasoning, as a model known by its name does; temperature and the name of the limit stay as they were", () => {
  const base = { integration: { provider: "openai" }, model: "my-local-model" };
  const request = { maxOutputTokens: 1000 };
  assert.equal(requestOutputLimit(request, base), 1000);
  assert.equal(requestOutputLimit(request, { ...base, supportsReasoning: true }), 1000 + engine.REASONING_OUTPUT_MARGIN);
  assert.equal(requestOutputLimit({ ...request, json: SCHEMA }, { ...base, supportsReasoning: true }), 4096 + 12000, "a function gets its floor first");
  assert.equal(requestOutputLimit(request, { ...base, supportsReasoning: true, maxOutputTokens: 8192 }), 8192, "never above what the model can");
  assert.equal(requestOutputLimit({ ...request, outputBoost: 3 }, { ...base, supportsReasoning: true }), 3 * 13000, "and the second try after a cut multiplies it");
  assert.equal(requestOutputLimit(request, { ...base, supportsReasoning: false }), 1000, "a model that says it does not reason has no margin");
  assert.equal(requestOutputLimit({}, { ...base, supportsReasoning: true, maxOutputTokens: 4096 }), 4096, "with no limit asked, the model's own is the limit");

  const body = (flags, extra = {}) => buildChatRequest({ integration: integration(), model: "my-local-model", ...flags }, { system: "S", user: "U", maxOutputTokens: 1000, temperature: 0.4, ...extra }).body;
  assert.equal(body({}).max_tokens, 1000);
  assert.equal(body({ supportsReasoning: true }).max_tokens, 13000, "the parameter is the one a model of this name takes");
  assert.equal(body({ supportsReasoning: true }).temperature, 0.4, "a local reasoning model takes a temperature");
  assert.equal("max_completion_tokens" in body({ supportsReasoning: true }), false);
});

test("what the name of a model says is not undone by a declaration: a model known to reason by name keeps its margin, whatever the box says", () => {
  const request = { maxOutputTokens: 1000 };
  for (const declared of [undefined, true, false]) {
    assert.equal(requestOutputLimit(request, { integration: { provider: "openai" }, model: "o3-mini", ...(declared === undefined ? {} : { supportsReasoning: declared }) }), 13000, `o3-mini, ${declared}`);
    assert.equal(requestOutputLimit(request, { integration: { provider: "azure_openai" }, model: "my-deployment", underlyingModel: "gpt-5-mini", ...(declared === undefined ? {} : { supportsReasoning: declared }) }), 13000, `azure, ${declared}`);
  }
});

// ─── Reasoning: the thinking level ──────────────────────────────────────────

test("a thinking level is sent to a model that declares it reasons and to one that does not say; a model that declares it does not is not sent one, and the request says why", () => {
  /** `thinking: null` is a candidate with no level of its own: only its integration may have one. */
  const send = (flags, { thinking = "high", integrationExtra = {} } = {}) => buildChatRequest({ integration: integration(integrationExtra), model: MODEL, ...(thinking === null ? {} : { thinking }), ...flags }, { system: "S", user: "U" });
  assert.equal(send({}).body.reasoning_effort, "high", "not declared: as E2 sends it");
  assert.equal(send({ supportsReasoning: true }).body.reasoning_effort, "high");
  const withheld = send({ supportsReasoning: false });
  assert.equal("reasoning_effort" in withheld.body, false);
  assert.equal("thinking" in withheld, false, "nothing was sent: the request carries no level");
  assert.deepEqual(withheld.notes, [`The thinking level "high" was not sent: "${MODEL}" is declared as not reasoning (supportsReasoning is off).`]);
  const fromIntegration = send({ supportsReasoning: false }, { thinking: null, integrationExtra: { thinking: "xhigh" } });
  assert.equal("reasoning_effort" in fromIntegration.body, false, "the integration's level is withheld too");
  assert.match(fromIntegration.notes[0], /"xhigh" was not sent/);
  for (const quiet of [send({ supportsReasoning: false }, { thinking: "automatic" }), send({ supportsReasoning: false }, { thinking: null }), send({ supportsReasoning: true }), send({})]) assert.equal("notes" in quiet, false, "no level was asked for, or it was sent: nothing to say");
  assert.equal(send({ supportsReasoning: true }).thinking, "high");
});

test("through the client: the level a model declared not to take is not sent, so the provider has no reason to refuse it; the attempt says so; the same level to a model that does not say is refused as before", async () => {
  const provider = (entry) => ("reasoning_effort" in entry.body ? failing(400, { message: "Unrecognized request argument supplied: reasoning_effort" }) : reply("Answered."));
  const attempts = [];
  const quiet = recording(provider);
  const config = pickAiRuntimeConfig(withModel({ supportsReasoning: false }, { thinking: "high" }));
  const response = await createFetchAi(config, { fetch: quiet.fetch, onAttempt: (attempt) => attempts.push(attempt) }).complete(ASK);
  assert.equal(response.text, "Answered.");
  assert.equal(quiet.calls.length, 1, "no useless request, no 400");
  assert.equal("thinking" in attempts[0], false);
  assert.deepEqual(attempts[0].notes, [`The thinking level "high" was not sent: "${MODEL}" is declared as not reasoning (supportsReasoning is off).`]);

  const unsaid = recording(provider);
  const error = await createFetchAi(pickAiRuntimeConfig(withModel({}, { thinking: "high" })), { fetch: unsaid.fetch }).complete(ASK).then(() => null, (failure) => failure);
  assert.ok(error instanceof AiProviderError);
  assert.match(error.message, /does not accept a thinking level/, "E2's own answer to a model that was not declared");

  const ok = await createFetchAi(pickAiRuntimeConfig(withModel({ supportsReasoning: true }, { thinking: "high" })), { fetch: async () => reply("Fine."), onAttempt: (attempt) => attempts.push(attempt) }).complete(ASK);
  assert.equal(ok.text, "Fine.");
  assert.equal(attempts.at(-1).thinking, "high", "a model that declares it reasons is sent the level");
});

// ─── Reasoning: a reply cut before the first word ───────────────────────────

test("a declared reasoning model whose reply is cut with nothing written is a reply cut while reasoning, though no reasoning could be seen; any other model is plain truncation, as before", async () => {
  const ask = (flags, response, request = { ...ASK, maxOutputTokens: 500 }) => createFetchAi(pickAiRuntimeConfig(withModel(flags)), { fetch: async () => response() }).complete(request).then(() => null, (failure) => failure);
  const hidden = await ask({ supportsReasoning: true }, () => cut());
  assert.ok(hidden instanceof AiProviderError);
  assert.equal(hidden.truncated, true);
  assert.equal(hidden.reasoningOnly, true, "this is what lets the autopilot try again with a larger limit");
  assert.equal(hidden.retryable, false);
  assert.match(hidden.message, /declared as reasoning/);
  assert.match(hidden.message, /output limit before writing the reply/);
  assert.deepEqual(hidden.usage, { inputTokens: 50, outputTokens: 4000, cachedInputTokens: 0 }, "what it cost is kept");

  for (const flags of [{}, { supportsReasoning: false }]) {
    const plain = await ask(flags, () => cut());
    assert.equal(plain.truncated, true);
    assert.equal(plain.reasoningOnly, undefined, JSON.stringify(flags));
    assert.match(plain.message, /the reply was cut by the output token limit/);
  }
  const half = await ask({ supportsReasoning: true }, () => cut({ content: "Half a scene" }));
  assert.equal(half.reasoningOnly, undefined, "a reply that said something is cut, not reasoned away");
  assert.match(half.message, /cut by the output token limit/);
  const seen = await ask({ supportsReasoning: false }, () => cut({ content: "", reasoning_content: "thinking ".repeat(50) }));
  assert.equal(seen.reasoningOnly, true, "what was seen is seen, whatever the box says");
  assert.match(seen.message, /while reasoning/);
  assert.doesNotMatch(seen.message, /declared/);
  const limited = await createFetchAi(pickAiRuntimeConfig(withModel({ supportsReasoning: true, maxOutputTokens: 4096 })), { fetch: async () => cut() }).complete({ ...ASK, maxOutputTokens: 4000 }).then(() => null, (failure) => failure);
  assert.equal(limited.limitReached, true, "a model asked for all it can has nothing larger to be asked for");
});

test("the same, in a stream, and for a function: nothing written and a length finish", async () => {
  const stream = (chunks) => async () => sse(chunks);
  const hiddenText = await createFetchAi(pickAiRuntimeConfig(withModel({ supportsReasoning: true })), { fetch: stream([finish("length"), DONE]) }).complete({ ...ASK, onText: () => undefined }).then(() => null, (failure) => failure);
  assert.equal(hiddenText.reasoningOnly, true);
  const hiddenCall = await createFetchAi(pickAiRuntimeConfig(withModel({ supportsReasoning: true })), { fetch: stream([finish("length"), DONE]) }).complete(JSON_ASK).then(() => null, (failure) => failure);
  assert.equal(hiddenCall.reasoningOnly, true);
  const partialCall = await createFetchAi(pickAiRuntimeConfig(withModel({ supportsReasoning: true })), { fetch: stream([call("", { name: "result" }), call("{\"ok\":"), finish("length"), DONE]) }).complete(JSON_ASK).then(() => null, (failure) => failure);
  assert.equal(partialCall.reasoningOnly, undefined, "a function that was begun is an answer that was cut");
});

test("in a whole run: a declared reasoning model that spends its limit before it writes a word is asked again with a limit three times larger, and a model that does not say stops with the plain truncation", async () => {
  const FAST = { readers: false, readersOnPlan: false, specialists: false, pauseAfterPlan: false };
  async function run(flags) {
    const fake = createFakeAutopilotAi();
    const limits = [];
    const fetch = async (_url, init) => {
      const body = JSON.parse(init.body);
      limits.push(body.max_tokens ?? body.max_completion_tokens);
      if (limits.length === 1) return cut();
      const tool = body.tools?.[0]?.function;
      const out = await fake.complete({ capability: "autopilot", label: "provider", system: body.messages[0].content, user: body.messages[1].content, ...(tool ? { json: tool } : {}) });
      const usage = { prompt_tokens: 100, completion_tokens: 50 };
      if (!tool) return Response.json({ choices: [{ message: { content: out.text }, finish_reason: "stop" }], usage });
      return Response.json({ choices: [{ message: { tool_calls: [{ function: { name: tool.name, arguments: JSON.stringify(out.json) } }] }, finish_reason: "tool_calls" }], usage });
    };
    const store = new MemoryBookStore(seedBookFiles());
    const events = [];
    const session = new AutopilotSession({ bookId: "book", store, ai: createFetchAi(pickAiRuntimeConfig(withModel(flags)), { fetch }), host: "server", hostLabel: "test", retryDelayMs: 0 });
    session.subscribe((event) => events.push(event));
    await session.start({ brief: { idea: "x", targetChapters: 1, scenesPerChapter: 1, wordsPerScene: 300 }, options: FAST, limits: { steps: 1 } });
    await session.waitForIdle();
    return { limits, events, state: parseAutopilotState(store.files.get("autopilot/state.json")) };
  }
  const declared = await run({ supportsReasoning: true });
  assert.equal(declared.state.status, "paused", declared.state.lastError?.message);
  assert.ok(declared.limits.length >= 2);
  assert.equal(declared.limits[1], 3 * declared.limits[0], "three times the limit of the first try");
  assert.ok(declared.events.some((event) => event.type === "insight" && /retrying once with a 3× larger limit/.test(event.title)));
  const unsaid = await run({});
  assert.equal(unsaid.state.status, "error");
  assert.equal(unsaid.state.lastError.errorKind, "truncated");
  assert.equal(unsaid.limits.length, 1, "no second try");
});

// ─── What does not change ───────────────────────────────────────────────────

test("a candidate that declares nothing is built into the very requests it always was, flag by flag, for the models of every family", () => {
  const request = { system: "SYS", user: "USR", maxOutputTokens: 1500, temperature: 0.3 };
  const candidates = [
    { integration: integration(), model: "gpt-4o" },
    { integration: integration({ provider: "azure_openai", endpoint: "https://x.openai.azure.com", apiVersion: "2024-10-21" }), model: "dep-1", underlyingModel: "o3-mini" },
    { integration: integration({ streamMode: "off" }), model: MODEL, maxOutputTokens: 8192, supportsToolCalls: false },
    { integration: integration({ provider: "github_models" }), model: "openai/gpt-5", thinking: "low" },
  ];
  for (const candidate of candidates) {
    for (const extra of [{}, { json: SCHEMA }, { json: SCHEMA, outputBoost: 3 }]) {
      const left = buildChatRequest(candidate, { ...request, ...extra });
      const right = buildChatRequest({ ...candidate, supportsStreaming: undefined, supportsReasoning: undefined, supportsVision: undefined }, { ...request, ...extra });
      assert.deepEqual(right, left, `${candidate.model} ${JSON.stringify(Object.keys(extra))}`);
      assert.equal("notes" in left, false);
    }
    const vision = buildChatRequest({ ...candidate, supportsVision: true }, request);
    assert.deepEqual(vision, buildChatRequest(candidate, request), "vision is data: it changes no request");
  }
  const cfg = pickAiRuntimeConfig(withModel({}));
  const plan = planAttempts(cfg, JSON_ASK);
  assert.equal(plan.attempts.length, 1);
  assert.equal("notes" in plan.attempts[0].built, false);
});

test("the tool calls are the same as E2 made them, and the new declarations neither add nor take away a model from the route", async () => {
  const two = (first, second) => ({ aiIntegrations: [
    integration({ id: "a", name: "Alpha", endpoint: "http://a.test/v1", chatModels: [{ id: "a1", name: "alpha-model", capabilities: ["default"], ...first }] }),
    integration({ id: "b", name: "Beta", endpoint: "http://b.test/v1", chatModels: [{ id: "b1", name: "beta-model", capabilities: ["default"], ...second }] }),
  ] });
  const hostOf = (entry) => new URL(entry.url).hostname;
  const asked = async (config) => {
    const { fetch, calls } = recording(() => toolReply({ ok: true }));
    const attempts = [];
    await createFetchAi(config, { fetch, onAttempt: (attempt) => attempts.push(attempt) }).complete(JSON_ASK);
    return { calls: calls.map(hostOf), attempts };
  };
  const skipped = await asked(two({ supportsToolCalls: false, supportsStreaming: true, supportsReasoning: true }, { supportsStreaming: false }));
  assert.deepEqual(skipped.calls, ["b.test"], "a model without tool calls is skipped whatever else it declares");
  assert.deepEqual(skipped.attempts[0].skipped, [{ model: "alpha-model", reason: "no-tool-calls" }]);
  const kept = await asked(two({ supportsToolCalls: true, supportsStreaming: false, supportsReasoning: false, supportsVision: true }, {}));
  assert.deepEqual(kept.calls, ["a.test"]);
  assert.equal(kept.attempts[0].tools, true, "the function is forced, with or without a stream");
  assert.equal(kept.attempts[0].stream, false);
});
