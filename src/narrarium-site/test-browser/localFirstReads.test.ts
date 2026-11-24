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
import { classifyRepositoryError, RepositoryError } from "@/repository/repositoryError";
import { blockNetwork, createLinkedBookClone, createLocalOnlyBook, resetLocalWorkspace } from "./helpers/localFirst";

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

    await expect(readFileWithSha("", "writer", "novel", "main", "book.md")).rejects.toMatchObject({ name: "RepositoryError", kind: "credential-invalid" });
    await expect(loadFileContent("", "writer", "novel", "book.md", "main")).rejects.toMatchObject({ name: "RepositoryError", kind: "credential-invalid" });
    await expect(optionalBinaryFileContent("", "writer", "novel", "assets/book/cover.png", "main")).rejects.toMatchObject({ name: "RepositoryError", kind: "credential-invalid" });
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
