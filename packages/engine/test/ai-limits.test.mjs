import test from "node:test";
import assert from "node:assert/strict";
import * as engine from "../dist/index.js";
import { MemoryBookStore, createFakeAutopilotAi, seedBookFiles } from "../dist/testing/index.js";

const { AiProviderError, AutopilotSession, createFetchAi, estimateCost, parseAutopilotState, pickAiRuntimeConfig } = engine;

const SCHEMA = { name: "result", description: "A result", parameters: { type: "object", properties: { ok: { type: "boolean" } }, required: ["ok"] } };
const ASK = { capability: "autopilot", label: "t", system: "SYS", user: "USR" };

const encoder = new TextEncoder();
function sse(chunks) {
  return new ReadableStream({
    start(controller) {
      for (const chunk of chunks) controller.enqueue(encoder.encode(chunk));
      controller.close();
    },
  });
}
const events = (chunks) => new Response(sse(chunks), { status: 200, headers: { "content-type": "text/event-stream" } });
const data = (value) => `data: ${JSON.stringify(value)}\n\n`;
const DONE = "data: [DONE]\n\n";
const content = (text) => data({ choices: [{ delta: { content: text } }] });
const reasoning = (text) => data({ choices: [{ delta: { reasoning_content: text } }] });
const finish = (reason) => data({ choices: [{ delta: {}, finish_reason: reason }] });
const usageChunk = (prompt, completion) => data({ choices: [], usage: { prompt_tokens: prompt, completion_tokens: completion } });

function model(name, extra = {}, integrationExtra = {}) {
  return pickAiRuntimeConfig({ aiIntegrations: [{ id: "a", name: "A", provider: "openai", endpoint: "http://a.test/v1", apiKey: "k", chatModels: [{ id: "1", name, capabilities: ["default"], ...extra }], ...integrationExtra }] });
}

// ─── M2: output limits and reasoning models ─────────────────────────────────

const reasoningCandidate = (name, provider = "openai", extra = {}) => ({ integration: { provider }, model: name, ...extra });

test("known reasoning models get a deterministic margin for their reasoning on top of the requested limit", () => {
  assert.equal(engine.REASONING_OUTPUT_MARGIN, 12_000);
  const limit = engine.requestOutputLimit;
  for (const name of ["o1", "o3-mini", "o4-mini", "gpt-5", "gpt-5-mini", "openai/gpt-5", "codex-mini-latest"]) {
    assert.equal(limit({ maxOutputTokens: 1_520 }, reasoningCandidate(name)), 13_520, name);
  }
  for (const name of ["gpt-4o", "gpt-4.1", "qwen3-thinking", "deepseek-r1", "claude-sonnet", "o2-test", "gpt-50"]) {
    assert.equal(limit({ maxOutputTokens: 1_520 }, reasoningCandidate(name)), 1_520, `${name}: not known by name, unchanged`);
  }
  assert.equal(limit({ maxOutputTokens: 1_520 }, reasoningCandidate("deploy", "azure_openai", { underlyingModel: "o3-mini" })), 13_520, "Azure: the declared model decides");
  assert.equal(limit({ maxOutputTokens: 1_520 }, reasoningCandidate("deploy", "azure_openai", { underlyingModel: "gpt-4o" })), 1_520);
  assert.equal(limit({ maxOutputTokens: 1_520 }, reasoningCandidate("team-o3-mini", "azure_openai")), 13_520, "Azure: else the deployment name");
  assert.equal(limit({ maxOutputTokens: 1_520 }, reasoningCandidate("openai/o3-mini", "github_models")), 13_520);
});

test("the reasoning margin is capped by the model's own maximum, added to structured floors too, and absent without a requested limit", () => {
  const limit = engine.requestOutputLimit;
  assert.equal(limit({ maxOutputTokens: 1_520 }, reasoningCandidate("gpt-5", "openai", { maxOutputTokens: 8_000 })), 8_000);
  assert.equal(limit({ maxOutputTokens: 1_520 }, reasoningCandidate("gpt-5", "openai", { maxOutputTokens: 100_000 })), 13_520);
  assert.equal(limit({ json: SCHEMA, maxOutputTokens: 400 }, reasoningCandidate("gpt-5")), 4_096 + 12_000, "the structured floor, then the reasoning margin");
  assert.equal(limit({ json: SCHEMA, maxOutputTokens: 9_000 }, reasoningCandidate("gpt-5")), 21_000);
  assert.equal(limit({ json: SCHEMA, maxOutputTokens: 400 }, reasoningCandidate("gpt-4o")), 4_096, "the floor stays for normal models");
  assert.equal(limit({}, reasoningCandidate("gpt-5")), undefined, "no limit requested: none is invented");
  assert.equal(limit({}, reasoningCandidate("gpt-5", "openai", { maxOutputTokens: 8_000 })), 8_000);
  assert.equal(limit({ maxOutputTokens: 1_520 }, {}), 1_520, "a candidate of unknown identity is a normal model");
});

test("the output boost multiplies the effective limit, after the floor and the margin, up to the model's maximum", () => {
  const limit = engine.requestOutputLimit;
  assert.equal(limit({ maxOutputTokens: 1_520, outputBoost: 3 }, reasoningCandidate("qwen3")), 4_560);
  assert.equal(limit({ json: SCHEMA, maxOutputTokens: 400, outputBoost: 3 }, reasoningCandidate("qwen3")), 12_288);
  assert.equal(limit({ maxOutputTokens: 1_520, outputBoost: 3 }, reasoningCandidate("gpt-5")), 40_560);
  assert.equal(limit({ maxOutputTokens: 1_520, outputBoost: 3 }, reasoningCandidate("qwen3", "openai", { maxOutputTokens: 4_000 })), 4_000);
  assert.equal(limit({ maxOutputTokens: 1_520, outputBoost: 1 }, reasoningCandidate("qwen3")), 1_520);
  assert.equal(limit({ maxOutputTokens: 1_520, outputBoost: 0 }, reasoningCandidate("qwen3")), 1_520, "a boost below 1 is ignored");
});

test("a reasoning model's request carries the margin, a normal model's does not", async () => {
  const bodies = [];
  const fetch = async (_url, init) => (bodies.push(JSON.parse(init.body)), Response.json({ choices: [{ message: { content: "fine" }, finish_reason: "stop" }] }));
  await createFetchAi(model("gpt-5"), { fetch }).complete({ ...ASK, maxOutputTokens: 1_520 });
  await createFetchAi(model("gpt-4o"), { fetch }).complete({ ...ASK, maxOutputTokens: 1_520 });
  assert.equal(bodies[0].max_completion_tokens, 13_520);
  assert.equal(bodies[1].max_tokens, 1_520);
});

test("the reasoning margin is counted when the attempts are estimated against maxTokenAttempts", async () => {
  const cfg = (name) => ({ ...model(name), routingExecution: { maxTokenAttempts: 10_000 } });
  const ask = (name) => createFetchAi(cfg(name), { fetch: async () => Response.json({ choices: [{ message: { content: "fine" }, finish_reason: "stop" }] }) }).complete({ ...ASK, maxOutputTokens: 1_520 }).then((value) => value, (error) => error);
  assert.equal((await ask("gpt-4o")).text, "fine", "about 1500 tokens fit 10000");
  const refused = await ask("gpt-5");
  assert.ok(refused instanceof engine.AiRoutingBudgetError, "13520 tokens with the margin do not");
});

test("a reply cut while the model had only reasoned is marked, and still not retryable by the client", async () => {
  const plain = (choice) => async () => Response.json({ choices: [choice], usage: { prompt_tokens: 50, completion_tokens: 1_520 } });
  const reasoned = await createFetchAi(model("qwen3-thinking"), { fetch: plain({ message: { content: "", reasoning_content: "thinking ".repeat(100) }, finish_reason: "length" }) }).complete(ASK).then(() => null, (error) => error);
  assert.equal(reasoned.truncated, true);
  assert.equal(reasoned.reasoningOnly, true);
  assert.equal(reasoned.retryable, false);
  const inline = await createFetchAi(model("qwen3-thinking"), { fetch: plain({ message: { content: "<think>still going" }, finish_reason: "length" }) }).complete(ASK).then(() => null, (error) => error);
  assert.equal(inline.reasoningOnly, true);
  const headless = await createFetchAi(model("qwen3-thinking"), { fetch: plain({ message: { content: "thinking out loud</think>" }, finish_reason: "length" }) }).complete(ASK).then(() => null, (error) => error);
  assert.equal(headless.reasoningOnly, true);
  const partial = await createFetchAi(model("qwen3-thinking"), { fetch: plain({ message: { content: "Half a scene", reasoning_content: "some thought" }, finish_reason: "length" }) }).complete(ASK).then(() => null, (error) => error);
  assert.equal(partial.truncated, true);
  assert.equal(partial.reasoningOnly, undefined, "a reply that started is an ordinary cut");
  const streamed = await createFetchAi(model("qwen3-thinking"), { fetch: async () => events([reasoning("Let me think"), finish("length"), DONE]) }).complete({ ...ASK, onText: () => undefined }).then(() => null, (error) => error);
  assert.equal(streamed.reasoningOnly, true);
});

const FAST = { readers: false, readersOnPlan: false, pauseAfterPlan: false };
const ONE_SCENE = { brief: { idea: "x", targetChapters: 1, scenesPerChapter: 1, wordsPerScene: 300 }, options: FAST };

/** A fake OpenAI-compatible provider answering with what the engine's fake AI answers; `respond` may take a request over. */
function provider(fake, options = {}) {
  const requests = [];
  const fetch = async (url, init) => {
    const body = JSON.parse(init.body);
    requests.push({ url: String(url), body });
    const custom = options.respond?.(body, requests);
    if (custom) return custom;
    const tool = body.tools?.[0]?.function;
    const answer = await fake.complete({ capability: "autopilot", label: "provider", system: body.messages[0].content, user: body.messages[1].content, json: tool });
    const usage = options.usage === false ? undefined : { prompt_tokens: 100, completion_tokens: 50 };
    if (tool) return Response.json({ choices: [{ message: { content: null, tool_calls: [{ function: { arguments: JSON.stringify(answer.json) } }] }, finish_reason: "tool_calls" }], ...(usage ? { usage } : {}) });
    if (body.stream) return events([content(answer.text), finish("stop"), ...(usage ? [usageChunk(usage.prompt_tokens, usage.completion_tokens)] : []), DONE]);
    return Response.json({ choices: [{ message: { content: answer.text }, finish_reason: "stop" }], ...(usage ? { usage } : {}) });
  };
  return { fetch, requests };
}

const isProse = (body) => !body.tools && /ghostwriter/.test(body.messages[0].content);
const limitOf = (body) => body.max_tokens ?? body.max_completion_tokens;

async function runOver(host, cfg, start, extra = {}) {
  const store = new MemoryBookStore(seedBookFiles({ chapters: 1 }));
  const emitted = [];
  const session = new AutopilotSession({ bookId: "book", store, ai: createFetchAi(cfg, { fetch: host.fetch }), host: "server", hostLabel: "test", retryDelayMs: 0, ...extra });
  session.subscribe((event) => emitted.push(event));
  await session.start(start);
  await session.waitForIdle();
  return { state: (await session.snapshot()).state, events: emitted, store };
}

test("a thinking model that spends its whole limit reasoning is retried once with a limit three times larger, remembered for the run", async () => {
  const fake = createFakeAutopilotAi();
  let truncated = 0;
  const host = provider(fake, {
    respond: (body) => {
      if (!isProse(body) || truncated > 0) return undefined;
      truncated += 1;
      return events([reasoning("Let me think about the scene. ".repeat(50)), finish("length"), usageChunk(2_000, 1_520), DONE]);
    },
  });
  const cfg = model("qwen3-thinking");
  const { state, events: emitted } = await runOver(host, cfg, { brief: { idea: "x", targetChapters: 1, scenesPerChapter: 2, wordsPerScene: 300 }, options: FAST });
  assert.equal(state.status, "completed", state.lastError?.message);
  const prose = host.requests.filter((request) => isProse(request.body));
  const base = Math.min(16_000, Math.ceil(300 * 2.4) + 800);
  assert.equal(limitOf(prose[0].body), base);
  assert.equal(limitOf(prose[1].body), base * 3, "the retry of the same scene");
  assert.equal(limitOf(prose[2].body), base * 3, "the next scene starts with the larger limit: it is remembered for the run");
  const retry = emitted.find((event) => event.type === "insight" && event.code === "failureRetry");
  assert.ok(retry, "announced");
  assert.match(retry.title, /larger|3/i);
  assert.equal(state.stats.failures, 0);
  assert.ok(state.stats.outputTokens >= 1_520, "the cut attempt's tokens are counted");
});

test("the larger limit is tried once: a second reasoning-only cut ends the step", async () => {
  const fake = createFakeAutopilotAi();
  const host = provider(fake, { respond: (body) => isProse(body) ? events([reasoning("hmm ".repeat(200)), finish("length"), DONE]) : undefined });
  const { state } = await runOver(host, model("qwen3-thinking"), ONE_SCENE);
  assert.equal(state.status, "error");
  assert.match(state.lastError.message, /used its output limit while reasoning/);
  assert.equal(host.requests.filter((request) => isProse(request.body)).length, 2, "the first try and the boosted retry, no more");
});

test("a cut that already had the model's own maximum is not retried: asking for more cannot help", async () => {
  const fake = createFakeAutopilotAi();
  const base = Math.min(16_000, Math.ceil(300 * 2.4) + 800);
  const host = provider(fake, { respond: (body) => isProse(body) ? events([reasoning("hmm ".repeat(200)), finish("length"), DONE]) : undefined });
  const { state } = await runOver(host, model("qwen3-thinking", { maxOutputTokens: base }), ONE_SCENE);
  assert.equal(state.status, "error");
  assert.match(state.lastError.message, /used its output limit while reasoning/);
  assert.equal(host.requests.filter((request) => isProse(request.body)).length, 1, "the request already asked for the maximum");
  const error = await createFetchAi(model("qwen3-thinking", { maxOutputTokens: 2_000 }), { fetch: async () => Response.json({ choices: [{ message: { content: "", reasoning_content: "x".repeat(300) }, finish_reason: "length" }] }) }).complete({ ...ASK, maxOutputTokens: 1_000 }).then(() => null, (failure) => failure);
  assert.equal(error.reasoningOnly, true);
  assert.equal(error.limitReached, undefined, "there was room to ask for more");
});

test("any other cut reply stays final: it is not retried", async () => {
  const fake = createFakeAutopilotAi();
  const host = provider(fake, { respond: (body) => isProse(body) ? events([content("Half a scene that just stops "), finish("length"), DONE]) : undefined });
  const { state, events: emitted } = await runOver(host, model("qwen3-thinking"), ONE_SCENE);
  assert.equal(state.status, "error");
  assert.match(state.lastError.message, /cut by the output token limit/);
  assert.equal(host.requests.filter((request) => isProse(request.body)).length, 1);
  assert.ok(!emitted.some((event) => event.type === "insight" && event.code === "failureRetry"));
});

test("a structured reply cut while reasoning is retried with the boosted limit too", async () => {
  const fake = createFakeAutopilotAi();
  let cut = 0;
  const host = provider(fake, {
    respond: (body) => {
      if (body.tools?.[0]?.function.name !== "book_concept" || cut > 0) return undefined;
      cut += 1;
      return Response.json({ choices: [{ message: { content: "", reasoning_content: "x".repeat(4000) }, finish_reason: "length" }], usage: { prompt_tokens: 500, completion_tokens: 4_096 } });
    },
  });
  const { state } = await runOver(host, model("deepseek-r1"), ONE_SCENE);
  assert.equal(state.status, "completed", state.lastError?.message);
  const concepts = host.requests.filter((request) => request.body.tools?.[0]?.function.name === "book_concept");
  assert.equal(limitOf(concepts[0].body), 9_000);
  assert.equal(limitOf(concepts[1].body), 27_000);
});

// ─── M5: budget accounting ──────────────────────────────────────────────────

test("cached tokens cost like normal input when no cached price is set", () => {
  const usage = { inputTokens: 1_000, outputTokens: 0, cachedInputTokens: 400 };
  assert.equal(estimateCost(usage, { inputPerMTok: 2 }), 1_000 / 1_000_000 * 2, "no cached price: 600 billed + 400 cached, both at the input price");
  assert.equal(estimateCost(usage, { inputPerMTok: 2, cachedPerMTok: 0.5 }), (600 * 2 + 400 * 0.5) / 1_000_000);
  assert.equal(estimateCost(usage, { inputPerMTok: 2, cachedPerMTok: 0 }), (600 * 2) / 1_000_000, "an explicit zero is a free cache");
  assert.equal(estimateCost(usage, undefined), undefined);
  assert.equal(estimateCost(undefined, { inputPerMTok: 2 }), undefined);
});

test("a reply without usage is estimated and flagged, never counted as zero", async () => {
  const noUsage = (text = "A reply of some length, enough to count.") => async () => Response.json({ choices: [{ message: { content: text }, finish_reason: "stop" }] });
  const priced = { pricing: { inputPerMTok: 1, outputPerMTok: 2 } };
  const response = await createFetchAi(model("m", priced), { fetch: noUsage() }).complete({ ...ASK, user: "x".repeat(4_000) });
  assert.equal(response.usageKnown, false);
  assert.equal(response.costKnown, false, "an estimated cost is not a measured one");
  assert.ok(response.usage.inputTokens >= 1_000 && response.usage.inputTokens < 1_100, `input estimated from the prompt: ${response.usage.inputTokens}`);
  assert.ok(response.usage.outputTokens > 0 && response.usage.outputTokens < 30);
  assert.ok(response.cost > 0, "the estimate keeps budgets moving");

  const free = await createFetchAi(model("m"), { fetch: noUsage() }).complete(ASK);
  assert.equal(free.usageKnown, false);
  assert.equal(free.costKnown, false);
  assert.equal(free.cost, undefined, "no price, no cost");
  assert.ok(free.usage.inputTokens > 0, "but the tokens are still estimated");

  const measured = await createFetchAi(model("m", priced), { fetch: async () => Response.json({ choices: [{ message: { content: "ok" }, finish_reason: "stop" }], usage: { prompt_tokens: 100, completion_tokens: 10 } }) }).complete(ASK);
  assert.equal(measured.usageKnown, true);
  assert.equal(measured.costKnown, true);
  assert.equal(measured.cost, (100 * 1 + 10 * 2) / 1_000_000);

  const unpriced = await createFetchAi(model("m"), { fetch: async () => Response.json({ choices: [{ message: { content: "ok" }, finish_reason: "stop" }], usage: { prompt_tokens: 100, completion_tokens: 10 } }) }).complete(ASK);
  assert.equal(unpriced.usageKnown, true);
  assert.equal(unpriced.costKnown, false, "usage reported but the model has no price");
  assert.equal(unpriced.cost, undefined);
  assert.deepEqual(unpriced.usage, { inputTokens: 100, outputTokens: 10, cachedInputTokens: 0 });
});

test("a streamed reply without a usage chunk is estimated too, and so is a failed attempt that got as far as a reply", async () => {
  const streamed = await createFetchAi(model("m", { pricing: { inputPerMTok: 1, outputPerMTok: 2 } }), { fetch: async () => events([content("Some streamed text."), finish("stop"), DONE]) }).complete({ ...ASK, onText: () => undefined });
  assert.equal(streamed.usageKnown, false);
  assert.ok(streamed.usage.outputTokens > 0);

  const cut = await createFetchAi(model("m", { pricing: { inputPerMTok: 1, outputPerMTok: 2 } }), { fetch: async () => Response.json({ choices: [{ message: { content: "Half a scene" }, finish_reason: "length" }] }) }).complete({ ...ASK, user: "x".repeat(4_000) }).then(() => null, (error) => error);
  assert.equal(cut.truncated, true);
  assert.equal(cut.usageKnown, false);
  assert.ok(cut.usage.inputTokens >= 1_000, "the provider read the prompt: it counts");
  assert.ok(cut.cost > 0);

  const refused = await createFetchAi(model("m"), { fetch: async () => new Response("{}", { status: 500 }) }).complete(ASK).then(() => null, (error) => error);
  assert.equal(refused.usage, undefined, "an HTTP error never reached the model: nothing is counted");
});

test("what fallbacks cost keeps its flags: one unknown attempt makes the total unknown", async () => {
  const cfg = pickAiRuntimeConfig({ aiIntegrations: [
    { id: "a", name: "A", provider: "openai", endpoint: "http://a.test/v1", apiKey: "k", chatModels: [{ id: "1", name: "first", capabilities: ["default"], pricing: { inputPerMTok: 1 } }] },
    { id: "b", name: "B", provider: "openai", endpoint: "http://b.test/v1", apiKey: "k", chatModels: [{ id: "2", name: "second", capabilities: ["default"], pricing: { inputPerMTok: 1 } }] },
  ] });
  const fetch = async (url) => String(url).includes("a.test")
    ? Response.json({ choices: [{ message: { content: "x" }, finish_reason: "length" }] })
    : Response.json({ choices: [{ message: { content: "answer" }, finish_reason: "stop" }], usage: { prompt_tokens: 50, completion_tokens: 5 } });
  const response = await createFetchAi(cfg, { fetch }).complete({ ...ASK, user: "x".repeat(400) });
  assert.equal(response.text, "answer");
  assert.equal(response.usageKnown, false, "the first attempt's usage was estimated");
  assert.ok(response.usage.inputTokens > 50);
});

/** The engine's fake AI with `usageKnown`/`costKnown` flags on every reply. */
function flagged(flags, options = {}) {
  const base = createFakeAutopilotAi(options);
  return {
    calls: base.calls,
    async complete(request) {
      const response = await base.complete(request);
      return { ...response, ...flags(request) };
    },
  };
}

async function runWith(ai, start, extra = {}, files = seedBookFiles({ chapters: 1 })) {
  const store = new MemoryBookStore(files);
  const emitted = [];
  const session = new AutopilotSession({ bookId: "book", store, ai, host: "server", hostLabel: "test", retryDelayMs: 0, ...extra });
  session.subscribe((event) => emitted.push(event));
  await session.start(start);
  await session.waitForIdle();
  return { state: (await session.snapshot()).state, events: emitted, store, session };
}

test("calls that cannot be measured are counted in the statistics and saved with the state", async () => {
  const ai = flagged((request) => request.label === "autopilot:concept" ? { usageKnown: false, costKnown: false } : request.label === "autopilot:plan" ? { usageKnown: true, costKnown: false } : {}, {});
  const { state, store } = await runWith(ai, ONE_SCENE);
  assert.equal(state.status, "completed");
  assert.equal(state.stats.usageUnknownCalls, 1);
  assert.equal(state.stats.costUnknownCalls, 2);
  const saved = parseAutopilotState(store.files.get("autopilot/state.json"));
  assert.equal(saved.stats.usageUnknownCalls, 1);
  assert.equal(saved.stats.costUnknownCalls, 2);

  const clean = await runWith(createFakeAutopilotAi(), ONE_SCENE);
  assert.equal(clean.state.stats.usageUnknownCalls, undefined, "a run that measures everything leaves the fields out");
  assert.equal("costUnknownCalls" in clean.state.stats, false);
});

test("a state saved before these fields existed loads and keeps running", async () => {
  const old = JSON.parse(JSON.stringify(engine.createAutopilotState(new Date())));
  old.stats = { tasks: 2, aiCalls: 3, inputTokens: 10, outputTokens: 5, cost: 0.01, failures: 0 };
  delete old.options.budgetTokens;
  const state = parseAutopilotState(JSON.stringify(old));
  assert.equal(state.stats.usageUnknownCalls, undefined);
  assert.equal(state.options.budgetTokens ?? 0, 0);
  const ai = flagged((request) => request.label === "autopilot:plan" ? { costKnown: false } : {});
  const store = new MemoryBookStore({ ...seedBookFiles({ chapters: 1 }), "autopilot/state.json": JSON.stringify({ ...old, status: "paused" }) });
  const session = new AutopilotSession({ bookId: "book", store, ai, host: "server", hostLabel: "test", retryDelayMs: 0 });
  await session.start(ONE_SCENE);
  await session.waitForIdle();
  const resumed = (await session.snapshot()).state;
  assert.equal(resumed.status, "completed");
  assert.equal(resumed.stats.costUnknownCalls, 1);
  assert.ok(resumed.stats.aiCalls > 3, "the counters carry on from the saved ones");
  assert.ok(Number.isFinite(resumed.stats.cost));
});

test("one warning per run says the money budget cannot apply to a model without a price", async () => {
  const unpriced = () => ({ costKnown: false, cost: undefined, model: "local-qwen" });
  const ai = flagged(unpriced);
  const withBudget = await runWith(ai, { ...ONE_SCENE, options: { ...FAST, budgetLimit: 5 } });
  const warnings = withBudget.events.filter((event) => event.type === "insight" && event.code === "budgetNotApplicable");
  assert.equal(warnings.length, 1, "one per run, not one per call");
  assert.equal(warnings[0].tone, "warning");
  assert.match(warnings[0].title, /local-qwen/);
  assert.match(warnings[0].title, /no price/i);
  assert.match(warnings[0].detail, /token budget/i, "and says what to use instead");
  assert.ok(warnings[0].activityId);

  const without = await runWith(flagged(unpriced), ONE_SCENE);
  assert.equal(without.events.filter((event) => event.code === "budgetNotApplicable").length, 0, "no money budget, nothing to warn about");

  const priced = await runWith(flagged(() => ({ costKnown: true })), { ...ONE_SCENE, options: { ...FAST, budgetLimit: 5 } });
  assert.equal(priced.events.filter((event) => event.code === "budgetNotApplicable").length, 0);

  const estimated = await runWith(flagged(() => ({ costKnown: false, usageKnown: false })), { ...ONE_SCENE, options: { ...FAST, budgetLimit: 5 } });
  assert.equal(estimated.events.filter((event) => event.code === "budgetNotApplicable").length, 0, "a model with a price and estimated tokens is a different case: the budget still applies to the estimate");

  const again = await runWith(flagged(unpriced), { ...ONE_SCENE, options: { ...FAST, budgetLimit: 5 } });
  assert.equal(again.events.filter((event) => event.code === "budgetNotApplicable").length, 1, "a new run warns again");
});

test("the warning is in the book's language", async () => {
  const files = seedBookFiles({ chapters: 1, language: "it" });
  const ai = flagged(() => ({ costKnown: false, cost: undefined, model: "locale" }));
  const { events: emitted } = await runWith(ai, { ...ONE_SCENE, options: { ...FAST, budgetLimit: 5 } }, {}, files);
  const warning = emitted.find((event) => event.code === "budgetNotApplicable");
  assert.match(warning.title, /budget in denaro non è applicabile/);
  assert.match(warning.title, /locale/);
});

test("budgetTokens stops the run when the tokens used reach it, and 0 turns it off", async () => {
  const limited = await runWith(createFakeAutopilotAi(), { ...ONE_SCENE, options: { ...FAST, budgetTokens: 450 } });
  assert.equal(limited.state.status, "paused");
  assert.match(limited.state.message, /Token budget reached/);
  assert.equal(limited.state.stats.aiCalls, 3, "100 + 50 tokens per call: the third call reaches 450");
  assert.equal(limited.state.options.budgetTokens, 450);

  const off = await runWith(createFakeAutopilotAi(), { ...ONE_SCENE, options: { ...FAST, budgetTokens: 0 } });
  assert.equal(off.state.status, "completed");

  const resumed = await limited.session.configure({ options: { budgetTokens: 100_000 } });
  assert.equal(resumed.options.budgetTokens, 100_000);
  await limited.session.start();
  await limited.session.waitForIdle();
  assert.equal((await limited.session.snapshot()).state.status, "completed");

  const italian = await runWith(createFakeAutopilotAi(), { ...ONE_SCENE, options: { ...FAST, budgetTokens: 450 } }, {}, seedBookFiles({ chapters: 1, language: "it" }));
  assert.match(italian.state.message, /Budget di token raggiunto/);
});

test("the money budget and the token budget are independent limits, either one stops the run", async () => {
  const money = await runWith(createFakeAutopilotAi(), { ...ONE_SCENE, options: { ...FAST, budgetLimit: 0.0035, budgetTokens: 1_000_000 } });
  assert.equal(money.state.status, "paused");
  assert.match(money.state.message, /Budget reached/);
});

test("tokens estimated for a provider that reports none still count toward budgetTokens", async () => {
  const host = provider(createFakeAutopilotAi(), { usage: false });
  const { state } = await runOver(host, model("local-model"), { ...ONE_SCENE, options: { ...FAST, budgetTokens: 3_000 } });
  assert.equal(state.status, "paused");
  assert.match(state.message, /Token budget reached/);
  assert.ok(state.stats.inputTokens + state.stats.outputTokens >= 3_000);
  assert.ok(state.stats.usageUnknownCalls >= 1);
  assert.equal(state.stats.costUnknownCalls, state.stats.aiCalls, "no price on any call");
});

test("a failed attempt's estimated tokens are counted too", async () => {
  const failing = { calls: [], async complete() { throw new AiProviderError("cut", undefined, false, { truncated: true, usage: { inputTokens: 900, outputTokens: 100, cachedInputTokens: 0 }, usageKnown: false, costKnown: false, model: "m" }); } };
  const { state } = await runWith(failing, ONE_SCENE);
  assert.equal(state.status, "error");
  assert.equal(state.stats.inputTokens, 900);
  assert.equal(state.stats.usageUnknownCalls, 1);
  assert.equal(state.stats.costUnknownCalls, 1);
});
