import "fake-indexeddb/auto";
import { afterEach, beforeEach, expect, test, vi } from "vitest";

// The full sync says what it is doing while it runs (the resolver of the conflicts shows it), and a stop is honoured only while it has changed nothing.

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
    input.signal?.throwIfAborted();
    const binary = atob(blob.data.content.replace(/\n/g, ""));
    const bytes = Uint8Array.from(binary, (character) => character.charCodeAt(0));
    input.meter.add(input.kind, bytes.byteLength);
    return bytes;
  }),
}));

import { localWorkspaceScope, resetLocalWorkspaceIdentityForTests } from "@/account/deviceIdentity";
import { RepositorySyncConflictError, syncFullRepository, withRepositoryMutationLease, type RepositorySyncConflictChoice, type RepositorySyncProgress } from "@/repository/repositoryService";
import { captureRepositoryOperationScope } from "@/repository/repositoryOperationScope";
import { getLocalRepositoryById, listAllLocalFiles, listLocalRecoverySnapshots, listUnpushedLocalCommits, putCleanLocalFile, putLocalRepository, writeLocalText } from "@/repository/localRepository";

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
afterEach(() => vi.clearAllMocks());

/** A copy with a change of this device to `state.json`, which GitHub changed too, and a plot GitHub changed alone. */
async function conflictedCopy() {
  const scope = captureRepositoryOperationScope();
  const target = { bookId: "book", owner: "owner", repo: "repo", branch: "main", accountIdentity: localWorkspaceScope() };
  const meta = await putLocalRepository({ ...target, defaultBranch: "main", remoteHeadSha: "base-head", clonedAt: new Date().toISOString(), cloneComplete: true }, scope);
  await putCleanLocalFile({ repoId: meta.id, path: "autopilot/state.json", kind: "text", text: "{\"version\":1}\n", baseSha: "state-base", size: 14 }, scope);
  await putCleanLocalFile({ repoId: meta.id, path: "plot.md", kind: "text", text: "plot\n", baseSha: "plot-base", size: 5 }, scope);
  await writeLocalText(meta.id, "autopilot/state.json", "{\"version\":2}\n", scope);
  octokit.getRef.mockResolvedValue({ data: { object: { sha: "remote-head" } } });
  octokit.getCommit.mockImplementation(async ({ commit_sha }: { commit_sha: string }) => ({ data: { tree: { sha: `tree-of-${commit_sha}` } } }));
  octokit.getTree.mockResolvedValue({ data: { truncated: false, tree: [{ type: "blob", path: "autopilot/state.json", sha: "state-remote" }, { type: "blob", path: "plot.md", sha: "plot-remote" }] } });
  octokit.getBlob.mockImplementation(async ({ file_sha }: { file_sha: string }) => ({ data: { encoding: "base64", content: btoa(file_sha === "plot-remote" ? "new plot\n" : "{\"version\":3}\n") } }));
  const conflict = await syncFullRepository({ ...target, token: "token" }).then(() => null, (error: unknown) => error);
  expect(conflict).toBeInstanceOf(RepositorySyncConflictError);
  const [file] = (conflict as RepositorySyncConflictError).conflicts;
  const keepLocal: Record<string, RepositorySyncConflictChoice> = { [file.path]: { choice: "local", expectedLocalHash: file.localHash, expectedRemoteSha: file.remoteSha, expectedLocalDeleted: file.localDeleted, expectedRemoteDeleted: file.remoteDeleted, expectedLocalBaseSha: file.localBaseSha, expectedLocalChanged: file.localChanged } };
  octokit.createBlob.mockResolvedValue({ data: { sha: "state-local" } });
  octokit.createTree.mockResolvedValue({ data: { sha: "tree-local" } });
  octokit.createCommit.mockResolvedValue({ data: { sha: "local-head" } });
  octokit.updateRef.mockResolvedValue({ data: {} });
  octokit.getRef.mockReset();
  octokit.getRef.mockResolvedValueOnce({ data: { object: { sha: "remote-head" } } }).mockResolvedValueOnce({ data: { object: { sha: "remote-head" } } }).mockResolvedValue({ data: { object: { sha: "local-head" } } });
  return { meta, target, keepLocal };
}

test("a sync with the author's choices says each step in order, with the files it downloads and publishes", async () => {
  const { target, keepLocal } = await conflictedCopy();
  const steps: RepositorySyncProgress[] = [];

  const result = await syncFullRepository({ ...target, token: "token", conflictResolutions: keepLocal, onProgress: (progress) => steps.push(progress) });

  expect(result).toMatchObject({ pulled: 1, keptLocal: 1, committed: 1, pushed: 1, unpublished: 0 });
  expect(steps).toEqual([
    { step: "checking" },
    { step: "downloading", done: 0, total: 1 },
    { step: "downloading", done: 1, total: 1 },
    { step: "merging" },
    { step: "committing" },
    { step: "publishing" },
    { step: "publishing", done: 1, total: 1 },
  ]);
});

test("a stop while GitHub's versions download changes nothing on this device", async () => {
  const { meta, target, keepLocal } = await conflictedCopy();
  const before = await listAllLocalFiles(meta.id);
  const beforeMeta = await getLocalRepositoryById(meta.id, localWorkspaceScope());
  const stop = new AbortController();
  octokit.getBlob.mockImplementation(async () => {
    stop.abort();
    return { data: { encoding: "base64", content: btoa("new plot\n") } };
  });

  await expect(syncFullRepository({ ...target, token: "token", conflictResolutions: keepLocal, signal: stop.signal })).rejects.toMatchObject({ kind: "abort" });

  expect(await listAllLocalFiles(meta.id)).toEqual(before);
  expect(await listUnpushedLocalCommits(meta.id)).toEqual([]);
  expect(await listLocalRecoverySnapshots(meta.id, localWorkspaceScope())).toEqual([]);
  expect(await getLocalRepositoryById(meta.id, localWorkspaceScope())).toMatchObject({ remoteHeadSha: beforeMeta!.remoteHeadSha, remoteStatus: beforeMeta!.remoteStatus });
  expect(octokit.createBlob).not.toHaveBeenCalled();
});

test("a stop asked once the merge started is ignored: the sync publishes to the end", async () => {
  const { target, keepLocal } = await conflictedCopy();
  const stop = new AbortController();
  octokit.createBlob.mockImplementation(async () => {
    stop.abort();
    return { data: { sha: "state-local" } };
  });

  await expect(syncFullRepository({ ...target, token: "token", conflictResolutions: keepLocal, signal: stop.signal })).resolves.toMatchObject({ keptLocal: 1, committed: 1, pushed: 1, unpublished: 0 });
  expect(octokit.updateRef).toHaveBeenCalledTimes(1);
});

test("a sync that waits for another operation on the working copy says so, then runs", async () => {
  const { meta, target, keepLocal } = await conflictedCopy();
  let release!: () => void;
  const held = withRepositoryMutationLease(meta.id, () => new Promise<void>((resolve) => { release = resolve; }));
  const steps: string[] = [];

  const running = syncFullRepository({ ...target, token: "token", conflictResolutions: keepLocal, onProgress: (progress) => steps.push(progress.step) });
  await vi.waitFor(() => expect(steps).toEqual(["waiting"]), { timeout: 10_000 });
  release();
  await held;
  await expect(running).resolves.toMatchObject({ pushed: 1 });
  expect(steps.slice(0, 2)).toEqual(["waiting", "checking"]);
});
