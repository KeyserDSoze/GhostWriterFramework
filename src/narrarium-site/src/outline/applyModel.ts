import type { AutopilotState, ChapterFreeze, ReviseChaptersInput, RevisionChapterMode } from "narrarium-engine";
import type { WhatChanged, WhatChangedRow } from "@/outline/whatChanged";

/**
 * «Apply to the book» on the Synopsis page: the written chapters whose entry changed, each with what the author chooses for it, and the campaign of the engine
 * (`reviseChapters`, reason `outline-change`) that carries the choices out. Pure.
 *
 * - A chapter the author decides about now is a written chapter, closed, whose entry the autopilot has not followed yet: what the setting of the autopilot
 *   (`frozenEdits`) would do with it (`ask`, `auto`, `notify`), also one left for later before or one whose decision waits for the next run.
 * - What it is by default: rewritten to follow the Synopsis when the autopilot approved it (and froze it); left for later when the author froze it by hand, wrote
 *   it before the autopilot (an imported chapter the autopilot never froze: it never rewrites it for its own decision), or left it for later already. The author
 *   changes it. A plan made again around written chapters (a book that grew) counts them all as imported: the record of the freeze says who wrote one.
 * - Every other chapter of «What changed» is told, not decided: the autopilot plans it again, plans it after the plan, takes it out of the plan, keeps it, or decides
 *   about it once it has finished working on it.
 */

export type ApplyChoice = RevisionChapterMode;

export interface ApplyRow {
  row: WhatChangedRow;
  /** What the setting of the autopilot does with the change without a choice. */
  outcome: "ask" | "auto" | "notify";
  /** Who froze the chapter, when it is frozen. */
  frozenBy: ChapterFreeze["by"] | null;
  /** The author wrote it before the autopilot, which never approved it: it is rewritten only because the author chooses it. */
  authorWritten: boolean;
  /** The choice it starts with. */
  initial: ApplyChoice;
}

export interface ApplyModel {
  /** The chapters to decide about, in the order of the book. */
  decide: ApplyRow[];
  /** The other chapters of «What changed» that the autopilot has not followed yet: told, not decided. */
  told: WhatChangedRow[];
}

const DECIDED = new Set(["ask", "auto", "notify"]);

/** Whether the author decides about the change of a row of «What changed» in «Apply to the book». */
export function isDecidable(row: WhatChangedRow): boolean {
  return row.pending && row.written && DECIDED.has(row.outcome) && Boolean(row.digest) && (!row.held || row.held === "deferred" || row.held === "decided");
}

/** The choice a chapter starts with (see the module); a decision recorded for the next run is the author's choice already. */
export function initialChoice(row: WhatChangedRow, frozenBy: ChapterFreeze["by"] | null): ApplyChoice {
  if (row.held === "decided" && row.decision) return row.decision === "rewrite-to-outline" ? "follow" : "keep";
  if (row.held === "deferred" || frozenBy === "author") return "later";
  return frozenBy === "autopilot" || !row.imported ? "follow" : "later";
}

/** The panel of a view: `freezes` has the record of each written chapter that is frozen, by number (`null`: not frozen). */
export function applyModel(view: WhatChanged, freezes: ReadonlyMap<number, ChapterFreeze | null>): ApplyModel {
  const decide: ApplyRow[] = [];
  const told: WhatChangedRow[] = [];
  for (const row of view.rows) {
    if (!row.pending) continue;
    if (isDecidable(row)) {
      const frozenBy = freezes.get(row.number)?.by ?? null;
      decide.push({ row, outcome: row.outcome as ApplyRow["outcome"], frozenBy, authorWritten: row.imported && frozenBy !== "autopilot", initial: initialChoice(row, frozenBy) });
    } else told.push(row);
  }
  return { decide, told };
}

/** The campaign the choices make: every chapter decided about, with the fingerprint of the change the author saw (a change made since is refused, `stale`). */
export function reviseInput(rows: readonly ApplyRow[], choices: ReadonlyMap<number, ApplyChoice>, words: { note?: string; instructions?: ReadonlyMap<number, string> } = {}): ReviseChaptersInput {
  const note = words.note?.trim();
  return {
    reason: "outline-change",
    chapters: rows.map(({ row, initial }) => {
      const mode = choices.get(row.number) ?? initial;
      const instruction = mode === "follow" ? words.instructions?.get(row.number)?.trim() : undefined;
      return { number: row.number, mode, fingerprint: row.digest!, ...(instruction ? { instruction } : {}) };
    }),
    ...(note ? { note } : {}),
  };
}

/** The chapters the choices rewrite: every one of them is written and closed (approved, or written by the author), so the author confirms them first. */
export function toRewrite(rows: readonly ApplyRow[], choices: ReadonlyMap<number, ApplyChoice>): ApplyRow[] {
  return rows.filter(({ row, initial }) => (choices.get(row.number) ?? initial) === "follow");
}

/**
 * The state the estimate of the chapters to rewrite is made on: those chapters still to write, every other one done, no reader (a chapter rewritten is reviewed again
 * without the simulated readers) and the book judged already. Writing a chapter anew costs at least as much as rewriting the scenes its new entry needs: an upper bound.
 */
export function rewriteEstimateState(state: AutopilotState, numbers: ReadonlySet<number>): AutopilotState {
  const plan = state.plan!;
  return {
    ...state,
    finalDone: true,
    options: { ...state.options, readers: false, readersOnPlan: false },
    plan: { ...plan, chapters: plan.chapters.map((chapter) => ({ ...chapter, status: numbers.has(chapter.number) ? "planned" as const : "done" as const })) },
  };
}

/** The state the estimate of the rest of the plan is made on, once the chapters are rewritten: a rewrite reopens the book, which the director judges again at its end. */
export function restEstimateState(state: AutopilotState, rewriting: boolean): AutopilotState {
  return rewriting ? { ...state, finalDone: false } : state;
}
