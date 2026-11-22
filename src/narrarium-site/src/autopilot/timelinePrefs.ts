import { useCallback, useState } from "react";
import { TIMELINE_FILTERS, type TimelineFilter } from "@/autopilot/timelineModel";

const KEY = "narrarium-autopilot-timeline-v1";

/** What the author chose for the timeline of a book, and keeps for the session. */
export interface TimelinePrefs {
  filter: TimelineFilter;
  /** An ISO time: what was over before it is hidden. */
  since: string | null;
}

const DEFAULTS: TimelinePrefs = { filter: "all", since: null };

/** Where the storage of the session is not available (a private window, a full storage) the choice lasts for as long as the page does. */
const memory = new Map<string, TimelinePrefs>();

function readAll(): Record<string, unknown> {
  try {
    const parsed = JSON.parse(sessionStorage.getItem(KEY) ?? "{}") as unknown;
    return parsed && typeof parsed === "object" ? (parsed as Record<string, unknown>) : {};
  } catch {
    return {};
  }
}

export function readTimelinePrefs(bookId: string): TimelinePrefs {
  const stored = (readAll()[bookId] ?? memory.get(bookId)) as Partial<TimelinePrefs> | undefined;
  if (!stored || typeof stored !== "object") return DEFAULTS;
  const filter = TIMELINE_FILTERS.includes(stored.filter as TimelineFilter) ? (stored.filter as TimelineFilter) : DEFAULTS.filter;
  const since = typeof stored.since === "string" && Number.isFinite(Date.parse(stored.since)) ? stored.since : null;
  return { filter, since };
}

export function writeTimelinePrefs(bookId: string, prefs: TimelinePrefs): void {
  try {
    sessionStorage.setItem(KEY, JSON.stringify({ ...readAll(), [bookId]: prefs }));
    memory.delete(bookId);
  } catch {
    memory.set(bookId, prefs);
  }
}

/** The filter and the moment of the book, kept for the session: the same when the page is drawn again, and when the author comes back to it. */
export function useTimelinePrefs(bookId: string): [TimelinePrefs, (patch: Partial<TimelinePrefs>) => void] {
  const [state, setState] = useState(() => ({ bookId, prefs: readTimelinePrefs(bookId) }));
  // The page may stay while the book changes: the choice read is the one of the book on the screen.
  const current = state.bookId === bookId ? state.prefs : readTimelinePrefs(bookId);
  const change = useCallback((patch: Partial<TimelinePrefs>) => {
    const next = { ...readTimelinePrefs(bookId), ...patch };
    writeTimelinePrefs(bookId, next);
    setState({ bookId, prefs: next });
  }, [bookId]);
  return [current, change];
}
