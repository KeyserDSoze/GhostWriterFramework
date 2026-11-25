import {
  cycleMayStart,
  decideBranchAction,
  outcomeIsVisible,
  pauseAfterFailure,
  rateLimitAllows,
  selectBranchesToSync,
  triggerRuns,
  type BranchCandidate,
  type BranchOutcomeKind,
  type SyncTrigger,
} from "@/branches/autoSyncPolicy";
import { bookAutoSyncMode, bookBranchMemory } from "@/branches/memory";
import { listRemoteBranches, rememberRemoteHead } from "@/branches/remoteBranches";
import { emptyBookSyncState, useBranchSyncStore, type BookSyncState, type BranchSyncOutcome, type CycleSummary } from "@/branches/syncStore";
import { resolveAuthoritativeBranch } from "@/github/branchRules";
import { githubRemoteAvailability } from "@/github/remoteAvailability";
import { getLocalRepositoryStatusSnapshot, listLocalRepositoriesByBook, type LocalRepositoryMeta } from "@/repository/localRepository";
import { classifyRepositoryError, type RepositoryError } from "@/repository/repositoryError";
import { currentRepositoryScopeIdentity } from "@/repository/repositoryOperationScope";
import { ensureLocalBookStructure, getExistingLocalBookStructure } from "@/repository/repositoryService";
import { autoSyncBranch } from "@/repository/branchSync";
import { useAutopilotStore } from "@/autopilot/store";
import { interruptedRuns } from "@/autopilot/resume";
import { useAuthStore } from "@/store/authStore";
import { useBooksStore } from "@/store/booksStore";
import { useSettingsStore } from "@/store/settingsStore";
import { bookStorageMode, resolveBookToken, type BookEntry } from "@/types/settings";
import { AUTOPILOT_LOCK_PREFIX, EDITING_LOCK_PREFIX, REPOSITORY_LOCK_PREFIX } from "@/branches/locks";

const BACKGROUND_CONCURRENCY = 2;

/** What the cycle needs of the browser, injectable for the tests. */
export interface AutoSyncHost {
  now(): number;
  /** The names of the Web Locks held in this browser now. */
  heldLocks(): Promise<Set<string>>;
  /** The autopilot of the book runs on the personal server: its pushes are not raced. */
  serverAutopilotRunning(bookId: string): boolean;
  /** A branch got new files from GitHub: the pages that show it read them again. */
  branchUpdated(bookId: string, branch: string): void;
}

export function browserAutoSyncHost(onBranchUpdated: (bookId: string, branch: string) => void = refreshLoadedBranch): AutoSyncHost {
  return {
    now: () => Date.now(),
    heldLocks: async () => {
      const manager = typeof navigator !== "undefined" ? navigator.locks : undefined;
      const snapshot = await manager?.query?.().catch(() => null);
      return new Set((snapshot?.held ?? []).map((lock) => lock.name ?? "").filter(Boolean));
    },
    serverAutopilotRunning: (bookId) => useAutopilotStore.getState().views[bookId]?.server?.running === true,
    branchUpdated: onBranchUpdated,
  };
}

/** The structure of the book on the screen of this tab, read again from its working copy when its branch got new files. */
export async function refreshLoadedBranch(bookId: string, branch: string): Promise<void> {
  const book = useSettingsStore.getState().settings.books.find((entry) => entry.id === bookId);
  if (!book || useBooksStore.getState().structures[bookId]?.loadedBranch !== branch) return;
  const local = await getExistingLocalBookStructure(bookId, book.owner, book.repo, branch, currentRepositoryScopeIdentity()).catch(() => null);
  if (local && useBooksStore.getState().structures[bookId]?.loadedBranch === branch) useBooksStore.getState().setStructure(bookId, local.structure);
}

/** The branch the pages of the book use, by the same rule (`resolveAuthoritativeBranch`). */
export function currentBranchOf(book: BookEntry): string {
  const books = useBooksStore.getState();
  const structure = books.structures[book.id];
  return resolveAuthoritativeBranch({ activeBranch: book.activeBranch, workingBranch: books.workingBranches[book.id], loadedBranch: structure?.loadedBranch, defaultBranch: structure?.defaultBranch, userEmail: useAuthStore.getState().user?.email }).branch;
}

async function mapLimit<T>(items: T[], limit: number, run: (item: T) => Promise<void>): Promise<void> {
  let next = 0;
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (next < items.length) await run(items[next++]);
  }));
}

/**
 * One cycle of the automatic sync of a GitHub book (`branch`: the branch the asking tab shows; by default the one these settings give): nothing at all without GitHub (`githubRemoteAvailability`), when the mode does not run on this trigger,
 * too soon after the last one, or while the browser autopilot runs the book or is to be resumed by itself after a reload; otherwise one conditional list of the branches of GitHub, then the current
 * branch and the ones it brings along, each as `decideBranchAction` says. Returns, and publishes in `useBranchSyncStore`, what the book's sync knows now.
 */
export async function runBookSyncCycle(bookId: string, trigger: SyncTrigger, host: AutoSyncHost = browserAutoSyncHost(), options: { branch?: string } = {}): Promise<BookSyncState> {
  const store = useBranchSyncStore.getState();
  const previous = store.books[bookId] ?? emptyBookSyncState();
  const now = host.now();
  const settings = useSettingsStore.getState().settings;
  const book = settings.books.find((entry) => entry.id === bookId);
  if (!book || bookStorageMode(book) !== "github" || !book.owner || !book.repo) return previous;
  const token = resolveBookToken(book, settings);
  // No credential, one GitHub refused, offline: nothing is asked of GitHub, and the branch button says why (from the same decision).
  if (githubRemoteAvailability(book, token) !== "ready") return previous;
  if (!triggerRuns(bookAutoSyncMode(settings, book), trigger)) return previous;
  if (!cycleMayStart(trigger, { now, lastCycleAt: previous.lastCycleAt, pausedUntil: previous.pausedUntil })) return previous;
  const held = await host.heldLocks();
  const identity = currentRepositoryScopeIdentity();
  // The browser autopilot of the book runs (its lock), or this browser will resume it by itself (its intent, kept from the start of the run until it
  // ends, is paused or stopped, or moves to the server): after a reload, the run is re-created a little later, and nothing is synced meanwhile.
  if (held.has(`${AUTOPILOT_LOCK_PREFIX}${bookId}`) || interruptedRuns(identity).some((intent) => intent.bookId === bookId)) {
    const paused = { ...previous, status: "autopilot" as const, lastCycleAt: now };
    store.replaceBook(bookId, paused);
    return paused;
  }

  store.patchBook(bookId, { status: "running" });
  let listing: Awaited<ReturnType<typeof listRemoteBranches>>;
  try {
    listing = await listRemoteBranches({ token, owner: book.owner, repo: book.repo, accountIdentity: identity });
  } catch (error) {
    const classified = classifyRepositoryError(error, "list");
    const failures = previous.failures + 1;
    const pausedUntil = pauseAfterFailure(classified.kind, failures, now, { rateLimitReset: classified.details?.rateLimitReset ? Date.parse(classified.details.rateLimitReset) : undefined }) ?? undefined;
    const failed: BookSyncState = { ...previous, status: "failed", errorKind: classified.kind, failures, pausedUntil, lastCycleAt: now, lastSummary: { at: now, pulledFiles: 0, pulled: 0, pushed: 0, published: 0, downloaded: 0, attention: 0, failed: classified.kind } };
    store.replaceBook(bookId, failed);
    return failed;
  }

  const allows = rateLimitAllows(listing.rate, now);
  const same = (left: string, right: string) => left.toLowerCase() === right.toLowerCase();
  const copies = new Map((await listLocalRepositoriesByBook(bookId, identity))
    .filter((row) => row.cloneComplete === true && same(row.owner, book.owner) && same(row.repo, book.repo))
    .map((row) => [row.branch, row] as [string, LocalRepositoryMeta]));
  // The branch the asking tab shows is the current one: this tab may not show the book, or may know an older choice.
  const candidates = selectBranchesToSync({ current: options.branch ?? currentBranchOf(book), memory: bookBranchMemory(settings, book), localCopies: new Set(copies.keys()), listed: listing.heads, allows });
  const editing = held.has(`${EDITING_LOCK_PREFIX}${bookId}`);
  const mayPush = !host.serverAutopilotRunning(bookId);
  const branches: Record<string, BranchSyncOutcome> = { ...previous.branches };
  const visited: BranchSyncOutcome[] = [];
  let failure: RepositoryError | null = null;

  const visit = async (candidate: BranchCandidate): Promise<void> => {
    if (failure && (failure.kind === "rate-limit" || failure.kind === "abuse-limit")) return;
    const at = host.now();
    const record = (outcome: BranchOutcomeKind, extra: Partial<BranchSyncOutcome> = {}) => {
      branches[candidate.name] = { outcome, at, ...extra };
      visited.push(branches[candidate.name]);
    };
    const copy = copies.get(candidate.name);
    const listedHeadSha = listing.heads.get(candidate.name) ?? (listing.complete ? null : undefined);
    const context = { role: candidate.role, mayPush, mayPull: candidate.role === "background" || !editing };
    try {
      if (!copy) {
        if (decideBranchAction({ hasCopy: false, dirty: 0, ahead: 0, listedHeadSha }, context) !== "download") return;
        // A branch the person works on elsewhere, brought here: the files the other copies already have are not downloaded again.
        await ensureLocalBookStructure({ bookId, book, token, accountIdentity: identity, branch: candidate.name });
        record("downloaded", { remoteHeadSha: listedHeadSha ?? undefined });
        return;
      }
      if (held.has(`${REPOSITORY_LOCK_PREFIX}${copy.id}`)) { record("busy"); return; }
      const snapshot = await getLocalRepositoryStatusSnapshot(book.owner, book.repo, candidate.name, identity);
      if (!snapshot) return;
      const action = decideBranchAction({ hasCopy: true, pendingHeadSha: copy.pendingBranch?.headSha, localHeadSha: copy.remoteHeadSha, dirty: snapshot.status.dirty, ahead: snapshot.status.ahead, listedHeadSha }, context);
      if (action === "gone" || action === "name-taken") { record(action, { remoteHeadSha: listedHeadSha ?? undefined }); return; }
      if (action === "hold") { record("held"); return; }
      if (listedHeadSha === undefined) return;
      const result = await autoSyncBranch({ bookId, owner: book.owner, repo: book.repo, branch: candidate.name, accountIdentity: identity, repoId: copy.id, token, listedHeadSha, mayPush: context.mayPush, mayPull: context.mayPull });
      record(result.outcome, { remoteHeadSha: result.remoteHeadSha, ...(result.files !== undefined ? { files: result.files } : {}) });
      if (result.remoteHeadSha && (result.outcome === "pushed" || result.outcome === "published")) rememberRemoteHead(identity, book.owner, book.repo, candidate.name, result.remoteHeadSha);
      if (result.outcome === "pulled") host.branchUpdated(bookId, candidate.name);
    } catch (error) {
      const classified = classifyRepositoryError(error, "compare");
      record("failed", { errorKind: classified.kind });
      if (classified.kind !== "abort" && (!failure || candidate.role === "current")) failure = classified;
    }
  };

  const [current, ...background] = candidates;
  if (current) await visit(current);
  await mapLimit(background, BACKGROUND_CONCURRENCY, visit);

  const failed = failure as RepositoryError | null;
  const failures = failed ? previous.failures + 1 : 0;
  const pausedForFailure = failed ? pauseAfterFailure(failed.kind, failures, now, { rateLimitReset: failed.details?.rateLimitReset ? Date.parse(failed.details.rateLimitReset) : undefined }) ?? undefined : undefined;
  const pausedForRate = allows === "none" && listing.rate ? listing.rate.resetAt : undefined;
  const count = (kind: BranchOutcomeKind) => visited.filter((entry) => entry.outcome === kind).length;
  const lastSummary: CycleSummary = {
    at: now,
    pulledFiles: visited.filter((entry) => entry.outcome === "pulled").reduce((sum, entry) => sum + (entry.files ?? 0), 0),
    pulled: count("pulled"),
    pushed: count("pushed"),
    published: count("published"),
    downloaded: count("downloaded"),
    attention: visited.filter((entry) => outcomeIsVisible(entry.outcome)).length,
  };
  const next: BookSyncState = {
    status: failed ? "failed" : "done",
    lastCycleAt: now,
    failures,
    branches,
    lastSummary,
    ...(failed ? { errorKind: failed.kind } : {}),
    ...(pausedForFailure || pausedForRate ? { pausedUntil: Math.max(pausedForFailure ?? 0, pausedForRate ?? 0) } : {}),
    ...(listing.rate ? { rateRemaining: listing.rate.remaining, rateResetAt: listing.rate.resetAt } : {}),
  };
  store.replaceBook(bookId, next);
  return next;
}
