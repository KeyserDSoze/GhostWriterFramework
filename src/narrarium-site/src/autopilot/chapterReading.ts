/**
 * What reading a chapter in a window over the result needs that is not a screen: the click that opens it, who the neighbours of a chapter are, the keys that move it, how much of a
 * long chapter is drawn at a time, and which files of the book it may read. Pure.
 */

/** The scenes drawn when a chapter opens, and the scenes added each time more are asked for (or the reader comes near the end): a long chapter is drawn as it is read. */
export const FIRST_SCENES = 3;
export const MORE_SCENES = 4;

/**
 * The click that follows a link inside this page: the main button with no key held. Ctrl, Cmd, Shift and Alt ask the browser for another tab, another window or a download, and the
 * middle button for another tab: those keep opening the page, as a link does.
 */
export function isPlainClick(event: { button: number; ctrlKey: boolean; metaKey: boolean; shiftKey: boolean; altKey: boolean; defaultPrevented?: boolean }): boolean {
  return !event.defaultPrevented && event.button === 0 && !event.ctrlKey && !event.metaKey && !event.shiftKey && !event.altKey;
}

/** What a click on a link to a chapter asks for: the window opens on the chapter's folder, from the link, which has the focus again when it closes. */
export type OpenChapter = (slug: string, link: HTMLElement) => void;

/**
 * The click handler of a link to a chapter, for a page that can open the chapter in a window: a plain click opens the window, in the place of the link; any other (Ctrl, Cmd, Shift, Alt, the middle
 * button) follows the link to the chapter's page as ever. Without `open`, the link is only a link.
 */
export function chapterLinkClick(open: OpenChapter | undefined, slug: string): ((event: { button: number; ctrlKey: boolean; metaKey: boolean; shiftKey: boolean; altKey: boolean; defaultPrevented: boolean; currentTarget: HTMLElement; preventDefault: () => void }) => void) | undefined {
  if (!open) return undefined;
  return (event) => {
    if (!isPlainClick(event)) return;
    event.preventDefault();
    open(slug, event.currentTarget);
  };
}

export interface Neighbours {
  previous: string | null;
  next: string | null;
  /** The place of the chapter among the chapters that can be read (from 1; 0 when it is not one of them) and how many there are. */
  position: number;
  total: number;
}

/**
 * The chapters before and after one, by their folders, among the ones the book has (`has`: the others have no text to read), in the order of the plan. A chapter is told by its
 * folder, not by its number: two folders can have one number.
 */
export function chapterNeighbours(chapters: ReadonlyArray<{ slug: string }>, has: ReadonlySet<string>, slug: string): Neighbours {
  const readable = chapters.filter((chapter) => has.has(chapter.slug));
  const index = readable.findIndex((chapter) => chapter.slug === slug);
  return {
    previous: index > 0 ? readable[index - 1].slug : null,
    next: index >= 0 && index < readable.length - 1 ? readable[index + 1].slug : null,
    position: index + 1,
    total: readable.length,
  };
}

/**
 * The chapter an arrow key asks for: -1 the previous one, 1 the next, 0 when the key is not for the window: one with a modifier, one typed in a field, one that a list scrolling
 * sideways keeps for itself (`data-own-arrows`).
 */
export function arrowStep(event: { key: string; altKey: boolean; ctrlKey: boolean; metaKey: boolean; shiftKey: boolean; target: EventTarget | null; defaultPrevented?: boolean }): -1 | 0 | 1 {
  if (event.defaultPrevented || event.altKey || event.ctrlKey || event.metaKey || event.shiftKey) return 0;
  if (event.key !== "ArrowLeft" && event.key !== "ArrowRight") return 0;
  const target = event.target;
  if (target instanceof Element && target.closest("input, textarea, select, [contenteditable]:not([contenteditable='false']), [data-own-arrows]")) return 0;
  return event.key === "ArrowLeft" ? -1 : 1;
}

/**
 * Whether a path is a scene of the chapter whose folder is `slug`: a Markdown file directly in that folder, other than the chapter's own `chapter.md`. It is all the window reads: never
 * a file of the canon, a secret in particular, so that what a secret says before its time is not in the window's reach.
 */
export function isSceneFile(path: string, slug: string): boolean {
  const folder = `chapters/${slug}/`;
  if (!path.startsWith(folder) || !path.endsWith(".md")) return false;
  const name = path.slice(folder.length);
  return name.length > ".md".length && !name.includes("/") && name !== "chapter.md";
}

/** The order of the scenes of a chapter: by their file names, whose number comes first (scene 1000 after scene 999). */
export function compareScenePaths(left: string, right: string): number {
  return left.localeCompare(right, "en", { numeric: true });
}

/** The number of a scene, from the digits its file name begins with (`002-the-tide.md` is 2); `null` for a name without. */
export function sceneNumber(path: string): number | null {
  const found = /^(\d+)/.exec(path.slice(path.lastIndexOf("/") + 1));
  return found ? Number(found[1]) : null;
}

/** The title of a scene: the one its frontmatter says, else the words of its file name (`002-the-tide-table.md` is «The tide table»); `null` when it has neither. */
export function sceneTitle(path: string, frontmatterTitle?: unknown): string | null {
  if (typeof frontmatterTitle === "string" && frontmatterTitle.trim()) return frontmatterTitle.trim();
  const name = path.slice(path.lastIndexOf("/") + 1).replace(/\.md$/i, "").replace(/^\d+[-_.\s]*/, "").replace(/[-_]+/g, " ").trim();
  return name ? name.charAt(0).toUpperCase() + name.slice(1) : null;
}

/** How many scenes are drawn once more are asked for. */
export function moreScenes(shown: number, total: number): number {
  return Math.min(total, shown + MORE_SCENES);
}
