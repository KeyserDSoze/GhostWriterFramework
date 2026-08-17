import "fake-indexeddb/auto";
import { captureRepositoryOperationScope } from "@/repository/repositoryOperationScope";
import { afterEach, expect, test, vi } from "vitest";

const repository = vi.hoisted(() => ({ pushLocalCommits: vi.fn() }));
const git = vi.hoisted(() => ({ getRef: vi.fn(), getCommit: vi.fn(), getTree: vi.fn(), getBlob: vi.fn() }));
vi.mock("@octokit/rest", () => ({ Octokit: class { rest = { git }; } }));
vi.mock("@/repository/repositoryService", async (importOriginal) => ({
  ...await importOriginal<typeof import("@/repository/repositoryService")>(),
  pushLocalCommits: repository.pushLocalCommits,
}));

import { getLocalFile, listUnpushedLocalCommits, putCleanLocalFile, putLocalRepository, removeLocalRepository } from "@/repository/localRepository";
import { AmbiguousLocalPushError } from "@/repository/repositoryService";
import { commitAndPushTextFileMutation, RepositoryConflictError } from "@/repository/safeRepositoryMutation";
import { useAuthStore } from "@/store/authStore";

useAuthStore.setState({ user: { provider: "google", providerAccountId: "sub-writer", name: "Writer", email: "writer@example.com", picture: "" } });

let repoId = "";
afterEach(async () => {
  vi.clearAllMocks();
  if (repoId) await removeLocalRepository(repoId, captureRepositoryOperationScope());
  repoId = "";
});

async function setup() {
  const repo = await putLocalRepository({ bookId: "book", owner: "owner", repo: "repo", branch: "main", defaultBranch: "main", remoteHeadSha: "source", clonedAt: new Date().toISOString(), cloneComplete: true }, captureRepositoryOperationScope());
  repoId = repo.id;
  const file = await putCleanLocalFile({ repoId, path: "plot.md", kind: "text", text: "old", baseSha: "old-blob", size: 3 });
  repository.pushLocalCommits.mockRejectedValue(new AmbiguousLocalPushError("ambiguous", "generated", new Error("network")));
  git.getRef.mockResolvedValue({ data: { object: { sha: "descendant" } } });
  git.getCommit.mockResolvedValue({ data: { parents: [{ sha: "generated" }] } });
  git.getTree.mockResolvedValue({ data: { truncated: false, tree: [{ path: "plot.md", type: "blob", sha: "new-blob" }] } });
  git.getBlob.mockResolvedValue({ data: { encoding: "base64", content: btoa("new") } });
  return file;
}

test("local push recovery accepts a descendant only with generated ancestry and exact revisions", async () => {
  const file = await setup();
  await expect(commitAndPushTextFileMutation({ token: "token", book: { id: "book", owner: "owner", repo: "repo" } as any, branch: "main", expectedRemoteHeadSha: "source", message: "Update", mutations: [{ path: "plot.md", content: "new", expectedCurrentHash: file.currentHash }] })).resolves.toEqual({ commitSha: "descendant", mode: "local" });
  expect(await listUnpushedLocalCommits(repoId)).toEqual([]);
  expect(await getLocalFile(repoId, "plot.md", captureRepositoryOperationScope())).toMatchObject({ text: "new", status: "clean" });
});

test("local push recovery rejects matching content without generated ancestry and restores local state", async () => {
  const file = await setup();
  git.getCommit.mockResolvedValue({ data: { parents: [{ sha: "source" }] } });
  await expect(commitAndPushTextFileMutation({ token: "token", book: { id: "book", owner: "owner", repo: "repo" } as any, branch: "main", expectedRemoteHeadSha: "source", message: "Update", mutations: [{ path: "plot.md", content: "new", expectedCurrentHash: file.currentHash }] })).rejects.toBeInstanceOf(RepositoryConflictError);
  expect(await listUnpushedLocalCommits(repoId)).toEqual([]);
  expect(await getLocalFile(repoId, "plot.md", captureRepositoryOperationScope())).toMatchObject({ text: "old", status: "clean" });
  expect(git.getTree).not.toHaveBeenCalled();
});
