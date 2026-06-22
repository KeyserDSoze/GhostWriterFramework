import { useEffect, useRef, useState } from "react";
import { useAuthStore } from "@/store/authStore";
import { useSettingsStore } from "@/store/settingsStore";
import { useBooksStore } from "@/store/booksStore";
import { resolveBookToken } from "@/types/settings";
import { ensureDevBranch, emailToBranchName } from "./githubClient";

/**
 * Ensures the personal dev branch (`dev-{email}`) exists for the given book,
 * creating it from the default branch if needed.
 *
 * Returns:
 *  - `branch`   — the working branch name to use for all reads/writes
 *  - `ensuring` — true while the first-time creation is in progress
 */
export function useWorkingBranch(bookId: string | undefined): {
  branch: string;
  ensuring: boolean;
} {
  const user = useAuthStore((s) => s.user);
  const { settings } = useSettingsStore();
  const { structures, workingBranches, setWorkingBranch } = useBooksStore();

  const book = settings.books.find((b) => b.id === bookId);
  const structure = bookId ? structures[bookId] : undefined;

  const token =
    book ? resolveBookToken(book, settings) : "";

  const [ensuring, setEnsuring] = useState(false);
  const ensuredRef = useRef(false);

  // Compute the branch name immediately (deterministic, no async needed)
  const derivedBranch =
    user?.email ? emailToBranchName(user.email) : structure?.defaultBranch ?? "main";

  useEffect(() => {
    if (!bookId || !book || !structure || !token || !user?.email) return;
    // Already resolved this session
    if (workingBranches[bookId]) return;
    if (ensuredRef.current) return;
    ensuredRef.current = true;
    setEnsuring(true);

    ensureDevBranch(token, book.owner, book.repo, structure.defaultBranch, user.email)
      .then((branch) => setWorkingBranch(bookId, branch))
      .catch(console.error)
      .finally(() => setEnsuring(false));
  }, [book, bookId, structure, token, user?.email, workingBranches, setWorkingBranch]);

  const branch = (bookId ? workingBranches[bookId] : undefined) ?? derivedBranch;

  return { branch, ensuring };
}
