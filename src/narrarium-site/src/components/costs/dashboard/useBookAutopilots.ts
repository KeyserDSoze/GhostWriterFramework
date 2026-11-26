import { useEffect, useMemo, useState } from "react";
import { bookAutopilotOf, type BookAutopilot } from "@/autopilot/bookAutopilot";
import { loadAutopilotRuntime } from "@/autopilot/loader";
import { useAutopilotStore } from "@/autopilot/store";
import type { BookEntry } from "@/types/settings";

export { bookAutopilotOf, type BookAutopilot };

/** How many books are read at once, as the Autopilot page reads them. */
const READS_AT_ONCE = 4;

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
