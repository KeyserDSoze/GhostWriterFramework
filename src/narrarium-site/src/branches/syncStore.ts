import { create } from "zustand";
import type { BranchOutcomeKind } from "@/branches/autoSyncPolicy";

/**
 * What the automatic sync knows of each GitHub book, for the branch button and the switcher of every tab: the tab that syncs (the leader) fills it and
 * sends it to the others. Nothing here is saved: a new start asks GitHub again.
 */

export interface BranchSyncOutcome {
  outcome: BranchOutcomeKind;
  at: number;
  remoteHeadSha?: string;
  /** The kind of the failure (`RepositoryErrorKind`), for `failed`. */
  errorKind?: string;
  /** Files a pull brought, or a push sent. */
  files?: number;
}

/** What the last cycle did, for the menu of the sync pill and the switcher: nothing happens without it being said there. */
export interface CycleSummary {
  at: number;
  /** Files brought by pulls, and branches pulled, pushed (changes published), published (made on GitHub), downloaded. */
  pulledFiles: number;
  pulled: number;
  pushed: number;
  published: number;
  downloaded: number;
  /** Branches that wait for the person (diverged, gone, name taken, failed). */
  attention: number;
  /** The cycle itself failed (GitHub could not be asked): the kind of the failure. */
  failed?: string;
}

export type BookSyncStatus = "idle" | "running" | "done" | "paused" | "autopilot" | "failed";

export interface BookSyncState {
  status: BookSyncStatus;
  /** When the last cycle ended. */
  lastCycleAt?: number;
  /** Automatic cycles wait until then (a failure, the rate limit). */
  pausedUntil?: number;
  /** Failures in a row: the periodic cycle waits longer after each. */
  failures: number;
  errorKind?: string;
  rateRemaining?: number;
  rateResetAt?: number;
  branches: Record<string, BranchSyncOutcome>;
  lastSummary?: CycleSummary;
}

interface BranchSyncStoreState {
  books: Record<string, BookSyncState>;
  patchBook: (bookId: string, patch: Partial<BookSyncState>) => void;
  replaceBook: (bookId: string, state: BookSyncState) => void;
}

export const emptyBookSyncState = (): BookSyncState => ({ status: "idle", failures: 0, branches: {} });

export const useBranchSyncStore = create<BranchSyncStoreState>()((set) => ({
  books: {},
  patchBook: (bookId, patch) => set((state) => ({ books: { ...state.books, [bookId]: { ...(state.books[bookId] ?? emptyBookSyncState()), ...patch } } })),
  replaceBook: (bookId, next) => set((state) => ({ books: { ...state.books, [bookId]: next } })),
}));
