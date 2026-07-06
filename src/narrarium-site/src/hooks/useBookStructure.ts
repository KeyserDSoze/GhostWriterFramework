import { useCallback, useEffect } from "react";
import { useTranslation } from "react-i18next";
import { useSettingsStore } from "@/store/settingsStore";
import { useBooksStore } from "@/store/booksStore";
import { loadBookStructure } from "@/github/githubClient";
import { emailToBranchName } from "@/github/githubClient";
import { resolveBookToken } from "@/types/settings";
import { ensureLocalBookStructure, fetchRemoteStatus, getExistingLocalBookStructure, pullRemoteChanges } from "@/repository/repositoryService";
import { useAuthStore } from "@/store/authStore";

export function useBookStructure(bookId: string | undefined) {
  const { t } = useTranslation();
  const user = useAuthStore((s) => s.user);
  const { settings } = useSettingsStore();
  const {
    structures,
    loadingIds,
    errors,
    workingBranches,
    cloneProgress,
    setStructure,
    setLoading,
    setError,
    setCloneProgress,
    clearBook,
  } = useBooksStore();

  const resolvedBookId = bookId ?? "";
  const book = settings.books.find((entry) => entry.id === resolvedBookId);
  const structure = resolvedBookId ? structures[resolvedBookId] : undefined;
  const loading = resolvedBookId ? loadingIds.has(resolvedBookId) : false;
  const error = resolvedBookId ? errors[resolvedBookId] : undefined;
  const progress = resolvedBookId ? cloneProgress[resolvedBookId] : undefined;
  const readBranch = book?.activeBranch
    ?? (resolvedBookId ? workingBranches[resolvedBookId] : undefined)
    ?? (user?.email ? emailToBranchName(user.email) : undefined);

  const loadStructure = useCallback(() => {
    if (!book || !resolvedBookId) return;
    const token = resolveBookToken(book, settings);
    if (!token) {
      setError(resolvedBookId, t("bookPage.noTokenConfigured"));
      return;
    }
    setError(resolvedBookId, "");
    setLoading(resolvedBookId, true);
    setCloneProgress(resolvedBookId, undefined);
    getExistingLocalBookStructure(resolvedBookId)
      .then(async (local) => {
        if (local && (!readBranch || local.structure.loadedBranch === readBranch)) return local.structure;
        return ensureLocalBookStructure({ bookId: resolvedBookId, book, token, branch: readBranch, onProgress: (p) => setCloneProgress(resolvedBookId, p) }).then((result) => result.structure);
      })
      .catch(() => loadBookStructure(token, book.owner, book.repo, readBranch))
      .then(async (nextStructure) => {
        setStructure(resolvedBookId, nextStructure);
        setError(resolvedBookId, "");
        if (settings.repository.autoFetchOnOpen && navigator.onLine) {
          try {
            const remote = await fetchRemoteStatus({ bookId: resolvedBookId, token });
            if (remote.changed && settings.repository.autoPullWhenClean) {
              await pullRemoteChanges({ bookId: resolvedBookId, token });
              const refreshed = await getExistingLocalBookStructure(resolvedBookId);
              if (refreshed) setStructure(resolvedBookId, refreshed.structure);
            }
          } catch {
            // Remote checks are opportunistic; local offline editing stays available.
          }
        }
      })
      .catch((err: unknown) => {
        setError(resolvedBookId, err instanceof Error ? err.message : t("common.loadFailed"));
      })
      .finally(() => { setCloneProgress(resolvedBookId, undefined); setLoading(resolvedBookId, false); });
  }, [book, readBranch, resolvedBookId, setCloneProgress, setError, setLoading, setStructure, settings, t]);

  useEffect(() => {
    if (!book || !resolvedBookId || loading) return;
    if (structure && (!readBranch || structure.loadedBranch === readBranch)) return;
    loadStructure();
  }, [book, loadStructure, loading, readBranch, resolvedBookId, structure]);

  const reload = useCallback(() => {
    if (!resolvedBookId) return;
    clearBook(resolvedBookId);
    loadStructure();
  }, [clearBook, loadStructure, resolvedBookId]);

  return { book, structure, loading, error, reload, cloneProgress: progress };
}
