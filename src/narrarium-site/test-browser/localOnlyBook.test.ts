import { afterEach, beforeEach, describe, expect, it } from "vitest";
import "fake-indexeddb/auto";
import { resetLocalWorkspaceIdentityForTests, localWorkspaceScope } from "@/account/deviceIdentity";
import { createLocalOnlyBookRepository, getExistingLocalBookStructure } from "@/repository/repositoryService";
import { captureRepositoryOperationScope } from "@/repository/repositoryOperationScope";
import { attachLocalRepositoryToGitHub, getLocalFile, getLocalRepository, writeLocalText } from "@/repository/localRepository";
import type { BookEntry } from "@/types/settings";

describe("local-only books", () => {
  beforeEach(async () => {
    localStorage.clear();
    resetLocalWorkspaceIdentityForTests();
    await new Promise<void>((resolve) => {
      const request = indexedDB.deleteDatabase("narrarium-local-repositories");
      request.onsuccess = () => resolve();
      request.onerror = () => resolve();
      request.onblocked = () => resolve();
    });
  });

  afterEach(() => localStorage.clear());

  it("creates and reopens a complete book without a GitHub identity or token", async () => {
    const localRepositoryId = crypto.randomUUID();
    const book: BookEntry = {
      id: crypto.randomUUID(),
      storageMode: "local-only",
      localRepositoryId,
      owner: "",
      repo: "",
      name: "Offline novel",
      tokenIndex: null,
      activeBranch: `local:${localRepositoryId}`,
      addedAt: new Date().toISOString(),
    };
    const created = await createLocalOnlyBookRepository({ book, title: book.name, language: "en" });
    expect(created.meta.remoteKind).toBe("none");
    expect(created.structure.title).toBe(book.name);
    const scope = captureRepositoryOperationScope();
    const original = await getLocalFile(created.meta.id, "book.md", scope);
    await writeLocalText(created.meta.id, "book.md", `${original!.text}\nOffline edit\n`, scope);

    const reopened = await getExistingLocalBookStructure(book.id, "", "", book.activeBranch!, localWorkspaceScope());
    expect(reopened?.meta.id).toBe(created.meta.id);
    expect((await getLocalFile(created.meta.id, "book.md", captureRepositoryOperationScope()))?.text).toContain("Offline edit");
  });

  it("attaches a remote target without replacing the local repository identity or files", async () => {
    const localRepositoryId = crypto.randomUUID();
    const book: BookEntry = { id: crypto.randomUUID(), storageMode: "local-only", localRepositoryId, owner: "", repo: "", name: "Attach later", tokenIndex: null, activeBranch: `local:${localRepositoryId}`, addedAt: new Date().toISOString() };
    const created = await createLocalOnlyBookRepository({ book, title: book.name });
    const scope = captureRepositoryOperationScope();
    const attached = await attachLocalRepositoryToGitHub({ repoId: created.meta.id, scope, owner: "writer", repo: "attach-later", branch: "main", defaultBranch: "main", remoteHeadSha: "remote-head" });
    expect(attached.id).toBe(created.meta.id);
    expect(attached).toMatchObject({ remoteKind: "github", owner: "writer", repo: "attach-later", branch: "main" });
    expect((await getLocalRepository("writer", "attach-later", "main", scope))?.id).toBe(created.meta.id);
    expect((await getLocalFile(created.meta.id, "book.md", scope))?.text).toContain("Attach later");
  });
});
