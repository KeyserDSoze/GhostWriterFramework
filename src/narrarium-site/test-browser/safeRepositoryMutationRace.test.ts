import { beforeEach, expect, test, vi } from "vitest";

const octokit = vi.hoisted(() => ({
  getRef: vi.fn(),
  getCommit: vi.fn(),
  createTree: vi.fn(),
  createCommit: vi.fn(),
  updateRef: vi.fn(),
}));

vi.mock("@octokit/rest", () => ({ Octokit: class { rest = { git: octokit }; } }));
vi.mock("@/repository/localRepository", async (importOriginal) => ({
  ...await importOriginal<typeof import("@/repository/localRepository")>(),
  getLocalRepository: vi.fn().mockResolvedValue(null),
}));

import { commitAndPushTextFileMutation, RepositoryConflictError } from "@/repository/safeRepositoryMutation";

beforeEach(() => {
  vi.clearAllMocks();
  octokit.getRef
    .mockResolvedValueOnce({ data: { object: { sha: "source-head" } } })
    .mockResolvedValueOnce({ data: { object: { sha: "concurrent-head" } } });
  octokit.getCommit.mockResolvedValue({ data: { tree: { sha: "tree" } } });
  octokit.createTree.mockResolvedValue({ data: { sha: "new-tree" } });
  octokit.createCommit.mockResolvedValue({ data: { sha: "generated-commit" } });
  octokit.updateRef.mockRejectedValue(new Error("Update is not a fast forward"));
});

test("converts an updateRef remote-head race into a repository conflict", async () => {
  await expect(commitAndPushTextFileMutation({
    token: "token",
    book: { id: "book", owner: "owner", repo: "repo" } as any,
    branch: "main",
    expectedRemoteHeadSha: "source-head",
    message: "Update",
    mutations: [{ path: "plot.md", content: "generated" }],
  })).rejects.toBeInstanceOf(RepositoryConflictError);
});

test("an interruption after remote preflight but before commit prevents the ref mutation", async () => {
  vi.clearAllMocks();
  const controller = new AbortController();
  let finishCommitRead!: (value: { data: { tree: { sha: string } } }) => void;
  octokit.getRef.mockResolvedValue({ data: { object: { sha: "source-head" } } });
  octokit.getCommit.mockImplementation(() => new Promise((resolve) => { finishCommitRead = resolve; }));

  const operation = commitAndPushTextFileMutation({
    token: "token",
    book: { id: "book", owner: "owner", repo: "repo" } as any,
    branch: "main",
    expectedRemoteHeadSha: "source-head",
    message: "Update",
    mutations: [{ path: "plot.md", content: "generated" }],
    signal: controller.signal,
  });
  await vi.waitFor(() => expect(finishCommitRead).toBeTypeOf("function"));
  controller.abort();
  finishCommitRead({ data: { tree: { sha: "tree" } } });

  await expect(operation).rejects.toMatchObject({ name: "AbortError" });
  expect(octokit.createTree).not.toHaveBeenCalled();
  expect(octokit.createCommit).not.toHaveBeenCalled();
  expect(octokit.updateRef).not.toHaveBeenCalled();
});
