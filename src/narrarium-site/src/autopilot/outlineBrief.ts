import { serverHasOutlineBrief as serverAnnouncesOutlineBrief, type ServerInfo } from "narrarium-engine";
import { OUTLINE_BRIEF_DEFAULT, OUTLINE_BRIEF_FILE, OUTLINE_BRIEF_WORDS_PER_SCENE, autopilotPresetSkeleton, outlineChapterPath, readOutlineBrief, serializeOutlineBrief, serializeOutlineChapter, type AutopilotPresetId, type BookStore, type OutlineBrief, type OutlineBriefFields, type OutlineBriefReading } from "narrarium-engine";

export { OUTLINE_BOOK_FILE, OUTLINE_BRIEF_FILE, parseOutlineBrief, serializeOutlineBrief, type OutlineBrief, type OutlineBriefFields, type OutlineBriefReading } from "narrarium-engine";

/**
 * The brief of a book as the Scaletta holds it. The idea is the description of the book (`outline/book.md`); the genre, the audience, the words per scene
 * and the synopsis are the fields of `outline/_brief.md`. The engine composes the two (`readOutlineBrief`), and writes them (`writeOutlineBrief`, or the
 * changes of `outlineBriefChanges`): the site reads them from the files of the page and saves them through the outline's own commit.
 */

/** The words per scene the field takes: the engine's limits, in steps of a hundred. */
export const WORDS_PER_SCENE = { min: OUTLINE_BRIEF_WORDS_PER_SCENE.min, max: OUTLINE_BRIEF_WORDS_PER_SCENE.max, step: 100 } as const;

/** What a brief says when the book has none: the engine's defaults. */
export const EMPTY_OUTLINE_BRIEF: OutlineBrief = OUTLINE_BRIEF_DEFAULT;

/** Whether two sets of the brief's fields say the same: what the page compares before it offers to save. */
export function sameBriefFields(left: OutlineBriefFields, right: OutlineBriefFields): boolean {
  return left.genre.trim() === right.genre.trim()
    && left.audience.trim() === right.audience.trim()
    && left.wordsPerScene === right.wordsPerScene
    && left.synopsis.trim() === right.synopsis.trim();
}

/**
 * A store that only reads the files the page holds: the engine's composition (`readOutlineBrief`) reads through `read`, and nothing is written through it
 * (a write goes through the outline's commit).
 */
function readOnlyStoreOf(files: ReadonlyArray<{ path: string; content: string; hash?: string }>): BookStore {
  const byPath = new Map(files.map((file) => [file.path, file]));
  return {
    list: async () => files.map((file) => ({ path: file.path, hash: file.hash ?? "" })),
    read: async (path: string) => {
      const file = byPath.get(path);
      return file ? { path, content: file.content, hash: file.hash ?? "" } : null;
    },
    commit: async () => {
      throw new Error("The brief is read here, not written: the Scaletta saves it.");
    },
  };
}

/** The brief of the files of the outline, composed as the engine composes it: the idea from `book.md`, the fields from `_brief.md`. */
export function briefOfFiles(files: ReadonlyArray<{ path: string; content: string; hash?: string }>): Promise<OutlineBriefReading> {
  return readOutlineBrief(readOnlyStoreOf(files));
}

/**
 * The files a new book starts with for a size: its brief (the words per scene of the size; the idea is the description, left empty) and one entry per
 * chapter of the size, with no text, which the autopilot fills (`origin: autopilot`: the plan writes the entries that have none, and never touches an
 * author's). The engine has no function for these files, so the site writes them with the engine's serializers. `undefined` for an id that is not a size.
 */
export function presetOutlineFiles(id: AutopilotPresetId): Array<{ path: string; content: string }> | undefined {
  const skeleton = autopilotPresetSkeleton(id);
  if (!skeleton) return undefined;
  const brief = serializeOutlineBrief({ genre: "", audience: "", wordsPerScene: skeleton.wordsPerScene, synopsis: "" });
  const entries = Array.from({ length: skeleton.chapters }, (_, index) => ({
    path: outlineChapterPath(index + 1),
    content: serializeOutlineChapter({ number: index + 1, origin: "autopilot" }),
  }));
  return [{ path: OUTLINE_BRIEF_FILE, content: brief }, ...entries];
}

/** The id of the alert that says a personal server is too old to take the length of a book from its Scaletta: the buttons that would start or save point to it. */
export const OUTLINE_BRIEF_NOTICE_ID = "autopilot-outline-brief-notice";

/** The first release of the personal server that reads the brief and the chapters from the Scaletta (it announces `autopilot-outline-brief`). */
export const OUTLINE_BRIEF_SERVER_VERSION = "0.1.13";

/**
 * Whether the personal server takes the length of the book from its Scaletta (`autopilot-outline-brief`). An older one plans the default twelve
 * chapters and ignores the outline: the autopilot is not started or configured on it from here. Browser-hosted books are not asked.
 */
export function serverHasOutlineBrief(info: Pick<ServerInfo, "features"> | null | undefined): boolean {
  return serverAnnouncesOutlineBrief(info);
}
