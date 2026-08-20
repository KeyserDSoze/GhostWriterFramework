import "fake-indexeddb/auto";
import { afterEach, expect, test, vi } from "vitest";
import {
  listUnpushedLocalCommits,
  mutateLocalTextFilesAndCreateCommitAtomically,
  putLocalRepository,
  removeLocalRepository,
} from "@/repository/localRepository";
import { putCleanLocalFile } from "./helpers/localRepositorySeed";
import { captureRepositoryOperationScope } from "@/repository/repositoryOperationScope";
import { useAuthStore } from "@/store/authStore";

useAuthStore.setState({ user: { provider: "google", providerAccountId: "sub-writer", name: "Writer", email: "writer@example.com", picture: "" } });

let repoId = "";

afterEach(async () => {
  vi.restoreAllMocks();
  if (repoId) await removeLocalRepository(repoId, captureRepositoryOperationScope());
  repoId = "";
});

async function putLegacyCommits(commits: Array<Record<string, unknown>>): Promise<void> {
  const db = await new Promise<IDBDatabase>((resolve, reject) => {
    const request = indexedDB.open("narrarium-local-repositories");
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
  await new Promise<void>((resolve, reject) => {
    const tx = db.transaction("commits", "readwrite");
    const store = tx.objectStore("commits");
    for (const commit of commits) store.put(commit);
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
  });
  db.close();
}

test("identical timestamps retain transactional creation order after module reload", async () => {
  vi.spyOn(Date.prototype, "toISOString").mockReturnValue("2026-08-16T00:00:00.000Z");
  const repo = await putLocalRepository({ bookId: "book", owner: "owner", repo: "ordered", branch: "main", defaultBranch: "main", remoteHeadSha: "head", clonedAt: "2026-08-16T00:00:00.000Z", cloneComplete: true }, captureRepositoryOperationScope());
  repoId = repo.id;
  const original = await putCleanLocalFile({ repoId, path: "plot.md", kind: "text", text: "old", size: 3 });
  const first = await mutateLocalTextFilesAndCreateCommitAtomically(repoId, captureRepositoryOperationScope(), "First", [{ path: "plot.md", content: "first", expectedCurrentHash: original.currentHash }]);
  const second = await mutateLocalTextFilesAndCreateCommitAtomically(repoId, captureRepositoryOperationScope(), "Second", [{ path: "plot.md", content: "second", expectedCurrentHash: first.files[0].hash }]);

  expect(first.createdAt).toBe(second.createdAt);
  expect((await listUnpushedLocalCommits(repoId)).map((commit) => [commit.message, commit.order])).toEqual([["First", 1], ["Second", 2]]);

  vi.resetModules();
  const reloaded = await import("@/repository/localRepository");
  expect((await reloaded.listUnpushedLocalCommits(repoId)).map((commit) => [commit.message, commit.order])).toEqual([["First", 1], ["Second", 2]]);
});

test("legacy commits without an order use a stable total fallback before sequenced commits", async () => {
  vi.spyOn(Date.prototype, "toISOString").mockReturnValue("2026-08-16T00:00:00.000Z");
  const repo = await putLocalRepository({ bookId: "book", owner: "owner", repo: "legacy", branch: "main", defaultBranch: "main", remoteHeadSha: "head", clonedAt: "2026-08-16T00:00:00.000Z", cloneComplete: true }, captureRepositoryOperationScope());
  repoId = repo.id;
  await putLegacyCommits([
    { id: "legacy-z", repoId, message: "Legacy Z", createdAt: "2026-08-16T00:00:00.000Z", files: [], pushed: false },
    { id: "legacy-a", repoId, message: "Legacy A", createdAt: "2026-08-16T00:00:00.000Z", files: [], pushed: false },
  ]);
  const original = await putCleanLocalFile({ repoId, path: "plot.md", kind: "text", text: "old", size: 3 });
  const current = await mutateLocalTextFilesAndCreateCommitAtomically(repoId, captureRepositoryOperationScope(), "Sequenced", [{ path: "plot.md", content: "new", expectedCurrentHash: original.currentHash }]);

  expect(current.order).toBe(1);
  expect((await listUnpushedLocalCommits(repoId)).map((commit) => commit.id)).toEqual(["legacy-a", "legacy-z", current.id]);
});
