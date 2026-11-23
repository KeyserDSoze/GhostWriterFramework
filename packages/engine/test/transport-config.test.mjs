import test from "node:test";
import assert from "node:assert/strict";
import * as engine from "../dist/index.js";
import { MemoryBookStore, seedBookFiles } from "../dist/testing/index.js";
import { content, eventStream, integration, live } from "./transport-fakes.mjs";

const { AiProviderError, AutopilotSession, classifyAutopilotError, createFetchAi, normalizeErrorDetail, parseAutopilotState, pickAiRuntimeConfig, readStoredAutopilot, redactAiRuntimeConfig } = engine;

const pick = (extra) => pickAiRuntimeConfig({ aiIntegrations: [integration(extra)] }).aiIntegrations[0];

// ─── E1-7: the configuration ────────────────────────────────────────────────

test("streamMode is auto or off; anything else is left out, and a configuration of an older host has none", () => {
  assert.equal(pick({ streamMode: "off" }).streamMode, "off");
  assert.equal(pick({ streamMode: "auto" }).streamMode, "auto");
  for (const garbage of ["sse", "OFF", "", null, 0, 1, true, {}, []]) assert.equal("streamMode" in pick({ streamMode: garbage }), false, JSON.stringify(garbage));
  assert.equal("streamMode" in pick({}), false);
});

test("idleTimeoutMs is kept between 30 s and an hour, and what is not a number is left out", () => {
  assert.equal(pick({ idleTimeoutMs: 120_000 }).idleTimeoutMs, 120_000);
  assert.equal(pick({ idleTimeoutMs: 1_000 }).idleTimeoutMs, 30_000);
  assert.equal(pick({ idleTimeoutMs: 30_000 }).idleTimeoutMs, 30_000);
  assert.equal(pick({ idleTimeoutMs: 3_600_000 }).idleTimeoutMs, 3_600_000);
  assert.equal(pick({ idleTimeoutMs: 99_999_999 }).idleTimeoutMs, 3_600_000);
  assert.equal(pick({ idleTimeoutMs: 45_000.4 }).idleTimeoutMs, 45_000, "a whole number of milliseconds");
  for (const garbage of ["600", 0, -5, Number.NaN, Number.POSITIVE_INFINITY, null, {}, [], true]) assert.equal("idleTimeoutMs" in pick({ idleTimeoutMs: garbage }), false, String(garbage));
  assert.equal("idleTimeoutMs" in pick({}), false);
});

test("the provider timeout is saved as the author wrote it: the minimum applies when a call is made, not in the configuration", () => {
  assert.equal(pick({ requestTimeoutMs: 6_000 }).requestTimeoutMs, 6_000);
  assert.equal(pick({ requestTimeoutMs: 5 }).requestTimeoutMs, 5);
  assert.equal(pick({ requestTimeoutMs: 900_000 }).requestTimeoutMs, 900_000);
});

test("what a server stores and reads back keeps the new fields: picking is idempotent through JSON", () => {
  const picked = pickAiRuntimeConfig({ aiIntegrations: [integration({ streamMode: "off", idleTimeoutMs: 90_000, requestTimeoutMs: 6_000 }), integration({ id: "q", name: "Plain" })] });
  const again = pickAiRuntimeConfig(JSON.parse(JSON.stringify(picked)));
  assert.deepEqual(again, picked);
  assert.equal(again.aiIntegrations[0].streamMode, "off");
  assert.equal(again.aiIntegrations[0].idleTimeoutMs, 90_000);
  assert.equal(again.aiIntegrations[0].requestTimeoutMs, 6_000);
  assert.equal("streamMode" in again.aiIntegrations[1], false);
});

test("the safe view of a configuration shows the new fields, and still no key", () => {
  const picked = pickAiRuntimeConfig({ aiIntegrations: [integration({ streamMode: "off", idleTimeoutMs: 90_000 }), integration({ id: "q", name: "Plain" })] });
  const view = redactAiRuntimeConfig(picked);
  assert.equal(view.integrations[0].streamMode, "off");
  assert.equal(view.integrations[0].idleTimeoutMs, 90_000);
  assert.equal("streamMode" in view.integrations[1], false);
  assert.equal("idleTimeoutMs" in view.integrations[1], false);
  assert.equal(view.integrations[0].hasApiKey, true);
  assert.equal(JSON.stringify(view).includes("sk-test-SECRET"), false);
});

// ─── E1-5: what a failure says about its deadline ───────────────────────────

test("the detail of a timeout says which deadline ran out and how long it was; no other error has them", () => {
  for (const phase of ["start", "idle", "total"]) {
    const error = new AiProviderError("openai m: timeout", undefined, true, { transient: true, timedOut: true, timeout: { phase, ms: 30_000, raisedFrom: 6_000 } });
    const { kind, detail } = classifyAutopilotError(error);
    assert.equal(kind, "timeout");
    assert.equal(detail.timeoutMs, 30_000, phase);
    assert.equal(detail.timeoutPhase, phase);
    assert.equal("raisedFrom" in detail, false, "the detail is the same short list as ever, plus these two");
  }
  const plain = classifyAutopilotError(new AiProviderError("openai m: HTTP 500", 500, true)).detail;
  assert.equal("timeoutMs" in plain, false);
  assert.equal("timeoutPhase" in plain, false);
  const bad = classifyAutopilotError(Object.assign(new AiProviderError("t", undefined, true, { timedOut: true }), { timeout: { phase: "sometime", ms: -3 } })).detail;
  assert.equal("timeoutMs" in bad, false, "a value that is not valid is dropped");
  assert.equal("timeoutPhase" in bad, false);
});

test("a timeout's failure fields carry the deadline, next to the retry they belong to", () => {
  const error = new AiProviderError("openai m: the provider did not finish within 4 h", undefined, true, { transient: true, timedOut: true, timeout: { phase: "total", ms: 14_400_000 }, model: "m", provider: "openai", integrationId: "p" });
  const fields = engine.autopilotErrorFields(error, { attempt: 2, retries: 3 });
  assert.equal(fields.errorKind, "timeout");
  assert.deepEqual(fields.errorDetail, { model: "m", provider: "openai", integration: "p", timeoutMs: 14_400_000, timeoutPhase: "total", attempt: 2, retries: 3 });
});

test("an error detail read from a file keeps the deadline when it is valid and drops it when it is not", () => {
  assert.deepEqual(normalizeErrorDetail({ timeoutMs: 30_000, timeoutPhase: "start" }), { timeoutMs: 30_000, timeoutPhase: "start" });
  assert.deepEqual(normalizeErrorDetail({ status: 504, timeoutMs: 600_000.4, timeoutPhase: "idle" }), { status: 504, timeoutMs: 600_000, timeoutPhase: "idle" });
  assert.equal(normalizeErrorDetail({ timeoutMs: -1, timeoutPhase: "later" }), undefined);
  assert.deepEqual(normalizeErrorDetail({ status: 500, timeoutMs: "30", timeoutPhase: 7 }), { status: 500 });
  assert.deepEqual(normalizeErrorDetail({ timeoutMs: 0, timeoutPhase: "idle" }), { timeoutPhase: "idle" });
  assert.deepEqual(normalizeErrorDetail({ status: 429, attempt: 1, retries: 3 }), { status: 429, attempt: 1, retries: 3 }, "a file of an older engine reads as it did");
});

const STATE = "autopilot/state.json";
const ONE = { brief: { idea: "x", targetChapters: 1, scenesPerChapter: 1, wordsPerScene: 300 }, options: { readers: false, readersOnPlan: false, pauseAfterPlan: false } };

test("a run that ends on an idle timeout of the real client says so in its state, its activity, its events and its summary, and nothing in it is secret", async () => {
  const stream = () => {
    const body = live();
    body.send(content("Hi"));
    return eventStream(body.body);
  };
  const ai = createFetchAi({ aiIntegrations: [integration({ idleTimeoutMs: 40, endpoint: "https://proxy.example.com:8443/secret-path-ABC123/v1?key=QUERYSECRET789" })] }, { fetch: async () => stream(), minimumTimeoutMs: 1 });
  const store = new MemoryBookStore(seedBookFiles({ chapters: 1 }));
  const events = [];
  const session = new AutopilotSession({ bookId: "book", store, ai, host: "server", hostLabel: "test", retryDelayMs: 0 });
  session.subscribe((event) => events.push(event));
  await session.start(ONE);
  await session.waitForIdle();
  const snapshot = await session.snapshot();
  const state = parseAutopilotState(store.files.get(STATE));
  assert.equal(state.status, "error");
  assert.equal(state.lastError.errorKind, "timeout");
  assert.equal(state.lastError.errorDetail.timeoutMs, 40);
  assert.equal(state.lastError.errorDetail.timeoutPhase, "idle");
  assert.equal(state.lastError.errorDetail.endpoint, "https://proxy.example.com:8443");
  assert.equal(state.lastError.errorDetail.attempt, 3, "a timeout is retried as it always was");
  assert.match(state.lastError.message, /the provider sent nothing for 40 ms while answering/);
  assert.deepEqual(snapshot.summary.lastError.detail, state.lastError.errorDetail);
  const { activities } = await readStoredAutopilot(store);
  const failed = activities.filter((activity) => activity.status === "failed").at(-1);
  assert.equal(failed.errorKind, "timeout");
  assert.equal(failed.errorDetail.timeoutPhase, "idle");
  assert.equal(failed.errorDetail.timeoutMs, 40);
  assert.ok(events.some((event) => event.type === "task-finished" && event.activity.errorDetail?.timeoutPhase === "idle"));
  const everything = [store.files.get(STATE), store.files.get("autopilot/activity.json"), JSON.stringify(events), JSON.stringify(snapshot.summary)].join("\n");
  for (const secret of ["sk-test-SECRET-0123456789", "secret-path-ABC123", "QUERYSECRET789"]) assert.equal(everything.includes(secret), false, secret);
});
