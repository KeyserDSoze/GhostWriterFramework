import { useCallback, useEffect } from "react";
import { useTranslation } from "react-i18next";
import { useSettingsStore } from "@/store/settingsStore";
import { useBooksStore } from "@/store/booksStore";
import { loadBookStructure } from "@/github/githubClient";
import { ensureAuthoritativePersonalBranch, resolveAuthoritativeBranch } from "@/github/branchResolution";
import { resolveBookToken } from "@/types/settings";
import { ensureLocalBookStructure, fetchRemoteStatus, getExistingLocalBookStructure, pullRemoteChanges, verifyAndRepairLocalRepository } from "@/repository/repositoryService";
import { useAuthStore } from "@/store/authStore";
import { useToast } from "@/components/ui/use-toast";
import { accountIdentity, isAccountIdentityCurrent } from "@/auth/accountIdentity";

function remoteChangedNoticeKey(bookId: string, remoteHeadSha: string): string {
  return `narrarium-remote-changed-${bookId}-${remoteHeadSha}`;
}

export function useBookStructure(bookId: string | undefined) {
  const { t } = useTranslation();
  const user = useAuthStore((s) => s.user);
  const { toast } = useToast();
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
    setWorkingBranch,
    clearBook,
  } = useBooksStore();

  const resolvedBookId = bookId ?? "";
  const book = settings.books.find((entry) => entry.id === resolvedBookId);
  const structure = resolvedBookId ? structures[resolvedBookId] : undefined;
  const loading = resolvedBookId ? loadingIds.has(resolvedBookId) : false;
  const error = resolvedBookId ? errors[resolvedBookId] : undefined;
  const progress = resolvedBookId ? cloneProgress[resolvedBookId] : undefined;
  const branchResolution = resolveAuthoritativeBranch({ activeBranch: book?.activeBranch, workingBranch: resolvedBookId ? workingBranches[resolvedBookId] : undefined, loadedBranch: structure?.loadedBranch, defaultBranch: structure?.defaultBranch, userEmail: user?.email });
  const readBranch = branchResolution.branch;

  const loadStructure = useCallback(() => {
    if (!book || !resolvedBookId) return;
    const expectedIdentity = accountIdentity(user);
    if (!expectedIdentity) return;
    const ownsLoad = () => isAccountIdentityCurrent(expectedIdentity, useAuthStore.getState().user);
    const token = resolveBookToken(book, settings);
    const generation = useBooksStore.getState().structureGenerations[resolvedBookId] ?? 0;
    if (!token) {
      setError(resolvedBookId, t("bookPage.noTokenConfigured"));
      return;
    }
    setError(resolvedBookId, "");
    setLoading(resolvedBookId, true);
    setCloneProgress(resolvedBookId, undefined);
    void (async () => {
      let authoritativeBranch = readBranch;
      if (branchResolution.requiresCreation && user?.email && !workingBranches[resolvedBookId]) {
        authoritativeBranch = await ensureAuthoritativePersonalBranch({ token, owner: book.owner, repo: book.repo, defaultBranch: structure?.defaultBranch ?? "main", email: user.email });
        if (!ownsLoad()) return;
        setWorkingBranch(resolvedBookId, authoritativeBranch);
      }
      try {
        const local = await getExistingLocalBookStructure(resolvedBookId, book.owner, book.repo, authoritativeBranch, expectedIdentity);
        let nextStructure;
        if (local && local.structure.loadedBranch === authoritativeBranch) {
          // Heal partial/legacy clones: a repo is only trustworthy once verified complete.
          // When online, re-fetch any files missing from an interrupted clone before serving it.
          if (local.meta.cloneComplete !== true && navigator.onLine) {
            try {
              const repaired = await verifyAndRepairLocalRepository({ meta: local.meta, token, accountIdentity: expectedIdentity, onProgress: (p) => { if (ownsLoad()) setCloneProgress(resolvedBookId, p); } });
              nextStructure = repaired.structure;
            } catch {
              nextStructure = local.structure;
            }
          } else {
            nextStructure = local.structure;
          }
        } else {
          nextStructure = (await ensureLocalBookStructure({ bookId: resolvedBookId, book, token, accountIdentity: expectedIdentity, branch: authoritativeBranch, onProgress: (p) => { if (ownsLoad()) setCloneProgress(resolvedBookId, p); } })).structure;
        }
        if (nextStructure.loadedBranch !== authoritativeBranch) throw new Error(`Loaded branch ${nextStructure.loadedBranch} does not match authoritative branch ${authoritativeBranch}.`);
        if (!ownsLoad()) return;
        setStructure(resolvedBookId, nextStructure, generation);
        setError(resolvedBookId, "");
        if (settings.repository.autoFetchOnOpen && navigator.onLine) {
          try {
          const target = { bookId: resolvedBookId, owner: book.owner, repo: book.repo, branch: authoritativeBranch, accountIdentity: expectedIdentity };
            const remote = await fetchRemoteStatus({ ...target, token });
            if (remote.changed && settings.repository.autoPullWhenClean) {
              await pullRemoteChanges({ ...target, token });
              const refreshed = await getExistingLocalBookStructure(resolvedBookId, book.owner, book.repo, authoritativeBranch, expectedIdentity);
              if (refreshed && ownsLoad()) setStructure(resolvedBookId, refreshed.structure, generation);
            } else if (remote.changed) {
              const key = remoteChangedNoticeKey(resolvedBookId, remote.remoteHeadSha);
              if (!sessionStorage.getItem(key)) {
                sessionStorage.setItem(key, "1");
                toast({ title: t("repoStatus.remoteBehindTitle"), description: t("repoStatus.remoteBehindDescription") });
              }
            }
          } catch {
            // Remote checks are opportunistic; local offline editing stays available.
          }
        }
      } catch (localError) {
        try {
          const nextStructure = await loadBookStructure(token, book.owner, book.repo, authoritativeBranch);
          if (!ownsLoad()) return;
          setStructure(resolvedBookId, nextStructure, generation);
          setError(resolvedBookId, "");
        } catch (err) {
          if (ownsLoad()) setError(resolvedBookId, err instanceof Error ? err.message : localError instanceof Error ? localError.message : t("common.loadFailed"));
        }
      } finally {
        if (!ownsLoad()) return;
        setCloneProgress(resolvedBookId, undefined);
        setLoading(resolvedBookId, false);
      }
    })().catch((err: unknown) => {
        if (ownsLoad()) setError(resolvedBookId, err instanceof Error ? err.message : t("common.loadFailed"));
        if (ownsLoad()) {
          setCloneProgress(resolvedBookId, undefined);
          setLoading(resolvedBookId, false);
        }
      });
  }, [book, branchResolution.requiresCreation, readBranch, resolvedBookId, setCloneProgress, setError, setLoading, setStructure, setWorkingBranch, settings, structure?.defaultBranch, t, toast, user, workingBranches]);

  useEffect(() => {
    if (!book || !resolvedBookId || loading || error) return;
    if (structure && (!readBranch || structure.loadedBranch === readBranch)) return;
    loadStructure();
  }, [book, error, loadStructure, loading, readBranch, resolvedBookId, structure]);

  const reload = useCallback(() => {
    if (!resolvedBookId) return;
    clearBook(resolvedBookId);
    loadStructure();
  }, [clearBook, loadStructure, resolvedBookId]);

  return { book, structure, loading, error, reload, cloneProgress: progress };
}
