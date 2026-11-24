import { useCallback, useEffect } from "react";
import i18n from "@/i18n";
import { toast } from "@/components/ui/use-toast";
import { ensureAuthoritativePersonalBranch, resolveAuthoritativeBranch } from "@/github/branchResolution";
import { ensureLocalBookStructure, getExistingLocalBookStructure, invalidateRepositoryEnsureOperations, latestCompleteLocalBookStructure } from "@/repository/repositoryService";
import { useAuthStore } from "@/store/authStore";
import { useBooksStore, type LegacyBookStructureErrorCode } from "@/store/booksStore";
import { useSettingsStore } from "@/store/settingsStore";
import { bookStorageMode, resolveBookToken, resolveWorkingCopyToken, type BookEntry } from "@/types/settings";
import { githubRemoteAvailability } from "@/github/remoteAvailability";
import "@/i18n/localFirst";
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

/** What of the book is missing on this device when GitHub cannot bring it: the whole copy, the branch it is set to, or the rest of an interrupted download. */
type MissingCopy = "book" | "branch" | "incomplete";

class WorkingCopyUnavailableError extends Error {
  constructor(readonly missing: MissingCopy) {
    super(`The working copy (${missing}) cannot be brought to this device without GitHub.`);
  }
}

/** Why the working copy of a book cannot be brought to this device now: it lives on another device, there is no GitHub credential, or the browser is offline. */
function missingWorkingCopyMessage(book: BookEntry, token: string, missing: MissingCopy, branch: string): string {
  if (bookStorageMode(book) === "local-only") return i18n.t(book.localRepositoryId ? "common.loadFailed" : "localFirst.localBookOnAnotherDevice");
  const remote = githubRemoteAvailability(book, token);
  if (remote !== "no-credential" && remote !== "offline") return i18n.t("common.loadFailed");
  const reason = remote === "offline" ? "Offline" : "NoCredential";
  return missing === "branch" ? i18n.t(`localFirst.branchNotDownloaded${reason}`, { branch })
    : i18n.t(missing === "incomplete" ? `localFirst.incomplete${reason}` : `localFirst.notDownloaded${reason}`);
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

  // Set once the book needs its working copy brought to this device (a clone, a repair, a personal branch): then a failure says why that cannot happen now.
  let needsDownload = false;
  let missingCopy: MissingCopy = "book";
  const promise = (async () => {
    // GitHub brings a copy to this device, and only with a credential and a connection; a book kept on this device makes its own. A copy already here is
    // opened in every case.
    const tokenValue = resolveBookToken(book, settings);
    const canDownload = () => bookStorageMode(book) === "local-only" || githubRemoteAvailability(book, tokenValue) === "ready";
    const unavailable = (missing: MissingCopy) => {
      needsDownload = true;
      missingCopy = missing;
      return new WorkingCopyUnavailableError(missing);
    };
    // Without GitHub a branch that is not here can be neither made nor downloaded: the book keeps working on the copy of it this device has, on its branch.
    const keepLocalCopy = async () => {
      const kept = await latestCompleteLocalBookStructure(bookId, book.owner, book.repo, identity);
      // The operation still owns the book before it moves it to the branch of that copy: the working branch is what makes the move the current one.
      if (!kept || !ownsOperation()) return null;
      authoritativeBranch = kept.meta.branch;
      operationBranch = authoritativeBranch;
      useBooksStore.getState().setWorkingBranch(bookId, authoritativeBranch);
      return kept;
    };

    let authoritativeBranch = operationBranch;
    let local = await getExistingLocalBookStructure(bookId, book.owner, book.repo, authoritativeBranch, identity, { includeIncomplete: true });
    // A personal branch is made on GitHub: a book kept on this device has none, its branch is the one of its working copy.
    if (resolution.requiresCreation && user?.email && !books.workingBranches[bookId] && bookStorageMode(book) !== "local-only") {
      if (local?.meta.cloneComplete !== true) {
        needsDownload = true;
        const personal = canDownload()
          ? await ensureAuthoritativePersonalBranch({
            token: tokenValue,
            owner: book.owner,
            repo: book.repo,
            defaultBranch: books.structures[bookId]?.defaultBranch ?? "main",
            email: user.email,
          }).catch((error: unknown) => {
            // GitHub refused the credential, or went out of reach: the book stays on a copy this device has.
            if (canDownload()) throw error;
            return null;
          })
          : null;
        if (personal) {
          authoritativeBranch = personal;
          local = await getExistingLocalBookStructure(bookId, book.owner, book.repo, authoritativeBranch, identity, { includeIncomplete: true });
        } else {
          local = await keepLocalCopy();
          if (!local) throw unavailable("book");
          needsDownload = false;
        }
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
        if (!canDownload()) throw unavailable("incomplete");
        needsDownload = true;
        missingCopy = "incomplete";
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
    } else if (!canDownload()) {
      // A branch the author chose is not changed behind their back: it is said which one is missing, when the book has another copy here.
      const kept = resolution.source === "active" ? null : await keepLocalCopy();
      if (!kept) throw unavailable(resolution.source === "active" && await latestCompleteLocalBookStructure(bookId, book.owner, book.repo, identity) ? "branch" : "book");
      nextStructure = kept.structure;
    } else {
      needsDownload = true;
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

    if (scopeIsCurrent()) {
      for (let attempt = 0; attempt < 3 && scopeIsCurrent(); attempt += 1) {
        try {
          // The default ghostwriter is written into the working copy: like any other change, it needs no credential.
          const changed = await ensureDefaultGhostwriter({ token: resolveWorkingCopyToken(book, settings), book, branch: authoritativeBranch, structure: nextStructure, signal: controller.signal });
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
      // The credential is read again: GitHub may have just refused the one the book had.
      const token = resolveBookToken(book, useSettingsStore.getState().settings);
      const noCredential = needsDownload && bookStorageMode(book) !== "local-only" && githubRemoteAvailability(book, token) === "no-credential";
      useBooksStore.getState().setError(bookId, legacy
        ? { code: legacy, adoptionTarget: error && typeof error === "object" && "adoptionTarget" in error ? error.adoptionTarget as import("@/auth/legacyAdoptionConsent").LegacyAdoptionTarget | undefined : undefined }
        : { code: "BOOK_STRUCTURE_LOAD_FAILED", message: needsDownload ? missingWorkingCopyMessage(book, token, missingCopy, operationBranch) : i18n.t("common.loadFailed"), ...(noCredential ? { connectGitHub: true } : {}) });
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
