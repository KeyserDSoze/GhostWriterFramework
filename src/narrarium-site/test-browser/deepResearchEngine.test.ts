import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({ complete: vi.fn(), research: vi.fn(), save: vi.fn() }));
vi.mock("@/assistant/router", () => ({ completeTextRouted: mocks.complete }));
vi.mock("@/assistant/llm", () => ({ completeText: vi.fn() }));
vi.mock("@/research/ResearchRouter", () => ({ runResearchRouter: mocks.research }));
vi.mock("@/github/githubClient", () => ({ createOrUpdateTextFile: mocks.save }));

import { runDeepResearch } from "@/research/engine";

describe("deep research engine integration", () => {
  beforeEach(() => {
    mocks.complete.mockReset(); mocks.research.mockReset(); mocks.save.mockReset();
  });

  it("calls routed LLM, research provider and repository persistence with progress", async () => {
    mocks.complete.mockResolvedValueOnce('["roman roads"]').mockResolvedValueOnce("# Roman Roads\n\nFindings.\n\n## Sources\n- https://example.test");
    mocks.research.mockResolvedValue({ results: [{ id: "1", title: "Roads", url: "https://example.test", source: "web", provider: "wikipedia", intent: "encyclopedia", snippet: "facts" }], providerUsage: [{ provider: "wikipedia", intent: "encyclopedia", ok: true, resultCount: 1 }], intentsResolved: ["encyclopedia"], unavailableIntents: [] });
    mocks.save.mockResolvedValue("sha");
    const progress = vi.fn();
    const result = await runDeepResearch({ settings: { aiIntegrations: [], ui: { language: "en" } } as any, book: { owner: "owner", repo: "repo" } as any, branch: "draft", token: "token", query: "Roman roads", depth: "low", language: "en", intents: ["encyclopedia"], onProgress: progress });
    expect(mocks.complete).toHaveBeenCalledTimes(2);
    expect(mocks.research).toHaveBeenCalledWith(expect.objectContaining({ query: "roman roads", depth: "low", intents: ["encyclopedia"] }));
    expect(mocks.save).toHaveBeenCalledWith("token", "owner", "repo", "draft", expect.stringMatching(/^research\//), expect.stringContaining("Roman Roads"), expect.stringContaining("Add research"));
    expect(progress).toHaveBeenCalledWith("Saving research document…");
    expect(result.path).toMatch(/^research\//);
  });
});
