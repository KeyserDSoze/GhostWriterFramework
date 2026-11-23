import type { AutopilotState, PendingFrozenReview, PlannedChapter } from "./types.js";

/**
 * What the state of the autopilot says about one chapter, and nothing else: whether the chapter counts as written, which decision is being carried out, and whether the
 * autopilot has the chapter in its hands. A few pure lines, with no import but types, on purpose: the frozen chapters (`frozen.ts`) need them, and so does the rule that
 * tells the author what happens when an entry of the outline changes (`outline-change.ts`), which a page that only shows the outline loads without the rest of the
 * frozen chapters (the run's state, its prompts, its transport) that a module of `frozen.ts` would bring with it.
 */

/** A chapter counts as written when the author wrote it before the autopilot took over, the autopilot closed it, or one of its scenes is past `planned`. */
export function isPlannedChapterWritten(chapter: Pick<PlannedChapter, "status" | "scenes"> & Partial<Pick<PlannedChapter, "imported">>): boolean {
  return chapter.imported === true || chapter.status === "done" || chapter.scenes.some((scene) => scene.status !== "planned");
}

/** The decision being carried out, when one is: the autopilot works on one change at a time. */
export function startedReview(state: Pick<AutopilotState, "pendingReviews">): PendingFrozenReview | undefined {
  return state.pendingReviews?.find((entry) => entry.started);
}

/** Whether the revision in progress rewrites this chapter (or rewrote it, and reviews it again at its end). */
export function inRevision(state: Pick<AutopilotState, "revision">, number: number): boolean {
  const revision = state.revision;
  if (!revision) return false;
  return Boolean(revision.targets?.some((target) => target.chapterNumber === number) || revision.revisedChapters?.includes(number) || revision.onlyChapter === number);
}

/**
 * The chapters the autopilot has in its hands: being written or reviewed (not `done`), rewritten by the revision in progress, or the
 * change being carried out. What happens to their files then is the autopilot's own work, never a change of the author's to ask about.
 */
export function inHands(state: Pick<AutopilotState, "revision" | "pendingReviews">, chapter: Pick<PlannedChapter, "number" | "status">): boolean {
  if (chapter.status !== "done" || inRevision(state, chapter.number)) return true;
  return startedReview(state)?.number === chapter.number;
}
