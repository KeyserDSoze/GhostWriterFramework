import type { AutopilotState, AutopilotTaskKind, ChapterReview, PlannedChapter, PlannedScene } from "narrarium-engine";

/**
 * The map of the chapters: every chapter a row, every scene a cell, with the state of each worked out from the autopilot's state (the plan, the
 * review in progress, the revision of the book) and the step that runs now. Nothing here reads the book: which chapters are frozen is told by the
 * page, which reads the `chapter.md` of the chapters on the screen only. Pure.
 */

/** The state of a scene, in the order of the legend: to write, being written, written, in review, approved, to rewrite, frozen. */
export type SceneState = "todo" | "writing" | "written" | "review" | "approved" | "rewrite" | "frozen";
export const SCENE_STATES: readonly SceneState[] = ["todo", "writing", "written", "review", "approved", "rewrite", "frozen"];

/** The state of a chapter: planned, being written, in review, approved, written by the author before the autopilot took over, to be rewritten. */
export type ChapterState = "planned" | "writing" | "review" | "approved" | "imported" | "rewrite";

/** The step that runs now, as much of it as the map needs. */
export interface LiveStep {
  task: AutopilotTaskKind;
  chapterNumber?: number;
  sceneNumber?: number;
}

/** The steps that write the text of a scene: a first draft, a fix the director asked for, a revision of the book. */
const WRITING: ReadonlySet<AutopilotTaskKind> = new Set(["write", "repair", "revise"]);

export interface MapContext {
  review: Pick<ChapterReview, "chapterNumber" | "round" | "repairQueue"> | null;
  /** The scenes a revision of the book is still to rewrite, as `chapter:scene`. */
  rewrite: ReadonlySet<string>;
  /** The chapters those scenes are in. */
  rewriteChapters: ReadonlySet<number>;
  live: LiveStep | null;
  /** The slugs of the chapters that are frozen. */
  frozen: ReadonlySet<string>;
}

export function mapContext(state: Pick<AutopilotState, "review" | "revision"> | null, live: LiveStep | null, frozen: ReadonlySet<string>): MapContext {
  const revision = state?.revision;
  const pending = revision?.targets ? revision.targets.slice(Math.max(0, revision.cursor ?? 0)) : [];
  return {
    review: state?.review ?? null,
    rewrite: new Set(pending.map((target) => `${target.chapterNumber}:${target.sceneNumber}`)),
    rewriteChapters: new Set(pending.map((target) => target.chapterNumber)),
    live,
    frozen,
  };
}

function writingNow(context: MapContext, chapterNumber: number, sceneNumber?: number): boolean {
  const live = context.live;
  if (!live || !WRITING.has(live.task) || live.chapterNumber !== chapterNumber) return false;
  return sceneNumber === undefined || live.sceneNumber === sceneNumber;
}

export function sceneStateOf(chapter: Pick<PlannedChapter, "number" | "slug" | "status" | "imported">, scene: Pick<PlannedScene, "number" | "status">, context: MapContext): SceneState {
  if (writingNow(context, chapter.number, scene.number)) return "writing";
  if (context.rewrite.has(`${chapter.number}:${scene.number}`)) return "rewrite";
  // A state written by an older engine, or cut short, may lack the queue: it is read as empty.
  if (context.review?.chapterNumber === chapter.number && (context.review.repairQueue ?? []).includes(scene.number)) return "rewrite";
  if (chapter.status === "done") return context.frozen.has(chapter.slug) ? "frozen" : chapter.imported ? "written" : "approved";
  if (scene.status === "planned") return "todo";
  return chapter.status === "review" ? "review" : "written";
}

export function chapterStateOf(chapter: Pick<PlannedChapter, "number" | "status" | "imported">, context: MapContext): ChapterState {
  if (writingNow(context, chapter.number) && chapter.status === "done") return "writing";
  if (context.rewriteChapters.has(chapter.number)) return "rewrite";
  switch (chapter.status) {
    case "planned":
      return "planned";
    case "writing":
      return "writing";
    case "review":
      return "review";
    default:
      return chapter.imported ? "imported" : "approved";
  }
}

/** How many scenes of a chapter are in each state (the states that have none are left out), for the words of the table. */
export function sceneCounts(chapter: Pick<PlannedChapter, "number" | "slug" | "status" | "imported" | "scenes">, context: MapContext): Partial<Record<SceneState, number>> {
  const counts: Partial<Record<SceneState, number>> = {};
  for (const scene of chapter.scenes) {
    const state = sceneStateOf(chapter, scene, context);
    counts[state] = (counts[state] ?? 0) + 1;
  }
  return counts;
}

export interface GridPosition {
  row: number;
  /** 0 is the cell of the chapter, 1 and on its scenes. */
  col: number;
}

/**
 * Where a key moves the focus in the map, as the grid pattern of WAI-ARIA says: the arrows by one cell (up and down to the same column, or to the last
 * cell of a shorter row), Home and End to the ends of the row (of the map with Control), Page Up and Page Down by `page` rows. `cells` is how many
 * cells each row has. `null` when the key moves nothing.
 */
export function moveInGrid(position: GridPosition, key: string, cells: readonly number[], options: { ctrl: boolean; page: number }): GridPosition | null {
  const last = cells.length - 1;
  if (last < 0) return null;
  const clamp = (row: number, col: number): GridPosition => ({ row, col: Math.max(0, Math.min(col, cells[row] - 1)) });
  const { row, col } = position;
  switch (key) {
    case "ArrowRight":
      return col + 1 < cells[row] ? { row, col: col + 1 } : null;
    case "ArrowLeft":
      return col > 0 ? { row, col: col - 1 } : null;
    case "ArrowDown":
      return row < last ? clamp(row + 1, col) : null;
    case "ArrowUp":
      return row > 0 ? clamp(row - 1, col) : null;
    case "Home":
      return options.ctrl ? { row: 0, col: 0 } : { row, col: 0 };
    case "End":
      return options.ctrl ? clamp(last, cells[last] - 1) : clamp(row, cells[row] - 1);
    case "PageDown":
      return row < last ? clamp(Math.min(last, row + options.page), col) : null;
    case "PageUp":
      return row > 0 ? clamp(Math.max(0, row - options.page), col) : null;
    default:
      return null;
  }
}

/** The chapters the map draws at once: as many as the outline lists at a time. */
export const MAP_PAGE_SIZE = 50;

/** The position of the chapter in progress (the first that is not approved), `-1` when every chapter is. */
export function progressIndex(chapters: ReadonlyArray<Pick<PlannedChapter, "status">>): number {
  return chapters.findIndex((chapter) => chapter.status !== "done");
}

/** The first position of the window of `size` chapters that holds `index`. */
export function pageStart(index: number, size: number): number {
  return index < 0 ? 0 : Math.floor(index / size) * size;
}

/** Letters to compare, whatever their case and accents, in any alphabet. */
function matchKey(value: string): string {
  return value.normalize("NFKD").replace(/\p{M}/gu, "").toLocaleLowerCase().replace(/\s+/g, " ").trim();
}

/**
 * The positions of the chapters that a search finds: the chapter with that number when it is a number, else the chapters whose title has its words.
 * `null` when there is nothing to search (no title is read then: a plan has no maximum number of chapters).
 */
export function chapterMatches(chapters: ReadonlyArray<Pick<PlannedChapter, "number" | "title">>, query: string): number[] | null {
  const typed = query.trim();
  if (!typed) return null;
  if (/^\d+$/.test(typed)) {
    const number = Number(typed);
    const index = chapters.findIndex((chapter) => chapter.number === number);
    return index < 0 ? [] : [index];
  }
  const key = matchKey(typed);
  if (!key) return null;
  const found: number[] = [];
  chapters.forEach((chapter, index) => {
    if (matchKey(chapter.title).includes(key)) found.push(index);
  });
  return found;
}
