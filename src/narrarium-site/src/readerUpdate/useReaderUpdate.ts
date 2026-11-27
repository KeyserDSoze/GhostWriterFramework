import { useCallback, useEffect, useMemo } from "react";
import { create } from "zustand";
import { useSettingsStore } from "@/store/settingsStore";
import { useBooksStore } from "@/store/booksStore";
import { loadBookTemplate } from "@/narrarium/bookTemplate";
import { resolveGitHubRemoteToken, type BookEntry } from "@/types/settings";
import { useGitHubRemoteAvailability } from "@/github/remoteAvailability";
import type { ReaderFailure } from "@/readerAccess/errors";
import { classifyWorkflowFailure } from "@/readerAccess/creation";
import { currentRepositoryScopeIdentity, captureRepositoryOperationScope } from "@/repository/repositoryOperationScope";
import { getLocalRepository } from "@/repository/localRepository";
import { RepositorySyncConflictError, syncFullRepository } from "@/repository/repositoryService";
import { useRepositorySyncStore } from "@/store/repositorySyncStore";
import { applyReaderUpdate, openReaderUpdatePullRequest, type ReaderUpdateOutcome } from "@/readerUpdate/apply";
import type { UpdatePullRequest } from "@/readerUpdate/publishingBranch";
import { CustomizedWorkflowRefused } from "@/readerUpdate/commit";
import type { ReaderUpdateInputs } from "@/readerUpdate/decision";
import { inspectReaderUpdate, type ReaderUpdateInspection } from "@/readerUpdate/inspect";

export type ReaderUpdateFailure =
  | { kind: "refused-customized" }
  /** The working copy changed between the check and the commit. */
  | { kind: "changed" }
  | { kind: "github"; failure: ReaderFailure }
  /** The sync needs the person to choose between two copies of a file: the sync dialog has it. */
  | { kind: "conflict" }
  | { kind: "other" };

interface Entry {
  inspection: ReaderUpdateInspection | null;
  checking: boolean;
  applying: boolean;
  outcome: ReaderUpdateOutcome | null;
  failure: ReaderUpdateFailure | null;
  syncing: boolean;
  /** Why the last «Sync now» did not publish, in the same terms as a failed update. */
  syncFailure: ReaderUpdateFailure | null;
  /** The pull request that was opened to carry the update to a protected publishing branch. */
  pullRequest: UpdatePullRequest | null;
  openingPullRequest: boolean;
  pullRequestFailed: boolean;
}

/** The newest check of each book and branch: a slower, older one (made before GitHub was read) never replaces what a newer one found. */
const newestCheck: Record<string, number> = {};

const EMPTY: Entry = { inspection: null, checking: false, applying: false, outcome: null, failure: null, syncing: false, syncFailure: null, pullRequest: null, openingPullRequest: false, pullRequestFailed: false };

/** What was found for each book and branch, so that the tab of the reader and the notice of the GitHub tab show the same thing and one refreshes the other. */
const useReaderUpdateStore = create<{ entries: Record<string, Entry>; patch: (key: string, change: Partial<Entry>) => void }>((set) => ({
  entries: {},
  patch: (key, change) => set((state) => ({ entries: { ...state.entries, [key]: { ...(state.entries[key] ?? EMPTY), ...change } } })),
}));

export function describeUpdateFailure(error: unknown): ReaderUpdateFailure {
  if (error instanceof RepositorySyncConflictError) return { kind: "conflict" };
  if (error instanceof CustomizedWorkflowRefused) return { kind: "refused-customized" };
  if (error && typeof error === "object" && "code" in error && (error as { code?: unknown }).code === "REPOSITORY_CONFLICT") return { kind: "changed" };
  const failure = classifyWorkflowFailure(error);
  return failure.kind === "other" && failure.status === undefined ? { kind: "other" } : { kind: "github", failure };
}

/** The working branch the update is committed on: the one the book works on, the way every other change does. */
export function useWorkingBranch(book: BookEntry): string {
  const { workingBranches, structures } = useBooksStore();
  return book.activeBranch ?? workingBranches[book.id] ?? structures[book.id]?.defaultBranch ?? "main";
}

/** The check of a book's reader and the one commit that updates it. `remote` is what GitHub said of Pages and the passwords, when the caller has read it. */
export function useReaderUpdate(book: BookEntry, remote?: ReaderUpdateInputs["remote"], options: { scope?: string; /** GitHub may be asked for what the publishing branch has (default). `false` while the card is not on the screen: nothing is requested then. */ remoteReads?: boolean; /** The repository's default branch, when the caller has read it; otherwise the one the book's structure has. */ publishingBranch?: string } = {}) {
  const settings = useSettingsStore((state) => state.settings);
  const token = resolveGitHubRemoteToken(book, settings);
  // Checked again when GitHub becomes reachable or not (a connection, a credential GitHub refuses): the delivery of the update follows it.
  const remoteAvailability = useGitHubRemoteAvailability(book, token);
  const branch = useWorkingBranch(book);
  const structureDefault = useBooksStore((state) => state.structures[book.id]?.defaultBranch);
  const publishingBranch = options.publishingBranch ?? structureDefault;
  const remoteReads = options.remoteReads !== false;
  const key = `${book.id}|${branch}${options.scope ? `|${options.scope}` : ""}`;
  const entry = useReaderUpdateStore((state) => state.entries[key]) ?? EMPTY;
  const patch = useReaderUpdateStore((state) => state.patch);
  const pagesOn = remote?.pagesOn ?? null;
  const passwordsSet = remote?.passwordsSet ?? null;
  const workflowText = remote && "workflowText" in remote ? remote.workflowText : undefined;
  const remoteKey = useMemo(() => ({ pagesOn, passwordsSet, ...(workflowText !== undefined ? { workflowText } : {}) }), [pagesOn, passwordsSet, workflowText]);

  const check = useCallback(async () => {
    const mine = (newestCheck[key] = (newestCheck[key] ?? 0) + 1);
    patch(key, { checking: true });
    try {
      const inspection = await inspectReaderUpdate({ book, branch, token, remote: remoteKey, ...(publishingBranch ? { publishingBranch } : {}), readGitHub: remoteReads, loadTemplate: loadBookTemplate });
      if (newestCheck[key] === mine) patch(key, { inspection, checking: false });
    } catch {
      if (newestCheck[key] === mine) patch(key, { checking: false, inspection: null });
    }
  }, [book, branch, token, remoteKey, publishingBranch, remoteReads, key, patch, remoteAvailability]);

  useEffect(() => { void check(); }, [check]);

  const apply = useCallback(async (options: { replaceEdits: boolean }): Promise<ReaderUpdateOutcome | null> => {
    const current = useReaderUpdateStore.getState().entries[key]?.inspection;
    if (!current || current.decision.kind !== "update" || useReaderUpdateStore.getState().entries[key]?.applying) return null;
    patch(key, { applying: true, failure: null, outcome: null, pullRequest: null, pullRequestFailed: false });
    try {
      const outcome = await applyReaderUpdate({ book, branch, token, update: current.decision, workflowHash: current.workflowHash, replaceEdits: options.replaceEdits });
      patch(key, { applying: false, outcome });
      await check();
      return outcome;
    } catch (error) {
      patch(key, { applying: false, failure: describeUpdateFailure(error) });
      return null;
    }
  }, [book, branch, token, key, patch, check]);

  /**
   * Publishes what this device has not sent to GitHub, as the Sync button does (the changes are committed, GitHub is pulled and pushed). A refusal is kept with
   * its reason, never silent; a conflict opens the sync dialog, which is where the two copies are chosen between.
   */
  const syncNow = useCallback(async (): Promise<{ headSha: string | null } | null> => {
    if (useReaderUpdateStore.getState().entries[key]?.syncing) return null;
    patch(key, { syncing: true, syncFailure: null });
    const target = { bookId: book.id, owner: book.owner, repo: book.repo, branch, accountIdentity: currentRepositoryScopeIdentity() };
    try {
      await syncFullRepository({ ...target, token });
      const local = await getLocalRepository(book.owner, book.repo, branch, captureRepositoryOperationScope()).catch(() => null);
      patch(key, { syncing: false });
      await check();
      return { headSha: local?.remoteHeadSha ?? null };
    } catch (error) {
      if (error instanceof RepositorySyncConflictError) useRepositorySyncStore.getState().setConflict({ error, target });
      patch(key, { syncing: false, syncFailure: describeUpdateFailure(error) });
      return null;
    }
  }, [book, branch, token, key, patch, check]);

  /** The way that works when the publishing branch is protected: a pull request from a branch that carries the update. */
  const openPullRequest = useCallback(async (body: string): Promise<UpdatePullRequest | null> => {
    const offer = useReaderUpdateStore.getState().entries[key]?.outcome?.pullRequestOffer;
    if (!offer || useReaderUpdateStore.getState().entries[key]?.openingPullRequest) return null;
    patch(key, { openingPullRequest: true, pullRequestFailed: false });
    try {
      const pullRequest = await openReaderUpdatePullRequest({ book, token, offer, body });
      patch(key, { openingPullRequest: false, pullRequest });
      return pullRequest;
    } catch {
      patch(key, { openingPullRequest: false, pullRequestFailed: true });
      return null;
    }
  }, [book, token, key, patch]);

  return { ...entry, branch, publishingBranch, check, apply, syncNow, openPullRequest, dismissSyncFailure: () => patch(key, { syncFailure: null }), dismissFailure: () => patch(key, { failure: null }) };
}
