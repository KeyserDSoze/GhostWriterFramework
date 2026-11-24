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

import { GitHubAccountRepositoryPublicError, GitHubAccountRepositoryUnreachableError, GitHubAccountSyncBackend } from "@/account/sync/githubBackend";
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

  describe("with the token of the GitHub app", () => {
    const app = () => new GitHubAccountSyncBackend("ghu_app", "writer", "app");
    const forbidden = { status: 403, message: "Resource not accessible by integration" };

    it("creates narrarium.settings as a private repository when it does not exist, and publishes to it", async () => {
      api.getRepository.mockRejectedValue({ status: 404 });
      api.getAuthenticated.mockResolvedValue({ data: { id: 12, login: "writer" } });
      api.createRepository.mockResolvedValue({ data: { private: true, default_branch: "main" } });
      api.getRef.mockRejectedValue({ status: 404 });
      mockSuccessfulBootstrap();
      api.createBlob.mockImplementation(async () => ({ data: { sha: crypto.randomUUID() } }));
      api.createTree.mockResolvedValue({ data: { sha: "tree" } });
      api.createCommit.mockResolvedValue({ data: { sha: "commit" } });
      api.updateRef.mockResolvedValue({ data: {} });
      await expect(app().push(snapshot, { absent: true })).resolves.toEqual({ revision: "commit" });
      expect(api.createRepository).toHaveBeenCalledWith(expect.objectContaining({ name: "narrarium.settings", private: true }));
    });

    it("says the app cannot create the repository when GitHub refuses (403) or does not know the route (404)", async () => {
      for (const refusal of [forbidden, { status: 404 }]) {
        for (const mock of Object.values(api)) mock.mockReset();
        api.getRepository.mockRejectedValue({ status: 404 });
        api.getAuthenticated.mockResolvedValue({ data: { id: 12, login: "writer" } });
        api.createRepository.mockRejectedValue(refusal);
        const failure = await app().push(snapshot, { absent: true }).catch((error: unknown) => error);
        expect(failure).toBeInstanceOf(GitHubAccountRepositoryUnreachableError);
        expect(failure).toMatchObject({ code: "GITHUB_ACCOUNT_REPOSITORY_UNREACHABLE", reason: "create-refused" });
        expect(api.createBlob).not.toHaveBeenCalled();
      }
    });

    it("says the app does not reach a narrarium.settings that exists (hidden from it, and its name taken)", async () => {
      api.getRepository.mockRejectedValue({ status: 404 });
      api.getAuthenticated.mockResolvedValue({ data: { id: 12, login: "writer" } });
      api.createRepository.mockRejectedValue({ status: 422, message: "name already exists on this account" });
      await expect(app().push(snapshot, { absent: true })).rejects.toMatchObject({ code: "GITHUB_ACCOUNT_REPOSITORY_UNREACHABLE", reason: "exists-not-shared" });
      expect(api.createBlob).not.toHaveBeenCalled();
    });

    it("reading it for the first time is not an error: a missing repository is just absent", async () => {
      api.getRepository.mockRejectedValue({ status: 404 });
      await expect(app().pull()).resolves.toBeNull();
      expect(api.createRepository).not.toHaveBeenCalled();
    });

    it("says the same when the repository was created but the app has no access to write to it", async () => {
      api.getRepository.mockRejectedValue({ status: 404 });
      api.getAuthenticated.mockResolvedValue({ data: { id: 12, login: "writer" } });
      api.createRepository.mockResolvedValue({ data: { private: true, default_branch: "main" } });
      api.getRef.mockRejectedValue({ status: 404 });
      api.createFile.mockRejectedValue({ status: 404 });
      await expect(app().push(snapshot, { absent: true })).rejects.toMatchObject({ code: "GITHUB_ACCOUNT_REPOSITORY_UNREACHABLE", reason: "no-access" });
      expect(api.createBlob).not.toHaveBeenCalled();
    });

    it("says the same when GitHub refuses the app to read the repository", async () => {
      api.getRepository.mockRejectedValue(forbidden);
      await expect(app().pull()).rejects.toBeInstanceOf(GitHubAccountRepositoryUnreachableError);
    });

    it("does not take a limit on requests for a refusal", async () => {
      const limited = Object.assign(new Error("API rate limit exceeded"), { status: 403, response: { headers: { "x-ratelimit-remaining": "0" } } });
      api.getRepository.mockRejectedValue(limited);
      await expect(app().pull()).rejects.toBe(limited);
    });

    it("still refuses a public repository", async () => {
      api.getRepository.mockResolvedValue({ data: { private: false, default_branch: "main" } });
      await expect(app().push(snapshot, { absent: true })).rejects.toBeInstanceOf(GitHubAccountRepositoryPublicError);
      expect(api.createBlob).not.toHaveBeenCalled();
    });

    it("leaves a personal access token's refusal as the permission error it is", async () => {
      api.getRepository.mockRejectedValue({ status: 404 });
      api.getAuthenticated.mockResolvedValue({ data: { id: 12, login: "writer" } });
      api.createRepository.mockRejectedValue(forbidden);
      await expect(new GitHubAccountSyncBackend("ghp_pat", "writer", "pat").push(snapshot, { absent: true })).rejects.toBe(forbidden);
    });
  });
});
