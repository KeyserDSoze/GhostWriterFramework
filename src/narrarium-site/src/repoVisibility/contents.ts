import type { BookEntry } from "@/types/settings";
import { getLocalRepository, listLocalFilesUnder } from "@/repository/localRepository";
import { captureRepositoryOperationScope, currentRepositoryScopeIdentity } from "@/repository/repositoryOperationScope";
import { KEPT_IN_REPOSITORY, summarizeKept, type KeptItem } from "@/repoVisibility/model";

/** What Narrarium keeps in the repository of a book that this device's working copy has; `null` when there is no working copy to look in. */
export async function readKeptItems(book: BookEntry, branch: string): Promise<KeptItem[] | null> {
  if (!currentRepositoryScopeIdentity()) return null;
  const scope = captureRepositoryOperationScope();
  const meta = await getLocalRepository(book.owner, book.repo, branch, scope).catch(() => null);
  if (!meta || meta.cloneComplete !== true) return null;
  const found = await Promise.all(KEPT_IN_REPOSITORY.map((item) => listLocalFilesUnder(meta.id, item.path, scope).then((files) => files.map((file) => file.path))));
  return summarizeKept(found.flat());
}
