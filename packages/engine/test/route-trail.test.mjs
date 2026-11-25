import test from "node:test";
import assert from "node:assert/strict";
import * as engine from "../dist/index.js";
import { ASK, JSON_ASK, hang, integration, recording, settle, track } from "./transport-fakes.mjs";

const { AiPromptTooLargeError, AiProviderError, AiUnavailableError, MemoryAiCallStore, RunCalls, classifyAutopilotError, createFetchAi, describeAiRoute, normalizeErrorDetail, planAttempts, resolveAiCandidates } = engine;

// The route of a call, place by place: every candidate the author wrote, in the order they wrote it, with what became of it. A call that failed ends with the whole route (the primary
// that failed at once, then the fallback that ran out of time), never with the last candidate alone; a candidate that the router cannot use or that the plan leaves out keeps its place
// and says why; a page that ends sends nothing to the fallback; and the records of the call keep the candidates that were left out beside the ones that were asked.

const ALL = ["default"];
const model = (name, extra = {}) => ({ id: name, name, capabilities: ALL, ...extra });
const answer = (value, name = "result") => Response.json({ choices: [{ message: { tool_calls: [{ function: { name, arguments: JSON.stringify(value) } }] }, finish_reason: "tool_calls" }] });
const failing = (status, message) => new Response(JSON.stringify({ error: { message } }), { status, headers: { "content-type": "application/json" } });
const hostOf = (entry) => new URL(entry.url).hostname.replace(".test", "");
const byHost = (handlers) => recording((entry) => handlers[hostOf(entry)](entry));

/** Alpha (the primary) and Beta (the fallback), in the order of the route; `routing` is merged into the configuration. */
function twoModels({ primary = {}, fallback = {}, route, ...config } = {}) {
  return {
    aiIntegrations: [
      integration({ id: "a", name: "Alpha", endpoint: "http://a.test/v1", chatModels: [model("alpha-model", primary)] }),
      integration({ id: "b", name: "Beta", endpoint: "http://b.test/v1", chatModels: [model("beta-model", fallback)] }),
    ],
    taskRouting: { autopilot: route ?? { primary: { integrationId: "a", model: "alpha-model" }, fallbacks: [{ integrationId: "b", model: "beta-model" }] } },
    ...config,
  };
}

// ─── describeAiRoute ────────────────────────────────────────────────────────

test("describeAiRoute keeps the place of a target that cannot be called, with the reason, and resolveAiCandidates is what is left of it", () => {
  const config = {
    aiIntegrations: [
      integration({ id: "a", name: "Alpha", chatModels: [model("alpha-model"), { id: "r", name: "review-only", capabilities: ["review"] }] }),
      integration({ id: "m", name: "Microsoft", provider: "m365_copilot", chatModels: [model("copilot")] }),
      integration({ id: "b", name: "Beta", chatModels: [model("beta-model")] }),
    ],
    taskRouting: {
      autopilot: {
        primary: { integrationId: "gone", model: "x" },
        fallbacks: [
          { integrationId: "a", model: "missing-model" },
          { integrationId: "a", model: "review-only" },
          { integrationId: "m", model: "copilot" },
          { integrationId: "b", model: "beta-model" },
          { integrationId: "b", model: "beta-model" },
        ],
      },
    },
  };
  const entries = describeAiRoute(config, "autopilot");
  assert.deepEqual(entries.map((entry) => [entry.position, entry.unusable ?? entry.candidate.model]), [[0, "integration-missing"], [1, "model-missing"], [2, "task-not-allowed"], [3, "provider-unsupported"], [4, "beta-model"]]);
  assert.deepEqual(resolveAiCandidates(config, "autopilot").map((candidate) => candidate.model), ["beta-model"], "the same one twice counts once, and what cannot be called is not a candidate");
  assert.deepEqual(entries[0].target, { integrationId: "gone", model: "x" });
});

test("describeAiRoute and resolveAiCandidates are what they were for a task with no route: tagged models first, then the default writing integration, in order, at most maxCandidates", () => {
  const config = {
    aiIntegrations: [
      integration({ id: "a", name: "Alpha", chatModels: [model("alpha-model", { capabilities: ["default"] })] }),
      integration({ id: "b", name: "Beta", chatModels: [{ id: "b", name: "beta-model", capabilities: ["review"] }] }),
      integration({ id: "c", name: "Gamma", chatModels: [model("gamma-model")] }),
    ],
    defaultReviewIntegrationId: "c",
    maxCandidates: 2,
  };
  assert.deepEqual(resolveAiCandidates(config, "review").map((candidate) => candidate.model), ["gamma-model", "beta-model"]);
  assert.deepEqual(describeAiRoute(config, "review").map((entry) => entry.position), [0, 1]);
  assert.deepEqual(resolveAiCandidates(config, "autopilot").map((candidate) => candidate.model), ["alpha-model", "gamma-model"]);
});

// ─── The route of a call that failed ────────────────────────────────────────

test("a call whose primary fails at once and whose fallback runs out of the routing time ends with both: the primary first, the fallback last, and the time that was left says it is the routing's", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout", "Date"] });
  const cfg = twoModels({ routingExecution: { maxTotalDurationMs: 3000 } });
  const { fetch, calls } = recording((entry) => (entry.url.includes("a.test") ? failing(404, "The model `alpha-model` does not exist.") : hang(entry.url, entry.init)));
  const outcome = track(createFetchAi(cfg, { fetch }).complete(ASK));
  await settle();
  assert.equal(calls.length, 2, "the primary was asked, and then the fallback");
  t.mock.timers.tick(3000);
  await settle();
  assert.equal(outcome.done, true);
  const error = outcome.error;
  assert.ok(error instanceof AiProviderError);
  assert.equal(error.target.integrationId, "b", "the error's own target is the last candidate, as it always was");
  assert.equal(error.route.length, 2);
  const [first, second] = error.route;
  assert.deepEqual([first.position, first.integrationName, first.model, first.outcome, first.status], [0, "Alpha", "alpha-model", "failed", 404]);
  assert.match(first.message, /HTTP 404/);
  assert.match(first.message, /does not exist/);
  assert.deepEqual([second.position, second.integrationName, second.model, second.outcome, second.timeoutPhase, second.timeoutMs, second.routing], [1, "Beta", "beta-model", "timeout", "total", 3000, true]);
  assert.equal(second.durationMs, 3000);
  assert.equal(error.timeout.routing, true);
  const { kind, detail } = classifyAutopilotError(error);
  assert.equal(kind, "timeout");
  assert.equal(detail.integration, "b");
  assert.deepEqual(detail.route.map((step) => [step.position, step.outcome]), [[0, "failed"], [1, "timeout"]]);
});

test("the first candidate is not held to the routing time: its timeout is its own, and it is not the routing's", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout", "Date"] });
  const cfg = twoModels({ route: { primary: { integrationId: "a", model: "alpha-model" } }, routingExecution: { maxTotalDurationMs: 1000 } });
  cfg.aiIntegrations[0].requestTimeoutMs = 31_000;
  const { fetch } = recording((entry) => hang(entry.url, entry.init));
  const outcome = track(createFetchAi(cfg, { fetch }).complete(ASK));
  await settle();
  t.mock.timers.tick(31_000);
  await settle();
  assert.equal(outcome.done, true);
  assert.equal(outcome.error.timeout.phase, "start");
  assert.equal("routing" in outcome.error.timeout, false);
  assert.deepEqual(outcome.error.route.map((step) => [step.outcome, step.timeoutPhase, step.routing]), [["timeout", "start", undefined]]);
});

test("every candidate that failed is in the route, in order, and a call that works ends with no error and no route to say", async () => {
  const cfg = twoModels({ route: { primary: { integrationId: "a", model: "alpha-model" }, fallbacks: [{ integrationId: "b", model: "beta-model" }, { integrationId: "a", model: "alpha-model-2" }] } });
  cfg.aiIntegrations[0].chatModels.push(model("alpha-model-2"));
  const failures = byHost({ a: (entry) => failing(entry.body.model === "alpha-model" ? 401 : 503, "no"), b: () => failing(429, "slow down") });
  const error = await createFetchAi(cfg, { fetch: failures.fetch }).complete(ASK).then(() => null, (failure) => failure);
  assert.deepEqual(error.route.map((step) => [step.position, step.model, step.outcome, step.status]), [[0, "alpha-model", "failed", 401], [1, "beta-model", "failed", 429], [2, "alpha-model-2", "failed", 503]]);
  assert.equal(error.status, 503);

  const worked = byHost({ a: () => failing(500, "down"), b: () => Response.json({ choices: [{ message: { content: "ok" }, finish_reason: "stop" }] }) });
  const response = await createFetchAi(twoModels(), { fetch: worked.fetch }).complete(ASK);
  assert.equal(response.text, "ok");
  assert.equal("route" in response, false);
});

// ─── What the plan leaves out ───────────────────────────────────────────────

test("a primary whose context window cannot hold the prompt is left out with the numbers that say it, and the attempt after it is the fallback, in its place in the route", async () => {
  const attempts = [];
  const { fetch, calls } = byHost({ a: () => answer({ ok: true }), b: () => answer({ ok: true }) });
  const cfg = twoModels({ primary: { maxInputTokens: 1000 } });
  const big = { ...ASK, user: "word ".repeat(2000) };
  const response = await createFetchAi(cfg, { fetch, onAttempt: (attempt) => attempts.push(attempt) }).complete(big);
  assert.equal(response.text, "");
  assert.deepEqual(calls.map(hostOf), ["b"], "nothing was sent to the primary");
  assert.equal(attempts.length, 1);
  assert.equal(attempts[0].index, 1, "the fallback is the second place of the route, though it is the first to be asked");
  assert.equal(attempts[0].leftOut.length, 1);
  const [left] = attempts[0].leftOut;
  assert.deepEqual([left.position, left.integrationName, left.model, left.outcome, left.leftOut], [0, "Alpha", "alpha-model", "left-out", "context-window"]);
  assert.ok(left.promptTokens > left.windowTokens, `${left.promptTokens} > ${left.windowTokens}`);
  assert.ok(left.windowTokens > 0 && left.windowTokens < 1000);
});

test("when the call fails, the route has the candidate that was left out beside the one that was asked, and the message says the same", async () => {
  const { fetch } = byHost({ a: () => answer({ ok: true }), b: () => failing(503, "overloaded") });
  const cfg = twoModels({ primary: { maxInputTokens: 1000 } });
  const error = await createFetchAi(cfg, { fetch }).complete({ ...ASK, user: "word ".repeat(2000) }).then(() => null, (failure) => failure);
  assert.deepEqual(error.route.map((step) => [step.position, step.model, step.outcome, step.leftOut ?? step.status]), [[0, "alpha-model", "left-out", "context-window"], [1, "beta-model", "failed", 503]]);
  assert.match(error.message, /Skipped "alpha-model" in "Alpha": the prompt \(about \d+ tokens\) does not fit its context window \(\d+ tokens are left for the prompt\)\./);
});

test("a prompt that no window holds ends the call before anything is sent, and the error says which candidates were too small and by how much", () => {
  const cfg = twoModels({ primary: { maxInputTokens: 1000 }, fallback: { maxInputTokens: 2000 } });
  let error;
  try {
    planAttempts(cfg, { ...ASK, user: "word ".repeat(5000) });
  } catch (failure) {
    error = failure;
  }
  assert.ok(error instanceof AiPromptTooLargeError);
  assert.deepEqual(error.route.map((step) => [step.position, step.model, step.leftOut]), [[0, "alpha-model", "context-window"], [1, "beta-model", "context-window"]]);
  assert.ok(error.route.every((step) => step.promptTokens > step.windowTokens));
  assert.deepEqual(classifyAutopilotError(error).detail.route.map((step) => step.leftOut), ["context-window", "context-window"]);
});

test("the targets that cannot be called are in the plan with their reason, the call goes to the one that can, and a route with none of them says so instead of «no model is configured»", async () => {
  const cfg = twoModels({ route: { primary: { integrationId: "gone", model: "ghost" }, fallbacks: [{ integrationId: "b", model: "beta-model" }] } });
  const attempts = [];
  const { fetch } = byHost({ b: () => answer({ ok: true }) });
  await createFetchAi(cfg, { fetch, onAttempt: (attempt) => attempts.push(attempt) }).complete(JSON_ASK);
  assert.equal(attempts[0].index, 1, "the fallback is not taken for the primary");
  assert.deepEqual(attempts[0].leftOut.map((step) => [step.position, step.integrationId, step.model, step.leftOut, step.why]), [[0, "gone", "ghost", "unusable", "integration-missing"]]);

  const nothing = twoModels({ route: { primary: { integrationId: "gone", model: "ghost" }, fallbacks: [{ integrationId: "a", model: "other" }] } });
  let error;
  try {
    planAttempts(nothing, ASK);
  } catch (failure) {
    error = failure;
  }
  assert.ok(error instanceof AiUnavailableError);
  assert.match(error.message, /No model of the route of the "autopilot" task can be called/);
  assert.match(error.message, /"ghost" in "gone" \(its integration is no longer there\)/);
  assert.match(error.message, /"other" in "Alpha" \(the model is not in the integration\)/);
  assert.deepEqual(error.route.map((step) => [step.position, step.why]), [[0, "integration-missing"], [1, "model-missing"]]);
  assert.equal(new AiUnavailableError("review").message, "No AI model is configured for the \"review\" task. Configure an integration in the AI router.", "a task with no route says what it always said");
});

test("the routing limits that cut a fallback say so, and a first candidate that alone exceeds them is refused with its place", () => {
  const each = planAttempts(twoModels(), ASK).attempts[0].estimate.tokens;
  const cfg = twoModels({ routingExecution: { maxTokenAttempts: each + 1 } });
  const plan = planAttempts(cfg, ASK);
  assert.equal(plan.attempts.length, 1, "the second attempt does not fit the token limit");
  assert.deepEqual(plan.leftOut.map((step) => [step.position, step.model, step.leftOut]), [[1, "beta-model", "budget"]]);
  let error;
  try {
    planAttempts(twoModels({ routingExecution: { maxTokenAttempts: 1 } }), ASK);
  } catch (failure) {
    error = failure;
  }
  assert.equal(error.name, "AiRoutingBudgetError");
  assert.deepEqual(error.route.map((step) => [step.position, step.leftOut]), [[0, "budget"], [1, "budget"]]);
});

test("the privacy policy and the author who did not acknowledge a fallback leave it out with their reasons", async () => {
  const policy = twoModels({ fallbackDisclosure: { sameBoundaryOnly: true, requireAcknowledgement: false } });
  assert.deepEqual(planAttempts(policy, ASK).leftOut.map((step) => [step.model, step.leftOut]), [["beta-model", "boundary"]]);

  const refused = twoModels({ fallbackDisclosure: { sameBoundaryOnly: false, requireAcknowledgement: true } });
  const { fetch } = byHost({ a: () => failing(500, "down"), b: () => answer({ ok: true }) });
  const error = await createFetchAi(refused, { fetch, acknowledgeFallback: () => false }).complete(ASK).then(() => null, (failure) => failure);
  assert.deepEqual(error.route.map((step) => [step.model, step.outcome, step.leftOut ?? step.status]), [["alpha-model", "failed", 500], ["beta-model", "left-out", "not-acknowledged"]]);
});

test("the routing time that is used up leaves the fallbacks after it out, in the route of the error", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout", "Date"] });
  const cfg = twoModels({ routingExecution: { maxTotalDurationMs: 50 } });
  cfg.aiIntegrations[0].requestTimeoutMs = 30_000;
  let now = 0;
  const { fetch } = recording(async (entry) => {
    if (entry.url.includes("a.test")) {
      now += 60;
      t.mock.timers.tick(60);
      return failing(500, "slow failure");
    }
    return answer({ ok: true });
  });
  const error = await createFetchAi(cfg, { fetch }).complete(ASK).then(() => null, (failure) => failure);
  assert.ok(now >= 60);
  assert.deepEqual(error.route.map((step) => [step.model, step.outcome, step.leftOut ?? step.status]), [["alpha-model", "failed", 500], ["beta-model", "left-out", "out-of-time"]]);
  assert.match(error.message, /Fallbacks were not tried: the total routing time/);
});

// ─── A page that ends ───────────────────────────────────────────────────────

test("a request that fails while the host is ending is not the provider's failure: no other candidate is asked, and the attempt is closed as cancelled", async () => {
  const ends = [];
  let ending = false;
  const { fetch, calls } = recording(async () => {
    ending = true;
    throw new TypeError("Failed to fetch");
  });
  const error = await createFetchAi(twoModels(), { fetch, interrupted: () => ending, onAttemptEnd: (end) => ends.push(end) }).complete(ASK).then(() => null, (failure) => failure);
  assert.equal(calls.length, 1, "the prompt did not go to the fallback");
  assert.ok(error instanceof AiProviderError);
  assert.match(error.message, /fetch/i);
  assert.deepEqual(ends.map((end) => [end.model, end.outcome, end.failureKind]), [["alpha-model", "cancelled", "cancelled"]]);

  // The same failure of a host that is not ending is a failure of the provider: the next candidate is asked, as it always was.
  const alive = recording(async (entry) => {
    if (entry.url.includes("a.test")) throw new TypeError("Failed to fetch");
    return answer({ ok: true });
  });
  const response = await createFetchAi(twoModels(), { fetch: alive.fetch, interrupted: () => false }).complete(JSON_ASK);
  assert.deepEqual(response.json, { ok: true });
  assert.equal(alive.calls.length, 2);
});

// ─── The detail of a failure ────────────────────────────────────────────────

test("the detail of an error keeps the route, cleaned: valid steps only, no credential, no address but an origin, at most a dozen, and what is read from a file is read the same", () => {
  const secret = "sk-test-SECRET-0123456789";
  const error = Object.assign(new AiProviderError("boom", 500, true), {
    route: [
      { position: 0, integrationId: "a", integrationName: `Alpha ${secret}`, provider: "openai", model: "alpha-model", outcome: "failed", endpoint: "https://api.example.com/v1/chat?key=1", status: 404, durationMs: 12.4, message: `HTTP 404 — ${secret} missing\n${"x".repeat(400)}` },
      { position: 1, integrationId: "b", integrationName: "Beta", provider: "openai", model: "beta-model", outcome: "left-out", leftOut: "context-window", promptTokens: 9000, windowTokens: 4000 },
      { position: 2, model: "no-outcome" },
      { position: 3, integrationId: "c", integrationName: "Gamma", provider: "openai", model: "gamma-model", outcome: "timeout", timeoutPhase: "total", timeoutMs: 2800, routing: true, status: 99999, leftOut: "nonsense", why: "nonsense" },
      "garbage",
    ],
  });
  const { detail } = classifyAutopilotError(error);
  assert.equal(detail.route.length, 3, "a step without an outcome and one that is not an object are dropped");
  assert.equal(JSON.stringify(detail).includes(secret), false);
  assert.equal(detail.route[0].endpoint, "https://api.example.com", "never a path or a query");
  assert.equal(detail.route[0].durationMs, 12);
  assert.ok(detail.route[0].message.length <= 240);
  assert.equal(detail.route[0].message.includes("\n"), false);
  assert.deepEqual(detail.route[1], { position: 1, integrationId: "b", integrationName: "Beta", provider: "openai", model: "beta-model", outcome: "left-out", leftOut: "context-window", promptTokens: 9000, windowTokens: 4000 });
  assert.deepEqual([detail.route[2].timeoutPhase, detail.route[2].timeoutMs, detail.route[2].routing, "status" in detail.route[2], "leftOut" in detail.route[2], "why" in detail.route[2]], ["total", 2800, true, false, false, false]);
  assert.deepEqual(normalizeErrorDetail(JSON.parse(JSON.stringify(detail))).route, detail.route, "what a file keeps is read back as it was");
  const many = Object.assign(new AiProviderError("boom"), { route: Array.from({ length: 30 }, (_, position) => ({ position, integrationId: "a", integrationName: "A", provider: "openai", model: `m${position}`, outcome: "failed" })) });
  assert.equal(classifyAutopilotError(many).detail.route.length, 12);
  assert.equal(normalizeErrorDetail({ route: "nope" }), undefined);
});

// ─── The records of the call ────────────────────────────────────────────────

/** The task of a call once the recorder's writes have landed: the recorder never makes the caller wait for the store. */
async function ended(store, activityId) {
  for (let turn = 0; turn < 50; turn += 1) {
    const task = await store.readTask("book", activityId);
    if (task && task.calls.length && task.calls.every((entry) => entry.status !== "running")) return task;
    await settle();
  }
  throw new Error(`The call of ${activityId} never ended in the store.`);
}

test("the record of a call keeps the candidates that were left out beside the attempts, in the order of the route, and counts only the attempts that were asked", async () => {
  const store = new MemoryAiCallStore();
  const runCalls = new RunCalls({ store, bookId: "book", accountScope: null, host: "browser", secrets: () => [], onFailure: (error) => { throw error; }, now: () => new Date() });
  const start = (seq) => runCalls.start({ runId: "run", activityId: `activity_${seq}`, seq, stepAttempt: 1, task: "plan", chapter: null, scene: null, label: "plan", capability: "autopilot", system: "S", user: "U", structured: false, tool: null, toolSchemaHash: null, maxOutputTokens: null, temperature: null });

  // The primary is left out (its window), the fallback is asked and fails, the third is asked and answers.
  const cfg = twoModels({ primary: { maxInputTokens: 1000 }, route: { primary: { integrationId: "a", model: "alpha-model" }, fallbacks: [{ integrationId: "b", model: "beta-model" }, { integrationId: "c", model: "gamma-model" }] } });
  cfg.aiIntegrations.push(integration({ id: "c", name: "Gamma", endpoint: "http://c.test/v1", chatModels: [model("gamma-model")] }));
  const handlers = byHost({ a: () => answer({ ok: true }), b: () => failing(503, "overloaded"), c: () => Response.json({ choices: [{ message: { content: "done" }, finish_reason: "stop" }] }) });
  const recording1 = start(1);
  await createFetchAi(cfg, { fetch: handlers.fetch }).complete({ ...ASK, user: "word ".repeat(2000), onAttempt: recording1.onAttempt, onAttemptEnd: recording1.onAttemptEnd });
  const info = recording1.end("ok", {});
  assert.equal(info.attempts, 2, "two attempts were asked; the one left out is not an attempt");
  await ended(store, "activity_1").then((task) => {
    const attempts = task.calls[0].attempts;
    assert.deepEqual(attempts.map((attempt) => [attempt.index, attempt.model, attempt.outcome, attempt.integrationId]), [[1, "alpha-model", "skipped", "a"], [2, "beta-model", "failed", "b"], [3, "gamma-model", "ok", "c"]]);
    assert.deepEqual([attempts[0].skip.reason, attempts[0].durationMs, attempts[0].error, attempts[0].usage], ["context-window", null, null, null]);
    assert.ok(attempts[0].skip.promptTokens > attempts[0].skip.windowTokens);
    assert.equal("skip" in attempts[1], false, "an attempt that was asked has no reason to say");
  });

  // A call that never left, because no window holds the prompt: the error has the whole route, and the record keeps it.
  const tooBig = twoModels({ primary: { maxInputTokens: 1000 }, fallback: { maxInputTokens: 1000 } });
  const second = start(2);
  const error = await createFetchAi(tooBig, { fetch: handlers.fetch }).complete({ ...ASK, user: "word ".repeat(5000), onAttempt: second.onAttempt, onAttemptEnd: second.onAttemptEnd }).then(() => null, (failure) => failure);
  assert.equal(second.end("failed", { error }).attempts, 0);
  const task = await ended(store, "activity_2");
  assert.deepEqual(task.calls[0].attempts.map((attempt) => [attempt.index, attempt.model, attempt.outcome, attempt.skip.reason]), [[1, "alpha-model", "skipped", "context-window"], [2, "beta-model", "skipped", "context-window"]]);
});
