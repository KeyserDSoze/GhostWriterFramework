import { describe, expect, it } from "vitest";
import "fake-indexeddb/auto";
import { useAuthStore } from "@/store/authStore";
import { useSettingsStore } from "@/store/settingsStore";
import { localWorkspaceScope } from "@/account/deviceIdentity";
import { captureRepositoryOperationScope } from "@/repository/repositoryOperationScope";
import { createLocalRecoverySnapshot, getLocalRecoverySnapshot, getLocalRepositoryById, migrateCurrentProviderRepositoriesToWorkspace, putLocalRepository, writeLocalText } from "@/repository/localRepository";
import { saveLocalRewriteOperation } from "@/repository/localRewriteOperationStore";
import type { RewriteOperationManifest } from "@/narrarium/rewriteFromReaderFeedback";

describe("provider-scoped working copy migration", () => {
  it("adopts repository and recovery ownership in place without changing IDs", async () => {
    const user = { provider: "google" as const, providerAccountId: `sub-${crypto.randomUUID()}`, name: "Writer", email: "writer@example.test", picture: "" };
    useAuthStore.setState({ user });
    useSettingsStore.setState({ accountIdentity: `google:${user.providerAccountId}`, accountGeneration: 41 });
    const legacyScope = captureRepositoryOperationScope();
    const repository = await putLocalRepository({ bookId: crypto.randomUUID(), owner: "writer", repo: crypto.randomUUID(), branch: "main", defaultBranch: "main", remoteHeadSha: "head", clonedAt: new Date().toISOString(), cloneComplete: true }, legacyScope);
    await writeLocalText(repository.id, "book.md", "local work", legacyScope);
    const recovery = await createLocalRecoverySnapshot(repository.id, "before workspace migration", legacyScope);

    useSettingsStore.setState({ accountIdentity: localWorkspaceScope(), accountGeneration: 41 });
    const workspaceScope = captureRepositoryOperationScope();
    await expect(migrateCurrentProviderRepositoriesToWorkspace(workspaceScope)).resolves.toBe(1);
    expect(await getLocalRepositoryById(repository.id, workspaceScope.accountIdentity)).toMatchObject({ id: repository.id, accountScope: workspaceScope.accountIdentity });
    expect(await getLocalRecoverySnapshot(recovery.id, workspaceScope.accountIdentity)).toMatchObject({ id: recovery.id, accountIdentity: workspaceScope.accountIdentity, repository: { id: repository.id, accountScope: workspaceScope.accountIdentity } });
  });

  it("repairs rewrite ownership when primary migration completed before rewrite migration", async () => {
    const user = { provider: "google" as const, providerAccountId: `sub-${crypto.randomUUID()}`, name: "Writer", email: "writer@example.test", picture: "" };
    const legacyIdentity = `google:${user.providerAccountId}`;
    useAuthStore.setState({ user });
    useSettingsStore.setState({ accountIdentity: legacyIdentity, accountGeneration: 42 });
    const legacyScope = captureRepositoryOperationScope();
    const repository = await putLocalRepository({ bookId: crypto.randomUUID(), owner: "writer", repo: crypto.randomUUID(), branch: "main", defaultBranch: "main", remoteHeadSha: "head", clonedAt: new Date().toISOString(), cloneComplete: true }, legacyScope);
    const recovery = await createLocalRecoverySnapshot(repository.id, "before interrupted migration repair", legacyScope);
    const now = new Date().toISOString();
    await saveLocalRewriteOperation({ schemaVersion: 1, operationId: crypto.randomUUID(), operation: "rewriteFromReaderFeedback", scope: "chapter", bookId: repository.bookId, chapterId: "chapter", paragraphIds: [], startedAt: now, completedAt: null, status: "preparing", createdAt: now, updatedAt: now, repoId: repository.id, localInstanceId: repository.localInstanceId, owner: repository.owner, repo: repository.repo, branch: repository.branch, chapterSlug: "chapter", targetIds: [], feedbackMode: "panel-summary", feedbackPath: "feedback.md", feedbackSummaryPath: "feedback.md", feedbackSourceHash: "hash", staleFeedback: false, progress: { completed: 0, total: 0 }, modifiedFiles: [], generationRuns: [], aggregateInputTokens: 0, aggregateCachedInputTokens: 0, aggregateOutputTokens: 0, aggregateCost: 0, conflicts: [] } satisfies RewriteOperationManifest, legacyScope);

    useSettingsStore.setState({ accountIdentity: localWorkspaceScope(), accountGeneration: 42 });
    const workspaceScope = captureRepositoryOperationScope();
    await expect(migrateCurrentProviderRepositoriesToWorkspace(workspaceScope)).resolves.toBe(1);
    await expect(migrateCurrentProviderRepositoriesToWorkspace(workspaceScope)).resolves.toBe(0);
    expect(await getLocalRecoverySnapshot(recovery.id, workspaceScope.accountIdentity)).toMatchObject({ accountIdentity: workspaceScope.accountIdentity, repository: { accountScope: workspaceScope.accountIdentity, localInstanceId: repository.localInstanceId } });

    const rewriteDb = await new Promise<IDBDatabase>((resolve, reject) => { const request = indexedDB.open("narrarium-local-rewrite-operations"); request.onsuccess = () => resolve(request.result); request.onerror = () => reject(request.error); });
    const records = await new Promise<Array<Record<string, unknown>>>((resolve, reject) => {
      const request = rewriteDb.transaction("rewriteOperationsV3", "readonly").objectStore("rewriteOperationsV3").getAll();
      request.onsuccess = () => resolve(request.result as Array<Record<string, unknown>>);
      request.onerror = () => reject(request.error);
    });
    rewriteDb.close();
    expect(records.find((record) => record.repoId === repository.id)).toMatchObject({ accountIdentity: workspaceScope.accountIdentity, localInstanceId: repository.localInstanceId });
    expect(records.find((record) => record.repoId === repository.id)).not.toHaveProperty("legacyUnresolved");
    expect(records.find((record) => record.repoId === repository.id)).not.toHaveProperty("quarantineReason");
  });
});
