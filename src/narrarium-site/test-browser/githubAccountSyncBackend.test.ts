import { beforeEach, describe, expect, it, vi } from "vitest";

const api = vi.hoisted(() => ({
  getRepository: vi.fn(), createRepository: vi.fn(), deleteRepository: vi.fn(), getAuthenticated: vi.fn(),
  getRef: vi.fn(), getCommit: vi.fn(), getTree: vi.fn(), getBlob: vi.fn(), createBlob: vi.fn(), createTree: vi.fn(), createCommit: vi.fn(), createRef: vi.fn(), updateRef: vi.fn(),
}));

vi.mock("@octokit/rest", () => ({
  Octokit: class {
    rest = {
      repos: { get: api.getRepository, createForAuthenticatedUser: api.createRepository, delete: api.deleteRepository },
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

describe("GitHub account sync backend", () => {
  beforeEach(() => {
    for (const mock of Object.values(api)) mock.mockReset();
  });

  it("refuses to put account data in a public narrarium.settings repository", async () => {
    api.getRepository.mockResolvedValue({ data: { private: false, default_branch: "main" } });
    await expect(new GitHubAccountSyncBackend("token", "writer").push(snapshot, { absent: true })).rejects.toBeInstanceOf(GitHubAccountRepositoryPublicError);
    expect(api.createBlob).not.toHaveBeenCalled();
  });

  it("creates a private repository and publishes one aggregated commit", async () => {
    api.getRepository.mockRejectedValue({ status: 404 });
    api.getAuthenticated.mockResolvedValue({ data: { id: 12, login: "writer" } });
    api.createRepository.mockResolvedValue({ data: { private: true, default_branch: "main" } });
    api.getRef.mockRejectedValue({ status: 404 });
    api.createBlob.mockImplementation(async () => ({ data: { sha: crypto.randomUUID() } }));
    api.createTree.mockResolvedValue({ data: { sha: "tree" } });
    api.createCommit.mockResolvedValue({ data: { sha: "commit" } });
    api.createRef.mockResolvedValue({ data: {} });

    await expect(new GitHubAccountSyncBackend("token", "writer").push(snapshot, { absent: true })).resolves.toEqual({ revision: "commit" });
    expect(api.createRepository).toHaveBeenCalledWith(expect.objectContaining({ name: "narrarium.settings", private: true, auto_init: false }));
    expect(api.createCommit).toHaveBeenCalledTimes(1);
    expect(api.createCommit).toHaveBeenCalledWith(expect.objectContaining({ message: "Sync Narrarium account data" }));
    expect(api.createRef).toHaveBeenCalledWith(expect.objectContaining({ ref: "refs/heads/main", sha: "commit" }));
  });
});
