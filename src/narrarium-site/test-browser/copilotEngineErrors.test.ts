import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { AiProviderError, AiToolsRequiredError } from "narrarium-engine";
import { classifyConfirmationRouted, completeTextRouted, completeToolRouted } from "@/assistant/router";
import { assertProvidersClean, data, eventStream, failReply, textReply, toolReply, USAGE } from "./helpers/fakeProvider";
import { chatModel, compatible, SCHEMA, settingsOf } from "./helpers/aiFixtures";
import { either, entries, failure, hostsOf, MESSAGES, provide, resetStores, routeOf, speak, speakCall, target } from "./helpers/copilotHarness";

beforeEach(resetStores);
afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
  assertProvidersClean();
});

const noTools = (id: string, name = `model-${id}`) => compatible(id, [chatModel(name, { supportsToolCalls: false })], { name: id.toUpperCase() });
const withTools = (id: string) => compatible(id, [chatModel(`model-${id}`, { supportsToolCalls: true })], { name: id.toUpperCase() });

describe("«Tools only», which the Copilot obeys as the run does", () => {
  it("refuses a forced call when no model of the route can call a function, before anything is sent, and says the two ways out", async () => {
    const a = noTools("a");
    const b = noTools("b");
    const fake = provide([a, b], speak("never"));

    const error = await failure(completeToolRouted(routeOf("copilot", [a, b]), MESSAGES, "copilot", SCHEMA, { accountScope: null }));

    expect(error).toBeInstanceOf(AiToolsRequiredError);
    expect(error.models).toEqual(["model-a", "model-b"]);
    expect(error.message).toContain("\"Tools only\" is on");
    expect(error.message).toContain("\"model-a\" in \"A\"");
    expect(error.message).toContain("Turn on \"Forced tool calls\" for the model in AI Integrations, or turn off \"Tools only\" in the AI Router.");
    expect(fake.calls, "nothing was sent").toHaveLength(0);
    expect(entries(), "and no attempt is shown for what was never an attempt").toHaveLength(0);
  });

  it("leaves a model without tool calls out of a forced call and asks the next, whose entry says what was left out", async () => {
    const a = noTools("a");
    const b = withTools("b");
    const fake = provide([a, b], speakCall({ ok: true }));

    const result = await completeToolRouted<{ ok: boolean }>(routeOf("copilot", [a, b]), MESSAGES, "copilot", SCHEMA, { accountScope: null });

    expect(result.output).toEqual({ ok: true });
    expect(hostsOf(fake)).toEqual(["b"]);
    expect(result.metadata).toMatchObject({ integrationId: "b", routeCandidateIndex: 1, usedFallback: true });
    expect(entries()[0]).toMatchObject({ routeCandidateIndex: 1, toolsOnly: true, skipped: [{ model: "model-a", reason: "no-tool-calls" }] });
  });

  it("tells onAttempt the place of the candidate in the route, a model that was left out counted: the second, as in the run", async () => {
    const a = noTools("a");
    const b = withTools("b");
    provide([a, b], speakCall({ ok: true }));
    const attempts: number[] = [];

    await completeToolRouted(routeOf("copilot", [a, b]), MESSAGES, "copilot", SCHEMA, { accountScope: null, onAttempt: (index) => attempts.push(index) });

    expect(attempts).toEqual([1]);
  });

  it("says in the error of a call that failed which models it left out, as the run does", async () => {
    const a = noTools("a");
    const b = withTools("b");
    provide([a, b], () => failReply(400, "refused"));

    const error = await failure(completeToolRouted(routeOf("copilot", [a, b]), MESSAGES, "copilot", SCHEMA, { accountScope: null }));

    expect(error).toBeInstanceOf(AiProviderError);
    expect(error.message).toContain("Skipped \"model-a\" in \"A\": it is marked as without tool calls and \"Tools only\" is on.");
  });

  it("does not touch a request for prose: a model without tool calls writes it as any other", async () => {
    const a = noTools("a");
    const fake = provide([a], speak("A line of prose."));

    await expect(completeTextRouted(routeOf("copilot", [a]), MESSAGES, "copilot", { accountScope: null })).resolves.toBe("A line of prose.");

    expect(hostsOf(fake)).toEqual(["a"]);
  });

  it("does not take the JSON in the text of a reply for the answer: it refuses it, asks the next candidate, and says why when none answers", async () => {
    const a = withTools("a");
    const b = withTools("b");
    const fake = provide([a, b], () => textReply(JSON.stringify({ ok: true })));

    const error = await failure(completeToolRouted(routeOf("copilot", [a, b]), MESSAGES, "copilot", SCHEMA, { accountScope: null }));

    expect(hostsOf(fake)).toEqual(["a", "b"]);
    expect(error).toBeInstanceOf(AiProviderError);
    expect(error.message).toContain("answered in text instead of calling the function \"result\"");
    expect(error.message).toContain("turn off \"Tools only\" in the AI Router");
  });

  it("is a confirmation that is simply unclear when no model can call its function: a helper that never stops the flow", async () => {
    const a = noTools("a");
    const fake = provide([a], speakCall({ decision: "yes" }, USAGE, "confirm"));
    const settings = settingsOf([a], { taskRouting: { "simple-tasks": { primary: target(a), fallbacks: [] } } });

    await expect(classifyConfirmationRouted(settings, "yes", undefined, null)).resolves.toBe("unclear");

    expect(fake.calls).toHaveLength(0);
  });

  describe("turned off in the AI Router", () => {
    it("asks a model without tool calls for the JSON in its message, and reads the JSON of its text", async () => {
      const a = noTools("a");
      const fake = provide([a], () => textReply(JSON.stringify({ ok: true })));

      const result = await completeToolRouted<{ ok: boolean }>(routeOf("copilot", [a], { aiToolsOnly: false }), MESSAGES, "copilot", SCHEMA, { accountScope: null });

      expect(result.output).toEqual({ ok: true });
      expect(fake.calls[0].body.tools).toBeUndefined();
      expect(fake.calls[0].body.messages[0].role).toBe("system");
      expect(String(fake.calls[0].body.messages[0].content)).toContain("You are the Copilot.");
      expect(String(fake.calls[0].body.messages[0].content)).toContain("Reply with ONLY one JSON object");
      expect(fake.calls[0].body.messages[1].content, "the message of the author is as it was").toEqual([{ type: "text", text: "Write a line." }]);
      expect(entries()[0]).toMatchObject({ toolsOnly: false, tools: false, structured: true });
      expect(entries()[0].skipped).toBeUndefined();
    });

    it("reads the JSON that a model wrote in its text when it did not call the function it was asked for", async () => {
      const a = withTools("a");
      provide([a], () => textReply("Here you are: {\"ok\": true}"));

      await expect(completeToolRouted<{ ok: boolean }>(routeOf("copilot", [a], { aiToolsOnly: false }), MESSAGES, "copilot", SCHEMA, { accountScope: null })).resolves.toMatchObject({ output: { ok: true } });
    });

    it("asks every model of the route, those without tool calls included, in their order", async () => {
      const a = noTools("a");
      const b = withTools("b");
      const fake = provide([a, b], (call) => (call.url.includes("a.example.test") ? failReply(400, "refused") : speakCall({ ok: true })(call)));

      await completeToolRouted(routeOf("copilot", [a, b], { aiToolsOnly: false }), MESSAGES, "copilot", SCHEMA, { accountScope: null });

      expect(hostsOf(fake)).toEqual(["a", "b"]);
    });
  });
});

describe("what the author is told when a call fails", () => {
  it("is the sentence of the engine, naming the provider and the model, when the connection cannot be made, once the Copilot has tried again", async () => {
    vi.useFakeTimers();
    const a = compatible("a", [chatModel("muse-glimmer-30b")], { name: "LlmProxy" });
    const fake = provide([a], () => Promise.reject(new TypeError("Failed to fetch")));

    const toolRun = failure(completeToolRouted(routeOf("copilot", [a]), MESSAGES, "copilot", SCHEMA, { accountScope: null }));
    await vi.advanceTimersByTimeAsync(5_000);
    const tool = await toolRun;
    const textRun = failure(completeTextRouted(routeOf("copilot", [a]), MESSAGES, "copilot", { accountScope: null }));
    await vi.advanceTimersByTimeAsync(5_000);
    const text = await textRun;
    expect(fake.calls, "three attempts for each call: the first and two more").toHaveLength(6);

    expect(tool).toBeInstanceOf(AiProviderError);
    expect(tool).toMatchObject({ transient: true });
    expect(tool.message).toBe("openai muse-glimmer-30b: Failed to fetch");
    expect(text.message).toBe("All configured completion candidates failed: openai muse-glimmer-30b: Failed to fetch");
  });

  it("says that the connection was lost while the model answered, and where to look, when a stream breaks", async () => {
    const a = compatible("a", [chatModel("muse-glimmer-30b")], { name: "LlmProxy" });
    provide([a], () => new Response(new ReadableStream({
      start(controller) {
        controller.enqueue(new TextEncoder().encode(data({ choices: [{ delta: { content: "Half a" } }] })));
        controller.error(new TypeError("network error"));
      },
    }), { status: 200, headers: { "content-type": "text/event-stream" } }));

    const error = await failure(completeTextRouted(routeOf("copilot", [a]), MESSAGES, "copilot", { accountScope: null }));

    expect(error.message).toContain("the connection with the provider was lost while it was answering");
    expect(error.message).toContain("check the proxy or the tunnel between this app and the provider");
  });

  it("says what the provider said, without its key, when it refuses the request", async () => {
    const a = compatible("a", [chatModel("model-a")], { name: "Account A" });
    provide([a], () => failReply(401, `Incorrect API key provided: ${a.endpoint.apiKey}`));

    const tool = await failure(completeToolRouted(routeOf("copilot", [a]), MESSAGES, "copilot", SCHEMA, { accountScope: null }));
    const text = await failure(completeTextRouted(routeOf("copilot", [a]), MESSAGES, "copilot", { accountScope: null }));

    for (const error of [tool, text]) {
      expect(error.message).toContain("Incorrect API key provided");
      expect(error.message).not.toContain(a.endpoint.apiKey);
    }
    expect(tool).toMatchObject({ status: 401 });
  });

  it("gives the reason of every candidate that failed, in order, without saying the provider and the model twice", async () => {
    vi.useFakeTimers();
    const a = compatible("a", [chatModel("model-a")]);
    const b = compatible("b", [chatModel("model-b")]);
    provide([a, b], (call) => failReply(call.url.includes("a.example.test") ? 429 : 500, call.url.includes("a.example.test") ? "Rate limit reached" : "Internal error"));

    const run = failure(completeTextRouted(routeOf("copilot", [a, b]), MESSAGES, "copilot", { accountScope: null }));
    // Each of the two candidates was asked three times, with a wait in between: the reason that is kept is the one of its last attempt.
    await vi.advanceTimersByTimeAsync(10_000);
    const error = await run;

    expect(error.message).toMatch(/^All configured completion candidates failed: openai model-a: .*Rate limit reached.*; openai model-b: .*Internal error/s);
    expect(error.message).not.toContain("openai/model-a");
    expect(error.failures).toHaveLength(2);
    expect(error.causes).toEqual([expect.objectContaining({ status: 429 }), expect.objectContaining({ status: 500 })]);
  });

  it("keeps a long sentence of the engine whole: the deadline that ran out, and where it is changed, are the point", async () => {
    vi.useFakeTimers();
    try {
      const name = `LlmProxy of the tunnel ${"behind the studio ".repeat(8)}`.trim();
      const a = compatible("llm", [chatModel("muse-glimmer-30b")], { name, requestTimeoutMs: 6_000 });
      provide([a], (call) => new Promise((_resolve, reject) => call.signal?.addEventListener("abort", () => reject(call.signal?.reason), { once: true })));
      const pending = failure(completeTextRouted(routeOf("copilot", [a]), MESSAGES, "copilot", { accountScope: null }));

      await vi.advanceTimersByTimeAsync(30_000);
      const error = await pending;

      expect(error.failures[0].length, "the sentence of the engine is longer than the 240 characters that an error of any other kind is cut to").toBeGreaterThan(240);
      expect(error.message).toContain(`was 6 s and was raised to the 30 s minimum)`);
    } finally {
      vi.useRealTimers();
    }
  });

  it("is the reason of the caller, in the words of the caller, when a reply is refused by validateText", async () => {
    const a = compatible("a", [chatModel("model-a")]);
    provide([a], speak("not json"));

    const error = await failure(completeTextRouted(routeOf("copilot", [a]), MESSAGES, "copilot", { accountScope: null, validateText: () => { throw new Error("The reply is not the JSON the Copilot asked for"); } }));

    expect(error.message).toBe("All configured completion candidates failed: openai/model-a: The reply is not the JSON the Copilot asked for");
  });

  it("is a decision that the Copilot can read: the reply of a model that is not yes or no is unclear", async () => {
    const a = compatible("a", [chatModel("model-a")]);
    provide([a], () => toolReply({ decision: "perhaps" }));
    const settings = settingsOf([a], { taskRouting: { "simple-tasks": { primary: target(a), fallbacks: [] } } });

    await expect(classifyConfirmationRouted(settings, "perhaps", undefined, null)).resolves.toBe("unclear");
  });
});

describe("a reply that ends in the middle of a stream or without its end", () => {
  it("is an error of the candidate, which is asked again like any passing error, and then the next one is asked", async () => {
    vi.useFakeTimers();
    const a = compatible("a", [chatModel("model-a")]);
    const b = compatible("b", [chatModel("model-b")]);
    const fake = provide([a, b], (call) => (call.url.includes("a.example.test")
      ? either(() => eventStream([data({ choices: [{ delta: { content: "Half a" } }] })]), () => textReply("", null))(call)
      : speak("A whole line.")(call)));

    const run = completeTextRouted(routeOf("copilot", [a, b]), MESSAGES, "copilot", { accountScope: null });
    const settled = run.then((value) => ({ value }), (error) => ({ error }));
    await vi.advanceTimersByTimeAsync(5_000);

    expect(await settled).toEqual({ value: "A whole line." });
    expect(hostsOf(fake)).toEqual(["a", "a", "a", "b"]);
  });
});
