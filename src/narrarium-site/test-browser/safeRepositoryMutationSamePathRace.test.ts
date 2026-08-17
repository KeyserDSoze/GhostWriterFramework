import "fake-indexeddb/auto";
import { captureRepositoryOperationScope } from "@/repository/repositoryOperationScope";
import { afterEach, expect, test, vi } from "vitest";

const repository = vi.hoisted(() => ({ pushLocalCommits: vi.fn() }));
const octokit = vi.hoisted(() => ({ getRef: vi.fn() }));

vi.mock("@octokit/rest", () => ({ Octokit: class { rest = { git: octokit }; } }));
vi.mock("@/repository/repositoryService", async (importOriginal) => ({
  ...await importOriginal<typeof import("@/repository/repositoryService")>(),
  pushLocalCommits: repository.pushLocalCommits,
}));

import {
  getLocalFile,
  listDirtyLocalFiles,
  listUnpushedLocalCommits,
  putCleanLocalFile,
  putLocalRepository,
  removeLocalRepository,
  writeLocalText,
} from "@/repository/localRepository";
import { commitAndPushTextFileMutation } from "@/repository/safeRepositoryMutation";
import { useAuthStore } from "@/store/authStore";

useAuthStore.setState({ user: { provider: "google", providerAccountId: "sub-writer", name: "Writer", email: "writer@example.com", picture: "" } });

let repoId = "";

afterEach(async () => {
  vi.clearAllMocks();
  if (repoId) await removeLocalRepository(repoId, captureRepositoryOperationScope());
  repoId = "";
});

test("a newer same-path edit survives an abort after the mutation commit", async () => {
  const repo = await putLocalRepository({ bookId: "book", owner: "owner", repo: "repo", branch: "main", defaultBranch: "main", remoteHeadSha: "source-head", clonedAt: new Date().toISOString(), cloneComplete: true }, captureRepositoryOperationScope());
  repoId = repo.id;
  const original = await putCleanLocalFile({ repoId, path: "plot.md", kind: "text", text: "old", size: 3 });
  repository.pushLocalCommits.mockImplementation(async () => {
    await writeLocalText(repoId, "plot.md", "newer local edit");
    throw new DOMException("cancelled", "AbortError");
  });
  octokit.getRef.mockResolvedValue({ data: { object: { sha: "source-head" } } });

  await expect(commitAndPushTextFileMutation({
    token: "token",
    book: { id: "book", owner: "owner", repo: "repo" } as any,
    branch: "main",
    expectedRemoteHeadSha: "source-head",
    message: "Update plot",
    mutations: [{ path: "plot.md", content: "mutation result", expectedCurrentHash: original.currentHash }],
  })).rejects.toMatchObject({ name: "AbortError" });

  expect((await getLocalFile(repoId, "plot.md", captureRepositoryOperationScope()))?.text).toBe("newer local edit");
  expect((await listDirtyLocalFiles(repoId)).map((file) => file.path)).toEqual(["plot.md"]);
  expect(await listUnpushedLocalCommits(repoId)).toEqual([]);
});
