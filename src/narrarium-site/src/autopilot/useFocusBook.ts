import { useCallback, useEffect, useMemo } from "react";
import { useLocation } from "react-router-dom";
import { runnerActivity, type AutopilotState, type AutopilotStateSummary } from "narrarium-engine";
import { parseAppRoute } from "@/assistant/context";
import { lastSignalAt, useAutopilotStore, type BookAutopilotView, type FeedEntry } from "@/autopilot/store";
import { latestSummary } from "@/autopilot/summary";
import { useSettingsStore } from "@/store/settingsStore";

/** A book the live panel could command, and whether its autopilot runs (anywhere). */
export interface FocusCandidate {
  id: string;
  name: string;
  running: boolean;
}

/** Why this book is the one: the author chose it, it is the page they are in, it is the only one that runs, or it was active most recently. */
export type FocusReason = "chosen" | "route" | "only-running" | "recent";

export interface FocusInput {
  /** The book of the page the author is in, if they are in a book. */
  routeBookId: string | undefined;
  /** The library. A book that is not in it cannot be in focus. */
  books: ReadonlyArray<{ id: string; name: string }>;
  /** The books whose autopilot runs now, on any host. */
  running: ReadonlySet<string>;
  /** The books that did something, the one that did it last first. */
  recent: readonly string[];
  /** The book the author chose to command among the candidates. */
  chosen: string | null;
}

export interface FocusChoice {
  focus: FocusCandidate | null;
  /** The books to choose from: the page's book, the ones that run (the most recent first) and the one the author chose. The selector is for more than one. */
  candidates: FocusCandidate[];
  why: FocusReason | null;
}

/**
 * The book the live panel commands: the one the author chose, else the book of the page they are in, else the only one that runs
 * (whatever its host), else the one that was active most recently. None, and so no bar, when nothing ever ran and they are not in a book.
 */
export function selectFocusBook(input: FocusInput): FocusChoice {
  const names = new Map(input.books.map((book) => [book.id, book.name]));
  const known = (id: string | null | undefined): id is string => typeof id === "string" && names.has(id);
  const candidate = (id: string): FocusCandidate => ({ id, name: names.get(id) ?? id, running: input.running.has(id) });
  const rank = (id: string) => {
    const index = input.recent.indexOf(id);
    return index < 0 ? Number.MAX_SAFE_INTEGER : index;
  };
  const running = input.books.map((book) => book.id).filter((id) => input.running.has(id)).sort((left, right) => rank(left) - rank(right));
  const recent = input.recent.filter(known);
  const route = known(input.routeBookId) ? input.routeBookId : null;
  const chosen = known(input.chosen) ? input.chosen : null;

  const ids: string[] = [];
  for (const id of [route, ...running, chosen]) if (id && !ids.includes(id)) ids.push(id);

  let picked: string | null = null;
  let why: FocusReason | null = null;
  if (chosen) [picked, why] = [chosen, "chosen"];
  else if (route) [picked, why] = [route, "route"];
  else if (running.length === 1) [picked, why] = [running[0], "only-running"];
  else if (running.length > 1) [picked, why] = [running[0], "recent"];
  else if (recent.length) [picked, why] = [recent[0], "recent"];
  if (picked && !ids.includes(picked)) ids.push(picked);
  return { focus: picked ? candidate(picked) : null, candidates: ids.map(candidate), why };
}

/** Whether the autopilot of a book runs, by everything this client knows of it: its own session, another tab, the live events, the saved state (unless its runner went quiet) and what the server says of its books. */
function runsNow(view: BookAutopilotView | undefined, live: AutopilotStateSummary | undefined, serverRunning: boolean): boolean {
  if (view?.snapshot?.running || view?.busyInAnotherTab || serverRunning) return true;
  const summary = latestSummary(view?.snapshot?.state ?? null, live, view?.snapshot?.summary) ?? live ?? null;
  if (summary?.status !== "running") return false;
  return runnerActivity({ status: summary.status, runner: summary.runner } as AutopilotState) !== "stale";
}

/** When each book was last active, as far as this client knows: what it heard of it, what its summary says, what the feed kept from before. The latest first; books without a sign are left out. */
function recentBooks(ids: readonly string[], summaries: Record<string, AutopilotStateSummary>, views: Record<string, BookAutopilotView>, feed: readonly FeedEntry[]): string[] {
  const lastInFeed = new Map<string, number>();
  for (const entry of feed) {
    const at = Date.parse(entry.event.at);
    if (Number.isFinite(at) && at > (lastInFeed.get(entry.event.bookId) ?? 0)) lastInFeed.set(entry.event.bookId, at);
  }
  const time = (id: string) => {
    const stamps = [lastSignalAt(id) ?? 0, lastInFeed.get(id) ?? 0, Date.parse(summaries[id]?.updatedAt ?? "") || 0, Date.parse(views[id]?.snapshot?.state?.updatedAt ?? "") || 0];
    return Math.max(...stamps);
  };
  return ids.map((id) => ({ id, at: time(id) })).filter((entry) => entry.at > 0).sort((left, right) => right.at - left.at).map((entry) => entry.id);
}

/**
 * The book the live panel of the dock commands, and the ones the author can choose instead. A choice is for the page the author is in: it
 * is forgotten when they go to another book.
 */
export function useFocusBook(): FocusChoice & { choose: (bookId: string | null) => void } {
  const location = useLocation();
  const route = parseAppRoute(location.pathname);
  const routeBookId = "bookId" in route ? route.bookId : undefined;
  const books = useSettingsStore((state) => state.settings.books);
  const views = useAutopilotStore((state) => state.views);
  const summaries = useAutopilotStore((state) => state.summaries);
  const feed = useAutopilotStore((state) => state.feed);
  const serverBooks = useAutopilotStore((state) => state.server.books);
  const chosen = useAutopilotStore((state) => state.dockFocusBook);
  const setChosen = useAutopilotStore((state) => state.setDockFocusBook);

  useEffect(() => {
    if (useAutopilotStore.getState().dockFocusBook) setChosen(null);
  }, [routeBookId, setChosen]);

  const choice = useMemo(() => {
    const library = books.map((book) => ({ id: book.id, name: book.name }));
    const serverRunning = new Set(serverBooks.filter((summary) => summary.running).map((summary) => summary.bookId));
    const running = new Set(library.map((book) => book.id).filter((id) => runsNow(views[id], summaries[id], serverRunning.has(id))));
    return selectFocusBook({ routeBookId, books: library, running, recent: recentBooks(library.map((book) => book.id), summaries, views, feed), chosen });
  }, [books, views, summaries, feed, serverBooks, routeBookId, chosen]);

  const choose = useCallback((bookId: string | null) => setChosen(bookId), [setChosen]);
  return { ...choice, choose };
}
