import { expect, test, vi } from "vitest";
import { confirmPullRequestProposal } from "@/assistant/pullRequestProposal";

test("reconciles an ambiguous PR create to an exact existing pull request", async () => {
  const pull = { number: 7, title: "Proposal", body: "Body", state: "open", htmlUrl: "https://example/pr/7", head: "draft", base: "main" };
  const dependencies = {
    getDefaultBranch: vi.fn().mockResolvedValue("main"),
    listBranches: vi.fn().mockResolvedValue([{ name: "main", protected: true }, { name: "draft", protected: false }]),
    listBranchCommits: vi.fn().mockImplementation(async (_token, _owner, _repo, branch) => [{ sha: branch === "main" ? "base" : "head" }]),
    compareBranches: vi.fn().mockResolvedValue([{ filename: "book.md", status: "modified", additions: 1, deletions: 0, changes: 1 }]),
    listOpenPullRequests: vi.fn().mockResolvedValueOnce([]).mockResolvedValueOnce([pull]),
    createPullRequest: vi.fn().mockRejectedValue(new TypeError("network response lost")),
  };
  const action = { kind: "confirm-create-pull-request" as const, bookId: "book", base: "main", head: "draft", title: "Proposal", body: "Body", baseRevision: "base", headRevision: "head", changedFiles: [{ filename: "book.md", status: "modified", additions: 1, deletions: 0 }], existingPullRequests: [], owner: "owner", repo: "repo" };
  await expect(confirmPullRequestProposal({ token: "token", action }, dependencies)).resolves.toEqual(pull);
  expect(dependencies.listOpenPullRequests).toHaveBeenCalledTimes(2);
});

test("does not reconcile a different PR", async () => {
  const dependencies = {
    getDefaultBranch: vi.fn().mockResolvedValue("main"),
    listBranches: vi.fn().mockResolvedValue([{ name: "main", protected: true }, { name: "draft", protected: false }]),
    listBranchCommits: vi.fn().mockImplementation(async (_token, _owner, _repo, branch) => [{ sha: branch === "main" ? "base" : "head" }]),
    compareBranches: vi.fn().mockResolvedValue([{ filename: "book.md", status: "modified", additions: 1, deletions: 0, changes: 1 }]),
    listOpenPullRequests: vi.fn().mockResolvedValueOnce([]).mockResolvedValueOnce([{ number: 8, title: "Other", body: "Body", state: "open", htmlUrl: "https://example/pr/8", head: "draft", base: "main" }]),
    createPullRequest: vi.fn().mockRejectedValue(new TypeError("network response lost")),
  };
  const action = { kind: "confirm-create-pull-request" as const, bookId: "book", base: "main", head: "draft", title: "Proposal", body: "Body", baseRevision: "base", headRevision: "head", changedFiles: [{ filename: "book.md", status: "modified", additions: 1, deletions: 0 }], existingPullRequests: [], owner: "owner", repo: "repo" };
  await expect(confirmPullRequestProposal({ token: "token", action }, dependencies)).rejects.toThrow("network response lost");
});
