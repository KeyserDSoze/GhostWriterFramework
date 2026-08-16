import "fake-indexeddb/auto";
import { afterEach, expect, test, vi } from "vitest";

const octokit = vi.hoisted(() => ({
  getRef: vi.fn(),
  getCommit: vi.fn(),
  getTree: vi.fn(),
  createBlob: vi.fn(),
  createTree: vi.fn(),
  createCommit: vi.fn(),
  updateRef: vi.fn(),
}));

vi.mock("@octokit/rest", () => ({ Octokit: class { rest = { git: octokit }; } }));

import {
  getLocalFile,
  listDirtyLocalFiles,
  listUnpushedLocalCommits,
  mutateLocalTextFilesAndCreateCommitAtomically,
  putCleanLocalFile,
  putLocalRepository,
  removeLocalRepository,
  writeLocalText,
} from "@/repository/localRepository";
import { pushLocalCommits } from "@/repository/repositoryService";

let repoId = "";

afterEach(async () => {
  vi.clearAllMocks();
  vi.restoreAllMocks();
  if (repoId) await removeLocalRepository(repoId);
  repoId = "";
});

test("a newer same-path edit remains dirty when it lands before successful push settlement", async () => {
  const repo = await putLocalRepository({ bookId: "book", owner: "owner", repo: "repo", branch: "main", defaultBranch: "main", remoteHeadSha: "source-head", clonedAt: new Date().toISOString(), cloneComplete: true });
  repoId = repo.id;
  const original = await putCleanLocalFile({ repoId, path: "plot.md", kind: "text", text: "old", baseSha: "old-blob", size: 3 });
  const commit = await mutateLocalTextFilesAndCreateCommitAtomically(repoId, "Update plot", [
    { path: "plot.md", content: "pushed mutation", expectedCurrentHash: original.currentHash },
  ]);
  octokit.getRef.mockResolvedValue({ data: { object: { sha: "source-head" } } });
  octokit.getCommit.mockResolvedValue({ data: { tree: { sha: "source-tree" } } });
  octokit.getTree.mockResolvedValue({ data: { tree: [{ type: "blob", path: "plot.md" }] } });
  octokit.createBlob.mockResolvedValue({ data: { sha: "pushed-blob" } });
  octokit.createTree.mockResolvedValue({ data: { sha: "pushed-tree" } });
  octokit.createCommit.mockResolvedValue({ data: { sha: "pushed-head" } });
  octokit.updateRef.mockImplementation(async () => {
    await writeLocalText(repoId, "plot.md", "newer local edit");
    return { data: {} };
  });

  const result = await pushLocalCommits({ bookId: "book", token: "token", repoId });

  const current = await getLocalFile(repoId, "plot.md");
  expect(result).toMatchObject({ commitSha: "pushed-head", recoveryPaths: ["plot.md"] });
  expect(current).toMatchObject({ text: "newer local edit", status: "modified", committed: false, baseSha: "pushed-blob", baseHash: commit.files[0].hash });
  expect((await listDirtyLocalFiles(repoId)).map((file) => file.path)).toEqual(["plot.md"]);
  expect(await listUnpushedLocalCommits(repoId)).toEqual([]);
});

test("multiple commits to one path push and settle against the final committed revision", async () => {
  vi.spyOn(Date.prototype, "toISOString").mockReturnValue("2026-08-16T00:00:00.000Z");
  const repo = await putLocalRepository({ bookId: "book", owner: "owner", repo: "repo", branch: "main", defaultBranch: "main", remoteHeadSha: "source-head", clonedAt: new Date().toISOString(), cloneComplete: true });
  repoId = repo.id;
  const original = await putCleanLocalFile({ repoId, path: "plot.md", kind: "text", text: "old", baseSha: "old-blob", size: 3 });
  const first = await mutateLocalTextFilesAndCreateCommitAtomically(repoId, "First update", [
    { path: "plot.md", content: "first", expectedCurrentHash: original.currentHash },
  ]);
  const second = await mutateLocalTextFilesAndCreateCommitAtomically(repoId, "Second update", [
    { path: "plot.md", content: "second", expectedCurrentHash: first.files[0].hash },
  ]);
  octokit.getRef.mockResolvedValue({ data: { object: { sha: "source-head" } } });
  octokit.getCommit.mockResolvedValue({ data: { tree: { sha: "source-tree" } } });
  octokit.getTree.mockResolvedValue({ data: { tree: [{ type: "blob", path: "plot.md" }] } });
  octokit.createBlob.mockResolvedValue({ data: { sha: "pushed-blob" } });
  octokit.createTree.mockResolvedValue({ data: { sha: "pushed-tree" } });
  octokit.createCommit.mockResolvedValue({ data: { sha: "pushed-head" } });
  octokit.updateRef.mockResolvedValue({ data: {} });

  const result = await pushLocalCommits({ bookId: "book", token: "token", repoId });

  expect([first.order, second.order]).toEqual([1, 2]);
  expect(result.recoveryPaths).toBeUndefined();
  expect(await getLocalFile(repoId, "plot.md")).toMatchObject({ text: "second", status: "clean", committed: false, baseSha: "pushed-blob" });
  expect(await listUnpushedLocalCommits(repoId)).toEqual([]);
});
