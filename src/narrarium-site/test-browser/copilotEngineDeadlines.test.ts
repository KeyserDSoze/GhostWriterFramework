import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createFetchAi, pickAiRuntimeConfig } from "narrarium-engine";
import { classifyConfirmationRouted, completeTextRouted, completeToolRouted } from "@/assistant/router";
import { assertProvidersClean, failReply, hang, textReply, toolReply } from "./helpers/fakeProvider";
import { chatModel, compatible, SCHEMA } from "./helpers/aiFixtures";
import { MESSAGES, after, drip, entries, failAfter, goesSilent, hostsOf, provide, resetStores, routeOf, DEFAULT_SETTINGS } from "./helpers/copilotHarness";

/** What a reply of `pieces` pieces of text says, as the fake sends it. */
const spoken = (pieces: number) => Array.from({ length: pieces }, (_, index) => `piece ${index + 1}. `).join("");

/** Follows a promise without awaiting it: a rejection that comes while the clock is being moved is not an unhandled one. */
const outcome = <T>(promise: Promise<T>) => promise.then((value) => ({ value, error: undefined as any }), (error: unknown) => ({ value: undefined as T | undefined, error: error as any }));

beforeEach(() => {
  resetStores();
  vi.useFakeTimers();
});

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
  assertProvidersClean();
});

describe("the owner's case: a slow 30B model behind a tunnel, with a provider timeout of 6 s", () => {
  const llm = () => compatible("llm", [chatModel("muse-glimmer-30b")], { name: "LlmProxy", requestTimeoutMs: 6_000 });

  it("answers in prose that streams for 90 s: the provider timeout is how long the provider has to begin answering, not how long the reply may take", async () => {
    const fixture = llm();
    const fake = provide([fixture], (call) => drip({ signal: call.signal, pieces: 30, everyMs: 3_000 }));
    const seen: string[] = [];
    const run = outcome(completeTextRouted(routeOf("copilot", [fixture]), MESSAGES, "copilot", { accountScope: null, onText: (text) => seen.push(text) }));

    await vi.advanceTimersByTimeAsync(91_000);
    const { value, error } = await run;

    expect(error).toBeUndefined();
    expect(value).toBe(spoken(30));
    expect(seen[seen.length - 1]).toBe(spoken(30));
    expect(seen.length, "the text came as it was written").toBeGreaterThan(20);
    expect(fake.calls).toHaveLength(1);
    expect(entries()[0]).toMatchObject({ status: "done", timeouts: { startMs: 30_000, idleMs: 600_000, capMs: 14_400_000, raisedFrom: 6_000 } });
  });

  it("streams the reply of a request that has no listener of its text, so that no silence is left for a tunnel to cut", async () => {
    const fixture = llm();
    const fake = provide([fixture], (call) => (call.body.stream ? drip({ signal: call.signal, pieces: 30, everyMs: 3_000 }) : after(90_000, () => textReply(spoken(30)), call.signal)));
    const run = outcome(completeTextRouted(routeOf("copilot", [fixture]), MESSAGES, "copilot", { accountScope: null }));

    await vi.advanceTimersByTimeAsync(91_000);
    const { value, error } = await run;

    expect(error).toBeUndefined();
    expect(value).toBe(spoken(30));
    expect(fake.calls[0].body).toMatchObject({ stream: true, stream_options: { include_usage: true } });
  });

  it("answers in a forced function call that streams its arguments for 90 s", async () => {
    const fixture = llm();
    const fake = provide([fixture], (call) => (call.body.stream
      ? drip({ signal: call.signal, pieces: 30, everyMs: 3_000, as: "call", args: "{\"ok\":true}" })
      : after(90_000, () => toolReply({ ok: true }), call.signal)));
    const run = outcome(completeToolRouted<{ ok: boolean }>(routeOf("copilot", [fixture]), MESSAGES, "copilot", SCHEMA, { accountScope: null }));

    await vi.advanceTimersByTimeAsync(91_000);
    const { value, error } = await run;

    expect(error).toBeUndefined();
    expect(value?.output).toEqual({ ok: true });
    expect(fake.calls[0].body).toMatchObject({ stream: true, tool_choice: "required" });
    expect(entries()[0]).toMatchObject({ status: "done", structured: true, tools: true, stream: true, streamed: true, toolCalled: true });
  });

  it("classifies a confirmation from a model that takes 90 s to say yes", async () => {
    const fixture = llm();
    provide([fixture], (call) => (call.body.stream
      ? drip({ signal: call.signal, pieces: 30, everyMs: 3_000, as: "call", name: "confirm", args: "{\"decision\":\"yes\"}" })
      : after(90_000, () => toolReply({ decision: "yes" }), call.signal)));
    const run = outcome(classifyConfirmationRouted(routeOf("simple-tasks", [fixture]), "yes, go on", undefined, null));

    await vi.advanceTimersByTimeAsync(91_000);
    expect((await run).value).toBe("yes");
  });

  it("is still a provider that has not begun to answer after 6 s: nothing stops the call then, the 30 s minimum does, and the message says so", async () => {
    const fixture = llm();
    provide([fixture], (call) => after(1_000_000, () => textReply("late"), call.signal));
    const run = outcome(completeTextRouted(routeOf("copilot", [fixture]), MESSAGES, "copilot", { accountScope: null }));
    let settled = false;
    void run.then(() => { settled = true; });

    await vi.advanceTimersByTimeAsync(6_000);
    expect(settled, "6 s is not the deadline").toBe(false);
    await vi.advanceTimersByTimeAsync(24_000);
    const { error } = await run;

    expect(error.message).toContain("the provider did not start answering within 30 s");
    expect(error.message).toContain("the \"Provider timeout\" of the integration \"LlmProxy\" was 6 s and was raised to the 30 s minimum");
    expect(entries()[0]).toMatchObject({ status: "error", failureKind: "timeout", timeoutPhase: "start", timeoutMs: 30_000 });
  });
});

describe("a reply that keeps arriving is never cut, and a silence is", () => {
  it("does not stop a reply that lasts 150 s, longer than the 60 s the Copilot used to give a whole request, because bytes go on arriving", async () => {
    const fixture = compatible("a", [chatModel("model-a")]);
    provide([fixture], (call) => drip({ signal: call.signal, pieces: 15, everyMs: 10_000 }));
    const run = outcome(completeTextRouted(routeOf("copilot", [fixture]), MESSAGES, "copilot", { accountScope: null }));

    await vi.advanceTimersByTimeAsync(151_000);

    expect((await run).value).toBe(spoken(15));
  });

  it("does not stop a structured reply that lasts 150 s either", async () => {
    const fixture = compatible("a", [chatModel("model-a")]);
    provide([fixture], (call) => drip({ signal: call.signal, pieces: 15, everyMs: 10_000, as: "call", args: "{\"ok\":true}" }));
    const run = outcome(completeToolRouted<{ ok: boolean }>(routeOf("copilot", [fixture]), MESSAGES, "copilot", SCHEMA, { accountScope: null }));

    await vi.advanceTimersByTimeAsync(151_000);

    expect((await run).value?.output).toEqual({ ok: true });
  });

  it("stops a model that goes silent while it answers after the idle timeout of its integration, and says which deadline ran out and where it is changed", async () => {
    const fixture = compatible("llm", [chatModel("muse-glimmer-30b")], { name: "LlmProxy", idleTimeoutMs: 30_000 });
    const fake = provide([fixture], (call) => goesSilent(call.signal));
    const run = outcome(completeTextRouted(routeOf("copilot", [fixture]), MESSAGES, "copilot", { accountScope: null }));

    await vi.advanceTimersByTimeAsync(29_000);
    expect(fake.calls[0].signal?.aborted, "29 s of silence is not enough").toBe(false);
    await vi.advanceTimersByTimeAsync(1_000);
    const { error } = await run;

    expect(error.message).toContain("the provider sent nothing for 30 s while answering (the \"Idle timeout\" of the integration \"LlmProxy\")");
    expect(fake.calls[0].signal?.aborted, "and the request in flight was let go").toBe(true);
    expect(entries()[0]).toMatchObject({ status: "error", failureKind: "timeout", timeoutPhase: "idle", timeoutMs: 30_000 });
  });

  it("gives the same silence to a structured reply, and the next candidate is then tried", async () => {
    const a = compatible("a", [chatModel("model-a")], { idleTimeoutMs: 30_000 });
    const b = compatible("b", [chatModel("model-b")]);
    const fake = provide([a, b], (call) => (call.url.includes("a.example.test") ? goesSilent(call.signal, "{\"ok\":") : toolReply({ ok: true })));
    const run = outcome(completeToolRouted<{ ok: boolean }>(routeOf("copilot", [a, b]), MESSAGES, "copilot", SCHEMA, { accountScope: null }));

    await vi.advanceTimersByTimeAsync(30_000);
    const { value } = await run;

    expect(value?.output).toEqual({ ok: true });
    expect(hostsOf(fake)).toEqual(["a", "b"]);
    expect(entries().map((entry) => [entry.routeCandidateIndex, entry.status, entry.timeoutPhase])).toEqual([[1, "done", undefined], [0, "error", "idle"]]);
  });

  it("uses the provider timeout of the integration as the time the provider has to begin answering, and the default (10 minutes) when it has none", async () => {
    const own = compatible("a", [chatModel("model-a")], { name: "Own", requestTimeoutMs: 45_000 });
    provide([own], (call) => hang(call.signal));
    const first = outcome(completeTextRouted(routeOf("copilot", [own]), MESSAGES, "copilot", { accountScope: null }));
    await vi.advanceTimersByTimeAsync(45_000);
    expect((await first).error.message).toContain("the provider did not start answering within 45 s (the \"Provider timeout\" of the integration \"Own\")");

    const plain = compatible("b", [chatModel("model-b")], { name: "Plain" });
    provide([plain], (call) => hang(call.signal));
    const second = outcome(completeTextRouted(routeOf("copilot", [plain]), MESSAGES, "copilot", { accountScope: null }));
    await vi.advanceTimersByTimeAsync(599_000);
    expect(entries()[0].status, "nothing stopped it at 60 s, or at 599 s").toBe("pending");
    await vi.advanceTimersByTimeAsync(1_000);
    expect((await second).error.message).toContain("the provider did not start answering within 600 s (the default provider timeout; the integration \"Plain\" can change it with its \"Provider timeout\")");
  });
});

describe("the author's Stop wins over everything", () => {
  it("cancels a reply that is streaming, lets the request go, does not try the fallback, and is a cancel and not a timeout", async () => {
    const a = compatible("a", [chatModel("model-a")]);
    const b = compatible("b", [chatModel("model-b")]);
    const fake = provide([a, b], (call) => drip({ signal: call.signal, pieces: 30, everyMs: 3_000 }));
    const controller = new AbortController();
    const run = outcome(completeTextRouted(routeOf("copilot", [a, b]), MESSAGES, "copilot", { accountScope: null, signal: controller.signal }));

    await vi.advanceTimersByTimeAsync(10_000);
    controller.abort(new DOMException("Stopped by the author.", "AbortError"));
    const { error } = await run;
    // The call is over the moment the author stops it; the panel closes the entry of the attempt a few steps later.
    await vi.advanceTimersByTimeAsync(0);

    expect(error.name).toBe("AbortError");
    expect(hostsOf(fake)).toEqual(["a"]);
    expect(fake.calls[0].signal?.aborted).toBe(true);
    expect(entries()[0]).toMatchObject({ status: "error", failureKind: "cancelled" });
    expect(entries()[0].timeoutPhase).toBeUndefined();
  });

  it("is a cancel even when a deadline runs out at the very same moment", async () => {
    const fixture = compatible("a", [chatModel("model-a")], { idleTimeoutMs: 30_000 });
    provide([fixture], (call) => goesSilent(call.signal));
    const controller = new AbortController();
    const run = outcome(completeToolRouted(routeOf("copilot", [fixture]), MESSAGES, "copilot", SCHEMA, { accountScope: null, signal: controller.signal }));

    await vi.advanceTimersByTimeAsync(29_999);
    controller.abort(new DOMException("Stopped by the author.", "AbortError"));
    await vi.advanceTimersByTimeAsync(1);

    expect((await run).error.name).toBe("AbortError");
    expect(entries()[0]).toMatchObject({ failureKind: "cancelled" });
  });

  it("settles at once when the author stops a call whose provider ignores the abort of its request: nothing holds the author", async () => {
    const a = compatible("a", [chatModel("model-a")]);
    const fake = provide([a], () => new Promise<Response>(() => undefined));
    const controller = new AbortController();
    const run = outcome(completeToolRouted(routeOf("copilot", [a]), MESSAGES, "copilot", SCHEMA, { accountScope: null, signal: controller.signal }));

    await vi.advanceTimersByTimeAsync(1_000);
    controller.abort(new DOMException("Stopped by the author.", "AbortError"));
    const { error } = await run;

    expect(error.name).toBe("AbortError");
    expect(fake.calls).toHaveLength(1);
  });

  it("is a cancel and not a timeout when the author stops a fallback that is running on the routing time that was left", async () => {
    const a = compatible("a", [chatModel("model-a")]);
    const b = compatible("b", [chatModel("model-b")]);
    const fake = provide([a, b], (call) => (call.url.includes("a.example.test") ? failAfter(20_000, () => failReply(400, "refused"), call.signal) : drip({ signal: call.signal, pieces: 40, everyMs: 5_000 })));
    const controller = new AbortController();
    const settings = routeOf("copilot", [a, b], { routingExecution: { ...DEFAULT_SETTINGS.routingExecution, maxTotalDurationMs: 60_000 } });
    const run = outcome(completeTextRouted(settings, MESSAGES, "copilot", { accountScope: null, signal: controller.signal }));

    await vi.advanceTimersByTimeAsync(30_000);
    controller.abort(new DOMException("Stopped by the author.", "AbortError"));
    const { error } = await run;
    await vi.advanceTimersByTimeAsync(0);

    expect(error.name).toBe("AbortError");
    expect(hostsOf(fake)).toEqual(["a", "b"]);
    expect(entries()[0]).toMatchObject({ routeCandidateIndex: 1, failureKind: "cancelled" });
    await vi.advanceTimersByTimeAsync(60_000);
    expect(entries()[0].failureKind, "and the routing time that ran out after it changed nothing").toBe("cancelled");
  });

  it("stops a structured call and a confirmation that wait for a provider, without a fallback", async () => {
    const a = compatible("a", [chatModel("model-a")]);
    const b = compatible("b", [chatModel("model-b")]);
    const fake = provide([a, b], (call) => hang(call.signal));
    const settings = routeOf("copilot", [a, b], { taskRouting: { copilot: { primary: { integrationId: "a", model: "model-a" }, fallbacks: [{ integrationId: "b", model: "model-b" }] }, "simple-tasks": { primary: { integrationId: "a", model: "model-a" }, fallbacks: [{ integrationId: "b", model: "model-b" }] } } });
    const tool = new AbortController();
    const first = outcome(completeToolRouted(settings, MESSAGES, "copilot", SCHEMA, { accountScope: null, signal: tool.signal }));
    await vi.advanceTimersByTimeAsync(5_000);
    tool.abort(new DOMException("Stopped.", "AbortError"));
    expect((await first).error.name).toBe("AbortError");

    const confirm = new AbortController();
    const second = outcome(classifyConfirmationRouted(settings, "yes", confirm.signal, null));
    await vi.advanceTimersByTimeAsync(5_000);
    confirm.abort(new DOMException("Stopped.", "AbortError"));
    expect((await second).error.name, "a confirmation that is stopped is not turned into «unclear»").toBe("AbortError");
    expect(hostsOf(fake)).toEqual(["a", "a"]);
  });
});

describe("the total routing time (`maxTotalDurationMs`) is for the fallbacks, as in the run", () => {
  const withTotal = (ms: number) => ({ routingExecution: { ...DEFAULT_SETTINGS.routingExecution, maxTotalDurationMs: ms } });

  it("never interrupts the first candidate: it runs for its own deadlines, however long the total is", async () => {
    const fixture = compatible("a", [chatModel("model-a")]);
    provide([fixture], (call) => drip({ signal: call.signal, pieces: 20, everyMs: 5_000 }));
    const run = outcome(completeTextRouted(routeOf("copilot", [fixture], withTotal(60_000)), MESSAGES, "copilot", { accountScope: null }));

    await vi.advanceTimersByTimeAsync(101_000);

    expect((await run).value, "100 s, with a routing time of 60 s").toBe(spoken(20));
  });

  it("gives a fallback the time that is left, and says so when it runs out", async () => {
    const a = compatible("a", [chatModel("model-a")]);
    const b = compatible("b", [chatModel("model-b")]);
    const fake = provide([a, b], (call) => (call.url.includes("a.example.test") ? failAfter(20_000, () => failReply(400, "refused"), call.signal) : drip({ signal: call.signal, pieces: 40, everyMs: 5_000 })));
    const run = outcome(completeTextRouted(routeOf("copilot", [a, b], withTotal(60_000)), MESSAGES, "copilot", { accountScope: null }));

    await vi.advanceTimersByTimeAsync(20_000);
    expect(hostsOf(fake), "the fallback starts when the primary has failed").toEqual(["a", "b"]);
    await vi.advanceTimersByTimeAsync(39_999);
    expect(fake.calls[1].signal?.aborted, "it has until the end of the routing time").toBe(false);
    await vi.advanceTimersByTimeAsync(1);
    const { error } = await run;

    expect(error.message).toContain("the provider did not finish within the 40 s left of the total routing time (maxTotalDurationMs)");
    expect(entries()[0]).toMatchObject({ routeCandidateIndex: 1, usedFallback: true, status: "error", failureKind: "timeout", timeoutPhase: "total", timeoutMs: 40_000 });
  });

  it("says it in the words of the engine: the sentence is the one that the engine's own client writes for a later candidate that runs out of the routing time", async () => {
    const a = compatible("a", [chatModel("model-a")]);
    const b = compatible("b", [chatModel("model-b")]);
    const settings = routeOf("copilot", [a, b], withTotal(60_000));
    const reply = (call: { url: string; signal: AbortSignal | null }) => (call.url.includes("a.example.test") ? failAfter(20_000, () => failReply(400, "refused"), call.signal) : drip({ signal: call.signal, pieces: 40, everyMs: 5_000 }));

    // The engine's client, given the whole route, with the same routing time.
    const engineFake = provide([a, b], reply);
    const engine = outcome(createFetchAi(pickAiRuntimeConfig(settings), { fetch: engineFake.fetch }).complete({ capability: "copilot", label: "copilot", system: "s", user: "u" }));
    await vi.advanceTimersByTimeAsync(60_000);
    const fromEngine = (await engine).error;
    expect(fromEngine.message).toContain("left of the total routing time (maxTotalDurationMs)");

    // The Copilot, which asks one candidate at a time and keeps the routing time itself.
    provide([a, b], reply);
    const copilot = outcome(completeTextRouted(settings, MESSAGES, "copilot", { accountScope: null }));
    await vi.advanceTimersByTimeAsync(60_000);
    const fromCopilot = (await copilot).error;

    expect(fromCopilot.failures[1]).toBe(fromEngine.message);
  });

  it("does not start a fallback when the routing time is already used up, and says so", async () => {
    const a = compatible("a", [chatModel("model-a")]);
    const b = compatible("b", [chatModel("model-b")]);
    const fake = provide([a, b], (call) => (call.url.includes("a.example.test") ? failAfter(70_000, () => failReply(400, "refused"), call.signal) : textReply("from b")));
    const run = outcome(completeToolRouted(routeOf("copilot", [a, b], withTotal(60_000)), MESSAGES, "copilot", SCHEMA, { accountScope: null }));

    await vi.advanceTimersByTimeAsync(70_000);
    const { error } = await run;

    expect(hostsOf(fake)).toEqual(["a"]);
    expect(error.message).toContain("Fallbacks were not tried: the total routing time (maxTotalDurationMs, 60 s) was used up.");
  });

  it("does not count the time the author takes to decide on a fallback in another account", async () => {
    const a = compatible("a", [chatModel("model-a")]);
    const b = compatible("b", [chatModel("model-b")]);
    const fake = provide([a, b], (call) => (call.url.includes("a.example.test") ? failAfter(30_000, () => failReply(400, "refused"), call.signal) : drip({ signal: call.signal, pieces: 2, everyMs: 5_000 })));
    // The author takes 40 s to say yes: the clock of the day moves while the question is open, and the timers do not.
    vi.spyOn(window, "confirm").mockImplementation(() => { vi.setSystemTime(Date.now() + 40_000); return true; });
    const settings = routeOf("copilot", [a, b], { ...withTotal(60_000), fallbackDisclosure: { sameBoundaryOnly: false, requireAcknowledgement: true } });
    const run = outcome(completeTextRouted(settings, MESSAGES, "copilot", { accountScope: null }));

    await vi.advanceTimersByTimeAsync(30_000);
    await vi.advanceTimersByTimeAsync(11_000);
    const { value, error } = await run;

    expect(error).toBeUndefined();
    expect(value, "30 s + the author's 40 s is more than the 60 s of routing time, but the author's time is not the call's").toBe(spoken(2));
    expect(hostsOf(fake)).toEqual(["a", "b"]);
  });
});
