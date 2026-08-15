import { Octokit } from "@octokit/rest";
import type { BookEntry } from "@/types/settings";
import {
  createLocalCommit,
  getLocalRepository,
  getLocalFile,
  listDirtyLocalFiles,
  listUnpushedLocalCommits,
  markLocalCommitsPushed,
  mutateLocalTextFilesAtomically,
  restoreLocalFilesAndDeleteCommit,
  sha256Text,
  type LocalTextFileMutation,
} from "@/repository/localRepository";
import { pushLocalCommits, RemoteHeadMismatchError } from "@/repository/repositoryService";
import { loadRemoteFileContentAtRef } from "@/github/githubClient";

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
}): Promise<RepositoryOperationPreflight> {
  const meta = await getLocalRepository(input.book.owner, input.book.repo, input.branch);
  if (!meta) {
    throw new Error("A local working copy for the selected branch is required.");
  }
  if (meta.cloneComplete !== true) throw new Error("The local working copy has not been fully verified.");
  const [dirty, ahead] = await Promise.all([listDirtyLocalFiles(meta.id), listUnpushedLocalCommits(meta.id)]);
  if (dirty.length) throw new Error("The local working copy must be clean before starting this operation.");
  if (ahead.length) throw new Error("Push or discard existing local commits before starting this operation.");
  const octokit = new Octokit({ auth: input.token });
  const ref = await octokit.rest.git.getRef({ owner: input.book.owner, repo: input.book.repo, ref: `heads/${input.branch}` });
  const remoteHeadSha = ref.data.object.sha;
  if (remoteHeadSha !== meta.remoteHeadSha) throw new RepositoryConflictError("The remote branch changed. Pull and retry the operation.");
  return { repoId: meta.id, remoteHeadSha, branch: input.branch };
}

export async function resolveRepositoryHeadForMutation(input: { token: string; book: BookEntry; branch: string }): Promise<string> {
  const local = await getLocalRepository(input.book.owner, input.book.repo, input.branch).catch(() => null);
  if (local) return (await preflightRepositoryOperation(input)).remoteHeadSha;
  const octokit = new Octokit({ auth: input.token });
  const ref = await octokit.rest.git.getRef({ owner: input.book.owner, repo: input.book.repo, ref: `heads/${input.branch}` });
  return ref.data.object.sha;
}

async function mutateRemoteTextFiles(input: {
  token: string;
  book: BookEntry;
  branch: string;
  expectedRemoteHeadSha: string;
  message: string;
  mutations: RepositoryTextMutation[];
}): Promise<string> {
  const octokit = new Octokit({ auth: input.token });
  const ref = await octokit.rest.git.getRef({ owner: input.book.owner, repo: input.book.repo, ref: `heads/${input.branch}` });
  if (ref.data.object.sha !== input.expectedRemoteHeadSha) throw new RepositoryConflictError("The remote branch changed before the operation could be saved.");
  const commit = await octokit.rest.git.getCommit({ owner: input.book.owner, repo: input.book.repo, commit_sha: input.expectedRemoteHeadSha });

  for (const mutation of input.mutations) {
    if (mutation.expectedCurrentHash === undefined) continue;
    const current = await loadRemoteFileContentAtRef(input.token, input.book.owner, input.book.repo, mutation.path, input.expectedRemoteHeadSha).catch(() => null);
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
  });
  const nextCommit = await octokit.rest.git.createCommit({
    owner: input.book.owner,
    repo: input.book.repo,
    message: input.message,
    tree: tree.data.sha,
    parents: [input.expectedRemoteHeadSha],
  });
  await octokit.rest.git.updateRef({ owner: input.book.owner, repo: input.book.repo, ref: `heads/${input.branch}`, sha: nextCommit.data.sha, force: false });
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
}): Promise<{ commitSha: string; mode: "local" | "remote" }> {
  const local = await getLocalRepository(input.book.owner, input.book.repo, input.branch).catch(() => null);
  if (!local) {
    const commitSha = await mutateRemoteTextFiles(input);
    return { commitSha, mode: "remote" };
  }
  if (local.remoteHeadSha !== input.expectedRemoteHeadSha) throw new RepositoryConflictError("The local working copy is based on a different remote head.");
  const snapshots = await Promise.all(input.mutations.map(async (mutation) => ({ path: mutation.path, file: await getLocalFile(local.id, mutation.path) ?? null })));
  try {
    await mutateLocalTextFilesAtomically(local.id, input.mutations);
  } catch (error) {
    if (error instanceof Error && error.message.startsWith("File changed since")) {
      const path = /^File changed since it was read:\s*(.+)$/.exec(error.message)?.[1];
      throw new RepositoryConflictError(error.message, path);
    }
    throw error;
  }
  if (!input.mutations.some((mutation) => mutation.content !== undefined)) return { commitSha: input.expectedRemoteHeadSha, mode: "local" };
  const localCommit = await createLocalCommit(local.id, input.message);
  let pushed;
  try {
    pushed = await pushLocalCommits({
      bookId: input.book.id,
      token: input.token,
      expectedRemoteHeadSha: input.expectedRemoteHeadSha,
      repoId: local.id,
      owner: input.book.owner,
      repo: input.book.repo,
      branch: input.branch,
    });
  } catch (error) {
    const octokit = new Octokit({ auth: input.token });
    const remoteRef = await octokit.rest.git.getRef({ owner: input.book.owner, repo: input.book.repo, ref: `heads/${input.branch}` }).catch(() => null);
    const remoteHead = remoteRef?.data.object.sha;
    if (remoteHead && remoteHead !== input.expectedRemoteHeadSha) {
      const pushedShas: Record<string, string | null> = {};
      let matchesOperation = true;
      await Promise.all(input.mutations.map(async (mutation) => {
        const remote = await loadRemoteFileContentAtRef(input.token, input.book.owner, input.book.repo, mutation.path, remoteHead).catch(() => null);
        pushedShas[mutation.path] = remote?.sha ?? null;
        if (mutation.content === undefined) return;
        if (mutation.content === null) {
          if (remote) matchesOperation = false;
          return;
        }
        if (!remote || await sha256Text(remote.content) !== await sha256Text(mutation.content)) matchesOperation = false;
      }));
      if (!matchesOperation) {
        await restoreLocalFilesAndDeleteCommit(local.id, localCommit.id, snapshots);
        throw new RepositoryConflictError("The remote branch advanced with different content while saving the operation.");
      }
      await markLocalCommitsPushed(local.id, [localCommit.id], remoteHead, pushedShas).catch(() => undefined);
      return { commitSha: remoteHead, mode: "local" };
    }
    await restoreLocalFilesAndDeleteCommit(local.id, localCommit.id, snapshots);
    if (error instanceof RemoteHeadMismatchError) throw new RepositoryConflictError(error.message);
    throw error;
  }
  return { commitSha: pushed.commitSha, mode: "local" };
}

export { sha256Text };
