import { beforeEach, describe, expect, it, vi } from "vitest";

const api = vi.hoisted(() => ({
  getRepository: vi.fn(), createRepository: vi.fn(), createFile: vi.fn(), deleteFile: vi.fn(), deleteRepository: vi.fn(), getAuthenticated: vi.fn(),
  getRef: vi.fn(), getCommit: vi.fn(), getTree: vi.fn(), getBlob: vi.fn(), createBlob: vi.fn(), createTree: vi.fn(), createCommit: vi.fn(), createRef: vi.fn(), updateRef: vi.fn(),
}));

vi.mock("@octokit/rest", () => ({
  Octokit: class {
    rest = {
      repos: { get: api.getRepository, createForAuthenticatedUser: api.createRepository, createOrUpdateFileContents: api.createFile, deleteFile: api.deleteFile, delete: api.deleteRepository },
      users: { getAuthenticated: api.getAuthenticated },
      git: { getRef: api.getRef, getCommit: api.getCommit, getTree: api.getTree, getBlob: api.getBlob, createBlob: api.createBlob, createTree: api.createTree, createCommit: api.createCommit, createRef: api.createRef, updateRef: api.updateRef },
    };
  },
}));

import { GitHubAccountRepositoryPublicError, GitHubAccountSyncBackend } from "@/account/sync/githubBackend";
import { ACCOUNT_SYNC_SCHEMA_VERSION, type LocalAccountSnapshot } from "@/account/types";
import { initialAccountManifest } from "@/account/vectorClock";
import { DEFAULT_SETTINGS } from "@/types/settings";
import { emptyCostsFile } from "@/costs/model";

const snapshot: LocalAccountSnapshot = {
  dirty: true,
  manifest: { ...initialAccountManifest("device-a"), vectorClock: { "device-a": 1 } },
  data: { schemaVersion: ACCOUNT_SYNC_SCHEMA_VERSION, settings: DEFAULT_SETTINGS, costs: emptyCostsFile(), clipboard: [], chats: [] },
};

function mockSuccessfulBootstrap(): void {
  api.createFile.mockResolvedValue({ data: { content: { sha: "marker" }, commit: { sha: "bootstrap" } } });
  api.getTree.mockResolvedValueOnce({ data: { truncated: false, tree: [{ type: "blob", path: ".narrarium-bootstrap", sha: "marker" }] } });
  api.getBlob.mockResolvedValueOnce({ data: { content: btoa("Narrarium account synchronization repository.\n") } });
}

describe("GitHub account sync backend", () => {
  beforeEach(() => {
    for (const mock of Object.values(api)) mock.mockReset();
  });

  it("refuses to put account data in a public narrarium.settings repository", async () => {
    api.getRepository.mockResolvedValue({ data: { private: false, default_branch: "main" } });
    await expect(new GitHubAccountSyncBackend("token", "writer").push(snapshot, { absent: true })).rejects.toBeInstanceOf(GitHubAccountRepositoryPublicError);
    expect(api.createBlob).not.toHaveBeenCalled();
  });

  it("creates a private repository and publishes one aggregated account commit", async () => {
    api.getRepository.mockRejectedValue({ status: 404 });
    api.getAuthenticated.mockResolvedValue({ data: { id: 12, login: "writer" } });
    api.createRepository.mockResolvedValue({ data: { private: true, default_branch: "main" } });
    api.getRef.mockRejectedValue({ status: 404 });
    mockSuccessfulBootstrap();
    api.createBlob.mockImplementation(async () => ({ data: { sha: crypto.randomUUID() } }));
    api.createTree.mockResolvedValue({ data: { sha: "tree" } });
    api.createCommit.mockResolvedValue({ data: { sha: "commit" } });
    api.updateRef.mockResolvedValue({ data: {} });

    await expect(new GitHubAccountSyncBackend("token", "writer").push(snapshot, { absent: true })).resolves.toEqual({ revision: "commit" });
    expect(api.createRepository).toHaveBeenCalledWith(expect.objectContaining({ name: "narrarium.settings", private: true, auto_init: false }));
    expect(api.createFile).toHaveBeenCalledWith(expect.objectContaining({ path: ".narrarium-bootstrap", message: "Initialize Narrarium account repository" }));
    expect(api.createFile.mock.invocationCallOrder[0]).toBeLessThan(api.createBlob.mock.invocationCallOrder[0]);
    expect(api.createCommit).toHaveBeenCalledTimes(1);
    expect(api.createCommit).toHaveBeenCalledWith(expect.objectContaining({ message: "Sync Narrarium account data", parents: ["bootstrap"] }));
    expect(api.updateRef).toHaveBeenCalledWith(expect.objectContaining({ ref: "heads/main", sha: "commit", force: false }));
  });

  it("bootstraps a private repository left empty by an interrupted first sync", async () => {
    api.getRepository.mockResolvedValue({ data: { private: true, default_branch: "main" } });
    api.getRef.mockRejectedValue({ status: 409 });
    mockSuccessfulBootstrap();
    api.createBlob.mockImplementation(async () => ({ data: { sha: crypto.randomUUID() } }));
    api.createTree.mockResolvedValue({ data: { sha: "tree" } });
    api.createCommit.mockResolvedValue({ data: { sha: "commit" } });
    api.updateRef.mockResolvedValue({ data: {} });

    await expect(new GitHubAccountSyncBackend("token", "writer").push(snapshot, { absent: true })).resolves.toEqual({ revision: "commit" });
    expect(api.createRepository).not.toHaveBeenCalled();
    expect(api.createFile).toHaveBeenCalledTimes(1);
    expect(api.createTree).toHaveBeenCalledWith(expect.not.objectContaining({ base_tree: expect.anything() }));
  });

  it("resumes safely when only Narrarium's bootstrap marker exists", async () => {
    api.getRepository.mockResolvedValue({ data: { private: true, default_branch: "main" } });
    api.getRef.mockResolvedValue({ data: { object: { sha: "bootstrap" } } });
    api.getTree.mockResolvedValue({ data: { truncated: false, tree: [{ type: "blob", path: ".narrarium-bootstrap", sha: "marker" }] } });
    api.getBlob.mockResolvedValue({ data: { content: btoa("Narrarium account synchronization repository.\n") } });
    api.createBlob.mockImplementation(async () => ({ data: { sha: crypto.randomUUID() } }));
    api.createTree.mockResolvedValue({ data: { sha: "tree" } });
    api.createCommit.mockResolvedValue({ data: { sha: "commit" } });
    api.updateRef.mockResolvedValue({ data: {} });

    await expect(new GitHubAccountSyncBackend("token", "writer").push(snapshot, { absent: true })).resolves.toEqual({ revision: "commit" });
    expect(api.createFile).not.toHaveBeenCalled();
    expect(api.createCommit).toHaveBeenCalledWith(expect.objectContaining({ parents: ["bootstrap"] }));
    expect(api.updateRef).toHaveBeenCalledWith(expect.objectContaining({ ref: "heads/main", sha: "commit", force: false }));
  });

  it("resumes when another client creates the same bootstrap marker concurrently", async () => {
    api.getRepository.mockResolvedValue({ data: { private: true, default_branch: "main" } });
    api.getRef.mockRejectedValueOnce({ status: 409 }).mockResolvedValueOnce({ data: { object: { sha: "bootstrap" } } });
    api.createFile.mockRejectedValue({ status: 422 });
    api.getTree.mockResolvedValue({ data: { truncated: false, tree: [{ type: "blob", path: ".narrarium-bootstrap", sha: "marker" }] } });
    api.getBlob.mockResolvedValue({ data: { content: btoa("Narrarium account synchronization repository.\n") } });
    api.createBlob.mockImplementation(async () => ({ data: { sha: crypto.randomUUID() } }));
    api.createTree.mockResolvedValue({ data: { sha: "tree" } });
    api.createCommit.mockResolvedValue({ data: { sha: "commit" } });
    api.updateRef.mockResolvedValue({ data: {} });

    await expect(new GitHubAccountSyncBackend("token", "writer").push(snapshot, { absent: true })).resolves.toEqual({ revision: "commit" });
    expect(api.getRef).toHaveBeenCalledTimes(2);
    expect(api.createCommit).toHaveBeenCalledWith(expect.objectContaining({ parents: ["bootstrap"] }));
  });

  it("stops and removes its marker if unrelated content appears during bootstrap", async () => {
    api.getRepository.mockResolvedValue({ data: { private: true, default_branch: "main" } });
    api.getRef.mockRejectedValue({ status: 409 });
    api.createFile.mockResolvedValue({ data: { content: { sha: "marker" }, commit: { sha: "bootstrap-on-unrelated" } } });
    api.getTree.mockResolvedValue({ data: { truncated: false, tree: [{ type: "blob", path: "README.md", sha: "readme" }, { type: "blob", path: ".narrarium-bootstrap", sha: "marker" }] } });
    api.deleteFile.mockResolvedValue({ data: {} });

    await expect(new GitHubAccountSyncBackend("token", "writer").push(snapshot, { absent: true })).rejects.toThrow("GitHub account repository changed before it could be updated.");
    expect(api.deleteFile).toHaveBeenCalledWith(expect.objectContaining({ path: ".narrarium-bootstrap", sha: "marker", branch: "main" }));
    expect(api.createBlob).not.toHaveBeenCalled();
  });

  it("keeps a valid marker recoverable when bootstrap verification fails transiently", async () => {
    api.getRepository.mockResolvedValue({ data: { private: true, default_branch: "main" } });
    api.getRef.mockRejectedValue({ status: 409 });
    api.createFile.mockResolvedValue({ data: { content: { sha: "marker" }, commit: { sha: "bootstrap" } } });
    api.getTree.mockRejectedValue(new Error("temporary network failure"));

    await expect(new GitHubAccountSyncBackend("token", "writer").push(snapshot, { absent: true })).rejects.toThrow("temporary network failure");
    expect(api.deleteFile).not.toHaveBeenCalled();
    expect(api.createBlob).not.toHaveBeenCalled();
  });

  it("rejects unrelated content discovered after a concurrent bootstrap conflict", async () => {
    api.getRepository.mockResolvedValue({ data: { private: true, default_branch: "main" } });
    api.getRef.mockRejectedValueOnce({ status: 409 }).mockResolvedValueOnce({ data: { object: { sha: "unrelated" } } });
    api.createFile.mockRejectedValue({ status: 422 });
    api.getTree.mockResolvedValue({ data: { truncated: false, tree: [{ type: "blob", path: "README.md", sha: "readme" }] } });

    await expect(new GitHubAccountSyncBackend("token", "writer").push(snapshot, { absent: true })).rejects.toThrow("GitHub account repository changed before it could be updated.");
    expect(api.createBlob).not.toHaveBeenCalled();
  });

  it("updates a matching existing account snapshot without bootstrapping", async () => {
    api.getRepository.mockResolvedValue({ data: { private: true, default_branch: "main" } });
    api.getRef.mockResolvedValue({ data: { object: { sha: "previous" } } });
    api.getCommit.mockResolvedValue({ data: { tree: { sha: "previous-tree" } } });
    api.getTree.mockResolvedValue({ data: { truncated: false, tree: [{ type: "blob", path: "manifest.json", sha: "manifest" }] } });
    api.createBlob.mockImplementation(async () => ({ data: { sha: crypto.randomUUID() } }));
    api.createTree.mockResolvedValue({ data: { sha: "tree" } });
    api.createCommit.mockResolvedValue({ data: { sha: "commit" } });
    api.updateRef.mockResolvedValue({ data: {} });

    await expect(new GitHubAccountSyncBackend("token", "writer").push(snapshot, { absent: false, revision: "previous" })).resolves.toEqual({ revision: "commit" });
    expect(api.createFile).not.toHaveBeenCalled();
    expect(api.createTree).toHaveBeenCalledWith(expect.objectContaining({ base_tree: "previous-tree" }));
    expect(api.updateRef).toHaveBeenCalledWith(expect.objectContaining({ ref: "heads/main", sha: "commit", force: false }));
  });

  it("does not adopt a non-empty repository when the remote snapshot was expected to be absent", async () => {
    api.getRepository.mockResolvedValue({ data: { private: true, default_branch: "main" } });
    api.getRef.mockResolvedValue({ data: { object: { sha: "unrelated" } } });
    api.getTree.mockResolvedValue({ data: { truncated: false, tree: [{ type: "blob", path: "README.md", sha: "readme" }] } });

    await expect(new GitHubAccountSyncBackend("token", "writer").push(snapshot, { absent: true })).rejects.toThrow("GitHub account repository changed before it could be updated.");
    expect(api.createFile).not.toHaveBeenCalled();
    expect(api.createBlob).not.toHaveBeenCalled();
  });
});
