import { summarizeDesign, type AutopilotActivity, type AutopilotState, type AutopilotStateSummary } from "narrarium-engine";
import { matchKey } from "@/lib/matchText";

/**
 * What the Autopilot page says of every book, worked out from what the app already read of it: the saved state of its autopilot, the summary the
 * last `state` event carried, the log of its steps and the step that runs. Pure, and cheap on purpose: a library can hold 50 books, and the order of
 * the cards is worked out again whenever any of them changes, so nothing here walks a plan (which has no maximum number of chapters) to order them.
 */

/**
 * The state of a book's autopilot, as its card says it in words: it never started, it runs (or waits to try a failed step again), it is paused
 * (or its plan waits for the author's approval), it waits for an answer (or for the choice of a pitch, or for profile files to be corrected), it stopped on an error, or the
 * book is finished.
 */
export type HubState = "new" | "running" | "retrying" | "paused" | "plan" | "question" | "profiles" | "error" | "completed";

export const HUB_STATES: readonly HubState[] = ["new", "running", "retrying", "paused", "plan", "question", "profiles", "error", "completed"];

/** The order of the cards: what asks the author something comes first, then what runs, then the rest. */
export type HubRank = 0 | 1 | 2;

interface StateFacts {
  status: AutopilotStateSummary["status"];
  question: AutopilotStateSummary["question"];
  retry?: AutopilotStateSummary["retry"];
  awaitingPlan: boolean;
  /** The design waits for the author to choose a pitch: a wait without a question that is not a profile to correct. */
  choosePitch?: boolean;
}

function classify({ status, question, retry, awaitingPlan, choosePitch }: StateFacts): HubState {
  switch (status) {
    case "running":
      return retry ? "retrying" : "running";
    case "waiting-author":
      // A run that waits without a question waits for its profile files to be corrected (see `isProfileProblemStop`), unless a design waits for the choice of a pitch: an answer too.
      return question || choosePitch ? "question" : "profiles";
    case "paused":
      return awaitingPlan ? "plan" : "paused";
    case "error":
      return "error";
    case "completed":
      return "completed";
    default:
      // A state that never ran (written by the configuration, or after a reset): its autopilot has not started.
      return "new";
  }
}

/** The state of a book whose summary was worked out (the card has it: `useAutopilotControl`). */
export function hubState(summary: Pick<AutopilotStateSummary, "status" | "question" | "retry" | "design"> | null, state: Pick<AutopilotState, "plan"> | null): HubState {
  if (!summary) return "new";
  return classify({ status: summary.status, question: summary.question, retry: summary.retry, awaitingPlan: Boolean(state?.plan?.awaitingAuthor), choosePitch: summary.design?.choosePitch });
}

/**
 * The state of a book for the order of the cards, without summarizing its state: the newest of what was heard (`live`, the summary of the last
 * `state` event) and what was read (`downloaded`, the summary the download came with), as `latestSummary` picks it, else the saved state itself.
 */
export function hubStateOf(state: AutopilotState | null, live: AutopilotStateSummary | undefined, downloaded?: AutopilotStateSummary | null): HubState {
  if (!state) return "new";
  const fresh = live && live.updatedAt >= state.updatedAt ? live : downloaded && downloaded.updatedAt === state.updatedAt ? downloaded : null;
  return classify({
    status: fresh?.status ?? state.status,
    question: fresh ? fresh.question : state.question,
    retry: fresh?.retry,
    awaitingPlan: Boolean(state.plan?.awaitingAuthor),
    choosePitch: fresh ? fresh.design?.choosePitch : summarizeDesign(state.design)?.choosePitch,
  });
}

/** Asks something of the author: an answer, the approval of the plan, profile files to correct, an error to deal with, or frozen chapters that changed. */
export function hubRank(hub: HubState, frozenChanges = 0): HubRank {
  if (hub === "question" || hub === "plan" || hub === "profiles" || hub === "error" || frozenChanges > 0) return 0;
  if (hub === "running" || hub === "retrying") return 1;
  return 2;
}

/** The books in the order of their cards: by rank, and in the order of the library within a rank. */
export function orderBooks<T extends { id: string }>(books: readonly T[], rankOf: (id: string) => HubRank): T[] {
  return books
    .map((book, index) => ({ book, index, rank: rankOf(book.id) }))
    .sort((left, right) => left.rank - right.rank || left.index - right.index)
    .map((entry) => entry.book);
}

/** The cards get a filter by title from this many books on: a short library is read at a glance. */
export const HUB_FILTER_FROM = 11;

/** The books whose title has the words typed, whatever their case, accents and script. */
export function filterBooks<T extends { name: string }>(books: readonly T[], query: string): T[] {
  const wanted = matchKey(query);
  if (!wanted) return [...books];
  return books.filter((book) => matchKey(book.name).includes(wanted));
}

/** How far the book is: the chapters closed out of the ones planned (none before a plan exists). */
export function chapterProgress(summary: Pick<AutopilotStateSummary, "progress"> | null): { done: number; total: number; ratio: number } | null {
  const total = summary?.progress.chapters ?? 0;
  if (!summary || total <= 0) return null;
  const done = Math.min(total, Math.max(0, summary.progress.chaptersDone));
  return { done, total, ratio: done / total };
}

export type HubVote =
  | { kind: "book"; director: number }
  | { kind: "chapter"; number: number; director: number; readers: number | null };

const vote = (value: unknown): number | null => (typeof value === "number" && Number.isFinite(value) ? value : null);

/**
 * The director's last vote, as the state keeps it: on the whole book once its final review is done, else on the last chapter he judged (the
 * chapter of the plan with the highest number that has a vote, which is the last one reviewed as the plan goes on), with the readers' average of its
 * first round. `null` before any vote. A chapter reviewed again later (a change of a frozen chapter) is not told apart: the plan keeps no time.
 */
export function lastVote(state: Pick<AutopilotState, "plan" | "finalReview"> | null): HubVote | null {
  if (!state) return null;
  const book = vote(state.finalReview?.score);
  if (book !== null) return { kind: "book", director: book };
  const chapters = state.plan?.chapters ?? [];
  for (let index = chapters.length - 1; index >= 0; index -= 1) {
    const chapter = chapters[index];
    const rounds = chapter.rounds ?? [];
    const director = [...rounds].reverse().map((round) => vote(round?.director)).find((value) => value !== null) ?? vote(chapter.score);
    if (director === null) continue;
    const readers = rounds.map((round) => vote(round?.readers)).find((value) => value !== null) ?? null;
    return { kind: "chapter", number: chapter.number, director, readers };
  }
  return null;
}

/** The step the card says: the one that runs now, else the last one of the log, with when it ended (or began, for one that has no end). */
export function lastStep(activities: readonly AutopilotActivity[], running: AutopilotActivity | null, runs = false): { activity: AutopilotActivity; now: boolean; at: string } | null {
  if (running) return { activity: running, now: true, at: running.startedAt };
  const last = activities[activities.length - 1];
  if (!last) return null;
  // A step of the log that has not ended is the one in progress only while the book runs: a run that was interrupted leaves one behind.
  if (runs && last.status === "running") return { activity: last, now: true, at: last.startedAt };
  return { activity: last, now: false, at: last.endedAt ?? last.startedAt };
}
