import { beforeEach, expect, test, vi } from "vitest";
import { runReaderEvaluations } from "@/narrarium/readerEvaluations";
import { emptyReaderPersona } from "@/narrarium/readerPersona";

const router = vi.hoisted(() => ({ completeToolRouted: vi.fn() }));
const github = vi.hoisted(() => ({
  createFile: vi.fn(),
  deleteFile: vi.fn(),
  loadFileContent: vi.fn(),
  readFileWithSha: vi.fn(),
  updateFile: vi.fn(),
}));

vi.mock("@/assistant/router", () => ({ completeToolRouted: router.completeToolRouted }));
vi.mock("@/github/githubClient", () => github);

const currentGood = "evaluations/readers/chapters/001-start/good.md";
const currentBad = "evaluations/readers/chapters/001-start/bad.md";
const legacyGood = "evaluations/readers/chapters/001-start/good/old.md";

beforeEach(() => {
  vi.clearAllMocks();
  github.createFile.mockResolvedValue(undefined);
  github.deleteFile.mockResolvedValue(undefined);
  github.updateFile.mockResolvedValue(undefined);
  github.readFileWithSha.mockImplementation(async (_token, _owner, _repo, _branch, path) =>
    path === legacyGood ? { sha: "legacy-sha", content: "legacy" } : null);
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
    settings: { ui: { language: "en" } } as any,
    target: { type: "chapter", bookId: "book", chapterId: "001-start", title: "Start", text: "Text", sourcePath: "chapters/001-start/chapter.md", sourceVersion: "sha" },
    readers: [reader("good"), reader("bad")],
    depth: "brief",
    concurrency: 2,
  });

  expect(result.completed).toHaveLength(1);
  expect(result.failed).toHaveLength(1);
  expect(result.changedPaths).toEqual([currentBad, currentGood, legacyGood]);
  expect(github.createFile.mock.calls.map((call) => call[4])).toEqual(expect.arrayContaining([currentGood, currentBad]));
  expect(github.deleteFile).toHaveBeenCalledWith("token", "owner", "repo", "main", legacyGood, "legacy-sha", expect.any(String));
});
