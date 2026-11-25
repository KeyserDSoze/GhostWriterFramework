import type { AutopilotActivity, AutopilotState, AutopilotStateSummary } from "narrarium-engine";
import { hubState, type HubState } from "@/autopilot/hubModel";

/**
 * Which books' autopilots the author should see at a glance, wherever they are in the app: the ones that run (or wait to try a failed step again),
 * the ones that wait for the author (a question, a plan to approve, profile files to correct, an error), and the ones paused, these two only when
 * something happened to them in the last day (an old pause is the book's page's business). Pure: it reads what the app already holds of every book
 * (the summaries of the live events, the downloaded state of each book, the server's list of its books, the step that runs) and orders what needs
 * the author first, then what runs, then what is paused, each in the order of the library.
 */

/** How long a book that waits for the author, or is paused, stays in the list after the last thing that happened to it. */
export const ACTIVE_RECENT_MS = 24 * 60 * 60 * 1000;

export type ActiveKind = "attention" | "running" | "paused";

export interface ActiveBook {
  id: string;
  name: string;
  host: "browser" | "server";
  state: HubState;
  kind: ActiveKind;
  /** The step that runs now, as the live events say it (none for a book that does not run, or whose step was not heard yet). */
  step: AutopilotActivity | null;
}

interface ViewFacts {
  snapshot: { state: AutopilotState | null; summary?: AutopilotStateSummary | null; running?: boolean } | null;
  busyInAnotherTab?: boolean;
}

export interface ActiveBooksInput {
  books: ReadonlyArray<{ id: string; name: string; autopilotHost?: "browser" | "server" | string }>;
  /** The summary of the last `state` event of each book. */
  summaries: Readonly<Record<string, AutopilotStateSummary | undefined>>;
  views: Readonly<Record<string, ViewFacts | undefined>>;
  serverBooks: ReadonlyArray<{ bookId: string; running: boolean; autopilot: AutopilotStateSummary | null }>;
  live: Readonly<Record<string, { activity: AutopilotActivity } | null | undefined>>;
  now: number;
  /** The summary of a downloaded state the events did not catch up with (`latestSummary`); without it the newest summary there is counts. */
  summarize?: (state: AutopilotState, live: AutopilotStateSummary | undefined, downloaded: AutopilotStateSummary | null | undefined) => AutopilotStateSummary | null;
  /**
   * The engine's rule for a runner that is still alive (`runnerActivity`): a summary that says that its book runs counts while its runner was
   * heard of lately. Without it (the launcher, until the rule is loaded) such a summary is taken at its word.
   */
  runnerActivity?: (state: AutopilotState, now?: Date) => "none" | "active" | "stale";
}

const KIND_ORDER: Record<ActiveKind, number> = { attention: 0, running: 1, paused: 2 };

function newest(...summaries: Array<AutopilotStateSummary | null | undefined>): AutopilotStateSummary | null {
  let best: AutopilotStateSummary | null = null;
  for (const summary of summaries) if (summary && (!best || summary.updatedAt > best.updatedAt)) best = summary;
  return best;
}

function kindOf(state: HubState, runs: boolean, recent: boolean): ActiveKind | null {
  if (runs || state === "running" || state === "retrying") return runs ? "running" : null;
  if (!recent) return null;
  if (state === "question" || state === "plan" || state === "profiles" || state === "error") return "attention";
  if (state === "paused") return "paused";
  return null;
}

export function activeBooks(input: ActiveBooksInput): ActiveBook[] {
  const server = new Map(input.serverBooks.map((entry) => [entry.bookId, entry]));
  const found: Array<ActiveBook & { index: number }> = [];
  input.books.forEach((book, index) => {
    const view = input.views[book.id];
    const state = view?.snapshot?.state ?? null;
    const live = input.summaries[book.id];
    const remote = server.get(book.id);
    const downloaded = state && input.summarize ? input.summarize(state, live, view?.snapshot?.summary) : view?.snapshot?.summary ?? null;
    const summary = newest(downloaded, live, remote?.autopilot);
    if (!summary) return;
    const hub = hubState(summary, state);
    // A run is known to go on by its own session, another tab, the server's list, or a summary whose runner was heard of lately.
    const heard = summary.status === "running" && input.runnerActivity?.({ status: summary.status, runner: summary.runner } as AutopilotState, new Date(input.now)) !== "stale";
    const runs = Boolean(view?.snapshot?.running || view?.busyInAnotherTab || remote?.running || heard);
    const updated = Date.parse(summary.updatedAt);
    const recent = Number.isFinite(updated) && input.now - updated <= ACTIVE_RECENT_MS;
    const kind = kindOf(hub, runs, recent);
    if (!kind) return;
    const host = book.autopilotHost === "server" ? "server" : "browser";
    found.push({ id: book.id, name: book.name, host, state: kind === "running" && hub !== "retrying" ? "running" : hub, kind, step: kind === "running" ? input.live[book.id]?.activity ?? null : null, index });
  });
  return found.sort((left, right) => KIND_ORDER[left.kind] - KIND_ORDER[right.kind] || left.index - right.index).map(({ index: _index, ...book }) => book);
}

/** What the launcher of the live panel says: how many autopilots run, how many wait for the author, and the names of the ones that run. */
export function activeCounts(books: readonly ActiveBook[]): { running: number; attention: number; names: string[] } {
  const running = books.filter((book) => book.kind === "running");
  return { running: running.length, attention: books.filter((book) => book.kind === "attention").length, names: running.map((book) => book.name) };
}
