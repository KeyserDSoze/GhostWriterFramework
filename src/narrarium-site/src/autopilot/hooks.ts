import { useEffect, useState } from "react";
import { loadAutopilotRuntime } from "@/autopilot/loader";
import { emptyView, useAutopilotStore, type BookAutopilotView } from "@/autopilot/store";

/** The autopilot view of a book (snapshot, server summary, sync), kept fresh by the runtime. */
export function useBookAutopilotView(bookId: string | undefined): BookAutopilotView {
  const view = useAutopilotStore((state) => (bookId ? state.views[bookId] : undefined));
  return view ?? emptyView(bookId ?? "");
}

/** Load the runtime and refresh the book's view when the book, `enabled` or `refreshKey` change. */
export function useAutopilotRefresh(bookId: string | undefined, enabled = true, refreshKey = ""): void {
  useEffect(() => {
    if (!bookId || !enabled) return;
    let cancelled = false;
    void loadAutopilotRuntime().then((runtime) => {
      if (!cancelled) void runtime.refresh(bookId);
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
