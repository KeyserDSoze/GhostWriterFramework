import { beforeEach, expect, test, vi } from "vitest";
import { generateReaderEvaluationSummary, runReaderEvaluations } from "@/narrarium/readerEvaluations";
import { emptyReaderPersona } from "@/narrarium/readerPersona";

const router = vi.hoisted(() => ({ completeToolRouted: vi.fn() }));
const github = vi.hoisted(() => ({
  createFile: vi.fn(),
  deleteFile: vi.fn(),
  loadFileContent: vi.fn(),
  readFileWithSha: vi.fn(),
  updateFile: vi.fn(),
}));
const safeMutation = vi.hoisted(() => ({
  commitAndPushTextFileMutation: vi.fn(),
  resolveRepositoryHeadForMutation: vi.fn(),
  RepositoryConflictError: class RepositoryConflictError extends Error {
    readonly code = "REPOSITORY_CONFLICT";
    constructor(message: string, readonly path?: string) { super(message); }
  },
}));
const immediateMutation = vi.hoisted(() => ({
  captureImmediateMutation: vi.fn(),
  commitImmediateMutation: vi.fn(),
  mergeManagedFrontmatter: (existing: Record<string, unknown>, managed: Record<string, unknown>, keys: string[]) => ({
    ...Object.fromEntries(Object.entries(existing).filter(([key]) => !keys.includes(key))),
    ...managed,
  }),
}));

vi.mock("@/assistant/router", () => ({ completeToolRouted: router.completeToolRouted }));
vi.mock("@/github/githubClient", () => github);
vi.mock("@/repository/safeRepositoryMutation", () => safeMutation);
vi.mock("@/assistant/immediateMutation", () => immediateMutation);

const currentGood = "evaluations/readers/chapters/001-start/good.md";
const currentBad = "evaluations/readers/chapters/001-start/bad.md";
const legacyGood = "evaluations/readers/chapters/001-start/good/old.md";

beforeEach(() => {
  vi.clearAllMocks();
  github.createFile.mockResolvedValue(undefined);
  github.deleteFile.mockResolvedValue(undefined);
  github.updateFile.mockResolvedValue(undefined);
  github.readFileWithSha.mockImplementation(async (_token, _owner, _repo, _branch, path) =>
    path === "chapters/001-start/chapter.md" ? { sha: "sha", content: "Text" }
      : path === legacyGood ? { sha: "legacy-sha", content: "legacy" } : null);
  safeMutation.resolveRepositoryHeadForMutation.mockResolvedValue("head");
  safeMutation.commitAndPushTextFileMutation.mockResolvedValue({ commitSha: "next", mode: "remote" });
  immediateMutation.captureImmediateMutation.mockImplementation(async ({ path, remoteHeadSha }) => {
    const current = await github.readFileWithSha("token", "owner", "repo", "main", path);
    return { path, content: current?.content ?? null, sha: current?.sha ?? null, hash: current ? `hash:${current.content}` : null, remoteHeadSha: remoteHeadSha ?? "head" };
  });
  router.completeToolRouted.mockImplementation(async (_settings, _messages, _task, _tool, options) => {
    if (String(options.label).endsWith(":bad")) throw new Error("model failed");
    return {
      output: {
        generalImpression: "Clear",
        strengths: ["Voice"],
        weaknesses: ["Pacing"],
        mostEffectiveMoment: "Opening",
        mainProblem: "Middle",
        prioritySuggestion: "Trim",
        score: 7,
      },
      metadata: {},
    };
  });
});

test("rejects a stale reader target before model generation", async () => {
  github.readFileWithSha.mockResolvedValue({ sha: "new-sha", content: "Changed" });
  const reader = { ...emptyReaderPersona("en"), id: "good", slug: "good", name: "good" };
  await expect(runReaderEvaluations({
    token: "token", book: { id: "book", owner: "owner", repo: "repo" } as any, branch: "main",
    structure: { language: "en", readerEvaluationFiles: [], characters: [], locations: [], items: [], factions: [] } as any,
    settings: { ui: { language: "en" } } as any, accountScope: null,
    target: { type: "paragraph", bookId: "book", chapterId: "001-start", paragraphId: "001-opening", title: "Opening", text: "Old", sourcePath: "chapters/001-start/001-opening.md", sourceVersion: "old-sha" },
    readers: [reader], depth: "brief",
  })).rejects.toMatchObject({ code: "REPOSITORY_CONFLICT" });
  expect(router.completeToolRouted).not.toHaveBeenCalled();
  expect(safeMutation.commitAndPushTextFileMutation).not.toHaveBeenCalled();
});

test("rejects a late source conflict after reader models finish", async () => {
  github.readFileWithSha
    .mockResolvedValueOnce({ sha: "sha", content: "Text" })
    .mockImplementation(async (_token, _owner, _repo, _branch, path) => path.includes("evaluations/") ? null : { sha: "changed-sha", content: "Changed" });
  const reader = { ...emptyReaderPersona("en"), id: "good", slug: "good", name: "good" };
  await expect(runReaderEvaluations({
    token: "token", book: { id: "book", owner: "owner", repo: "repo" } as any, branch: "main",
    structure: { language: "en", readerEvaluationFiles: [], characters: [], locations: [], items: [], factions: [] } as any,
    settings: { ui: { language: "en" } } as any, accountScope: null,
    target: { type: "chapter", bookId: "book", chapterId: "001-start", title: "Start", text: "Text", sourcePath: "chapters/001-start/chapter.md", sourceVersion: "sha" },
    readers: [reader], depth: "brief",
  })).rejects.toMatchObject({ code: "REPOSITORY_CONFLICT" });
  expect(router.completeToolRouted).toHaveBeenCalledOnce();
  expect(safeMutation.commitAndPushTextFileMutation).not.toHaveBeenCalled();
});

test("propagates account-scope cancellation without persisting a failed evaluation", async () => {
  router.completeToolRouted.mockRejectedValueOnce(new DOMException("The authenticated account changed.", "AbortError"));
  const reader = { ...emptyReaderPersona("en"), id: "good", slug: "good", name: "good" };

  await expect(runReaderEvaluations({
    token: "token", book: { id: "book", owner: "owner", repo: "repo" } as any, branch: "main",
    structure: { language: "en", readerEvaluationFiles: [], characters: [], locations: [], items: [], factions: [] } as any,
    settings: { ui: { language: "en" } } as any, accountScope: "google:first@example.com",
    target: { type: "chapter", bookId: "book", chapterId: "001-start", title: "Start", text: "Text", sourcePath: "chapters/001-start/chapter.md", sourceVersion: "sha" },
    readers: [reader], depth: "brief",
  })).rejects.toMatchObject({ name: "AbortError" });

  expect(safeMutation.commitAndPushTextFileMutation).not.toHaveBeenCalled();
  expect(immediateMutation.commitImmediateMutation).not.toHaveBeenCalled();
});

test("validates summary targets before generation and again before write", async () => {
  github.readFileWithSha
    .mockResolvedValueOnce({ sha: "sha", content: "Text" })
    .mockResolvedValueOnce({ sha: "changed-sha", content: "Changed" });
  router.completeToolRouted.mockResolvedValue({ output: { overallScore: 7 }, metadata: {} });
  immediateMutation.captureImmediateMutation.mockResolvedValue({ path: "summary.md", content: null, sha: null, hash: null, remoteHeadSha: "head" });
  await expect(generateReaderEvaluationSummary({
    token: "token", book: { id: "book", owner: "owner", repo: "repo" } as any, branch: "main",
    settings: { ui: { language: "en" } } as any, accountScope: null,
    target: { type: "paragraph", bookId: "book", chapterId: "001-start", paragraphId: "001-opening", title: "Opening", text: "Text", sourcePath: "chapters/001-start/001-opening.md", sourceVersion: "sha" },
    evaluations: [{ path: "one.md", id: "one", targetType: "paragraph", targetId: "target", readerId: "one", readerName: "One", readerType: "standard", createdAt: "now", sourceContentHash: "hash", sourceContentVersion: "sha", status: "completed", body: "Body" }],
  })).rejects.toMatchObject({ code: "REPOSITORY_CONFLICT" });
  expect(router.completeToolRouted).toHaveBeenCalledOnce();
  expect(immediateMutation.commitImmediateMutation).not.toHaveBeenCalled();
});

test("reader evaluation mutation result includes completed, failed-record, and legacy deletion paths", async () => {
  const reader = (slug: string) => ({ ...emptyReaderPersona("en"), id: slug, slug, name: slug });
  const result = await runReaderEvaluations({
    token: "token",
    book: { id: "book", owner: "owner", repo: "repo" } as any,
    branch: "main",
    structure: {
      language: "en",
      readerEvaluationFiles: [{ path: legacyGood }],
      characters: [], locations: [], items: [], factions: [],
    } as any,
    settings: { ui: { language: "en" } } as any, accountScope: null,
    target: { type: "chapter", bookId: "book", chapterId: "001-start", title: "Start", text: "Text", sourcePath: "chapters/001-start/chapter.md", sourceVersion: "sha" },
    readers: [reader("good"), reader("bad")],
    depth: "brief",
    concurrency: 2,
  });

  expect(result.completed).toHaveLength(1);
  expect(result.failed).toHaveLength(1);
  expect(result.changedPaths).toEqual([currentBad, currentGood, legacyGood]);
  expect(safeMutation.commitAndPushTextFileMutation).toHaveBeenCalledWith(expect.objectContaining({
    expectedRemoteHeadSha: "head",
    mutations: expect.arrayContaining([
      expect.objectContaining({ path: currentGood }),
      expect.objectContaining({ path: currentBad }),
      { path: legacyGood, content: null, expectedCurrentHash: "hash:legacy" },
    ]),
  }));
});
