import { beforeEach, describe, expect, it, vi } from "vitest";
import * as llm from "@/assistant/llm";
import { completeTextRouted, completeToolRouted, PromptBudgetExceededError } from "@/assistant/router";
import { setFallbackAcknowledgementAccountScope } from "@/assistant/fallbackDisclosure";
import { DEFAULT_SETTINGS, type AIIntegration, type AppSettings } from "@/types/settings";

function integration(id: string, maxInputTokens?: number): AIIntegration {
  return { id, name: id, provider: "openai", apiKey: "key", chatModels: [{ id: `${id}-m`, name: `${id}-model`, capabilities: ["default", "director"], maxInputTokens, maxOutputTokens: 100 }] };
}

function settings(integrations: AIIntegration[]): AppSettings {
  const [primary, ...fallbacks] = integrations;
  const route = { primary: { integrationId: primary.id, model: `${primary.id}-model` }, fallbacks: fallbacks.map((entry) => ({ integrationId: entry.id, model: `${entry.id}-model` })) };
  return { ...DEFAULT_SETTINGS, aiIntegrations: integrations, taskRouting: { default: route, director: route } };
}

const findings = `FINDINGS TO DECIDE:\n${"[S1-1] a finding that must not be lost. ".repeat(200)}\nEND OF FINDINGS`;
const tool = { name: "director_review", description: "d", parameters: { type: "object", properties: { verdict: { type: "string" } }, required: ["verdict"] } };
const metadata = { requestId: "r", task: "director" as const, provider: "openai" as const, integrationId: "big", model: "big-model", inputTokens: 1, cachedInputTokens: 0, outputTokens: 1 };

beforeEach(() => {
  vi.restoreAllMocks();
  setFallbackAcknowledgementAccountScope(null);
});

describe("prompts that must never be cut", () => {
  it("refuses a text prompt that fits no routed model instead of cutting its middle", async () => {
    const run = vi.spyOn(llm, "completeText");
    await expect(completeTextRouted(settings([integration("small", 1_000)]), [{ role: "user", content: findings }], "default", { accountScope: null, overflow: "fail" }))
      .rejects.toSatisfy((error: unknown) => error instanceof PromptBudgetExceededError && /Nothing was sent/.test(error.message) && !error.message.includes("finding that must not be lost"));
    expect(run).not.toHaveBeenCalled();
  });

  it("skips the models a prompt does not fit and sends it whole to one that fits", async () => {
    const run = vi.spyOn(llm, "completeText").mockResolvedValue("decided");
    const attempts: number[] = [];
    await expect(completeTextRouted(settings([integration("small", 1_000), integration("big", 200_000)]), [{ role: "user", content: findings }], "default", { accountScope: null, overflow: "fail", onAttempt: (index) => attempts.push(index), onFinish: () => undefined })).resolves.toBe("decided");
    expect(run).toHaveBeenCalledTimes(1);
    expect(run.mock.calls[0][0].id).toBe("big");
    expect(JSON.stringify(run.mock.calls[0][1])).toContain("END OF FINDINGS");
    expect(JSON.stringify(run.mock.calls[0][1])).not.toContain("Context truncated");
    expect(run.mock.calls[0][3]).toHaveProperty("onFinish");
    expect(attempts).toEqual([1]);
  });

  it("sends a prompt whole to a model whose context window is not configured", async () => {
    const run = vi.spyOn(llm, "completeText").mockResolvedValue("decided");
    const long = `${findings}\n${"Earlier chapters, kept whole. ".repeat(4_000)}`;
    await expect(completeTextRouted(settings([integration("unknown")]), [{ role: "user", content: long }], "default", { accountScope: null, overflow: "fail" })).resolves.toBe("decided");
    expect(JSON.stringify(run.mock.calls[0][1])).toContain("END OF FINDINGS");
    expect(JSON.stringify(run.mock.calls[0][1])).not.toContain("Context truncated");
  });

  it("does the same for forced tools, and keeps truncating for the other features", async () => {
    const run = vi.spyOn(llm, "completeToolWith").mockResolvedValue({ output: { verdict: "approve" }, metadata });
    await expect(completeToolRouted(settings([integration("small", 1_000)]), [{ role: "user", content: findings }], "director", tool, { accountScope: null, overflow: "fail" })).rejects.toBeInstanceOf(PromptBudgetExceededError);
    expect(run).not.toHaveBeenCalled();

    await completeToolRouted(settings([integration("small", 1_000), integration("big", 200_000)]), [{ role: "user", content: findings }], "director", tool, { accountScope: null, overflow: "fail" });
    expect(run.mock.calls[0][0].id).toBe("big");
    expect(JSON.stringify(run.mock.calls[0][3])).toContain("END OF FINDINGS");

    await completeToolRouted(settings([integration("small", 1_000)]), [{ role: "user", content: findings }], "director", tool, { accountScope: null });
    expect(JSON.stringify(run.mock.calls[1][3])).toContain("Context truncated");
  });
});
