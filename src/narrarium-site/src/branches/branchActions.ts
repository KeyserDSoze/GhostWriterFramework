import { defaultAutoSyncMode, withBookBranchMemory } from "@/branches/memory";
import { chooseBranch, setBookAutoSync } from "@/branches/memoryEdits";
import { saveSettingsNow } from "@/drive/useSettings";
import { createBranchFromWorkingCopy, publishLocalBranch, type AutoSyncBranchResult } from "@/repository/branchSync";
import { currentRepositoryScopeIdentity } from "@/repository/repositoryOperationScope";
import { useSettingsStore } from "@/store/settingsStore";
import type { BookBranchMemory, BookEntry } from "@/types/settings";

/**
 * What the switcher and the GitHub tab do with the branches of a book: each changes the settings of this device (the branch it is on) and the memory that
 * syncs with the account (which branches, which one last, the automatic sync of the book), and saves them at once.
 */

function bookOf(bookId: string): BookEntry {
  const book = useSettingsStore.getState().settings.books.find((entry) => entry.id === bookId);
  if (!book) throw new Error("The book is not in the settings.");
  return book;
}

async function apply(patch: Parameters<ReturnType<typeof useSettingsStore.getState>["patchSettings"]>[0]): Promise<void> {
  useSettingsStore.getState().patchSettings(patch);
  await saveSettingsNow();
}

/** Open another branch of the book here: it becomes this device's branch, and the last one worked on everywhere. Its pages load it from its own copy. */
export async function switchBranch(bookId: string, branch: string): Promise<void> {
  const settings = useSettingsStore.getState().settings;
  await apply(chooseBranch(settings, bookOf(bookId), branch, new Date().toISOString()));
}

/**
 * A new branch from the one open now, made on this device (it opens at once), then published now when asked and GitHub can be reached, otherwise by the
 * next sync. A failure to publish leaves it here, as made: `publishError` says why.
 */
export async function createBranch(input: { bookId: string; from: string; name: string; publishNow: boolean; token: string }): Promise<{ published?: AutoSyncBranchResult; publishError?: unknown }> {
  const book = bookOf(input.bookId);
  const accountIdentity = currentRepositoryScopeIdentity();
  await createBranchFromWorkingCopy({ bookId: book.id, owner: book.owner, repo: book.repo, branch: input.from, accountIdentity, newBranch: input.name });
  await apply(chooseBranch(useSettingsStore.getState().settings, book, input.name, new Date().toISOString(), { createdHere: true }));
  if (!input.publishNow) return {};
  try {
    return { published: await publishLocalBranch({ bookId: book.id, owner: book.owner, repo: book.repo, branch: input.name, accountIdentity, token: input.token }) };
  } catch (error) {
    return { publishError: error };
  }
}

/** Change the memory of the book's branches (a label, a branch forgotten, kept in sync or not). */
export async function updateBranchMemory(bookId: string, update: (memory: BookBranchMemory | undefined, at: string) => BookBranchMemory): Promise<void> {
  const settings = useSettingsStore.getState().settings;
  const at = new Date().toISOString();
  await apply(withBookBranchMemory(settings, bookOf(bookId), (memory) => update(memory, at)));
}

/**
 * The automatic sync of one book, on or off. On follows the default of the settings, unless that is off: then the book syncs on opening and on focus.
 * `mode` sets one mode explicitly (the GitHub tab); `null` goes back to the default.
 */
export async function setBookAutoSyncMode(bookId: string, mode: "on" | "off" | null | "open-focus" | "periodic"): Promise<void> {
  const settings = useSettingsStore.getState().settings;
  const fallback = defaultAutoSyncMode(settings.repository);
  const next = mode === "off" ? "off" : mode === "on" ? (fallback === "off" ? "open-focus" : undefined) : mode ?? undefined;
  await updateBranchMemory(bookId, (memory, at) => setBookAutoSync(memory, next, at));
}
