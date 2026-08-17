import { beforeEach, expect, test, vi } from "vitest";

const local = vi.hoisted(() => ({
  getLocalRepository: vi.fn(),
  getLocalFile: vi.fn(),
  mutateLocalTextFilesAndCreateCommitAtomically: vi.fn(),
  restoreLocalFilesAndDeleteCommit: vi.fn(),
}));
const repository = vi.hoisted(() => ({ pushLocalCommits: vi.fn() }));

vi.mock("@octokit/rest", () => ({ Octokit: class {} }));
vi.mock("@/repository/localRepository", async (importOriginal) => ({
  ...await importOriginal<typeof import("@/repository/localRepository")>(),
  ...local,
}));
vi.mock("@/repository/repositoryService", async (importOriginal) => ({
  ...await importOriginal<typeof import("@/repository/repositoryService")>(),
  pushLocalCommits: repository.pushLocalCommits,
}));

import { commitAndPushTextFileMutation } from "@/repository/safeRepositoryMutation";
import { useAuthStore } from "@/store/authStore";

beforeEach(() => {
  useAuthStore.setState({ user: { provider: "google", providerAccountId: "sub-writer", name: "Writer", email: "writer@example.com", picture: "" } });
  vi.clearAllMocks();
  local.getLocalRepository.mockResolvedValue({ id: "repo-id", remoteHeadSha: "source-head" });
  local.getLocalFile.mockResolvedValue({ path: "plot.md", text: "old" });
  local.restoreLocalFilesAndDeleteCommit.mockResolvedValue(undefined);
});

test("an abort after the local commit rolls it back before remote push starts", async () => {
  const controller = new AbortController();
  local.mutateLocalTextFilesAndCreateCommitAtomically.mockImplementation(async () => {
    controller.abort(new DOMException("cancelled", "AbortError"));
    return { id: "local-commit" };
  });

  await expect(commitAndPushTextFileMutation({
    token: "token",
    book: { id: "book", owner: "owner", repo: "repo" } as any,
    branch: "main",
    expectedRemoteHeadSha: "source-head",
    message: "Update plot",
    mutations: [{ path: "plot.md", content: "new" }],
    signal: controller.signal,
  })).rejects.toMatchObject({ name: "AbortError", message: "cancelled" });

  expect(repository.pushLocalCommits).not.toHaveBeenCalled();
  expect(local.restoreLocalFilesAndDeleteCommit).toHaveBeenCalledWith(
    "repo-id",
    { accountIdentity: "google:sub-writer", accountGeneration: 0 },
    "local-commit",
    [{ path: "plot.md", file: { path: "plot.md", text: "old" } }],
  );
});
