import { MAX_ACTIVITIES, type AutopilotActivity, type AutopilotFinalReview, type AutopilotOptions, type AutopilotPhase, type AutopilotState, type AutopilotStateSummary, type AutopilotStats, type AutopilotStatus, type AutopilotTaskKind } from "narrarium-engine";

/**
 * What the control band shows of a book, worked out from what the page already has (the summary, the saved state, the log of the steps).
 * Nothing here asks the engine for anything: the order of the steps of a chapter is the one `nextStep` of the engine follows, read back.
 */

/** The steps of the cycle of a chapter, in the order the author thinks of them: write, readers, specialists, director, fix. */
export type CycleStage = "write" | "readers" | "specialists" | "director" | "fix";
export const CYCLE_STAGES: readonly CycleStage[] = ["write", "readers", "specialists", "director", "fix"];

/** Where a chapter is: one of the steps of its cycle, or `close` when everything is done and only closing it is left. */
export interface ChapterCycle {
  chapterNumber: number;
  stage: CycleStage | "close" | null;
  /** The round of the review (2 or more once the director asked for fixes), when the saved state says so. */
  round: number | null;
}

/** Which step of the cycle of a chapter a kind of task is; `null` for the ones that are not part of it (the concept, the plan, the final review…). */
export function stageOfTask(kind: AutopilotTaskKind | undefined): CycleStage | "close" | null {
  switch (kind) {
    case "scenes":
    case "write":
    case "revise":
      return "write";
    case "reader":
    case "readers-summary":
      return "readers";
    case "specialists":
      return "specialists";
    case "director-review":
      return "director";
    case "repair":
      return "fix";
    case "consolidate":
      return "close";
    default:
      return null;
  }
}

type CycleState = Pick<AutopilotState, "plan" | "review" | "options">;

/**
 * The chapter in progress and where it is in its cycle. The step that runs now says it first (it is newer than the saved state); with none,
 * the saved state does, in the order the engine asks for the steps of a chapter: its scenes, the readers, the comparison of the readers, the
 * specialists, the director, the fixes, the closing. `null` when the run does something that is not a chapter, or there is no chapter in progress.
 */
export function chapterCycle(state: CycleState | null, live: Pick<AutopilotActivity, "task" | "chapterNumber"> | null | undefined): ChapterCycle | null {
  const plan = state?.plan;
  // A plan that waits for the author has no chapter in progress yet: nothing is written until it is approved.
  const current = plan?.approved && !plan.awaitingAuthor ? plan.chapters.find((chapter) => chapter.status !== "done") : undefined;
  const review = state?.review && current && state.review.chapterNumber === current.number ? state.review : null;
  if (live) {
    const stage = stageOfTask(live.task);
    if (!stage) return null;
    const chapterNumber = live.chapterNumber ?? current?.number;
    if (chapterNumber === undefined) return null;
    const sameReview = state?.review && state.review.chapterNumber === chapterNumber ? state.review : null;
    return { chapterNumber, stage, round: sameReview?.round ?? null };
  }
  if (!current) return null;
  if (current.status === "planned" || current.status === "writing") return { chapterNumber: current.number, stage: "write", round: null };
  if (!review) return { chapterNumber: current.number, stage: state?.options.readers ? "readers" : "specialists", round: null };
  let stage: CycleStage | "close";
  if (review.readersPending.length > 0 || (review.readerScores.length > 0 && !review.readersSummaryDone)) stage = "readers";
  else if (!review.specialistsDone) stage = "specialists";
  else if (!review.directorDone) stage = "director";
  else if (review.repairQueue.length > 0) stage = "fix";
  else stage = "close";
  return { chapterNumber: current.number, stage, round: review.round };
}

export interface CycleItem {
  stage: CycleStage;
  state: "done" | "current" | "todo";
}

/** The five steps of the cycle, each marked: what is behind the current step is done, the current one is current, what is ahead is still to do. */
export function cycleItems(cycle: ChapterCycle): CycleItem[] {
  const index = cycle.stage === "close" ? CYCLE_STAGES.length : cycle.stage ? CYCLE_STAGES.indexOf(cycle.stage) : -1;
  return CYCLE_STAGES.map((stage, position) => ({ stage, state: position < index ? "done" : position === index ? "current" : "todo" }));
}

/** The compact indicator of the phases of a book: the concept, the plan, the chapters (written and reviewed one by one) and the final review. */
export type BandPhase = "concept" | "plan" | "chapters" | "final";
export const BAND_PHASES: readonly BandPhase[] = ["concept", "plan", "chapters", "final"];

export interface PhaseStep {
  key: BandPhase;
  state: "done" | "current" | "todo";
}

export function bandPhases(phase: AutopilotPhase): PhaseStep[] {
  const index = phase === "completed" ? BAND_PHASES.length : phase === "write" || phase === "review" ? 2 : BAND_PHASES.indexOf(phase as BandPhase);
  return BAND_PHASES.map((key, position) => ({ key, state: position < index ? "done" : position === index ? "current" : "todo" }));
}

export interface ClosedChapter {
  number: number;
  /** The folder of the chapter in the plan; `undefined` when the plan has no chapter with that number any more. */
  slug: string | undefined;
}

/**
 * The chapter the last step closed, for a run that paused right after it (“Chapter 4 approved: read it and resume”): the one the author is
 * asked to read. None while the run goes on, when the last step is not the closing of a chapter, or while the plan waits for the author.
 */
export function closedChapterToRead(state: Pick<AutopilotState, "plan"> | null, activities: readonly AutopilotActivity[], status: AutopilotStatus | undefined): ClosedChapter | null {
  if (!state || status !== "paused" || state.plan?.awaitingAuthor) return null;
  const last = activities[activities.length - 1];
  if (!last || last.task !== "consolidate" || last.status !== "succeeded" || last.chapterNumber === undefined) return null;
  return { number: last.chapterNumber, slug: state.plan?.chapters.find((chapter) => chapter.number === last.chapterNumber)?.slug };
}

export interface FinalVerdict {
  verdict?: "approve" | "revise" | "rewrite";
  score?: number;
  text: string;
}

const VERDICT_LINE = /^(approve|revise|rewrite)\s+(\d+(?:[.,]\d+)?)\s*\/\s*10\s+[—–-]\s+([\s\S]+)$/;

/**
 * What the director's reviews write as the result of a step: “approve 8/10 — what it thinks” (the review of a chapter, the review of the book). The one
 * place that reads it. The engine now says the verdict on the whole book (`finalReview`) and the votes of the rounds of a chapter (`rounds`) as data: this
 * is what stands in for them when a state does not have them, for a state that an older engine wrote.
 */
export function parseVerdictLine(summary: string | undefined): { verdict: NonNullable<FinalVerdict["verdict"]>; score: number; text: string } | null {
  const match = summary ? VERDICT_LINE.exec(summary.trim()) : null;
  return match ? { verdict: match[1] as NonNullable<FinalVerdict["verdict"]>, score: Number(match[2].replace(",", ".")), text: match[3].trim() } : null;
}

/**
 * The review of the whole book that the engine saved. The summary is the newest word on the state of the book, so a book that was reopened has none even if an
 * older download still has one; the saved state has the words whole (the summary cuts them), and they are taken from it when it is the same review.
 */
export function finalReviewOf(summary: Pick<AutopilotStateSummary, "finalReview"> | null | undefined, state: Pick<AutopilotState, "finalReview"> | null | undefined): AutopilotFinalReview | null {
  const review = summary?.finalReview;
  if (!review) return null;
  const saved = state?.finalReview;
  return saved && saved.at === review.at && saved.verdict === review.verdict && saved.score === review.score && saved.text.length > review.text.length ? saved : review;
}

/**
 * The director's judgement on the whole book: the review the engine saved, when it did; else, for a state that an older engine wrote, what the last final review
 * that worked wrote in the log (“approve 8/10 — what it thinks”).
 */
export function finalVerdict(activities: readonly AutopilotActivity[], review?: AutopilotFinalReview | null): FinalVerdict | null {
  if (review) return { verdict: review.verdict, score: review.score, text: review.text };
  for (let index = activities.length - 1; index >= 0; index -= 1) {
    const activity = activities[index];
    if (activity.task !== "final" || activity.status !== "succeeded") continue;
    const summary = activity.summary?.trim();
    if (!summary) return null;
    return parseVerdictLine(summary) ?? { text: summary };
  }
  return null;
}

/**
 * How long the autopilot worked: what the engine counted (`stats.workedMs`, over every run, and not only for the steps in the log), when it did; else, for a state
 * that an older engine wrote, how long the steps in the log took, together. The log keeps the last `MAX_ACTIVITIES` steps: when it is full the older ones are
 * missing, and that total is a minimum.
 */
export function workedTime(activities: readonly AutopilotActivity[], workedMs?: number): { milliseconds: number; complete: boolean } {
  if (typeof workedMs === "number" && Number.isFinite(workedMs) && workedMs > 0) return { milliseconds: workedMs, complete: true };
  let milliseconds = 0;
  for (const activity of activities) {
    if (!activity.endedAt) continue;
    const length = Date.parse(activity.endedAt) - Date.parse(activity.startedAt);
    if (Number.isFinite(length) && length > 0) milliseconds += length;
  }
  return { milliseconds, complete: activities.length < MAX_ACTIVITIES };
}

/** How much older than the count a book has to be for the card to say since when the time is counted: a count that begins with the book has nothing to say. */
const SAME_BEGINNING_MS = 3_600_000;

/**
 * The moment the working time began to be counted (`stats.workedMsSince`), when it is worth saying: the book is older than the count, so the time before it was never counted (a book
 * that was started before the engine counted, and went on after). Nothing when the engine did not say it (a count that began before the moment was written has none, and none is made
 * up), when it is not a date, when there is no count to say it of, and when the book's own start is not known to compare it with.
 */
export function workedSince(stats: { workedMs?: number; workedMsSince?: string }, bookStartedAt: string | undefined): string | null {
  const worked = stats.workedMs;
  if (typeof worked !== "number" || !Number.isFinite(worked) || worked <= 0) return null;
  const since = typeof stats.workedMsSince === "string" ? Date.parse(stats.workedMsSince) : Number.NaN;
  const started = typeof bookStartedAt === "string" ? Date.parse(bookStartedAt) : Number.NaN;
  if (!Number.isFinite(since) || !Number.isFinite(started)) return null;
  return since - started > SAME_BEGINNING_MS ? (stats.workedMsSince as string) : null;
}

export interface BudgetFigure {
  value: number;
  /** The budget, or `null` when there is none (zero is no limit). */
  limit: number | null;
  /** The part of the budget used, from 0 to 1 (a budget that was passed is a full bar), or `null` without a budget. */
  ratio: number | null;
}

export interface BudgetUse {
  cost: BudgetFigure;
  tokens: BudgetFigure;
}

function figure(value: number, limit: number | undefined): BudgetFigure {
  if (!limit || limit <= 0) return { value, limit: null, ratio: null };
  return { value, limit, ratio: Math.min(1, Math.max(0, value / limit)) };
}

/** The cost and the tokens used, each against its budget when the author set one. The options are the ones of the saved state, which the page may not have yet. */
export function budgetUse(stats: Pick<AutopilotStats, "cost" | "inputTokens" | "outputTokens">, options: Pick<AutopilotOptions, "budgetLimit" | "budgetTokens"> | null | undefined): BudgetUse {
  return { cost: figure(stats.cost, options?.budgetLimit), tokens: figure(stats.inputTokens + stats.outputTokens, options?.budgetTokens) };
}

/**
 * How the page of the autopilot is laid out for the width it has: `wide` has two columns, `tabs` has tabs and the whole band, `compact`
 * has tabs, a band of two rows and the actions in a bar at the bottom. A width that is not known is a wide one.
 */
export type PageLayout = "wide" | "tabs" | "compact";
export const WIDE_FROM = 880;
export const COMPACT_BELOW = 560;

export function pageLayout(width: number | null): PageLayout {
  if (width === null || width >= WIDE_FROM) return "wide";
  return width < COMPACT_BELOW ? "compact" : "tabs";
}
