import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({ complete: vi.fn(), research: vi.fn(), capture: vi.fn(), commit: vi.fn(), resolveHead: vi.fn() }));
vi.mock("@/assistant/router", () => ({ completeTextRouted: mocks.complete }));
vi.mock("@/assistant/llm", () => ({ completeText: vi.fn() }));
vi.mock("@/research/ResearchRouter", () => ({ runResearchRouter: mocks.research }));
vi.mock("@/assistant/immediateMutation", async (importOriginal) => ({
  ...await importOriginal<typeof import("@/assistant/immediateMutation")>(),
  captureImmediateMutation: mocks.capture,
  commitImmediateMutation: mocks.commit,
}));
vi.mock("@/repository/safeRepositoryMutation", async (importOriginal) => ({
  ...await importOriginal<typeof import("@/repository/safeRepositoryMutation")>(),
  resolveRepositoryHeadForMutation: mocks.resolveHead,
}));

import { runDeepResearch } from "@/research/engine";

describe("deep research engine integration", () => {
  beforeEach(() => {
    mocks.complete.mockReset(); mocks.research.mockReset(); mocks.capture.mockReset(); mocks.commit.mockReset(); mocks.resolveHead.mockReset();
    mocks.resolveHead.mockResolvedValue("source-head");
    mocks.capture.mockImplementation(async ({ path, remoteHeadSha }) => ({ path, content: null, sha: null, hash: null, remoteHeadSha }));
    mocks.commit.mockResolvedValue("next-head");
  });

  it("calls routed LLM, research provider and repository persistence with progress", async () => {
    mocks.complete.mockResolvedValueOnce('["roman roads"]').mockResolvedValueOnce("# Roman Roads\n\nFindings.\n\n## Sources\n- https://example.test");
    mocks.research.mockResolvedValue({ results: [{ id: "1", title: "Roads", url: "https://example.test", source: "web", provider: "wikipedia", intent: "encyclopedia", snippet: "facts" }], providerUsage: [{ provider: "wikipedia", intent: "encyclopedia", ok: true, resultCount: 1 }], intentsResolved: ["encyclopedia"], unavailableIntents: [] });
    const progress = vi.fn();
    const result = await runDeepResearch({ settings: { aiIntegrations: [], ui: { language: "en" } } as any, book: { owner: "owner", repo: "repo" } as any, branch: "draft", token: "token", query: "Roman roads", depth: "low", language: "en", intents: ["encyclopedia"], overrideIntegrationId: "selected", overrideModelName: "reasoning", onProgress: progress });
    expect(mocks.complete).toHaveBeenCalledTimes(2);
    expect(mocks.complete).toHaveBeenNthCalledWith(1, expect.anything(), expect.anything(), "deep-research", expect.objectContaining({ preferred: { integrationId: "selected", model: "reasoning" } }));
    expect(mocks.research).toHaveBeenCalledWith(expect.objectContaining({ query: "roman roads", depth: "low", intents: ["encyclopedia"] }));
    expect(mocks.resolveHead.mock.invocationCallOrder[0]).toBeLessThan(mocks.complete.mock.invocationCallOrder[0]);
    expect(mocks.capture).toHaveBeenCalledWith(expect.objectContaining({ path: expect.stringMatching(/^research\//), remoteHeadSha: "source-head" }));
    expect(mocks.commit).toHaveBeenCalledWith(expect.objectContaining({ content: expect.stringContaining("Roman Roads") }));
    expect(progress).toHaveBeenCalledWith("Saving research document…");
    expect(result.path).toMatch(/^research\//);
  });

  it("removes stale optional managed fields while preserving custom frontmatter", async () => {
    mocks.complete.mockResolvedValueOnce('["roman roads"]').mockResolvedValueOnce("# Roman Roads\n\nFindings.");
    mocks.research.mockResolvedValue({ results: [{ id: "1", title: "Roads", url: "https://example.test", source: "web", provider: "wikipedia", intent: "encyclopedia", snippet: "facts" }], providerUsage: [], intentsResolved: ["encyclopedia"], unavailableIntents: [] });
    mocks.capture.mockImplementation(async ({ path, remoteHeadSha }) => ({
      path,
      content: "---\ncreatedAt: 2020-01-01T00:00:00.000Z\nrelatedEntityId: character:old\nrelatedEntityType: character\ncustom: keep\n---\n\nOld",
      sha: "sha",
      hash: "hash",
      remoteHeadSha,
    }));
    await runDeepResearch({ settings: { aiIntegrations: [], ui: { language: "en" } } as any, book: { owner: "owner", repo: "repo" } as any, branch: "draft", token: "token", query: "Roman roads", depth: "low", language: "en", intents: ["encyclopedia"] });
    const content = mocks.commit.mock.calls[0][0].content as string;
    expect(content).toContain("custom: keep");
    expect(content).not.toContain("relatedEntityId");
    expect(content).not.toContain("relatedEntityType");
  });
});
