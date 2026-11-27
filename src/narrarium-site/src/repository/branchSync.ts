import {
  addLocalRepoLog,
  createLocalCommit,
  getLocalRepository,
  listDirtyLocalFiles,
  listUnpushedLocalCommits,
  markLocalRepositoryRemoteCheck,
  settleOrphanedCommittedFiles,
  updateLocalRepositoryHead,
  type LocalRepositoryMeta,
} from "@/repository/localRepository";
import {
  autoCommitMessage,
  BranchNameTakenError,
  exactLocalRepository,
  operationScope,
  publishPendingBranchLeased,
  pullRemoteChangesLeased,
  pushLocalCommitsLocked,
  RemoteHeadMismatchError,
  resolveRemoteChangeState,
  trackedOctokit,
  withRepositoryMutationLease,
  type ExactRepositoryTarget,
} from "@/repository/repositoryService";
import { classifyRepositoryError, RepositoryError } from "@/repository/repositoryError";
import { createLocalBranchCopy } from "@/repository/localBranchCopy";

/**
 * What the branches of a book need of their working copies beyond the ordinary sync: the automatic sync of one branch, a branch made on this device, and
 * publishing it. A module of its own, loaded with the branch sync and the branch switcher, not with the shell of every page.
 */

/** What the automatic sync did to one branch (`@/branches/autoSync`). */
export interface AutoSyncBranchResult {
  outcome: "synced" | "pulled" | "pushed" | "published" | "held" | "diverged" | "gone" | "name-taken";
  remoteHeadSha?: string;
  files?: number;
}

/**
 * The automatic sync of one branch with a working copy here, under the lease of that copy, with what the copy and GitHub say at that moment: a pull only
 * into a clean copy, local work pushed (saved changes committed first, as the Sync does) only when GitHub did not move, a branch created here published
 * first. GitHub moved while the copy has work: `diverged`, and the copy is left as it is for the person (the Sync and its conflict dialog); a branch GitHub
 * does not have and that was not created here: `gone`. Nothing is forced, merged or overwritten. `listedHeadSha` is the head GitHub listed for the branch
 * (`null`: not listed), so an unchanged branch costs no request.
 */
export async function autoSyncBranch(input: ExactRepositoryTarget & { token: string; listedHeadSha: string | null; mayPush: boolean; mayPull: boolean; signal?: AbortSignal }): Promise<AutoSyncBranchResult> {
  const scope = operationScope(input);
  const selected = await exactLocalRepository(input, scope);
  return withRepositoryMutationLease(selected.id, async () => {
    let meta = await exactLocalRepository(input, scope);
    if (meta.remoteKind === "none") return { outcome: "held" };
    // A change marked as committed without its commit is work like any other (see the full sync): it is pushed, never left behind as «nothing to do».
    await settleOrphanedCommittedFiles(meta.id, scope);
    const octokit = trackedOctokit(input.token, input);
    const request = { request: { signal: input.signal } };
    let published = false;
    if (meta.pendingBranch) {
      const pending = meta.pendingBranch;
      if (input.listedHeadSha !== null && input.listedHeadSha !== pending.headSha) return { outcome: "name-taken", remoteHeadSha: input.listedHeadSha };
      if (!input.mayPush) return { outcome: "held" };
      try {
        await publishPendingBranchLeased(meta, octokit, scope, input.signal);
      } catch (error) {
        if (error instanceof BranchNameTakenError) return { outcome: "name-taken", remoteHeadSha: error.remoteHeadSha };
        throw error;
      }
      meta = await exactLocalRepository(input, scope);
      published = true;
    } else if (input.listedHeadSha === null) return { outcome: "gone" };
    const dirty = await listDirtyLocalFiles(meta.id);
    const ahead = await listUnpushedLocalCommits(meta.id);
    const work = dirty.length > 0 || ahead.length > 0;
    let remoteHeadSha = published ? meta.remoteHeadSha : input.listedHeadSha!;
    if (remoteHeadSha !== meta.remoteHeadSha) {
      const state = await resolveRemoteChangeState(octokit, meta, input.signal);
      remoteHeadSha = state.remoteHeadSha;
      if (remoteHeadSha !== meta.remoteHeadSha && !state.changed) {
        // A new head with the same files: the copy follows it without touching a file, and its work is pushed on top as if GitHub had not moved.
        await updateLocalRepositoryHead(meta.id, scope, remoteHeadSha);
        meta = await exactLocalRepository(input, scope);
      } else if (remoteHeadSha !== meta.remoteHeadSha) {
        if (work) {
          await markLocalRepositoryRemoteCheck(meta.id, scope, meta.remoteHeadSha, remoteHeadSha, true);
          return { outcome: "diverged", remoteHeadSha };
        }
        if (!input.mayPull) return { outcome: "held", remoteHeadSha };
        const pulled = await pullRemoteChangesLeased(meta, { ...input, mode: "safe" }, scope);
        return { outcome: "pulled", remoteHeadSha: pulled.remoteHeadSha, files: pulled.updated };
      }
    }
    if (!work) {
      await markLocalRepositoryRemoteCheck(meta.id, scope, meta.remoteHeadSha, remoteHeadSha, false);
      return { outcome: published ? "published" : "synced", remoteHeadSha };
    }
    if (!input.mayPush) return { outcome: published ? "published" : "held", remoteHeadSha };
    if (dirty.length) {
      const commit = await createLocalCommit(meta.id, scope, autoCommitMessage(dirty.map((file) => file.path)), new Set(dirty.map((file) => file.path)), new Map(dirty.map((file) => [file.path, file.currentHash])));
      await addLocalRepoLog(meta.id, scope, "commit", `Automatic sync committed ${commit.files.length} files: ${commit.message}`);
    }
    try {
      const pushed = await pushLocalCommitsLocked(await exactLocalRepository(input, scope), { ...input, expectedRemoteHeadSha: remoteHeadSha }, scope);
      const finalRef = await octokit.rest.git.getRef({ owner: meta.owner, repo: meta.repo, ref: `heads/${meta.branch}`, ...request });
      await updateLocalRepositoryHead(meta.id, scope, finalRef.data.object.sha);
      return { outcome: published ? "published" : "pushed", remoteHeadSha: finalRef.data.object.sha, files: pushed.files };
    } catch (error) {
      // GitHub moved between the look and the push: nothing was written there, the work stays here as a commit, and the person decides.
      if (error instanceof RemoteHeadMismatchError) {
        await markLocalRepositoryRemoteCheck(meta.id, scope, meta.remoteHeadSha, error.actualRemoteHeadSha, true).catch(() => undefined);
        return { outcome: "diverged", remoteHeadSha: error.actualRemoteHeadSha };
      }
      throw error;
    }
  });
}

/**
 * A new branch of the book, made on this device from the working copy of the current one (under its lease, so the copy is consistent): it opens at once and
 * works without GitHub. GitHub gets it with the next sync (`autoSyncBranch` publishes it), or now with `publishLocalBranch`.
 */
export async function createBranchFromWorkingCopy(input: ExactRepositoryTarget & { newBranch: string }): Promise<LocalRepositoryMeta> {
  const scope = operationScope(input);
  const source = await exactLocalRepository(input, scope);
  if (source.remoteKind === "none") throw new Error("A book kept on this device has a single branch.");
  if (await getLocalRepository(source.owner, source.repo, input.newBranch, scope)) throw new RepositoryError("A branch with this name is already on this device.", "conflict", "create");
  return withRepositoryMutationLease(source.id, async () => {
    const copy = await createLocalBranchCopy({ source: await exactLocalRepository(input, scope), branch: input.newBranch, scope });
    await addLocalRepoLog(copy.id, scope, "clone", `Created branch ${input.newBranch} from ${source.branch} on this device`);
    return copy;
  });
}

/** Publish now a branch made on this device: GitHub gets the branch, and its changes, with nothing forced (see `autoSyncBranch`). */
export async function publishLocalBranch(input: ExactRepositoryTarget & { token: string; signal?: AbortSignal }): Promise<AutoSyncBranchResult> {
  const octokit = trackedOctokit(input.token, input);
  const listedHeadSha = await octokit.rest.git.getRef({ owner: input.owner, repo: input.repo, ref: `heads/${input.branch}`, request: { signal: input.signal } })
    .then((ref) => ref.data.object.sha, (error: unknown) => {
      const status = (error as { status?: unknown }).status;
      if (status === 404) return null;
      throw classifyRepositoryError(error, "read");
    });
  return autoSyncBranch({ ...input, listedHeadSha, mayPush: true, mayPull: false });
}
