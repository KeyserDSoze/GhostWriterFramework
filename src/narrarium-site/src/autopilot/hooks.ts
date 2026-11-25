import { useEffect, useRef, useState } from "react";
import { loadAutopilotRuntime } from "@/autopilot/loader";
import { emptyView, useAutopilotStore, type BookAutopilotView } from "@/autopilot/store";

export { useNow } from "@/autopilot/useNow";

/** The autopilot view of a book (snapshot, server summary, sync), kept fresh by the runtime. */
export function useBookAutopilotView(bookId: string | undefined): BookAutopilotView {
  const view = useAutopilotStore((state) => (bookId ? state.views[bookId] : undefined));
  return view ?? emptyView(bookId ?? "");
}

/**
 * Load the runtime and refresh the book's view when the book, `enabled` or `refreshKey` change. Opening only joins a
 * download that is already on its way (the dock and the page open together); a changed book or key (another branch,
 * another host) asks for a download of its own, as the one on its way may be for what was shown before.
 */
export function useAutopilotRefresh(bookId: string | undefined, enabled = true, refreshKey = ""): void {
  const lastKey = useRef<string | null>(null);
  useEffect(() => {
    if (!bookId || !enabled) return;
    const key = `${bookId}\n${refreshKey}`;
    const changed = lastKey.current !== null && lastKey.current !== key;
    lastKey.current = key;
    let cancelled = false;
    void loadAutopilotRuntime().then((runtime) => {
      if (!cancelled) void runtime.refresh(bookId, { join: !changed });
    }).catch(() => undefined);
    return () => {
      cancelled = true;
    };
  }, [bookId, enabled, refreshKey]);
}

/** Milliseconds elapsed since `since`, updated every second while mounted. */
export function useElapsed(since: string | undefined): number {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    if (!since) return;
    const timer = window.setInterval(() => setNow(Date.now()), 1000);
    return () => window.clearInterval(timer);
  }, [since]);
  const start = since ? Date.parse(since) : Number.NaN;
  return Number.isFinite(start) ? Math.max(0, now - start) : 0;
}
