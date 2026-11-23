import { createGitHubClient } from "@/github/githubClient";
import { CopyHttpError, retryAfterOf } from "../classify";
import { COPY_GITHUB_BRANCH, CopyError } from "../types";
import type { GitHubCopyApi } from "./github";

function base64(bytes: Uint8Array): string {
  let out = "";
  const step = 0x8000;
  for (let index = 0; index < bytes.length; index += step) out += String.fromCharCode(...bytes.subarray(index, index + step));
  return btoa(out);
}

/** An Octokit error as the copier classifies it: the status, the wait the service asked for, and a message without the request. */
function rethrow(error: unknown): never {
  const value = error as { status?: number; message?: string; response?: { headers?: Record<string, unknown> } };
  if (typeof value?.status === "number") {
    if (value.status === 409 && /empty/i.test(value.message ?? "")) throw new CopyError("unavailable", "The repository is empty: make a first commit in it, then choose GitHub again.", { cause: error });
    throw new CopyHttpError(value.status, value.message ?? `GitHub answered ${value.status}`, retryAfterOf(value.response?.headers));
  }
  throw error;
}

/** `GitHubCopyApi` over the site's GitHub client and the book's token: the Git Data API, on a branch of the book's own repository. */
export class OctokitGitHubApi implements GitHubCopyApi {
  private readonly octokit;
  constructor(token: string, private readonly owner: string, private readonly repo: string) {
    this.octokit = createGitHubClient(token, { owner, repo, branch: COPY_GITHUB_BRANCH });
  }
  private get target() { return { owner: this.owner, repo: this.repo }; }

  async getRepository(): Promise<{ private: boolean }> {
    try { return { private: (await this.octokit.rest.repos.get(this.target)).data.private }; } catch (error) { return rethrow(error); }
  }
  async getBranchHead(branch: string): Promise<{ commitSha: string; treeSha: string } | null> {
    try {
      const ref = await this.octokit.rest.git.getRef({ ...this.target, ref: `heads/${branch}` });
      const commit = await this.octokit.rest.git.getCommit({ ...this.target, commit_sha: ref.data.object.sha });
      return { commitSha: ref.data.object.sha, treeSha: commit.data.tree.sha };
    } catch (error) {
      if ((error as { status?: number }).status === 404) return null;
      return rethrow(error);
    }
  }
  async createBlob(bytes: Uint8Array): Promise<string> {
    try { return (await this.octokit.rest.git.createBlob({ ...this.target, content: base64(bytes), encoding: "base64" })).data.sha; } catch (error) { return rethrow(error); }
  }
  async createTree(baseTree: string | null, entries: Array<{ path: string; blobSha: string }>): Promise<string> {
    try {
      return (await this.octokit.rest.git.createTree({
        ...this.target,
        ...(baseTree ? { base_tree: baseTree } : {}),
        tree: entries.map((entry) => ({ path: entry.path, mode: "100644" as const, type: "blob" as const, sha: entry.blobSha })),
      })).data.sha;
    } catch (error) { return rethrow(error); }
  }
  async createCommit(message: string, treeSha: string, parents: string[]): Promise<string> {
    try { return (await this.octokit.rest.git.createCommit({ ...this.target, message, tree: treeSha, parents })).data.sha; } catch (error) { return rethrow(error); }
  }
  async createBranch(branch: string, commitSha: string): Promise<void> {
    try { await this.octokit.rest.git.createRef({ ...this.target, ref: `refs/heads/${branch}`, sha: commitSha }); } catch (error) { rethrow(error); }
  }
  async updateBranch(branch: string, commitSha: string): Promise<void> {
    try { await this.octokit.rest.git.updateRef({ ...this.target, ref: `heads/${branch}`, sha: commitSha, force: false }); } catch (error) { rethrow(error); }
  }
  async deleteBranch(branch: string): Promise<void> {
    try { await this.octokit.rest.git.deleteRef({ ...this.target, ref: `heads/${branch}` }); } catch (error) {
      if ((error as { status?: number }).status === 404 || (error as { status?: number }).status === 422) return;
      rethrow(error);
    }
  }
}
