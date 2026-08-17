import "fake-indexeddb/auto";
import { afterEach, describe, expect, it } from "vitest";
import {
  getLocalFile,
  listDirtyLocalFiles,
  listUnpushedLocalCommits,
  markLocalCommitsPushed,
  mutateLocalTextFilesAndCreateCommitAtomically,
  putCleanLocalFile,
  putLocalRepository,
  removeLocalRepository,
  restoreLocalFilesAndDeleteCommit,
  writeLocalText,
} from "@/repository/localRepository";
import { captureRepositoryOperationScope } from "@/repository/repositoryOperationScope";
import { useAuthStore } from "@/store/authStore";

useAuthStore.setState({ user: { provider: "google", providerAccountId: "sub-writer", name: "Writer", email: "writer@example.com", picture: "" } });

let repoId = "";

afterEach(async () => {
  if (repoId) await removeLocalRepository(repoId, captureRepositoryOperationScope());
  repoId = "";
});

describe("atomic local multi-file recovery", () => {
  it("rolls back create, update, and delete plus the unpushed commit in one recovery", async () => {
    const repo = await putLocalRepository({ bookId: "book", owner: "owner", repo: "repo", branch: "draft", defaultBranch: "main", remoteHeadSha: "remote", clonedAt: new Date().toISOString(), cloneComplete: true }, captureRepositoryOperationScope());
    repoId = repo.id;
    const originalA = await putCleanLocalFile({ repoId, path: "a.md", kind: "text", text: "old A", size: 5 });
    const originalB = await putCleanLocalFile({ repoId, path: "b.md", kind: "text", text: "old B", size: 5 });

    const commit = await mutateLocalTextFilesAndCreateCommitAtomically(repoId, captureRepositoryOperationScope(), "multi-file operation", [
      { path: "a.md", content: "new A", expectedCurrentHash: originalA.currentHash },
      { path: "b.md", content: null, expectedCurrentHash: originalB.currentHash },
      { path: "c.md", content: "new C", expectedCurrentHash: null },
    ]);
    expect((await getLocalFile(repoId, "a.md"))?.text).toBe("new A");
    expect(await getLocalFile(repoId, "b.md")).toBeNull();
    expect((await getLocalFile(repoId, "c.md"))?.text).toBe("new C");
    expect(commit.files.map((file) => file.path)).toEqual(["a.md", "b.md", "c.md"]);
    expect(await listUnpushedLocalCommits(repoId)).toEqual([commit]);

    await restoreLocalFilesAndDeleteCommit(repoId, captureRepositoryOperationScope(), commit.id, [
      { path: "a.md", file: originalA },
      { path: "b.md", file: originalB },
      { path: "c.md", file: null },
    ]);
    expect((await getLocalFile(repoId, "a.md"))?.text).toBe("old A");
    expect((await getLocalFile(repoId, "b.md"))?.text).toBe("old B");
    expect(await getLocalFile(repoId, "c.md")).toBeNull();
    expect(await listUnpushedLocalCommits(repoId)).toEqual([]);
    expect(await listDirtyLocalFiles(repoId)).toEqual([]);
  });

  it("does not commit or overwrite a concurrently dirtied unrelated file", async () => {
    const repo = await putLocalRepository({ bookId: "book", owner: "owner", repo: "repo", branch: "draft", defaultBranch: "main", remoteHeadSha: "remote", clonedAt: new Date().toISOString(), cloneComplete: true }, captureRepositoryOperationScope());
    repoId = repo.id;
    const target = await putCleanLocalFile({ repoId, path: "target.md", kind: "text", text: "old target", size: 10 });
    await putCleanLocalFile({ repoId, path: "unrelated.md", kind: "text", text: "old unrelated", size: 13 });
    const [commit] = await Promise.all([
      mutateLocalTextFilesAndCreateCommitAtomically(repoId, captureRepositoryOperationScope(), "target change", [
        { path: "target.md", content: "new target", expectedCurrentHash: target.currentHash },
      ]),
      writeLocalText(repoId, "unrelated.md", "dirty unrelated"),
    ]);

    expect(commit.files.map((file) => file.path)).toEqual(["target.md"]);
    expect((await getLocalFile(repoId, "unrelated.md"))?.text).toBe("dirty unrelated");
    expect((await listDirtyLocalFiles(repoId)).map((file) => file.path)).toEqual(["unrelated.md"]);

    await restoreLocalFilesAndDeleteCommit(repoId, captureRepositoryOperationScope(), commit.id, [{ path: "target.md", file: target }]);
    expect((await getLocalFile(repoId, "target.md"))?.text).toBe("old target");
    expect((await getLocalFile(repoId, "unrelated.md"))?.text).toBe("dirty unrelated");
  });

  it("does not overwrite a newer same-path edit when a push failure rolls back the mutation commit", async () => {
    const repo = await putLocalRepository({ bookId: "book", owner: "owner", repo: "repo", branch: "draft", defaultBranch: "main", remoteHeadSha: "remote", clonedAt: new Date().toISOString(), cloneComplete: true }, captureRepositoryOperationScope());
    repoId = repo.id;
    const original = await putCleanLocalFile({ repoId, path: "target.md", kind: "text", text: "old target", size: 10 });
    const commit = await mutateLocalTextFilesAndCreateCommitAtomically(repoId, captureRepositoryOperationScope(), "target change", [
      { path: "target.md", content: "mutation result", expectedCurrentHash: original.currentHash },
    ]);
    await writeLocalText(repoId, "target.md", "newer local edit");

    const recovery = await restoreLocalFilesAndDeleteCommit(repoId, captureRepositoryOperationScope(), commit.id, [{ path: "target.md", file: original }]);

    expect(recovery.skippedPaths).toEqual(["target.md"]);
    expect((await getLocalFile(repoId, "target.md"))?.text).toBe("newer local edit");
    expect((await listDirtyLocalFiles(repoId)).map((file) => file.path)).toEqual(["target.md"]);
    expect(await listUnpushedLocalCommits(repoId)).toEqual([]);
  });

  it("keeps a newer same-path edit dirty when the mutation commit is marked pushed", async () => {
    const repo = await putLocalRepository({ bookId: "book", owner: "owner", repo: "repo", branch: "draft", defaultBranch: "main", remoteHeadSha: "remote", clonedAt: new Date().toISOString(), cloneComplete: true }, captureRepositoryOperationScope());
    repoId = repo.id;
    const original = await putCleanLocalFile({ repoId, path: "target.md", kind: "text", text: "old target", size: 10 });
    const commit = await mutateLocalTextFilesAndCreateCommitAtomically(repoId, captureRepositoryOperationScope(), "target change", [
      { path: "target.md", content: "pushed mutation", expectedCurrentHash: original.currentHash },
    ]);
    await writeLocalText(repoId, "target.md", "newer local edit");

    const settlement = await markLocalCommitsPushed(repoId, captureRepositoryOperationScope(), [commit.id], "pushed-head", { "target.md": "pushed-blob" });

    const current = await getLocalFile(repoId, "target.md");
    expect(settlement.skippedPaths).toEqual(["target.md"]);
    expect(current).toMatchObject({ text: "newer local edit", status: "modified", committed: false, baseSha: "pushed-blob", baseHash: commit.files[0].hash });
    expect((await listDirtyLocalFiles(repoId)).map((file) => file.path)).toEqual(["target.md"]);
    expect(await listUnpushedLocalCommits(repoId)).toEqual([]);
  });

  it("validates every target hash before applying writes or creating a commit", async () => {
    const repo = await putLocalRepository({ bookId: "book", owner: "owner", repo: "repo", branch: "draft", defaultBranch: "main", remoteHeadSha: "remote", clonedAt: new Date().toISOString(), cloneComplete: true }, captureRepositoryOperationScope());
    repoId = repo.id;
    const originalA = await putCleanLocalFile({ repoId, path: "a.md", kind: "text", text: "old A", size: 5 });
    await putCleanLocalFile({ repoId, path: "b.md", kind: "text", text: "old B", size: 5 });

    await expect(mutateLocalTextFilesAndCreateCommitAtomically(repoId, captureRepositoryOperationScope(), "stale operation", [
      { path: "a.md", content: "new A", expectedCurrentHash: originalA.currentHash },
      { path: "b.md", content: "new B", expectedCurrentHash: "stale-hash" },
    ])).rejects.toThrow("File changed since it was read: b.md");

    expect((await getLocalFile(repoId, "a.md"))?.text).toBe("old A");
    expect((await getLocalFile(repoId, "b.md"))?.text).toBe("old B");
    expect(await listUnpushedLocalCommits(repoId)).toEqual([]);
  });

  it("rejects foreign commit IDs without mutating either repository", async () => {
    const scope = captureRepositoryOperationScope();
    const first = await putLocalRepository({ bookId: "first", owner: "owner", repo: "first", branch: "main", defaultBranch: "main", remoteHeadSha: "head", clonedAt: new Date().toISOString() }, scope);
    const second = await putLocalRepository({ bookId: "second", owner: "owner", repo: "second", branch: "main", defaultBranch: "main", remoteHeadSha: "head", clonedAt: new Date().toISOString() }, scope);
    repoId = first.id;
    const file = await putCleanLocalFile({ repoId: first.id, path: "plot.md", kind: "text", text: "old", size: 3 });
    const commit = await mutateLocalTextFilesAndCreateCommitAtomically(first.id, scope, "foreign", [{ path: "plot.md", content: "new", expectedCurrentHash: file.currentHash }]);

    await expect(markLocalCommitsPushed(second.id, scope, [commit.id], "pushed", {})).rejects.toMatchObject({ code: "REPOSITORY_OWNERSHIP_CHANGED" });
    await expect(restoreLocalFilesAndDeleteCommit(second.id, scope, commit.id, [])).rejects.toMatchObject({ code: "REPOSITORY_OWNERSHIP_CHANGED" });
    expect(await listUnpushedLocalCommits(first.id)).toEqual([commit]);
    await removeLocalRepository(second.id, scope);
  });
});
