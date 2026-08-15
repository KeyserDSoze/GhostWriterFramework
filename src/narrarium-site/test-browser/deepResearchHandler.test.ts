import { describe, expect, it, vi } from "vitest";
import { executeDeepResearchFromCopilot } from "@/assistant/deepResearchHandler";
import type { RunDeepResearchInput, RunDeepResearchResult } from "@/research/engine";

describe("deep research Copilot adapter", () => {
  it("passes routed inputs, progress and cancellation to the persistence engine", async () => {
    const progress = vi.fn();
    const controller = new AbortController();
    const runner = vi.fn(async (input: RunDeepResearchInput): Promise<RunDeepResearchResult> => {
      input.onProgress("provider search");
      return { path: "research/result.md", slug: "result", title: "Result", markdown: "# Result", cost: 1, providers: ["wikipedia"], providerUsage: [], intentsResolved: ["encyclopedia"], unavailableSummary: [] };
    });
    const result = await executeDeepResearchFromCopilot({ prompt: "run deep research on Roman roads using wikipedia", settings: { ui: { language: "en" } } as any, structureLanguage: "it", book: { id: "book" } as any, branch: "draft", token: "token", signal: controller.signal, onText: progress }, runner);
    expect(runner).toHaveBeenCalledWith(expect.objectContaining({ query: "Roman roads", depth: "high", intents: ["encyclopedia"], language: "it", branch: "draft", token: "token", signal: controller.signal }));
    expect(progress).toHaveBeenCalledWith("provider search");
    expect(result?.path).toBe("research/result.md");
  });
});
