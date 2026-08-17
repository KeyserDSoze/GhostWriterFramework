import type { BookEntry } from "@/types/settings";
import {
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
import { AmbiguousLocalPushError, pushLocalCommits, RemoteHeadMismatchError } from "@/repository/repositoryService";
import { loadRemoteFileContentAtRef } from "@/github/githubClient";
import { optionalRepositoryRead } from "@/repository/repositoryError";
import { reconcileRemoteMutation } from "@/repository/remoteMutationReconciliation";
import { accountIdentity } from "@/auth/accountIdentity";
import { useAuthStore } from "@/store/authStore";
import { captureRepositoryOperationScope } from "@/repository/repositoryOperationScope";
import { createTrackedGitHubClient } from "@/repository/githubRequest";
import { recordRepositoryWriteValidated } from "@/repository/tokenHealth";

function currentAccountIdentity(): string | null {
  return accountIdentity(useAuthStore.getState().user);
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
  const [dirty, ahead] = await Promise.all([listDirtyLocalFiles(meta.id), listUnpushedLocalCommits(meta.id)]);
  input.signal?.throwIfAborted();
  if (dirty.length) throw new Error("The local working copy must be clean before starting this operation.");
  if (ahead.length) throw new Error("Push or discard existing local commits before starting this operation.");
  const octokit = createTrackedGitHubClient(input.token, identity ? { accountIdentity: identity, owner: input.book.owner, repo: input.book.repo, branch: input.branch } : undefined);
  const ref = await octokit.rest.git.getRef({ owner: input.book.owner, repo: input.book.repo, ref: `heads/${input.branch}`, request: { signal: input.signal } });
  input.signal?.throwIfAborted();
  const remoteHeadSha = ref.data.object.sha;
  if (remoteHeadSha !== meta.remoteHeadSha) throw new RepositoryConflictError("The remote branch changed. Pull and retry the operation.");
  return { repoId: meta.id, remoteHeadSha, branch: input.branch };
}

export async function resolveRepositoryHeadForMutation(input: { token: string; book: BookEntry; branch: string; signal?: AbortSignal }): Promise<string> {
  input.signal?.throwIfAborted();
  const scope = captureRepositoryOperationScope();
  const identity = currentAccountIdentity();
  const local = identity ? await getLocalRepository(input.book.owner, input.book.repo, input.branch, scope).catch(() => null) : null;
  input.signal?.throwIfAborted();
  if (local) return (await preflightRepositoryOperation(input)).remoteHeadSha;
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
 * Apply one optimistic multi-file text mutation and make it visible in Git.
 * Local repositories use one IndexedDB transaction followed by one safe push;
 * remote-only callers use one Git Trees commit.
 */
export async function commitAndPushTextFileMutation(input: {
  token: string;
  book: BookEntry;
  branch: string;
  expectedRemoteHeadSha: string;
  message: string;
  mutations: RepositoryTextMutation[];
  signal?: AbortSignal;
}): Promise<{ commitSha: string; mode: "local" | "remote" }> {
  const operationScope = captureRepositoryOperationScope();
  input.signal?.throwIfAborted();
  const identity = currentAccountIdentity();
  const local = identity ? await getLocalRepository(input.book.owner, input.book.repo, input.branch, operationScope).catch(() => null) : null;
  input.signal?.throwIfAborted();
  if (!local) {
    const commitSha = await mutateRemoteTextFiles(input);
    return { commitSha, mode: "remote" };
  }
  if (local.remoteHeadSha !== input.expectedRemoteHeadSha) throw new RepositoryConflictError("The local working copy is based on a different remote head.");
  const writes = input.mutations.filter((mutation) => mutation.content !== undefined);
  const snapshots = await Promise.all(writes.map(async (mutation) => ({ path: mutation.path, file: await getLocalFile(local.id, mutation.path, operationScope) ?? null })));
  input.signal?.throwIfAborted();
  if (!writes.length) {
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
  try {
    input.signal?.throwIfAborted();
    localCommit = await mutateLocalTextFilesAndCreateCommitAtomically(local.id, operationScope, input.message, input.mutations);
  } catch (error) {
    if (error instanceof Error && error.message.startsWith("File changed since")) {
      const path = /^File changed since it was read:\s*(.+)$/.exec(error.message)?.[1];
      throw new RepositoryConflictError(error.message, path);
    }
    throw error;
  }
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
        return { commitSha: reconciled.headSha, mode: "local" };
      }
      await restoreLocalFilesAndDeleteCommit(local.id, operationScope, localCommit.id, snapshots);
      if (error.cause instanceof DOMException && error.cause.name === "AbortError") throw error.cause;
      throw new RepositoryConflictError("The local push outcome could not be proven by generated-commit ancestry and revision parity.");
    }
    await restoreLocalFilesAndDeleteCommit(local.id, operationScope, localCommit.id, snapshots);
    if (error instanceof RemoteHeadMismatchError) throw new RepositoryConflictError(error.message);
    throw error;
  }
  return { commitSha: pushed.commitSha, mode: "local" };
}

export { sha256Text };
