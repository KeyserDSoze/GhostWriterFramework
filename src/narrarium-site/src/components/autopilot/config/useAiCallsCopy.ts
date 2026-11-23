import { useCallback, useEffect, useState } from "react";
import type { AiCallTotals } from "narrarium-engine";
import { ensureCallsHost } from "@/autopilot/calls/host";
import { callsCopier, copyServices, onCopyChange } from "@/autopilot/calls/copies/services";
import { startCopiesRuntime } from "@/autopilot/calls/copies/runtime";
import { isCopyTargetKind, type CopyErrorCode, type CopyStatus, type CopyTargetKind } from "@/autopilot/calls/copies/types";
import { useSettingsStore } from "@/store/settingsStore";

/** The choice saved for a book, with the account's settings. */
export function useSavedCopyTarget(bookId: string): CopyTargetKind | null {
  return useSettingsStore((state) => {
    const value = state.settings.books.find((book) => book.id === bookId)?.aiCallsCopy;
    return isCopyTargetKind(value) ? value : null;
  });
}

/**
 * Saves the choice of a book: the account's settings now, and the copying starts (or stops waiting) at once. The author's settings are saved on
 * request, so `save` is the page's own (`useSettings().save`). What is already copied stays where it is.
 */
export async function chooseCopyTarget(bookId: string, next: CopyTargetKind | null, previous: CopyTargetKind | null, save: () => Promise<unknown>): Promise<void> {
  const store = useSettingsStore.getState();
  store.patchSettings({ books: store.settings.books.map((book) => {
    if (book.id !== bookId) return book;
    const { aiCallsCopy: _former, ...rest } = book;
    return next ? { ...rest, aiCallsCopy: next } : rest;
  }) });
  await save();
  // The copies read what this device keeps through the host (the store, its outbox, the deletion): it is made ready before the first scan.
  await ensureCallsHost();
  const copier = callsCopier();
  if (previous && previous !== next) await copier.forget(bookId, previous);
  if (next) {
    const scheduler = startCopiesRuntime();
    void copier.scan(bookId, next).then(() => scheduler.kick({ force: true, scan: false }));
  }
}

export interface CopyView {
  status: CopyStatus | null;
  /** The copies each place holds (a place the author left is still listed while its copies are there). */
  kept: Array<{ target: CopyTargetKind; status: CopyStatus }>;
  /** What the local records of the book take, when the local store can say it. */
  totals: AiCallTotals | null;
  /** The refusal found when the place was checked just now. */
  checked: { target: CopyTargetKind; code: CopyErrorCode | null } | null;
  checking: boolean;
}

const KINDS: CopyTargetKind[] = ["github", "google-drive", "onedrive"];

/** The state of the copies of a book, drawn again when the outbox, the ledger or the connection of the device changes. */
export function useAiCallsCopy(bookId: string, target: CopyTargetKind | null): CopyView & { refresh: () => void } {
  const [view, setView] = useState<CopyView>({ status: null, kept: [], totals: null, checked: null, checking: false });
  const [tick, setTick] = useState(0);
  const refresh = useCallback(() => setTick((value) => value + 1), []);

  useEffect(() => onCopyChange((changed) => { if (changed === bookId) refresh(); }), [bookId, refresh]);
  // What this device keeps is read from the browser's store: it is opened (and the copies made ready) when the tab is shown, and the tab is drawn again with its size.
  useEffect(() => {
    let active = true;
    void ensureCallsHost().then((store) => { if (active && store) refresh(); });
    return () => { active = false; };
  }, [refresh]);
  useEffect(() => {
    window.addEventListener("online", refresh);
    window.addEventListener("offline", refresh);
    return () => { window.removeEventListener("online", refresh); window.removeEventListener("offline", refresh); };
  }, [refresh]);

  useEffect(() => {
    let active = true;
    void (async () => {
      const copier = callsCopier();
      const statuses = await Promise.all(KINDS.map(async (kind) => ({ target: kind, status: await copier.status(bookId, kind) })));
      const totals = await copyServices().store()?.totals(bookId).catch(() => null) ?? null;
      if (!active) return;
      setView((current) => ({
        ...current,
        status: target ? statuses.find((entry) => entry.target === target)?.status ?? null : null,
        kept: statuses.filter((entry) => entry.target !== target && (entry.status.copiedTasks > 0 || entry.status.bytes > 0)),
        totals,
      }));
    })();
    return () => { active = false; };
  }, [bookId, target, tick]);

  // A place is looked at when it is chosen, and again when the sign-in or the repository changes: a public repository is said at once, not at the first copy.
  useEffect(() => {
    if (!target) { setView((current) => ({ ...current, checked: null, checking: false })); return; }
    let active = true;
    setView((current) => ({ ...current, checking: true }));
    void callsCopier().check(bookId, target).then((code) => { if (active) setView((current) => ({ ...current, checked: { target, code }, checking: false })); });
    return () => { active = false; };
  }, [bookId, target]);

  return { ...view, refresh };
}
