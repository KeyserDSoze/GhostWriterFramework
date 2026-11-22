import test from "node:test";
import assert from "node:assert/strict";
import * as engine from "../dist/index.js";
import { MemoryBookStore, seedBookFiles } from "../dist/testing/index.js";
import { ASK, DONE, JSON_ASK, call, content, finish, integration, recording, sse, usage } from "./transport-fakes.mjs";

const { AiProviderError, AiReplyRejectedError, AutopilotSession, classifyAutopilotError, createFetchAi, parseAutopilotState, pickAiRuntimeConfig, redactAiRuntimeConfig } = engine;

// ─── Fixtures ───────────────────────────────────────────────────────────────

/** Two integrations in route order: Alpha (the primary) and Beta (the fallback), each with one model. */
function twoModels({ primary = {}, fallback = {}, ...config } = {}) {
  return {
    aiIntegrations: [
      integration({ id: "a", name: "Alpha", endpoint: "http://a.test/v1", chatModels: [{ id: "a1", name: "alpha-model", capabilities: ["default"], ...primary }] }),
      integration({ id: "b", name: "Beta", endpoint: "http://b.test/v1", chatModels: [{ id: "b1", name: "beta-model", capabilities: ["default"], ...fallback }] }),
    ],
    ...config,
  };
}

const NO_TOOLS = { supportsToolCalls: false };
const answer = (value, name = "result") => Response.json({ choices: [{ message: { tool_calls: [{ function: { name, arguments: JSON.stringify(value) } }] }, finish_reason: "tool_calls" }] });
const text = (value) => Response.json({ choices: [{ message: { content: value }, finish_reason: "stop" }] });
const failing = (status, message) => new Response(JSON.stringify({ error: { message } }), { status, headers: { "content-type": "application/json" } });
const hostOf = (entry) => new URL(entry.url).hostname.replace(".test", "");
/** A fetch that answers as `handlers[host](entry)` says: `a` is the primary, `b` the fallback. */
const byHost = (handlers) => recording((entry) => handlers[hostOf(entry)](entry));

// ─── The setting and its default ────────────────────────────────────────────

test("Tools only is on by default: nothing in the configuration says it, and the client behaves as if it did", async () => {
  const picked = pickAiRuntimeConfig({ aiIntegrations: [integration()] });
  assert.equal("toolsOnly" in picked, false, "a configuration of an older host carries no such key");
  assert.equal(redactAiRuntimeConfig(picked).toolsOnly, true, "and the safe view says what is in force");
  const { fetch, calls } = recording(() => answer({ ok: true }));
  const error = await createFetchAi({ aiIntegrations: [integration({ chatModels: [{ id: "m", name: "plain", capabilities: ["default"], ...NO_TOOLS }] })] }, { fetch }).complete(JSON_ASK).then(() => null, (failure) => failure);
  assert.ok(error instanceof engine.AiToolsRequiredError, "a model marked as without tool calls is not used for a structured reply");
  assert.equal(calls.length, 0);
});

test("pickAiRuntimeConfig reads the switch from the settings (aiToolsOnly) and from an already picked configuration (toolsOnly), ignoring what is not a boolean", () => {
  const pick = (extra) => pickAiRuntimeConfig({ aiIntegrations: [integration()], ...extra });
  assert.equal(pick({ aiToolsOnly: false }).toolsOnly, false);
  assert.equal(pick({ aiToolsOnly: true }).toolsOnly, true);
  assert.equal(pick({ toolsOnly: false }).toolsOnly, false, "the personal server stores and reads back a picked configuration, which says toolsOnly");
  assert.equal(pick({ toolsOnly: true }).toolsOnly, true);
  assert.equal(pick({ aiToolsOnly: false, toolsOnly: true }).toolsOnly, false, "the settings' own word wins");
  for (const garbage of ["false", "yes", 0, 1, null, {}, []]) {
    assert.equal("toolsOnly" in pick({ aiToolsOnly: garbage }), false, `aiToolsOnly ${JSON.stringify(garbage)} is ignored`);
    assert.equal("toolsOnly" in pick({ toolsOnly: garbage }), false, `toolsOnly ${JSON.stringify(garbage)} is ignored`);
  }
  assert.equal(pick({ aiToolsOnly: "false", toolsOnly: false }).toolsOnly, false, "an invalid settings value does not hide a valid picked one");
  const off = pick({ aiToolsOnly: false });
  assert.deepEqual(pickAiRuntimeConfig(JSON.parse(JSON.stringify(off))), off, "picking again changes nothing: what a server saves is what it reads");
  assert.equal(redactAiRuntimeConfig(off).toolsOnly, false);
  assert.equal(JSON.stringify(redactAiRuntimeConfig(off)).includes("sk-test-SECRET"), false);
});

// ─── (a) The models that cannot call a function are skipped ─────────────────

test("(a) a fallback marked as without tool calls is skipped: no request goes to it, and the attempt says so", async () => {
  const attempts = [];
  const { fetch, calls } = byHost({ a: () => answer({ ok: true }), b: () => answer({ ok: false }) });
  const response = await createFetchAi(twoModels({ fallback: NO_TOOLS }), { fetch, onAttempt: (attempt) => attempts.push(attempt) }).complete(JSON_ASK);
  assert.deepEqual(response.json, { ok: true });
  assert.deepEqual(calls.map(hostOf), ["a"]);
  assert.deepEqual(attempts[0].skipped, [{ model: "beta-model", reason: "no-tool-calls" }]);
  assert.equal(attempts[0].toolsOnly, true);
});

test("(a) when the primary fails the skipped fallback is still not asked, and the error says it was left out and why", async () => {
  const { fetch, calls } = byHost({ a: () => failing(500, "primary down"), b: () => answer({ ok: true }) });
  const error = await createFetchAi(twoModels({ fallback: NO_TOOLS }), { fetch }).complete(JSON_ASK).then(() => null, (failure) => failure);
  assert.ok(error instanceof AiProviderError);
  assert.deepEqual(calls.map(hostOf), ["a"], "nothing was sent to the fallback that cannot call a function");
  assert.match(error.message, /primary down/);
  assert.match(error.message, /Skipped "beta-model" in "Beta": it is marked as without tool calls and "Tools only" is on\./);
});

test("(a) a primary without tool calls is skipped too, and the fallback answers as the attempt that has the route's second place", async () => {
  const attempts = [];
  const { fetch, calls } = byHost({ a: () => answer({ ok: false }), b: () => answer({ ok: true }) });
  const response = await createFetchAi(twoModels({ primary: NO_TOOLS }), { fetch, onAttempt: (attempt) => attempts.push(attempt) }).complete(JSON_ASK);
  assert.deepEqual(response.json, { ok: true });
  assert.deepEqual(calls.map(hostOf), ["b"]);
  assert.equal(attempts.length, 1);
  assert.equal(attempts[0].index, 1, "the index is the candidate's place in the route");
  assert.equal(attempts[0].model, "beta-model");
  assert.deepEqual(attempts[0].skipped, [{ model: "alpha-model", reason: "no-tool-calls" }]);
});

test("(a) when no model can call a function nothing is sent: a final error names the models and the two remedies, and its kind is config", async () => {
  const attempts = [];
  const { fetch, calls } = byHost({ a: () => answer({ ok: true }), b: () => answer({ ok: true }) });
  const error = await createFetchAi(twoModels({ primary: NO_TOOLS, fallback: NO_TOOLS }), { fetch, onAttempt: (attempt) => attempts.push(attempt) }).complete(JSON_ASK).then(() => null, (failure) => failure);
  assert.equal(typeof engine.AiToolsRequiredError, "function", "exported");
  assert.ok(error instanceof engine.AiToolsRequiredError, String(error));
  assert.ok(error instanceof AiProviderError);
  assert.equal(error.name, "AiToolsRequiredError");
  assert.equal(error.retryable, false, "the same configuration would end the same way");
  assert.deepEqual(error.models, ["alpha-model", "beta-model"]);
  assert.match(error.message, /"alpha-model" in "Alpha"/);
  assert.match(error.message, /"beta-model" in "Beta"/);
  assert.match(error.message, /Turn on "Forced tool calls" for the model in AI Integrations/);
  assert.match(error.message, /turn off "Tools only" in the AI Router/);
  assert.match(error.message, /Nothing was sent/);
  assert.equal(calls.length, 0);
  assert.equal(attempts.length, 0, "no attempt was made");
  assert.deepEqual(classifyAutopilotError(error), { kind: "config", detail: {} });
});

test("(a) only the models of this call are named, and a request without a function (prose) uses a model without tool calls as it always did", async () => {
  const prose = byHost({ a: () => text("A scene."), b: () => text("Never.") });
  const attempts = [];
  const response = await createFetchAi(twoModels({ primary: NO_TOOLS, fallback: NO_TOOLS }), { fetch: prose.fetch, onAttempt: (attempt) => attempts.push(attempt) }).complete(ASK);
  assert.equal(response.text, "A scene.");
  assert.deepEqual(prose.calls.map(hostOf), ["a"]);
  assert.equal("skipped" in attempts[0], false, "nothing was skipped for prose");
});

test("(a) the privacy policy still anchors on the primary when the primary is the one that is skipped", async () => {
  const cfg = twoModels({ primary: NO_TOOLS, fallbackDisclosure: { sameBoundaryOnly: true, requireAcknowledgement: false } });
  const { fetch, calls } = byHost({ a: () => answer({ ok: false }), b: () => answer({ ok: true }) });
  const error = await createFetchAi(cfg, { fetch }).complete(JSON_ASK).then(() => null, (failure) => failure);
  assert.ok(error instanceof AiProviderError);
  assert.equal(calls.length, 0, "Beta is in another account than the primary: it is not a fallback of the primary, tools or not");
});

test("(a) planAttempts says what it left out: the skipped candidates with their place in the route, while the primary stays the route's first", () => {
  const cfg = twoModels({ primary: NO_TOOLS });
  const plan = engine.planAttempts(cfg, JSON_ASK);
  assert.deepEqual(plan.attempts.map((attempt) => [attempt.candidate.model, attempt.index]), [["beta-model", 1]]);
  assert.deepEqual(plan.skipped.map((entry) => [entry.candidate.model, entry.index, entry.reason]), [["alpha-model", 0, "no-tool-calls"]]);
  assert.equal(plan.primary.model, "alpha-model", "the account that content is meant to stay in is still the route's first");
  assert.equal(plan.excludedByBoundary, 0, "what the privacy policy leaves out is counted apart");
  const prose = engine.planAttempts(cfg, ASK);
  assert.deepEqual(prose.skipped, [], "a request without a function skips nothing");
  assert.equal(prose.attempts.length, 2);
  assert.deepEqual(engine.planAttempts({ ...cfg, toolsOnly: false }, JSON_ASK).skipped, [], "and neither does a configuration with Tools only off");
});

test("(a) a model whose tool calls were never declared counts as able to call: only an explicit false skips", async () => {
  const { fetch, calls } = byHost({ a: () => answer({ ok: true }), b: () => answer({ ok: true }) });
  for (const supportsToolCalls of [undefined, true]) {
    const response = await createFetchAi(twoModels({ primary: { supportsToolCalls } }), { fetch }).complete(JSON_ASK);
    assert.deepEqual(response.json, { ok: true });
  }
  assert.deepEqual(calls.map(hostOf), ["a", "a"]);
});

test("(a) no key ends up in what Tools only says, even when a name holds it: the error, its models and the note of a skipped fallback are redacted", async () => {
  const key = "sk-test-SECRET-0123456789";
  const alone = { aiIntegrations: [integration({ id: "a", name: `Alpha ${key}`, endpoint: "http://a.test/v1", chatModels: [{ id: "a1", name: `model ${key}`, capabilities: ["default"], ...NO_TOOLS }] })] };
  const error = await createFetchAi(alone, { fetch: async () => answer({ ok: true }) }).complete(JSON_ASK).then(() => null, (failure) => failure);
  assert.ok(error instanceof engine.AiToolsRequiredError);
  assert.equal(JSON.stringify([error.message, error.models]).includes(key), false);
  const noted = { aiIntegrations: [integration({ id: "a", name: "Alpha", endpoint: "http://a.test/v1" }), integration({ id: "b", name: `Beta ${key}`, endpoint: "http://b.test/v1", chatModels: [{ id: "b1", name: "beta-model", capabilities: ["default"], ...NO_TOOLS }] })] };
  const failed = await createFetchAi(noted, { fetch: async () => failing(500, "down") }).complete(JSON_ASK).then(() => null, (failure) => failure);
  assert.equal(failed.message.includes(key), false);
  assert.match(failed.message, /Skipped "beta-model" in "Beta /);
});

// ─── (b) The answer must be a function call ─────────────────────────────────

test("(b) a reply in text is rejected, never read, and the next candidate is tried", async () => {
  const ends = [];
  const { fetch, calls } = byHost({ a: () => text(JSON.stringify({ ok: true })), b: () => answer({ ok: false }) });
  const response = await createFetchAi(twoModels(), { fetch, onAttemptEnd: (end) => ends.push(end) }).complete(JSON_ASK);
  assert.deepEqual(response.json, { ok: false }, "the second candidate's call, not the first one's text, which was perfectly valid JSON");
  assert.deepEqual(calls.map(hostOf), ["a", "b"]);
  assert.equal(ends[0].outcome, "failed");
  assert.match(ends[0].error, /answered in text instead of calling the function "result"/);
  assert.equal(ends[0].toolCalled, false);
  assert.equal(ends[1].outcome, "ok");
  assert.equal(ends[1].toolCalled, true);
});

test("(b) the rejection is a retryable reply error that says why and what to do, and it keeps what the attempt cost", async () => {
  const { fetch } = recording(() => Response.json({ choices: [{ message: { content: JSON.stringify({ ok: true }) }, finish_reason: "stop" }], usage: { prompt_tokens: 90, completion_tokens: 12 } }));
  const error = await createFetchAi({ aiIntegrations: [integration()] }, { fetch }).complete(JSON_ASK).then(() => null, (failure) => failure);
  assert.ok(error instanceof AiReplyRejectedError, String(error));
  assert.equal(error.retryable, true);
  assert.match(error.message, /^openai muse-glimmer-30b: the model answered in text instead of calling the function "result": "Tools only" is on/);
  assert.match(error.message, /turn off "Tools only" in the AI Router/i);
  assert.deepEqual(error.usage, { inputTokens: 90, outputTokens: 12, cachedInputTokens: 0 });
  assert.equal(classifyAutopilotError(error).kind, "provider");
});

test("(b) the arguments of the call are used, also when the text next to them says something else, and the text is never read as a fallback", async () => {
  const withText = await createFetchAi({ aiIntegrations: [integration()] }, { fetch: async () => Response.json({ choices: [{ message: { content: "Sure!", tool_calls: [{ function: { name: "result", arguments: JSON.stringify({ ok: true }) } }] }, finish_reason: "stop" }] }) }).complete(JSON_ASK);
  assert.deepEqual(withText.json, { ok: true });

  const wrongFields = await createFetchAi({ aiIntegrations: [integration()] }, { fetch: async () => Response.json({ choices: [{ message: { content: JSON.stringify({ ok: true }), tool_calls: [{ function: { name: "result", arguments: "{\"summary\":\"only a summary\"}" } }] }, finish_reason: "stop" }] }) }).complete(JSON_ASK).then(() => null, (failure) => failure);
  assert.ok(wrongFields instanceof AiReplyRejectedError);
  assert.match(wrongFields.message, /none of the expected fields/, "the JSON in the text would have been the answer: it is not looked at");

  const empty = await createFetchAi({ aiIntegrations: [integration()] }, { fetch: async () => Response.json({ choices: [{ message: { content: JSON.stringify({ ok: true }), tool_calls: [{ function: { name: "result", arguments: "{}" } }] }, finish_reason: "stop" }] }) }).complete(JSON_ASK).then(() => null, (failure) => failure);
  assert.ok(empty instanceof AiReplyRejectedError);
  assert.match(empty.message, /empty arguments/, "empty arguments are rejected as they always were, and the text does not make up for them");
});

test("(b) a reply that arrives as a stream follows the same rules: pieces of a call are the answer, text alone is not", async () => {
  const pieces = ["{\"ok\"", ":tru", "e}"];
  const streamed = await createFetchAi({ aiIntegrations: [integration()] }, { fetch: async () => sse([call("", { name: "result" }), ...pieces.map((piece) => call(piece)), finish("tool_calls"), usage(10, 4), DONE]) }).complete(JSON_ASK);
  assert.deepEqual(streamed.json, { ok: true });

  const ends = [];
  const onlyText = await createFetchAi({ aiIntegrations: [integration()] }, { fetch: async () => sse([content(JSON.stringify({ ok: true })), finish("stop"), DONE]), onAttemptEnd: (end) => ends.push(end) }).complete(JSON_ASK).then(() => null, (failure) => failure);
  assert.ok(onlyText instanceof AiReplyRejectedError, String(onlyText));
  assert.match(onlyText.message, /answered in text instead of calling the function "result"/);
  assert.equal(ends[0].streamed, true);
  assert.equal(ends[0].toolCalled, false);
});

test("(b) a model that gave nothing at all is still the empty reply it was, not a text answer", async () => {
  const error = await createFetchAi({ aiIntegrations: [integration()] }, { fetch: async () => Response.json({ choices: [{ message: { content: "" }, finish_reason: "stop" }] }) }).complete(JSON_ASK).then(() => null, (failure) => failure);
  assert.ok(error instanceof AiProviderError);
  assert.match(error.message, /empty reply/);
});

// ─── (c) With Tools only off, today's behavior ──────────────────────────────

test("(c) with toolsOnly false a model without tool calls is used, and the schema goes in the message as it always did", async () => {
  const attempts = [];
  const { fetch, calls } = recording(() => text(`Here you go: ${JSON.stringify({ ok: true })}`));
  const response = await createFetchAi({ ...twoModels({ primary: NO_TOOLS }), toolsOnly: false }, { fetch, onAttempt: (attempt) => attempts.push(attempt) }).complete(JSON_ASK);
  assert.deepEqual(response.json, { ok: true });
  assert.equal(hostOf(calls[0]), "a", "the primary is used");
  assert.equal("tools" in calls[0].body, false);
  assert.match(calls[0].body.messages[0].content, /Reply with ONLY one JSON object/);
  assert.equal(attempts[0].toolsOnly, false);
  assert.equal("skipped" in attempts[0], false);
});

test("(c) with toolsOnly false the JSON in a text reply is the answer, and empty arguments fall back to it, as before", async () => {
  const cfg = { aiIntegrations: [integration()], toolsOnly: false };
  const inText = await createFetchAi(cfg, { fetch: async () => text(JSON.stringify({ ok: true })) }).complete(JSON_ASK);
  assert.deepEqual(inText.json, { ok: true });
  const afterEmpty = await createFetchAi(cfg, { fetch: async () => Response.json({ choices: [{ message: { content: JSON.stringify({ ok: false }), tool_calls: [{ function: { name: "result", arguments: "{}" } }] }, finish_reason: "stop" }] }) }).complete(JSON_ASK);
  assert.deepEqual(afterEmpty.json, { ok: false });
  const streamed = await createFetchAi(cfg, { fetch: async () => sse([content("Sure: "), content(JSON.stringify({ ok: true })), finish("stop"), DONE]) }).complete(JSON_ASK);
  assert.deepEqual(streamed.json, { ok: true });
});

test("(c) through pickAiRuntimeConfig the settings switch does the same", async () => {
  const cfg = pickAiRuntimeConfig({ aiToolsOnly: false, aiIntegrations: [integration({ chatModels: [{ id: "m", name: "plain", capabilities: ["default"], ...NO_TOOLS }] })] });
  const response = await createFetchAi(cfg, { fetch: async () => text(JSON.stringify({ ok: true })) }).complete(JSON_ASK);
  assert.deepEqual(response.json, { ok: true });
});

// ─── The kind, and what a run does with it ──────────────────────────────────

test("the new kind is in the closed list and is read from a file, and the other kinds are as they were", () => {
  assert.ok(engine.AUTOPILOT_ERROR_KINDS.includes("config"));
  assert.equal(engine.normalizeErrorKind("config"), "config");
  assert.equal(engine.normalizeErrorKind("nonsense"), undefined);
  assert.equal(engine.AUTOPILOT_ERROR_KINDS.length, 13);
});

const FAST = { readers: false, readersOnPlan: false, pauseAfterPlan: false };
const ONE = { brief: { idea: "x", targetChapters: 1, scenesPerChapter: 1, wordsPerScene: 300 }, options: FAST };

test("a run whose only model cannot call a function stops at once as a configuration problem, with nothing sent and nothing retried", async () => {
  const { fetch, calls } = recording(() => answer({ ok: true }));
  const ai = createFetchAi({ aiIntegrations: [integration({ chatModels: [{ id: "m", name: "plain", capabilities: ["default"], ...NO_TOOLS }] })] }, { fetch });
  const store = new MemoryBookStore(seedBookFiles());
  const events = [];
  const session = new AutopilotSession({ bookId: "book", store, ai, host: "server", hostLabel: "test", retryDelayMs: 0 });
  session.subscribe((event) => events.push(event));
  await session.start(ONE);
  await session.waitForIdle();
  const snapshot = await session.snapshot();
  const state = parseAutopilotState(store.files.get("autopilot/state.json"));
  assert.equal(state.status, "error");
  assert.equal(state.lastError.errorKind, "config");
  assert.match(state.lastError.message, /Turn on "Forced tool calls" for the model in AI Integrations/);
  assert.equal(snapshot.summary.lastError.kind, "config");
  assert.equal(calls.length, 0, "nothing was sent to the provider");
  assert.equal(events.some((event) => event.type === "insight" && event.code === "failureRetry"), false, "a configuration is not retried");
  const failed = snapshot.activities.filter((activity) => activity.status === "failed");
  assert.equal(failed.length, 1);
  assert.equal(failed[0].errorKind, "config");
});

test("the same book with Tools only off runs on the same model (the schema goes in the message)", async () => {
  const { fetch, calls } = recording(() => text("Nothing JSON about this."));
  const ai = createFetchAi({ aiIntegrations: [integration({ chatModels: [{ id: "m", name: "plain", capabilities: ["default"], ...NO_TOOLS }] })], toolsOnly: false }, { fetch });
  const store = new MemoryBookStore(seedBookFiles());
  const session = new AutopilotSession({ bookId: "book", store, ai, host: "server", hostLabel: "test", retryDelayMs: 0 });
  await session.start(ONE);
  await session.waitForIdle();
  assert.ok(calls.length > 0, "the provider was asked");
  assert.equal("tools" in calls[0].body, false);
  assert.match(calls[0].body.messages[0].content, /Reply with ONLY one JSON object/);
});
