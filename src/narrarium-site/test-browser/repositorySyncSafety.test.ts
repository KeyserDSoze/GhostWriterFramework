import "fake-indexeddb/auto";
import { afterEach, expect, test, vi } from "vitest";

const octokit = vi.hoisted(() => ({
  getRepo: vi.fn(),
  getRef: vi.fn(),
  getCommit: vi.fn(),
  getTree: vi.fn(),
  getBlob: vi.fn(),
  createBlob: vi.fn(),
  createTree: vi.fn(),
  createCommit: vi.fn(),
  updateRef: vi.fn(),
}));

vi.mock("@octokit/rest", () => ({ Octokit: class { rest = { git: octokit, repos: { get: octokit.getRepo } }; } }));

import {
  createLocalCommit,
  createLocalRepositoryClone,
  claimLocalRepositoryRepair,
  claimLegacyLocalRepositoryMigration,
  createLocalRecoverySnapshot,
  applyRemoteMergeAtomically,
  mutateLocalTextFilesAndCreateCommitAtomically,
  deleteLocalRecoverySnapshot,
  deleteLocalFile,
  getLocalFile as getLocalFileScoped,
  getLocalRecoverySnapshot,
  getLocalRepositoryById,
  listLocalRecoverySnapshots,
  listUnpushedLocalCommits,
  putCleanLocalFile,
  putLocalRepository,
  putQuarantinedLocalRepository,
  removeLocalRepository,
  removeAbandonedLocalClone,
  releaseLocalRepositoryRepair,
  releaseLegacyLocalRepositoryMigration,
  reclaimExpiredRepositoryLifecycleLease,
  heartbeatRepositoryLifecycleLease,
  markLocalRepositoryCloneComplete,
  classifyLegacyLocalRepositoryMigration,
  applyCloneRepairAtomically,
  restoreUnpushedCommitsAsDirty,
  restoreLocalRecoverySnapshot,
  listDirtyLocalFiles,
  writeLocalText,
} from "@/repository/localRepository";
import { ensureLocalBookStructure, migrateLegacyLocalRepository, overwriteRemoteWithLocal, pullRemoteChanges, pushLocalCommits, recloneLocalWorkingCopy, restoreLocalFilesToBase, restoreRepositoryRecovery, syncFullRepository, verifyAndRepairLocalRepository } from "@/repository/repositoryService";
import { useAuthStore } from "@/store/authStore";
import { captureRepositoryOperationScope } from "@/repository/repositoryOperationScope";

let repoId = "";
const identity = "google:sub-writer";
const target = { bookId: "book", owner: "owner", repo: "repo", branch: "main", accountIdentity: identity };
const getLocalFile = (repoIdValue: string, path: string) => {
  if (useAuthStore.getState().user?.providerAccountId !== "sub-writer") {
    useAuthStore.setState({ user: { provider: "google", providerAccountId: "sub-writer", name: "Writer", email: "writer@example.com", picture: "" } });
  }
  return getLocalFileScoped(repoIdValue, path, captureRepositoryOperationScope());
};

useAuthStore.setState({ user: { provider: "google", providerAccountId: "sub-writer", name: "Writer", email: "writer@example.com", picture: "" } });

afterEach(async () => {
  vi.clearAllMocks();
  useAuthStore.setState({ user: { provider: "google", providerAccountId: "sub-writer", name: "Writer", email: "writer@example.com", picture: "" } });
  if (repoId) for (const recovery of await listLocalRecoverySnapshots(repoId, identity)) await deleteLocalRecoverySnapshot(recovery.id, identity);
  if (repoId) await removeLocalRepository(repoId, captureRepositoryOperationScope());
  repoId = "";
});

async function setup(cloneComplete = true) {
  const meta = await putLocalRepository({ ...target, defaultBranch: "main", remoteHeadSha: "base-head", clonedAt: new Date().toISOString(), cloneComplete }, captureRepositoryOperationScope());
  repoId = meta.id;
  return meta;
}

function switchAccount(): void {
  useAuthStore.setState({ user: { provider: "google", providerAccountId: "sub-other", name: "Other", email: "other@example.com", picture: "" } });
}

function gate<T>() {
  let release!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((resolve, rejectPromise) => { release = resolve; reject = rejectPromise; });
  return { promise, release, reject };
}

test("pull applies nothing when the account switches during download", async () => {
  await setup();
  await putCleanLocalFile({ repoId, path: "plot.md", kind: "text", text: "old", baseSha: "old-blob", size: 3 });
  const blob = gate<{ data: { encoding: string; content: string } }>();
  octokit.getRef.mockResolvedValue({ data: { object: { sha: "remote-head" } } });
  octokit.getCommit.mockImplementation(async ({ commit_sha }: { commit_sha: string }) => ({ data: { tree: { sha: `${commit_sha}-tree` } } }));
  octokit.getTree.mockResolvedValue({ data: { truncated: false, tree: [{ type: "blob", path: "plot.md", sha: "new-blob" }] } });
  octokit.getBlob.mockReturnValue(blob.promise);
  const operation = pullRemoteChanges({ ...target, token: "token" });
  await vi.waitFor(() => expect(octokit.getBlob).toHaveBeenCalled());
  switchAccount();
  blob.release({ data: { encoding: "base64", content: btoa("new") } });
  await expect(operation).rejects.toMatchObject({ code: "REPOSITORY_OWNERSHIP_CHANGED" });
  expect(await getLocalFile(repoId, "plot.md")).toMatchObject({ text: "old", baseSha: "old-blob" });
});

test("full sync applies nothing when the account switches during download", async () => {
  await setup();
  await putCleanLocalFile({ repoId, path: "plot.md", kind: "text", text: "old", baseSha: "old-blob", size: 3 });
  const blob = gate<{ data: { encoding: string; content: string } }>();
  octokit.getRef.mockResolvedValue({ data: { object: { sha: "remote-head" } } });
  octokit.getCommit.mockImplementation(async ({ commit_sha }: { commit_sha: string }) => ({ data: { tree: { sha: `${commit_sha}-tree` } } }));
  octokit.getTree.mockResolvedValue({ data: { truncated: false, tree: [{ type: "blob", path: "plot.md", sha: "new-blob" }] } });
  octokit.getBlob.mockReturnValue(blob.promise);
  const operation = syncFullRepository({ ...target, token: "token" });
  await vi.waitFor(() => expect(octokit.getBlob).toHaveBeenCalled());
  switchAccount();
  blob.release({ data: { encoding: "base64", content: btoa("new") } });
  await expect(operation).rejects.toMatchObject({ code: "REPOSITORY_OWNERSHIP_CHANGED" });
  expect(await getLocalFile(repoId, "plot.md")).toMatchObject({ text: "old", baseSha: "old-blob" });
});

test("push settlement applies nothing when the account switches after remote work", async () => {
  await setup();
  const original = await putCleanLocalFile({ repoId, path: "plot.md", kind: "text", text: "old", baseSha: "old-blob", size: 3 });
  const commit = await mutateLocalTextFilesAndCreateCommitAtomically(repoId, captureRepositoryOperationScope(), "push", [{ path: "plot.md", content: "new", expectedCurrentHash: original.currentHash }]);
  octokit.getRef.mockResolvedValue({ data: { object: { sha: "base-head" } } });
  octokit.getCommit.mockResolvedValue({ data: { tree: { sha: "base-tree" } } });
  octokit.getTree.mockResolvedValue({ data: { truncated: false, tree: [{ type: "blob", path: "plot.md" }] } });
  octokit.createBlob.mockResolvedValue({ data: { sha: "new-blob" } });
  octokit.createTree.mockResolvedValue({ data: { sha: "new-tree" } });
  octokit.createCommit.mockResolvedValue({ data: { sha: "new-head" } });
  octokit.updateRef.mockImplementation(async () => { switchAccount(); return { data: {} }; });
  await expect(pushLocalCommits({ ...target, token: "token", repoId })).rejects.toMatchObject({ code: "REPOSITORY_OWNERSHIP_CHANGED" });
  expect(await listUnpushedLocalCommits(repoId)).toEqual([commit]);
  expect(await getLocalFile(repoId, "plot.md")).toMatchObject({ text: "new", committed: true, baseSha: "old-blob" });
});

test("clone repair applies nothing when the account switches during download", async () => {
  const meta = await setup(false);
  const blob = gate<{ data: { encoding: string; content: string } }>();
  octokit.getTree.mockResolvedValue({ data: { truncated: false, tree: [{ type: "blob", path: "missing.md", sha: "blob" }] } });
  octokit.getBlob.mockReturnValue(blob.promise);
  const operation = verifyAndRepairLocalRepository({ meta, token: "token", accountIdentity: identity });
  await vi.waitFor(() => expect(octokit.getBlob).toHaveBeenCalled());
  switchAccount();
  blob.release({ data: { encoding: "base64", content: btoa("new") } });
  await expect(operation).rejects.toMatchObject({ code: "REPOSITORY_OWNERSHIP_CHANGED" });
  expect(await getLocalFile(repoId, "missing.md")).toBeNull();
});

test("failed clone after account switch leaves the original incomplete clone quarantined", async () => {
  const blob = gate<{ data: { encoding: string; content: string } }>();
  octokit.getRepo.mockResolvedValue({ data: { default_branch: "main" } });
  octokit.getRef.mockResolvedValue({ data: { object: { sha: "clone-head" } } });
  octokit.getTree.mockResolvedValue({ data: { truncated: false, tree: [{ type: "blob", path: "book.md", sha: "book-blob", size: 4 }] } });
  octokit.getBlob.mockReturnValue(blob.promise);

  const operation = ensureLocalBookStructure({ bookId: "book", book: { id: "book", owner: "owner", repo: "repo" } as any, token: "token", accountIdentity: identity, branch: "main" });
  await vi.waitFor(() => expect(octokit.getBlob).toHaveBeenCalled());
  const originalRepoId = `${identity}::owner/repo#main`;
  repoId = originalRepoId;
  switchAccount();
  blob.reject(new Error("download failed"));

  await expect(operation).rejects.toThrow();
  useAuthStore.setState({ user: { provider: "google", providerAccountId: "sub-writer", name: "Writer", email: "writer@example.com", picture: "" } });
  expect(await getLocalRepositoryById(originalRepoId, identity)).toMatchObject({ id: originalRepoId, accountScope: identity, cloneComplete: false });
});

test("concurrent clone shares the active clone transaction", async () => {
  const blob = gate<{ data: { encoding: string; content: string } }>();
  octokit.getRepo.mockResolvedValue({ data: { default_branch: "main" } });
  octokit.getRef.mockResolvedValue({ data: { object: { sha: "clone-head" } } });
  octokit.getTree.mockResolvedValue({ data: { truncated: false, tree: [{ type: "blob", path: "book.md", sha: "book-blob", size: 4 }] } });
  octokit.getBlob.mockReturnValue(blob.promise);
  const input = { bookId: "book", book: { id: "book", owner: "owner", repo: "repo" } as any, token: "token", accountIdentity: identity, branch: "main" };

  const first = ensureLocalBookStructure(input);
  await vi.waitFor(() => expect(octokit.getBlob).toHaveBeenCalledTimes(1));
  const activeId = `${identity}::owner/repo#main`;
  repoId = activeId;
  const active = await getLocalRepositoryById(activeId, identity);
  expect(active).toMatchObject({ cloneComplete: false });
  expect(active?.cloneOperationId).toBeTruthy();

  const concurrent = ensureLocalBookStructure(input);
  expect((await getLocalRepositoryById(activeId, identity))?.cloneOperationId).toBe(active?.cloneOperationId);

  blob.release({ data: { encoding: "base64", content: btoa("book") } });
  await expect(first).resolves.toMatchObject({ meta: { cloneComplete: true, lastCloneOperationId: active?.cloneOperationId } });
  await expect(concurrent).resolves.toMatchObject({ meta: { cloneComplete: true, lastCloneOperationId: active?.cloneOperationId } });
  expect(octokit.getBlob).toHaveBeenCalledTimes(1);
  expect(await getLocalFile(activeId, "book.md")).toMatchObject({ text: "book" });
});

test("stale clone cleanup is rejected after the repository is replaced", async () => {
  const scope = captureRepositoryOperationScope();
  const cloneOperationId = crypto.randomUUID();
  const clone = await createLocalRepositoryClone({ bookId: "book", owner: "owner", repo: "replacement", branch: "main", defaultBranch: "main", remoteHeadSha: "old", clonedAt: new Date().toISOString() }, scope, cloneOperationId);
  repoId = clone.id;
  await putLocalRepository({ bookId: "book", owner: "owner", repo: "replacement", branch: "main", defaultBranch: "main", remoteHeadSha: "new", clonedAt: new Date().toISOString(), cloneComplete: true }, scope);

  await expect(removeAbandonedLocalClone(clone, scope, cloneOperationId)).rejects.toMatchObject({ code: "REPOSITORY_OWNERSHIP_CHANGED" });
  expect(await getLocalRepositoryById(clone.id, identity)).toMatchObject({ cloneComplete: true, remoteHeadSha: "new" });
});

test("truncated initial clone transitions to repair-required and later repairs successfully", async () => {
  octokit.getRepo.mockResolvedValue({ data: { default_branch: "main" } });
  octokit.getRef.mockResolvedValue({ data: { object: { sha: "clone-head" } } });
  octokit.getTree.mockResolvedValueOnce({ data: { truncated: true, tree: [{ type: "blob", path: "book.md", sha: "book-blob", size: 4 }] } });
  octokit.getBlob.mockResolvedValue({ data: { encoding: "base64", content: btoa("book") } });
  const input = { bookId: "book", book: { id: "book", owner: "owner", repo: "repairable" } as any, token: "token", accountIdentity: identity, branch: "main" };

  const cloned = await ensureLocalBookStructure(input);
  repoId = cloned.meta.id;
  const repairable = await getLocalRepositoryById(repoId, identity);
  expect(repairable).toMatchObject({ cloneComplete: false, cloneStatus: "repair-required" });
  expect(repairable?.cloneOperationId).toBeUndefined();

  octokit.getTree.mockResolvedValueOnce({ data: { truncated: false, tree: [
    { type: "blob", path: "book.md", sha: "book-blob", size: 4 },
    { type: "blob", path: "plot.md", sha: "plot-blob", size: 4 },
  ] } });
  octokit.getBlob.mockImplementation(async ({ file_sha }: { file_sha: string }) => ({ data: { encoding: "base64", content: btoa(file_sha === "plot-blob" ? "plot" : "book") } }));
  const repaired = await verifyAndRepairLocalRepository({ meta: repairable!, token: "token", accountIdentity: identity });
  expect(repaired.meta).toMatchObject({ cloneComplete: true, cloneStatus: "complete" });
  expect(repaired.meta.repairOperationId).toBeUndefined();
  expect(await getLocalFile(repoId, "plot.md")).toMatchObject({ text: "plot" });
});

test("failed repair releases its token and a later repair can retry", async () => {
  const meta = await setup(false);
  octokit.getTree.mockRejectedValueOnce(new Error("temporary repair failure"));
  await expect(verifyAndRepairLocalRepository({ meta, token: "token", accountIdentity: identity })).rejects.toThrow("temporary repair failure");
  const retryable = await getLocalRepositoryById(repoId, identity);
  expect(retryable).toMatchObject({ cloneComplete: false, cloneStatus: "repair-required" });
  expect(retryable?.repairOperationId).toBeUndefined();

  octokit.getTree.mockResolvedValueOnce({ data: { truncated: false, tree: [] } });
  await expect(verifyAndRepairLocalRepository({ meta: retryable!, token: "token", accountIdentity: identity })).resolves.toMatchObject({ meta: { cloneComplete: true, cloneStatus: "complete" } });
});

test("concurrent repairs are fenced by unique repair operation IDs", async () => {
  const meta = await setup(false);
  const scope = captureRepositoryOperationScope();
  const firstRepairId = crypto.randomUUID();
  const secondRepairId = crypto.randomUUID();
  const claimed = await claimLocalRepositoryRepair(meta.id, scope, firstRepairId);
  expect(claimed).toMatchObject({ cloneStatus: "repairing", repairOperationId: firstRepairId });

  await expect(claimLocalRepositoryRepair(meta.id, scope, secondRepairId)).rejects.toMatchObject({ code: "LOCAL_CLONE_ALREADY_IN_PROGRESS" });
  await expect(releaseLocalRepositoryRepair(meta.id, scope, secondRepairId)).rejects.toMatchObject({ code: "REPOSITORY_OWNERSHIP_CHANGED" });
  expect(await getLocalRepositoryById(meta.id, identity)).toMatchObject({ cloneStatus: "repairing", repairOperationId: firstRepairId });

  await releaseLocalRepositoryRepair(meta.id, scope, firstRepairId);
  expect(await getLocalRepositoryById(meta.id, identity)).toMatchObject({ cloneStatus: "repair-required", repairOperationId: undefined });
});

test("legacy complete working copy is verified and loaded without repair", async () => {
  const meta = await putLocalRepository({ ...target, repo: "legacy-complete", defaultBranch: "main", remoteHeadSha: "legacy-head", clonedAt: new Date().toISOString() }, captureRepositoryOperationScope());
  repoId = meta.id;
  await putCleanLocalFile({ repoId, path: "book.md", kind: "text", text: "book", baseSha: "book-blob", size: 4 });
  octokit.getRepo.mockResolvedValue({ data: { default_branch: "main" } });
  octokit.getTree.mockResolvedValue({ data: { truncated: false, tree: [{ type: "blob", path: "book.md", sha: "book-blob", size: 4 }] } });
  octokit.getBlob.mockResolvedValue({ data: { encoding: "base64", content: btoa("book") } });

  const result = await ensureLocalBookStructure({ bookId: "book", book: { id: "book", owner: "owner", repo: "legacy-complete" } as any, token: "token", accountIdentity: identity, branch: "main" });
  expect(result).toMatchObject({ cloned: false, meta: { cloneComplete: true, cloneStatus: "complete" } });
  expect(octokit.getTree).toHaveBeenCalledWith(expect.objectContaining({ tree_sha: "legacy-head" }));
});

test("legacy incomplete working copy is classified repair-required then repaired", async () => {
  const meta = await putLocalRepository({ ...target, repo: "legacy-incomplete", defaultBranch: "main", remoteHeadSha: "legacy-head", clonedAt: new Date().toISOString() }, captureRepositoryOperationScope());
  repoId = meta.id;
  await putCleanLocalFile({ repoId, path: "book.md", kind: "text", text: "book", baseSha: "book-blob", size: 4 });
  octokit.getTree
    .mockResolvedValueOnce({ data: { truncated: false, tree: [{ type: "blob", path: "book.md", sha: "book-blob" }, { type: "blob", path: "plot.md", sha: "plot-blob" }] } })
    .mockResolvedValueOnce({ data: { truncated: false, tree: [{ type: "blob", path: "book.md", sha: "book-blob" }, { type: "blob", path: "plot.md", sha: "plot-blob" }] } });
  octokit.getBlob.mockImplementation(async ({ file_sha }: { file_sha: string }) => ({ data: { encoding: "base64", content: btoa(file_sha === "plot-blob" ? "plot" : "book") } }));

  const migrated = await migrateLegacyLocalRepository({ meta, token: "token", accountIdentity: identity });
  expect(migrated).toMatchObject({ cloneComplete: false, cloneStatus: "repair-required" });
  const repaired = await verifyAndRepairLocalRepository({ meta: migrated, token: "token", accountIdentity: identity });
  expect(repaired.meta).toMatchObject({ cloneComplete: true, cloneStatus: "complete" });
  expect(await getLocalFile(repoId, "plot.md")).toMatchObject({ text: "plot" });
});

test("concurrent legacy migrations are fenced", async () => {
  const meta = await putLocalRepository({ ...target, repo: "legacy-concurrent", defaultBranch: "main", remoteHeadSha: "legacy-head", clonedAt: new Date().toISOString() }, captureRepositoryOperationScope());
  repoId = meta.id;
  const scope = captureRepositoryOperationScope();
  const firstId = crypto.randomUUID();
  const secondId = crypto.randomUUID();
  const claimed = await claimLegacyLocalRepositoryMigration(meta.id, scope, firstId);
  expect(claimed).toMatchObject({ cloneStatus: "migrating", migrationOperationId: firstId });
  await expect(claimLegacyLocalRepositoryMigration(meta.id, scope, secondId)).rejects.toMatchObject({ code: "LOCAL_CLONE_ALREADY_IN_PROGRESS" });
  await expect(releaseLegacyLocalRepositoryMigration(meta.id, scope, secondId)).rejects.toMatchObject({ code: "REPOSITORY_OWNERSHIP_CHANGED" });
  await releaseLegacyLocalRepositoryMigration(meta.id, scope, firstId);
  const retryable = await getLocalRepositoryById(meta.id, identity);
  expect(retryable?.cloneComplete).toBeUndefined();
  expect(retryable?.cloneStatus).toBeUndefined();
  expect(retryable?.migrationOperationId).toBeUndefined();
});

test("truncated remote leaves legacy migration retryable", async () => {
  const meta = await putLocalRepository({ ...target, repo: "legacy-truncated", defaultBranch: "main", remoteHeadSha: "legacy-head", clonedAt: new Date().toISOString() }, captureRepositoryOperationScope());
  repoId = meta.id;
  octokit.getTree.mockResolvedValue({ data: { truncated: true, tree: [] } });

  await expect(migrateLegacyLocalRepository({ meta, token: "token", accountIdentity: identity })).rejects.toThrow("truncated");
  const retryable = await getLocalRepositoryById(meta.id, identity);
  expect(retryable?.cloneComplete).toBeUndefined();
  expect(retryable?.cloneStatus).toBeUndefined();
  expect(retryable?.migrationOperationId).toBeUndefined();
});

test("recovery applies nothing when the account switches before its transaction", async () => {
  await setup();
  await writeLocalText(repoId, "plot.md", "snapshot");
  const snapshot = await createLocalRecoverySnapshot(repoId, "switch", captureRepositoryOperationScope());
  await writeLocalText(repoId, "plot.md", "current");
  const operation = restoreRepositoryRecovery({ ...target, repoId, recoveryId: snapshot.id });
  switchAccount();
  await expect(operation).rejects.toMatchObject({ code: "REPOSITORY_OWNERSHIP_CHANGED" });
  expect(await getLocalFile(repoId, "plot.md")).toMatchObject({ text: "current" });
});

test("direct atomic merge applies nothing with a stale operation scope", async () => {
  await setup();
  const file = await putCleanLocalFile({ repoId, path: "plot.md", kind: "text", text: "old", baseSha: "old-blob", size: 3 });
  const scope = captureRepositoryOperationScope();
  switchAccount();
  await expect(applyRemoteMergeAtomically({ repoId, scope, remoteHeadSha: "new-head", expectedFiles: [file], deletes: [], writes: [{ path: "plot.md", kind: "text", text: "new", baseSha: "new-blob", size: 3 }] })).rejects.toMatchObject({ code: "REPOSITORY_OWNERSHIP_CHANGED" });
  expect(await getLocalFile(repoId, "plot.md")).toMatchObject({ text: "old", baseSha: "old-blob" });
});

async function overwriteRecovery(value: object): Promise<void> {
  const db = await new Promise<IDBDatabase>((resolve, reject) => {
    const request = indexedDB.open("narrarium-local-repositories");
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
  await new Promise<void>((resolve, reject) => {
    const tx = db.transaction("recoveries", "readwrite");
    tx.objectStore("recoveries").put(value);
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
  });
  db.close();
}

async function patchRepository(repoIdValue: string, patch: Record<string, unknown>): Promise<void> {
  const db = await new Promise<IDBDatabase>((resolve, reject) => {
    const request = indexedDB.open("narrarium-local-repositories");
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
  await new Promise<void>((resolve, reject) => {
    const tx = db.transaction("repositories", "readwrite");
    const store = tx.objectStore("repositories");
    const request = store.get(repoIdValue);
    request.onsuccess = () => store.put({ ...request.result, ...patch });
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
  });
  db.close();
}

test.each(["cloning", "migrating", "repairing"] as const)("expired %s lease is reclaimed and stale owner is fenced", async (kind) => {
  const scope = captureRepositoryOperationScope();
  const oldOperationId = crypto.randomUUID();
  let meta;
  if (kind === "cloning") {
    meta = await createLocalRepositoryClone({ bookId: "book", owner: "owner", repo: `crashed-${kind}`, branch: "main", defaultBranch: "main", remoteHeadSha: "head", clonedAt: new Date().toISOString() }, scope, oldOperationId);
  } else {
    meta = await putLocalRepository({ ...target, repo: `crashed-${kind}`, defaultBranch: "main", remoteHeadSha: "head", clonedAt: new Date().toISOString(), ...(kind === "repairing" ? { cloneComplete: false } : {}) }, scope);
    if (kind === "migrating") meta = await claimLegacyLocalRepositoryMigration(meta.id, scope, oldOperationId);
    else meta = await claimLocalRepositoryRepair(meta.id, scope, oldOperationId);
  }
  repoId = meta.id;
  const oldFence = meta.operationFence!;
  await patchRepository(meta.id, { operationLease: { ...meta.operationLease, ownerInstanceNonce: "crashed-instance", heartbeatAt: "2000-01-01T00:00:00.000Z", expiresAt: "2000-01-01T00:00:01.000Z" } });
  const nextOperationId = crypto.randomUUID();
  const reclaimed = await reclaimExpiredRepositoryLifecycleLease(meta.id, scope, nextOperationId);
  expect(reclaimed.operationFence).toBe(oldFence + 1);
  expect(reclaimed.operationLease).toMatchObject({ operationId: nextOperationId, fence: oldFence + 1 });

  if (kind === "cloning") await expect(markLocalRepositoryCloneComplete(meta.id, scope, oldOperationId, 0, "head")).rejects.toMatchObject({ code: "REPOSITORY_OWNERSHIP_CHANGED" });
  if (kind === "migrating") await expect(classifyLegacyLocalRepositoryMigration({ repoId: meta.id, scope, migrationOperationId: oldOperationId, expectedRemoteHeadSha: "head", expectedFiles: [], expectedFileCount: 0, complete: true })).rejects.toMatchObject({ code: "REPOSITORY_OWNERSHIP_CHANGED" });
  if (kind === "repairing") await expect(applyCloneRepairAtomically({ repoId: meta.id, scope, repairOperationId: oldOperationId, expectedRemoteHeadSha: "head", expectedFiles: [], writes: [], deletePaths: [], expectedFileCount: 0 })).rejects.toMatchObject({ code: "REPOSITORY_OWNERSHIP_CHANGED" });
});

test("live lifecycle lease cannot be reclaimed", async () => {
  const scope = captureRepositoryOperationScope();
  const operationId = crypto.randomUUID();
  const meta = await createLocalRepositoryClone({ bookId: "book", owner: "owner", repo: "live-lease", branch: "main", defaultBranch: "main", remoteHeadSha: "head", clonedAt: new Date().toISOString() }, scope, operationId);
  repoId = meta.id;
  await heartbeatRepositoryLifecycleLease(meta.id, scope, operationId);
  await expect(reclaimExpiredRepositoryLifecycleLease(meta.id, scope, crypto.randomUUID())).rejects.toMatchObject({ code: "LOCAL_CLONE_ALREADY_IN_PROGRESS" });
});

test("repair replaces corrupt bytes even when baseSha matches the remote blob", async () => {
  const meta = await setup(false);
  await putCleanLocalFile({ repoId, path: "plot.md", kind: "text", text: "corrupt", baseSha: "plot-blob", size: 7 });
  octokit.getTree.mockResolvedValue({ data: { truncated: false, tree: [{ type: "blob", path: "plot.md", sha: "plot-blob", size: 4 }] } });
  octokit.getBlob.mockResolvedValue({ data: { encoding: "base64", content: btoa("good") } });

  await verifyAndRepairLocalRepository({ meta, token: "token", accountIdentity: identity });
  expect(await getLocalFile(repoId, "plot.md")).toMatchObject({ text: "good", baseSha: "plot-blob", status: "clean" });
});

test("recovery restore accepts the matching immutable account", async () => {
  await setup();
  await writeLocalText(repoId, "plot.md", "saved");
  const snapshot = await createLocalRecoverySnapshot(repoId, "matching", captureRepositoryOperationScope());
  await writeLocalText(repoId, "plot.md", "later");

  await expect(restoreRepositoryRecovery({ ...target, repoId, recoveryId: snapshot.id })).resolves.toMatchObject({ recovery: { id: snapshot.id, accountIdentity: identity } });
  expect(await getLocalFile(repoId, "plot.md")).toMatchObject({ text: "saved" });
});

test("recovery restore rejects a direct foreign recovery ID", async () => {
  await setup();
  const ownId = repoId;
  const ownSnapshot = await createLocalRecoverySnapshot(ownId, "own", captureRepositoryOperationScope());
  const foreignIdentity = "google:sub-foreign";
  useAuthStore.setState({ user: { provider: "google", providerAccountId: "sub-foreign", name: "Foreign", email: "foreign@example.com", picture: "" } });
  const foreign = await putQuarantinedLocalRepository({ bookId: target.bookId, owner: target.owner, repo: target.repo, branch: target.branch, accountScope: foreignIdentity, defaultBranch: "main", remoteHeadSha: "foreign", clonedAt: new Date().toISOString(), cloneComplete: true });

  await expect(restoreRepositoryRecovery({ ...target, accountIdentity: foreignIdentity, repoId: foreign.id, recoveryId: ownSnapshot.id })).rejects.toThrow("unavailable");

  await removeLocalRepository(foreign.id, captureRepositoryOperationScope());
  useAuthStore.setState({ user: { provider: "google", providerAccountId: "sub-writer", name: "Writer", email: "writer@example.com", picture: "" } });
  repoId = ownId;
});

test("legacy unscoped recovery snapshots cannot restore", async () => {
  await setup();
  const snapshot = await createLocalRecoverySnapshot(repoId, "legacy", captureRepositoryOperationScope());
  await overwriteRecovery({ ...snapshot, accountIdentity: undefined });

  expect(await getLocalRecoverySnapshot(snapshot.id, identity)).toBeNull();
  await expect(restoreRepositoryRecovery({ ...target, repoId, recoveryId: snapshot.id })).rejects.toThrow("unavailable");
});

test("recovery restore rejects a mismatched live target repository", async () => {
  await setup();
  const snapshot = await createLocalRecoverySnapshot(repoId, "original target", captureRepositoryOperationScope());
  await putLocalRepository({ ...target, bookId: "other-book", defaultBranch: "main", remoteHeadSha: "other", clonedAt: new Date().toISOString(), cloneComplete: true }, captureRepositoryOperationScope());

  await expect(restoreRepositoryRecovery({ ...target, bookId: "other-book", repoId, recoveryId: snapshot.id })).rejects.toThrow("does not match");
});

test("safe pull rejects local changes and remote-wins snapshots them before replacement", async () => {
  await setup();
  await putCleanLocalFile({ repoId, path: "plot.md", kind: "text", text: "base", baseSha: "base-blob", size: 4 });
  await writeLocalText(repoId, "plot.md", "local");
  octokit.getRef.mockResolvedValue({ data: { object: { sha: "remote-head" } } });
  octokit.getCommit.mockImplementation(async ({ commit_sha }: { commit_sha: string }) => ({ data: { tree: { sha: `${commit_sha}-tree` } } }));
  octokit.getTree.mockResolvedValue({ data: { truncated: false, tree: [{ type: "blob", path: "plot.md", sha: "remote-blob" }] } });
  octokit.getBlob.mockResolvedValue({ data: { encoding: "base64", content: btoa("remote") } });

  await expect(pullRemoteChanges({ ...target, token: "token" })).rejects.toThrow("clean working copy");
  await expect(pullRemoteChanges({ ...target, token: "token", mode: "remote-wins" })).rejects.toThrow("explicit confirmation");
  const result = await pullRemoteChanges({ ...target, token: "token", mode: "remote-wins", confirmed: true });

  expect(result.recoveryId).toBeTruthy();
  expect((await listLocalRecoverySnapshots(repoId, identity))[0].files.find((file) => file.path === "plot.md")?.text).toBe("local");
  expect(await getLocalFile(repoId, "plot.md")).toMatchObject({ text: "remote", baseSha: "remote-blob", status: "clean" });
});

test("push rejects a changed remote head by default", async () => {
  await setup();
  await putCleanLocalFile({ repoId, path: "plot.md", kind: "text", text: "base", baseSha: "base-blob", size: 4 });
  await writeLocalText(repoId, "plot.md", "local");
  await createLocalCommit(repoId, captureRepositoryOperationScope(), "local commit");
  octokit.getRef.mockResolvedValue({ data: { object: { sha: "other-head" } } });

  await expect(pushLocalCommits({ ...target, token: "token", repoId })).rejects.toMatchObject({ code: "REMOTE_HEAD_MISMATCH" });
});

test("push rejects a truncated base tree before creating blobs or commits", async () => {
  await setup();
  await putCleanLocalFile({ repoId, path: "plot.md", kind: "text", text: "base", baseSha: "base-blob", size: 4 });
  await writeLocalText(repoId, "plot.md", "local");
  await createLocalCommit(repoId, captureRepositoryOperationScope(), "local commit");
  octokit.getRef.mockResolvedValue({ data: { object: { sha: "base-head" } } });
  octokit.getCommit.mockResolvedValue({ data: { tree: { sha: "base-tree" } } });
  octokit.getTree.mockResolvedValue({ data: { truncated: true, tree: [] } });

  await expect(pushLocalCommits({ ...target, token: "token", repoId })).rejects.toThrow("truncated");
  expect(octokit.createBlob).not.toHaveBeenCalled();
  expect(octokit.createTree).not.toHaveBeenCalled();
  expect(await listUnpushedLocalCommits(repoId)).toHaveLength(1);
});

test("remote-wins waits for a paused push and then observes the pushed head", async () => {
  await setup();
  await putCleanLocalFile({ repoId, path: "plot.md", kind: "text", text: "base", baseSha: "base-blob", size: 4 });
  await writeLocalText(repoId, "plot.md", "pushed");
  await createLocalCommit(repoId, captureRepositoryOperationScope(), "push first");
  let remoteHead = "base-head";
  let releaseUpdate!: () => void;
  const updateGate = new Promise<void>((resolve) => { releaseUpdate = resolve; });
  let updateStarted!: () => void;
  const updateStartedPromise = new Promise<void>((resolve) => { updateStarted = resolve; });
  octokit.getRef.mockImplementation(async () => ({ data: { object: { sha: remoteHead } } }));
  octokit.getCommit.mockImplementation(async ({ commit_sha }: { commit_sha: string }) => ({ data: { tree: { sha: `${commit_sha}-tree` } } }));
  octokit.getTree.mockImplementation(async () => ({ data: { truncated: false, tree: [{ type: "blob", path: "plot.md", sha: remoteHead === "base-head" ? "base-blob" : "pushed-blob" }] } }));
  octokit.getBlob.mockResolvedValue({ data: { encoding: "base64", content: btoa("pushed") } });
  octokit.createBlob.mockResolvedValue({ data: { sha: "pushed-blob" } });
  octokit.createTree.mockResolvedValue({ data: { sha: "pushed-tree" } });
  octokit.createCommit.mockResolvedValue({ data: { sha: "pushed-head" } });
  octokit.updateRef.mockImplementation(async () => {
    updateStarted();
    await updateGate;
    remoteHead = "pushed-head";
    return { data: {} };
  });

  const push = pushLocalCommits({ ...target, token: "token", repoId });
  await updateStartedPromise;
  const pull = pullRemoteChanges({ ...target, token: "token", mode: "remote-wins", confirmed: true });
  await Promise.resolve();
  expect(octokit.getRef).toHaveBeenCalledTimes(1);
  releaseUpdate();

  await expect(push).resolves.toMatchObject({ commitSha: "pushed-head" });
  await expect(pull).resolves.toMatchObject({ remoteHeadSha: "pushed-head" });
  expect(await getLocalFile(repoId, "plot.md")).toMatchObject({ text: "pushed", status: "clean", baseSha: "pushed-blob" });
  expect(await listUnpushedLocalCommits(repoId)).toEqual([]);
});

test("push waits for a paused remote-wins pull and then fails coherently with no commits", async () => {
  await setup();
  await putCleanLocalFile({ repoId, path: "plot.md", kind: "text", text: "base", baseSha: "base-blob", size: 4 });
  await writeLocalText(repoId, "plot.md", "discarded local");
  await createLocalCommit(repoId, captureRepositoryOperationScope(), "discard me");
  let releaseBlob!: () => void;
  const blobGate = new Promise<void>((resolve) => { releaseBlob = resolve; });
  let blobStarted!: () => void;
  const blobStartedPromise = new Promise<void>((resolve) => { blobStarted = resolve; });
  octokit.getRef.mockResolvedValue({ data: { object: { sha: "remote-head" } } });
  octokit.getCommit.mockImplementation(async ({ commit_sha }: { commit_sha: string }) => ({ data: { tree: { sha: `${commit_sha}-tree` } } }));
  octokit.getTree.mockResolvedValue({ data: { truncated: false, tree: [{ type: "blob", path: "plot.md", sha: "remote-blob" }] } });
  octokit.getBlob.mockImplementation(async () => {
    blobStarted();
    await blobGate;
    return { data: { encoding: "base64", content: btoa("remote") } };
  });

  const pull = pullRemoteChanges({ ...target, token: "token", mode: "remote-wins", confirmed: true });
  await blobStartedPromise;
  const push = pushLocalCommits({ ...target, token: "token", repoId });
  await Promise.resolve();
  expect(octokit.createBlob).not.toHaveBeenCalled();
  releaseBlob();

  await expect(pull).resolves.toMatchObject({ remoteHeadSha: "remote-head" });
  await expect(push).rejects.toThrow("No local commits to push");
  expect(await getLocalFile(repoId, "plot.md")).toMatchObject({ text: "remote", status: "clean", baseSha: "remote-blob" });
  expect(await listUnpushedLocalCommits(repoId)).toEqual([]);
});

test("restoring an old committed deletion does not hide a newer recreation", async () => {
  await setup();
  await putCleanLocalFile({ repoId, path: "notes.md", kind: "text", text: "base", baseSha: "base-blob", size: 4 });
  const base = await getLocalFile(repoId, "notes.md");
  await import("@/repository/localRepository").then(({ mutateLocalTextFilesAndCreateCommitAtomically }) =>
    mutateLocalTextFilesAndCreateCommitAtomically(repoId, captureRepositoryOperationScope(), "delete", [{ path: "notes.md", content: null, expectedCurrentHash: base!.currentHash }]),
  );
  await writeLocalText(repoId, "notes.md", "recreated");

  await restoreUnpushedCommitsAsDirty(repoId, captureRepositoryOperationScope());

  expect(await listUnpushedLocalCommits(repoId)).toEqual([]);
  expect(await getLocalFile(repoId, "notes.md")).toMatchObject({ text: "recreated", status: "modified", committed: false });
});

test("sync detects a same-path conflict before applying unrelated remote files", async () => {
  await setup();
  await putCleanLocalFile({ repoId, path: "plot.md", kind: "text", text: "base", baseSha: "plot-base", size: 4 });
  await putCleanLocalFile({ repoId, path: "other.md", kind: "text", text: "old", baseSha: "other-base", size: 3 });
  await writeLocalText(repoId, "plot.md", "local");
  octokit.getRef.mockResolvedValue({ data: { object: { sha: "remote-head" } } });
  octokit.getCommit.mockImplementation(async ({ commit_sha }: { commit_sha: string }) => ({ data: { tree: { sha: `${commit_sha}-tree` } } }));
  octokit.getTree.mockResolvedValue({ data: { truncated: false, tree: [
    { type: "blob", path: "plot.md", sha: "plot-remote" },
    { type: "blob", path: "other.md", sha: "other-remote" },
  ] } });
  octokit.getBlob.mockImplementation(async ({ file_sha }: { file_sha: string }) => ({ data: { encoding: "base64", content: btoa(file_sha === "plot-remote" ? "remote conflict" : "new other") } }));

  await expect(syncFullRepository({ ...target, token: "token" })).rejects.toThrow("plot.md");

  expect(await getLocalFile(repoId, "plot.md")).toMatchObject({ text: "local", status: "modified" });
  expect(await getLocalFile(repoId, "other.md")).toMatchObject({ text: "old", baseSha: "other-base" });
});

test("truncated clone verification never deletes an omitted clean file", async () => {
  const meta = await setup(false);
  await putCleanLocalFile({ repoId, path: "kept.md", kind: "text", text: "keep", baseSha: "kept-blob", size: 4 });
  octokit.getTree.mockResolvedValue({ data: { truncated: true, tree: [] } });

  await expect(verifyAndRepairLocalRepository({ meta, token: "token", accountIdentity: identity })).rejects.toThrow("truncated");
  expect(await getLocalFile(repoId, "kept.md")).toMatchObject({ text: "keep", baseSha: "kept-blob" });
});

test("clone repair preserves a delayed concurrent edit and applies no prepared files", async () => {
  const meta = await setup(false);
  await putCleanLocalFile({ repoId, path: "stale.md", kind: "text", text: "old", baseSha: "old-blob", size: 3 });
  octokit.getTree.mockResolvedValue({ data: { truncated: false, tree: [
    { type: "blob", path: "stale.md", sha: "new-blob" },
    { type: "blob", path: "missing.md", sha: "missing-blob" },
  ] } });
  octokit.getBlob.mockImplementation(async ({ file_sha }: { file_sha: string }) => {
    if (file_sha === "missing-blob") await writeLocalText(repoId, "stale.md", "concurrent edit");
    return { data: { encoding: "base64", content: btoa(file_sha) } };
  });

  await expect(verifyAndRepairLocalRepository({ meta, token: "token", accountIdentity: identity })).rejects.toThrow("changed during clone repair");
  expect(await getLocalFile(repoId, "stale.md")).toMatchObject({ text: "concurrent edit", status: "modified" });
  expect(await getLocalFile(repoId, "missing.md")).toBeNull();
  expect((await getLocalRepositoryById(repoId, identity))?.cloneComplete).toBe(false);
});

test("clone repair preserves a delayed concurrent create at a missing target", async () => {
  const meta = await setup(false);
  octokit.getTree.mockResolvedValue({ data: { truncated: false, tree: [{ type: "blob", path: "missing.md", sha: "missing-blob" }] } });
  octokit.getBlob.mockImplementation(async () => {
    await writeLocalText(repoId, "missing.md", "local create");
    return { data: { encoding: "base64", content: btoa("remote") } };
  });

  await expect(verifyAndRepairLocalRepository({ meta, token: "token", accountIdentity: identity })).rejects.toThrow("changed during clone repair");
  expect(await getLocalFile(repoId, "missing.md")).toMatchObject({ text: "local create", status: "new" });
});

test("clone repair transaction failure rolls back every file and completeness update", async () => {
  const meta = await setup(false);
  await putCleanLocalFile({ repoId, path: "unexpected.md", kind: "text", text: "keep on failure", baseSha: "unexpected", size: 15 });
  octokit.getTree.mockResolvedValue({ data: { truncated: false, tree: [{ type: "blob", path: "missing.md", sha: "missing-blob" }] } });
  octokit.getBlob.mockResolvedValue({ data: { encoding: "base64", content: btoa("remote") } });
  const originalPut = IDBObjectStore.prototype.put;
  const putSpy = vi.spyOn(IDBObjectStore.prototype, "put").mockImplementation(function (this: IDBObjectStore, value: unknown, key?: IDBValidKey) {
    if (this.name === "repositories" && typeof value === "object" && value !== null && "cloneComplete" in value && (value as { cloneComplete?: boolean }).cloneComplete === true) {
      this.transaction.abort();
    }
    return originalPut.call(this, value, key);
  });

  await expect(verifyAndRepairLocalRepository({ meta, token: "token", accountIdentity: identity })).rejects.toThrow("aborted");
  putSpy.mockRestore();
  expect(await getLocalFile(repoId, "unexpected.md")).toMatchObject({ text: "keep on failure" });
  expect(await getLocalFile(repoId, "missing.md")).toBeNull();
});

test("remote-wins aborts atomically when a local edit lands during blob download", async () => {
  await setup();
  await putCleanLocalFile({ repoId, path: "a.md", kind: "text", text: "old-a", baseSha: "a-old", size: 5 });
  await putCleanLocalFile({ repoId, path: "b.md", kind: "text", text: "old-b", baseSha: "b-old", size: 5 });
  octokit.getRef.mockResolvedValue({ data: { object: { sha: "remote-head" } } });
  octokit.getCommit.mockImplementation(async ({ commit_sha }: { commit_sha: string }) => ({ data: { tree: { sha: `${commit_sha}-tree` } } }));
  octokit.getTree.mockResolvedValue({ data: { truncated: false, tree: [
    { type: "blob", path: "a.md", sha: "a-new" },
    { type: "blob", path: "b.md", sha: "b-new" },
  ] } });
  octokit.getBlob.mockImplementation(async ({ file_sha }: { file_sha: string }) => {
    if (file_sha === "b-new") await writeLocalText(repoId, "b.md", "concurrent");
    return { data: { encoding: "base64", content: btoa(file_sha) } };
  });

  await expect(pullRemoteChanges({ ...target, token: "token", mode: "remote-wins", confirmed: true })).rejects.toThrow("changed while");
  expect(await getLocalFile(repoId, "a.md")).toMatchObject({ text: "old-a", baseSha: "a-old" });
  expect(await getLocalFile(repoId, "b.md")).toMatchObject({ text: "concurrent", status: "modified" });
});

test("clean pull conflicts on a concurrent edit and leaves a recovery snapshot", async () => {
  await setup();
  await putCleanLocalFile({ repoId, path: "plot.md", kind: "text", text: "old", baseSha: "old-blob", size: 3 });
  octokit.getRef.mockResolvedValue({ data: { object: { sha: "remote-head" } } });
  octokit.getCommit.mockImplementation(async ({ commit_sha }: { commit_sha: string }) => ({ data: { tree: { sha: `${commit_sha}-tree` } } }));
  octokit.getTree.mockResolvedValue({ data: { truncated: false, tree: [{ type: "blob", path: "plot.md", sha: "new-blob" }] } });
  octokit.getBlob.mockImplementation(async () => {
    await writeLocalText(repoId, "plot.md", "concurrent");
    return { data: { encoding: "base64", content: btoa("remote") } };
  });

  await expect(pullRemoteChanges({ ...target, token: "token" })).rejects.toThrow("changed while");
  expect(await getLocalFile(repoId, "plot.md")).toMatchObject({ text: "concurrent", status: "modified" });
  expect(await listLocalRecoverySnapshots(repoId, identity)).toHaveLength(0);
});

test("full sync atomically rejects a concurrent edit without applying unrelated remote writes", async () => {
  await setup();
  await putCleanLocalFile({ repoId, path: "a.md", kind: "text", text: "old-a", baseSha: "a-old", size: 5 });
  await putCleanLocalFile({ repoId, path: "b.md", kind: "text", text: "old-b", baseSha: "b-old", size: 5 });
  octokit.getRef.mockResolvedValue({ data: { object: { sha: "remote-head" } } });
  octokit.getCommit.mockImplementation(async ({ commit_sha }: { commit_sha: string }) => ({ data: { tree: { sha: `${commit_sha}-tree` } } }));
  octokit.getTree.mockResolvedValue({ data: { truncated: false, tree: [
    { type: "blob", path: "a.md", sha: "a-new" },
    { type: "blob", path: "b.md", sha: "b-new" },
  ] } });
  octokit.getBlob.mockImplementation(async ({ file_sha }: { file_sha: string }) => {
    if (file_sha === "b-new") await writeLocalText(repoId, "a.md", "concurrent");
    return { data: { encoding: "base64", content: btoa(file_sha) } };
  });

  await expect(syncFullRepository({ ...target, token: "token" })).rejects.toThrow("changed during repository sync");
  expect(await getLocalFile(repoId, "a.md")).toMatchObject({ text: "concurrent", status: "modified" });
  expect(await getLocalFile(repoId, "b.md")).toMatchObject({ text: "old-b", baseSha: "b-old" });
});

test("recovery survives working-copy removal and restores files and commits", async () => {
  await setup();
  await putCleanLocalFile({ repoId, path: "plot.md", kind: "text", text: "base", baseSha: "base", size: 4 });
  await writeLocalText(repoId, "plot.md", "recover me");
  await createLocalCommit(repoId, captureRepositoryOperationScope(), "recover commit");
  const recovery = (await import("@/repository/localRepository")).createLocalRecoverySnapshot(repoId, "test", captureRepositoryOperationScope()).then((value) => value);
  const snapshot = await recovery;
  await removeLocalRepository(repoId, captureRepositoryOperationScope());

  expect((await listLocalRecoverySnapshots(repoId, identity)).map((entry) => entry.id)).toContain(snapshot.id);
  await putLocalRepository({ ...target, defaultBranch: "main", remoteHeadSha: "replacement", clonedAt: new Date().toISOString(), cloneComplete: true }, captureRepositoryOperationScope());
  await restoreLocalRecoverySnapshot(snapshot.id, captureRepositoryOperationScope(), { ...target, repoId });
  expect(await getLocalFile(repoId, "plot.md")).toMatchObject({ text: "recover me", committed: true });
  expect((await listUnpushedLocalCommits(repoId)).map((commit) => commit.message)).toEqual(["recover commit"]);
});

test("local-source overwrite blocks and snapshots malformed paths without touching the remote ref", async () => {
  await setup();
  await putCleanLocalFile({ repoId, path: "/invalid.md", kind: "text", text: "unsafe", baseSha: "bad", size: 6 });
  await putCleanLocalFile({ repoId, path: "book.md", kind: "text", text: "book", baseSha: "book", size: 4 });
  octokit.getRef.mockResolvedValue({ data: { object: { sha: "remote-head" } } });

  await expect(overwriteRemoteWithLocal({ ...target, token: "token", confirmed: true })).rejects.toThrow("/invalid.md");
  expect(octokit.createTree).not.toHaveBeenCalled();
  expect(octokit.updateRef).not.toHaveBeenCalled();
  expect((await listLocalRecoverySnapshots(repoId, identity))[0].files.some((file) => file.path === "/invalid.md")).toBe(true);
});

test("initial clone fetches immutable blob SHAs and never the mutable branch contents API", async () => {
  octokit.getRepo.mockResolvedValue({ data: { default_branch: "main" } });
  octokit.getRef.mockResolvedValue({ data: { object: { sha: "clone-head" } } });
  octokit.getTree.mockResolvedValue({ data: { truncated: false, tree: [{ type: "blob", path: "book.md", sha: "book-blob", size: 4 }] } });
  octokit.getBlob.mockResolvedValue({ data: { encoding: "base64", content: btoa("book") } });
  const fetchMock = vi.fn();
  vi.stubGlobal("fetch", fetchMock);

  const result = await ensureLocalBookStructure({ bookId: "book", book: { id: "book", owner: "owner", repo: "repo" } as any, token: "token", accountIdentity: identity, branch: "main" });
  repoId = result.meta.id;
  expect(octokit.getBlob).toHaveBeenCalledWith(expect.objectContaining({ file_sha: "book-blob" }));
  expect(fetchMock).not.toHaveBeenCalled();
  expect(await getLocalFile(repoId, "book.md")).toMatchObject({ text: "book", baseSha: "book-blob" });
  vi.unstubAllGlobals();
});

test("local-source settlement preserves a newer same-path edit dirty and keeps recovery", async () => {
  await setup();
  await putCleanLocalFile({ repoId, path: "plot.md", kind: "text", text: "old", baseSha: "old-blob", size: 3 });
  await writeLocalText(repoId, "plot.md", "pushed");
  await createLocalCommit(repoId, captureRepositoryOperationScope(), "push local source");
  octokit.getRef.mockResolvedValue({ data: { object: { sha: "remote-head" } } });
  octokit.createBlob.mockResolvedValue({ data: { sha: "pushed-blob" } });
  octokit.createTree.mockResolvedValue({ data: { sha: "pushed-tree" } });
  octokit.createCommit.mockResolvedValue({ data: { sha: "pushed-head" } });
  octokit.updateRef.mockImplementation(async () => {
    await writeLocalText(repoId, "plot.md", "newer");
    return { data: {} };
  });

  const result = await overwriteRemoteWithLocal({ ...target, token: "token", confirmed: true });
  expect(result.recoveryPaths).toEqual(["plot.md"]);
  expect(await getLocalFile(repoId, "plot.md")).toMatchObject({ text: "newer", status: "modified", baseSha: "pushed-blob" });
  expect((await listDirtyLocalFiles(repoId)).map((file) => file.path)).toEqual(["plot.md"]);
  expect(await listUnpushedLocalCommits(repoId)).toEqual([]);
  expect(await listLocalRecoverySnapshots(repoId, identity)).toHaveLength(1);
});

test("local-source settlement preserves a newer same-path commit as pushable", async () => {
  await setup();
  await putCleanLocalFile({ repoId, path: "plot.md", kind: "text", text: "old", baseSha: "old-blob", size: 3 });
  await writeLocalText(repoId, "plot.md", "first");
  await createLocalCommit(repoId, captureRepositoryOperationScope(), "first commit");
  octokit.getRef.mockResolvedValue({ data: { object: { sha: "remote-head" } } });
  octokit.createBlob.mockResolvedValue({ data: { sha: "pushed-blob" } });
  octokit.createTree.mockResolvedValue({ data: { sha: "pushed-tree" } });
  octokit.createCommit.mockResolvedValue({ data: { sha: "pushed-head" } });
  octokit.updateRef.mockImplementation(async () => {
    await writeLocalText(repoId, "plot.md", "second");
    await createLocalCommit(repoId, captureRepositoryOperationScope(), "second commit");
    return { data: {} };
  });

  await overwriteRemoteWithLocal({ ...target, token: "token", confirmed: true });
  expect(await getLocalFile(repoId, "plot.md")).toMatchObject({ text: "second", status: "clean", committed: true, baseSha: "pushed-blob" });
  expect((await listUnpushedLocalCommits(repoId)).map((commit) => commit.message)).toEqual(["second commit"]);
});

test("local-source settlement preserves deletion of a locally new pushed path as a dirty tombstone", async () => {
  await setup();
  await writeLocalText(repoId, "new.md", "pushed content");
  octokit.getRef.mockResolvedValue({ data: { object: { sha: "remote-head" } } });
  octokit.createBlob.mockResolvedValue({ data: { sha: "pushed-blob" } });
  octokit.createTree.mockResolvedValue({ data: { sha: "pushed-tree" } });
  octokit.createCommit.mockResolvedValue({ data: { sha: "pushed-head" } });
  octokit.updateRef.mockImplementation(async () => {
    await deleteLocalFile(repoId, "new.md");
    return { data: {} };
  });

  const result = await overwriteRemoteWithLocal({ ...target, token: "token", confirmed: true });

  expect(result.recoveryPaths).toEqual(["new.md"]);
  expect(await getLocalFile(repoId, "new.md")).toBeNull();
  expect(await listDirtyLocalFiles(repoId)).toEqual([
    expect.objectContaining({ path: "new.md", status: "deleted", committed: false, baseSha: "pushed-blob" }),
  ]);
});

test("selected file restore applies nothing when a later base blob download fails", async () => {
  await setup();
  await putCleanLocalFile({ repoId, path: "a.md", kind: "text", text: "base-a", baseSha: "a-base", size: 6 });
  await putCleanLocalFile({ repoId, path: "b.md", kind: "text", text: "base-b", baseSha: "b-base", size: 6 });
  await writeLocalText(repoId, "a.md", "local-a");
  await writeLocalText(repoId, "b.md", "local-b");
  octokit.getBlob.mockImplementation(async ({ file_sha }: { file_sha: string }) => {
    if (file_sha === "b-base") throw new Error("second download failed");
    return { data: { encoding: "base64", content: btoa("base-a") } };
  });

  await expect(restoreLocalFilesToBase({ ...target, repoId, paths: ["a.md", "b.md"], token: "token" })).rejects.toThrow("second download failed");
  expect(await getLocalFile(repoId, "a.md")).toMatchObject({ text: "local-a", status: "modified" });
  expect(await getLocalFile(repoId, "b.md")).toMatchObject({ text: "local-b", status: "modified" });
});

test("reclone waits for an in-flight push and clones the pushed remote head", async () => {
  await setup();
  await putCleanLocalFile({ repoId, path: "plot.md", kind: "text", text: "base", baseSha: "base-blob", size: 4 });
  await writeLocalText(repoId, "plot.md", "pushed");
  await createLocalCommit(repoId, captureRepositoryOperationScope(), "push first");
  let remoteHead = "base-head";
  const update = gate<void>();
  octokit.getRepo.mockResolvedValue({ data: { default_branch: "main" } });
  octokit.getRef.mockImplementation(async () => ({ data: { object: { sha: remoteHead } } }));
  octokit.getCommit.mockResolvedValue({ data: { tree: { sha: "base-tree" } } });
  octokit.getTree.mockImplementation(async ({ tree_sha }: { tree_sha: string }) => ({ data: { truncated: false, tree: [{ type: "blob", path: "plot.md", sha: tree_sha === "pushed-head" ? "pushed-blob" : "base-blob", size: 6 }] } }));
  octokit.getBlob.mockResolvedValue({ data: { encoding: "base64", content: btoa("pushed") } });
  octokit.createBlob.mockResolvedValue({ data: { sha: "pushed-blob" } });
  octokit.createTree.mockResolvedValue({ data: { sha: "pushed-tree" } });
  octokit.createCommit.mockResolvedValue({ data: { sha: "pushed-head" } });
  octokit.updateRef.mockImplementation(async () => { await update.promise; remoteHead = "pushed-head"; return { data: {} }; });

  const push = pushLocalCommits({ ...target, token: "token", repoId });
  await vi.waitFor(() => expect(octokit.updateRef).toHaveBeenCalledOnce());
  const reclone = recloneLocalWorkingCopy({ bookId: "book", book: { id: "book", owner: "owner", repo: "repo" } as any, token: "token", accountIdentity: identity, branch: "main" });
  await Promise.resolve();
  expect(octokit.getRepo).not.toHaveBeenCalled();
  update.release();

  await expect(push).resolves.toMatchObject({ commitSha: "pushed-head" });
  await expect(reclone).resolves.toMatchObject({ meta: { remoteHeadSha: "pushed-head", cloneComplete: true } });
  expect(await getLocalFile(repoId, "plot.md")).toMatchObject({ text: "pushed", baseSha: "pushed-blob", status: "clean" });
});
