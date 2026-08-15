import { beforeEach, describe, expect, it, vi } from "vitest";
import { DEFAULT_SETTINGS } from "@/types/settings";

const mocks = vi.hoisted(() => ({
  completeTextRouted: vi.fn(),
  scoreEvaluationRouted: vi.fn(),
}));

vi.mock("@/assistant/router", async (importOriginal) => ({
  ...await importOriginal<typeof import("@/assistant/router")>(),
  completeTextRouted: mocks.completeTextRouted,
}));

vi.mock("@/assistant/service", () => ({
  resolveEvaluationCriteria: () => ({ pacing: "Pacing" }),
  scoreEvaluationRouted: mocks.scoreEvaluationRouted,
}));

vi.mock("@/github/githubClient", () => ({
  loadFileContent: vi.fn().mockResolvedValue("---\ncriteria:\n  pacing: Pacing\n---\n"),
}));

import { generateParagraphEvaluationWithScores, type PipelineSource } from "@/narrarium/pipeline";

function source(signal?: AbortSignal): PipelineSource {
  return {
    token: "token",
    owner: "owner",
    repo: "repo",
    branch: "main",
    settings: DEFAULT_SETTINGS,
    structure: { language: "en", ghostwriters: [] } as unknown as PipelineSource["structure"],
    signal,
  };
}

describe("pipeline evaluation scoring", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.completeTextRouted.mockResolvedValue("Evaluation body");
  });

  it("passes one AbortSignal through prose and scoring and preserves routed metadata", async () => {
    const controller = new AbortController();
    const metadata = {
      requestId: "request",
      task: "review" as const,
      provider: "openai" as const,
      integrationId: "fallback-integration",
      model: "review-model",
      inputTokens: 120,
      cachedInputTokens: 20,
      outputTokens: 15,
      cost: 0.12,
      currency: "USD",
      routeCandidateIndex: 1,
      usedFallback: true,
    };
    mocks.scoreEvaluationRouted.mockImplementation(async (_settings, _prompt, _criteria, options) => {
      options.onMetadata(metadata);
      return { pacing: { score: 7, explanation: "Evidence" } };
    });

    const result = await generateParagraphEvaluationWithScores(source(), "Scene", "Prose", { signal: controller.signal });

    expect(mocks.completeTextRouted.mock.calls[0][3].signal).toBe(controller.signal);
    expect(mocks.scoreEvaluationRouted.mock.calls[0][3]).toMatchObject({ signal: controller.signal, label: "evaluation:paragraph-scoring" });
    expect(result.scoreGeneration).toEqual(metadata);
    expect(result.scores?.pacing.score).toBe(7);
  });

  it("does not start scoring when cancellation arrives after prose generation", async () => {
    const controller = new AbortController();
    mocks.completeTextRouted.mockImplementation(async () => {
      controller.abort();
      return "Evaluation body";
    });

    await expect(generateParagraphEvaluationWithScores(source(controller.signal), "Scene", "Prose")).rejects.toMatchObject({ name: "AbortError" });
    expect(mocks.scoreEvaluationRouted).not.toHaveBeenCalled();
  });
});
