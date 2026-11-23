import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { classifyConfirmationRouted, completeTextRouted, completeToolRouted } from "@/assistant/router";
import { setFallbackAcknowledgementAccountScope } from "@/assistant/fallbackDisclosure";
import { assertProvidersClean, data, eventStream, failReply, hang, textReply, type ProviderCall } from "./helpers/fakeProvider";
import { chatModel, compatible, SCHEMA, settingsOf } from "./helpers/aiFixtures";
import { cutsAfter, cutsOff, DEFAULT_SETTINGS, drip, entries, failAfter, goesSilent, hostsOf, ledger, MESSAGES, provide, resetStores, routeOf, speak, speakCall, target } from "./helpers/copilotHarness";

/** The first wait is about a second and the second about three, each by a quarter either way: the bounds that a test can rely on whatever the jitter is. */
const FIRST = { min: 750, max: 1_250 };
const SECOND = { min: 2_250, max: 3_750 };

/** Follows a promise without awaiting it: a rejection that comes while the clock is being moved is not an unhandled one. */
const outcome = <T>(promise: Promise<T>) => promise.then((value) => ({ value, error: undefined as any }), (error: unknown) => ({ value: undefined as T | undefined, error: error as any }));

/** A provider that fails the first `failures` requests as `fail` says, and then answers as `then` says. */
const flaky = (failures: number, fail: () => Response | Promise<Response>, then: (call: ProviderCall) => Response | Promise<Response>) => {
  let count = 0;
  return (call: ProviderCall) => (++count <= failures ? fail() : then(call));
};
const overloaded = () => failReply(503, "The engine is overloaded");

beforeEach(() => {
  resetStores();
  vi.useFakeTimers();
});
afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
  assertProvidersClean();
});

describe("a passing error is tried again on the same candidate, quietly", () => {
  it("asks a text again after about a second when the provider answered 503, and gives the reply of the second attempt", async () => {
    const a = compatible("a");
    const fake = provide([a], flaky(1, overloaded, speak("A whole line.")));
    const attempts: number[] = [];

    const run = outcome(completeTextRouted(routeOf("copilot", [a]), MESSAGES, "copilot", { accountScope: null, onAttempt: (index) => attempts.push(index) }));
    await vi.advanceTimersByTimeAsync(FIRST.min - 1);
    expect(fake.calls, "not sooner than three quarters of a second").toHaveLength(1);
    await vi.advanceTimersByTimeAsync(FIRST.max - FIRST.min + 1);
    const { value, error } = await run;

    expect(error).toBeUndefined();
    expect(value).toBe("A whole line.");
    expect(hostsOf(fake)).toEqual(["a", "a"]);
    expect(attempts, "it is one candidate that was asked twice").toEqual([0]);
  });

  it("asks a forced call again, and a confirmation too", async () => {
    const a = compatible("a");
    const settings = settingsOf([a], { taskRouting: { copilot: { primary: target(a), fallbacks: [] }, "simple-tasks": { primary: target(a), fallbacks: [] } } });
    const tool = provide([a], flaky(1, overloaded, speakCall({ ok: true })));
    const first = outcome(completeToolRouted<{ ok: boolean }>(settings, MESSAGES, "copilot", SCHEMA, { accountScope: null }));
    await vi.advanceTimersByTimeAsync(FIRST.max);
    expect((await first).value?.output).toEqual({ ok: true });
    expect(hostsOf(tool)).toEqual(["a", "a"]);

    const confirm = provide([a], flaky(1, overloaded, speakCall({ decision: "yes" }, undefined, "confirm")));
    const second = outcome(classifyConfirmationRouted(settings, "yes", undefined, null));
    await vi.advanceTimersByTimeAsync(FIRST.max);
    expect((await second).value).toBe("yes");
    expect(hostsOf(confirm)).toEqual(["a", "a"]);
  });

  it("waits about a second, then about three, and gives up after the third attempt: the error is the one of the provider, as it is", async () => {
    const a = compatible("a");
    const times: number[] = [];
    const fake = provide([a], () => {
      times.push(Date.now());
      return overloaded();
    });
    const start = Date.now();

    const run = outcome(completeTextRouted(routeOf("copilot", [a]), MESSAGES, "copilot", { accountScope: null }));
    await vi.advanceTimersByTimeAsync(FIRST.max + SECOND.max + 1);
    const { error } = await run;

    expect(fake.calls, "the first attempt and two more").toHaveLength(3);
    expect(times[1] - times[0]).toBeGreaterThanOrEqual(FIRST.min);
    expect(times[1] - times[0]).toBeLessThanOrEqual(FIRST.max);
    expect(times[2] - times[1]).toBeGreaterThanOrEqual(SECOND.min);
    expect(times[2] - times[1]).toBeLessThanOrEqual(SECOND.max);
    expect(times[0]).toBe(start);
    expect(error.message).toContain("HTTP 503");
    expect(error.message).toContain("The engine is overloaded");
    await vi.advanceTimersByTimeAsync(60_000);
    expect(fake.calls, "and no fourth").toHaveLength(3);
  });

  it("goes on to the next candidate as soon as the last attempt of the first has failed, with no wait of its own", async () => {
    const a = compatible("a");
    const b = compatible("b");
    const times: Array<[string, number]> = [];
    provide([a, b], (call) => {
      times.push([new URL(call.url).hostname.replace(".example.test", ""), Date.now()]);
      return call.url.includes("a.example.test") ? overloaded() : speak("From b.")(call);
    });

    const run = outcome(completeTextRouted(routeOf("copilot", [a, b]), MESSAGES, "copilot", { accountScope: null }));
    await vi.advanceTimersByTimeAsync(FIRST.max + SECOND.max);
    const { value } = await run;

    expect(value).toBe("From b.");
    expect(times.map(([host]) => host)).toEqual(["a", "a", "a", "b"]);
    expect(times[3][1], "b is asked the moment a has used its attempts").toBe(times[2][1]);
  });

  it("records each attempt as an entry of its own in the panel of AI requests, and in the costs only what the provider billed, once", async () => {
    const a = compatible("a");
    const fake = provide([a], flaky(2, overloaded, speak("A whole line.")));

    const run = outcome(completeTextRouted(routeOf("copilot", [a]), MESSAGES, "copilot", { accountScope: null, label: "copilot:chat" }));
    await vi.advanceTimersByTimeAsync(FIRST.max + SECOND.max);
    await run;

    expect(fake.calls).toHaveLength(3);
    expect(entries().map((entry) => [entry.status, entry.label, entry.routeCandidateIndex, entry.usedFallback])).toEqual([
      ["done", "copilot:chat", 0, false],
      ["error", "copilot:chat", 0, false],
      ["error", "copilot:chat", 0, false],
    ]);
    expect(ledger()).toMatchObject({ inputTokens: 120, cachedTokens: 20, outputTokens: 30 });
  });

  it("tells the caller how the attempt that served it ended, once: the usage and the finish are those of that attempt", async () => {
    const a = compatible("a");
    provide([a], flaky(1, overloaded, speak("A whole line.")));
    const finishes: string[] = [];
    const usages: number[] = [];

    const run = outcome(completeTextRouted(routeOf("copilot", [a]), MESSAGES, "copilot", { accountScope: null, onFinish: (report) => finishes.push(report.finishReason), onUsage: (report) => usages.push(report.inputTokens) }));
    await vi.advanceTimersByTimeAsync(FIRST.max);
    await run;

    expect(finishes).toEqual(["stop"]);
    expect(usages).toEqual([120]);
  });
});

describe("the errors that are a passing moment, and the ones that are not", () => {
  it.each([500, 502, 503, 504, 520])("is tried again when the provider answers %s, three attempts in all", async (status) => {
    const a = compatible("a");
    const fake = provide([a], () => failReply(status, "The node is flaky"));

    const run = outcome(completeTextRouted(routeOf("copilot", [a]), MESSAGES, "copilot", { accountScope: null }));
    await vi.advanceTimersByTimeAsync(FIRST.max + SECOND.max);
    const { error } = await run;

    expect(fake.calls).toHaveLength(3);
    expect(error.message).toContain(`HTTP ${status}`);
  });

  it.each([408, 429])("is tried again when the provider answers %s, which says that it is the moment", async (status) => {
    const a = compatible("a");
    const fake = provide([a], flaky(1, () => failReply(status, "Try again"), speak("A whole line.")));

    const run = outcome(completeTextRouted(routeOf("copilot", [a]), MESSAGES, "copilot", { accountScope: null }));
    await vi.advanceTimersByTimeAsync(FIRST.max);

    expect((await run).value).toBe("A whole line.");
    expect(fake.calls).toHaveLength(2);
  });

  it("is tried again when the connection cannot be made at all", async () => {
    const a = compatible("a");
    let count = 0;
    const fake = provide([a], (call) => (++count === 1 ? Promise.reject(new TypeError("Failed to fetch")) : speak("A whole line.")(call)));

    const run = outcome(completeTextRouted(routeOf("copilot", [a]), MESSAGES, "copilot", { accountScope: null }));
    await vi.advanceTimersByTimeAsync(FIRST.max);

    expect((await run).value).toBe("A whole line.");
    expect(fake.calls).toHaveLength(2);
  });

  it.each([400, 401, 403, 404, 409, 422])("is never tried again when the provider answers %s: the request itself is refused, and waiting does not change it", async (status) => {
    const a = compatible("a");
    const fake = provide([a], () => failReply(status, "Refused"));

    const run = outcome(completeTextRouted(routeOf("copilot", [a]), MESSAGES, "copilot", { accountScope: null }));
    await vi.advanceTimersByTimeAsync(0);
    const { error } = await run;
    await vi.advanceTimersByTimeAsync(30_000);

    expect(fake.calls, "one attempt, and no wait").toHaveLength(1);
    expect(error.message).toContain(`HTTP ${status}`);
  });

  it("is never tried again, in a forced call and in a confirmation either, when the request is refused", async () => {
    const a = compatible("a");
    const settings = settingsOf([a], { taskRouting: { copilot: { primary: target(a), fallbacks: [] }, "simple-tasks": { primary: target(a), fallbacks: [] } } });
    const fake = provide([a], () => failReply(401, "Incorrect API key provided"));

    const tool = await outcome(completeToolRouted(settings, MESSAGES, "copilot", SCHEMA, { accountScope: null }));
    const confirmation = await outcome(classifyConfirmationRouted(settings, "yes", undefined, null));
    await vi.advanceTimersByTimeAsync(30_000);

    expect(tool.error.message).toContain("HTTP 401");
    expect(confirmation.value).toBe("unclear");
    expect(fake.calls, "one attempt for each").toHaveLength(2);
  });

  it("goes on to the fallback at once when the first candidate is refused", async () => {
    const a = compatible("a");
    const b = compatible("b");
    const fake = provide([a, b], (call) => (call.url.includes("a.example.test") ? failReply(400, "Refused") : speak("From b.")(call)));

    const run = outcome(completeTextRouted(routeOf("copilot", [a, b]), MESSAGES, "copilot", { accountScope: null }));
    await vi.advanceTimersByTimeAsync(0);

    expect((await run).value).toBe("From b.");
    expect(hostsOf(fake)).toEqual(["a", "b"]);
  });

  it("is never tried again when the model ran out of time: waiting the same minutes a second time is no blip, and the fallback is asked at once", async () => {
    const a = compatible("a", [chatModel("model-a")], { idleTimeoutMs: 30_000 });
    const b = compatible("b");
    const fake = provide([a, b], (call) => (call.url.includes("a.example.test") ? goesSilent(call.signal) : speak("From b.")(call)));

    const run = outcome(completeTextRouted(routeOf("copilot", [a, b]), MESSAGES, "copilot", { accountScope: null }));
    await vi.advanceTimersByTimeAsync(30_000);

    expect((await run).value).toBe("From b.");
    expect(hostsOf(fake)).toEqual(["a", "b"]);
  });

  it("is never tried again when the provider did not start answering in time, nor when it went silent while it answered", async () => {
    const a = compatible("a", [chatModel("model-a")], { requestTimeoutMs: 30_000 });
    const fake = provide([a], (call) => hang(call.signal));
    const start = outcome(completeTextRouted(routeOf("copilot", [a]), MESSAGES, "copilot", { accountScope: null }));
    await vi.advanceTimersByTimeAsync(30_000);
    expect((await start).error.message).toContain("did not start answering within 30 s");
    await vi.advanceTimersByTimeAsync(120_000);
    expect(fake.calls).toHaveLength(1);

    const silent = compatible("s", [chatModel("model-s")], { idleTimeoutMs: 30_000 });
    const second = provide([silent], (call) => goesSilent(call.signal));
    const idle = outcome(completeToolRouted(routeOf("copilot", [silent]), MESSAGES, "copilot", SCHEMA, { accountScope: null }));
    await vi.advanceTimersByTimeAsync(30_000);
    expect((await idle).error.message).toContain("sent nothing for 30 s");
    await vi.advanceTimersByTimeAsync(120_000);
    expect(second.calls).toHaveLength(1);
  });

  it("is never tried again when the routing time that was left for a fallback ran out", async () => {
    const a = compatible("a");
    const b = compatible("b");
    const settings = routeOf("copilot", [a, b], { routingExecution: { ...DEFAULT_SETTINGS.routingExecution, maxTotalDurationMs: 60_000 } });
    const fake = provide([a, b], (call) => (call.url.includes("a.example.test") ? failAfter(20_000, () => failReply(400, "Refused"), call.signal) : drip({ signal: call.signal, pieces: 40, everyMs: 5_000 })));

    const run = outcome(completeTextRouted(settings, MESSAGES, "copilot", { accountScope: null }));
    await vi.advanceTimersByTimeAsync(60_000);
    const { error } = await run;
    await vi.advanceTimersByTimeAsync(60_000);

    expect(error.message).toContain("left of the total routing time");
    expect(hostsOf(fake), "b ran out of the time that was left and was not asked a second time").toEqual(["a", "b"]);
  });

  it("is never tried again when the reply was refused: empty, filtered, or text where the function was expected", async () => {
    const a = compatible("a");
    const settings = routeOf("copilot", [a]);

    const empty = provide([a], () => textReply("", null));
    await outcome(completeTextRouted(settings, MESSAGES, "copilot", { accountScope: null }));
    expect(empty.calls).toHaveLength(1);

    const filtered = provide([a], () => eventStream([data({ choices: [{ delta: { content: "I cannot" } }] }), data({ choices: [{ delta: {}, finish_reason: "content_filter" }] }), "data: [DONE]\n\n"]));
    await outcome(completeTextRouted(settings, MESSAGES, "copilot", { accountScope: null }));
    expect(filtered.calls).toHaveLength(1);

    const text = provide([a], () => textReply(JSON.stringify({ ok: true })));
    await outcome(completeToolRouted(settings, MESSAGES, "copilot", SCHEMA, { accountScope: null }));
    expect(text.calls).toHaveLength(1);

    await vi.advanceTimersByTimeAsync(30_000);
    expect(empty.calls).toHaveLength(1);
  });

  it("is never tried again when it is the Copilot that does not accept the reply: the next candidate is asked, not the same one", async () => {
    const a = compatible("a");
    const b = compatible("b");
    const fake = provide([a, b], (call) => speak(call.url.includes("a.example.test") ? "not json" : "{\"ok\":true}")(call));

    const run = outcome(completeTextRouted(routeOf("copilot", [a, b]), MESSAGES, "copilot", { accountScope: null, validateText: (text) => { JSON.parse(text); } }));
    await vi.advanceTimersByTimeAsync(0);

    expect((await run).value).toBe("{\"ok\":true}");
    expect(hostsOf(fake)).toEqual(["a", "b"]);
  });
});

describe("what the provider says about when to come back", () => {
  it("is waited for when it is more than the Copilot would have waited: never sooner than Retry-After", async () => {
    const a = compatible("a");
    const fake = provide([a], flaky(1, () => failReply(429, "Rate limit reached", { "retry-after": "2" }), speak("A whole line.")));

    const run = outcome(completeTextRouted(routeOf("copilot", [a]), MESSAGES, "copilot", { accountScope: null }));
    await vi.advanceTimersByTimeAsync(1_999);
    expect(fake.calls, "the provider said two seconds").toHaveLength(1);
    await vi.advanceTimersByTimeAsync(1);

    expect((await run).value).toBe("A whole line.");
    expect(fake.calls).toHaveLength(2);
  });

  it("is waited for up to ten seconds, and the retry is made then", async () => {
    const a = compatible("a");
    const fake = provide([a], flaky(1, () => failReply(503, "Busy", { "retry-after": "10" }), speak("A whole line.")));

    const run = outcome(completeTextRouted(routeOf("copilot", [a]), MESSAGES, "copilot", { accountScope: null }));
    await vi.advanceTimersByTimeAsync(9_999);
    expect(fake.calls).toHaveLength(1);
    await vi.advanceTimersByTimeAsync(1);

    expect((await run).value).toBe("A whole line.");
  });

  it("is not waited for when it is more than ten seconds: that is not a blip, and the error is shown as it is", async () => {
    const a = compatible("a");
    const fake = provide([a], () => failReply(429, "Rate limit reached", { "retry-after": "120" }));

    const run = outcome(completeTextRouted(routeOf("copilot", [a]), MESSAGES, "copilot", { accountScope: null }));
    await vi.advanceTimersByTimeAsync(0);
    const { error } = await run;
    await vi.advanceTimersByTimeAsync(120_000);

    expect(fake.calls).toHaveLength(1);
    expect(error.message).toContain("HTTP 429");
  });

  it("is not waited for when it is more than ten seconds, and the fallback is asked at once", async () => {
    const a = compatible("a");
    const b = compatible("b");
    const fake = provide([a, b], (call) => (call.url.includes("a.example.test") ? failReply(503, "Busy", { "retry-after": "11" }) : speak("From b.")(call)));

    const run = outcome(completeTextRouted(routeOf("copilot", [a, b]), MESSAGES, "copilot", { accountScope: null }));
    await vi.advanceTimersByTimeAsync(0);

    expect((await run).value).toBe("From b.");
    expect(hostsOf(fake)).toEqual(["a", "b"]);
  });
});

describe("a reply that was already streaming when the connection was lost", () => {
  it("starts again from the beginning: the text so far is replaced, never added to", async () => {
    const a = compatible("a");
    let count = 0;
    provide([a], (call) => (++count === 1 ? cutsOff("Half a li") : speak("A whole line.")(call)));
    const seen: string[] = [];

    const run = outcome(completeTextRouted(routeOf("copilot", [a]), MESSAGES, "copilot", { accountScope: null, onText: (text) => seen.push(text) }));
    await vi.advanceTimersByTimeAsync(FIRST.max);
    const { value } = await run;

    expect(value).toBe("A whole line.");
    const half = seen.indexOf("Half a li");
    expect(half, "the first attempt's text was shown").toBeGreaterThanOrEqual(0);
    expect(seen[half + 1], "and taken away when the connection was lost, before the wait").toBe("");
    expect(seen[seen.length - 1]).toBe("A whole line.");
    expect(seen.filter((text) => text.includes("Half a li") && text.includes("whole")), "never one text made of both").toEqual([]);
    expect(seen.filter((text) => text.startsWith("Half") && text !== "Half a li")).toEqual([]);
  });

  it("starts again when the provider reports an overload inside the stream, after it had written", async () => {
    const a = compatible("a");
    let count = 0;
    const fake = provide([a], (call) => (++count === 1
      ? eventStream([data({ choices: [{ delta: { content: "Half a li" } }] }), data({ error: { message: "The engine is overloaded" } })])
      : speak("A whole line.")(call)));
    const seen: string[] = [];

    const run = outcome(completeTextRouted(routeOf("copilot", [a]), MESSAGES, "copilot", { accountScope: null, onText: (text) => seen.push(text) }));
    await vi.advanceTimersByTimeAsync(FIRST.max);

    expect((await run).value).toBe("A whole line.");
    expect(fake.calls).toHaveLength(2);
    expect(seen.filter((text) => text.includes("Half a li") && text.includes("whole"))).toEqual([]);
  });

  it("starts again from the beginning when the arguments of a forced call were cut in the middle", async () => {
    const a = compatible("a");
    let count = 0;
    const fake = provide([a], (call) => (++count === 1
      ? cutsAfter(data({ choices: [{ delta: { tool_calls: [{ index: 0, id: "call_1", type: "function", function: { name: "result", arguments: "{\"ok\":" } }] } }] }))
      : speakCall({ ok: true })(call)));

    const run = outcome(completeToolRouted<{ ok: boolean }>(routeOf("copilot", [a]), MESSAGES, "copilot", SCHEMA, { accountScope: null }));
    await vi.advanceTimersByTimeAsync(FIRST.max);

    expect((await run).value?.output).toEqual({ ok: true });
    expect(fake.calls).toHaveLength(2);
  });

  it("does not hand the half line of the attempt that was lost to the next one when that one is cut by the output limit with nothing written", async () => {
    const a = compatible("a");
    let count = 0;
    provide([a], () => (++count === 1 ? cutsOff("Half a li") : eventStream([data({ choices: [{ delta: {}, finish_reason: "length" }] }), "data: [DONE]\n\n"])));

    const run = outcome(completeTextRouted(routeOf("copilot", [a]), MESSAGES, "copilot", { accountScope: null }));
    await vi.advanceTimersByTimeAsync(FIRST.max + SECOND.max);
    const { value, error } = await run;

    expect(value, "the second attempt wrote nothing: the first one's half line is not its reply").toBeUndefined();
    expect(error).toBeInstanceOf(Error);
  });
});

describe("the author's Stop, while the Copilot waits", () => {
  it("ends the wait at once, and the call ends as a stop: no error, and no attempt after it", async () => {
    const a = compatible("a");
    const fake = provide([a], overloaded);
    const controller = new AbortController();

    const run = outcome(completeTextRouted(routeOf("copilot", [a]), MESSAGES, "copilot", { accountScope: null, signal: controller.signal }));
    await vi.advanceTimersByTimeAsync(300);
    expect(fake.calls).toHaveLength(1);
    controller.abort(new DOMException("Stopped by the author.", "AbortError"));
    const { error } = await run;
    await vi.advanceTimersByTimeAsync(30_000);

    expect(error.name).toBe("AbortError");
    expect(error.message).toBe("Stopped by the author.");
    expect(fake.calls, "the attempt that failed, and no other").toHaveLength(1);
  });

  it("ends the wait of a forced call and of a confirmation at once too", async () => {
    const a = compatible("a");
    const settings = settingsOf([a], { taskRouting: { copilot: { primary: target(a), fallbacks: [] }, "simple-tasks": { primary: target(a), fallbacks: [] } } });
    const fake = provide([a], overloaded);
    const tool = new AbortController();
    const confirm = new AbortController();

    const first = outcome(completeToolRouted(settings, MESSAGES, "copilot", SCHEMA, { accountScope: null, signal: tool.signal }));
    const second = outcome(classifyConfirmationRouted(settings, "yes", confirm.signal, null));
    await vi.advanceTimersByTimeAsync(300);
    tool.abort(new DOMException("Stopped.", "AbortError"));
    confirm.abort(new DOMException("Stopped.", "AbortError"));

    expect((await first).error.name).toBe("AbortError");
    expect((await second).error.name, "a confirmation that is stopped is not turned into «unclear»").toBe("AbortError");
    await vi.advanceTimersByTimeAsync(30_000);
    expect(fake.calls).toHaveLength(2);
  });

  it("ends the wait when the signed-in account changes: the content is not asked again for an account that left", async () => {
    const a = compatible("a");
    setFallbackAcknowledgementAccountScope("google:first@example.com");
    const fake = provide([a], overloaded);

    const run = outcome(completeTextRouted(routeOf("copilot", [a]), MESSAGES, "copilot", { accountScope: "google:first@example.com" }));
    await vi.advanceTimersByTimeAsync(300);
    setFallbackAcknowledgementAccountScope("google:second@example.com");
    const { error } = await run;
    await vi.advanceTimersByTimeAsync(30_000);

    expect(error.name).toBe("AbortError");
    expect(fake.calls).toHaveLength(1);
  });

  it("is a stop of the second attempt as well, in the middle of its stream, and the entry of that attempt says that it was cancelled", async () => {
    const a = compatible("a");
    let count = 0;
    provide([a], (call) => (++count === 1 ? overloaded() : drip({ signal: call.signal, pieces: 30, everyMs: 3_000 })));
    const controller = new AbortController();

    const run = outcome(completeTextRouted(routeOf("copilot", [a]), MESSAGES, "copilot", { accountScope: null, signal: controller.signal }));
    await vi.advanceTimersByTimeAsync(FIRST.max + 10_000);
    controller.abort(new DOMException("Stopped by the author.", "AbortError"));
    const { error } = await run;
    await vi.advanceTimersByTimeAsync(0);

    expect(error.name).toBe("AbortError");
    expect(entries().map((entry) => entry.failureKind)).toEqual(["cancelled", "provider"]);
  });
});

describe("the routing time (maxTotalDurationMs), which a wait must leave room in", () => {
  const within = (maxTotalDurationMs: number) => ({ routingExecution: { ...DEFAULT_SETTINGS.routingExecution, maxTotalDurationMs } });

  it("does not wait when the routing time that is left is shorter than the wait: the error is shown at once, as it is", async () => {
    const a = compatible("a");
    const fake = provide([a], overloaded);

    const run = outcome(completeTextRouted(routeOf("copilot", [a], within(FIRST.min - 50)), MESSAGES, "copilot", { accountScope: null }));
    await vi.advanceTimersByTimeAsync(0);
    const { error } = await run;
    await vi.advanceTimersByTimeAsync(30_000);

    expect(fake.calls).toHaveLength(1);
    expect(error.message).toContain("HTTP 503");
  });

  it("waits when the routing time leaves room for the wait and the attempt after it", async () => {
    const a = compatible("a");
    const fake = provide([a], flaky(1, overloaded, speak("A whole line.")));

    const run = outcome(completeTextRouted(routeOf("copilot", [a], within(5_000)), MESSAGES, "copilot", { accountScope: null }));
    await vi.advanceTimersByTimeAsync(FIRST.max);

    expect((await run).value).toBe("A whole line.");
    expect(fake.calls).toHaveLength(2);
  });

  it("counts the time of the failed attempt: a provider that takes its time to answer 503 leaves less to wait with", async () => {
    const a = compatible("a");
    const fake = provide([a], (call) => failAfter(900, overloaded, call.signal));

    const run = outcome(completeTextRouted(routeOf("copilot", [a], within(1_500)), MESSAGES, "copilot", { accountScope: null }));
    await vi.advanceTimersByTimeAsync(900);
    const { error } = await run;
    await vi.advanceTimersByTimeAsync(30_000);

    expect(fake.calls, "900 ms spent and a wait of 750 or more do not fit in 1 500").toHaveLength(1);
    expect(error.message).toContain("HTTP 503");
  });

  it("runs the attempt after the wait on the routing time that is left, and does not try again the one that ran out of it", async () => {
    const a = compatible("a");
    let count = 0;
    const fake = provide([a], (call) => (++count === 1 ? overloaded() : drip({ signal: call.signal, pieces: 40, everyMs: 5_000 })));

    const run = outcome(completeTextRouted(routeOf("copilot", [a], within(10_000)), MESSAGES, "copilot", { accountScope: null }));
    await vi.advanceTimersByTimeAsync(10_000);
    const { error } = await run;
    await vi.advanceTimersByTimeAsync(60_000);

    expect(error.message).toContain("left of the total routing time (maxTotalDurationMs)");
    expect(fake.calls, "the second attempt was cut at the end of the routing time, and there was no third").toHaveLength(2);
    expect(entries()[0]).toMatchObject({ failureKind: "timeout", timeoutPhase: "total" });
  });

  it("does not delay the first attempt of a call by the routing time, however short it is", async () => {
    const a = compatible("a");
    provide([a], (call) => drip({ signal: call.signal, pieces: 10, everyMs: 5_000 }));

    const run = outcome(completeTextRouted(routeOf("copilot", [a], within(1_000)), MESSAGES, "copilot", { accountScope: null }));
    await vi.advanceTimersByTimeAsync(51_000);

    expect((await run).error).toBeUndefined();
  });
});
