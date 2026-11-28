import type { BookEntry } from "@/types/settings";
import { isUsableGitHubToken } from "@/github/remoteAvailability";
import {
  getLocalCommit,
  getLocalRepository,
  getLocalFile,
  listDirtyLocalFiles,
  listUnpushedLocalCommits,
  markLocalCommitsPushed,
  mutateLocalTextFilesAndCreateCommitAtomically,
  mutateLocalTextFilesAtomically,
  restoreLocalFilesAndDeleteCommit,
  sha256Text,
  type LocalTextFileMutation,
} from "@/repository/localRepository";
import { AmbiguousLocalPushError, pushLocalCommits, RemoteHeadMismatchError, RepositorySyncConflictError, syncFullRepository } from "@/repository/repositoryService";
import { loadRemoteFileContentAtRef } from "@/github/githubClient";
import { isRepositoryError, optionalRepositoryRead } from "@/repository/repositoryError";
import { reconcileRemoteMutation } from "@/repository/remoteMutationReconciliation";
import { captureRepositoryOperationScope } from "@/repository/repositoryOperationScope";
import { createTrackedGitHubClient } from "@/repository/githubRequest";
import { recordRepositoryWriteValidated } from "@/repository/tokenHealth";
import { RepositoryByteMeter, utf8Bytes } from "@/repository/repositoryLimits";
import { useRepositorySyncStore } from "@/store/repositorySyncStore";
import { currentRepositoryScopeIdentity } from "@/repository/repositoryOperationScope";

function currentAccountIdentity(): string | null {
  return currentRepositoryScopeIdentity();
}

export type RepositoryTextMutation = LocalTextFileMutation;

export class RepositoryConflictError extends Error {
  readonly code = "REPOSITORY_CONFLICT";
  constructor(message: string, readonly path?: string) {
    super(message);
    this.name = "RepositoryConflictError";
  }
}

export interface RepositoryOperationPreflight {
  repoId: string;
  remoteHeadSha: string;
  branch: string;
}

export async function preflightRepositoryOperation(input: {
  token: string;
  book: BookEntry;
  branch: string;
  signal?: AbortSignal;
}): Promise<RepositoryOperationPreflight> {
  input.signal?.throwIfAborted();
  const scope = captureRepositoryOperationScope();
  const identity = currentAccountIdentity();
  const meta = identity ? await getLocalRepository(input.book.owner, input.book.repo, input.branch, scope) : null;
  input.signal?.throwIfAborted();
  if (!meta) {
    throw new Error("A local working copy for the selected branch is required.");
  }
  if (meta.cloneComplete !== true) throw new Error("The local working copy has not been fully verified.");
  return { repoId: meta.id, remoteHeadSha: meta.remoteHeadSha, branch: input.branch };
}

/**
 * What a change published at once finds in the working copy besides itself: local commits not sent yet and edits not saved as a commit yet (the sync commits them as
 * one). These never stop the change: it is saved as a local commit on top, and the book's normal sync sends it together with them, in order.
 */
async function earlierWork(repoId: string, ownPaths: ReadonlySet<string>, signal?: AbortSignal): Promise<number> {
  const [dirty, ahead] = await Promise.all([listDirtyLocalFiles(repoId), listUnpushedLocalCommits(repoId)]);
  signal?.throwIfAborted();
  return ahead.length + (dirty.some((file) => !ownPaths.has(file.path)) ? 1 : 0);
}

/**
 * What became of a change that was to reach GitHub at once (every change of the Copilot on a book on GitHub): sent with the sync (`earlier` is the number of changes
 * of the author's that went with it), saved on this device and left for the next sync (and why), or sent as far as a real conflict allows (the resolver is open).
 * It is never an error: the change is in the working copy in all three.
 */
export type MutationDelivery =
  | { kind: "published"; earlier: number; pulled: number }
  | { kind: "saved"; reason: "local-book" | "no-credential" | "offline" | "unreachable" | "branch-unpublished" | "held" | "failed"; earlier: number; error?: unknown }
  | { kind: "conflict"; earlier: number; files: string[] };

/** A branch without a working copy on this device lives only on GitHub: a book kept on this device, or one without a credential, never goes there. */
export function assertRemoteBranchReachable(input: { token: string; book: BookEntry }): void {
  if (!input.book.owner || !input.book.repo || !isUsableGitHubToken(input.token)) throw new Error("A local working copy for the selected branch is required.");
}

export async function resolveRepositoryHeadForMutation(input: { token: string; book: BookEntry; branch: string; signal?: AbortSignal }): Promise<string> {
  input.signal?.throwIfAborted();
  const scope = captureRepositoryOperationScope();
  const identity = currentAccountIdentity();
  const local = identity ? await getLocalRepository(input.book.owner, input.book.repo, input.branch, scope).catch(() => null) : null;
  input.signal?.throwIfAborted();
  if (local) return (await preflightRepositoryOperation(input)).remoteHeadSha;
  assertRemoteBranchReachable(input);
  const octokit = createTrackedGitHubClient(input.token, identity ? { accountIdentity: identity, owner: input.book.owner, repo: input.book.repo, branch: input.branch } : undefined);
  const ref = await octokit.rest.git.getRef({ owner: input.book.owner, repo: input.book.repo, ref: `heads/${input.branch}`, request: { signal: input.signal } });
  input.signal?.throwIfAborted();
  return ref.data.object.sha;
}

async function mutateRemoteTextFiles(input: {
  token: string;
  book: BookEntry;
  branch: string;
  expectedRemoteHeadSha: string;
  message: string;
  mutations: RepositoryTextMutation[];
  signal?: AbortSignal;
}): Promise<string> {
  input.signal?.throwIfAborted();
  const identity = currentAccountIdentity();
  const octokit = createTrackedGitHubClient(input.token, identity ? { accountIdentity: identity, owner: input.book.owner, repo: input.book.repo, branch: input.branch } : undefined);
  const request = { request: { signal: input.signal } };
  const ref = await octokit.rest.git.getRef({ owner: input.book.owner, repo: input.book.repo, ref: `heads/${input.branch}`, ...request });
  input.signal?.throwIfAborted();
  if (ref.data.object.sha !== input.expectedRemoteHeadSha) throw new RepositoryConflictError("The remote branch changed before the operation could be saved.");
  const commit = await octokit.rest.git.getCommit({ owner: input.book.owner, repo: input.book.repo, commit_sha: input.expectedRemoteHeadSha, ...request });
  input.signal?.throwIfAborted();

  for (const mutation of input.mutations) {
    if (mutation.expectedCurrentHash === undefined) continue;
    const current = await optionalRepositoryRead(() => loadRemoteFileContentAtRef(input.token, input.book.owner, input.book.repo, mutation.path, input.expectedRemoteHeadSha, input.signal));
    input.signal?.throwIfAborted();
    const actual = current ? await sha256Text(current.content) : null;
    if (actual !== mutation.expectedCurrentHash) throw new RepositoryConflictError(`File changed since it was read: ${mutation.path}`, mutation.path);
  }

  const writes = input.mutations.filter((mutation) => mutation.content !== undefined);
  if (!writes.length) return input.expectedRemoteHeadSha;
  const tree = await octokit.rest.git.createTree({
    owner: input.book.owner,
    repo: input.book.repo,
    base_tree: commit.data.tree.sha,
    tree: writes.map((mutation) => ({
      path: mutation.path,
      mode: "100644" as const,
      type: "blob" as const,
      ...(mutation.content === null ? { sha: null } : { content: mutation.content }),
    })),
    ...request,
  });
  input.signal?.throwIfAborted();
  const nextCommit = await octokit.rest.git.createCommit({
    owner: input.book.owner,
    repo: input.book.repo,
    message: input.message,
    tree: tree.data.sha,
    parents: [input.expectedRemoteHeadSha],
    ...request,
  });
  input.signal?.throwIfAborted();
  try {
    await octokit.rest.git.updateRef({ owner: input.book.owner, repo: input.book.repo, ref: `heads/${input.branch}`, sha: nextCommit.data.sha, force: false, ...request });
  } catch (error) {
    const reconciled = await reconcileRemoteMutation({ octokit, owner: input.book.owner, repo: input.book.repo, branch: input.branch, generatedCommitSha: nextCommit.data.sha, revisions: input.mutations });
    if (reconciled.landed && reconciled.headSha) {
      if (identity) await recordRepositoryWriteValidated({ accountIdentity: identity, token: input.token, owner: input.book.owner, repo: input.book.repo, branch: input.branch });
      return reconciled.headSha;
    }
    if (!reconciled.headSha || reconciled.headSha === input.expectedRemoteHeadSha) throw error;
    throw new RepositoryConflictError("The generated commit is not an ancestor of the remote head, or its intended revisions no longer match.");
  }
  if (identity) await recordRepositoryWriteValidated({ accountIdentity: identity, token: input.token, owner: input.book.owner, repo: input.book.repo, branch: input.branch });
  return nextCommit.data.sha;
}

/**
 * Apply one optimistic multi-file text mutation as a commit of the working copy and, unless the caller passes `push: false`, publish it at once. This is
 * the decided behaviour of the changes the Copilot applies (and undoes) on a GitHub book: they reach GitHub right away when it can be reached. Without
 * GitHub (a book kept on this device, no credential or one GitHub refused, offline, or GitHub out of reach during the push) the commit stays on this
 * device and the next sync publishes it. Remote-only callers (no working copy here) still need one Git Trees commit.
 */
export async function commitAndPushTextFileMutation(input: {
  token: string;
  book: BookEntry;
  branch: string;
  expectedRemoteHeadSha: string;
  message: string;
  mutations: RepositoryTextMutation[];
  signal?: AbortSignal;
  /** `false` leaves the commit on this device for the author's next sync; by default it is published at once whenever GitHub can be reached. */
  push?: boolean;
}): Promise<{ commitSha: string; mode: "local" | "remote"; /** Only for a change that was to be published (`push` not `false`) and made a commit. */ delivery?: MutationDelivery }> {
  const meter = new RepositoryByteMeter("mutation");
  for (const mutation of input.mutations) if (typeof mutation.content === "string") meter.add("text", utf8Bytes(mutation.content));
  const operationScope = captureRepositoryOperationScope();
  input.signal?.throwIfAborted();
  const identity = currentAccountIdentity();
  const local = identity ? await getLocalRepository(input.book.owner, input.book.repo, input.branch, operationScope).catch(() => null) : null;
  input.signal?.throwIfAborted();
  if (!local) {
    assertRemoteBranchReachable(input);
    const commitSha = await mutateRemoteTextFiles(input);
    return { commitSha, mode: "remote" };
  }
  if (local.remoteHeadSha !== input.expectedRemoteHeadSha) throw new RepositoryConflictError("The local working copy is based on a different remote head.");
  // A book kept on this device has nowhere to publish; without a GitHub credential (none, or one GitHub refused) or a connection the next sync publishes:
  // the change stays a local commit. So does a change of a branch made on this device that GitHub does not have yet: the sync publishes the two together.
  const wantsPush = input.push !== false;
  const online = typeof navigator === "undefined" || navigator.onLine !== false;
  const publish = wantsPush && local.remoteKind !== "none" && !local.pendingBranch && isUsableGitHubToken(input.token) && online;
  const writes = input.mutations.filter((mutation) => mutation.content !== undefined);
  const snapshots = await Promise.all(writes.map(async (mutation) => ({ path: mutation.path, file: await getLocalFile(local.id, mutation.path, operationScope) ?? null })));
  input.signal?.throwIfAborted();
  const desiredHashes = new Map(await Promise.all(writes.map(async (mutation) => [mutation.path, typeof mutation.content === "string" ? await sha256Text(mutation.content) : null] as const)));
  const hasChanges = snapshots.some(({ path, file }) => {
    const desiredHash = desiredHashes.get(path);
    return desiredHash === null ? Boolean(file && file.status !== "deleted") : file?.status === "deleted" || file?.currentHash !== desiredHash;
  });
  if (!writes.length || !hasChanges) {
    try {
      await mutateLocalTextFilesAtomically(local.id, operationScope, input.mutations);
    } catch (error) {
      if (error instanceof Error && error.message.startsWith("File changed since")) {
        const path = /^File changed since it was read:\s*(.+)$/.exec(error.message)?.[1];
        throw new RepositoryConflictError(error.message, path);
      }
      throw error;
    }
    return { commitSha: input.expectedRemoteHeadSha, mode: "local" };
  }
  let localCommit;
  let earlier = 0;
  try {
    input.signal?.throwIfAborted();
    if (wantsPush) earlier = await earlierWork(local.id, new Set(writes.map((mutation) => mutation.path)), input.signal);
    localCommit = await mutateLocalTextFilesAndCreateCommitAtomically(local.id, operationScope, input.message, input.mutations);
  } catch (error) {
    if (error instanceof Error && error.message.startsWith("File changed since")) {
      const path = /^File changed since it was read:\s*(.+)$/.exec(error.message)?.[1];
      throw new RepositoryConflictError(error.message, path);
    }
    throw error;
  }
  if (!wantsPush) return { commitSha: localCommit.id, mode: "local" };
  if (!publish) {
    const reason = local.remoteKind === "none" ? "local-book" : local.pendingBranch ? "branch-unpublished" : !isUsableGitHubToken(input.token) ? "no-credential" : "offline";
    return { commitSha: localCommit.id, mode: "local", delivery: { kind: "saved", reason, earlier } };
  }
  const settleBySync = (fallbackSha: string) => syncAfterLocalCommit({ input, local, identity: identity!, operationScope, fallbackSha, earlier });
  // Work of the author's that GitHub does not have yet goes first, in order, and the sync (which commits what is not committed, takes what GitHub has and
  // pushes, never forcing) is the one that sends it together with this change.
  if (earlier > 0) return settleBySync(localCommit.id);
  let pushed;
  let pushStarted = false;
  try {
    input.signal?.throwIfAborted();
    pushStarted = true;
    pushed = await pushLocalCommits({
      bookId: input.book.id,
      token: input.token,
      expectedRemoteHeadSha: input.expectedRemoteHeadSha,
      repoId: local.id,
      owner: input.book.owner,
      repo: input.book.repo,
      branch: input.branch,
      accountIdentity: identity!,
      signal: input.signal,
    });
  } catch (error) {
    if (!pushStarted) {
      await restoreLocalFilesAndDeleteCommit(local.id, operationScope, localCommit.id, snapshots);
      throw error;
    }
    if (error instanceof AmbiguousLocalPushError) {
      const octokit = createTrackedGitHubClient(input.token, { accountIdentity: identity!, owner: input.book.owner, repo: input.book.repo, branch: input.branch });
      const reconciled = await reconcileRemoteMutation({ octokit, owner: input.book.owner, repo: input.book.repo, branch: input.branch, generatedCommitSha: error.generatedCommitSha, revisions: input.mutations });
      if (reconciled.landed && reconciled.headSha) {
        await markLocalCommitsPushed(local.id, operationScope, [localCommit.id], reconciled.headSha, reconciled.blobShas ?? {}).catch(() => undefined);
        await recordRepositoryWriteValidated({ accountIdentity: identity!, token: input.token, owner: input.book.owner, repo: input.book.repo, branch: input.branch });
        return { commitSha: reconciled.headSha, mode: "local", delivery: { kind: "published", earlier: 0, pulled: 0 } };
      }
      await restoreLocalFilesAndDeleteCommit(local.id, operationScope, localCommit.id, snapshots);
      if (error.cause instanceof DOMException && error.cause.name === "AbortError") throw error.cause;
      throw new RepositoryConflictError("The local push outcome could not be proven by generated-commit ancestry and revision parity.");
    }
    // GitHub moved: the sync takes what it has and sends this change after it.
    if (error instanceof RemoteHeadMismatchError) return settleBySync(localCommit.id);
    // GitHub out of reach, or the credential refused: the commit stays on this device, like any other local change, and the next sync publishes it.
    if (isRepositoryError(error, "network")) return { commitSha: localCommit.id, mode: "local", delivery: { kind: "saved", reason: "unreachable", earlier } };
    if (isRepositoryError(error, "credential-invalid") || isRepositoryError(error, "no-credential")) return { commitSha: localCommit.id, mode: "local", delivery: { kind: "saved", reason: "no-credential", earlier } };
    // The automatic sync of the branch may have published this very commit between its making and this push: it is on GitHub, so it is kept.
    const published = await getLocalCommit(local.id, localCommit.id).catch(() => null);
    if (published?.pushed) return { commitSha: published.remoteCommitSha ?? (await getLocalRepository(input.book.owner, input.book.repo, input.branch, operationScope))?.remoteHeadSha ?? localCommit.id, mode: "local", delivery: { kind: "published", earlier: 0, pulled: 0 } };
    await restoreLocalFilesAndDeleteCommit(local.id, operationScope, localCommit.id, snapshots);
    throw error;
  }
  return { commitSha: pushed.commitSha, mode: "local", delivery: { kind: "published", earlier: 0, pulled: 0 } };
}

/**
 * The book's normal sync, right after a change was saved as a local commit: it sends the change with whatever else this device holds, in order. What it finds is
 * a delivery, never an error: a real conflict opens the resolver (the change stays saved here, the sync did not force anything), and GitHub out of reach leaves
 * everything on this device for the next sync. Only a cancelled operation is thrown.
 */
async function syncAfterLocalCommit(context: {
  input: { token: string; book: BookEntry; branch: string; signal?: AbortSignal };
  local: { id: string };
  identity: string;
  operationScope: ReturnType<typeof captureRepositoryOperationScope>;
  fallbackSha: string;
  earlier: number;
}): Promise<{ commitSha: string; mode: "local"; delivery: MutationDelivery }> {
  const { input, local, identity, earlier } = context;
  const target = { bookId: input.book.id, repoId: local.id, owner: input.book.owner, repo: input.book.repo, branch: input.branch, accountIdentity: identity };
  try {
    const result = await syncFullRepository({ ...target, token: input.token, signal: input.signal });
    const settled = await getLocalRepository(input.book.owner, input.book.repo, input.branch, context.operationScope).catch(() => null);
    const commitSha = settled?.remoteHeadSha ?? context.fallbackSha;
    if (result.unpublished > 0) return { commitSha: context.fallbackSha, mode: "local", delivery: { kind: "saved", reason: "held", earlier } };
    return { commitSha, mode: "local", delivery: { kind: "published", earlier, pulled: result.pulled } };
  } catch (error) {
    if (error instanceof RepositorySyncConflictError) {
      useRepositorySyncStore.getState().setConflict({ error, target });
      return { commitSha: context.fallbackSha, mode: "local", delivery: { kind: "conflict", earlier, files: error.conflicts.map((conflict) => conflict.path) } };
    }
    if ((error instanceof DOMException && error.name === "AbortError") || isRepositoryError(error, "abort")) throw error;
    const reason = isRepositoryError(error, "network") ? "unreachable" : isRepositoryError(error, "credential-invalid") || isRepositoryError(error, "no-credential") ? "no-credential" : "failed";
    return { commitSha: context.fallbackSha, mode: "local", delivery: { kind: "saved", reason, earlier, ...(reason === "failed" ? { error } : {}) } };
  }
}

export { sha256Text };
