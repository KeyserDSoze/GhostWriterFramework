import "fake-indexeddb/auto";
import { afterEach, expect, test, vi } from "vitest";

const git = vi.hoisted(() => ({ getRef: vi.fn(), getCommit: vi.fn(), getTree: vi.fn(), createBlob: vi.fn(), createTree: vi.fn(), createCommit: vi.fn(), updateRef: vi.fn() }));
vi.mock("@octokit/rest", () => ({ Octokit: class { rest = { git, repos: {} }; } }));

import { getLocalFile, listUnpushedLocalCommits, mutateLocalTextFilesAndCreateCommitAtomically, putCleanLocalFile, putLocalRepository, removeLocalRepository } from "@/repository/localRepository";
import { syncFullRepository } from "@/repository/repositoryService";
import { captureRepositoryOperationScope } from "@/repository/repositoryOperationScope";
import { useAuthStore } from "@/store/authStore";

const identity = "google:sync-limit-transport";
const target = { bookId: "book", owner: "owner", repo: "repo", branch: "main", accountIdentity: identity };
let repoId = "";
useAuthStore.setState({ user: { provider: "google", providerAccountId: "sync-limit-transport", name: "Writer", email: "writer@example.com", picture: "" } });

afterEach(async () => {
  vi.clearAllMocks();
  vi.unstubAllGlobals();
  if (repoId) await removeLocalRepository(repoId, captureRepositoryOperationScope()).catch(() => undefined);
  repoId = "";
});

test("production streaming transport preserves local commits on oversized full sync", async () => {
  const scope = captureRepositoryOperationScope();
  const meta = await putLocalRepository({ ...target, defaultBranch: "main", remoteHeadSha: "base-head", clonedAt: new Date().toISOString(), cloneComplete: true, cloneStatus: "complete" }, scope);
  repoId = meta.id;
  await putCleanLocalFile({ repoId, path: "plot.md", kind: "text", text: "base", baseSha: "plot-base", size: 4 });
  const base = await getLocalFile(repoId, "plot.md", scope);
  await mutateLocalTextFilesAndCreateCommitAtomically(repoId, scope, "local work", [{ path: "plot.md", content: "local", expectedCurrentHash: base!.currentHash }]);

  git.getRef.mockResolvedValue({ data: { object: { sha: "remote-head" } } });
  git.getCommit.mockImplementation(async ({ commit_sha }: { commit_sha: string }) => ({ data: { tree: { sha: `${commit_sha}-tree` } } }));
  git.getTree.mockResolvedValue({ data: { truncated: false, tree: [{ type: "blob", path: "oversized.md", sha: "oversized" }] } });
  const chunk = new Uint8Array(1024 * 1024 + 1);
  vi.stubGlobal("fetch", vi.fn(async () => new Response(new ReadableStream<Uint8Array>({ start(controller) { controller.enqueue(chunk); controller.enqueue(chunk); controller.close(); } }), { headers: { "content-type": "application/octet-stream" } })));

  await expect(syncFullRepository({ ...target, token: "token" })).rejects.toMatchObject({ kind: "limit-exceeded" });
  expect((await listUnpushedLocalCommits(repoId)).map((commit) => commit.message)).toEqual(["local work"]);
  expect(await getLocalFile(repoId, "plot.md", scope)).toMatchObject({ text: "local", committed: true });
  expect(git.createBlob).not.toHaveBeenCalled();
  expect(git.updateRef).not.toHaveBeenCalled();
});

test("measured transfer obeys available quota even when tree metadata omits size", async () => {
  const scope = captureRepositoryOperationScope();
  const meta = await putLocalRepository({ ...target, defaultBranch: "main", remoteHeadSha: "base-head", clonedAt: new Date().toISOString(), cloneComplete: true, cloneStatus: "complete" }, scope);
  repoId = meta.id;
  git.getRef.mockResolvedValue({ data: { object: { sha: "remote-head" } } });
  git.getCommit.mockImplementation(async ({ commit_sha }: { commit_sha: string }) => ({ data: { tree: { sha: `${commit_sha}-tree` } } }));
  git.getTree.mockResolvedValue({ data: { truncated: false, tree: [{ type: "blob", path: "small.md", sha: "small-without-size" }] } });
  vi.stubGlobal("navigator", { onLine: true, storage: { estimate: async () => ({ quota: 100, usage: 96 }) } });
  vi.stubGlobal("fetch", vi.fn(async () => new Response(new ReadableStream<Uint8Array>({ start(controller) { controller.enqueue(new TextEncoder().encode("12345")); controller.close(); } }), { headers: { "content-type": "application/octet-stream" } })));
  await expect(syncFullRepository({ ...target, token: "token" })).rejects.toMatchObject({ kind: "limit-exceeded" });
  expect(await listUnpushedLocalCommits(repoId)).toEqual([]);
});
