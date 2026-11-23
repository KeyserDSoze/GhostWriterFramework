import { inHands, isPlannedChapterWritten } from "./chapter-state.js";
import { FROZEN_EDITS_MODES, type AutopilotState, type FrozenEditsMode, type PlannedChapter } from "./types.js";

/**
 * What the autopilot does about a chapter when the author changes, or deletes, its entry of the outline (the Scaletta). One rule, said once, for every host
 * that tells the author before it happens: the web app's Outline page, the personal server's MCP. The rule is the engine's own, in `outlinePlanStatus`
 * (`outline-check.ts`) and `settleFrozenChanges` (`frozen.ts`), and a test runs those two functions on a real book for every case below.
 *
 *  - `ask`, `auto`, `notify`: the chapter is closed (`done`, or written by the author before the autopilot took over) and the plan remembers the entry it followed:
 *    the change is decided as `options.frozenEdits` says: the run stops with a question, rewrites the chapter to follow the new entry (`auto`), or only says it
 *    (`notify`). A chapter the author wrote is never rewritten for the autopilot's own decision, so under `auto` it is only said.
 *  - `later`: the chapter is being written (or the autopilot has it in its hands: a revision rewrites it, or the decision about it is being carried out); the
 *    change is said once, and decided once the chapter is closed.
 *  - `replan`: the chapter is not written yet: it is planned again from the new entry, before its scenes (the insight `outlineChanged`). Only the chapter about to
 *    be started is looked at, so a later chapter is planned again when its turn comes.
 *  - `unplan`: the entry was deleted and the chapter is not written: the chapter leaves the plan (`outlineRemoved`).
 *  - `stays`: the entry was deleted and the chapter is written: the chapter stays in the book, and the run says it once (`outlineRemovedWritten`).
 *  - `none`: nothing: no plan, a plan that does not have the chapter, a plan that does not remember an entry of the chapter, or the deletion of the whole outline
 *    (deleting `outline/` is not deleting every chapter).
 *
 * What it does not decide: an entry that cannot be read changes nothing until the author corrects it (`outlineWarnings`), and the autopilot looks at the outline only
 * once its plan is approved: a change made before is noticed when it is.
 *
 * It reads the state of a chapter (written, in the autopilot's hands) through `chapter-state.ts`, the functions `outlinePlanStatus` and `settleFrozenChanges` read it
 * with, and imports nothing else of the autopilot: a page that tells the author what a change does must not load the frozen chapters, the run's state or its transport
 * (a test follows the imports of this module). Keep it so.
 */
export type OutlineChangeOutcome = "ask" | "auto" | "notify" | "later" | "replan" | "unplan" | "stays" | "none";

/** The outcomes in the order a host tells them: what asks, rewrites or reports first, then what waits, what plans again, what stays, and what does nothing. */
export const OUTLINE_CHANGE_OUTCOMES: readonly OutlineChangeOutcome[] = ["ask", "auto", "notify", "later", "replan", "unplan", "stays", "none"];

/** What the rule reads of the state of a book's autopilot: an `AutopilotState` is one, and so is the part of it a client keeps. */
export interface OutlineChangeState {
  /** `frozenEdits` is `ask` when the author chose none (and for a value nobody knows). */
  options?: { frozenEdits?: FrozenEditsMode | string } | null;
  plan?: { chapters: ReadonlyArray<Pick<PlannedChapter, "number" | "status" | "scenes"> & Partial<Pick<PlannedChapter, "imported" | "outlineDigest">>> } | null;
  /** What the autopilot has in its hands: a revision in progress, the decision about a change being carried out. */
  revision?: AutopilotState["revision"];
  pendingReviews?: AutopilotState["pendingReviews"];
}

export interface OutlineChangeOptions {
  /** What happened to the entry: it changed (the default; a new entry for a chapter that had none is a change too), or it was deleted. */
  entry?: "changed" | "removed";
  /** For a deletion: the outline has no entry left at all, which is not a deletion of every chapter. */
  outlineEmpty?: boolean;
}

/**
 * What the autopilot does when the entry of chapter `number` changes (see `OutlineChangeOutcome`), given the state of its autopilot: `options.frozenEdits`, the
 * chapter of the plan with that number, and the work it has in its hands. Pure; `null` for the state of a book that has no autopilot says `none`.
 */
export function changeOfWritten(state: OutlineChangeState | null | undefined, number: number, options: OutlineChangeOptions = {}): OutlineChangeOutcome {
  const chapter = state?.plan?.chapters.find((candidate) => candidate.number === number);
  if (!state || !chapter) return "none";
  const written = isPlannedChapterWritten(chapter);
  if (options.entry === "removed") {
    if (options.outlineEmpty || !chapter.outlineDigest) return "none";
    return written ? "stays" : "unplan";
  }
  if (!written) return "replan";
  if (!chapter.outlineDigest) return "none";
  if (inHands({ revision: state.revision ?? null, pendingReviews: state.pendingReviews }, chapter)) return "later";
  const mode = FROZEN_EDITS_MODES.find((candidate) => candidate === state.options?.frozenEdits) ?? "ask";
  return mode === "auto" && chapter.imported === true ? "notify" : mode;
}

/** The chapters of a series of edits that have one outcome. */
export interface OutlineChangeGroup {
  outcome: OutlineChangeOutcome;
  /** In order, each once. */
  numbers: number[];
}

/**
 * The chapters whose entry a series changed or deleted, grouped by what the autopilot does about each (`changeOfWritten`), in the order of
 * `OUTLINE_CHANGE_OUTCOMES`: a host says one sentence for each group. A chapter whose entry changed and another entry deleted in the same series is in two groups.
 */
export function groupOutlineChanges(state: OutlineChangeState | null | undefined, changes: ReadonlyArray<{ number: number; entry?: "changed" | "removed" }>, options: { outlineEmpty?: boolean } = {}): OutlineChangeGroup[] {
  const groups = new Map<OutlineChangeOutcome, Set<number>>();
  for (const change of changes) {
    const outcome = changeOfWritten(state, change.number, { ...(change.entry ? { entry: change.entry } : {}), ...(options.outlineEmpty ? { outlineEmpty: true } : {}) });
    const numbers = groups.get(outcome) ?? new Set<number>();
    numbers.add(change.number);
    groups.set(outcome, numbers);
  }
  return OUTLINE_CHANGE_OUTCOMES.filter((outcome) => groups.has(outcome)).map((outcome) => ({ outcome, numbers: [...groups.get(outcome)!].sort((left, right) => left - right) }));
}
