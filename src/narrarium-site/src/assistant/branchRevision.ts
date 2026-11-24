import { listBranchCommits } from "@/github/githubClient";
import { githubRemoteAvailability } from "@/github/remoteAvailability";
import { getLocalRepository, type LocalRepositoryMeta } from "@/repository/localRepository";
import { captureRepositoryOperationScope } from "@/repository/repositoryOperationScope";
import type { BookEntry } from "@/types/settings";

/** The complete working copy of a branch of the book on this device, if there is one. */
export async function localBranchCopy(book: BookEntry, branch: string): Promise<LocalRepositoryMeta | null> {
  const meta = await getLocalRepository(book.owner, book.repo, branch, captureRepositoryOperationScope()).catch(() => null);
  return meta?.cloneComplete === true ? meta : null;
}

/**
 * The revision an action without files is bound to (a branch switch, a pull request): the latest commit of the branch on GitHub or, when GitHub cannot be
 * used, the head of its working copy on this device (the last remote head it knows, and its local commits). Null when there is neither.
 */
export async function branchRevision(book: BookEntry, token: string, branch: string, signal?: AbortSignal): Promise<string | null> {
  if (githubRemoteAvailability(book, token) === "ready") return (await listBranchCommits(token, book.owner, book.repo, branch, signal))[0]?.sha ?? null;
  const local = await localBranchCopy(book, branch);
  return local ? `local:${local.remoteHeadSha}:${local.nextCommitOrder ?? 0}` : null;
}
