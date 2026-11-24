import { bookStorageMode, type BookEntry } from "@/types/settings";

/**
 * Where the book's working branch is, in the words of the settings. A book that lives on this device has a local working branch that exists only here; once
 * it is connected to GitHub its content is published on the repository's default branch, and the working branch is the branch the book reads and writes on
 * GitHub: «published as <branch>».
 */
export type WorkingBranchState =
  | { kind: "device" }
  | { kind: "github"; branch: string };

export function workingBranchState(book: Pick<BookEntry, "storageMode" | "activeBranch">, resolvedBranch: string | undefined): WorkingBranchState {
  if (bookStorageMode(book as BookEntry) !== "github") return { kind: "device" };
  return { kind: "github", branch: book.activeBranch ?? resolvedBranch ?? "main" };
}
