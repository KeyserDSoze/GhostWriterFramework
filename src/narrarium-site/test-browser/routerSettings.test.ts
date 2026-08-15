import { beforeEach, describe, expect, it, vi } from "vitest";
import * as llm from "@/assistant/llm";
import {
  BROWSER_ROUTING_ID,
  completeToolRouted,
  reconcileTaskRouting,
  resolveTaskCandidates,
  StaleRoutingConfigurationError,
} from "@/assistant/router";
import { migrateSettings } from "@/drive/cloudSettingsClient";
import { DEFAULT_SETTINGS, type AIIntegration, type AppSettings } from "@/types/settings";

function integration(id: string, models: Array<{ id: string; name: string; capabilities: Array<"default" | "review"> }>): AIIntegration {
  return { id, name: id, provider: "openai", apiKey: "key", chatModels: models };
}

function settings(integrations: AIIntegration[], patch: Partial<AppSettings> = {}): AppSettings {
  return { ...DEFAULT_SETTINGS, aiIntegrations: integrations, ...patch };
}

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

  it("stops fallback execution on abort and distinguishes an entirely stale route", async () => {
    const ai = integration("ai", [{ id: "model", name: "model", capabilities: ["review"] }]);
    const abort = new DOMException("aborted", "AbortError");
    const run = vi.spyOn(llm, "completeToolWith").mockRejectedValue(abort);
    const configured = settings([ai], { taskRouting: { review: { primary: { integrationId: "ai", model: "model" }, fallbacks: [{ integrationId: "ai", model: "model" }] } } });
    await expect(completeToolRouted(configured, [], "review", { name: "score", description: "score", parameters: {} })).rejects.toBe(abort);
    expect(run).toHaveBeenCalledTimes(1);

    const stale = settings([ai], { taskRouting: { review: { primary: { integrationId: "ai", model: "removed" }, fallbacks: [] } } });
    await expect(completeToolRouted(stale, [], "review", { name: "score", description: "score", parameters: {} })).rejects.toBeInstanceOf(StaleRoutingConfigurationError);
  });
});
