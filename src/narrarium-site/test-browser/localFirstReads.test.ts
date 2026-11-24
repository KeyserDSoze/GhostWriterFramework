import "fake-indexeddb/auto";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  createFileIfAbsent,
  createOrUpdateTextFile,
  loadBinaryFileContent,
  loadFileContent,
  optionalBinaryFileContent,
  readFileWithSha,
} from "@/github/githubClient";
import { loadAuditReport } from "@/narrarium/audit";
import { getLocalFile } from "@/repository/localRepository";
import { captureRepositoryOperationScope } from "@/repository/repositoryOperationScope";
import { classifyRepositoryError, RepositoryError, repositoryErrorDescription } from "@/repository/repositoryError";
import { createTrackedGitHubClient } from "@/repository/githubRequest";
import { fetchRepositoryBlobBytes } from "@/repository/repositoryBlobTransport";
import { RepositoryByteMeter } from "@/repository/repositoryLimits";
import { githubRemoteAvailability, isUsableGitHubToken } from "@/github/remoteAvailability";
import i18n from "@/i18n";
import { DEFAULT_SETTINGS, LOCAL_BOOK_TOKEN, resolveBookToken, resolveWorkingCopyToken, type BookEntry } from "@/types/settings";
import { blockNetwork, createLinkedBookClone, createLinkedBookWithoutCredential, createLocalOnlyBook, resetLocalWorkspace } from "./helpers/localFirst";

// The working copy in IndexedDB answers every read of a book that has one: a file it does not hold does not exist (yet), and GitHub is not asked.
// GitHub is a peer the book syncs with, never a source a page reads from.

beforeEach(resetLocalWorkspace);
afterEach(() => vi.unstubAllGlobals());

const notFound = { name: "RepositoryError", kind: "not-found", status: 404, operation: "read" };

describe("a book that lives only on this device", () => {
  it("opens the Audit page of a book that has no audit yet, without asking GitHub", async () => {
    const network = blockNetwork();
    const local = await createLocalOnlyBook();

    await expect(loadAuditReport({ token: local.token, book: local.book, branch: local.branch, structure: local.structure, target: { scope: "book", bookId: local.book.id } })).resolves.toBeNull();
    expect(network.requests).toEqual([]);
  });

  it("answers a missing file as absent from the working copy", async () => {
    const network = blockNetwork();
    const { token, book, branch } = await createLocalOnlyBook();

    const missing = readFileWithSha(token, book.owner, book.repo, branch, "audit/book.md");
    await expect(missing).rejects.toBeInstanceOf(RepositoryError);
    await expect(missing).rejects.toMatchObject(notFound);
    await expect(loadFileContent(token, book.owner, book.repo, "resumes/chapters/001.md", branch)).rejects.toMatchObject(notFound);
    await expect(loadBinaryFileContent(token, book.owner, book.repo, "assets/book/cover.png", branch)).rejects.toMatchObject(notFound);
    await expect(optionalBinaryFileContent(token, book.owner, book.repo, "assets/book/cover.png", branch)).resolves.toBeNull();
    expect(network.requests).toEqual([]);
  });

  it("creates a missing file in the working copy, and only once", async () => {
    const network = blockNetwork();
    const { token, book, branch, meta } = await createLocalOnlyBook();

    await createOrUpdateTextFile(token, book.owner, book.repo, branch, "notes/first.md", "# First\n", "Add a note");
    expect(await createFileIfAbsent(token, book.owner, book.repo, branch, "notes/second.md", "# Second\n", "Add a note")).toBe(true);
    expect(await createFileIfAbsent(token, book.owner, book.repo, branch, "notes/second.md", "# Again\n", "Add a note")).toBe(false);

    const scope = captureRepositoryOperationScope();
    expect((await getLocalFile(meta.id, "notes/first.md", scope))?.text).toBe("# First\n");
    expect((await getLocalFile(meta.id, "notes/second.md", scope))?.text).toBe("# Second\n");
    expect(network.requests).toEqual([]);
  });
});

describe("a book linked to GitHub, with its working copy on this device", () => {
  const files = [{ path: "book.md", content: "---\ntype: book\nid: book\ntitle: Linked\n---\n\nA linked book.\n" }];

  it("does not read GitHub for a file the working copy does not hold, even with a token", async () => {
    const network = blockNetwork();
    const linked = await createLinkedBookClone({ token: "ghp_real_token", files });

    await expect(readFileWithSha(linked.token, linked.book.owner, linked.book.repo, linked.branch, "audit/book.md")).rejects.toMatchObject(notFound);
    await expect(loadFileContent(linked.token, linked.book.owner, linked.book.repo, "plot.md", linked.branch)).rejects.toMatchObject(notFound);
    await expect(optionalBinaryFileContent(linked.token, linked.book.owner, linked.book.repo, "assets/book/cover.webp", linked.branch)).resolves.toBeNull();
    await expect(loadAuditReport({ token: linked.token, book: linked.book, branch: linked.branch, structure: linked.structure, target: { scope: "book", bookId: linked.book.id } })).resolves.toBeNull();
    expect(network.requests).toEqual([]);
  });
});

describe("a book without a working copy on this device", () => {
  it("does not call GitHub without a credential", async () => {
    const network = blockNetwork();

    await expect(readFileWithSha("", "writer", "novel", "main", "book.md")).rejects.toMatchObject({ name: "RepositoryError", kind: "no-credential" });
    await expect(loadFileContent("", "writer", "novel", "book.md", "main")).rejects.toMatchObject({ name: "RepositoryError", kind: "no-credential" });
    await expect(optionalBinaryFileContent("", "writer", "novel", "assets/book/cover.png", "main")).rejects.toMatchObject({ name: "RepositoryError", kind: "no-credential" });
    await expect(readFileWithSha(LOCAL_BOOK_TOKEN, "writer", "novel", "main", "book.md")).rejects.toMatchObject({ name: "RepositoryError", kind: "no-credential" });
    expect(network.requests).toEqual([]);
  });

  it("still reads GitHub when it has a credential", async () => {
    const network = blockNetwork();

    await expect(readFileWithSha("ghp_real_token", "writer", "novel", "main", "book.md")).rejects.toMatchObject({ name: "RepositoryError", kind: "network" });
    expect(network.github()).toHaveLength(1);
  });
});

describe("a request that never reached GitHub", () => {
  it("is a network failure, also when Octokit wraps it as a status 500", () => {
    const transport = Object.assign(new Error("fetch failed"), { name: "HttpError", status: 500, cause: new TypeError("Failed to fetch") });
    expect(classifyRepositoryError(transport, "update")).toMatchObject({ kind: "network", operation: "update" });
    expect(classifyRepositoryError(Object.assign(new Error("Server Error"), { name: "HttpError", status: 502 }), "update")).toMatchObject({ kind: "service-unavailable" });
  });
});

describe("a GitHub book without a credential", () => {
  const files = [
    { path: "book.md", content: "---\ntype: book\nid: book\ntitle: Linked\n---\n\nA linked book.\n" },
    { path: "chapters/001-the-gate/chapter.md", content: "---\ntype: chapter\nid: chapter:001-the-gate\nnumber: 1\ntitle: The Gate\n---\n\nThe first chapter.\n" },
  ];

  it("gives its services the token of the working copy, and the pages that reach GitHub no credential", async () => {
    const linked = await createLinkedBookWithoutCredential({ files });
    expect(resolveWorkingCopyToken(linked.book, DEFAULT_SETTINGS)).toBe(LOCAL_BOOK_TOKEN);
    expect(resolveBookToken(linked.book, DEFAULT_SETTINGS)).toBe("");
    expect(githubRemoteAvailability(linked.book, resolveBookToken(linked.book, DEFAULT_SETTINGS))).toBe("no-credential");
    expect(githubRemoteAvailability(linked.book, linked.token)).toBe("no-credential");
    expect(resolveWorkingCopyToken({ ...linked.book, bookToken: "ghp_book" }, DEFAULT_SETTINGS)).toBe("ghp_book");
  });

  it("reads every file from its working copy, a missing one is absent, and GitHub is not asked", async () => {
    const network = blockNetwork();
    const linked = await createLinkedBookWithoutCredential({ files });

    expect((await readFileWithSha(linked.token, linked.book.owner, linked.book.repo, linked.branch, "book.md")).content).toContain("A linked book.");
    await expect(readFileWithSha(linked.token, linked.book.owner, linked.book.repo, linked.branch, "audit/book.md")).rejects.toMatchObject(notFound);
    await expect(optionalBinaryFileContent(linked.token, linked.book.owner, linked.book.repo, "assets/book/cover.webp", linked.branch)).resolves.toBeNull();
    await expect(loadAuditReport({ token: linked.token, book: linked.book, branch: linked.branch, structure: linked.structure, target: { scope: "book", bookId: linked.book.id } })).resolves.toBeNull();
    expect(linked.structure.chapters.map((chapter) => chapter.slug)).toEqual(["001-the-gate"]);
    expect(network.requests).toEqual([]);
  });

  it("sends nothing to GitHub without a credential, whatever asks: what is missing is said, in both languages", async () => {
    const network = blockNetwork();
    for (const token of ["", LOCAL_BOOK_TOKEN]) {
      const refused = createTrackedGitHubClient(token).rest.repos.get({ owner: "writer", repo: "novel" });
      await expect(refused).rejects.toMatchObject({ name: "RepositoryError", kind: "no-credential" });
      await expect(fetchRepositoryBlobBytes({ token, owner: "writer", repo: "novel", path: "book.md", sha: "blob-0", kind: "text", meter: new RepositoryByteMeter("transfer") })).rejects.toMatchObject({ kind: "no-credential" });
    }
    expect(network.requests).toEqual([]);
    const error = new RepositoryError("No GitHub credential.", "no-credential", "read");
    await i18n.changeLanguage("en");
    expect(repositoryErrorDescription(error, (key, options) => i18n.t(key, options))).toBe("This needs GitHub: connect GitHub or add a token to use it. Your work stays on this device.");
    await i18n.changeLanguage("it");
    expect(repositoryErrorDescription(error, (key, options) => i18n.t(key, options))).toMatch(/^Serve GitHub: collega GitHub/);
    await i18n.changeLanguage("en");
  });
});

describe("a credential GitHub refuses", () => {
  const book: BookEntry = { id: "book", owner: "writer", repo: "novel", name: "Novel", tokenIndex: null, activeBranch: "main", addedAt: "2026-11-24T00:00:00.000Z" };
  const answer = (status: number) => vi.stubGlobal("fetch", vi.fn(async () => new Response(JSON.stringify(status === 401 ? { message: "Bad credentials" } : { id: 1, name: "novel", full_name: "writer/novel" }), { status, headers: { "content-type": "application/json" } })));

  it("counts as no credential from the first refusal, and as a credential again once GitHub accepts it", async () => {
    answer(401);
    expect(githubRemoteAvailability(book, "ghp_revoked")).toBe("ready");
    await expect(createTrackedGitHubClient("ghp_revoked").rest.repos.get({ owner: "writer", repo: "novel" })).rejects.toMatchObject({ status: 401 });
    expect(githubRemoteAvailability(book, "ghp_revoked")).toBe("no-credential");
    expect(isUsableGitHubToken("ghp_revoked")).toBe(false);
    // Another credential, a new token or the renewed token of the app, is a credential at once.
    expect(githubRemoteAvailability(book, "ghp_renewed")).toBe("ready");

    answer(200);
    await createTrackedGitHubClient("ghp_revoked").rest.repos.get({ owner: "writer", repo: "novel" });
    expect(githubRemoteAvailability(book, "ghp_revoked")).toBe("ready");
  });
});
