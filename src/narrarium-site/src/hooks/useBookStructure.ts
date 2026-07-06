import { useCallback, useEffect } from "react";
import { useTranslation } from "react-i18next";
import { useSettingsStore } from "@/store/settingsStore";
import { useBooksStore } from "@/store/booksStore";
import { loadBookStructure } from "@/github/githubClient";
import { resolveBookToken } from "@/types/settings";
import { ensureLocalBookStructure, getExistingLocalBookStructure } from "@/repository/repositoryService";

export function useBookStructure(bookId: string | undefined) {
  const { t } = useTranslation();
  const { settings } = useSettingsStore();
  const {
    structures,
    loadingIds,
    errors,
    workingBranches,
    setStructure,
    setLoading,
    setError,
    clearBook,
  } = useBooksStore();

  const resolvedBookId = bookId ?? "";
  const book = settings.books.find((entry) => entry.id === resolvedBookId);
  const structure = resolvedBookId ? structures[resolvedBookId] : undefined;
  const loading = resolvedBookId ? loadingIds.has(resolvedBookId) : false;
  const error = resolvedBookId ? errors[resolvedBookId] : undefined;
  const readBranch = book?.activeBranch ?? (resolvedBookId ? workingBranches[resolvedBookId] : undefined) ?? undefined;

  const loadStructure = useCallback(() => {
    if (!book || !resolvedBookId) return;
    const token = resolveBookToken(book, settings);
    if (!token) {
      setError(resolvedBookId, t("bookPage.noTokenConfigured"));
      return;
    }
    setError(resolvedBookId, "");
    setLoading(resolvedBookId, true);
    getExistingLocalBookStructure(resolvedBookId)
      .then((local) => {
        if (local && (!readBranch || local.structure.loadedBranch === readBranch)) return local.structure;
        return ensureLocalBookStructure({ bookId: resolvedBookId, book, token, branch: readBranch }).then((result) => result.structure);
      })
      .catch(() => loadBookStructure(token, book.owner, book.repo, readBranch))
      .then((nextStructure) => {
        setStructure(resolvedBookId, nextStructure);
        setError(resolvedBookId, "");
      })
      .catch((err: unknown) => {
        setError(resolvedBookId, err instanceof Error ? err.message : t("common.loadFailed"));
      })
      .finally(() => setLoading(resolvedBookId, false));
  }, [book, readBranch, resolvedBookId, setError, setLoading, setStructure, settings, t]);

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

  return { book, structure, loading, error, reload };
}
