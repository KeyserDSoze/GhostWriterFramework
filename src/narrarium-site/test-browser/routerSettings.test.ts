import { beforeEach, describe, expect, it, vi } from "vitest";
import * as llm from "@/assistant/llm";
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

describe("routed tool execution", () => {
  beforeEach(() => vi.restoreAllMocks());

  it("falls back on invalid structured output and preserves actual usage and cost metadata", async () => {
    const primary = integration("primary", [{ id: "p", name: "primary", capabilities: ["review"] }]);
    const fallback = integration("fallback", [{ id: "f", name: "fallback", capabilities: ["review"] }]);
    const run = vi.spyOn(llm, "completeToolWith")
      .mockResolvedValueOnce({ output: { score: -1 }, metadata: { requestId: "primary", task: "review", provider: "openai", integrationId: "primary", model: "primary", inputTokens: 1, cachedInputTokens: 0, outputTokens: 1 } })
      .mockResolvedValueOnce({ output: { score: 8 }, metadata: { requestId: "fallback", task: "review", provider: "openai", integrationId: "fallback", model: "fallback", inputTokens: 12, cachedInputTokens: 2, outputTokens: 4, cost: 0.42, currency: "USD" } });
    const configured = settings([primary, fallback], { taskRouting: { review: { primary: { integrationId: "primary", model: "primary" }, fallbacks: [{ integrationId: "fallback", model: "fallback" }] } } });

    const result = await completeToolRouted<{ score: number }>(configured, [{ role: "user", content: "score" }], "review", { name: "score", description: "score", parameters: {} }, {
      accountScope: null,
      validate: (value) => {
        const score = (value as { score?: unknown }).score;
        if (typeof score !== "number" || score < 0) throw new Error("invalid score");
        return { score };
      },
    });

    expect(result.output).toEqual({ score: 8 });
    expect(result.metadata).toMatchObject({ integrationId: "fallback", requestId: "fallback", cost: 0.42, inputTokens: 12, routeCandidateIndex: 1, usedFallback: true });
    expect(run.mock.calls[0][6]).toMatchObject({ routeCandidateIndex: 0, usedFallback: false });
    expect(run.mock.calls[1][6]).toMatchObject({ routeCandidateIndex: 1, usedFallback: true });
  });

  it("falls back when candidate-level text validation rejects malformed structured output", async () => {
    const primary = integration("primary", [{ id: "p", name: "primary", capabilities: ["default"] }]);
    const fallback = integration("fallback", [{ id: "f", name: "fallback", capabilities: ["default"] }]);
    vi.spyOn(llm, "completeText").mockResolvedValueOnce("not json").mockResolvedValueOnce('{"title":"Valid"}');
    const configured = settings([primary, fallback], { taskRouting: { default: { primary: { integrationId: "primary", model: "primary" }, fallbacks: [{ integrationId: "fallback", model: "fallback" }] } } });
    await expect(completeTextRouted(configured, [{ role: "user", content: "create" }], "default", { accountScope: null, validateText: (text) => { JSON.parse(text); } })).resolves.toBe('{"title":"Valid"}');
  });

  it("filters forced-tool-incompatible candidates and caps route length", async () => {
    const integrations = Array.from({ length: 6 }, (_, index) => ({ ...integration(`ai-${index}`, [{ id: `m-${index}`, name: `model-${index}`, capabilities: ["review"] }]), chatModels: [{ id: `m-${index}`, name: `model-${index}`, capabilities: ["review" as const], supportsToolCalls: index !== 0 }] }));
    const configured = settings(integrations, { routingExecution: { ...DEFAULT_SETTINGS.routingExecution, maxCandidates: 3 }, taskRouting: { review: { primary: { integrationId: "ai-0", model: "model-0" }, fallbacks: integrations.slice(1).map((entry, index) => ({ integrationId: entry.id, model: `model-${index + 1}` })) } } });
    expect(resolveTaskCandidates(configured, "review")).toHaveLength(3);
    const run = vi.spyOn(llm, "completeToolWith").mockResolvedValue({ output: { ok: true }, metadata: { requestId: "ok", task: "review", provider: "openai", integrationId: "ai-1", model: "model-1", inputTokens: 1, cachedInputTokens: 0, outputTokens: 1 } });
    await completeToolRouted(configured, [{ role: "user", content: "x" }], "review", { name: "x", description: "x", parameters: {} }, { accountScope: null });
    expect(run.mock.calls[0][0].id).toBe("ai-1");
  });

  it("falls back on provider AbortError and distinguishes an entirely stale route", async () => {
    const ai = integration("ai", [{ id: "model", name: "model", capabilities: ["review"] }]);
    const fallback = integration("fallback", [{ id: "fallback", name: "fallback", capabilities: ["review"] }]);
    const abort = new DOMException("aborted", "AbortError");
    const run = vi.spyOn(llm, "completeToolWith").mockRejectedValueOnce(abort).mockResolvedValueOnce({ output: { score: 8 }, metadata: { requestId: "fallback", task: "review", provider: "openai", integrationId: "fallback", model: "fallback", inputTokens: 1, cachedInputTokens: 0, outputTokens: 1 } });
    const configured = settings([ai, fallback], { taskRouting: { review: { primary: { integrationId: "ai", model: "model" }, fallbacks: [{ integrationId: "fallback", model: "fallback" }] } } });
    await expect(completeToolRouted(configured, [], "review", { name: "score", description: "score", parameters: {} }, { accountScope: null })).resolves.toMatchObject({ output: { score: 8 } });
    expect(run).toHaveBeenCalledTimes(2);

    const stale = settings([ai], { taskRouting: { review: { primary: { integrationId: "ai", model: "removed" }, fallbacks: [] } } });
    await expect(completeToolRouted(stale, [], "review", { name: "score", description: "score", parameters: {} }, { accountScope: null })).rejects.toBeInstanceOf(StaleRoutingConfigurationError);
  });

  it("prepends a selected override while retaining budgeted configured fallback", async () => {
    const selected = { ...integration("selected", [{ id: "s", name: "selected", capabilities: ["default"] }]), requestTimeoutMs: 5 };
    selected.chatModels![0].maxInputTokens = 120;
    selected.chatModels![0].maxOutputTokens = 11;
    const fallback = integration("fallback", [{ id: "f", name: "fallback", capabilities: ["default"] }]);
    const run = vi.spyOn(llm, "completeText").mockRejectedValueOnce(new Error("provider failed")).mockResolvedValueOnce("fallback");
    const configured = settings([selected, fallback], { taskRouting: { default: { primary: { integrationId: "fallback", model: "fallback" }, fallbacks: [] } } });

    await expect(completeTextRouted(configured, [{ role: "user", content: "x".repeat(2_000) }], "default", { accountScope: null, preferred: { integrationId: "selected", model: "selected" } })).resolves.toBe("fallback");
    expect(run.mock.calls.map((call) => call[0].id)).toEqual(["selected", "fallback"]);
    expect(JSON.stringify(run.mock.calls[0][1])).toContain("Context truncated");
    expect(run.mock.calls[0][3]).toMatchObject({ maxOutputTokens: 11, usedFallback: false });
    expect(run.mock.calls[1][3]).toMatchObject({ usedFallback: true });
  });
});

describe("account-scoped routed execution", () => {
  beforeEach(() => vi.restoreAllMocks());

  it("aborts before fallback when the authenticated account changes between attempts", async () => {
    const primary = integration("primary", [{ id: "p", name: "primary", capabilities: ["default"] }]);
    const fallback = integration("fallback", [{ id: "f", name: "fallback", capabilities: ["default"] }]);
    const configured = settings([primary, fallback], { taskRouting: { default: { primary: { integrationId: "primary", model: "primary" }, fallbacks: [{ integrationId: "fallback", model: "fallback" }] } } });
    setFallbackAcknowledgementAccountScope("google:first@example.com");
    const run = vi.spyOn(llm, "completeText").mockImplementation(async () => {
      setFallbackAcknowledgementAccountScope("google:second@example.com");
      throw new Error("primary failed after account switch");
    });

    await expect(completeTextRouted(configured, [{ role: "user", content: "request" }], "default", { accountScope: "google:first@example.com" })).rejects.toMatchObject({ name: "AbortError" });
    expect(run).toHaveBeenCalledOnce();
  });
});

describe("routed execution limits", () => {
  beforeEach(() => vi.restoreAllMocks());

  it("uses each candidate's token limits and advances after a provider timeout", async () => {
    const primary = { ...integration("primary", [{ id: "p", name: "primary", capabilities: ["default"] }]), requestTimeoutMs: 5 };
    primary.chatModels![0].maxInputTokens = 120;
    primary.chatModels![0].maxOutputTokens = 17;
    const fallback = integration("fallback", [{ id: "f", name: "fallback", capabilities: ["default"] }]);
    fallback.chatModels![0].maxInputTokens = 500;
    fallback.chatModels![0].maxOutputTokens = 29;
    const run = vi.spyOn(llm, "completeText")
      .mockImplementationOnce(async (_integration, _messages, _purpose, options) => {
        await new Promise((_, reject) => options?.signal?.addEventListener("abort", () => reject(new DOMException("aborted", "AbortError")), { once: true }));
        return "unreachable";
      })
      .mockResolvedValueOnce("fallback result");
    const configured = settings([primary, fallback], { taskRouting: { default: { primary: { integrationId: "primary", model: "primary" }, fallbacks: [{ integrationId: "fallback", model: "fallback" }] } } });
    const messages = [{ role: "user" as const, content: `Long chapter start\n${"x".repeat(8_000)}\nLong chapter end` }];

    await expect(completeTextRouted(configured, messages, "default", { accountScope: null })).resolves.toBe("fallback result");
    expect(run).toHaveBeenCalledTimes(2);
    expect(JSON.stringify(run.mock.calls[0][1])).toContain("Context truncated");
    expect(run.mock.calls[0][3]).toMatchObject({ maxOutputTokens: 17, usedFallback: false });
    expect(run.mock.calls[1][3]).toMatchObject({ maxOutputTokens: 29, usedFallback: true });
  });

  it("does not treat user cancellation as a provider timeout", async () => {
    const controller = new AbortController();
    const ai = integration("ai", [{ id: "m", name: "model", capabilities: ["default"] }]);
    const run = vi.spyOn(llm, "completeText").mockImplementation(async (_integration, _messages, _purpose, options) => {
      controller.abort(new DOMException("cancelled", "AbortError"));
      options?.signal?.throwIfAborted();
      return "unreachable";
    });

    await expect(completeTextRouted(settings([ai]), [{ role: "user", content: "hello" }], "default", { accountScope: null, signal: controller.signal })).rejects.toMatchObject({ name: "AbortError" });
    expect(run).toHaveBeenCalledTimes(1);
  });

  it("applies the same timeout fallback semantics to forced-tool execution", async () => {
    const primary = { ...integration("primary", [{ id: "p", name: "primary", capabilities: ["review"] }]), requestTimeoutMs: 5 };
    const fallback = integration("fallback", [{ id: "f", name: "fallback", capabilities: ["review"] }]);
    const run = vi.spyOn(llm, "completeToolWith")
      .mockImplementationOnce(async (_integration, _model, _pricing, _messages, _capability, _tool, options) => {
        await new Promise((_, reject) => options?.signal?.addEventListener("abort", () => reject(new DOMException("aborted", "AbortError")), { once: true }));
        throw new Error("unreachable");
      })
      .mockResolvedValueOnce({ output: { score: 9 }, metadata: { requestId: "fallback", task: "review", provider: "openai", integrationId: "fallback", model: "fallback", inputTokens: 1, cachedInputTokens: 0, outputTokens: 1 } });
    const configured = settings([primary, fallback], { taskRouting: { review: { primary: { integrationId: "primary", model: "primary" }, fallbacks: [{ integrationId: "fallback", model: "fallback" }] } } });

    const result = await completeToolRouted(configured, [{ role: "user", content: "score" }], "review", { name: "score", description: "score", parameters: {} }, { accountScope: null });
    expect(result.metadata).toMatchObject({ integrationId: "fallback", usedFallback: true });
    expect(run).toHaveBeenCalledTimes(2);
  });

  it("bounds confirmation classification candidates too", async () => {
    const primary = { ...integration("primary", [{ id: "p", name: "primary", capabilities: ["default"] }]), requestTimeoutMs: 5 };
    const fallback = integration("fallback", [{ id: "f", name: "fallback", capabilities: ["default"] }]);
    const configured = settings([primary, fallback], { taskRouting: { "simple-tasks": { primary: { integrationId: "primary", model: "primary" }, fallbacks: [{ integrationId: "fallback", model: "fallback" }] } } });
    const run = vi.spyOn(llm, "classifyConfirmationWith")
      .mockImplementationOnce(async (_integration, _model, _pricing, _utterance, options) => {
        await new Promise((_, reject) => options?.signal?.addEventListener("abort", () => reject(new DOMException("aborted", "AbortError")), { once: true }));
        return "unclear";
      })
      .mockResolvedValueOnce("yes");

    await expect(classifyConfirmationRouted(configured, "continue?", undefined, null)).resolves.toBe("yes");
    expect(run).toHaveBeenCalledTimes(2);
    const framed = run.mock.calls[0][3];
    expect(framed.match(/continue\?/g)).toHaveLength(1);
    expect(framed).toContain('<current_request trust="user-instruction">');
  });

  it("propagates operation cancellation through confirmation classification", async () => {
    const controller = new AbortController();
    const ai = integration("ai", [{ id: "m", name: "model", capabilities: ["default"] }]);
    const run = vi.spyOn(llm, "classifyConfirmationWith").mockImplementation(async (_integration, _model, _pricing, _utterance, options) => {
      controller.abort(new DOMException("operation stopped", "AbortError"));
      options?.signal?.throwIfAborted();
      return "unclear";
    });

    await expect(classifyConfirmationRouted(settings([ai]), "perhaps", controller.signal, null)).rejects.toMatchObject({ name: "AbortError" });
    expect(run).toHaveBeenCalledTimes(1);
  });

  it("skips confirmation candidates whose schema cannot fit and truncates the utterance for fallback", async () => {
    const primary = integration("primary", [{ id: "p", name: "primary", capabilities: ["default"] }]);
    primary.chatModels![0].maxInputTokens = 100;
    const fallback = integration("fallback", [{ id: "f", name: "fallback", capabilities: ["default"] }]);
    fallback.chatModels![0].maxInputTokens = 1_000;
    fallback.chatModels![0].maxOutputTokens = 100;
    const configured = settings([primary, fallback], { taskRouting: { "simple-tasks": { primary: { integrationId: "primary", model: "primary" }, fallbacks: [{ integrationId: "fallback", model: "fallback" }] } } });
    const run = vi.spyOn(llm, "classifyConfirmationWith").mockResolvedValue("yes");

    await expect(classifyConfirmationRouted(configured, `confirm-start ${"private".repeat(1_000)} confirm-end`, undefined, null)).resolves.toBe("yes");
    expect(run).toHaveBeenCalledTimes(1);
    expect(run.mock.calls[0][0].id).toBe("fallback");
    expect(run.mock.calls[0][3]).toContain("Context truncated");
    expect(run.mock.calls[0][3].length).toBeLessThan(1_000);
  });

  it("never dispatches a forced-tool request when the schema alone exhausts every candidate", async () => {
    const primary = integration("primary", [{ id: "p", name: "primary", capabilities: ["review"] }]);
    primary.chatModels![0].maxInputTokens = 20;
    const fallback = integration("fallback", [{ id: "f", name: "fallback", capabilities: ["review"] }]);
    fallback.chatModels![0].maxInputTokens = 20;
    const configured = settings([primary, fallback], { taskRouting: { review: { primary: { integrationId: "primary", model: "primary" }, fallbacks: [{ integrationId: "fallback", model: "fallback" }] } } });
    const run = vi.spyOn(llm, "completeToolWith");
    const sensitivePrompt = "private prompt that must not appear in diagnostics";

    await expect(completeToolRouted(configured, [{ role: "user", content: sensitivePrompt }], "review", { name: "large", description: "x".repeat(100), parameters: {} }, { accountScope: null })).rejects.toSatisfy((error: unknown) => {
      return error instanceof CandidateInputBudgetError && error.message.includes("budget exhausted") && !error.message.includes(sensitivePrompt);
    });
    expect(run).not.toHaveBeenCalled();
  });

  it("skips a schema-overflow forced-tool candidate and dispatches only the fitting fallback", async () => {
    const primary = integration("primary", [{ id: "p", name: "primary", capabilities: ["review"] }]);
    primary.chatModels![0].maxInputTokens = 20;
    const fallback = integration("fallback", [{ id: "f", name: "fallback", capabilities: ["review"] }]);
    fallback.chatModels![0].maxInputTokens = 1_000;
    fallback.chatModels![0].maxOutputTokens = 100;
    const configured = settings([primary, fallback], { taskRouting: { review: { primary: { integrationId: "primary", model: "primary" }, fallbacks: [{ integrationId: "fallback", model: "fallback" }] } } });
    const run = vi.spyOn(llm, "completeToolWith").mockResolvedValue({ output: { score: 8 }, metadata: { requestId: "fallback", task: "review", provider: "openai", integrationId: "fallback", model: "fallback", inputTokens: 1, cachedInputTokens: 0, outputTokens: 1 } });

    await expect(completeToolRouted(configured, [{ role: "user", content: "score this" }], "review", { name: "score", description: "score", parameters: {} }, { accountScope: null })).resolves.toMatchObject({ output: { score: 8 }, metadata: { usedFallback: true } });
    expect(run).toHaveBeenCalledTimes(1);
    expect(run.mock.calls[0][0].id).toBe("fallback");
    expect(run.mock.calls[0][3]).not.toEqual([]);
  });
});
