import { beforeEach, describe, expect, test, vi } from "vitest";
import { draftImportChangedPaths, mutationMessage } from "@/assistant/service";
import { refreshBookAfterMutation, runPromptWithMutationRefresh } from "@/assistant/mutationRefresh";
import { useBooksStore } from "@/store/booksStore";
import { chapterCreationPaths } from "@/narrarium/canon";
import { chapterDraftArtifactPaths } from "@/narrarium/workspace";

const repository = vi.hoisted(() => ({ getExistingLocalBookStructure: vi.fn() }));
const github = vi.hoisted(() => ({
  loadBookStructure: vi.fn(),
  createFile: vi.fn(),
  createFileIfAbsent: vi.fn(),
  createOrUpdateTextFile: vi.fn(),
}));

vi.mock("@/repository/repositoryService", () => repository);
vi.mock("@/github/githubClient", async (importOriginal) => ({
  ...await importOriginal<typeof import("@/github/githubClient")>(),
  loadBookStructure: github.loadBookStructure,
  createFile: github.createFile,
  createFileIfAbsent: github.createFileIfAbsent,
  createOrUpdateTextFile: github.createOrUpdateTextFile,
}));

const book = { id: "book", owner: "owner", repo: "repo" } as any;
const structure = (title: string) => ({ title, loadedBranch: "main", chapters: [] }) as any;

beforeEach(() => {
  repository.getExistingLocalBookStructure.mockReset();
  github.loadBookStructure.mockReset();
  github.createFile.mockReset().mockResolvedValue(undefined);
  github.createFileIfAbsent.mockReset().mockResolvedValue(undefined);
  github.createOrUpdateTextFile.mockReset().mockResolvedValue(undefined);
  useBooksStore.setState({ structures: {}, structureGenerations: {}, workingBranches: { book: "main" } });
});

test.each([
  ["create", ["chapters/002-next/chapter.md"]],
  ["update", ["chapters/001-start/001-opening.md"]],
  ["delete", ["characters/old.md"]],
  ["evaluation", ["evaluations/chapters/001-start.md"]],
  ["note", ["notes.md"]],
  ["reader", ["evaluations/readers/chapters/001-start/reader.md"]],
  ["plot", ["plot.md"]],
])("refreshes structure and context for successful %s mutations", async (_kind, paths) => {
  const refresh = vi.fn().mockResolvedValue(undefined);
  const result = await runPromptWithMutationRefresh(() => Promise.resolve(mutationMessage("changed", paths)), refresh);
  expect(result.mutation).toEqual({
    changedPaths: paths,
    refresh: "book-structure-and-context",
  });
  expect(refresh).toHaveBeenCalledOnce();
});

test("chapter creation reports its chapter, resume, and evaluation files", () => {
  expect(chapterCreationPaths("002-next")).toEqual([
    "chapters/002-next/chapter.md",
    "resumes/chapters/002-next.md",
    "evaluations/chapters/002-next.md",
  ]);
});

test("chapter draft creation reports chapter, notes, ideas, and promoted files", () => {
  const changedPaths = chapterDraftArtifactPaths("002-next");
  expect(changedPaths).toEqual([
    "drafts/002-next/chapter.md",
    "drafts/002-next/notes.md",
    "drafts/002-next/ideas.md",
    "drafts/002-next/promoted.md",
  ]);
  expect(draftImportChangedPaths({ changedPaths })).toEqual(changedPaths);
});

test("refreshes after a handler writes and then fails", async () => {
  const refresh = vi.fn().mockResolvedValue(undefined);
  await expect(runPromptWithMutationRefresh(async () => {
    await github.createFile("token", "owner", "repo", "main", "plot.md", "changed", "Update plot");
    throw new Error("later evaluation failed");
  }, refresh)).rejects.toThrow("later evaluation failed");
  expect(refresh).toHaveBeenCalledOnce();
});

test("does not release a prompt until refreshed context is available to the next prompt", async () => {
  let finishRefresh!: () => void;
  let context = "stale";
  const refresh = () => new Promise<void>((resolve) => {
    finishRefresh = () => { context = "fresh"; resolve(); };
  });
  let completed = false;
  const first = runPromptWithMutationRefresh(() => Promise.resolve(mutationMessage("created", ["plot.md"])), refresh)
    .then(() => { completed = true; });
  await Promise.resolve();
  expect(completed).toBe(false);

  finishRefresh();
  await first;
  expect(context).toBe("fresh");
});

describe("authoritative mutation refresh", () => {
  test("rebuilds from the current local repository without dropping branch provenance", async () => {
    repository.getExistingLocalBookStructure.mockResolvedValue({ structure: structure("fresh") });

    await refreshBookAfterMutation({ book, token: "token", branch: "main" });

    expect(useBooksStore.getState().structures.book.title).toBe("fresh");
    expect(useBooksStore.getState().workingBranches.book).toBe("main");
    expect(github.loadBookStructure).not.toHaveBeenCalled();
  });

  test("does not let an older refresh overwrite a newer mutation result", async () => {
    let resolveOlder!: (value: unknown) => void;
    const older = new Promise((resolve) => { resolveOlder = resolve; });
    repository.getExistingLocalBookStructure
      .mockReturnValueOnce(older)
      .mockResolvedValueOnce({ structure: structure("newer") });

    const first = refreshBookAfterMutation({ book, token: "token", branch: "main" });
    await refreshBookAfterMutation({ book, token: "token", branch: "main" });
    resolveOlder({ structure: structure("older") });
    await first;

    expect(useBooksStore.getState().structures.book.title).toBe("newer");
  });
});
