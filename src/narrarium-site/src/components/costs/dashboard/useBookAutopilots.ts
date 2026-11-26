import { useEffect, useMemo, useState } from "react";
import type { AutopilotLimitReached, AutopilotOptions, AutopilotStats, AutopilotStatus } from "narrarium-engine";
import { loadAutopilotRuntime } from "@/autopilot/loader";
import { useAutopilotStore } from "@/autopilot/store";
import type { BookEntry } from "@/types/settings";

/** How many books are read at once, as the Autopilot page reads them. */
const READS_AT_ONCE = 4;

/** What the dashboard says of a book's autopilot: its options (the budget among them), its status and the autopilot's own count of what it spent. */
export interface BookAutopilot {
  /** `false` while its saved state is being read; `true` once it is known (and `status` is `null` for a book whose autopilot never started). */
  read: boolean;
  /** Its state could not be read (a personal server that does not answer): nothing is said of it, and it is not «being read» for ever. */
  unavailable?: boolean;
  status: AutopilotStatus | null;
  options: AutopilotOptions | null;
  /** The autopilot's own count, the one its budget is compared with: the personal server's summary for a book that runs there. */
  stats: AutopilotStats | null;
  publish: "off" | "chapter" | "step" | null;
  /** The limit that stopped the run, with the numbers the stop compared (the engine's `limitReached`): the money cap, the token cap, the rounds of a review. */
  limitReached: AutopilotLimitReached | null;
}

type Store = ReturnType<typeof useAutopilotStore.getState>;

/** The newest of what the store holds of a book: the live summary when it is newer than the saved state, else the saved state. Pure, for the tests. */
export function bookAutopilotOf(store: Pick<Store, "views" | "summaries">, bookId: string): BookAutopilot {
  const view = store.views[bookId];
  const snapshot = view?.snapshot;
  const state = snapshot?.state ?? null;
  const live = store.summaries[bookId];
  const fresh = live && (!state || live.updatedAt >= state.updatedAt) ? live : snapshot?.summary ?? null;
  if (!snapshot && !live) return { read: false, status: null, options: null, stats: null, publish: null, limitReached: null };
  return {
    read: true,
    status: fresh?.status ?? state?.status ?? null,
    options: state?.options ?? null,
    stats: fresh?.stats ?? state?.stats ?? null,
    publish: fresh?.publish ?? state?.options.publishEvery ?? null,
    // A start takes the limit away, so the newest of the two says whether it still holds.
    limitReached: (fresh ? fresh.limitReached : state?.limitReached) ?? null,
  };
}

/**
 * Reads the autopilot of every book, as the Autopilot page does (the runtime's download of its saved state, in this browser or from the personal server),
 * a few books at a time, and follows what the store holds of them. The runtime is loaded with the first read, after the table is drawn.
 */
export function useBookAutopilots(books: readonly BookEntry[]): Record<string, BookAutopilot> {
  const ids = useMemo(() => books.map((book) => book.id).join("\u0000"), [books]);
  // The books whose read ended, well or not: one that ended and still has nothing in the store could not be read.
  const [settled, setSettled] = useState<ReadonlySet<string>>(new Set());
  useEffect(() => {
    let cancelled = false;
    const queue = ids.split("\u0000").filter(Boolean);
    const done = (id: string) => { if (!cancelled) setSettled((current) => new Set(current).add(id)); };
    if (!queue.length) return;
    void loadAutopilotRuntime().then(async (runtime) => {
      const reader = async () => {
        while (!cancelled && queue.length) {
          const id = queue.shift()!;
          await runtime.refresh(id, { join: true }).catch(() => undefined);
          done(id);
        }
      };
      await Promise.all(Array.from({ length: Math.min(READS_AT_ONCE, queue.length) }, reader));
    }).catch(() => queue.forEach(done));
    return () => { cancelled = true; };
  }, [ids]);
  const views = useAutopilotStore((store) => store.views);
  const summaries = useAutopilotStore((store) => store.summaries);
  return useMemo(() => Object.fromEntries(books.map((book) => {
    const known = bookAutopilotOf({ views, summaries }, book.id);
    return [book.id, !known.read && settled.has(book.id) ? { ...known, unavailable: true } : known];
  })), [books, views, summaries, settled]);
}
