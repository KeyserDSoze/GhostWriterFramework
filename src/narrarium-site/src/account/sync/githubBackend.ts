import { Octokit } from "@octokit/rest";
import type { AccountRemoteExpectation, AccountRemoteSnapshot, AccountSyncBackend, LocalAccountSnapshot, SyncableAccountData } from "@/account/types";
import { accountContentHash } from "@/account/vectorClock";
import { parseAccountRepositoryFiles, serializeAccountRepository } from "@/account/serialization";
import { RepositoryByteMeter, utf8Bytes } from "@/repository/repositoryLimits";

export const GITHUB_ACCOUNT_REPOSITORY = "narrarium.settings" as const;
const BOOTSTRAP_PATH = ".narrarium-bootstrap";
const BOOTSTRAP_CONTENT = "Narrarium account synchronization repository.\n";
const MANAGED_PATH = /^(?:manifest\.json|settings\.json|books\.json|costs\.json|clipboard\.json|chats\/[^/]+\.json|chat-segments\/[^/]+\/[^/]+\.json)$/;

export class GitHubAccountRepositoryPublicError extends Error {
  readonly code = "GITHUB_ACCOUNT_REPOSITORY_PUBLIC";
  constructor() {
    super("The narrarium.settings repository is public. Account sync is blocked until it is private.");
    this.name = "GitHubAccountRepositoryPublicError";
  }
}

export class GitHubAccountSyncBackend implements AccountSyncBackend {
  readonly kind = "github" as const;
  private readonly octokit: Octokit;

  constructor(token: string, private readonly owner: string) {
    this.octokit = new Octokit({ auth: token });
  }

  async pull(): Promise<AccountRemoteSnapshot | null> {
    const repository = await this.repository(false);
    if (!repository) return null;
    const branch = repository.default_branch || "main";
    let ref;
    try { ref = await this.octokit.rest.git.getRef({ owner: this.owner, repo: GITHUB_ACCOUNT_REPOSITORY, ref: `heads/${branch}` }); }
    catch (error) { if (statusOf(error) === 409 || statusOf(error) === 404) return null; throw error; }
    const tree = await this.octokit.rest.git.getTree({ owner: this.owner, repo: GITHUB_ACCOUNT_REPOSITORY, tree_sha: ref.data.object.sha, recursive: "1" });
    if (tree.data.truncated) throw new Error("GitHub account repository tree is truncated.");
    const entries = tree.data.tree.filter((entry) => entry.type === "blob" && entry.path && entry.sha && MANAGED_PATH.test(entry.path));
    if (!entries.some((entry) => entry.path === "manifest.json")) return null;
    const meter = new RepositoryByteMeter("transfer");
    const files = new Map<string, string>();
    for (const entry of entries) {
      const response = await this.octokit.rest.git.getBlob({ owner: this.owner, repo: GITHUB_ACCOUNT_REPOSITORY, file_sha: entry.sha! });
      const bytes = decodeBase64(response.data.content.replace(/\s/g, ""));
      meter.add("binary", bytes.byteLength);
      files.set(entry.path!, new TextDecoder().decode(bytes));
    }
    const envelope = parseAccountRepositoryFiles(files);
    await assertHash(envelope.data, envelope.manifest.contentHash);
    return { backend: "github", ...envelope, revision: ref.data.object.sha, sizeBytes: meter.measuredBytes };
  }

  async push(snapshot: LocalAccountSnapshot, expected: AccountRemoteExpectation): Promise<{ revision?: string }> {
    const serialized = await serializeAccountRepository(snapshot);
    const repository = await this.repository(true);
    if (!repository) throw new Error("GitHub account repository could not be created.");
    const branch = repository.default_branch || "main";
    const meter = new RepositoryByteMeter("mutation");
    for (const content of serialized.files.values()) meter.add("text", utf8Bytes(content));

    let headSha: string | null = null;
    let baseTree: string | undefined;
    let previousManaged: string[] = [];
    let ref;
    try {
      ref = await this.octokit.rest.git.getRef({ owner: this.owner, repo: GITHUB_ACCOUNT_REPOSITORY, ref: `heads/${branch}` });
    } catch (error) {
      if (statusOf(error) !== 404 && statusOf(error) !== 409) throw error;
      if (!expected.absent) throw new Error("GitHub account repository was deleted before it could be updated.");
      headSha = await this.bootstrapEmptyRepository(branch);
    }

    if (ref) {
      headSha = ref.data.object.sha;
      if (expected.absent) {
        if (!await this.isBootstrapCommit(headSha)) throw new Error("GitHub account repository changed before it could be updated.");
      } else {
        if (!expected.revision || expected.revision !== headSha) throw new Error("GitHub account repository changed before it could be updated.");
        try {
          const commit = await this.octokit.rest.git.getCommit({ owner: this.owner, repo: GITHUB_ACCOUNT_REPOSITORY, commit_sha: headSha });
          baseTree = commit.data.tree.sha;
          const currentTree = await this.octokit.rest.git.getTree({ owner: this.owner, repo: GITHUB_ACCOUNT_REPOSITORY, tree_sha: headSha, recursive: "1" });
          if (currentTree.data.truncated) throw new Error("GitHub account repository tree is truncated.");
          previousManaged = currentTree.data.tree.filter((entry) => entry.type === "blob" && entry.path && MANAGED_PATH.test(entry.path)).map((entry) => entry.path!);
        } catch (error) {
          if (statusOf(error) === 404 || statusOf(error) === 409) throw new Error("GitHub account repository was deleted before it could be updated.");
          throw error;
        }
      }
    }

    const blobs = new Map<string, string>();
    for (const [path, content] of serialized.files) {
      const blob = await this.octokit.rest.git.createBlob({ owner: this.owner, repo: GITHUB_ACCOUNT_REPOSITORY, content: encodeBase64(content), encoding: "base64" });
      blobs.set(path, blob.data.sha);
    }
    const treeEntries = [
      ...[...blobs].map(([path, sha]) => ({ path, mode: "100644" as const, type: "blob" as const, sha })),
      ...previousManaged.filter((path) => !blobs.has(path)).map((path) => ({ path, mode: "100644" as const, type: "blob" as const, sha: null })),
    ];
    const tree = await this.octokit.rest.git.createTree({ owner: this.owner, repo: GITHUB_ACCOUNT_REPOSITORY, ...(baseTree ? { base_tree: baseTree } : {}), tree: treeEntries });
    const commit = await this.octokit.rest.git.createCommit({
      owner: this.owner,
      repo: GITHUB_ACCOUNT_REPOSITORY,
      message: "Sync Narrarium account data",
      tree: tree.data.sha,
      parents: headSha ? [headSha] : [],
    });
    if (headSha) await this.octokit.rest.git.updateRef({ owner: this.owner, repo: GITHUB_ACCOUNT_REPOSITORY, ref: `heads/${branch}`, sha: commit.data.sha, force: false });
    else await this.octokit.rest.git.createRef({ owner: this.owner, repo: GITHUB_ACCOUNT_REPOSITORY, ref: `refs/heads/${branch}`, sha: commit.data.sha });
    return { revision: commit.data.sha };
  }

  async deleteRemoteData(): Promise<void> {
    const repository = await this.repository(false);
    if (!repository) return;
    await this.octokit.rest.repos.delete({ owner: this.owner, repo: GITHUB_ACCOUNT_REPOSITORY });
  }

  private async repository(create: boolean): Promise<{ private: boolean; default_branch: string } | null> {
    try {
      const response = await this.octokit.rest.repos.get({ owner: this.owner, repo: GITHUB_ACCOUNT_REPOSITORY });
      if (!response.data.private) throw new GitHubAccountRepositoryPublicError();
      return { private: response.data.private, default_branch: response.data.default_branch || "main" };
    } catch (error) {
      if (error instanceof GitHubAccountRepositoryPublicError) throw error;
      if (statusOf(error) !== 404 || !create) return statusOf(error) === 404 ? null : Promise.reject(error);
      const authenticated = await this.octokit.rest.users.getAuthenticated();
      if (String(authenticated.data.login).toLocaleLowerCase() !== this.owner.toLocaleLowerCase()) throw new Error("GitHub account repository can only be created for the authenticated user.");
      const created = await this.octokit.rest.repos.createForAuthenticatedUser({ name: GITHUB_ACCOUNT_REPOSITORY, private: true, auto_init: false, description: "Private Narrarium account synchronization data" });
      if (!created.data.private) throw new GitHubAccountRepositoryPublicError();
      return { private: true, default_branch: created.data.default_branch || "main" };
    }
  }

  private async bootstrapEmptyRepository(branch: string): Promise<string> {
    let response;
    try {
      response = await this.octokit.rest.repos.createOrUpdateFileContents({
        owner: this.owner,
        repo: GITHUB_ACCOUNT_REPOSITORY,
        path: BOOTSTRAP_PATH,
        message: "Initialize Narrarium account repository",
        content: encodeBase64(BOOTSTRAP_CONTENT),
      });
    } catch (error) {
      if (statusOf(error) !== 409 && statusOf(error) !== 422) throw error;
      const ref = await this.octokit.rest.git.getRef({ owner: this.owner, repo: GITHUB_ACCOUNT_REPOSITORY, ref: `heads/${branch}` });
      if (!await this.isBootstrapCommit(ref.data.object.sha)) throw new Error("GitHub account repository changed before it could be updated.");
      return ref.data.object.sha;
    }
    if (!response.data.commit.sha) throw new Error("GitHub did not return the initial account repository commit.");
    if (!await this.isBootstrapCommit(response.data.commit.sha)) {
      await this.removeBootstrapMarker(response.data.content?.sha, branch);
      throw new Error("GitHub account repository changed before it could be updated.");
    }
    return response.data.commit.sha;
  }

  private async isBootstrapCommit(commitSha: string): Promise<boolean> {
    const tree = await this.octokit.rest.git.getTree({ owner: this.owner, repo: GITHUB_ACCOUNT_REPOSITORY, tree_sha: commitSha, recursive: "1" });
    if (tree.data.truncated || tree.data.tree.length !== 1) return false;
    const marker = tree.data.tree[0];
    if (marker.type !== "blob" || marker.path !== BOOTSTRAP_PATH || !marker.sha) return false;
    const blob = await this.octokit.rest.git.getBlob({ owner: this.owner, repo: GITHUB_ACCOUNT_REPOSITORY, file_sha: marker.sha });
    return new TextDecoder().decode(decodeBase64(blob.data.content.replace(/\s/g, ""))) === BOOTSTRAP_CONTENT;
  }

  private async removeBootstrapMarker(sha: string | undefined, branch: string): Promise<void> {
    if (!sha) return;
    try {
      await this.octokit.rest.repos.deleteFile({ owner: this.owner, repo: GITHUB_ACCOUNT_REPOSITORY, path: BOOTSTRAP_PATH, message: "Remove Narrarium account repository bootstrap marker", sha, branch });
    } catch {
      // Refusing the account commit is the safety boundary; marker cleanup is best effort.
    }
  }
}

function statusOf(error: unknown): number | undefined {
  return error && typeof error === "object" && "status" in error && typeof error.status === "number" ? error.status : undefined;
}

function encodeBase64(value: string): string {
  const bytes = new TextEncoder().encode(value);
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary);
}

function decodeBase64(value: string): Uint8Array {
  const binary = atob(value);
  return Uint8Array.from(binary, (character) => character.charCodeAt(0));
}

async function assertHash(data: SyncableAccountData, expected?: string): Promise<void> {
  if (expected && await accountContentHash(data) !== expected) throw new Error("GitHub account data hash does not match its manifest.");
}
