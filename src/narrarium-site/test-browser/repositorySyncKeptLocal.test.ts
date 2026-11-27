import "fake-indexeddb/auto";
import { afterEach, beforeEach, expect, test, vi } from "vitest";

// A change the full sync says it kept on this device is published by that sync, whatever state the working copy left it in; and the status of the copy
// counts it until it is on GitHub. A file marked as committed without a commit that is still to be published is the only state that made the sync say
// «kept local 1, committed 0, pushed 0» and then never publish it.

const octokit = vi.hoisted(() => ({
  getRepo: vi.fn(),
  getRef: vi.fn(),
  getCommit: vi.fn(),
  getTree: vi.fn(),
  getBlob: vi.fn(),
  createBlob: vi.fn(),
  createTree: vi.fn(),
  createCommit: vi.fn(),
  updateRef: vi.fn(),
}));

vi.mock("@octokit/rest", () => ({ Octokit: class { rest = { git: octokit, repos: { get: octokit.getRepo } }; } }));
vi.mock("@/repository/repositoryBlobTransport", () => ({
  fetchRepositoryBlobBytes: vi.fn(async (input: { owner: string; repo: string; sha: string; kind: "text" | "binary"; meter: { add: (kind: "text" | "binary", size: number) => void }; signal?: AbortSignal }) => {
    const blob = await octokit.getBlob({ owner: input.owner, repo: input.repo, file_sha: input.sha, request: { signal: input.signal } });
    const binary = atob(blob.data.content.replace(/\n/g, ""));
    const bytes = Uint8Array.from(binary, (character) => character.charCodeAt(0));
    input.meter.add(input.kind, bytes.byteLength);
    return bytes;
  }),
}));

import { localWorkspaceScope, resetLocalWorkspaceIdentityForTests } from "@/account/deviceIdentity";
import { attachLocalBookToGitHub, createLocalOnlyBookRepository, RepositorySyncConflictError, syncFullRepository } from "@/repository/repositoryService";
import { captureRepositoryOperationScope } from "@/repository/repositoryOperationScope";
import { createLocalCommit, deleteLocalFile, getLocalRepositoryStatusSnapshot, listAllLocalFiles, listUnpushedLocalCommits, putCleanLocalFile, putLocalRepository, writeLocalText } from "@/repository/localRepository";
import type { BookEntry } from "@/types/settings";
import { createFakeGitHub } from "./helpers/fakeGitHub";

const DB_NAME = "narrarium-local-repositories";

beforeEach(async () => {
  localStorage.clear();
  resetLocalWorkspaceIdentityForTests();
  await new Promise<void>((resolve) => {
    const request = indexedDB.deleteDatabase(DB_NAME);
    request.onsuccess = () => resolve();
    request.onerror = () => resolve();
    request.onblocked = () => resolve();
  });
});
afterEach(() => {
  vi.clearAllMocks();
  localStorage.clear();
});

/** The commits of a working copy forget a commit, as some settlements did: the files keep the mark of it. */
async function forgetCommits(repoId: string): Promise<void> {
  const db = await new Promise<IDBDatabase>((resolve, reject) => { const request = indexedDB.open(DB_NAME); request.onsuccess = () => resolve(request.result); request.onerror = () => reject(request.error); });
  await new Promise<void>((resolve, reject) => {
    const tx = db.transaction("commits", "readwrite");
    const cursor = tx.objectStore("commits").index("repoId").openCursor(IDBKeyRange.only(repoId));
    cursor.onsuccess = () => { if (cursor.result) { cursor.result.delete(); cursor.result.continue(); } };
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
  });
  db.close();
}

function remote(files: Record<string, string>, head: string, previousHead: string) {
  octokit.getRef.mockResolvedValue({ data: { object: { sha: head } } });
  octokit.getCommit.mockImplementation(async ({ commit_sha }: { commit_sha: string }) => ({ data: { tree: { sha: commit_sha === previousHead ? "tree-before" : `tree-of-${commit_sha}` } } }));
  octokit.getTree.mockImplementation(async () => ({ data: { truncated: false, tree: Object.keys(files).map((path) => ({ type: "blob", path, sha: files[path] })) } }));
}

test("a kept version of a file marked committed without its commit is committed and published by the sync", async () => {
  const scope = captureRepositoryOperationScope();
  const identity = localWorkspaceScope();
  const target = { bookId: "book", owner: "owner", repo: "repo", branch: "main", accountIdentity: identity };
  const meta = await putLocalRepository({ ...target, defaultBranch: "main", remoteHeadSha: "base-head", clonedAt: new Date().toISOString(), cloneComplete: true }, scope);
  await putCleanLocalFile({ repoId: meta.id, path: "autopilot/state.json", kind: "text", text: "{\"version\":1}\n", baseSha: "state-base", size: 14 }, scope);
  await putCleanLocalFile({ repoId: meta.id, path: "plot.md", kind: "text", text: "plot\n", baseSha: "plot-base", size: 5 }, scope);
  await writeLocalText(meta.id, "autopilot/state.json", "{\"version\":2,\"by\":\"this device\"}\n", scope);
  await createLocalCommit(meta.id, scope, "Autopilot step");
  await forgetCommits(meta.id);
  const orphan = (await listAllLocalFiles(meta.id)).find((file) => file.path === "autopilot/state.json")!;
  expect(orphan).toMatchObject({ status: "clean", committed: true });
  expect(await listUnpushedLocalCommits(meta.id)).toEqual([]);

  // The status of the copy does not say «clean» while the change is only here.
  expect((await getLocalRepositoryStatusSnapshot("owner", "repo", "main", identity))?.status).toMatchObject({ dirty: 1, ahead: 0 });

  // GitHub changed the same file: the author keeps this device's version.
  remote({ "autopilot/state.json": "state-remote", "plot.md": "plot-base" }, "remote-head", "base-head");
  octokit.getBlob.mockResolvedValue({ data: { encoding: "base64", content: btoa("{\"version\":3,\"by\":\"server\"}\n") } });
  octokit.createBlob.mockResolvedValue({ data: { sha: "state-local" } });
  octokit.createTree.mockResolvedValue({ data: { sha: "tree-local" } });
  octokit.createCommit.mockResolvedValue({ data: { sha: "local-head" } });
  octokit.updateRef.mockResolvedValue({ data: {} });
  const conflict = await syncFullRepository({ ...target, token: "token" }).then(() => null, (failure: unknown) => failure);
  expect(conflict).toBeInstanceOf(RepositorySyncConflictError);
  const [file] = (conflict as RepositorySyncConflictError).conflicts;
  expect(file).toMatchObject({ path: "autopilot/state.json", localChanged: true });

  octokit.getRef.mockReset();
  octokit.getRef.mockResolvedValueOnce({ data: { object: { sha: "remote-head" } } }).mockResolvedValueOnce({ data: { object: { sha: "remote-head" } } }).mockResolvedValue({ data: { object: { sha: "local-head" } } });
  const result = await syncFullRepository({ ...target, token: "token", conflictResolutions: { [file.path]: { choice: "local", expectedLocalHash: file.localHash, expectedRemoteSha: file.remoteSha, expectedLocalDeleted: file.localDeleted, expectedRemoteDeleted: file.remoteDeleted, expectedLocalBaseSha: file.localBaseSha, expectedLocalChanged: file.localChanged } } });

  expect(result).toMatchObject({ pulled: 0, keptLocal: 1, committed: 1, pushed: 1, unpublished: 0 });
  expect(octokit.createBlob).toHaveBeenCalledWith(expect.objectContaining({ content: "{\"version\":2,\"by\":\"this device\"}\n", encoding: "utf-8" }));
  expect((await listAllLocalFiles(meta.id)).find((entry) => entry.path === "autopilot/state.json")).toMatchObject({ status: "clean", committed: false, baseSha: "state-local" });
  expect((await getLocalRepositoryStatusSnapshot("owner", "repo", "main", identity))?.status).toMatchObject({ dirty: 0, ahead: 0 });
});

test("attaching a local book to GitHub leaves no deletion marked as committed, so a later sync has nothing it keeps without publishing", async () => {
  const localRepositoryId = crypto.randomUUID();
  const book: BookEntry = { id: crypto.randomUUID(), storageMode: "local-only", localRepositoryId, owner: "", repo: "", name: "The Glass Harbor", tokenIndex: null, activeBranch: `local:${localRepositoryId}`, addedAt: new Date().toISOString() };
  const { meta } = await createLocalOnlyBookRepository({ book, title: book.name, language: "en", files: [{ path: "notes/old.md", content: "An old note.\n" }] });
  const scope = captureRepositoryOperationScope();
  await deleteLocalFile(meta.id, "notes/old.md", scope);
  await createLocalCommit(meta.id, scope, "Save local book changes");
  const fake = createFakeGitHub();

  const attached = await attachLocalBookToGitHub({ book, token: "never-used", owner: "", repo: "glass-harbor", octokit: fake.octokit });

  const files = await listAllLocalFiles(meta.id);
  expect(files.filter((file) => file.committed)).toEqual([]);
  expect(files.find((file) => file.path === "notes/old.md")).toBeUndefined();
  expect((await getLocalRepositoryStatusSnapshot(attached.owner, attached.repo, attached.branch, localWorkspaceScope()))?.status).toMatchObject({ dirty: 0, ahead: 0 });

  // GitHub moves (another device changed the plot): the sync brings it, and keeps nothing it does not publish.
  const tree = Object.fromEntries(files.filter((file) => file.status !== "deleted").map((file) => [file.path, file.baseSha!]));
  remote({ ...tree, "plot.md": "plot-from-another-device" }, "remote-head", attached.remoteHeadSha);
  octokit.getBlob.mockResolvedValue({ data: { encoding: "base64", content: btoa("The plot, from another device.\n") } });
  const result = await syncFullRepository({ bookId: book.id, repoId: meta.id, owner: attached.owner, repo: attached.repo, branch: attached.branch, accountIdentity: localWorkspaceScope(), token: "token" });
  expect(result).toMatchObject({ pulled: 1, keptLocal: 0, committed: 0, pushed: 0, unpublished: 0 });
});

test("a deletion marked as committed by an earlier attachment is settled by the next sync instead of being kept forever", async () => {
  const scope = captureRepositoryOperationScope();
  const identity = localWorkspaceScope();
  const target = { bookId: "book", owner: "owner", repo: "repo", branch: "main", accountIdentity: identity };
  const meta = await putLocalRepository({ ...target, defaultBranch: "main", remoteHeadSha: "base-head", clonedAt: new Date().toISOString(), cloneComplete: true }, scope);
  // A file that was only ever on this device (no GitHub version), deleted and committed, whose commit was then settled without it.
  await putCleanLocalFile({ repoId: meta.id, path: "notes/old.md", kind: "text", text: "An old note.\n", size: 13 }, scope);
  await putCleanLocalFile({ repoId: meta.id, path: "plot.md", kind: "text", text: "plot\n", baseSha: "plot-base", size: 5 }, scope);
  await deleteLocalFile(meta.id, "notes/old.md", scope);
  await createLocalCommit(meta.id, scope, "Save local book changes");
  await forgetCommits(meta.id);
  expect((await listAllLocalFiles(meta.id)).find((file) => file.path === "notes/old.md")).toMatchObject({ status: "deleted", committed: true });

  remote({ "plot.md": "plot-remote" }, "remote-head", "base-head");
  octokit.getBlob.mockResolvedValue({ data: { encoding: "base64", content: btoa("new plot\n") } });
  const result = await syncFullRepository({ ...target, token: "token" });

  expect(result).toMatchObject({ pulled: 1, keptLocal: 0, committed: 0, pushed: 0, unpublished: 0 });
  expect((await listAllLocalFiles(meta.id)).find((file) => file.path === "notes/old.md")).toBeUndefined();
  expect(octokit.createCommit).not.toHaveBeenCalled();
});
