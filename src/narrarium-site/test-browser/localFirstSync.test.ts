import "fake-indexeddb/auto";
import { afterEach, beforeEach, expect, test, vi } from "vitest";

const github = vi.hoisted(() => ({ getRef: vi.fn(), getCommit: vi.fn(), getTree: vi.fn(), createBlob: vi.fn(), createTree: vi.fn(), createCommit: vi.fn(), updateRef: vi.fn() }));
vi.mock("@octokit/rest", () => ({ Octokit: class { rest = { git: github }; } }));

import { localWorkspaceScope } from "@/account/deviceIdentity";
import { captureImmediateMutation, commitImmediateMutation } from "@/assistant/immediateMutation";
import { getLocalFile, getLocalRepositoryStatusSnapshot, listUnpushedLocalCommits } from "@/repository/localRepository";
import { captureRepositoryOperationScope } from "@/repository/repositoryOperationScope";
import { syncFullRepository } from "@/repository/repositoryService";
import { commitAndPushTextFileMutation } from "@/repository/safeRepositoryMutation";
import { createLinkedBookClone, createLinkedBookWithoutCredential, resetLocalWorkspace } from "./helpers/localFirst";

// An audit report is a file of the book like any other: it waits in the working copy as a local commit, the topbar counts it, and the sync publishes it.

beforeEach(resetLocalWorkspace);
afterEach(() => { vi.clearAllMocks(); vi.unstubAllGlobals(); });

const REPORT = "---\ntype: audit\nid: audit:book:book\n---\n\n# Audit\n\nNo findings.\n";

test("a linked book keeps its audit locally until the sync publishes it with the rest", async () => {
  const linked = await createLinkedBookClone({ token: "ghp_real_token", files: [{ path: "book.md", content: "---\ntype: book\nid: book\ntitle: Linked\n---\n\nA linked book.\n" }] });
  const snapshot = await captureImmediateMutation({ token: linked.token, book: linked.book, branch: linked.branch, path: "audit/book.md" });
  await commitImmediateMutation({ token: linked.token, book: linked.book, branch: linked.branch, snapshot, content: REPORT, message: "Update book audit: Linked" });

  expect(github.getRef).not.toHaveBeenCalled();
  const pending = await getLocalRepositoryStatusSnapshot(linked.book.owner, linked.book.repo, linked.branch, localWorkspaceScope());
  expect(pending?.status).toMatchObject({ ahead: 1, dirty: 0 });
  expect((await listUnpushedLocalCommits(linked.meta.id))[0].files.map((file) => file.path)).toEqual(["audit/book.md"]);

  // The remote did not move: the sync only pushes what this device has.
  github.getRef.mockResolvedValueOnce({ data: { object: { sha: "remote-head" } } }).mockResolvedValueOnce({ data: { object: { sha: "remote-head" } } }).mockResolvedValueOnce({ data: { object: { sha: "pushed-head" } } });
  github.getCommit.mockResolvedValue({ data: { tree: { sha: "remote-tree" } } });
  github.getTree.mockResolvedValue({ data: { truncated: false, tree: [{ path: "book.md", type: "blob", sha: "blob-0" }] } });
  github.createBlob.mockResolvedValue({ data: { sha: "audit-blob" } });
  github.createTree.mockResolvedValue({ data: { sha: "pushed-tree" } });
  github.createCommit.mockResolvedValue({ data: { sha: "pushed-head" } });
  github.updateRef.mockResolvedValue({ data: {} });

  const result = await syncFullRepository({ bookId: linked.book.id, owner: linked.book.owner, repo: linked.book.repo, branch: linked.branch, accountIdentity: localWorkspaceScope(), token: linked.token });

  expect(result).toMatchObject({ pulled: 0, pushed: 1 });
  expect(github.createTree).toHaveBeenCalledWith(expect.objectContaining({ base_tree: "remote-tree", tree: [{ path: "audit/book.md", mode: "100644", type: "blob", sha: "audit-blob" }] }));
  const synced = await getLocalRepositoryStatusSnapshot(linked.book.owner, linked.book.repo, linked.branch, localWorkspaceScope());
  expect(synced?.status).toMatchObject({ ahead: 0, dirty: 0 });
  expect(synced?.meta.remoteHeadSha).toBe("pushed-head");
  expect(await getLocalFile(linked.meta.id, "audit/book.md", captureRepositoryOperationScope())).toMatchObject({ status: "clean", baseSha: "audit-blob", text: REPORT });
});

test("a pull brings an audit made elsewhere into the working copy, where the pages read it", async () => {
  const linked = await createLinkedBookClone({ token: "ghp_real_token", files: [{ path: "book.md", content: "# Book\n" }] });
  github.getRef.mockResolvedValue({ data: { object: { sha: "remote-with-audit" } } });
  github.getCommit.mockImplementation(async ({ commit_sha }: { commit_sha: string }) => ({ data: { tree: { sha: commit_sha === "remote-head" ? "old-tree" : "new-tree" } } }));
  github.getTree.mockResolvedValue({ data: { truncated: false, tree: [{ path: "book.md", type: "blob", sha: "blob-0" }, { path: "audit/book.md", type: "blob", sha: "audit-blob" }] } });
  vi.stubGlobal("fetch", vi.fn(async (input: RequestInfo | URL) => {
    const url = String(input);
    if (url.endsWith("/git/blobs/audit-blob")) return new Response(REPORT, { status: 200, headers: { "content-type": "application/octet-stream" } });
    throw new TypeError(`Unexpected request ${url}`);
  }));

  const result = await syncFullRepository({ bookId: linked.book.id, owner: linked.book.owner, repo: linked.book.repo, branch: linked.branch, accountIdentity: localWorkspaceScope(), token: linked.token });

  expect(result.pulled).toBe(1);
  expect((await getLocalFile(linked.meta.id, "audit/book.md", captureRepositoryOperationScope()))?.text).toBe(REPORT);
});

test("a GitHub book without a credential saves as local commits, and the first sync once GitHub is connected publishes them", async () => {
  const linked = await createLinkedBookWithoutCredential({ files: [{ path: "book.md", content: "---\ntype: book\nid: book\ntitle: Linked\n---\n\nA linked book.\n" }] });
  const snapshot = await captureImmediateMutation({ token: linked.token, book: linked.book, branch: linked.branch, path: "audit/book.md" });
  await commitImmediateMutation({ token: linked.token, book: linked.book, branch: linked.branch, snapshot, content: REPORT, message: "Update book audit: Linked" });
  const applied = await commitAndPushTextFileMutation({ token: linked.token, book: linked.book, branch: linked.branch, expectedRemoteHeadSha: "remote-head", message: "Apply 1 Copilot file update", mutations: [{ path: "notes/gate.md", content: "# The gate\n", expectedCurrentHash: null }] });

  expect(applied.mode).toBe("local");
  expect(github.getRef).not.toHaveBeenCalled();
  expect((await getLocalRepositoryStatusSnapshot(linked.book.owner, linked.book.repo, linked.branch, localWorkspaceScope()))?.status).toMatchObject({ ahead: 1, dirty: 0 });

  // The author connects GitHub: the next sync publishes what was saved without it.
  github.getRef.mockResolvedValueOnce({ data: { object: { sha: "remote-head" } } }).mockResolvedValueOnce({ data: { object: { sha: "remote-head" } } }).mockResolvedValueOnce({ data: { object: { sha: "pushed-head" } } });
  github.getCommit.mockResolvedValue({ data: { tree: { sha: "remote-tree" } } });
  github.getTree.mockResolvedValue({ data: { truncated: false, tree: [{ path: "book.md", type: "blob", sha: "blob-0" }] } });
  github.createBlob.mockResolvedValueOnce({ data: { sha: "audit-blob" } }).mockResolvedValueOnce({ data: { sha: "note-blob" } });
  github.createTree.mockResolvedValue({ data: { sha: "pushed-tree" } });
  github.createCommit.mockResolvedValue({ data: { sha: "pushed-head" } });
  github.updateRef.mockResolvedValue({ data: {} });

  const result = await syncFullRepository({ bookId: linked.book.id, owner: linked.book.owner, repo: linked.book.repo, branch: linked.branch, accountIdentity: localWorkspaceScope(), token: "ghp_connected_later" });

  expect(result).toMatchObject({ pulled: 0, pushed: 2 });
  expect(github.createTree).toHaveBeenCalledWith(expect.objectContaining({ tree: expect.arrayContaining([expect.objectContaining({ path: "audit/book.md" }), expect.objectContaining({ path: "notes/gate.md" })]) }));
  const synced = await getLocalRepositoryStatusSnapshot(linked.book.owner, linked.book.repo, linked.branch, localWorkspaceScope());
  expect(synced?.status).toMatchObject({ ahead: 0, dirty: 0 });
  expect(synced?.meta.remoteHeadSha).toBe("pushed-head");
});
