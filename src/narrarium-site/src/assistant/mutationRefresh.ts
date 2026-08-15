import { loadBookStructure } from "@/github/githubClient";
import { getExistingLocalBookStructure } from "@/repository/repositoryService";
import { useBooksStore } from "@/store/booksStore";
import type { BookEntry } from "@/types/settings";
import type { AssistantMessage } from "@/assistant/store";

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
  const local = await getExistingLocalBookStructure(input.book.id);
  const structure = local?.structure.loadedBranch === input.branch
    ? local.structure
    : await loadBookStructure(input.token, input.book.owner, input.book.repo, input.branch);
  useBooksStore.getState().setStructure(input.book.id, structure, generation);
}
