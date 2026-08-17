import "fake-indexeddb/auto";
import { afterEach, describe, expect, it } from "vitest";
import { buildAvailableFileManifest, loadWriterContext } from "@/assistant/context";
import { canSearchAvailableFile, secretAccessMapForRoute } from "@/assistant/secretPolicy";
import { RepositoryError } from "@/repository/repositoryError";
import {
  buildLocalBookStructure,
  getLocalFile,
  putCleanLocalFile,
  putLocalRepository,
  removeLocalRepository,
} from "@/repository/localRepository";
import { captureRepositoryOperationScope } from "@/repository/repositoryOperationScope";
import { useAuthStore } from "@/store/authStore";

useAuthStore.setState({ user: { provider: "google", providerAccountId: "sub-writer", name: "Writer", email: "writer@example.com", picture: "" } });

let repoId = "";

afterEach(async () => {
  if (repoId) await removeLocalRepository(repoId, captureRepositoryOperationScope());
  repoId = "";
});

async function localSecretFixture() {
  const suffix = crypto.randomUUID();
  const repo = await putLocalRepository({
    bookId: `book-${suffix}`,
    owner: "owner",
    repo: `repo-${suffix}`,
    branch: "main",
    defaultBranch: "main",
    remoteHeadSha: "remote",
    clonedAt: new Date().toISOString(),
    cloneComplete: true,
  }, captureRepositoryOperationScope());
  repoId = repo.id;
  const files: Record<string, string> = {
    "book.md": "---\ntitle: Local Secrets\n---\n",
    "chapters/001-opening/chapter.md": "---\ntitle: Opening\n---\n",
    "chapters/002-suspicion/chapter.md": "---\ntitle: Suspicion\n---\n",
    "chapters/003-reveal/chapter.md": "---\ntitle: Reveal\n---\n",
    "secrets/the-truth.md": "---\ntitle: The Truth\nknown_from: chapter:002-suspicion\nreveal_in: chapter:003-reveal\n---\n\nThe crown is counterfeit.\n",
  };
  await Promise.all(Object.entries(files).map(([path, text]) => putCleanLocalFile({
    repoId,
    path,
    kind: "text",
    text,
    size: new TextEncoder().encode(text).byteLength,
  })));
  return { repo, files, structure: await buildLocalBookStructure(repo) };
}

describe("local repository secret thresholds", () => {
  it("retains thresholds and applies them to manifests and search eligibility", async () => {
    const { structure } = await localSecretFixture();
    expect(structure.secrets[0]).toMatchObject({
      path: "secrets/the-truth.md",
      knownFrom: "chapter:002-suspicion",
      revealIn: "chapter:003-reveal",
    });

    const hiddenAccess = secretAccessMapForRoute({ structure, route: { kind: "chapter", bookId: "book", chapterId: "001-opening" }, chapter: structure.chapters[0] });
    expect(buildAvailableFileManifest(structure, hiddenAccess).some((file) => file.path === "secrets/the-truth.md")).toBe(false);

    const knownAccess = secretAccessMapForRoute({ structure, route: { kind: "chapter", bookId: "book", chapterId: "002-suspicion" }, chapter: structure.chapters[1] });
    const knownFile = buildAvailableFileManifest(structure, knownAccess).find((file) => file.path === "secrets/the-truth.md");
    expect(knownFile?.secretAccess).toBe("known");
    expect(canSearchAvailableFile(knownFile!)).toBe(false);

    const revealedAccess = secretAccessMapForRoute({ structure, route: { kind: "chapter", bookId: "book", chapterId: "003-reveal" }, chapter: structure.chapters[2] });
    const revealedFile = buildAvailableFileManifest(structure, revealedAccess).find((file) => file.path === "secrets/the-truth.md");
    expect(revealedFile?.secretAccess).toBe("revealed");
    expect(canSearchAvailableFile(revealedFile!)).toBe(true);
  });

  it("keeps chapter context spoiler-safe and loads only an explicitly opened author secret", async () => {
    const { repo, structure } = await localSecretFixture();
    const book = { id: repo.bookId, owner: repo.owner, repo: repo.repo, activeBranch: "main", tokenIndex: null } as any;
    const settings = { books: [book], defaultGitHubToken: "token" } as any;
    const read = async (_token: string, _owner: string, _repo: string, path: string) => {
      const file = await getLocalFile(repo.id, path);
      if (!file?.text) throw new RepositoryError(`Missing local fixture file: ${path}`, "not-found", "read", 404);
      return file.text;
    };

    const chapterContext = await loadWriterContext(`/app/books/${repo.bookId}/chapters/002-suspicion`, settings, [book], { [repo.bookId]: structure }, { [repo.bookId]: "main" }, "main", read);
    expect(chapterContext.availableFiles.find((file) => file.path === "secrets/the-truth.md")?.secretAccess).toBe("known");
    expect(chapterContext.loadedFilePaths).not.toContain("secrets/the-truth.md");
    expect(chapterContext.relevantFiles.some((file) => file.content.includes("counterfeit"))).toBe(false);

    const secretContext = await loadWriterContext(`/app/books/${repo.bookId}/canon/secrets/the-truth`, settings, [book], { [repo.bookId]: structure }, { [repo.bookId]: "main" }, "main", read);
    expect(secretContext.availableFiles.find((file) => file.path === "secrets/the-truth.md")?.secretAccess).toBe("author");
    expect(secretContext.loadedFilePaths).toContain("secrets/the-truth.md");
    expect(secretContext.relevantFiles.find((file) => file.path === "secrets/the-truth.md")?.content).toContain("counterfeit");
  });
});
