import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { classifyConfirmationRouted, completeTextRouted, completeToolRouted } from "@/assistant/router";
import { setFallbackAcknowledgementAccountScope } from "@/assistant/fallbackDisclosure";
import { chatDelta } from "@/costs/costsStore";
import { LLM_DEBUG_ERROR_REDACTED, LLM_DEBUG_REDACTED, useLlmDebugStore } from "@/debug/llmDebugStore";
import { assertProvidersClean, data, DONE, eventStream, failReply, hang, textReply, USAGE } from "./helpers/fakeProvider";
import { chatModel, compatible, PRICE, SCHEMA, settingsOf } from "./helpers/aiFixtures";
import { either, entries, failure, hostsOf, ledger, MESSAGES, provide, resetStores, routeOf, speak, speakCall, target } from "./helpers/copilotHarness";

beforeEach(resetStores);
afterEach(() => {
  vi.unstubAllGlobals();
  vi.useRealTimers();
  assertProvidersClean();
});

const SECRET_PROMPT = "THE-UNPUBLISHED-MANUSCRIPT";
const SECRET_REPLY = "THE-SECRET-REPLY";

describe("every call appears once in the debug panel and once in the costs", () => {
  it("opens one entry for a text, one for a forced call and one for a confirmation, with the label of the caller or the one it always had", async () => {
    const a = compatible("a");
    provide([a], (call) => (call.body.tools ? speakCall(call.body.tools[0].function.name === "confirm" ? { decision: "yes" } : { ok: true }, USAGE, call.body.tools[0].function.name)(call) : speak("A line.")(call)));
    const settings = settingsOf([a], { taskRouting: { copilot: { primary: target(a), fallbacks: [] }, review: { primary: target(a), fallbacks: [] }, "simple-tasks": { primary: target(a), fallbacks: [] } } });

    await completeTextRouted(settings, MESSAGES, "copilot", { accountScope: null, label: "copilot:chat" });
    await completeTextRouted(settings, MESSAGES, "copilot", { accountScope: null });
    await completeTextRouted(settings, MESSAGES, "review", { accountScope: null });
    await completeToolRouted(settings, MESSAGES, "copilot", SCHEMA, { accountScope: null, label: "copilot:plan" });
    await completeToolRouted(settings, MESSAGES, "copilot", SCHEMA, { accountScope: null });
    await classifyConfirmationRouted(settings, "yes", undefined, null);

    expect(entries().map((entry) => entry.label).reverse()).toEqual(["copilot:chat", "writing", "review", "copilot:plan", "copilot", "confirm"]);
    expect(entries().every((entry) => entry.status === "done" && entry.kind === "chat")).toBe(true);
    expect(useLlmDebugStore.getState().pending, "every entry that was opened was closed").toBe(0);
  });

  it("opens one entry for each attempt, with its place in the route, and says which of them was a fallback", async () => {
    const a = compatible("a");
    const b = compatible("b");
    provide([a, b], (call) => (call.url.includes("a.example.test") ? failReply(400, "refused") : speak("From b.")(call)));

    await completeTextRouted(routeOf("copilot", [a, b]), MESSAGES, "copilot", { accountScope: null, label: "copilot:chat" });

    const [second, first] = entries();
    expect(first).toMatchObject({ status: "error", label: "copilot:chat", model: "model-a", provider: "openai", routeCandidateIndex: 0, usedFallback: false, failureKind: "provider" });
    expect(second).toMatchObject({ status: "done", label: "copilot:chat", model: "model-b", provider: "openai", routeCandidateIndex: 1, usedFallback: true });
    expect(first.integrationId).toMatch(/^integration:[0-9a-f]{16}$/);
    expect(first.integrationId).not.toBe(second.integrationId);
  });

  it("keeps the place of a candidate that the budget left out: the entry of the second says that it is the second", async () => {
    const small = compatible("small", [chatModel("model-small", { maxInputTokens: 1_000, maxOutputTokens: 100 })]);
    const big = compatible("big", [chatModel("model-big", { maxInputTokens: 200_000, maxOutputTokens: 100 })]);
    provide([small, big], speak("From big."));

    await completeTextRouted(routeOf("copilot", [small, big]), [{ role: "user", content: "x".repeat(20_000) }], "copilot", { accountScope: null, overflow: "fail" });

    expect(entries()).toHaveLength(1);
    expect(entries()[0]).toMatchObject({ model: "model-big", routeCandidateIndex: 1, usedFallback: true });
  });

  it("gives the Copilot's attempts the details of the autopilot's: how it asks, whether it streams, its thinking and its deadlines", async () => {
    const a = compatible("a", [chatModel("model-a")], { thinking: "high", requestTimeoutMs: 45_000, idleTimeoutMs: 90_000 });
    provide([a], speakCall({ ok: true }));

    await completeToolRouted(routeOf("copilot", [a]), MESSAGES, "copilot", SCHEMA, { accountScope: null });

    expect(entries()[0]).toMatchObject({
      status: "done",
      structured: true,
      tools: true,
      stream: true,
      streamMode: "auto",
      toolsOnly: true,
      thinking: "high",
      streamed: true,
      toolCalled: true,
      timeouts: { startMs: 45_000, idleMs: 90_000, capMs: 14_400_000 },
    });
    expect(entries()[0].firstByteMs).toBeGreaterThanOrEqual(0);
  });

  it("says in the entry of a text that it was not a forced call, and in the entry of a confirmation that it was", async () => {
    const a = compatible("a");
    provide([a], (call) => (call.body.tools ? speakCall({ decision: "no" }, USAGE, "confirm")(call) : speak("A line.")(call)));
    const settings = settingsOf([a], { taskRouting: { copilot: { primary: target(a), fallbacks: [] }, "simple-tasks": { primary: target(a), fallbacks: [] } } });

    await completeTextRouted(settings, MESSAGES, "copilot", { accountScope: null });
    await classifyConfirmationRouted(settings, "no", undefined, null);

    const [confirmation, text] = entries();
    expect(text).toMatchObject({ structured: false, tools: false, stream: true });
    expect(confirmation).toMatchObject({ structured: true, tools: true, stream: true, toolCalled: true });
  });

  it("keeps no prompt, no reply, no error text and no key", async () => {
    const a = compatible("a");
    const b = compatible("b");
    provide([a, b], (call) => (call.url.includes("a.example.test")
      ? failReply(401, `Incorrect API key provided: ${a.endpoint.apiKey}`)
      : speak(SECRET_REPLY)(call)));

    await completeTextRouted(routeOf("copilot", [a, b]), [{ role: "system", content: "You are the Copilot." }, { role: "user", content: [{ type: "text", text: SECRET_PROMPT }] }], "copilot", { accountScope: null });

    const stored = JSON.stringify(entries());
    for (const forbidden of [SECRET_PROMPT, SECRET_REPLY, a.endpoint.apiKey, b.endpoint.apiKey, "Incorrect API key", "example.test", "private-customer"]) expect(stored).not.toContain(forbidden);
    const [second, first] = entries();
    expect(first.messages?.map((message) => message.content)).toEqual([LLM_DEBUG_REDACTED, LLM_DEBUG_REDACTED]);
    expect(first.error).toBe(LLM_DEBUG_ERROR_REDACTED);
    expect(second.response).toBe(LLM_DEBUG_REDACTED);
  });

  it("closes the entry of a call that the author stopped as cancelled, with no cost, and leaves no entry open", async () => {
    const a = compatible("a");
    const fake = provide([a], (call) => hang(call.signal));
    const controller = new AbortController();
    const pending = failure(completeToolRouted(routeOf("copilot", [a]), MESSAGES, "copilot", SCHEMA, { accountScope: null, signal: controller.signal }));
    await vi.waitFor(() => expect(fake.calls).toHaveLength(1));

    controller.abort(new DOMException("Stopped by the author.", "AbortError"));

    expect((await pending).name).toBe("AbortError");
    // The call is over the moment the author stops it; the panel closes the entry of the attempt a few steps later.
    await vi.waitFor(() => expect(entries()[0]).toMatchObject({ status: "error", failureKind: "cancelled" }));
    expect(useLlmDebugStore.getState().pending).toBe(0);
    expect(ledger()).toBeUndefined();
  });
});

describe("what a call cost", () => {
  it("is recorded once, at the price of the model, and the panel and the costs agree", async () => {
    const a = compatible("a", [chatModel("model-a", { pricing: PRICE })]);
    provide([a], speak("A line.", { prompt_tokens: 1_000, completion_tokens: 500, prompt_tokens_details: { cached_tokens: 200 } }));

    await completeTextRouted(routeOf("copilot", [a]), MESSAGES, "copilot", { accountScope: null });

    const expected = chatDelta({ inputTokens: 1_000, cachedTokens: 200, outputTokens: 500 }, PRICE).chatCost!;
    expect(ledger()).toMatchObject({ bookId: "book-1", inputTokens: 1_000, cachedTokens: 200, outputTokens: 500 });
    expect(ledger().chatCost).toBeCloseTo(expected, 10);
    expect(ledger().models?.["model-a"]).toMatchObject({ inputTokens: 1_000, cachedTokens: 200, outputTokens: 500 });
    expect(entries()).toHaveLength(1);
    expect(entries()[0]).toMatchObject({ inputTokens: 1_000, cachedTokens: 200, outputTokens: 500 });
    expect(entries()[0].cost).toBeCloseTo(expected, 10);
  });

  it("is recorded once for a forced call and once for a confirmation too", async () => {
    const a = compatible("a", [chatModel("model-a", { pricing: PRICE })]);
    provide([a], (call) => speakCall(call.body.tools[0].function.name === "confirm" ? { decision: "yes" } : { ok: true }, { prompt_tokens: 1_000, completion_tokens: 500 }, call.body.tools[0].function.name)(call));
    const settings = settingsOf([a], { taskRouting: { copilot: { primary: target(a), fallbacks: [] }, "simple-tasks": { primary: target(a), fallbacks: [] } } });

    await completeToolRouted(settings, MESSAGES, "copilot", SCHEMA, { accountScope: null });
    expect(ledger()).toMatchObject({ inputTokens: 1_000, outputTokens: 500 });
    await classifyConfirmationRouted(settings, "yes", undefined, null);
    expect(ledger()).toMatchObject({ inputTokens: 2_000, outputTokens: 1_000 });
    expect(ledger().chatCost).toBeCloseTo(2 * chatDelta({ inputTokens: 1_000, cachedTokens: 0, outputTokens: 500 }, PRICE).chatCost!, 10);
  });

  it("is recorded for the attempts that the provider billed and the caller then refused, once each, so nothing is lost or counted twice", async () => {
    const a = compatible("a", [chatModel("model-a", { pricing: PRICE })]);
    const b = compatible("b", [chatModel("model-b", { pricing: PRICE })]);
    provide([a, b], (call) => speakCall({ score: call.url.includes("a.example.test") ? -1 : 8 }, call.url.includes("a.example.test") ? { prompt_tokens: 800, completion_tokens: 40 } : { prompt_tokens: 800, completion_tokens: 30 })(call));

    await completeToolRouted<{ score: number }>(routeOf("copilot", [a, b]), MESSAGES, "copilot", { name: "result", description: "A result", parameters: {} }, {
      accountScope: null,
      validate: (value) => {
        const score = (value as { score?: unknown }).score;
        if (typeof score !== "number" || score < 0) throw new Error("invalid score");
        return { score };
      },
    });

    expect(ledger()).toMatchObject({ inputTokens: 1_600, outputTokens: 70 });
    expect(ledger().models?.["model-a"]).toMatchObject({ inputTokens: 800, outputTokens: 40 });
    expect(ledger().models?.["model-b"]).toMatchObject({ inputTokens: 800, outputTokens: 30 });
    expect(entries()).toHaveLength(2);
  });

  it("is recorded for the tokens of a reply that was cut, when the provider counted them, and for nothing the provider did not", async () => {
    const a = compatible("a", [chatModel("model-a", { pricing: PRICE })]);
    const cut = { prompt_tokens: 800, completion_tokens: 2_048 };
    provide([a], either(() => eventStream([data({ choices: [{ delta: { content: "Half a line" } }] }), data({ choices: [{ delta: {}, finish_reason: "length" }] }), data({ choices: [], usage: cut }), DONE]), () => textReply("Half a line", cut, "length")));

    await completeTextRouted(routeOf("copilot", [a]), MESSAGES, "copilot", { accountScope: null });
    expect(ledger()).toMatchObject({ inputTokens: 800, outputTokens: 2_048 });

    resetStores();
    provide([a], () => failReply(500, "Internal error"));
    await failure(completeTextRouted(routeOf("copilot", [a]), MESSAGES, "copilot", { accountScope: null }));
    expect(ledger()).toBeUndefined();
  });

  it("leaves a model that has no price with tokens and no cost, as it always did", async () => {
    const a = compatible("a", [{ id: "free", name: "free-model", capabilities: ["default"] }]);
    provide([a], speak("A line.", { prompt_tokens: 100, completion_tokens: 20 }));

    await completeTextRouted(routeOf("copilot", [a]), MESSAGES, "copilot", { accountScope: null });

    expect(entries()[0]).toMatchObject({ inputTokens: 100, outputTokens: 20 });
    expect(entries()[0].cost).toBeUndefined();
    expect(ledger()).toBeUndefined();
  });
});

describe("what a forced call says of the run that served it", () => {
  it("names the attempt (the entry of the debug panel), the model, the tokens the provider counted, their cost and the currency of the settings", async () => {
    const a = compatible("a", [chatModel("model-a", { pricing: PRICE })]);
    provide([a], speakCall({ ok: true }, { prompt_tokens: 1_000, completion_tokens: 500, prompt_tokens_details: { cached_tokens: 200 } }));

    const result = await completeToolRouted<{ ok: boolean }>(routeOf("copilot", [a]), MESSAGES, "copilot", SCHEMA, { accountScope: null });

    expect(result.output).toEqual({ ok: true });
    expect(result.metadata).toMatchObject({
      requestId: entries()[0].id,
      task: "copilot",
      provider: "openai",
      integrationId: "a",
      model: "model-a",
      inputTokens: 1_000,
      cachedInputTokens: 200,
      outputTokens: 500,
      currency: "EUR",
      routeCandidateIndex: 0,
      usedFallback: false,
    });
    expect(result.metadata.cost).toBeCloseTo(chatDelta({ inputTokens: 1_000, cachedTokens: 200, outputTokens: 500 }, PRICE).chatCost!, 10);
  });

  it("says zero tokens, and no more, when the provider counted none", async () => {
    const a = compatible("a", [chatModel("model-a", { pricing: PRICE })]);
    provide([a], speakCall({ ok: true }, null));

    const result = await completeToolRouted<{ ok: boolean }>(routeOf("copilot", [a]), MESSAGES, "copilot", SCHEMA, { accountScope: null });

    expect(result.metadata).toMatchObject({ inputTokens: 0, cachedInputTokens: 0, outputTokens: 0 });
    expect(ledger()).toBeUndefined();
  });

  it("is the one of the fallback that served it, and of that one alone", async () => {
    const a = compatible("a", [chatModel("model-a", { pricing: PRICE })]);
    const b = compatible("b", [chatModel("model-b", { pricing: PRICE })]);
    const fake = provide([a, b], (call) => (call.url.includes("a.example.test") ? failReply(400, "refused") : speakCall({ ok: true }, { prompt_tokens: 50, completion_tokens: 5 })(call)));

    const result = await completeToolRouted<{ ok: boolean }>(routeOf("copilot", [a, b]), MESSAGES, "copilot", SCHEMA, { accountScope: null });

    expect(hostsOf(fake)).toEqual(["a", "b"]);
    expect(result.metadata).toMatchObject({ integrationId: "b", model: "model-b", inputTokens: 50, outputTokens: 5, routeCandidateIndex: 1, usedFallback: true, requestId: entries()[0].id });
  });
});

describe("the account that a call belongs to", () => {
  const SCOPE = "google:first@example.com";

  it("sends nothing, and opens no entry, when the account is no longer the one the call was made for", async () => {
    const a = compatible("a");
    const fake = provide([a], speak("never"));
    setFallbackAcknowledgementAccountScope("google:second@example.com");

    const text = await failure(completeTextRouted(routeOf("copilot", [a]), MESSAGES, "copilot", { accountScope: SCOPE }));
    const tool = await failure(completeToolRouted(routeOf("copilot", [a]), MESSAGES, "copilot", SCHEMA, { accountScope: SCOPE }));
    const confirmation = await failure(classifyConfirmationRouted(settingsOf([a], { taskRouting: { "simple-tasks": { primary: target(a), fallbacks: [] } } }), "yes", undefined, SCOPE));

    expect(text.name).toBe("AbortError");
    expect(tool.name).toBe("AbortError");
    expect(confirmation.name).toBe("AbortError");
    expect(fake.calls).toHaveLength(0);
    expect(entries()).toHaveLength(0);
  });

  it("goes on when the account is the one the call was made for, and also when there is none and none is signed in", async () => {
    const a = compatible("a");
    provide([a], speak("A line."));
    setFallbackAcknowledgementAccountScope(SCOPE);
    await expect(completeTextRouted(routeOf("copilot", [a]), MESSAGES, "copilot", { accountScope: SCOPE })).resolves.toBe("A line.");
    setFallbackAcknowledgementAccountScope(null);
    await expect(completeTextRouted(routeOf("copilot", [a]), MESSAGES, "copilot", { accountScope: null })).resolves.toBe("A line.");
  });

  it("stops a call in flight, and does not try the fallback, when the account changes while the provider answers", async () => {
    const a = compatible("a");
    const b = compatible("b");
    setFallbackAcknowledgementAccountScope(SCOPE);
    const fake = provide([a, b], (call) => {
      if (call.url.includes("a.example.test")) {
        setFallbackAcknowledgementAccountScope("google:second@example.com");
        return hang(call.signal);
      }
      return speak("From b.")(call);
    });

    const error = await failure(completeTextRouted(routeOf("copilot", [a, b]), MESSAGES, "copilot", { accountScope: SCOPE }));

    expect(error.name).toBe("AbortError");
    expect(hostsOf(fake)).toEqual(["a"]);
    expect(fake.calls[0].signal?.aborted).toBe(true);
    await vi.waitFor(() => expect(entries()[0]).toMatchObject({ status: "error", failureKind: "cancelled" }));
  });

  it("stops a call that fails, and does not try the fallback, when the account changed while it failed", async () => {
    const a = compatible("a");
    const b = compatible("b");
    setFallbackAcknowledgementAccountScope(SCOPE);
    const fake = provide([a, b], (call) => {
      if (call.url.includes("a.example.test")) {
        setFallbackAcknowledgementAccountScope("google:second@example.com");
        return failReply(400, "primary failed after the account changed");
      }
      return speak("From b.")(call);
    });

    const error = await failure(completeTextRouted(routeOf("copilot", [a, b]), MESSAGES, "copilot", { accountScope: SCOPE }));

    expect(error.name).toBe("AbortError");
    expect(hostsOf(fake)).toEqual(["a"]);
  });
});

describe("a reply that the provider kept to itself", () => {
  it("costs nothing and leaves the author with the reason, when the provider answers an empty body", async () => {
    const a = compatible("a");
    provide([a], () => textReply("", null));

    const error = await failure(completeTextRouted(routeOf("copilot", [a]), MESSAGES, "copilot", { accountScope: null }));

    expect(error).toBeInstanceOf(Error);
    expect(error.message).toMatch(/empty/i);
    expect(entries()[0]).toMatchObject({ status: "error", failureKind: "provider" });
  });
});
