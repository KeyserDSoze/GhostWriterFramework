import i18n from "@/i18n";
import { toast } from "@/components/ui/use-toast";
import { revertAdoptedBranch, settleAdoptedBranch } from "@/branches/memory";
import { saveSettingsNow } from "@/drive/useSettings";
import { useSettingsStore } from "@/store/settingsStore";
import type { BookEntry } from "@/types/settings";
import "@/i18n/branchesShell";

/** Why the branch chosen last on another device could not be opened here. */
export type AdoptionFailure = "gone" | "needs-github" | "failed";

function pending(bookId: string, branch: string): BookEntry | undefined {
  const book = useSettingsStore.getState().settings.books.find((entry) => entry.id === bookId);
  return book && book.adoptedFrom !== undefined && book.activeBranch === branch ? book : undefined;
}

function replace(bookId: string, update: (book: BookEntry) => BookEntry): void {
  const store = useSettingsStore.getState();
  store.patchSettings({ books: store.settings.books.map((entry) => entry.id === bookId ? update(entry) : entry) });
  // The choice of this device is kept with the rest of its settings; failing to write it only means it is made again on the next start.
  void saveSettingsNow().catch(() => undefined);
}

/** The branch chosen last on another device is open here: it becomes this device's branch, and the person is told which one opened and why. */
export function settleBranchAdoption(bookId: string, branch: string): void {
  const book = pending(bookId, branch);
  if (!book) return;
  const previous = book.adoptedFrom || i18n.t("branchesShell.personalBranch");
  replace(bookId, settleAdoptedBranch);
  toast({ title: i18n.t("branchesShell.adopted.title", { branch }), description: i18n.t("branchesShell.adopted.description", { previous }) });
}

/** It cannot be opened here: the book goes back to the branch it had (returns `true`), says why, and is not moved again until another choice. */
export function revertBranchAdoption(bookId: string, branch: string, failure: AdoptionFailure): boolean {
  const book = pending(bookId, branch);
  if (!book) return false;
  const previous = book.adoptedFrom || i18n.t("branchesShell.personalBranch");
  replace(bookId, revertAdoptedBranch);
  toast({ title: i18n.t("branchesShell.notAdopted.title", { branch }), description: i18n.t(`branchesShell.notAdopted.${failure}`, { branch, previous }) });
  return true;
}
