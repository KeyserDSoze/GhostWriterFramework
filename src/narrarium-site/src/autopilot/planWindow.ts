import type { PlannedChapter } from "narrarium-engine";

/** A plan of up to this many chapters is listed in full. Longer plans show a window and hide the rest in runs. */
export const PLAN_FULL_LIST_LIMIT = 40;
/** Chapters always shown at each end of a long plan. */
export const PLAN_EDGE_CHAPTERS = 5;
/** Chapters shown before and after the chapter in progress. */
export const PLAN_CONTEXT_CHAPTERS = 5;
/** Chapters a hidden run shows each time it is opened. */
export const PLAN_REVEAL_STEP = 50;
/** A hidden run of at most this many chapters is shown in one go. */
export const PLAN_SHOW_ALL_LIMIT = 100;

/** Positions in the plan's chapter list, both ends included. */
export interface PlanRange {
  from: number;
  to: number;
}

export type PlanSegment = (PlanRange & { kind: "shown" }) | (PlanRange & { kind: "hidden" });

/** The chapter in progress is the first one that is not approved yet; -1 when every chapter is. */
export function chapterInProgress(chapters: ReadonlyArray<Pick<PlannedChapter, "status">>): number {
  return chapters.findIndex((chapter) => chapter.status !== "done");
}

/** Sort ranges and join those that overlap or touch. */
export function mergeRanges(ranges: readonly PlanRange[]): PlanRange[] {
  const merged: PlanRange[] = [];
  for (const range of [...ranges].sort((left, right) => left.from - right.from || left.to - right.to)) {
    const last = merged[merged.length - 1];
    if (last && range.from <= last.to + 1) last.to = Math.max(last.to, range.to);
    else merged.push({ ...range });
  }
  return merged;
}

/**
 * How a plan of `count` chapters is laid out: the chapters shown (the first and last few, the ones around the chapter in
 * progress at position `focus`, and whatever the author already opened) with a hidden run between every two of them.
 */
export function planSegments(count: number, focus: number, opened: readonly PlanRange[]): PlanSegment[] {
  if (count <= 0) return [];
  const last = count - 1;
  const shown = mergeRanges([
    { from: 0, to: Math.min(last, PLAN_EDGE_CHAPTERS - 1) },
    { from: Math.max(0, count - PLAN_EDGE_CHAPTERS), to: last },
    ...(focus >= 0 ? [{ from: Math.max(0, focus - PLAN_CONTEXT_CHAPTERS), to: Math.min(last, focus + PLAN_CONTEXT_CHAPTERS) }] : []),
    ...opened.map((range) => ({ from: Math.max(0, range.from), to: Math.min(last, range.to) })).filter((range) => range.from <= range.to),
  ]);
  const segments: PlanSegment[] = [];
  let next = 0;
  for (const range of shown) {
    if (range.from > next) segments.push({ kind: "hidden", from: next, to: range.from - 1 });
    segments.push({ kind: "shown", ...range });
    next = range.to + 1;
  }
  return segments;
}

/** What opening a hidden run shows: all of it when it is short, otherwise its next chapters. */
export function nextReveal(run: PlanRange): PlanRange {
  const size = run.to - run.from + 1;
  return size <= PLAN_SHOW_ALL_LIMIT ? { ...run } : { from: run.from, to: run.from + PLAN_REVEAL_STEP - 1 };
}

export interface RunCounts {
  /** Written by the author before the autopilot took over. */
  imported: number;
  approved: number;
  /** Being written or reviewed. */
  active: number;
  planned: number;
}

/** How many chapters of a hidden run were written by the author, are approved, are being written or reviewed, or are only planned. */
export function countRun(chapters: ReadonlyArray<Pick<PlannedChapter, "status" | "imported">>, run: PlanRange): RunCounts {
  const counts: RunCounts = { imported: 0, approved: 0, active: 0, planned: 0 };
  for (let index = run.from; index <= run.to; index += 1) {
    const chapter = chapters[index];
    if (chapter?.status === "done") counts[chapter.imported ? "imported" : "approved"] += 1;
    else if (chapter?.status === "planned") counts.planned += 1;
    else counts.active += 1;
  }
  return counts;
}
