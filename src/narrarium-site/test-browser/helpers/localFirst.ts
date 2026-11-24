import { vi } from "vitest";
import { resetLocalWorkspaceIdentityForTests } from "@/account/deviceIdentity";
import { createLocalOnlyBookRepository } from "@/repository/repositoryService";
import { buildLocalBookStructure, putCleanLocalFile, putLocalRepository, type LocalRepositoryMeta } from "@/repository/localRepository";
import { captureRepositoryOperationScope } from "@/repository/repositoryOperationScope";
import { useAuthStore } from "@/store/authStore";
import { DEFAULT_SETTINGS, LOCAL_BOOK_TOKEN, resolveWorkingCopyToken, type BookEntry } from "@/types/settings";
import type { BookStructure } from "@/types/book";

/**
 * The network of these tests: every request is recorded and fails as a browser without a connection does (a `TypeError`), so a read that is meant to
 * come from the working copy in IndexedDB and goes to GitHub instead shows up both as a request and as an error.
 */
export function blockNetwork(): { requests: string[]; github: () => string[] } {
  const requests: string[] = [];
  vi.stubGlobal("fetch", vi.fn(async (input: RequestInfo | URL) => {
    const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
    requests.push(url);
    throw new TypeError("Failed to fetch");
  }));
  return { requests, github: () => requests.filter((url) => /^https:\/\/(?:api\.)?github\.com\//.test(url)) };
}

/** A new workspace for each test: its repositories are apart from those of the tests before (an IndexedDB is never deleted under a connection still open). */
export async function resetLocalWorkspace(): Promise<void> {
  localStorage.clear();
  useAuthStore.setState({ user: null });
  resetLocalWorkspaceIdentityForTests();
}

export interface LocalFirstBook {
  book: BookEntry;
  branch: string;
  token: string;
  meta: LocalRepositoryMeta;
  structure: BookStructure;
}

/** A book that lives only on this device: no owner, no repository, the token every local book gets. */
export async function createLocalOnlyBook(title = "Offline novel", files: Array<{ path: string; content: string }> = []): Promise<LocalFirstBook> {
  const localRepositoryId = crypto.randomUUID();
  const book: BookEntry = { id: crypto.randomUUID(), storageMode: "local-only", localRepositoryId, owner: "", repo: "", name: title, tokenIndex: null, activeBranch: `local:${localRepositoryId}`, addedAt: new Date().toISOString() };
  const created = await createLocalOnlyBookRepository({ book, title, language: "en", files });
  return { book, branch: book.activeBranch!, token: LOCAL_BOOK_TOKEN, meta: created.meta, structure: created.structure };
}

/** A book linked to a GitHub repository, with its complete working copy already in IndexedDB (as after a clone). */
export async function createLinkedBookClone(input: { owner?: string; repo?: string; branch?: string; token?: string; files: Array<{ path: string; content: string }> }): Promise<LocalFirstBook> {
  const owner = input.owner ?? "writer";
  const repo = input.repo ?? "novel";
  const branch = input.branch ?? "main";
  const book: BookEntry = { id: crypto.randomUUID(), owner, repo, name: repo, tokenIndex: null, bookToken: input.token, activeBranch: branch, addedAt: new Date().toISOString() };
  const scope = captureRepositoryOperationScope();
  const meta = await putLocalRepository({ bookId: book.id, repositoryKind: "book", remoteKind: "github", owner, repo, branch, defaultBranch: branch, remoteHeadSha: "remote-head", clonedAt: new Date().toISOString(), cloneComplete: true, cloneStatus: "complete", expectedFileCount: input.files.length }, scope);
  let index = 0;
  for (const file of input.files) await putCleanLocalFile({ repoId: meta.id, path: file.path, kind: "text", text: file.content, baseSha: `blob-${index++}`, size: new TextEncoder().encode(file.content).byteLength }, scope);
  return { book, branch, token: input.token ?? "", meta, structure: await buildLocalBookStructure(meta) };
}

/**
 * A book linked to GitHub with its working copy on this device and no GitHub credential at all (no token, no connection): the pages give its services the
 * token of the working copy, which is the local one.
 */
export async function createLinkedBookWithoutCredential(input: { branch?: string; files: Array<{ path: string; content: string }> }): Promise<LocalFirstBook> {
  const linked = await createLinkedBookClone({ branch: input.branch, files: input.files });
  const token = resolveWorkingCopyToken(linked.book, DEFAULT_SETTINGS);
  if (token !== LOCAL_BOOK_TOKEN) throw new Error("The settings of the test have a GitHub credential.");
  return { ...linked, token };
}
