import { afterEach, beforeEach, describe, expect, it } from "vitest";
import "fake-indexeddb/auto";
import { resetLocalWorkspaceIdentityForTests } from "@/account/deviceIdentity";
import { attachLocalBookToGitHub, createLocalOnlyBookRepository } from "@/repository/repositoryService";
import { captureRepositoryOperationScope } from "@/repository/repositoryOperationScope";
import { getLocalFile, getLocalRepository, listLocalFiles } from "@/repository/localRepository";
import { BookRepositoryError } from "@/github/bookRepository";
import type { BookEntry } from "@/types/settings";
import { createFakeGitHub } from "./helpers/fakeGitHub";

// A book that lives on this device is published through the same service that makes a new book on GitHub: the book's files, plus what the template has
// and the book lacks, in a few requests (never one for each file), and the working copy becomes the repository.

async function localBook(extra: Array<{ path: string; content: string }> = []) {
  const localRepositoryId = crypto.randomUUID();
  const book: BookEntry = { id: crypto.randomUUID(), storageMode: "local-only", localRepositoryId, owner: "", repo: "", name: "The Glass Harbor", tokenIndex: null, activeBranch: `local:${localRepositoryId}`, addedAt: new Date().toISOString() };
  const created = await createLocalOnlyBookRepository({ book, title: book.name, language: "en", files: extra });
  return { book, meta: created.meta };
}

const chapters = (count: number) => Array.from({ length: count }, (_, index) => ({ path: `chapters/${String(index).padStart(4, "0")}/chapter.md`, content: `---\ntype: chapter\n---\n\nChapter ${index}\n` }));

describe("attaching a local book to GitHub", () => {
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

  it("sends a book of many files in a few requests, not one for each file", async () => {
    const { book, meta } = await localBook(chapters(400));
    const localCount = (await listLocalFiles(meta.id)).length;
    expect(localCount).toBeGreaterThan(420);
    // Binary files go as blobs (see bookRepository.test.ts); this book has none, so no request is made for any file.
    const fake = createFakeGitHub();

    const attached = await attachLocalBookToGitHub({ book, token: "never-used", owner: "", repo: "glass-harbor", octokit: fake.octokit });

    // The calls do not grow with the files: the user, the name, the repository, the trees (150 entries at most each), two commits, the reference and the workflow update.
    const trees = fake.count("git.createTree");
    expect(trees).toBeLessThanOrEqual(Math.ceil((localCount + 130) / 150) + 1);
    expect(fake.count("git.createBlob")).toBe(0);
    expect(fake.calls.length).toBeLessThanOrEqual(trees + 14);
    expect(fake.calls.length).toBeLessThan(40);
    expect(attached).toMatchObject({ owner: "ada", repo: "glass-harbor", branch: "main" });
    expect(attached.creation.workflow).toBe("done");

    // The repository has the book's files and the template's, and the working copy is now that repository: every file clean, with the sha GitHub has.
    const remote = fake.filesAt("ada", "glass-harbor")!;
    expect(remote.has("chapters/0399/chapter.md")).toBe(true);
    expect(remote.has("reader/package.json")).toBe(true);
    expect(remote.has(".github/workflows/deploy-reader-pages.yml")).toBe(true);
    const after = await getLocalRepository("ada", "glass-harbor", "main", captureRepositoryOperationScope());
    expect(after).toMatchObject({ id: meta.id, remoteKind: "github", remoteHeadSha: attached.remoteHeadSha });
    const files = await listLocalFiles(meta.id);
    expect(files.every((file) => file.status === "clean" && file.baseSha)).toBe(true);
    expect(files.some((file) => file.path === "reader/package.json")).toBe(true);
    expect((await getLocalFile(meta.id, "book.md", captureRepositoryOperationScope()))?.text).toContain("The Glass Harbor");
  });

  it("does not replace a file the book has with the template's, and keeps the workflow out of the working copy when the token may not write it", async () => {
    const { book, meta } = await localBook([{ path: "context.md", content: "My own context.\n" }]);
    const fake = createFakeGitHub({ workflowRefusal: { status: 403, message: "refusing to allow a Personal Access Token to create or update workflow `.github/workflows/deploy-reader-pages.yml` without `workflow` scope" } });

    const attached = await attachLocalBookToGitHub({ book, token: "never-used", owner: "", repo: "glass-harbor", octokit: fake.octokit });

    expect(attached.creation.workflow).toBe("not-allowed");
    expect(fake.filesAt("ada", "glass-harbor")!.has(".github/workflows/deploy-reader-pages.yml")).toBe(false);
    expect((await getLocalFile(meta.id, "context.md", captureRepositoryOperationScope()))?.text).toBe("My own context.\n");
    expect((await listLocalFiles(meta.id)).some((file) => file.path.includes(".github/workflows"))).toBe(false);
  });

  it("creates the repository in an organization, public, with Pages", async () => {
    const { book } = await localBook();
    const fake = createFakeGitHub({ orgs: ["acme"] });
    const attached = await attachLocalBookToGitHub({ book, token: "never-used", owner: "acme", repo: "glass-harbor", visibility: "public", pages: "enable", octokit: fake.octokit });
    expect(attached).toMatchObject({ owner: "acme" });
    expect(attached.creation).toMatchObject({ private: false, pages: "enabled" });
    expect(fake.count("repos.createInOrg")).toBe(1);
  });

  it("fills an empty repository the user made, and refuses one with files unless asked to replace them", async () => {
    const { book } = await localBook();
    const empty = createFakeGitHub({ existing: [{ owner: "ada", name: "glass-harbor" }] });
    const attached = await attachLocalBookToGitHub({ book, token: "never-used", owner: "ada", repo: "glass-harbor", octokit: empty.octokit });
    expect(attached.creation.createdRepository).toBe(false);
    expect(empty.count("repos.createForAuthenticatedUser")).toBe(0);

    const second = await localBook();
    const full = createFakeGitHub({ existing: [{ owner: "ada", name: "glass-harbor", withBranch: true }] });
    await expect(attachLocalBookToGitHub({ book: second.book, token: "never-used", owner: "ada", repo: "glass-harbor", octokit: full.octokit })).rejects.toMatchObject({ code: "not-empty" });
    expect((await getLocalRepository("", "", second.book.activeBranch!, captureRepositoryOperationScope()))?.remoteKind).toBe("none");
    const replaced = await attachLocalBookToGitHub({ book: second.book, token: "never-used", owner: "ada", repo: "glass-harbor", overwriteExisting: true, octokit: full.octokit });
    expect(replaced.remoteHeadSha).toBeTruthy();
    expect(full.filesAt("ada", "glass-harbor")!.has("old.md")).toBe(false);
  });

  it("leaves the book on this device when the repository cannot be made, and says so with the code", async () => {
    const { book } = await localBook();
    const fake = createFakeGitHub({ faults: [{ call: "repos.createForAuthenticatedUser", status: 403, message: "Resource not accessible by personal access token" }] });
    const error = await attachLocalBookToGitHub({ book, token: "never-used", owner: "", repo: "glass-harbor", octokit: fake.octokit }).catch((failure) => failure);
    expect(error).toBeInstanceOf(BookRepositoryError);
    expect(error.code).toBe("cannot-create");
    expect((await getLocalRepository("", "", book.activeBranch!, captureRepositoryOperationScope()))?.remoteKind).toBe("none");
  });

  it("can be tried again into the empty repository a failed first commit left", async () => {
    const { book } = await localBook();
    const fake = createFakeGitHub({ faults: [{ call: "git.createCommit", status: 500, message: "Server Error", times: 1 }] });
    const error = await attachLocalBookToGitHub({ book, token: "never-used", owner: "", repo: "glass-harbor", octokit: fake.octokit }).catch((failure) => failure);
    expect(error).toMatchObject({ code: "first-commit-failed", repository: { owner: "ada", repo: "glass-harbor", created: true } });
    const attached = await attachLocalBookToGitHub({ book, token: "never-used", owner: "", repo: "glass-harbor", octokit: fake.octokit });
    expect(attached.creation.createdRepository).toBe(false);
    expect(fake.repos.size).toBe(1);
  });
});
