import { beforeEach, expect, test, vi } from "vitest";

const octokit = vi.hoisted(() => ({
  getRef: vi.fn(),
  getCommit: vi.fn(),
  getTree: vi.fn(),
  createBlob: vi.fn(),
  createTree: vi.fn(),
  createCommit: vi.fn(),
  updateRef: vi.fn(),
}));
const local = vi.hoisted(() => ({
  getLocalRepositoryById: vi.fn(),
  listDirtyLocalFiles: vi.fn(),
  listUnpushedLocalCommits: vi.fn(),
  listAllLocalFiles: vi.fn(),
  markLocalCommitsPushed: vi.fn(),
  addLocalRepoLog: vi.fn(),
}));

vi.mock("@octokit/rest", () => ({ Octokit: class { rest = { git: octokit }; } }));
vi.mock("@/repository/localRepository", async (importOriginal) => ({
  ...await importOriginal<typeof import("@/repository/localRepository")>(),
  ...local,
}));

import { pushLocalCommits } from "@/repository/repositoryService";
import { useAuthStore } from "@/store/authStore";

const identity = "google:sub-writer";

beforeEach(() => {
  vi.clearAllMocks();
  useAuthStore.setState({ user: { provider: "google", providerAccountId: "sub-writer", name: "Writer", email: "writer@example.com", picture: "" } });
  local.getLocalRepositoryById.mockResolvedValue({ id: "repo-id", bookId: "book", owner: "owner", repo: "repo", branch: "main", accountScope: identity });
  local.listDirtyLocalFiles.mockResolvedValue([]);
  local.listUnpushedLocalCommits.mockResolvedValue([{ id: "local-commit", message: "Update", files: [{ path: "plot.md", status: "modified", kind: "text", hash: "new-hash" }] }]);
  local.listAllLocalFiles.mockResolvedValue([{ path: "plot.md", kind: "text", text: "new", currentHash: "new-hash", status: "clean", committed: true }]);
  octokit.getRef.mockResolvedValue({ data: { object: { sha: "source-head" } } });
  octokit.getCommit.mockResolvedValue({ data: { tree: { sha: "source-tree" } } });
  octokit.getTree.mockResolvedValue({ data: { tree: [{ type: "blob", path: "plot.md" }] } });
  octokit.createBlob.mockResolvedValue({ data: { sha: "blob-sha" } });
});

test("an in-flight push forwards abort to GitHub and never updates the branch", async () => {
  const controller = new AbortController();
  octokit.createTree.mockImplementation((_input) => new Promise((_resolve, reject) => {
    _input.request.signal.addEventListener("abort", () => reject(_input.request.signal.reason), { once: true });
  }));

  const operation = pushLocalCommits({
    bookId: "book",
    token: "token",
    repoId: "repo-id",
    owner: "owner",
    repo: "repo",
    branch: "main",
    accountIdentity: identity,
    expectedRemoteHeadSha: "source-head",
    signal: controller.signal,
  });
  await vi.waitFor(() => expect(octokit.createTree).toHaveBeenCalledOnce());
  expect(octokit.createTree.mock.calls[0][0].request.signal).toBe(controller.signal);

  controller.abort(new DOMException("cancelled", "AbortError"));

  await expect(operation).rejects.toMatchObject({ name: "AbortError", message: "cancelled" });
  expect(octokit.createCommit).not.toHaveBeenCalled();
  expect(octokit.updateRef).not.toHaveBeenCalled();
  expect(local.markLocalCommitsPushed).not.toHaveBeenCalled();
});
