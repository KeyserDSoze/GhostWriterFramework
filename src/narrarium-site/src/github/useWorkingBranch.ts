import { useEffect, useRef, useState } from "react";
import { useAuthStore } from "@/store/authStore";
import { useSettingsStore } from "@/store/settingsStore";
import { useBooksStore } from "@/store/booksStore";
import { resolveBookToken } from "@/types/settings";
import { branchIsReady, ensureAuthoritativePersonalBranch, resolveAuthoritativeBranch } from "@/github/branchResolution";

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
  ready: boolean;
  error: string | null;
} {
  const user = useAuthStore((s) => s.user);
  const { settings } = useSettingsStore();
  const { structures, workingBranches, setWorkingBranch } = useBooksStore();

  const book = settings.books.find((b) => b.id === bookId);
  const structure = bookId ? structures[bookId] : undefined;

  const token =
    book ? resolveBookToken(book, settings) : "";

  const [ensuring, setEnsuring] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const ensuredRef = useRef<string | null>(null);

  // Compute the branch name immediately (deterministic, no async needed)
  const resolution = resolveAuthoritativeBranch({ activeBranch: book?.activeBranch, workingBranch: bookId ? workingBranches[bookId] : undefined, loadedBranch: structure?.loadedBranch, defaultBranch: structure?.defaultBranch, userEmail: user?.email });

  useEffect(() => {
    if (!bookId || !book || !structure || !token || !user?.email) return;
    if (book.activeBranch) return;
    // Already resolved this session
    if (workingBranches[bookId]) return;
    const ensureKey = `${bookId}:${user.email}`;
    if (ensuredRef.current === ensureKey) return;
    ensuredRef.current = ensureKey;
    setEnsuring(true);
    setError(null);

    ensureAuthoritativePersonalBranch({ token, owner: book.owner, repo: book.repo, defaultBranch: structure.defaultBranch, email: user.email })
      .then((branch) => setWorkingBranch(bookId, branch))
      .catch((cause) => setError(cause instanceof Error ? cause.message : String(cause)))
      .finally(() => setEnsuring(false));
  }, [book, bookId, structure, token, user?.email, workingBranches, setWorkingBranch]);

  const ready = branchIsReady({ resolution, ensuring, error, personalBranchRecorded: Boolean(bookId && workingBranches[bookId]) });
  return { branch: resolution.branch, ensuring, ready, error };
}
