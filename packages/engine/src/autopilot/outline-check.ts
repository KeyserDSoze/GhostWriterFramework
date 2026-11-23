import type { OutlineReader } from "../book/outline.js";
import { isItalian } from "../util/text.js";
import { isPlannedChapterWritten } from "./chapter-state.js";
import type { PlanNote } from "./planner.js";
import type { AutopilotState } from "./types.js";

// Whether a chapter counts as written is in `chapter-state.ts`, which has no import but types: the rule that tells the author what happens when an entry changes
// (`outline-change.ts`) needs it too, and must not carry the rest of this module with it. The export stays where it was.
export { isPlannedChapterWritten } from "./chapter-state.js";

/**
 * The new outline entry of a chapter already closed (`done`), which the author changed since the plan followed it: the author decides
 * what to do with it, as with a change of a frozen chapter (`frozenEdits`, see `autopilot/frozen.ts`).
 */
export interface OutlineWrittenChange {
  number: number;
  /** The digest of the new entry (`outlineEntryDigest`): what the plan keeps once the author decided. */
  digest: string;
  title: string;
  body: string;
}

/** What the outline says of the plan before a step: see `outlinePlanStatus`. */
export interface OutlinePlanStatus {
  /** The chapter about to be started whose entry changed (`changed`) or was deleted (`removed`) since the plan followed it. */
  changed: Map<number, "changed" | "removed">;
  /** The chapters already closed whose entry the author changed (not deleted, and readable): the author decides about each. */
  written: Map<number, OutlineWrittenChange>;
  /**
   * What the author should know: the entry of a written chapter that was deleted, or that changed while the chapter is still being
   * written, an entry that cannot be read. Each is said once a run.
   */
  notes: PlanNote[];
}

function text(language: string, en: string, it: string): string {
  return isItalian(language) ? it : en;
}

/**
 * The outline against an approved plan, before a step. The chapter about to be started, with nothing written, is planned again
 * when its entry no longer matches the digest the plan kept (`PlannedChapter.outlineDigest`: the author changed it, or wrote one
 * for a chapter that had none), and leaves the plan when the entry it came from was deleted (never when the whole outline is gone:
 * deleting `outline/` is not deleting every chapter). An entry the autopilot wrote and nobody touched is never followed by a chapter
 * whose plan does not remember its entry (a state saved by an engine that did not know the outline). An entry that cannot be read
 * changes nothing until the author corrects it. A chapter already closed whose entry changed is never touched here: it is in `written`,
 * and the author decides about it (it is asked, reviewed or said, as `frozenEdits` says). One still being written is told once a run,
 * and decided about once it is closed. Only the entries of the chapter about to be started and of the chapters written are read,
 * through the run's cache.
 */
export async function outlinePlanStatus(outline: OutlineReader, state: AutopilotState, language: string): Promise<OutlinePlanStatus> {
  const changed = new Map<number, "changed" | "removed">();
  const written = new Map<number, OutlineWrittenChange>();
  const notes: PlanNote[] = [];
  const plan = state.plan;
  if (!plan?.approved) return { changed, written, notes };
  const hasEntries = outline.index.chapters.length > 0;
  const current = plan.chapters.find((chapter) => chapter.status !== "done");
  if (current && !isPlannedChapterWritten(current)) {
    const entry = await outline.chapter(current.number);
    if (entry?.unreadable) {
      notes.push({
        key: `outline-unreadable:${current.number}:${entry.contentDigest}`,
        tone: "warning",
        code: "outlineWarnings",
        chapterNumber: current.number,
        title: text(language, `The outline of chapter ${current.number} cannot be read: the plan keeps what it had`, `La Scaletta del capitolo ${current.number} non si legge: il piano resta com'era`),
        detail: outline.warnings().filter((warning) => warning.path === entry.path).map((warning) => warning.message).join("\n") || entry.path,
      });
    } else if (entry && entry.contentDigest !== current.outlineDigest && !(entry.intact && !current.outlineDigest)) {
      // An entry the autopilot wrote and nobody touched, for a chapter whose plan does not remember its entry (a state saved by an
      // engine that did not know the outline), is the chapter's own: only an entry of the author is followed.
      changed.set(current.number, "changed");
    } else if (!entry && current.outlineDigest && hasEntries) changed.set(current.number, "removed");
  }
  for (const chapter of plan.chapters) {
    if (!chapter.outlineDigest || !isPlannedChapterWritten(chapter)) continue;
    const entry = await outline.chapter(chapter.number);
    if (entry?.contentDigest === chapter.outlineDigest || (!entry && !hasEntries)) continue;
    if (entry?.unreadable) {
      notes.push({
        key: `outline-unreadable:${chapter.number}:${entry.contentDigest}`,
        tone: "warning",
        code: "outlineWarnings",
        chapterNumber: chapter.number,
        title: text(language, `The outline of chapter ${chapter.number} cannot be read: nothing changes until you correct it`, `La Scaletta del capitolo ${chapter.number} non si legge: non cambia nulla finché non la correggi`),
        detail: outline.warnings().filter((warning) => warning.path === entry.path).map((warning) => warning.message).join("\n") || entry.path,
      });
      continue;
    }
    if (entry && chapter.status === "done") {
      written.set(chapter.number, { number: chapter.number, digest: entry.contentDigest, title: entry.title, body: entry.body });
      continue;
    }
    notes.push({
      key: `outline-written:${chapter.number}:${entry?.contentDigest ?? "removed"}`,
      tone: "info",
      // Two things, each with its code: the entry of a chapter still being written changed (it is decided once the chapter is closed), or the
      // entry of a written chapter is gone (the chapter stays in the book). A closed chapter whose entry changed is in `written`.
      code: entry ? "outlineChangedWhileWriting" : "outlineRemovedWritten",
      chapterNumber: chapter.number,
      title: entry
        ? text(language, `The outline of chapter ${chapter.number} changed while the chapter is being written: you will decide what to do once it is closed`, `La Scaletta del capitolo ${chapter.number} è cambiata mentre il capitolo è in scrittura: deciderai cosa fare quando sarà chiuso`)
        : text(language, `Chapter ${chapter.number} is no longer in the outline, but it is already written: it stays in the book`, `Il capitolo ${chapter.number} non è più nella Scaletta, ma è già scritto: resta nel libro`),
    });
  }
  return { changed, written, notes };
}
