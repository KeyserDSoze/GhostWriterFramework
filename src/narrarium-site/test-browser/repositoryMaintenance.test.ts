import "fake-indexeddb/auto";
import { afterEach, expect, test } from "vitest";
import { claimLocalRepositoryRepair, createLocalCommit, createLocalRecoverySnapshot, deleteLocalRecoverySnapshot, getLocalFile as getScopedFile, getLocalRepositoryById, listLocalRecoverySnapshots, pauseNextPrimaryFileWriteForTests, putLocalRepository, releaseLocalRepositoryRepair, removeLocalRepository } from "@/repository/localRepository";
import { deleteLocalFile, putCleanLocalFile, writeLocalText } from "./helpers/localRepositorySeed";
import { crashNextMaintenanceRemovalForTests, createMaintenanceBackupBundle, forceRemoveRepositoryWithoutBackup, lookupRepositoryMaintenanceTarget, RepositoryMaintenanceError, validateMaintenanceBackupBundle } from "@/repository/repositoryMaintenance";
import { recloneLocalWorkingCopy, removeLocalWorkingCopy } from "@/repository/repositoryService";
import { captureRepositoryOperationScope } from "@/repository/repositoryOperationScope";
import { useAuthStore } from "@/store/authStore";
import { pauseNextRewriteWriteForTests, saveLocalRewriteOperation } from "@/repository/localRewriteOperationStore";
import type { RewriteOperationManifest } from "@/narrarium/rewriteFromReaderFeedback";

const identity = "google:maintenance-writer";
const target = { bookId: "maintenance-book", owner: "owner", repo: "maintenance-repo", branch: "main", accountIdentity: identity };
let repoId = "";

useAuthStore.setState({ user: { provider: "google", providerAccountId: "maintenance-writer", name: "Writer", email: "writer@example.com", picture: "" } });

afterEach(async () => {
  useAuthStore.setState({ user: { provider: "google", providerAccountId: "maintenance-writer", name: "Writer", email: "writer@example.com", picture: "" } });
  if (repoId) for (const recovery of await listLocalRecoverySnapshots(repoId, identity)) await deleteLocalRecoverySnapshot(recovery.id, captureRepositoryOperationScope());
  const db = await new Promise<IDBDatabase>((resolve, reject) => { const request = indexedDB.open("narrarium-local-repositories"); request.onsuccess = () => resolve(request.result); request.onerror = () => reject(request.error); });
  if (db.objectStoreNames.contains("migrationJournals")) await new Promise<void>((resolve, reject) => { const tx = db.transaction("migrationJournals", "readwrite"); tx.objectStore("migrationJournals").delete("failed"); tx.oncomplete = () => resolve(); tx.onerror = () => reject(tx.error); });
  if (db.objectStoreNames.contains("removalJournals")) await new Promise<void>((resolve, reject) => { const tx = db.transaction("removalJournals", "readwrite"); tx.objectStore("removalJournals").clear(); tx.oncomplete = () => resolve(); tx.onerror = () => reject(tx.error); });
  if (db.objectStoreNames.contains("maintenanceTombstones")) await new Promise<void>((resolve, reject) => { const tx = db.transaction("maintenanceTombstones", "readwrite"); tx.objectStore("maintenanceTombstones").clear(); tx.oncomplete = () => resolve(); tx.onerror = () => reject(tx.error); });
  if (db.objectStoreNames.contains("consumedBackupReceipts")) await new Promise<void>((resolve, reject) => { const tx = db.transaction("consumedBackupReceipts", "readwrite"); tx.objectStore("consumedBackupReceipts").clear(); tx.oncomplete = () => resolve(); tx.onerror = () => reject(tx.error); });
  if (db.objectStoreNames.contains("recoveries")) await new Promise<void>((resolve, reject) => { const tx = db.transaction("recoveries", "readwrite"); tx.objectStore("recoveries").clear(); tx.oncomplete = () => resolve(); tx.onerror = () => reject(tx.error); });
  if (db.objectStoreNames.contains("maintenanceCompletions")) await new Promise<void>((resolve, reject) => { const tx = db.transaction("maintenanceCompletions", "readwrite"); tx.objectStore("maintenanceCompletions").clear(); tx.oncomplete = () => resolve(); tx.onerror = () => reject(tx.error); });
  db.close();
  if (repoId && await getLocalRepositoryById(repoId, identity)) await removeLocalRepository(repoId, captureRepositoryOperationScope());
  const rewriteDb = await new Promise<IDBDatabase>((resolve, reject) => { const request = indexedDB.open("narrarium-local-rewrite-operations"); request.onsuccess = () => resolve(request.result); request.onerror = () => reject(request.error); });
  if (rewriteDb.objectStoreNames.contains("rewriteOperationsV3")) await new Promise<void>((resolve, reject) => { const tx = rewriteDb.transaction("rewriteOperationsV3", "readwrite"); tx.objectStore("rewriteOperationsV3").clear(); tx.oncomplete = () => resolve(); tx.onerror = () => reject(tx.error); });
  if (rewriteDb.objectStoreNames.contains("maintenanceTombstones")) await new Promise<void>((resolve, reject) => { const tx = rewriteDb.transaction("maintenanceTombstones", "readwrite"); tx.objectStore("maintenanceTombstones").clear(); tx.oncomplete = () => resolve(); tx.onerror = () => reject(tx.error); });
  if (rewriteDb.objectStoreNames.contains("maintenanceCompletions")) await new Promise<void>((resolve, reject) => { const tx = rewriteDb.transaction("maintenanceCompletions", "readwrite"); tx.objectStore("maintenanceCompletions").clear(); tx.oncomplete = () => resolve(); tx.onerror = () => reject(tx.error); });
  rewriteDb.close();
  repoId = "";
});

async function setup(cloneComplete: boolean | undefined, cloneStatus?: "cloning" | "migrating" | "repair-required" | "repairing" | "complete") {
  const meta = await putLocalRepository({ ...target, defaultBranch: "main", remoteHeadSha: "head", clonedAt: new Date().toISOString(), cloneComplete, cloneStatus }, captureRepositoryOperationScope());
  repoId = meta.id;
  return meta;
}

function rewrite(localInstanceId: string): RewriteOperationManifest {
  const now = new Date().toISOString();
  return { schemaVersion: 1, operationId: crypto.randomUUID(), operation: "rewriteFromReaderFeedback", scope: "chapter", bookId: target.bookId, chapterId: "001", paragraphIds: [], startedAt: now, completedAt: null, status: "preparing", createdAt: now, updatedAt: now, repoId, localInstanceId, owner: target.owner, repo: target.repo, branch: target.branch, chapterSlug: "001", targetIds: [], feedbackMode: "panel-summary", feedbackPath: "evaluations/summary.md", feedbackSummaryPath: "evaluations/summary.md", feedbackSourceHash: "hash", staleFeedback: false, progress: { completed: 0, total: 0 }, modifiedFiles: [], generationRuns: [], aggregateInputTokens: 0, aggregateCachedInputTokens: 0, aggregateOutputTokens: 0, aggregateCost: 0, conflicts: [] };
}

for (const [cloneComplete, cloneStatus, expected] of [
  [true, "complete", "complete"],
  [false, "cloning", "cloning"],
  [false, "repair-required", "repair-required"],
  [false, "repairing", "repairing"],
  [undefined, "migrating", "migrating"],
  [undefined, undefined, "legacy-unverified"],
] as const) {
  test(`maintenance lookup exposes ${expected}`, async () => {
    await setup(cloneComplete, cloneStatus);
    await expect(lookupRepositoryMaintenanceTarget(target)).resolves.toMatchObject({ lifecycle: expected, repository: { id: repoId } });
  });
}

test("maintenance removal accepts a clean incomplete copy", async () => {
  await setup(false, "repair-required");
  const { receipt } = await createMaintenanceBackupBundle(target);
  await expect(removeLocalWorkingCopy({ ...target, backupReceiptId: receipt.receiptId, confirmation: "REMOVE owner/maintenance-repo" })).resolves.toEqual({ recoveriesPreserved: 0, rewriteOperationsRemoved: 0 });
  expect(await getLocalRepositoryById(repoId, identity)).toBeNull();
  repoId = "";
});

test("maintenance removal requires backup and typed confirmation for user work and preserves recoveries", async () => {
  await setup(false, "repair-required");
  await writeLocalText(repoId, "drafts/work.md", "work");
  await createLocalCommit(repoId, captureRepositoryOperationScope(), "work");
  await createLocalRecoverySnapshot(repoId, "safety", captureRepositoryOperationScope());
  await expect(removeLocalWorkingCopy({ ...target, backupReceiptId: "", confirmation: "REMOVE owner/maintenance-repo" })).rejects.toMatchObject({ code: "BACKUP_REQUIRED" });
  const { receipt } = await createMaintenanceBackupBundle(target);
  await expect(removeLocalWorkingCopy({ ...target, backupReceiptId: receipt.receiptId, confirmation: "wrong" })).rejects.toMatchObject({ code: "CONFIRMATION_REQUIRED" });
  await expect(removeLocalWorkingCopy({ ...target, backupReceiptId: receipt.receiptId, confirmation: "REMOVE owner/maintenance-repo" })).resolves.toMatchObject({ recoveriesPreserved: 1 });
  repoId = "";
});

test("maintenance lookup rejects the wrong account", async () => {
  await setup(true, "complete");
  useAuthStore.setState({ user: { provider: "google", providerAccountId: "other", name: "Other", email: "other@example.com", picture: "" } });
  await expect(lookupRepositoryMaintenanceTarget(target)).rejects.toBeInstanceOf(RepositoryMaintenanceError);
});

test("maintenance lookup exposes an interrupted migration journal", async () => {
  await setup(undefined, "migrating");
  const db = await new Promise<IDBDatabase>((resolve, reject) => {
    const request = indexedDB.open("narrarium-local-repositories");
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
  await new Promise<void>((resolve, reject) => {
    const tx = db.transaction("migrationJournals", "readwrite");
    tx.objectStore("migrationJournals").put({ id: "failed", oldRepoId: "legacy", newRepoId: repoId, ...target, immutableAccountIdentity: identity, phase: "prepared", createdAt: new Date().toISOString() });
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
  });
  db.close();
  await expect(lookupRepositoryMaintenanceTarget(target)).resolves.toMatchObject({ lifecycle: "journal-failed" });
});

test("removal fences an active lifecycle owner so it cannot settle", async () => {
  const meta = await setup(false, "repair-required");
  const operationId = crypto.randomUUID();
  await claimLocalRepositoryRepair(meta.id, captureRepositoryOperationScope(), operationId);
  const { receipt } = await createMaintenanceBackupBundle(target);
  await removeLocalWorkingCopy({ ...target, backupReceiptId: receipt.receiptId, confirmation: "REMOVE owner/maintenance-repo" });
  await expect(releaseLocalRepositoryRepair(meta.id, captureRepositoryOperationScope(), operationId)).rejects.toMatchObject({ code: "REPOSITORY_OWNERSHIP_CHANGED" });
  repoId = "";
});

test("backup bundle roundtrips every canonical maintenance record and content reference", async () => {
  const meta = await setup(true, "complete");
  await putCleanLocalFile({ repoId, path: "chapters/a.md", kind: "text", text: "chapter", baseSha: "sha", size: 7 });
  await putCleanLocalFile({ repoId, path: "deleted.md", kind: "text", text: "deleted body", baseSha: "deleted-sha", size: 12 });
  await deleteLocalFile(repoId, "deleted.md");
  await writeLocalText(repoId, "drafts/work.md", "draft");
  await createLocalCommit(repoId, captureRepositoryOperationScope(), "draft commit");
  await createLocalRecoverySnapshot(repoId, "complete recovery", captureRepositoryOperationScope());
  await saveLocalRewriteOperation(rewrite(meta.localInstanceId), captureRepositoryOperationScope());
  const { blob, manifest } = await createMaintenanceBackupBundle(target);
  const restored = await validateMaintenanceBackupBundle(blob);
  expect(restored).toEqual(manifest);
  expect(restored.files.find((file) => file.path === "deleted.md")?.contentPath).toBeTruthy();
  expect(restored).toMatchObject({ counts: { files: 3, commits: 1, recoveries: 1, rewrites: 1 }, restoreContract: { validation: "snapshotDigest" } });
  expect(JSON.stringify(restored)).not.toContain(identity);
});

test("a post-backup file edit invalidates the receipt", async () => {
  await setup(true, "complete");
  const { receipt } = await createMaintenanceBackupBundle(target);
  await writeLocalText(repoId, "new.md", "changed");
  await expect(removeLocalWorkingCopy({ ...target, backupReceiptId: receipt.receiptId, confirmation: "REMOVE owner/maintenance-repo" })).rejects.toMatchObject({ code: "BACKUP_STALE" });
});

test("a post-backup commit invalidates the receipt", async () => {
  await setup(true, "complete");
  await writeLocalText(repoId, "new.md", "changed");
  const { receipt } = await createMaintenanceBackupBundle(target);
  await createLocalCommit(repoId, captureRepositoryOperationScope(), "new commit");
  await expect(removeLocalWorkingCopy({ ...target, backupReceiptId: receipt.receiptId, confirmation: "REMOVE owner/maintenance-repo" })).rejects.toMatchObject({ code: "BACKUP_STALE" });
});

test("a post-backup recovery invalidates the receipt", async () => {
  await setup(true, "complete");
  const { receipt } = await createMaintenanceBackupBundle(target);
  await createLocalRecoverySnapshot(repoId, "later", captureRepositoryOperationScope());
  await expect(removeLocalWorkingCopy({ ...target, backupReceiptId: receipt.receiptId, confirmation: "REMOVE owner/maintenance-repo" })).rejects.toMatchObject({ code: "BACKUP_STALE" });
});

test("a post-backup rewrite invalidates the receipt", async () => {
  const meta = await setup(true, "complete");
  const { receipt } = await createMaintenanceBackupBundle(target);
  await saveLocalRewriteOperation(rewrite(meta.localInstanceId), captureRepositoryOperationScope());
  await expect(removeLocalWorkingCopy({ ...target, backupReceiptId: receipt.receiptId, confirmation: "REMOVE owner/maintenance-repo" })).rejects.toMatchObject({ code: "BACKUP_STALE" });
});

for (const phase of ["after-prepare", "after-rewrites", "after-primary"] as const) {
  test(`removal resumes idempotently after ${phase}`, async () => {
    await setup(true, "complete");
    const { receipt } = await createMaintenanceBackupBundle(target);
    crashNextMaintenanceRemovalForTests(phase);
    await expect(removeLocalWorkingCopy({ ...target, backupReceiptId: receipt.receiptId, confirmation: "REMOVE owner/maintenance-repo" })).rejects.toThrow("Simulated");
    await expect(removeLocalWorkingCopy({ ...target, backupReceiptId: receipt.receiptId, confirmation: "REMOVE owner/maintenance-repo" })).resolves.toMatchObject({ recoveriesPreserved: 0 });
    expect(await getLocalRepositoryById(repoId, identity)).toBeNull();
    repoId = "";
  });
}

test("a rewrite writer is blocked as soon as removal preparation is journaled", async () => {
  const meta = await setup(true, "complete");
  const operation = rewrite(meta.localInstanceId);
  const { receipt } = await createMaintenanceBackupBundle(target);
  crashNextMaintenanceRemovalForTests("after-prepare");
  await expect(removeLocalWorkingCopy({ ...target, backupReceiptId: receipt.receiptId, confirmation: "REMOVE owner/maintenance-repo" })).rejects.toThrow("Simulated");
  await expect(saveLocalRewriteOperation(operation, captureRepositoryOperationScope())).rejects.toMatchObject({ code: "REPOSITORY_OWNERSHIP_CHANGED" });
  await removeLocalWorkingCopy({ ...target, backupReceiptId: receipt.receiptId, confirmation: "REMOVE owner/maintenance-repo" });
  repoId = "";
});

test("a same-coordinate replacement cannot be deleted by a stale removal journal", async () => {
  const original = await setup(true, "complete");
  const { receipt } = await createMaintenanceBackupBundle(target);
  crashNextMaintenanceRemovalForTests("after-rewrites");
  await expect(removeLocalWorkingCopy({ ...target, backupReceiptId: receipt.receiptId, confirmation: "REMOVE owner/maintenance-repo" })).rejects.toThrow("Simulated");
  const db = await new Promise<IDBDatabase>((resolve, reject) => { const request = indexedDB.open("narrarium-local-repositories"); request.onsuccess = () => resolve(request.result); request.onerror = () => reject(request.error); });
  const replacementId = crypto.randomUUID();
  await new Promise<void>((resolve, reject) => {
    const tx = db.transaction("repositories", "readwrite");
    tx.objectStore("repositories").put({ ...original, localInstanceId: replacementId, operationFence: (original.operationFence ?? 0) + 2, updatedAt: new Date().toISOString() });
    tx.oncomplete = () => resolve(); tx.onerror = () => reject(tx.error);
  });
  db.close();
  await expect(removeLocalWorkingCopy({ ...target, backupReceiptId: receipt.receiptId, confirmation: "REMOVE owner/maintenance-repo" })).rejects.toMatchObject({ code: "REPOSITORY_OWNERSHIP_CHANGED" });
  expect(await getLocalRepositoryById(repoId, identity)).toMatchObject({ localInstanceId: replacementId });
});

test("maintenance lookup exposes a pending removal after primary deletion", async () => {
  await setup(true, "complete");
  const { receipt } = await createMaintenanceBackupBundle(target);
  crashNextMaintenanceRemovalForTests("after-primary");
  await expect(removeLocalWorkingCopy({ ...target, backupReceiptId: receipt.receiptId, confirmation: "REMOVE owner/maintenance-repo" })).rejects.toThrow("Simulated");
  await expect(lookupRepositoryMaintenanceTarget(target)).resolves.toMatchObject({ repository: null, lifecycle: "journal-failed", removalPending: true });
  await removeLocalWorkingCopy({ ...target, backupReceiptId: "", confirmation: "REMOVE owner/maintenance-repo" });
  repoId = "";
});

test("a primary file write paused before its transaction cannot cross the primary tombstone gap", async () => {
  await setup(true, "complete");
  const { receipt } = await createMaintenanceBackupBundle(target);
  const pause = pauseNextPrimaryFileWriteForTests();
  const write = writeLocalText(repoId, "late.md", "late");
  await pause.entered;
  await removeLocalWorkingCopy({ ...target, backupReceiptId: receipt.receiptId, confirmation: "REMOVE owner/maintenance-repo" });
  pause.release();
  await expect(write).rejects.toMatchObject({ code: "REPOSITORY_OWNERSHIP_CHANGED" });
  repoId = "";
});

test("a rewrite paused before its transaction cannot cross the rewrite tombstone gap", async () => {
  const meta = await setup(true, "complete");
  const { receipt } = await createMaintenanceBackupBundle(target);
  const pause = pauseNextRewriteWriteForTests();
  const write = saveLocalRewriteOperation(rewrite(meta.localInstanceId), captureRepositoryOperationScope());
  await pause.entered;
  await removeLocalWorkingCopy({ ...target, backupReceiptId: receipt.receiptId, confirmation: "REMOVE owner/maintenance-repo" });
  pause.release();
  await expect(write).rejects.toMatchObject({ code: "REPOSITORY_OWNERSHIP_CHANGED" });
  repoId = "";
});

test("a rewrite that passed its precheck and lands after primary fencing cancels removal", async () => {
  const meta = await setup(true, "complete");
  const { receipt } = await createMaintenanceBackupBundle(target);
  const pause = pauseNextRewriteWriteForTests();
  const write = saveLocalRewriteOperation(rewrite(meta.localInstanceId), captureRepositoryOperationScope());
  await pause.entered;
  crashNextMaintenanceRemovalForTests("after-prepare");
  await expect(removeLocalWorkingCopy({ ...target, backupReceiptId: receipt.receiptId, confirmation: "REMOVE owner/maintenance-repo" })).rejects.toThrow("Simulated");
  pause.release();
  await expect(write).resolves.toBeUndefined();
  await expect(removeLocalWorkingCopy({ ...target, backupReceiptId: receipt.receiptId, confirmation: "REMOVE owner/maintenance-repo" })).rejects.toMatchObject({ code: "BACKUP_STALE" });
  expect(await getLocalRepositoryById(repoId, identity)).toMatchObject({ localInstanceId: meta.localInstanceId });
});

test("a rewrite landing before rewrite fencing cancels removal rather than deleting unbacked work", async () => {
  const meta = await setup(true, "complete");
  const { receipt } = await createMaintenanceBackupBundle(target);
  await saveLocalRewriteOperation(rewrite(meta.localInstanceId), captureRepositoryOperationScope());
  await expect(removeLocalWorkingCopy({ ...target, backupReceiptId: receipt.receiptId, confirmation: "REMOVE owner/maintenance-repo" })).rejects.toMatchObject({ code: "BACKUP_STALE" });
  expect(await getLocalRepositoryById(repoId, identity)).toMatchObject({ localInstanceId: meta.localInstanceId });
});

test("crash before rewrite transaction restores repository without losing rewrites", async () => {
  const meta = await setup(true, "complete");
  const operation = rewrite(meta.localInstanceId);
  await saveLocalRewriteOperation(operation, captureRepositoryOperationScope());
  const { receipt } = await createMaintenanceBackupBundle(target);
  crashNextMaintenanceRemovalForTests("before-rewrite-transaction");
  await expect(removeLocalWorkingCopy({ ...target, backupReceiptId: receipt.receiptId, confirmation: "REMOVE owner/maintenance-repo" })).rejects.toThrow("Simulated");
  const db = await new Promise<IDBDatabase>((resolve, reject) => { const request = indexedDB.open("narrarium-local-rewrite-operations"); request.onsuccess = () => resolve(request.result); request.onerror = () => reject(request.error); });
  const rows = await new Promise<Array<{ operationId: string }>>((resolve, reject) => { const tx = db.transaction("rewriteOperationsV3", "readonly"); const request = tx.objectStore("rewriteOperationsV3").getAll(); request.onsuccess = () => resolve(request.result); request.onerror = () => reject(request.error); });
  db.close();
  expect(rows.some((row) => row.operationId === operation.operationId)).toBe(true);
  await expect(getLocalRepositoryById(repoId, identity)).resolves.toMatchObject({ localInstanceId: meta.localInstanceId });
});

for (const phase of ["after-rewrite-marker", "after-rewrite-phase-update"] as const) {
  test(`removal resumes from immutable rewrite marker after ${phase}`, async () => {
    const meta = await setup(true, "complete");
    await saveLocalRewriteOperation(rewrite(meta.localInstanceId), captureRepositoryOperationScope());
    const { receipt } = await createMaintenanceBackupBundle(target);
    crashNextMaintenanceRemovalForTests(phase);
    await expect(removeLocalWorkingCopy({ ...target, backupReceiptId: receipt.receiptId, confirmation: "REMOVE owner/maintenance-repo" })).rejects.toThrow("Simulated");
    await expect(removeLocalWorkingCopy({ ...target, backupReceiptId: receipt.receiptId, confirmation: "REMOVE owner/maintenance-repo" })).resolves.toMatchObject({ rewriteOperationsRemoved: 1 });
    repoId = "";
  });
}

test("missing rewrite completion marker fails closed without restoring the repository", async () => {
  const meta = await setup(true, "complete");
  await saveLocalRewriteOperation(rewrite(meta.localInstanceId), captureRepositoryOperationScope());
  const { receipt } = await createMaintenanceBackupBundle(target);
  crashNextMaintenanceRemovalForTests("after-rewrite-marker");
  await expect(removeLocalWorkingCopy({ ...target, backupReceiptId: receipt.receiptId, confirmation: "REMOVE owner/maintenance-repo" })).rejects.toThrow("Simulated");
  const db = await new Promise<IDBDatabase>((resolve, reject) => { const request = indexedDB.open("narrarium-local-rewrite-operations"); request.onsuccess = () => resolve(request.result); request.onerror = () => reject(request.error); });
  await new Promise<void>((resolve, reject) => { const tx = db.transaction("maintenanceCompletions", "readwrite"); tx.objectStore("maintenanceCompletions").clear(); tx.oncomplete = () => resolve(); tx.onerror = () => reject(tx.error); });
  db.close();
  await expect(removeLocalWorkingCopy({ ...target, backupReceiptId: receipt.receiptId, confirmation: "REMOVE owner/maintenance-repo" })).rejects.toThrow("REWRITE_MAINTENANCE_EVIDENCE_INVALID");
  await expect(getLocalRepositoryById(repoId, identity)).resolves.toMatchObject({ localInstanceId: meta.localInstanceId, operationFence: expect.any(Number) });
});

test("unexpected rewrite row after completion marker fails closed", async () => {
  const meta = await setup(true, "complete");
  const operation = rewrite(meta.localInstanceId);
  await saveLocalRewriteOperation(operation, captureRepositoryOperationScope());
  const { receipt } = await createMaintenanceBackupBundle(target);
  crashNextMaintenanceRemovalForTests("after-rewrite-marker");
  await expect(removeLocalWorkingCopy({ ...target, backupReceiptId: receipt.receiptId, confirmation: "REMOVE owner/maintenance-repo" })).rejects.toThrow("Simulated");
  const db = await new Promise<IDBDatabase>((resolve, reject) => { const request = indexedDB.open("narrarium-local-rewrite-operations"); request.onsuccess = () => resolve(request.result); request.onerror = () => reject(request.error); });
  await new Promise<void>((resolve, reject) => { const tx = db.transaction("rewriteOperationsV3", "readwrite"); tx.objectStore("rewriteOperationsV3").put({ ...operation, storageId: `${encodeURIComponent(repoId)}::${operation.operationId}`, accountIdentity: identity, repoKey: "owner/maintenance-repo#main", targetKey: "chapter:001" }); tx.oncomplete = () => resolve(); tx.onerror = () => reject(tx.error); });
  db.close();
  await expect(removeLocalWorkingCopy({ ...target, backupReceiptId: receipt.receiptId, confirmation: "REMOVE owner/maintenance-repo" })).rejects.toThrow("REWRITE_MAINTENANCE_EVIDENCE_INVALID");
});

test("successful finalization clears active rewrite tombstone and retains the primary completion marker", async () => {
  const meta = await setup(true, "complete");
  await saveLocalRewriteOperation(rewrite(meta.localInstanceId), captureRepositoryOperationScope());
  const { receipt } = await createMaintenanceBackupBundle(target);
  await removeLocalWorkingCopy({ ...target, backupReceiptId: receipt.receiptId, confirmation: "REMOVE owner/maintenance-repo" });
  const db = await new Promise<IDBDatabase>((resolve, reject) => { const request = indexedDB.open("narrarium-local-rewrite-operations"); request.onsuccess = () => resolve(request.result); request.onerror = () => reject(request.error); });
  const state = await new Promise<{ tombstones: unknown[]; completions: unknown[] }>((resolve, reject) => { const tx = db.transaction(["maintenanceTombstones", "maintenanceCompletions"], "readonly"); const tombstones = tx.objectStore("maintenanceTombstones").getAll(); const completions = tx.objectStore("maintenanceCompletions").getAll(); tx.oncomplete = () => resolve({ tombstones: tombstones.result, completions: completions.result }); tx.onerror = () => reject(tx.error); });
  db.close();
  expect(state.tombstones).toHaveLength(0);
  expect(state.completions).toHaveLength(1);
  repoId = "";
});

test("crash after rewrite finalization resumes primary and journal cleanup from durable completion", async () => {
  const meta = await setup(true, "complete");
  await saveLocalRewriteOperation(rewrite(meta.localInstanceId), captureRepositoryOperationScope());
  const { receipt } = await createMaintenanceBackupBundle(target);
  crashNextMaintenanceRemovalForTests("after-rewrite-finalize");
  await expect(removeLocalWorkingCopy({ ...target, backupReceiptId: receipt.receiptId, confirmation: "REMOVE owner/maintenance-repo" })).rejects.toThrow("Simulated");
  await expect(lookupRepositoryMaintenanceTarget(target)).resolves.toMatchObject({ repository: null, removalPending: true });
  await expect(removeLocalWorkingCopy({ ...target, backupReceiptId: "", confirmation: "REMOVE owner/maintenance-repo" })).resolves.toMatchObject({ rewriteOperationsRemoved: 1 });
  await expect(lookupRepositoryMaintenanceTarget(target)).resolves.toMatchObject({ repository: null, removalPending: false });
  repoId = "";
});

test("crash after final cleanup replays from the exact completion marker without a backup", async () => {
  await setup(true, "complete");
  const { receipt } = await createMaintenanceBackupBundle(target);
  crashNextMaintenanceRemovalForTests("after-final-cleanup");
  await expect(removeLocalWorkingCopy({ ...target, backupReceiptId: receipt.receiptId, confirmation: "REMOVE owner/maintenance-repo" })).rejects.toThrow("Simulated");
  await expect(removeLocalWorkingCopy({ ...target, backupReceiptId: "", confirmation: "REMOVE owner/maintenance-repo" })).resolves.toMatchObject({ rewriteOperationsRemoved: 0 });
  await expect(removeLocalWorkingCopy({ ...target, backupReceiptId: "", confirmation: "REMOVE owner/maintenance-repo" })).rejects.toMatchObject({ code: "BACKUP_REQUIRED" });
  repoId = "";
});

test("crash after final cleanup preserves exact recovery evidence and resumes without a backup", async () => {
  await setup(true, "complete");
  await writeLocalText(repoId, "drafts/preserved.md", "preserved");
  await createLocalCommit(repoId, captureRepositoryOperationScope(), "preserved work");
  const recovery = await createLocalRecoverySnapshot(repoId, "preserve me", captureRepositoryOperationScope());
  const { receipt } = await createMaintenanceBackupBundle(target);
  crashNextMaintenanceRemovalForTests("after-final-cleanup");
  await expect(removeLocalWorkingCopy({ ...target, backupReceiptId: receipt.receiptId, confirmation: "REMOVE owner/maintenance-repo" })).rejects.toThrow("Simulated");
  await expect(lookupRepositoryMaintenanceTarget(target)).resolves.toMatchObject({ repository: null, removalPending: true, recoveries: [expect.objectContaining({ id: recovery.id })] });
  await expect(removeLocalWorkingCopy({ ...target, backupReceiptId: "", confirmation: "REMOVE owner/maintenance-repo" })).resolves.toMatchObject({ recoveriesPreserved: 1 });
  await expect(lookupRepositoryMaintenanceTarget(target)).resolves.toMatchObject({ repository: null, removalPending: false, recoveries: [expect.objectContaining({ id: recovery.id })] });
  repoId = "";
});

for (const mutation of ["missing", "extra", "foreign"] as const) {
  test(`replay rejects a ${mutation} preserved recovery row`, async () => {
    await setup(true, "complete");
    await writeLocalText(repoId, "drafts/preserved.md", "preserved");
    await createLocalCommit(repoId, captureRepositoryOperationScope(), "preserved work");
    const recovery = await createLocalRecoverySnapshot(repoId, "preserve me", captureRepositoryOperationScope());
    const { receipt } = await createMaintenanceBackupBundle(target);
    crashNextMaintenanceRemovalForTests("after-final-cleanup");
    await expect(removeLocalWorkingCopy({ ...target, backupReceiptId: receipt.receiptId, confirmation: "REMOVE owner/maintenance-repo" })).rejects.toThrow("Simulated");
    const db = await new Promise<IDBDatabase>((resolve, reject) => { const request = indexedDB.open("narrarium-local-repositories"); request.onsuccess = () => resolve(request.result); request.onerror = () => reject(request.error); });
    await new Promise<void>((resolve, reject) => {
      const tx = db.transaction("recoveries", "readwrite");
      if (mutation === "missing") tx.objectStore("recoveries").delete(recovery.id);
      if (mutation === "foreign") tx.objectStore("recoveries").put({ ...recovery, accountIdentity: "google:foreign", repository: { ...recovery.repository, accountScope: "google:foreign" } });
      if (mutation === "extra") tx.objectStore("recoveries").put({ ...recovery, id: crypto.randomUUID() });
      tx.oncomplete = () => resolve(); tx.onerror = () => reject(tx.error);
    });
    db.close();
    await expect(removeLocalWorkingCopy({ ...target, backupReceiptId: "", confirmation: "REMOVE owner/maintenance-repo" })).rejects.toMatchObject({ code: "BACKUP_STALE" });
    repoId = "";
  });
}

for (const phase of ["after-primary-marker", "after-finalized"] as const) {
  test(`removal converges after ${phase} with rewrites and preserved recovery`, async () => {
    const meta = await setup(true, "complete");
    await saveLocalRewriteOperation(rewrite(meta.localInstanceId), captureRepositoryOperationScope());
    await writeLocalText(repoId, "drafts/preserved.md", "preserved");
    await createLocalCommit(repoId, captureRepositoryOperationScope(), "preserved work");
    await createLocalRecoverySnapshot(repoId, "preserve me", captureRepositoryOperationScope());
    const { receipt } = await createMaintenanceBackupBundle(target);
    crashNextMaintenanceRemovalForTests(phase);
    await expect(removeLocalWorkingCopy({ ...target, backupReceiptId: receipt.receiptId, confirmation: "REMOVE owner/maintenance-repo" })).rejects.toThrow("Simulated");
    await expect(removeLocalWorkingCopy({ ...target, backupReceiptId: "", confirmation: "REMOVE owner/maintenance-repo" })).resolves.toMatchObject({ recoveriesPreserved: 1, rewriteOperationsRemoved: 1 });
    await expect(lookupRepositoryMaintenanceTarget(target)).resolves.toMatchObject({ repository: null, removalPending: false, recoveries: [expect.anything()] });
    repoId = "";
  });
}

test("foreign removal completion marker fails closed", async () => {
  await setup(true, "complete");
  const db = await new Promise<IDBDatabase>((resolve, reject) => { const request = indexedDB.open("narrarium-local-repositories"); request.onsuccess = () => resolve(request.result); request.onerror = () => reject(request.error); });
  await new Promise<void>((resolve, reject) => { const tx = db.transaction("maintenanceCompletions", "readwrite"); tx.objectStore("maintenanceCompletions").put({ repoId, journalId: crypto.randomUUID(), localInstanceId: crypto.randomUUID(), accountIdentity: "google:foreign", bookId: target.bookId, owner: target.owner, repo: target.repo, branch: target.branch, receiptId: "foreign", snapshotDigest: "snapshot", primaryDigest: "primary", rewriteDigest: "rewrite", rewriteCount: 0, rewriteRecords: [], recoveriesPreserved: 0, completedAt: new Date().toISOString() }); tx.oncomplete = () => resolve(); tx.onerror = () => reject(tx.error); });
  db.close();
  await expect(removeLocalWorkingCopy({ ...target, backupReceiptId: "", confirmation: "REMOVE owner/maintenance-repo" })).rejects.toMatchObject({ code: "TARGET_MISMATCH" });
  expect(await getLocalRepositoryById(repoId, identity)).toBeTruthy();
});

test("reclone rejects a pending removal even after the repository row is gone", async () => {
  await setup(true, "complete");
  const { receipt } = await createMaintenanceBackupBundle(target);
  crashNextMaintenanceRemovalForTests("after-primary");
  await expect(removeLocalWorkingCopy({ ...target, backupReceiptId: receipt.receiptId, confirmation: "REMOVE owner/maintenance-repo" })).rejects.toThrow("Simulated");
  await expect(recloneLocalWorkingCopy({ bookId: target.bookId, book: { id: target.bookId, owner: target.owner, repo: target.repo } as never, token: "token", accountIdentity: identity, branch: target.branch })).rejects.toMatchObject({ code: "REMOVAL_PENDING" });
  await removeLocalWorkingCopy({ ...target, backupReceiptId: "", confirmation: "REMOVE owner/maintenance-repo" });
  repoId = "";
});

test("force removal requires the exact typed target and immutable account", async () => {
  await setup(true, "complete");
  await expect(forceRemoveRepositoryWithoutBackup(target, "FORCE RECLONE owner/other#main")).rejects.toMatchObject({ code: "CONFIRMATION_REQUIRED" });
  useAuthStore.setState({ user: { provider: "google", providerAccountId: "other", name: "Other", email: "other@example.com", picture: "" } });
  await expect(forceRemoveRepositoryWithoutBackup(target, "FORCE RECLONE owner/maintenance-repo#main")).rejects.toMatchObject({ code: "ACCOUNT_MISMATCH" });
  useAuthStore.setState({ user: { provider: "google", providerAccountId: "maintenance-writer", name: "Writer", email: "writer@example.com", picture: "" } });
  expect(await getLocalRepositoryById(repoId, identity)).toBeTruthy();
});

test("force removal deletes primary, recovery, and rewrite state without touching a remote", async () => {
  const meta = await setup(true, "complete");
  await writeLocalText(repoId, "drafts/unrecoverable.md", "discard me");
  await createLocalCommit(repoId, captureRepositoryOperationScope(), "discard local work");
  await createLocalRecoverySnapshot(repoId, "discard recovery", captureRepositoryOperationScope());
  await saveLocalRewriteOperation(rewrite(meta.localInstanceId), captureRepositoryOperationScope());
  await expect(forceRemoveRepositoryWithoutBackup(target, "FORCE RECLONE owner/maintenance-repo#main")).resolves.toEqual({ recoveriesPreserved: 0, rewriteOperationsRemoved: 1 });
  expect(await getLocalRepositoryById(repoId, identity)).toBeNull();
  expect(await listLocalRecoverySnapshots(repoId, identity)).toEqual([]);
  repoId = "";
});

for (const phase of ["after-prepare", "before-rewrite-transaction", "after-rewrite-marker", "after-rewrite-phase-update", "after-rewrites", "after-primary", "after-primary-marker", "after-rewrite-finalize", "after-final-cleanup", "after-finalized"] as const) {
  test(`force removal resumes safely after ${phase}`, async () => {
    const meta = await setup(true, "complete");
    await saveLocalRewriteOperation(rewrite(meta.localInstanceId), captureRepositoryOperationScope());
    crashNextMaintenanceRemovalForTests(phase);
    await expect(forceRemoveRepositoryWithoutBackup(target, "FORCE RECLONE owner/maintenance-repo#main")).rejects.toThrow("Simulated");
    await expect(forceRemoveRepositoryWithoutBackup(target, "FORCE RECLONE owner/maintenance-repo#main")).resolves.toMatchObject({ recoveriesPreserved: 0, rewriteOperationsRemoved: 1 });
    expect(await getLocalRepositoryById(repoId, identity)).toBeNull();
    repoId = "";
  });
}
