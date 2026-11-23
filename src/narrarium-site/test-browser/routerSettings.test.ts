import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  BROWSER_ROUTING_ID,
  CandidateInputBudgetError,
  classifyConfirmationRouted,
  completeTextRouted,
  completeToolRouted,
  reconcileTaskRouting,
  resolveTaskCandidates,
  resolveEffectiveTaskCandidates,
  StaleRoutingConfigurationError,
} from "@/assistant/router";
import { migrateSettings } from "@/drive/cloudSettingsClient";
import { DEFAULT_SETTINGS, type AIIntegration, type AppSettings } from "@/types/settings";
import { setFallbackAcknowledgementAccountScope } from "@/assistant/fallbackDisclosure";
import { chatDelta } from "@/costs/costsStore";
import { assertProvidersClean, failReply, hang } from "./helpers/fakeProvider";
import { chatModel, compatible, PRICE, settingsOf as fixtureSettings, type Fixture } from "./helpers/aiFixtures";
import { entries, failure, hostsOf, provide, resetStores, speak, speakCall, target as pick } from "./helpers/copilotHarness";

function integration(id: string, models: Array<{ id: string; name: string; capabilities: Array<"default" | "review"> }>): AIIntegration {
  return { id, name: id, provider: "openai", apiKey: "key", chatModels: models };
}

function settings(integrations: AIIntegration[], patch: Partial<AppSettings> = {}): AppSettings {
  return { ...DEFAULT_SETTINGS, aiIntegrations: integrations, ...patch };
}

beforeEach(() => setFallbackAcknowledgementAccountScope(null));

describe("task routing settings", () => {
  it("rewrites renamed models and retains unaffected fallbacks when an integration is deleted", () => {
    const first = integration("first", [{ id: "review-model", name: "review-v1", capabilities: ["review"] }]);
    const fallback = integration("fallback", [{ id: "fallback-model", name: "fallback-v1", capabilities: ["review"] }]);
    const routing = { review: { primary: { integrationId: "first", model: "review-v1" }, fallbacks: [{ integrationId: "fallback", model: "fallback-v1" }] } };
    const renamed = integration("first", [{ id: "review-model", name: "review-v2", capabilities: ["review"] }]);

    expect(reconcileTaskRouting(routing, [first, fallback], [renamed, fallback])?.review?.primary?.model).toBe("review-v2");
    expect(reconcileTaskRouting(routing, [first, fallback], [fallback])?.review).toEqual({ primary: undefined, fallbacks: [{ integrationId: "fallback", model: "fallback-v1" }] });
  });

  it("honors review precedence: explicit route, default review, capability tag, default writing", () => {
    const writing = integration("writing", [{ id: "w", name: "writing-default", capabilities: ["default"] }]);
    const tagged = integration("tagged", [{ id: "t", name: "tagged-review", capabilities: ["review"] }]);
    const review = integration("review", [{ id: "r", name: "review-default", capabilities: ["default"] }]);
    const base = settings([writing, tagged, review], { defaultWritingIntegrationId: "writing", defaultReviewIntegrationId: "review" });

    expect(resolveTaskCandidates(base, "review").map((candidate) => candidate.integration?.id)).toEqual(["review", "tagged", "writing"]);
    expect(resolveTaskCandidates({ ...base, taskRouting: { review: { primary: { integrationId: "tagged", model: "tagged-review" }, fallbacks: [] } } }, "review").map((candidate) => candidate.integration?.id)).toEqual(["tagged"]);
  });

  it("exposes the effective legacy all-integration chain used by settings disclosure", () => {
    const writing = integration("writing", [{ id: "w", name: "writing-default", capabilities: ["default"] }]);
    const other = { ...integration("other", [{ id: "o", name: "other-default", capabilities: ["default"] }]), provider: "azure_openai" as const };
    const base = settings([writing, other], { defaultWritingIntegrationId: "writing" });
    expect(resolveEffectiveTaskCandidates(base, "default").map((candidate) => candidate.integration?.id)).toEqual(["writing", "other"]);
    expect(resolveEffectiveTaskCandidates({ ...base, fallbackDisclosure: { ...base.fallbackDisclosure, sameBoundaryOnly: true } }, "default").map((candidate) => candidate.integration?.id)).toEqual(["writing"]);
  });

  it("uses the explicit editor route and falls back to the default route for existing settings", () => {
    const primary = integration("primary", [{ id: "p", name: "primary", capabilities: ["default"] }]);
    const fallback = integration("fallback", [{ id: "f", name: "fallback", capabilities: ["default"] }]);
    const defaultRoute = { primary: { integrationId: "primary", model: "primary" }, fallbacks: [{ integrationId: "fallback", model: "fallback" }] };
    const base = settings([primary, fallback], { taskRouting: { default: defaultRoute } });
    expect(resolveTaskCandidates(base, "editor-actions").map((candidate) => candidate.integration?.id)).toEqual(["primary", "fallback"]);
    expect(resolveTaskCandidates({ ...base, taskRouting: { ...base.taskRouting, "editor-actions": { primary: { integrationId: "fallback", model: "fallback" }, fallbacks: [] } } }, "editor-actions").map((candidate) => candidate.integration?.id)).toEqual(["fallback"]);
  });

  it("drops stale cloud targets using model membership and media compatibility", () => {
    const ai = { ...integration("ai", [{ id: "chat", name: "chat", capabilities: ["default"] }]), modelTextToSpeech: "voice" };
    const migrated = migrateSettings({
      ...DEFAULT_SETTINGS,
      aiIntegrations: [ai],
      books: [],
      taskRouting: {
        default: { primary: { integrationId: "ai", model: "removed" }, fallbacks: [{ integrationId: "ai", model: "chat" }] },
        image: { primary: { integrationId: BROWSER_ROUTING_ID, model: "browser" }, fallbacks: [] },
        tts: { primary: { integrationId: BROWSER_ROUTING_ID, model: "wrong" }, fallbacks: [] },
      },
    });

    expect(migrated.taskRouting?.default).toEqual({ primary: undefined, fallbacks: [{ integrationId: "ai", model: "chat" }] });
    expect(migrated.taskRouting?.image).toBeUndefined();
    expect(migrated.taskRouting?.tts?.primary).toEqual({ integrationId: BROWSER_ROUTING_ID, model: "browser" });
  });

  it("rejects explicit chat routes without a matching task capability", () => {
    const ai = integration("ai", [{ id: "chat", name: "chat", capabilities: ["review"] }]);
    const configured = settings([ai], { taskRouting: { copilot: { primary: { integrationId: "ai", model: "chat" }, fallbacks: [] } } });
    expect(resolveTaskCandidates(configured, "copilot")).toEqual([]);
  });
});

/** A fixture for the routed paths: an OpenAI-compatible integration with the models it serves, and a key and a host of its own. */
function served(id: string, models: Array<{ name: string; capabilities: Array<"default" | "review">; supportsToolCalls?: boolean; maxInputTokens?: number; maxOutputTokens?: number }>, extra: Partial<Fixture["integration"]> = {}): Fixture {
  return compatible(id, models.map((model) => chatModel(model.name, { capabilities: model.capabilities, ...(model.supportsToolCalls !== undefined ? { supportsToolCalls: model.supportsToolCalls } : {}), ...(model.maxInputTokens ? { maxInputTokens: model.maxInputTokens } : {}), ...(model.maxOutputTokens ? { maxOutputTokens: model.maxOutputTokens } : {}) })), extra);
}

function routing(fixtures: Fixture[], tasks: string[], extra: Partial<AppSettings> = {}): AppSettings {
  const [primary, ...fallbacks] = fixtures;
  const route = { primary: pick(primary), fallbacks: fallbacks.map((fixture) => pick(fixture)) };
  return fixtureSettings(fixtures, { taskRouting: Object.fromEntries(tasks.map((task) => [task, route])) as AppSettings["taskRouting"], ...extra });
}

const MESSAGES = [{ role: "user" as const, content: "score" }];
const SCORE = { name: "score", description: "score", parameters: {} };

describe("routed tool execution", () => {
  beforeEach(resetStores);
  afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
    vi.useRealTimers();
    assertProvidersClean();
  });

  it("falls back on invalid structured output and preserves actual usage and cost metadata", async () => {
    const primary = served("primary", [{ name: "primary", capabilities: ["review"] }]);
    const fallback = served("fallback", [{ name: "fallback", capabilities: ["review"] }]);
    provide([primary, fallback], (call) => (call.url.includes("primary.example.test")
      ? speakCall({ score: -1 }, { prompt_tokens: 1, completion_tokens: 1 })(call)
      : speakCall({ score: 8 }, { prompt_tokens: 12, completion_tokens: 4, prompt_tokens_details: { cached_tokens: 2 } })(call)));

    const result = await completeToolRouted<{ score: number }>(routing([primary, fallback], ["review"]), MESSAGES, "review", SCORE, {
      accountScope: null,
      validate: (value) => {
        const score = (value as { score?: unknown }).score;
        if (typeof score !== "number" || score < 0) throw new Error("invalid score");
        return { score };
      },
    });

    expect(result.output).toEqual({ score: 8 });
    expect(result.metadata).toMatchObject({ integrationId: "fallback", requestId: entries()[0].id, inputTokens: 12, cachedInputTokens: 2, outputTokens: 4, routeCandidateIndex: 1, usedFallback: true, currency: "EUR" });
    expect(result.metadata.cost).toBeCloseTo(chatDelta({ inputTokens: 12, cachedTokens: 2, outputTokens: 4 }, PRICE).chatCost!, 10);
    expect(entries().map((entry) => [entry.routeCandidateIndex, entry.usedFallback])).toEqual([[1, true], [0, false]]);
  });

  it("falls back when candidate-level text validation rejects malformed structured output", async () => {
    const primary = served("primary", [{ name: "primary", capabilities: ["default"] }]);
    const fallback = served("fallback", [{ name: "fallback", capabilities: ["default"] }]);
    provide([primary, fallback], (call) => speak(call.url.includes("primary.example.test") ? "not json" : "{\"title\":\"Valid\"}")(call));
    await expect(completeTextRouted(routing([primary, fallback], ["default"]), [{ role: "user", content: "create" }], "default", { accountScope: null, validateText: (text) => { JSON.parse(text); } })).resolves.toBe("{\"title\":\"Valid\"}");
  });

  it("filters forced-tool-incompatible candidates and caps route length", async () => {
    const fixtures = Array.from({ length: 6 }, (_, index) => served(`ai-${index}`, [{ name: `model-${index}`, capabilities: ["review"], supportsToolCalls: index !== 0 }]));
    const configured = routing(fixtures, ["review"], { routingExecution: { ...DEFAULT_SETTINGS.routingExecution, maxCandidates: 3 } });
    expect(resolveTaskCandidates(configured, "review")).toHaveLength(3);
    const fake = provide(fixtures, speakCall({ ok: true }));

    await completeToolRouted(configured, [{ role: "user", content: "x" }], "review", { name: "x", description: "x", parameters: {} }, { accountScope: null });

    expect(hostsOf(fake)).toEqual(["ai-1"]);
  });

  it("falls back on provider AbortError and distinguishes an entirely stale route", async () => {
    vi.useFakeTimers();
    const ai = served("ai", [{ name: "model", capabilities: ["review"] }]);
    const fallback = served("fallback", [{ name: "fallback", capabilities: ["review"] }]);
    const fake = provide([ai, fallback], (call) => (call.url.includes("ai.example.test") ? Promise.reject(new DOMException("aborted", "AbortError")) : speakCall({ score: 8 })(call)));
    const run = completeToolRouted(routing([ai, fallback], ["review"]), [], "review", SCORE, { accountScope: null });
    const settled = run.then((value) => ({ value }), (error) => ({ error }));
    // A connection that the provider's side aborted is a passing error: the model is asked three times before the fallback.
    await vi.advanceTimersByTimeAsync(5_000);
    expect(await settled).toMatchObject({ value: { output: { score: 8 } } });
    expect(hostsOf(fake)).toEqual(["ai", "ai", "ai", "fallback"]);

    const stale = fixtureSettings([ai], { taskRouting: { review: { primary: { integrationId: "ai", model: "removed" }, fallbacks: [] } } });
    await expect(completeToolRouted(stale, [], "review", SCORE, { accountScope: null })).rejects.toBeInstanceOf(StaleRoutingConfigurationError);
  });

  it("prepends a selected override while retaining budgeted configured fallback", async () => {
    const selected = served("selected", [{ name: "selected", capabilities: ["default"], maxInputTokens: 120, maxOutputTokens: 11 }]);
    const fallback = served("fallback", [{ name: "fallback", capabilities: ["default"] }]);
    const fake = provide([selected, fallback], (call) => (call.url.includes("selected.example.test") ? failReply(400, "provider failed") : speak("fallback")(call)));
    const configured = fixtureSettings([selected, fallback], { taskRouting: { default: { primary: pick(fallback), fallbacks: [] } } });

    await expect(completeTextRouted(configured, [{ role: "user", content: "x".repeat(2_000) }], "default", { accountScope: null, preferred: pick(selected) })).resolves.toBe("fallback");

    expect(hostsOf(fake)).toEqual(["selected", "fallback"]);
    expect(JSON.stringify(fake.calls[0].body.messages)).toContain("Context truncated");
    expect(fake.calls[0].body.max_tokens).toBe(11);
    expect(entries().map((entry) => entry.usedFallback)).toEqual([true, false]);
  });
});

describe("account-scoped routed execution", () => {
  beforeEach(resetStores);
  afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
    assertProvidersClean();
  });

  it("aborts before fallback when the authenticated account changes between attempts", async () => {
    const primary = served("primary", [{ name: "primary", capabilities: ["default"] }]);
    const fallback = served("fallback", [{ name: "fallback", capabilities: ["default"] }]);
    setFallbackAcknowledgementAccountScope("google:first@example.com");
    const fake = provide([primary, fallback], (call) => {
      setFallbackAcknowledgementAccountScope("google:second@example.com");
      return failReply(400, "primary failed after account switch");
    });

    await expect(completeTextRouted(routing([primary, fallback], ["default"]), [{ role: "user", content: "request" }], "default", { accountScope: "google:first@example.com" })).rejects.toMatchObject({ name: "AbortError" });
    expect(fake.calls).toHaveLength(1);
  });
});

describe("routed execution limits", () => {
  beforeEach(resetStores);
  afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
    vi.useRealTimers();
    assertProvidersClean();
  });

  it("uses each candidate's token limits and advances after a provider timeout", async () => {
    vi.useFakeTimers();
    const primary = served("primary", [{ name: "primary", capabilities: ["default"], maxInputTokens: 120, maxOutputTokens: 17 }], { requestTimeoutMs: 30_000 });
    const fallback = served("fallback", [{ name: "fallback", capabilities: ["default"], maxInputTokens: 500, maxOutputTokens: 29 }]);
    const fake = provide([primary, fallback], (call) => (call.url.includes("primary.example.test") ? hang(call.signal) : speak("fallback result")(call)));
    const messages = [{ role: "user" as const, content: `Long chapter start\n${"x".repeat(8_000)}\nLong chapter end` }];
    const run = completeTextRouted(routing([primary, fallback], ["default"]), messages, "default", { accountScope: null });
    const settled = run.then((value) => ({ value }), (error) => ({ error }));

    await vi.advanceTimersByTimeAsync(30_000);
    expect(await settled).toEqual({ value: "fallback result" });

    expect(hostsOf(fake)).toEqual(["primary", "fallback"]);
    expect(JSON.stringify(fake.calls[0].body.messages)).toContain("Context truncated");
    expect(fake.calls[0].body.max_tokens).toBe(17);
    expect(fake.calls[1].body.max_tokens).toBe(29);
    expect(entries().map((entry) => entry.usedFallback)).toEqual([true, false]);
  });

  it("does not treat user cancellation as a provider timeout", async () => {
    const controller = new AbortController();
    const ai = served("ai", [{ name: "model", capabilities: ["default"] }]);
    const fake = provide([ai], (call) => {
      controller.abort(new DOMException("cancelled", "AbortError"));
      return hang(call.signal);
    });

    await expect(completeTextRouted(fixtureSettings([ai]), [{ role: "user", content: "hello" }], "default", { accountScope: null, signal: controller.signal })).rejects.toMatchObject({ name: "AbortError" });
    expect(fake.calls).toHaveLength(1);
    await vi.waitFor(() => expect(entries()[0]).toMatchObject({ failureKind: "cancelled" }));
  });

  it("applies the same timeout fallback semantics to forced-tool execution", async () => {
    vi.useFakeTimers();
    const primary = served("primary", [{ name: "primary", capabilities: ["review"] }], { requestTimeoutMs: 30_000 });
    const fallback = served("fallback", [{ name: "fallback", capabilities: ["review"] }]);
    provide([primary, fallback], (call) => (call.url.includes("primary.example.test") ? hang(call.signal) : speakCall({ score: 9 })(call)));
    const settled = completeToolRouted(routing([primary, fallback], ["review"]), [{ role: "user", content: "score" }], "review", SCORE, { accountScope: null }).then((value) => ({ value }), (error) => ({ error }));

    await vi.advanceTimersByTimeAsync(30_000);
    const { value } = (await settled) as { value: Awaited<ReturnType<typeof completeToolRouted>> };

    expect(value.metadata).toMatchObject({ integrationId: "fallback", usedFallback: true });
  });

  it("bounds confirmation classification candidates too", async () => {
    vi.useFakeTimers();
    const primary = served("primary", [{ name: "primary", capabilities: ["default"] }], { requestTimeoutMs: 30_000 });
    const fallback = served("fallback", [{ name: "fallback", capabilities: ["default"] }]);
    const configured = routing([primary, fallback], ["simple-tasks"]);
    const fake = provide([primary, fallback], (call) => (call.url.includes("primary.example.test") ? hang(call.signal) : speakCall({ decision: "yes" }, undefined, "confirm")(call)));
    const settled = classifyConfirmationRouted(configured, "continue?", undefined, null).then((value) => ({ value }), (error) => ({ error }));

    await vi.advanceTimersByTimeAsync(30_000);

    expect(await settled).toEqual({ value: "yes" });
    expect(hostsOf(fake)).toEqual(["primary", "fallback"]);
    const framed = String(fake.calls[0].body.messages[0].content);
    expect(framed.match(/continue\?/g)).toHaveLength(1);
    expect(framed).toContain('<current_request trust="user-instruction">');
  });

  it("propagates operation cancellation through confirmation classification", async () => {
    const controller = new AbortController();
    const ai = served("ai", [{ name: "model", capabilities: ["default"] }]);
    const fake = provide([ai], (call) => {
      controller.abort(new DOMException("operation stopped", "AbortError"));
      return hang(call.signal);
    });

    await expect(classifyConfirmationRouted(fixtureSettings([ai]), "perhaps", controller.signal, null)).rejects.toMatchObject({ name: "AbortError" });
    expect(fake.calls).toHaveLength(1);
  });

  it("skips confirmation candidates whose schema cannot fit and truncates the utterance for fallback", async () => {
    const primary = served("primary", [{ name: "primary", capabilities: ["default"], maxInputTokens: 100 }]);
    const fallback = served("fallback", [{ name: "fallback", capabilities: ["default"], maxInputTokens: 1_000, maxOutputTokens: 100 }]);
    const fake = provide([primary, fallback], speakCall({ decision: "yes" }, undefined, "confirm"));

    await expect(classifyConfirmationRouted(routing([primary, fallback], ["simple-tasks"]), `confirm-start ${"private".repeat(1_000)} confirm-end`, undefined, null)).resolves.toBe("yes");

    expect(hostsOf(fake)).toEqual(["fallback"]);
    const framed = String(fake.calls[0].body.messages[0].content);
    expect(framed).toContain("Context truncated");
    expect(framed.length).toBeLessThan(1_000);
  });

  it("never dispatches a forced-tool request when the schema alone exhausts every candidate", async () => {
    const primary = served("primary", [{ name: "primary", capabilities: ["review"], maxInputTokens: 20 }]);
    const fallback = served("fallback", [{ name: "fallback", capabilities: ["review"], maxInputTokens: 20 }]);
    const fake = provide([primary, fallback], speakCall({ score: 8 }));
    const sensitivePrompt = "private prompt that must not appear in diagnostics";

    const error = await failure(completeToolRouted(routing([primary, fallback], ["review"]), [{ role: "user", content: sensitivePrompt }], "review", { name: "large", description: "x".repeat(100), parameters: {} }, { accountScope: null }));

    expect(error).toBeInstanceOf(CandidateInputBudgetError);
    expect(error.message).toContain("budget exhausted");
    expect(error.message).not.toContain(sensitivePrompt);
    expect(fake.calls).toHaveLength(0);
  });

  it("skips a schema-overflow forced-tool candidate and dispatches only the fitting fallback", async () => {
    const primary = served("primary", [{ name: "primary", capabilities: ["review"], maxInputTokens: 20 }]);
    const fallback = served("fallback", [{ name: "fallback", capabilities: ["review"], maxInputTokens: 1_000, maxOutputTokens: 100 }]);
    const fake = provide([primary, fallback], speakCall({ score: 8 }));

    await expect(completeToolRouted(routing([primary, fallback], ["review"]), [{ role: "user", content: "score this" }], "review", SCORE, { accountScope: null })).resolves.toMatchObject({ output: { score: 8 }, metadata: { usedFallback: true } });

    expect(hostsOf(fake)).toEqual(["fallback"]);
    expect(fake.calls[0].body.messages).not.toEqual([]);
  });
});
