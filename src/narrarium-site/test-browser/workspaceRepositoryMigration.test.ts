import { describe, expect, it } from "vitest";
import "fake-indexeddb/auto";
import { useAuthStore } from "@/store/authStore";
import { useSettingsStore } from "@/store/settingsStore";
import { localWorkspaceScope } from "@/account/deviceIdentity";
import { captureRepositoryOperationScope } from "@/repository/repositoryOperationScope";
import { createLocalRecoverySnapshot, getLocalRecoverySnapshot, getLocalRepositoryById, migrateCurrentProviderRepositoriesToWorkspace, putLocalRepository, writeLocalText } from "@/repository/localRepository";

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
});
