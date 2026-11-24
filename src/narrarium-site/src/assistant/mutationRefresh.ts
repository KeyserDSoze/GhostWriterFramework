import { getExistingLocalBookStructure } from "@/repository/repositoryService";
import { useBooksStore } from "@/store/booksStore";
import type { BookEntry } from "@/types/settings";
import type { AssistantMessage } from "@/assistant/store";
import { localWorkspaceScope } from "@/account/deviceIdentity";

export async function runPromptWithMutationRefresh<T extends Pick<AssistantMessage, "mutation">>(
  operation: () => Promise<T>,
  refresh: () => Promise<void>,
): Promise<T> {
  let result: T;
  try {
    result = await operation();
  } catch (error) {
    // A handler may have completed one or more repository writes before a later
    // write or model call failed. Refreshing is safe even when no write occurred.
    await refresh();
    throw error;
  }
  if (result.mutation) await refresh();
  return result;
}

export async function refreshBookAfterMutation(input: {
  book: BookEntry;
  token: string;
  branch: string;
}): Promise<void> {
  const generation = useBooksStore.getState().invalidateStructure(input.book.id);
  const identity = localWorkspaceScope();
  const local = await getExistingLocalBookStructure(input.book.id, input.book.owner, input.book.repo, input.branch, identity);
  // Without a working copy of that branch the structure stays invalidated: the book's pages load it again from their own working copy.
  if (local?.structure.loadedBranch === input.branch) useBooksStore.getState().setStructure(input.book.id, local.structure, generation);
}
