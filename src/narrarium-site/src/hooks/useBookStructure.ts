import { useCallback, useEffect } from "react";
import i18n from "@/i18n";
import { toast } from "@/components/ui/use-toast";
import { ensureAuthoritativePersonalBranch, resolveAuthoritativeBranch } from "@/github/branchResolution";
import { ensureLocalBookStructure, getExistingLocalBookStructure, invalidateRepositoryEnsureOperations } from "@/repository/repositoryService";
import { useAuthStore } from "@/store/authStore";
import { useBooksStore, type LegacyBookStructureErrorCode } from "@/store/booksStore";
import { useSettingsStore } from "@/store/settingsStore";
import { resolveBookToken } from "@/types/settings";
import { ensureDefaultGhostwriter } from "@/narrarium/defaultGhostwriter";
import { currentRepositoryScopeIdentity } from "@/repository/repositoryOperationScope";

type Operation = { token: string; epoch: number; controller: AbortController; promise: Promise<void> };

const operations = new Map<string, Operation>();
const failedOperations = new Set<string>();
let operationSequence = 0;
let loadEpoch = 0;

export function resetBookStructureLoadCoordinator(): number {
  loadEpoch += 1;
  useBooksStore.setState({ structureLoadEpoch: loadEpoch });
  invalidateRepositoryEnsureOperations(loadEpoch, currentRepositoryScopeIdentity());
  for (const operation of operations.values()) operation.controller.abort();
  operations.clear();
  failedOperations.clear();
  return loadEpoch;
}

export function retryBookStructureLoad(bookId: string): number {
  const generation = useBooksStore.getState().invalidateStructure(bookId);
  failedOperations.forEach((key) => {
    if (key.includes(`::${bookId}::`)) failedOperations.delete(key);
  });
  return generation;
}

function operationKey(epoch: number, identity: string, bookId: string, owner: string, repo: string, branch: string, generation: number): string {
  return `${epoch}::${identity}::${bookId}::${owner}/${repo}#${branch}::${generation}`;
}

function startBookStructureOperation(bookId: string, requestedGeneration?: number): Promise<void> | undefined {
  const user = useAuthStore.getState().user;
  const identity = currentRepositoryScopeIdentity();
  const settings = useSettingsStore.getState().settings;
  const book = settings.books.find((entry) => entry.id === bookId);
  if (!book) return;

  const books = useBooksStore.getState();
  const epoch = loadEpoch;
  if (books.structureLoadEpoch !== epoch) return;
  const generation = requestedGeneration ?? books.structureGenerations[bookId] ?? 0;
  if ((books.structureGenerations[bookId] ?? 0) !== generation) return;
  const resolution = resolveAuthoritativeBranch({
    activeBranch: book.activeBranch,
    workingBranch: books.workingBranches[bookId],
    loadedBranch: books.structures[bookId]?.loadedBranch,
    defaultBranch: books.structures[bookId]?.defaultBranch,
    userEmail: user?.email,
  });
  const branch = resolution.branch;
  const key = operationKey(epoch, identity, bookId, book.owner, book.repo, branch, generation);
  const bookKeyPart = `::${bookId}::`;
  for (const [operationKeyValue, operation] of operations) {
    if (operationKeyValue !== key && operation.epoch === epoch && operationKeyValue.includes(bookKeyPart)) {
      operation.controller.abort();
      operations.delete(operationKeyValue);
    }
  }
  for (const failedKey of failedOperations) {
    if (failedKey !== key && failedKey.includes(bookKeyPart)) failedOperations.delete(failedKey);
  }
  const active = operations.get(key);
  if (active) return active.promise;
  if (failedOperations.has(key)) return;
  if (books.structures[bookId]?.loadedBranch === branch) return;

  const token = `${epoch}:${Date.now()}-${++operationSequence}`;
  const controller = new AbortController();
  let operationBranch = branch;
  const scopeIsCurrent = () => {
    const currentUser = useAuthStore.getState().user;
    const currentBooks = useBooksStore.getState();
    const currentBook = useSettingsStore.getState().settings.books.find((entry) => entry.id === bookId);
    if (!currentBook || currentBook.owner !== book.owner || currentBook.repo !== book.repo) return false;
    const currentBranch = resolveAuthoritativeBranch({
      activeBranch: currentBook.activeBranch,
      workingBranch: currentBooks.workingBranches[bookId],
      loadedBranch: currentBooks.structures[bookId]?.loadedBranch,
      defaultBranch: currentBooks.structures[bookId]?.defaultBranch,
      userEmail: currentUser?.email,
    }).branch;
    return loadEpoch === epoch
      && identity === currentRepositoryScopeIdentity()
      && (currentBooks.structureGenerations[bookId] ?? 0) === generation
      && currentBranch === operationBranch;
  };
  const ownsOperation = () => {
    const current = useBooksStore.getState();
    return scopeIsCurrent()
      && current.activeStructureOperations[bookId]?.token === token;
  };
  const finishLocalLoading = () => {
    if (!ownsOperation()) return;
    const state = useBooksStore.getState();
    state.setCloneProgress(bookId, undefined);
    state.endStructureOperation(bookId, token);
  };

  books.setError(bookId);
  books.setCloneProgress(bookId, undefined);
  books.beginStructureOperation(bookId, token, epoch, generation);

  const promise = (async () => {
    const tokenValue = resolveBookToken(book, settings);

    let authoritativeBranch = operationBranch;
    let local = await getExistingLocalBookStructure(bookId, book.owner, book.repo, authoritativeBranch, identity, { includeIncomplete: true });
    if (resolution.requiresCreation && user?.email && !books.workingBranches[bookId]) {
      if (local?.meta.cloneComplete !== true) {
        if (!tokenValue) throw new Error(i18n.t("bookPage.noTokenConfigured"));
        authoritativeBranch = await ensureAuthoritativePersonalBranch({
          token: tokenValue,
          owner: book.owner,
          repo: book.repo,
          defaultBranch: books.structures[bookId]?.defaultBranch ?? "main",
          email: user.email,
        });
        local = await getExistingLocalBookStructure(bookId, book.owner, book.repo, authoritativeBranch, identity, { includeIncomplete: true });
      }
      operationBranch = authoritativeBranch;
      if (!ownsOperation()) return;
      useBooksStore.getState().setWorkingBranch(bookId, authoritativeBranch);
    }

    let nextStructure;
    if (local?.structure.loadedBranch === authoritativeBranch) {
      if (local.meta.cloneComplete === true) {
        nextStructure = local.structure;
      } else {
        if (!navigator.onLine) throw new Error("The local working copy is incomplete and requires an online repair.");
        if (!tokenValue) throw new Error(i18n.t("bookPage.noTokenConfigured"));
        nextStructure = (await ensureLocalBookStructure({
          bookId,
          book,
          token: tokenValue,
          accountIdentity: identity,
          branch: authoritativeBranch,
          onProgress: (progress) => {
            if (ownsOperation()) useBooksStore.getState().setCloneProgress(bookId, { ...progress, phase: progress.phase ?? "repairing" });
          },
        })).structure;
      }
    } else {
      if (!tokenValue) throw new Error(i18n.t("bookPage.noTokenConfigured"));
      const ensured = await ensureLocalBookStructure({
        bookId,
        book,
        token: tokenValue,
        accountIdentity: identity,
        branch: authoritativeBranch,
        onProgress: (progress) => {
          if (ownsOperation()) useBooksStore.getState().setCloneProgress(bookId, progress);
        },
      });
      nextStructure = ensured.structure;
      if (ensured.cloned && ownsOperation()) toast({ title: i18n.t("repoStatus.cloneRestored") });
    }
    if (nextStructure.loadedBranch !== authoritativeBranch) {
      throw new Error(`Loaded branch ${nextStructure.loadedBranch} does not match authoritative branch ${authoritativeBranch}.`);
    }
    if (!ownsOperation()) return;
    useBooksStore.getState().setStructure(bookId, nextStructure, generation);
    useBooksStore.getState().setError(bookId);
    finishLocalLoading();

    if (tokenValue && scopeIsCurrent()) {
      for (let attempt = 0; attempt < 3 && scopeIsCurrent(); attempt += 1) {
        try {
          const changed = await ensureDefaultGhostwriter({ token: tokenValue, book, branch: authoritativeBranch, structure: nextStructure, signal: controller.signal });
          if (changed) {
            const refreshed = await getExistingLocalBookStructure(bookId, book.owner, book.repo, authoritativeBranch, identity);
            if (refreshed) nextStructure = refreshed.structure;
            if (scopeIsCurrent()) useBooksStore.getState().setStructure(bookId, nextStructure, generation);
          }
          break;
        } catch (error) {
          if (controller.signal.aborted) return;
          if (attempt < 2) {
            await new Promise((resolve) => window.setTimeout(resolve, 250 * (attempt + 1)));
            continue;
          }
          toast({ title: i18n.t("ghostwriters.provisionFailed"), description: error instanceof Error ? error.message : String(error), variant: "destructive" });
        }
      }
    }

    // Opening a local working copy never contacts its remote. Fetch/pull/push are
    // explicit or scheduled repository operations and validate credentials lazily.
  })().catch((error: unknown) => {
    if (loadEpoch === epoch) failedOperations.add(key);
    if (ownsOperation()) {
      const code = error && typeof error === "object" && "code" in error ? error.code : undefined;
      const legacy = typeof code === "string" && ["LEGACY_REPOSITORY_AUTH_REQUIRED", "LEGACY_REPOSITORY_COPY_CONFLICT", "LEGACY_REPOSITORY_ADOPTION_DECLINED", "LEGACY_REPOSITORY_CHANGED"].includes(code)
        ? code as LegacyBookStructureErrorCode
        : null;
      useBooksStore.getState().setError(bookId, legacy
        ? { code: legacy, adoptionTarget: error && typeof error === "object" && "adoptionTarget" in error ? error.adoptionTarget as import("@/auth/legacyAdoptionConsent").LegacyAdoptionTarget | undefined : undefined }
        : { code: "BOOK_STRUCTURE_LOAD_FAILED", message: i18n.t("common.loadFailed") });
    }
  }).finally(() => {
    finishLocalLoading();
    if (operations.get(key)?.token === token) operations.delete(key);
  });

  operations.set(key, { token, epoch, controller, promise });
  return promise;
}

export function useBookStructure(bookId: string | undefined) {
  const resolvedBookId = bookId ?? "";
  const user = useAuthStore((state) => state.user);
  const book = useSettingsStore((state) => state.settings.books.find((entry) => entry.id === resolvedBookId));
  const structure = useBooksStore((state) => resolvedBookId ? state.structures[resolvedBookId] : undefined);
  const loading = useBooksStore((state) => resolvedBookId ? state.loadingIds.has(resolvedBookId) : false);
  const error = useBooksStore((state) => resolvedBookId ? state.errors[resolvedBookId] : undefined);
  const progress = useBooksStore((state) => resolvedBookId ? state.cloneProgress[resolvedBookId] : undefined);
  const workingBranch = useBooksStore((state) => resolvedBookId ? state.workingBranches[resolvedBookId] : undefined);
  const generation = useBooksStore((state) => resolvedBookId ? state.structureGenerations[resolvedBookId] ?? 0 : 0);
  const epoch = useBooksStore((state) => state.structureLoadEpoch);
  const readBranch = resolveAuthoritativeBranch({ activeBranch: book?.activeBranch, workingBranch, loadedBranch: structure?.loadedBranch, defaultBranch: structure?.defaultBranch, userEmail: user?.email }).branch;

  useEffect(() => {
    if (!resolvedBookId || !book || structure?.loadedBranch === readBranch) return;
    startBookStructureOperation(resolvedBookId, generation);
  }, [resolvedBookId, book?.owner, book?.repo, book?.activeBranch, user?.provider, user?.providerAccountId, user?.homeAccountId, user?.email, readBranch, structure?.loadedBranch, generation, epoch]);

  const reload = useCallback(() => {
    if (!resolvedBookId) return;
    const nextGeneration = retryBookStructureLoad(resolvedBookId);
    startBookStructureOperation(resolvedBookId, nextGeneration);
  }, [resolvedBookId]);

  return { book, structure, loading, error, reload, cloneProgress: progress };
}
