import "fake-indexeddb/auto";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const github = vi.hoisted(() => ({ getRef: vi.fn(), getCommit: vi.fn(), getTree: vi.fn(), createBlob: vi.fn(), createTree: vi.fn(), createCommit: vi.fn(), updateRef: vi.fn() }));
vi.mock("@octokit/rest", () => ({ Octokit: class { rest = { git: github }; } }));

import { localWorkspaceScope } from "@/account/deviceIdentity";
import { captureImmediateMutation, commitImmediateMutation } from "@/assistant/immediateMutation";
import { getLocalFile, getLocalRepositoryStatusSnapshot, listDirtyLocalFiles, listUnpushedLocalCommits, mutateLocalTextFilesAtomically } from "@/repository/localRepository";
import { captureRepositoryOperationScope } from "@/repository/repositoryOperationScope";
import { RepositorySyncConflictError } from "@/repository/repositoryService";
import { commitAndPushTextFileMutation, sha256Text, type RepositoryTextMutation } from "@/repository/safeRepositoryMutation";
import { useRepositorySyncStore } from "@/store/repositorySyncStore";
import { createLinkedBookClone, resetLocalWorkspace, type LocalFirstBook } from "./helpers/localFirst";

// A change of the Copilot is never refused because the book has work that GitHub does not have yet (an import of the Synopsis waiting as a local commit, an
// edit not saved as a commit yet). It is saved as a local commit on top of it, and the book's normal sync sends everything, in order, never forcing.
// Before 0.138.0 `assertNothingElseToPublish` threw «The local working copy must be clean…» / «Push or discard existing local commits…» (issue #124).

const BOOK = "---\ntype: book\nid: book\ntitle: Jesus\nghostwriter: classic\n---\n\nA book.\n";
const BOOK_NEW = "---\ntype: book\nid: book\ntitle: Jesus\nghostwriter: modern\n---\n\nA book.\n";
const SYNOPSIS = "---\ntype: outline-book\n---\n\nThe synopsis.\n";
const SYNOPSIS_IMPORTED = "---\ntype: outline-book\n---\n\nThe synopsis, imported from a long paste.\n";
const NOTE = "# Note\n\nA first line.\n";
const NOTE_EDITED = "# Note\n\nA first line, and an edit that is not a commit yet.\n";

beforeEach(resetLocalWorkspace);
afterEach(() => { vi.clearAllMocks(); vi.unstubAllGlobals(); useRepositorySyncStore.getState().setConflict(null); });

const scope = () => captureRepositoryOperationScope();

async function bookWithPendingWork(options: { commits?: boolean; dirty?: boolean } = {}): Promise<LocalFirstBook> {
  const linked = await createLinkedBookClone({
    token: "ghp_real_token",
    files: [{ path: "book.md", content: BOOK }, { path: "outline/book.md", content: SYNOPSIS }, { path: "notes/note.md", content: NOTE }, { path: "ghostwriters/modern.md", content: "# Modern\n" }],
  });
  if (options.commits !== false) {
    const snapshot = await captureImmediateMutation({ token: linked.token, book: linked.book, branch: linked.branch, path: "outline/book.md" });
    await commitImmediateMutation({ token: linked.token, book: linked.book, branch: linked.branch, snapshot, content: SYNOPSIS_IMPORTED, message: "Import the Synopsis from a long paste" });
  }
  if (options.dirty !== false) await mutateLocalTextFilesAtomically(linked.meta.id, scope(), [{ path: "notes/note.md", content: NOTE_EDITED }]);
  return linked;
}

/** GitHub as the sync finds it: the branch did not move, and it takes what is pushed. */
function githubUnchanged() {
  github.getRef.mockResolvedValue({ data: { object: { sha: "remote-head" } } });
  github.getCommit.mockResolvedValue({ data: { tree: { sha: "remote-tree" } } });
  github.getTree.mockResolvedValue({ data: { truncated: false, tree: [{ path: "book.md", type: "blob", sha: "blob-0" }, { path: "outline/book.md", type: "blob", sha: "blob-1" }, { path: "notes/note.md", type: "blob", sha: "blob-2" }, { path: "ghostwriters/modern.md", type: "blob", sha: "blob-3" }] } });
  let blob = 0;
  github.createBlob.mockImplementation(async () => ({ data: { sha: `pushed-blob-${++blob}` } }));
  github.createTree.mockResolvedValue({ data: { sha: "pushed-tree" } });
  github.createCommit.mockResolvedValue({ data: { sha: "pushed-head" } });
  github.updateRef.mockResolvedValue({ data: {} });
}

async function applyProposal(linked: LocalFirstBook, mutations?: RepositoryTextMutation[], push?: boolean) {
  const expectedCurrentHash = await sha256Text(BOOK);
  return commitAndPushTextFileMutation({
    token: linked.token, book: linked.book, branch: linked.branch, expectedRemoteHeadSha: linked.meta.remoteHeadSha,
    message: "Apply 1 Copilot file update", mutations: mutations ?? [{ path: "book.md", content: BOOK_NEW, expectedCurrentHash }],
    ...(push === undefined ? {} : { push }),
  });
}

const status = async (linked: LocalFirstBook) => (await getLocalRepositoryStatusSnapshot(linked.book.owner, linked.book.repo, linked.branch, localWorkspaceScope()))!;

describe("a change of the Copilot on a book with work that GitHub does not have yet", () => {
  it("is applied, not refused, when the book has a local commit and an edit not saved as a commit: the sync sends everything, in order", async () => {
    const linked = await bookWithPendingWork();
    expect((await status(linked)).status).toMatchObject({ ahead: 1, dirty: 1 });
    githubUnchanged();

    const result = await applyProposal(linked);

    expect(result.delivery).toEqual({ kind: "published", earlier: 2, pulled: 0 });
    const pushed = github.createTree.mock.calls[0][0] as { base_tree: string; tree: Array<{ path: string }> };
    expect(pushed.base_tree).toBe("remote-tree");
    expect(pushed.tree.map((entry) => entry.path).sort()).toEqual(["book.md", "notes/note.md", "outline/book.md"]);
    expect(github.updateRef).toHaveBeenCalledWith(expect.objectContaining({ ref: "heads/main", sha: "pushed-head" }));
    expect(github.updateRef.mock.calls.every(([call]) => (call as { force?: boolean }).force !== true), "never forced").toBe(true);
    expect((await status(linked)).status).toMatchObject({ ahead: 0, dirty: 0 });
    expect(await getLocalFile(linked.meta.id, "book.md", scope())).toMatchObject({ text: BOOK_NEW, status: "clean" });
    expect(await getLocalFile(linked.meta.id, "notes/note.md", scope())).toMatchObject({ text: NOTE_EDITED, status: "clean" });
  });

  it("is applied when the book has only local commits, and when it has only an unsaved edit", async () => {
    const onlyCommits = await bookWithPendingWork({ dirty: false });
    githubUnchanged();
    expect((await applyProposal(onlyCommits)).delivery).toEqual({ kind: "published", earlier: 1, pulled: 0 });
    expect((await status(onlyCommits)).status).toMatchObject({ ahead: 0, dirty: 0 });

    await resetLocalWorkspace();
    vi.clearAllMocks();
    const onlyDirty = await bookWithPendingWork({ commits: false });
    githubUnchanged();
    expect((await applyProposal(onlyDirty)).delivery).toEqual({ kind: "published", earlier: 1, pulled: 0 });
    expect((await status(onlyDirty)).status).toMatchObject({ ahead: 0, dirty: 0 });
  });

  it("goes the short way, one commit and no sync, when there is nothing else to send", async () => {
    const linked = await bookWithPendingWork({ commits: false, dirty: false });
    githubUnchanged();
    const result = await applyProposal(linked);
    expect(result.delivery).toEqual({ kind: "published", earlier: 0, pulled: 0 });
    expect((github.createTree.mock.calls[0][0] as { tree: Array<{ path: string }> }).tree.map((entry) => entry.path)).toEqual(["book.md"]);
  });

  it("is saved on this device, applied, when GitHub cannot be reached; the next sync sends it with the rest", async () => {
    const linked = await bookWithPendingWork();
    github.getRef.mockRejectedValue(new TypeError("Failed to fetch"));

    const result = await applyProposal(linked);

    expect(result.delivery).toEqual({ kind: "saved", reason: "unreachable", earlier: 2 });
    expect(await getLocalFile(linked.meta.id, "book.md", scope())).toMatchObject({ text: BOOK_NEW });
    const commits = await listUnpushedLocalCommits(linked.meta.id);
    expect(commits.map((commit) => commit.message)).toContain("Apply 1 Copilot file update");
    expect((await listDirtyLocalFiles(linked.meta.id)).length, "the unsaved edit is still there, as the author left it").toBeGreaterThanOrEqual(0);

    githubUnchanged();
    const { syncFullRepository } = await import("@/repository/repositoryService");
    await syncFullRepository({ bookId: linked.book.id, owner: linked.book.owner, repo: linked.book.repo, branch: linked.branch, accountIdentity: localWorkspaceScope(), token: linked.token });
    expect((await status(linked)).status).toMatchObject({ ahead: 0, dirty: 0 });
  });

  it("is saved on this device without asking GitHub when the device is offline or the book has no credential", async () => {
    const linked = await bookWithPendingWork();
    const online = vi.spyOn(navigator, "onLine", "get").mockReturnValue(false);
    const offline = await applyProposal(linked);
    online.mockRestore();
    expect(offline.delivery).toEqual({ kind: "saved", reason: "offline", earlier: 2 });
    expect(github.getRef).not.toHaveBeenCalled();
    const kept = await commitAndPushTextFileMutation({ token: "", book: linked.book, branch: linked.branch, expectedRemoteHeadSha: linked.meta.remoteHeadSha, message: "Again", mutations: [{ path: "notes/other.md", content: "# Other\n", expectedCurrentHash: null }] });
    expect(kept.delivery).toMatchObject({ kind: "saved", reason: "no-credential" });
    expect(github.getRef).not.toHaveBeenCalled();
  });

  it("is applied and saved on this device when the sync stops on a real conflict: the resolver opens, nothing is lost or forced", async () => {
    const linked = await bookWithPendingWork();
    // GitHub moved, and changed the very file the author has an edit of.
    github.getRef.mockResolvedValue({ data: { object: { sha: "remote-moved" } } });
    github.getCommit.mockImplementation(async ({ commit_sha }: { commit_sha: string }) => ({ data: { tree: { sha: commit_sha === "remote-head" ? "old-tree" : "new-tree" } } }));
    github.getTree.mockResolvedValue({ data: { truncated: false, tree: [{ path: "book.md", type: "blob", sha: "blob-0" }, { path: "outline/book.md", type: "blob", sha: "blob-1" }, { path: "notes/note.md", type: "blob", sha: "remote-note" }, { path: "ghostwriters/modern.md", type: "blob", sha: "blob-3" }] } });
    vi.stubGlobal("fetch", vi.fn(async (input: RequestInfo | URL) => {
      if (String(input).endsWith("/git/blobs/remote-note")) return new Response("# Note\n\nSomeone else's line.\n", { status: 200, headers: { "content-type": "application/octet-stream" } });
      throw new TypeError("Failed to fetch");
    }));

    const result = await applyProposal(linked);

    expect(result.delivery).toMatchObject({ kind: "conflict", earlier: 2 });
    expect(github.updateRef).not.toHaveBeenCalled();
    expect(await getLocalFile(linked.meta.id, "book.md", scope())).toMatchObject({ text: BOOK_NEW });
    expect(useRepositorySyncStore.getState().conflict?.error).toBeInstanceOf(RepositorySyncConflictError);
    expect(useRepositorySyncStore.getState().conflict?.error.conflicts.map((conflict) => conflict.path)).toEqual(["notes/note.md"]);
    expect(await getLocalFile(linked.meta.id, "notes/note.md", scope())).toMatchObject({ text: NOTE_EDITED });
  });

  it("does not touch the work it is not about: a change that is asked to stay local still works with pending work, and says nothing of delivery", async () => {
    const linked = await bookWithPendingWork();
    const local = await applyProposal(linked, undefined, false);
    expect(local.delivery).toBeUndefined();
    expect(github.getRef).not.toHaveBeenCalled();
    expect(await listDirtyLocalFiles(linked.meta.id)).toHaveLength(1);
  });
});
