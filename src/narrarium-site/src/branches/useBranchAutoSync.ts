import { useEffect, useRef } from "react";
import { periodicDelay, type SyncTrigger } from "@/branches/autoSyncPolicy";
import { watchBranch } from "@/branches/watchedBranch";
import { EDITING_LOCK_PREFIX } from "@/branches/locks";
import { useBranchSyncStore } from "@/branches/syncStore";
import { useSaveStore } from "@/store/saveStore";
import type { AutoSyncMode } from "@/types/settings";

let runtimeModule: Promise<typeof import("@/branches/syncRuntime")> | null = null;

/** Ask for a cycle of the automatic sync of a book. Its code (and GitHub's client) loads with the first request, not with the shell of the app. */
export function requestBranchSync(bookId: string, trigger: SyncTrigger, branch?: string): void {
  runtimeModule ??= import("@/branches/syncRuntime");
  void runtimeModule.then((module) => module.branchSyncRuntime().request(bookId, trigger, branch)).catch(() => { runtimeModule = null; });
}

export interface BranchAutoSyncInput {
  bookId?: string;
  /** The branch whose working copy the pages show. */
  loadedBranch?: string;
  /** `githubRemoteAvailability(...) === "ready"`: without GitHub nothing is asked. */
  ready: boolean;
  mode: AutoSyncMode;
  /** Opens the Sync of the book (the existing one, with its conflict dialog). */
  onSyncNow: () => void;
}

/**
 * The triggers of the automatic sync of the book on the screen: opening it or switching branch, the window coming back, GitHub becoming reachable (the
 * network, a credential), and the timer of the periodic mode, which waits longer after each failure. While a page of the book has unsaved edits the tab holds
 * a shared Web Lock, so that no tab pulls into the branch under them. The branch it shows is the one whose outcomes the branch sync says here.
 */
export function useBranchAutoSync({ bookId, loadedBranch, ready, mode, onSyncNow }: BranchAutoSyncInput): void {
  const active = Boolean(bookId && loadedBranch && ready && mode !== "off");
  const opened = useRef<string | null>(null);
  const wasReady = useRef(ready);
  const syncNow = useRef(onSyncNow);
  syncNow.current = onSyncNow;

  useEffect(() => {
    if (!active || !bookId || !loadedBranch) return;
    const key = `${bookId}\u0000${loadedBranch}`;
    if (opened.current === key) return;
    const trigger: SyncTrigger = opened.current?.startsWith(`${bookId}\u0000`) ? "switch" : "open";
    opened.current = key;
    requestBranchSync(bookId, trigger, loadedBranch);
  }, [active, bookId, loadedBranch]);

  useEffect(() => {
    const became = ready && !wasReady.current;
    wasReady.current = ready;
    if (became && active && bookId) requestBranchSync(bookId, "online", loadedBranch);
  }, [ready, active, bookId, loadedBranch]);

  useEffect(() => {
    if (!active || !bookId) return undefined;
    const back = () => { if (document.visibilityState !== "hidden") requestBranchSync(bookId, "focus", loadedBranch); };
    window.addEventListener("focus", back);
    document.addEventListener("visibilitychange", back);
    return () => {
      window.removeEventListener("focus", back);
      document.removeEventListener("visibilitychange", back);
    };
  }, [active, bookId, loadedBranch]);

  const failures = useBranchSyncStore((state) => (bookId ? state.books[bookId]?.failures : 0) ?? 0);
  const lastCycleAt = useBranchSyncStore((state) => (bookId ? state.books[bookId]?.lastCycleAt : undefined));
  useEffect(() => {
    if (!active || !bookId || mode !== "periodic") return undefined;
    // Counted from the last cycle, whatever started it: a focus a minute ago puts the next tick off.
    const timer = window.setTimeout(() => requestBranchSync(bookId, "periodic", loadedBranch), periodicDelay(failures));
    return () => window.clearTimeout(timer);
  }, [active, bookId, loadedBranch, mode, failures, lastCycleAt]);

  const editing = useSaveStore((state) => Boolean(state.current?.dirty));
  useEffect(() => {
    const manager = typeof navigator !== "undefined" ? navigator.locks : undefined;
    if (!editing || !bookId || !manager?.request) return undefined;
    let release!: () => void;
    const held = new Promise<void>((resolve) => { release = resolve; });
    void manager.request(`${EDITING_LOCK_PREFIX}${bookId}`, { mode: "shared" }, () => held).catch(() => undefined);
    return () => release();
  }, [editing, bookId]);

  // What only the person can settle about this branch is said by the branch sync once it is loaded (`@/branches/outcomeToasts`).
  useEffect(() => {
    watchBranch(bookId && loadedBranch ? { bookId, branch: loadedBranch, onSyncNow: () => syncNow.current() } : null);
  }, [bookId, loadedBranch]);
}
