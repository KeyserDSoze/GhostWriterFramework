import { assertRepositoryOperationScopeCurrent, RepositoryOwnershipChangedError, type RepositoryOperationScope } from "@/repository/repositoryOperationScope";
import {
  createLocalRepositoryClone,
  getLocalRepository,
  listAllLocalFiles,
  markLocalRepositoryCloneComplete,
  putClonedLocalFile,
  removeAbandonedLocalClone,
  type LocalFileStatus,
  type LocalRepositoryMeta,
} from "@/repository/localRepository";

/**
 * A new branch of a book made on this device from the working copy of another branch: every file as it is there, so the new branch starts from what the
 * person sees. Its changes against GitHub (saved or already committed in the source) are changes of the new copy, waiting to be published; the source
 * keeps its own. The copy is marked as not on GitHub yet (`pendingBranch`), based on the commit of GitHub the source is based on.
 */
export async function createLocalBranchCopy(input: { source: LocalRepositoryMeta; branch: string; scope: RepositoryOperationScope }): Promise<LocalRepositoryMeta> {
  const { source, branch, scope } = input;
  assertRepositoryOperationScopeCurrent(scope);
  if (source.accountScope !== scope.accountIdentity) throw new RepositoryOwnershipChangedError();
  if (source.cloneComplete !== true) throw new Error("The working copy of the branch is incomplete and cannot be copied.");
  const files = await listAllLocalFiles(source.id);
  const operationId = crypto.randomUUID();
  const created = await createLocalRepositoryClone({
    bookId: source.bookId,
    repositoryKind: source.repositoryKind ?? "book",
    remoteKind: source.remoteKind,
    owner: source.owner,
    repo: source.repo,
    branch,
    defaultBranch: source.defaultBranch,
    remoteHeadSha: source.remoteHeadSha,
    clonedAt: new Date().toISOString(),
    expectedFileCount: files.filter((file) => file.baseSha).length,
    pendingBranch: { base: source.branch, headSha: source.remoteHeadSha, createdAt: new Date().toISOString() },
  }, scope, operationId);
  try {
    for (const file of files) {
      // A committed change is a plain change of the new copy, which has no commits of its own.
      const status: LocalFileStatus = !file.committed ? file.status
        : file.status === "deleted" ? "deleted"
          : !file.baseSha ? "new"
            : file.currentHash === file.baseHash ? "clean" : "modified";
      const { key: _key, repoId: _repoId, ...rest } = file;
      await putClonedLocalFile(created.id, scope, { ...rest, status, committed: false, updatedAt: new Date().toISOString() }, operationId);
    }
    await markLocalRepositoryCloneComplete(created.id, scope, operationId, files.filter((file) => file.baseSha).length);
  } catch (error) {
    await removeAbandonedLocalClone(created, scope, operationId).catch(() => undefined);
    throw error;
  }
  const copy = await getLocalRepository(source.owner, source.repo, branch, scope);
  if (!copy) throw new Error("The new branch could not be read back.");
  return copy;
}
