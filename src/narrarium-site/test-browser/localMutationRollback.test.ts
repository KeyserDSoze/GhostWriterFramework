import "fake-indexeddb/auto";
import { afterEach, describe, expect, it } from "vitest";
import {
  createLocalCommit,
  getLocalFile,
  listDirtyLocalFiles,
  listUnpushedLocalCommits,
  mutateLocalTextFilesAtomically,
  putCleanLocalFile,
  putLocalRepository,
  removeLocalRepository,
  restoreLocalFilesAndDeleteCommit,
} from "@/repository/localRepository";

let repoId = "";

afterEach(async () => {
  if (repoId) await removeLocalRepository(repoId);
  repoId = "";
});

describe("atomic local multi-file recovery", () => {
  it("rolls back create, update, and delete plus the unpushed commit in one recovery", async () => {
    const repo = await putLocalRepository({ bookId: "book", owner: "owner", repo: "repo", branch: "draft", defaultBranch: "main", remoteHeadSha: "remote", clonedAt: new Date().toISOString(), cloneComplete: true });
    repoId = repo.id;
    const originalA = await putCleanLocalFile({ repoId, path: "a.md", kind: "text", text: "old A", size: 5 });
    const originalB = await putCleanLocalFile({ repoId, path: "b.md", kind: "text", text: "old B", size: 5 });

    await mutateLocalTextFilesAtomically(repoId, [
      { path: "a.md", content: "new A", expectedCurrentHash: originalA.currentHash },
      { path: "b.md", content: null, expectedCurrentHash: originalB.currentHash },
      { path: "c.md", content: "new C", expectedCurrentHash: null },
    ]);
    const commit = await createLocalCommit(repoId, "multi-file operation");
    expect((await getLocalFile(repoId, "a.md"))?.text).toBe("new A");
    expect(await getLocalFile(repoId, "b.md")).toBeNull();
    expect((await getLocalFile(repoId, "c.md"))?.text).toBe("new C");

    await restoreLocalFilesAndDeleteCommit(repoId, commit.id, [
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
});
