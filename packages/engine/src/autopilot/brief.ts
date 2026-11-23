import { outlineBriefChanges, readOutlineBrief, type OutlineBrief } from "../book/outline-brief.js";
import type { BookFileChange, BookStore } from "../book/store.js";
import { DEFAULT_BRIEF } from "./state.js";
import type { AutopilotBrief, AutopilotState } from "./types.js";

/**
 * The brief a run starts from or a configuration reads: the idea from the description of the book (`outline/book.md`), the fields from
 * `outline/_brief.md`. A book saved before the brief had these files moves what its state held into them, once: the idea when the author has
 * written no description (a description that the author wrote is never overwritten), and the fields when `_brief.md` does not exist. The
 * returned `changes` make that move, and the caller commits them with its own commit. A file whose frontmatter cannot be read stops the
 * reading: the brief is never taken as the defaults over an author's text.
 */
export async function readBrief(store: BookStore, state?: Pick<AutopilotState, "brief"> | null): Promise<{ brief: AutopilotBrief; changes: BookFileChange[] }> {
  const reading = await readOutlineBrief(store);
  if (reading.unreadable) throw new Error("outline/_brief.md: its frontmatter is not valid YAML: correct the file before the autopilot reads its brief.");
  if (reading.bookUnreadable) throw new Error("outline/book.md: its frontmatter is not valid YAML: correct the file before the autopilot reads the idea of the book.");
  const legacy = state?.brief ?? DEFAULT_BRIEF;
  const moved: Partial<OutlineBrief> = {};
  if (!reading.brief.idea && legacy.idea) moved.idea = legacy.idea;
  const fieldsMoved = Boolean(legacy.synopsis || legacy.genre || legacy.audience || legacy.wordsPerScene !== DEFAULT_BRIEF.wordsPerScene);
  if (!reading.hash && fieldsMoved) Object.assign(moved, { genre: legacy.genre, audience: legacy.audience, wordsPerScene: legacy.wordsPerScene, synopsis: legacy.synopsis });
  if (Object.keys(moved).length === 0) return { brief: reading.brief, changes: [] };
  const planned = await outlineBriefChanges(store, moved);
  return { brief: planned.brief, changes: planned.changes };
}
