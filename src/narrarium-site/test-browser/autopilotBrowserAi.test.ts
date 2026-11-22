import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { AiProviderError, AiReplyRejectedError, AiUnavailableError, DEFAULT_ROUTING_EXECUTION, type AiRequest } from "narrarium-engine";
import { localWorkspaceScope } from "@/account/deviceIdentity";
import { clearFallbackAcknowledgements, CrossBoundaryFallbackCancelledError, setFallbackAcknowledgementAccountScope } from "@/assistant/fallbackDisclosure";
import { createBrowserAi } from "@/autopilot/browserAi";
import { chatDelta, useCostsStore } from "@/costs/costsStore";
import { emptyCostsFile } from "@/costs/model";
import { LLM_DEBUG_ERROR_REDACTED, LLM_DEBUG_REDACTED, useLlmDebugStore } from "@/debug/llmDebugStore";
import { useSettingsStore } from "@/store/settingsStore";
import { DEFAULT_SETTINGS, type AppSettings } from "@/types/settings";
import { assertProvidersClean, createFakeProvider, failReply, hang, streamedReply, textReply, toolReply, USAGE, type ProviderReply } from "./helpers/fakeProvider";
import { chatModel, compatible, endpointsOf, GITHUB_TOKEN, PRICE, routed, SCHEMA, settingsOf, type Fixture } from "./helpers/aiFixtures";

const ASK: AiRequest = { capability: "autopilot", label: "autopilot:scene", system: "The system prompt", user: "The user prompt" };

/** The browser's AI port against a fake provider, with the settings the author would have. */
function useProvider(fixtures: Fixture[], settings: AppSettings, reply: ProviderReply) {
  const fake = createFakeProvider(endpointsOf(fixtures), reply, [GITHUB_TOKEN]);
  vi.stubGlobal("fetch", fake.fetch);
  useSettingsStore.setState({ settings });
  return fake;
}

const entries = () => useLlmDebugStore.getState().entries;
const ledger = () => useCostsStore.getState().file.books["book-1"];
const hostOf = (url: string) => new URL(url).hostname.replace(".example.test", "");
const failure = (promise: Promise<unknown>) => promise.then(() => undefined, (error: any) => error);

beforeEach(() => {
  localStorage.clear();
  useLlmDebugStore.setState({ entries: [], pending: 0, storageError: null, accountIdentity: null });
  useCostsStore.setState({ file: emptyCostsFile(), currentBookId: "book-1", currentBookName: "The Glass Harbor", dirty: false, revision: 0 });
  setFallbackAcknowledgementAccountScope(localWorkspaceScope());
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.useRealTimers();
  setFallbackAcknowledgementAccountScope(null);
  assertProvidersClean();
});

describe("the autopilot's AI port in the browser", () => {
  describe("the debug panel", () => {
    it("records one entry per attempt with its place in the route, and closes it with what the provider reported", async () => {
      const a = compatible("a");
      const b = compatible("b");
      useProvider([a, b], routed([a, b]), (call) => (call.url.includes("a.example.test") ? failReply(503, "overloaded") : textReply("Scene text.")));

      await createBrowserAi().complete(ASK);

      const [second, first] = entries();
      expect(first).toMatchObject({ kind: "chat", status: "error", label: "autopilot:scene", model: "model-a", provider: "openai", routeCandidateIndex: 0, usedFallback: false, failureKind: "provider", contentKinds: ["text"] });
      expect(second).toMatchObject({ kind: "chat", status: "done", label: "autopilot:scene", model: "model-b", provider: "openai", routeCandidateIndex: 1, usedFallback: true, inputTokens: 120, cachedTokens: 20, outputTokens: 30, contentKinds: ["text"] });
      expect(second.cost).toBeCloseTo(chatDelta({ inputTokens: 120, cachedTokens: 20, outputTokens: 30 }, PRICE).chatCost!, 10);
      expect(first.integrationId).toMatch(/^integration:[0-9a-f]{16}$/);
      expect(second.integrationId).toMatch(/^integration:[0-9a-f]{16}$/);
      expect(first.integrationId).not.toBe(second.integrationId);
      expect(useLlmDebugStore.getState().pending, "every attempt that began was closed").toBe(0);
    });

    it("keeps no prompt, reply, error text or key", async () => {
      const a = compatible("a");
      const b = compatible("b");
      useProvider([a, b], routed([a, b]), (call) => (call.url.includes("a.example.test") ? failReply(401, `Incorrect API key provided: ${a.endpoint.apiKey}`) : textReply("THE-SECRET-REPLY")));

      await createBrowserAi().complete({ ...ASK, system: "THE-SECRET-MANUSCRIPT", user: "THE-SECRET-INSTRUCTION" });

      const stored = JSON.stringify(entries());
      for (const forbidden of ["THE-SECRET-MANUSCRIPT", "THE-SECRET-INSTRUCTION", "THE-SECRET-REPLY", a.endpoint.apiKey, b.endpoint.apiKey, "Incorrect API key", "example.test"]) expect(stored).not.toContain(forbidden);
      const [second, first] = entries();
      expect(first.messages).toEqual([{ role: "system", content: LLM_DEBUG_REDACTED }, { role: "user", content: LLM_DEBUG_REDACTED }]);
      expect(first.error).toBe(LLM_DEBUG_ERROR_REDACTED);
      expect(second.response).toBe(LLM_DEBUG_REDACTED);
    });

    it("shows the JSON instruction a model without tools receives as a message of the attempt, never its content", async () => {
      const fixture = compatible("a", [chatModel("m", { supportsToolCalls: false })]);
      // With «Tools only» on, which is the default, such a model is not asked at all: the JSON in the message is the way of the author who turned it off.
      useProvider([fixture], settingsOf([fixture], { aiToolsOnly: false }), () => textReply(JSON.stringify({ ok: true }), USAGE, "stop"));
      await createBrowserAi().complete({ ...ASK, json: SCHEMA });
      expect(entries()[0].messages?.map((message) => message.role)).toEqual(["system", "user"]);
      expect(JSON.stringify(entries())).not.toContain("Reply with ONLY one JSON object");
    });

    it("closes the entry of a paused call as cancelled and stops the request", async () => {
      const fixture = compatible("a");
      const fake = useProvider([fixture], settingsOf([fixture]), (call) => hang(call.signal));
      const controller = new AbortController();
      const pending = failure(createBrowserAi().complete({ ...ASK, signal: controller.signal }));
      await vi.waitFor(() => expect(fake.calls).toHaveLength(1));

      controller.abort(new DOMException("Paused by the author.", "AbortError"));

      expect((await pending).name).toBe("AbortError");
      expect(fake.calls[0].signal?.aborted, "the request in flight was abandoned").toBe(true);
      expect(entries()[0]).toMatchObject({ status: "error", failureKind: "cancelled" });
      expect(useLlmDebugStore.getState().pending).toBe(0);
      expect(ledger()).toBeUndefined();
    });

    it("reports a request that ran out of time with the limit it ran out of", async () => {
      vi.useFakeTimers();
      const fixture = compatible("a", undefined, { requestTimeoutMs: 30_000 });
      useProvider([fixture], settingsOf([fixture]), (call) => hang(call.signal));
      const pending = failure(createBrowserAi().complete(ASK));
      await vi.advanceTimersByTimeAsync(30_000);

      const error = await pending;
      expect(error).toBeInstanceOf(AiProviderError);
      expect(error).toMatchObject({ timedOut: true, retryable: true });
      expect(entries()[0]).toMatchObject({ status: "error", failureKind: "timeout", timeoutMs: 30_000 });
    });
  });

  describe("the costs", () => {
    it("records what an attempt cost, at the price of the model", async () => {
      const fixture = compatible("a", [chatModel("m", { pricing: PRICE })]);
      useProvider([fixture], settingsOf([fixture]), () => textReply("ok", { prompt_tokens: 1_000, completion_tokens: 500, prompt_tokens_details: { cached_tokens: 200 } }));

      await createBrowserAi().complete(ASK);

      const expected = chatDelta({ inputTokens: 1_000, cachedTokens: 200, outputTokens: 500 }, PRICE).chatCost!;
      expect(ledger()).toMatchObject({ bookId: "book-1", inputTokens: 1_000, cachedTokens: 200, outputTokens: 500 });
      expect(ledger().chatCost).toBeCloseTo(expected, 10);
      expect(ledger().models?.m).toMatchObject({ inputTokens: 1_000, cachedTokens: 200, outputTokens: 500 });
      expect(entries()[0].cost, "the panel and the costs agree").toBeCloseTo(expected, 10);
    });

    it("records the attempts that failed after the provider had billed them, once each, so nothing is lost or counted twice", async () => {
      const a = compatible("a", [chatModel("model-a")]);
      const b = compatible("b", [chatModel("model-b")]);
      useProvider([a, b], routed([a, b]), (call) => (call.url.includes("a.example.test")
        ? textReply("Half a scene", { prompt_tokens: 800, completion_tokens: 4_000 }, "length")
        : textReply("A whole scene.", { prompt_tokens: 800, completion_tokens: 300 })));

      const response = await createBrowserAi().complete(ASK);

      const total = chatDelta({ inputTokens: 1_600, cachedTokens: 0, outputTokens: 4_300 }, PRICE).chatCost!;
      expect(ledger()).toMatchObject({ inputTokens: 1_600, outputTokens: 4_300 });
      expect(ledger().chatCost).toBeCloseTo(total, 10);
      expect(ledger().models?.["model-a"]).toMatchObject({ inputTokens: 800, outputTokens: 4_000 });
      expect(ledger().models?.["model-b"]).toMatchObject({ inputTokens: 800, outputTokens: 300 });
      expect(response.usage).toEqual({ inputTokens: 1_600, outputTokens: 4_300, cachedInputTokens: 0 });
      expect(response.cost, "the autopilot's own count and the ledger say the same").toBeCloseTo(total, 10);

      const [second, first] = entries();
      expect(first).toMatchObject({ status: "error", model: "model-a", inputTokens: 800, outputTokens: 4_000 });
      expect(first.cost).toBeCloseTo(chatDelta({ inputTokens: 800, cachedTokens: 0, outputTokens: 4_000 }, PRICE).chatCost!, 10);
      expect(second).toMatchObject({ status: "done", model: "model-b", inputTokens: 800, outputTokens: 300 });
    });

    it("uses the price of the integration when the model has none of its own", async () => {
      const pricing = { inputPerMTok: 10, outputPerMTok: 20 };
      const fixture = compatible("a", [chatModel("m", { pricing: undefined })], { pricing });
      useProvider([fixture], settingsOf([fixture]), () => textReply("ok"));
      await createBrowserAi().complete(ASK);
      expect(ledger().chatCost).toBeCloseTo(chatDelta({ inputTokens: 120, cachedTokens: 20, outputTokens: 30 }, pricing).chatCost!, 10);
    });

    it("records no money for a model without a price, but the panel still shows its tokens", async () => {
      const fixture = compatible("a", [chatModel("m", { pricing: undefined })]);
      useProvider([fixture], settingsOf([fixture]), () => textReply("ok"));
      await createBrowserAi().complete(ASK);
      expect(ledger()).toBeUndefined();
      expect(entries()[0]).toMatchObject({ status: "done", inputTokens: 120, cachedTokens: 20, outputTokens: 30 });
      expect(entries()[0].cost).toBeUndefined();
    });

    it("never records tokens the provider did not report: an estimate is not a measurement", async () => {
      const fixture = compatible("a");
      useProvider([fixture], settingsOf([fixture]), () => streamedReply("A scene.", null));
      const response = await createBrowserAi().complete({ ...ASK, onText: () => undefined });
      expect(response.usageKnown).toBe(false);
      expect(ledger()).toBeUndefined();
      expect(entries()[0]).toMatchObject({ status: "done" });
      expect(entries()[0].inputTokens).toBeUndefined();
      expect(entries()[0].cost).toBeUndefined();
    });

    it("has nowhere to record when no book is open, and still works", async () => {
      useCostsStore.setState({ currentBookId: undefined, currentBookName: undefined });
      const fixture = compatible("a");
      useProvider([fixture], settingsOf([fixture]), () => textReply("ok"));
      await expect(createBrowserAi().complete(ASK)).resolves.toMatchObject({ text: "ok" });
      expect(useCostsStore.getState().file.books).toEqual({});
    });
  });

  describe("the account", () => {
    it("cancels the call in flight when the account changes", async () => {
      const fixture = compatible("a");
      const fake = useProvider([fixture], settingsOf([fixture]), (call) => hang(call.signal));
      const pending = failure(createBrowserAi().complete(ASK));
      await vi.waitFor(() => expect(fake.calls).toHaveLength(1));

      setFallbackAcknowledgementAccountScope("google:someone-else@example.com");

      expect((await pending).name).toBe("AbortError");
      expect(fake.calls[0].signal?.aborted).toBe(true);
      expect(entries()[0]).toMatchObject({ status: "error", failureKind: "cancelled" });
      expect(useLlmDebugStore.getState().pending).toBe(0);
    });

    it("never reaches the provider for a workspace that is no longer the current one", async () => {
      const fixture = compatible("a");
      const fake = useProvider([fixture], settingsOf([fixture]), () => textReply("ok"));
      setFallbackAcknowledgementAccountScope("google:someone-else@example.com");
      const error = await failure(createBrowserAi().complete(ASK));
      expect(error.name).toBe("AbortError");
      expect(fake.calls).toHaveLength(0);
      expect(entries()).toHaveLength(0);
    });

    it("stops following the caller's signal when the call ends", async () => {
      const fixture = compatible("a");
      useProvider([fixture], settingsOf([fixture]), () => textReply("ok"));
      const controller = new AbortController();
      const added = vi.spyOn(controller.signal, "addEventListener");
      const removed = vi.spyOn(controller.signal, "removeEventListener");
      await createBrowserAi().complete({ ...ASK, signal: controller.signal });
      const listeners = added.mock.calls.filter(([type]) => type === "abort").map(([, listener]) => listener);
      expect(listeners).toHaveLength(1);
      expect(removed.mock.calls.filter(([type]) => type === "abort").map(([, listener]) => listener)).toEqual(listeners);
    });
  });

  describe("sending content to another account", () => {
    const local = compatible("local", [chatModel("qwen")]);
    const cloud = compatible("cloud", [chatModel("gpt-4o")]);
    const settings = routed([local, cloud], { fallbackDisclosure: { sameBoundaryOnly: false, requireAcknowledgement: true } });
    const reply: ProviderReply = (call) => (call.url.includes("local.example.test") ? failReply(500, "local model crashed") : textReply("the manuscript was sent here"));
    const key = () => `narrarium:fallback-disclosure:v2:${encodeURIComponent(localWorkspaceScope().toLocaleLowerCase())}:text:${encodeURIComponent("integration:local")}:${encodeURIComponent("integration:cloud")}`;

    it("asks the author once for the pair of accounts, names both, and remembers the answer", async () => {
      const confirm = vi.spyOn(window, "confirm").mockReturnValue(true);
      const fake = useProvider([local, cloud], settings, reply);
      const ai = createBrowserAi();

      const first = await ai.complete(ASK);
      expect(first.text).toBe("the manuscript was sent here");
      expect(fake.calls.map((call) => hostOf(call.url))).toEqual(["local", "cloud"]);
      expect(confirm).toHaveBeenCalledTimes(1);
      expect(String(confirm.mock.calls[0][0])).toContain("openai / LOCAL");
      expect(String(confirm.mock.calls[0][0])).toContain("openai / CLOUD");
      expect(localStorage.getItem(key())).toBe("acknowledged");

      await ai.complete(ASK);
      expect(confirm, "the same pair is not asked again").toHaveBeenCalledTimes(1);
      expect(fake.calls.map((call) => hostOf(call.url))).toEqual(["local", "cloud", "local", "cloud"]);

      clearFallbackAcknowledgements();
      await ai.complete(ASK);
      expect(confirm, "forgotten answers are asked again").toHaveBeenCalledTimes(2);
    });

    it("a refusal cancels the call (a pause, not a failure), sends nothing to the other account and is not remembered", async () => {
      const confirm = vi.spyOn(window, "confirm").mockReturnValue(false);
      const fake = useProvider([local, cloud], settings, reply);

      const error = await failure(createBrowserAi().complete(ASK));

      expect(error).toBeInstanceOf(CrossBoundaryFallbackCancelledError);
      expect(error.name).toBe("AbortError");
      expect(confirm).toHaveBeenCalledTimes(1);
      expect(fake.calls.map((call) => hostOf(call.url))).toEqual(["local"]);
      expect(localStorage.getItem(key())).toBeNull();
      expect(useLlmDebugStore.getState().pending).toBe(0);
    });

    it("does not ask when the policy does not require it", async () => {
      const confirm = vi.spyOn(window, "confirm").mockReturnValue(false);
      const fake = useProvider([local, cloud], routed([local, cloud]), reply);
      await createBrowserAi().complete(ASK);
      expect(confirm).not.toHaveBeenCalled();
      expect(fake.calls.map((call) => hostOf(call.url))).toEqual(["local", "cloud"]);
    });
  });

  describe("errors", () => {
    const cases: Array<[string, ProviderReply, (error: any) => void]> = [
      ["a refused key", () => failReply(401, "Incorrect API key provided"), (error) => expect(error).toMatchObject({ status: 401, retryable: false })],
      ["an overloaded provider", () => failReply(503, "busy", { "retry-after": "5" }), (error) => expect(error).toMatchObject({ status: 503, retryable: true, transient: true, retryAfterMs: 5_000 })],
      ["a network failure", () => { throw new TypeError("Failed to fetch"); }, (error) => expect(error).toMatchObject({ retryable: true, transient: true })],
      ["a reply cut by the output limit", () => textReply("Half a scene", USAGE, "length"), (error) => {
        expect(error).toMatchObject({ truncated: true, retryable: false, usage: { inputTokens: 120, outputTokens: 30, cachedInputTokens: 20 } });
        expect(error.message).toMatch(/cut by the output token limit/);
      }],
      ["a model that spent its whole limit reasoning", () => Response.json({ choices: [{ message: { content: "", reasoning_content: "thinking ".repeat(500) }, finish_reason: "length" }], usage: USAGE }), (error) => {
        expect(error).toMatchObject({ truncated: true, reasoningOnly: true, retryable: false });
        expect(error.message).toMatch(/while reasoning, before writing the reply/);
      }],
      ["an empty reply", () => textReply(""), (error) => {
        expect(error.retryable).toBe(true);
        expect(error.message).toMatch(/empty reply/);
      }],
      ["a model that finished after reasoning without a reply", () => Response.json({ choices: [{ message: { content: "", reasoning_content: "thinking" }, finish_reason: "stop" }], usage: USAGE }), (error) => {
        expect(error.retryable).toBe(true);
        expect(error.message).toMatch(/finished after reasoning without a reply/);
      }],
      ["filtered content", () => textReply("", USAGE, "content_filter"), (error) => {
        expect(error.retryable).toBe(false);
        expect(error.message).toMatch(/filtered/);
      }],
    ];

    it.each(cases)("passes %s to the runner as the engine reports it", async (_name, reply, check) => {
      const fixture = compatible("a");
      useProvider([fixture], settingsOf([fixture]), reply);
      const error = await failure(createBrowserAi().complete(ASK));
      expect(error).toBeInstanceOf(AiProviderError);
      check(error);
    });

    it("rejects a structured reply with no usable field, keeping what it cost", async () => {
      const fixture = compatible("a");
      useProvider([fixture], settingsOf([fixture]), () => toolReply({}));
      const error = await failure(createBrowserAi().complete({ ...ASK, json: SCHEMA }));
      expect(error).toBeInstanceOf(AiReplyRejectedError);
      expect(error).toMatchObject({ retryable: true, usage: { inputTokens: 120, outputTokens: 30, cachedInputTokens: 20 } });
      expect(error.message).toMatch(/Expected fields: "ok"/);
    });

    it("unwraps a structured reply the model wrapped in one key", async () => {
      const fixture = compatible("a");
      useProvider([fixture], settingsOf([fixture]), () => toolReply({ arguments: { ok: true } }));
      const response = await createBrowserAi().complete({ ...ASK, json: SCHEMA });
      expect(response.json).toEqual({ ok: true });
    });

    it("says no AI model is configured, without calling anything", async () => {
      const fake = useProvider([], settingsOf([]), () => textReply("ok"));
      const error = await failure(createBrowserAi().complete(ASK));
      expect(error).toBeInstanceOf(AiUnavailableError);
      expect(error.capability).toBe("autopilot");
      expect(fake.calls).toHaveLength(0);
    });
  });

  describe("the settings", () => {
    it("are read again at every call", async () => {
      const a = compatible("a");
      const b = compatible("b");
      const fake = useProvider([a, b], settingsOf([a]), () => textReply("ok"));
      const ai = createBrowserAi();
      await ai.complete(ASK);
      useSettingsStore.setState({ settings: settingsOf([b]) });
      await ai.complete(ASK);
      expect(fake.calls.map((call) => hostOf(call.url))).toEqual(["a", "b"]);
      expect(fake.calls[1].headers.authorization).toBe(`Bearer ${b.endpoint.apiKey}`);
    });

    it("route each task by its own capability", async () => {
      const a = compatible("a");
      const b = compatible("b");
      const settings = settingsOf([a, b], { taskRouting: { autopilot: { primary: { integrationId: "a", model: "model-a" }, fallbacks: [] }, director: { primary: { integrationId: "b", model: "model-b" }, fallbacks: [] } } });
      const fake = useProvider([a, b], settings, () => textReply("ok"));
      const ai = createBrowserAi();
      await ai.complete(ASK);
      await ai.complete({ ...ASK, capability: "director" });
      expect(fake.calls.map((call) => hostOf(call.url))).toEqual(["a", "b"]);
    });

    it("work with an integration that only has the older single-model fields, billed at the price of the integration", async () => {
      const pricing = { inputPerMTok: 10, outputPerMTok: 20 };
      const legacy = compatible("old", [], { modelWriting: "gpt-4o", chatModels: undefined, pricing });
      const fake = useProvider([legacy], settingsOf([legacy]), () => textReply("ok"));
      await createBrowserAi().complete(ASK);
      expect(fake.calls[0].body.model).toBe("gpt-4o");
      expect(ledger().models?.["gpt-4o"]).toBeDefined();
      expect(ledger().chatCost).toBeCloseTo(chatDelta({ inputTokens: 120, cachedTokens: 20, outputTokens: 30 }, pricing).chatCost!, 10);
    });

    it("carry the settings of this call, not of an earlier one, into the price used for the costs", async () => {
      const cheap = compatible("a", [chatModel("m", { pricing: { inputPerMTok: 1, outputPerMTok: 1 } })]);
      const dear = compatible("a", [chatModel("m", { pricing: { inputPerMTok: 100, outputPerMTok: 100 } })]);
      useProvider([cheap], settingsOf([cheap]), () => textReply("ok", { prompt_tokens: 1_000_000, completion_tokens: 0 }));
      const ai = createBrowserAi();
      await ai.complete(ASK);
      useSettingsStore.setState({ settings: settingsOf([dear]) });
      await ai.complete(ASK);
      expect(ledger().chatCost).toBeCloseTo(1 + 100, 6);
    });
  });
});

describe("the defaults the adapter relies on", () => {
  it("are the engine's: a configuration without limits and one with the site's defaults behave alike", () => {
    expect(DEFAULT_SETTINGS.fallbackDisclosure).toEqual({ sameBoundaryOnly: false, requireAcknowledgement: false });
    expect(DEFAULT_SETTINGS.routingExecution).toEqual(DEFAULT_ROUTING_EXECUTION);
  });
});
