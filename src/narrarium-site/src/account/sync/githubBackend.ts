import { Octokit } from "@octokit/rest";
import type { AccountRemoteExpectation, AccountRemoteSnapshot, AccountSyncBackend, GitHubCredentialKind, LocalAccountSnapshot, SyncableAccountData } from "@/account/types";
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

/**
 * The GitHub App's token cannot create narrarium.settings, or reach the one that exists (the app is installed on selected repositories only, or GitHub
 * refused the creation). It is a state the owner fixes on GitHub, not a passing error: the sync says so once and does not retry by itself.
 */
export class GitHubAccountRepositoryUnreachableError extends Error {
  readonly code = "GITHUB_ACCOUNT_REPOSITORY_UNREACHABLE";
  constructor(readonly reason: "create-refused" | "exists-not-shared" | "no-access") {
    super("The Narrarium GitHub app cannot create or reach the narrarium.settings repository.");
    this.name = "GitHubAccountRepositoryUnreachableError";
  }
}

/**
 * Another write reached narrarium.settings between this device reading it and writing it (another device, or a read that was out of date). Nothing
 * was lost: the sync starts again from what is on GitHub now, instead of reporting a failure.
 */
export class GitHubAccountRepositoryChangedError extends Error {
  readonly code = "GITHUB_ACCOUNT_REPOSITORY_CHANGED";
  constructor() {
    super("GitHub account repository changed before it could be updated.");
    this.name = "GitHubAccountRepositoryChangedError";
  }
}

/**
 * GitHub answers its API with `Cache-Control: private, max-age=60`, so the browser may hand back a branch that is a minute old without asking. A sync that
 * builds its commit on that stale head is refused by GitHub («Update is not a fast forward»), over and over. Every call of the account repository
 * therefore bypasses the HTTP cache.
 */
const uncachedFetch: typeof fetch = (input, init) => fetch(input, { ...init, cache: "no-store" });

export class GitHubAccountSyncBackend implements AccountSyncBackend {
  readonly kind = "github" as const;
  private readonly octokit: Octokit;

  constructor(token: string, private readonly owner: string, private readonly credentialKind: GitHubCredentialKind = "pat") {
    this.octokit = new Octokit({ auth: token, request: { fetch: uncachedFetch } });
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
        if (!await this.isBootstrapCommit(headSha)) throw new GitHubAccountRepositoryChangedError();
      } else {
        if (!expected.revision || expected.revision !== headSha) throw new GitHubAccountRepositoryChangedError();
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
    try {
      if (headSha) await this.octokit.rest.git.updateRef({ owner: this.owner, repo: GITHUB_ACCOUNT_REPOSITORY, ref: `heads/${branch}`, sha: commit.data.sha, force: false });
      else await this.octokit.rest.git.createRef({ owner: this.owner, repo: GITHUB_ACCOUNT_REPOSITORY, ref: `refs/heads/${branch}`, sha: commit.data.sha });
    } catch (error) {
      if (isLostRace(error)) throw new GitHubAccountRepositoryChangedError();
      throw error;
    }
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
      if (this.refusedToTheApp(error)) throw new GitHubAccountRepositoryUnreachableError("no-access");
      if (statusOf(error) !== 404 || !create) return statusOf(error) === 404 ? null : Promise.reject(error);
      const authenticated = await this.octokit.rest.users.getAuthenticated();
      if (String(authenticated.data.login).toLocaleLowerCase() !== this.owner.toLocaleLowerCase()) throw new Error("GitHub account repository can only be created for the authenticated user.");
      let created;
      try {
        created = await this.octokit.rest.repos.createForAuthenticatedUser({ name: GITHUB_ACCOUNT_REPOSITORY, private: true, auto_init: false, description: "Private Narrarium account synchronization data" });
      } catch (createError) {
        // «Not found» above and «name already exists» here together mean the repository is there but this app does not see it.
        if (this.credentialKind === "app" && statusOf(createError) === 422) throw new GitHubAccountRepositoryUnreachableError("exists-not-shared");
        if (this.refusedToTheApp(createError) || (this.credentialKind === "app" && statusOf(createError) === 404)) throw new GitHubAccountRepositoryUnreachableError("create-refused");
        throw createError;
      }
      if (!created.data.private) throw new GitHubAccountRepositoryPublicError();
      return { private: true, default_branch: created.data.default_branch || "main" };
    }
  }

  /** GitHub told the app «not allowed» (as opposed to a limit that passes): only a GitHub App token is judged this way, a personal token's refusal stays a permission error. */
  private refusedToTheApp(error: unknown): boolean {
    return this.credentialKind === "app" && statusOf(error) === 403 && !isRateLimit(error);
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
      // A repository the app just created but cannot write to: GitHub did not give the app access to it.
      if (this.refusedToTheApp(error) || (this.credentialKind === "app" && statusOf(error) === 404)) throw new GitHubAccountRepositoryUnreachableError("no-access");
      if (statusOf(error) !== 409 && statusOf(error) !== 422) throw error;
      const ref = await this.octokit.rest.git.getRef({ owner: this.owner, repo: GITHUB_ACCOUNT_REPOSITORY, ref: `heads/${branch}` });
      if (!await this.isBootstrapCommit(ref.data.object.sha)) throw new GitHubAccountRepositoryChangedError();
      return ref.data.object.sha;
    }
    if (!response.data.commit.sha) throw new Error("GitHub did not return the initial account repository commit.");
    if (!await this.isBootstrapCommit(response.data.commit.sha)) {
      await this.removeBootstrapMarker(response.data.content?.sha, branch);
      throw new GitHubAccountRepositoryChangedError();
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

/** The branch moved while the commit was being made: «Update is not a fast forward» (422) when updating, «Reference already exists» (422) when creating. */
function isLostRace(error: unknown): boolean {
  if (statusOf(error) !== 422) return false;
  const message = error && typeof error === "object" && "message" in error && typeof error.message === "string" ? error.message : "";
  return /fast.?forward|already exists/i.test(message);
}

function isRateLimit(error: unknown): boolean {
  const value = error && typeof error === "object" ? error as { message?: unknown; response?: { headers?: Record<string, unknown> } } : {};
  return value.response?.headers?.["x-ratelimit-remaining"] === "0" || (typeof value.message === "string" && /rate.?limit|abuse/i.test(value.message));
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
