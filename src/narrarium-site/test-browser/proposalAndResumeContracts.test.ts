import { beforeEach, describe, expect, it, vi } from "vitest";
import type { LoadedWriterContext } from "@/assistant/context";
import type { AppSettings, BookEntry } from "@/types/settings";

const mocks = vi.hoisted(() => ({
  completeTextRouted: vi.fn(),
  completeToolRouted: vi.fn(),
  resolveTaskCandidates: vi.fn(),
  readFileWithSha: vi.fn(),
  loadFileContent: vi.fn(),
  captureImmediateMutation: vi.fn(),
  commitImmediateMutation: vi.fn(),
  commitImmediateMutations: vi.fn(),
  resolveRepositoryHeadForMutation: vi.fn(),
  executeDeepResearchFromCopilot: vi.fn(),
}));

vi.mock("@/assistant/router", async (importOriginal) => ({
  ...await importOriginal<typeof import("@/assistant/router")>(),
  completeTextRouted: mocks.completeTextRouted,
  completeToolRouted: mocks.completeToolRouted,
  resolveTaskCandidates: mocks.resolveTaskCandidates,
}));

vi.mock("@/github/githubClient", async (importOriginal) => ({
  ...await importOriginal<typeof import("@/github/githubClient")>(),
  readFileWithSha: mocks.readFileWithSha,
  loadFileContent: mocks.loadFileContent,
}));

vi.mock("@/assistant/immediateMutation", async (importOriginal) => ({
  ...await importOriginal<typeof import("@/assistant/immediateMutation")>(),
  captureImmediateMutation: mocks.captureImmediateMutation,
  commitImmediateMutation: mocks.commitImmediateMutation,
  commitImmediateMutations: mocks.commitImmediateMutations,
}));

vi.mock("@/repository/safeRepositoryMutation", async (importOriginal) => ({
  ...await importOriginal<typeof import("@/repository/safeRepositoryMutation")>(),
  resolveRepositoryHeadForMutation: mocks.resolveRepositoryHeadForMutation,
}));

vi.mock("@/assistant/deepResearchHandler", () => ({ executeDeepResearchFromCopilot: mocks.executeDeepResearchFromCopilot }));

import { runAssistantPrompt } from "@/assistant/service";
import { BUILTIN_TOOLS } from "@/assistant/tools/builtinTools";

const book = { id: "book", name: "Book", owner: "owner", repo: "repo", tokenIndex: null, addedAt: "now" } satisfies BookEntry;
const paragraph = { number: "001", title: "Opening", path: "chapters/001-start/001-opening.md" };
const chapter = { slug: "001-start", title: "Start", path: "chapters/001-start", paragraphs: [paragraph], hasResume: false, hasEvaluation: false };
const structure = { title: "Book", language: "en", defaultBranch: "main", loadedBranch: "main", chapters: [chapter], characters: [], locations: [], factions: [], items: [], timelines: [], researchFiles: [], readerEvaluationFiles: [] };
const context = {
  route: { kind: "paragraph", bookId: "book", chapterId: chapter.slug, paragraphNum: paragraph.number },
  book,
  structure,
  chapter,
  paragraph,
  relevantFiles: [],
  availableFiles: [],
  loadedFilePaths: [],
  noteTargetPath: "drafts/001-start/notes.md",
  branch: "main",
  branchReady: true,
  title: "Opening",
  summary: "Opening paragraph",
} as unknown as LoadedWriterContext;
const integration = { id: "ai", name: "AI", provider: "openai", apiKey: "key", chatModels: [{ id: "model", name: "model", capabilities: ["default", "chat-resume"] }] };
const settings = { ui: { language: "en" }, copilotTools: { toolOverrides: {} }, aiIntegrations: [integration] } as unknown as AppSettings;

function prompt(text: string) {
  return runAssistantPrompt({ prompt: text, context, settings, book, branch: "main", token: "token", history: [], compactSummary: "", compactedMessageCount: 0, attachments: [] });
}

function evaluateAllPrompt(signal?: AbortSignal) {
  const second = { number: "002", title: "Middle", path: "chapters/001-start/002-middle.md" };
  const multiChapter = { ...chapter, paragraphs: [paragraph, second] };
  const multiContext = { ...context, route: { kind: "chapter", bookId: "book", chapterId: chapter.slug }, chapter: multiChapter, paragraph: undefined, structure: { ...structure, chapters: [multiChapter] } } as unknown as LoadedWriterContext;
  return runAssistantPrompt({ prompt: "evaluate all paragraphs of chapter 1", context: multiContext, settings, book, branch: "main", token: "token", history: [], compactSummary: "", compactedMessageCount: 0, attachments: [], signal });
}

describe("proposal mutation contracts", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.resolveTaskCandidates.mockReturnValue([{ integration, model: "model" }]);
  });

  it("classifies paragraph rewrite proposals as mutating", () => {
    expect(BUILTIN_TOOLS.find((tool) => tool.id === "rewrite-current-paragraph")).toMatchObject({ mutatesData: true, destructive: false });
  });

  it.each([
    ["do not rewrite this paragraph", "did not run"],
    ["how would you rewrite this paragraph?", "explicit editing request"],
  ])("does not invoke an LLM or produce an apply action for %s", async (request, expectedText) => {
    const message = await prompt(request);
    expect(message.text).toContain(expectedText);
    expect(message.action).toBeUndefined();
    expect(mocks.completeTextRouted).not.toHaveBeenCalled();
    expect(mocks.readFileWithSha).not.toHaveBeenCalled();
  });

  it("runs an explicit rewrite as a reviewable apply proposal", async () => {
    mocks.readFileWithSha.mockResolvedValue({ content: "---\ntitle: Opening\n---\nOriginal body", sha: "paragraph-sha" });
    mocks.completeTextRouted.mockResolvedValue("Rewritten body");
    const message = await prompt("rewrite this paragraph");
    expect(message.action).toMatchObject({ kind: "apply-paragraph-rewrite", toolId: "rewrite-current-paragraph", proposedBody: "Rewritten body" });
    expect(message.mutation).toBeUndefined();
    expect(mocks.completeTextRouted).toHaveBeenCalledTimes(1);
  });
});

describe("write resume route contract", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.resolveTaskCandidates.mockReturnValue([{ integration, model: "model" }]);
    mocks.captureImmediateMutation.mockResolvedValue({ path: "resumes/chapters/001-start.md", content: null, sha: null, hash: null, remoteHeadSha: "head" });
    mocks.commitImmediateMutation.mockResolvedValue("commit");
    mocks.completeTextRouted.mockResolvedValue("Complete resume");
  });

  it.each([
    ["single chunk", 100, 1],
    ["multiple chunks", 31_000, 5],
  ])("uses only chat-resume for %s execution", async (_case, sourceSize, expectedCalls) => {
    mocks.loadFileContent.mockResolvedValue("x".repeat(sourceSize));
    const message = await prompt("write the resume");
    expect(message.mutation?.changedPaths).toEqual(["resumes/chapters/001-start.md"]);
    expect(mocks.completeTextRouted).toHaveBeenCalledTimes(expectedCalls);
    expect(mocks.completeTextRouted.mock.calls.map((call) => call[2])).toEqual(Array(expectedCalls).fill("chat-resume"));
  });
});

describe("immediate creation handler paths", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.resolveTaskCandidates.mockReturnValue([{ integration, model: "model" }]);
    mocks.resolveRepositoryHeadForMutation.mockResolvedValue("source-head");
    mocks.captureImmediateMutation.mockImplementation(async ({ path, remoteHeadSha }) => ({ path, content: null, sha: null, hash: null, remoteHeadSha }));
    mocks.commitImmediateMutations.mockResolvedValue("commit");
  });

  it("captures the branch head before generating and atomically creates chapter files", async () => {
    mocks.completeTextRouted.mockResolvedValue('{"title":"Next","summary":"Summary","body":"Body"}');
    const message = await prompt("create chapter");

    expect(mocks.resolveRepositoryHeadForMutation.mock.invocationCallOrder[0]).toBeLessThan(mocks.completeTextRouted.mock.invocationCallOrder[0]);
    expect(mocks.captureImmediateMutation).toHaveBeenCalledTimes(3);
    expect(mocks.commitImmediateMutations).toHaveBeenCalledWith(expect.objectContaining({
      snapshots: expect.arrayContaining([
        expect.objectContaining({ snapshot: expect.objectContaining({ path: "chapters/002-next/chapter.md", remoteHeadSha: "source-head" }) }),
        expect.objectContaining({ snapshot: expect.objectContaining({ path: "resumes/chapters/002-next.md", remoteHeadSha: "source-head" }) }),
        expect.objectContaining({ snapshot: expect.objectContaining({ path: "evaluations/chapters/002-next.md", remoteHeadSha: "source-head" }) }),
      ]),
    }));
    expect(message.mutation?.changedPaths).toHaveLength(3);
  });

  it("uses the pre-generation head and replacement mode for attachment draft imports", async () => {
    mocks.completeTextRouted.mockResolvedValue('{"title":"Imported","body":"New body"}');
    mocks.captureImmediateMutation.mockImplementation(async ({ path, remoteHeadSha }) => ({
      path,
      content: path.endsWith("001-opening.md") ? "---\ntype: paragraph-draft\ncustom: keep\n---\n\nOld" : null,
      sha: "sha",
      hash: "hash",
      remoteHeadSha,
    }));
    const message = await runAssistantPrompt({
      prompt: "import attachment as draft",
      context,
      settings,
      book,
      branch: "main",
      token: "token",
      history: [],
      compactSummary: "",
      compactedMessageCount: 0,
      attachments: [{ id: "a", name: "source.txt", mimeType: "text/plain", kind: "text", sizeBytes: 4, textContent: "text" }],
      attachmentTarget: "draft",
    });

    expect(mocks.resolveRepositoryHeadForMutation.mock.invocationCallOrder[0]).toBeLessThan(mocks.completeTextRouted.mock.invocationCallOrder[0]);
    const content = mocks.commitImmediateMutations.mock.calls[0][0].snapshots[0].content;
    expect(content).toContain("custom: keep");
    expect(content).toContain("New body");
    expect(message.mutation?.changedPaths).toEqual(["drafts/001-start/001-opening.md"]);
  });

  it("returns conflict choices when a create races with another writer", async () => {
    const { RepositoryConflictError } = await import("@/repository/safeRepositoryMutation");
    mocks.completeTextRouted.mockResolvedValue('{"title":"Next","summary":"Summary","body":"Body"}');
    mocks.commitImmediateMutations.mockRejectedValue(new RepositoryConflictError("branch changed"));
    const message = await prompt("create chapter");
    expect(message.text).toContain("**Diff**");
    expect(message.text).toContain("**Regenerate**");
    expect(message.text).toContain("**Merge**");
    expect(message.mutation).toBeUndefined();
  });

  it("passes the pre-generation head through the deep-research handler", async () => {
    mocks.executeDeepResearchFromCopilot.mockResolvedValue({ path: "research/result.md", title: "Result", providers: ["wikipedia"] });
    const message = await prompt("run deep research on aqueducts");
    expect(mocks.executeDeepResearchFromCopilot).toHaveBeenCalledWith(expect.objectContaining({ expectedRemoteHeadSha: "source-head" }));
    expect(message.mutation?.changedPaths).toEqual(["research/result.md"]);
  });

  it("commits fallback evaluation guidelines without resetting the source head", async () => {
    mocks.completeTextRouted.mockResolvedValue("Critical evaluation");
    mocks.completeToolRouted.mockImplementation(async (_settings, _messages, _capability, tool) => ({
      output: Object.fromEntries(Object.keys(tool.parameters.properties.criteria.properties).map((key) => [key, { score: 6, explanation: "Evidence" }])),
      metadata: {},
    }));
    mocks.loadFileContent.mockResolvedValue("---\ntitle: Opening\n---\n\nSource body");
    const message = await prompt("evaluate this paragraph");

    expect(mocks.resolveRepositoryHeadForMutation).toHaveBeenCalledTimes(2);
    expect(mocks.captureImmediateMutation).toHaveBeenCalledWith(expect.objectContaining({ path: "evaluation-guidelines.md", remoteHeadSha: "source-head" }));
    expect(mocks.captureImmediateMutation).toHaveBeenCalledWith(expect.objectContaining({ path: "evaluations/paragraphs/001-start/001-opening.md", remoteHeadSha: "source-head" }));
    expect(mocks.commitImmediateMutations).toHaveBeenCalledWith(expect.objectContaining({
      snapshots: expect.arrayContaining([
        expect.objectContaining({ snapshot: expect.objectContaining({ path: "evaluation-guidelines.md", remoteHeadSha: "source-head" }) }),
        expect.objectContaining({ snapshot: expect.objectContaining({ path: "evaluations/paragraphs/001-start/001-opening.md", remoteHeadSha: "source-head" }) }),
      ]),
    }));
    expect(message.mutation?.changedPaths).toEqual(["evaluation-guidelines.md", "evaluations/paragraphs/001-start/001-opening.md"]);
  });

  it("does not persist any multi-paragraph evaluation when later generation fails", async () => {
    mocks.completeTextRouted.mockResolvedValueOnce("First evaluation").mockRejectedValueOnce(new Error("second failed"));
    mocks.completeToolRouted.mockResolvedValue({ output: {}, metadata: {} });
    mocks.loadFileContent.mockImplementation(async (_token, _owner, _repo, path) => path.endsWith("chapter.md") ? "---\ntitle: Start\n---\n\nIntro" : `---\ntitle: Paragraph\n---\n\n${path}`);

    await expect(evaluateAllPrompt()).rejects.toThrow("second failed");
    expect(mocks.commitImmediateMutations).not.toHaveBeenCalled();
  });

  it("stages every paragraph and chapter evaluation in one repository mutation", async () => {
    mocks.completeTextRouted.mockResolvedValue("Evaluation");
    mocks.completeToolRouted.mockResolvedValue({ output: {}, metadata: {} });
    mocks.loadFileContent.mockImplementation(async (_token, _owner, _repo, path) => path.endsWith("chapter.md") ? "---\ntitle: Start\n---\n\nIntro" : `---\ntitle: Paragraph\n---\n\n${path}`);

    const message = await evaluateAllPrompt();
    expect(mocks.commitImmediateMutations).toHaveBeenCalledTimes(1);
    expect(mocks.commitImmediateMutations).toHaveBeenCalledWith(expect.objectContaining({
      snapshots: expect.arrayContaining([
        expect.objectContaining({ snapshot: expect.objectContaining({ path: "evaluations/paragraphs/001-start/001-opening.md", remoteHeadSha: "source-head" }) }),
        expect.objectContaining({ snapshot: expect.objectContaining({ path: "evaluations/paragraphs/001-start/002-middle.md", remoteHeadSha: "source-head" }) }),
        expect.objectContaining({ snapshot: expect.objectContaining({ path: "evaluations/chapters/001-start.md", remoteHeadSha: "source-head" }) }),
        expect.objectContaining({ snapshot: expect.objectContaining({ path: "evaluation-guidelines.md", remoteHeadSha: "source-head" }) }),
      ]),
    }));
    expect(message.mutation?.changedPaths).toHaveLength(4);
  });

  it("does not persist any multi-paragraph evaluation when cancellation interrupts staging", async () => {
    const controller = new AbortController();
    mocks.completeTextRouted.mockImplementation(async () => {
      if (mocks.completeTextRouted.mock.calls.length === 2) {
        controller.abort();
        throw new DOMException("Aborted", "AbortError");
      }
      return "First evaluation";
    });
    mocks.completeToolRouted.mockResolvedValue({ output: {}, metadata: {} });
    mocks.loadFileContent.mockImplementation(async (_token, _owner, _repo, path) => path.endsWith("chapter.md") ? "---\ntitle: Start\n---\n\nIntro" : `---\ntitle: Paragraph\n---\n\n${path}`);

    await expect(evaluateAllPrompt(controller.signal)).rejects.toMatchObject({ name: "AbortError" });
    expect(mocks.commitImmediateMutations).not.toHaveBeenCalled();
  });
});
