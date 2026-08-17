import { beforeEach, expect, test, vi } from "vitest";

const octokit = vi.hoisted(() => ({
  getRef: vi.fn(),
  getCommit: vi.fn(),
  getTree: vi.fn(),
  getBlob: vi.fn(),
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
import { useAuthStore } from "@/store/authStore";

beforeEach(() => {
  useAuthStore.setState({ user: { provider: "google", providerAccountId: "sub-writer", name: "Writer", email: "writer@example.com", picture: "" } });
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

test("an ambiguous updateRef error is success only when the generated head and every revision landed", async () => {
  vi.clearAllMocks();
  Object.values(octokit).forEach((mock) => mock.mockReset());
  octokit.getRef
    .mockResolvedValueOnce({ data: { object: { sha: "source-head" } } })
    .mockResolvedValueOnce({ data: { object: { sha: "generated-commit" } } });
  octokit.getCommit.mockResolvedValue({ data: { tree: { sha: "tree" }, parents: [] } });
  octokit.getTree.mockResolvedValue({ data: { truncated: false, tree: [{ path: "plot.md", type: "blob", sha: "blob" }] } });
  octokit.getBlob.mockResolvedValue({ data: { encoding: "base64", content: btoa("generated") } });
  octokit.createTree.mockResolvedValue({ data: { sha: "new-tree" } });
  octokit.createCommit.mockResolvedValue({ data: { sha: "generated-commit" } });
  octokit.updateRef.mockRejectedValue(new DOMException("request cancelled", "AbortError"));

  await expect(commitAndPushTextFileMutation({
    token: "token",
    book: { id: "book", owner: "owner", repo: "repo" } as any,
    branch: "main",
    expectedRemoteHeadSha: "source-head",
    message: "Update",
    mutations: [{ path: "plot.md", content: "generated" }],
  })).resolves.toEqual({ commitSha: "generated-commit", mode: "remote" });
});

test("an ambiguous generated head with mismatched revisions fails closed", async () => {
  vi.clearAllMocks();
  Object.values(octokit).forEach((mock) => mock.mockReset());
  octokit.getRef
    .mockResolvedValueOnce({ data: { object: { sha: "source-head" } } })
    .mockResolvedValueOnce({ data: { object: { sha: "generated-commit" } } });
  octokit.getCommit.mockResolvedValue({ data: { tree: { sha: "tree" }, parents: [] } });
  octokit.getTree.mockResolvedValue({ data: { truncated: false, tree: [{ path: "plot.md", type: "blob", sha: "blob" }] } });
  octokit.getBlob.mockResolvedValue({ data: { encoding: "base64", content: btoa("different") } });
  octokit.createTree.mockResolvedValue({ data: { sha: "new-tree" } });
  octokit.createCommit.mockResolvedValue({ data: { sha: "generated-commit" } });
  octokit.updateRef.mockRejectedValue(new Error("network outcome unknown"));

  await expect(commitAndPushTextFileMutation({
    token: "token",
    book: { id: "book", owner: "owner", repo: "repo" } as any,
    branch: "main",
    expectedRemoteHeadSha: "source-head",
    message: "Update",
    mutations: [{ path: "plot.md", content: "generated" }],
  })).rejects.toBeInstanceOf(RepositoryConflictError);
});

test("a descendant head is accepted only with generated-commit ancestry and exact parity", async () => {
  vi.clearAllMocks();
  Object.values(octokit).forEach((mock) => mock.mockReset());
  octokit.getRef.mockResolvedValueOnce({ data: { object: { sha: "source-head" } } }).mockResolvedValueOnce({ data: { object: { sha: "descendant" } } });
  octokit.getCommit.mockImplementation(async ({ commit_sha }: { commit_sha: string }) => commit_sha === "source-head"
    ? { data: { tree: { sha: "tree" }, parents: [] } }
    : { data: { tree: { sha: "descendant-tree" }, parents: [{ sha: "generated-commit" }] } });
  octokit.createTree.mockResolvedValue({ data: { sha: "new-tree" } });
  octokit.createCommit.mockResolvedValue({ data: { sha: "generated-commit" } });
  octokit.updateRef.mockRejectedValue(new Error("network outcome unknown"));
  octokit.getTree.mockResolvedValue({ data: { truncated: false, tree: [{ path: "plot.md", type: "blob", sha: "blob" }] } });
  octokit.getBlob.mockResolvedValue({ data: { encoding: "base64", content: btoa("generated") } });

  await expect(commitAndPushTextFileMutation({ token: "token", book: { id: "book", owner: "owner", repo: "repo" } as any, branch: "main", expectedRemoteHeadSha: "source-head", message: "Update", mutations: [{ path: "plot.md", content: "generated" }] })).resolves.toEqual({ commitSha: "descendant", mode: "remote" });
});

test("matching latest content without generated-commit ancestry is not proof of landing", async () => {
  vi.clearAllMocks();
  Object.values(octokit).forEach((mock) => mock.mockReset());
  octokit.getRef.mockResolvedValueOnce({ data: { object: { sha: "source-head" } } }).mockResolvedValueOnce({ data: { object: { sha: "unrelated" } } });
  octokit.getCommit.mockImplementation(async ({ commit_sha }: { commit_sha: string }) => commit_sha === "source-head"
    ? { data: { tree: { sha: "tree" }, parents: [] } }
    : { data: { tree: { sha: "other-tree" }, parents: [{ sha: "source-head" }] } });
  octokit.createTree.mockResolvedValue({ data: { sha: "new-tree" } });
  octokit.createCommit.mockResolvedValue({ data: { sha: "generated-commit" } });
  octokit.updateRef.mockRejectedValue(new Error("network outcome unknown"));
  octokit.getTree.mockResolvedValue({ data: { truncated: false, tree: [{ path: "plot.md", type: "blob", sha: "blob" }] } });
  octokit.getBlob.mockResolvedValue({ data: { encoding: "base64", content: btoa("generated") } });

  await expect(commitAndPushTextFileMutation({ token: "token", book: { id: "book", owner: "owner", repo: "repo" } as any, branch: "main", expectedRemoteHeadSha: "source-head", message: "Update", mutations: [{ path: "plot.md", content: "generated" }] })).rejects.toBeInstanceOf(RepositoryConflictError);
  expect(octokit.getTree).not.toHaveBeenCalled();
});
