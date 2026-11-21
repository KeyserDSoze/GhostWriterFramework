import type { AutopilotPlan, PlannedChapter } from "./types.js";

/** Characters a list of chapters may take in a prompt, unless the caller asks for another budget. */
export const OUTLINE_MAX_CHARS = 24_000;

/** Chapters up to this far from the focus keep every detail. */
const NEAR_CHAPTERS = 30;
/** Chapters farther than this from the focus are collapsed into blocks. */
const FAR_CHAPTERS = 100;
/** The first and the last chapters of a list are never collapsed. */
const EDGE_CHAPTERS = 5;
/** Chapters per collapsed line; a block grows tenfold while the list still does not fit. */
const BLOCK_CHAPTERS = 10;

export type ChapterDetail = "full" | "summary" | "title";

/** How one kind of chapter list is written, at every level of detail. */
export interface ChapterFormat<T> {
  render(item: T, detail: ChapterDetail): string;
  /** One line for a run of chapters far from the focus; with `titles` it lists them, else it only says what they are. */
  collapse(items: T[], titles: boolean): string;
}

export interface WindowOptions {
  /** The chapter being planned, reviewed or rewritten: its neighbourhood keeps the most detail. */
  around?: number;
  /** Budget in characters (default `OUTLINE_MAX_CHARS`). */
  maxChars?: number;
}

export interface OutlineOptions extends WindowOptions {
  /** One line per scene as well. */
  scenes?: boolean;
}

interface Level {
  /** Detail of the chapters that are not near the focus. */
  far: ChapterDetail;
  /** Chapters this close to the focus keep every detail. */
  near: number;
  /** Chapters farther than this from the focus (and not first or last) are collapsed into blocks. */
  mid: number;
  block: number;
}

/**
 * Tried in order until the list fits: everything; far chapters without reveals and scenes; far chapters with only a
 * title; far chapters collapsed into blocks of ten. A list that still does not fit grows its blocks tenfold, then
 * narrows the window around the focus, then the range kept line by line, so that no number of chapters can make it
 * exceed its budget.
 */
const LEVELS: Level[] = [
  { far: "full", near: Number.POSITIVE_INFINITY, mid: Number.POSITIVE_INFINITY, block: BLOCK_CHAPTERS },
  { far: "summary", near: NEAR_CHAPTERS, mid: Number.POSITIVE_INFINITY, block: BLOCK_CHAPTERS },
  { far: "title", near: NEAR_CHAPTERS, mid: Number.POSITIVE_INFINITY, block: BLOCK_CHAPTERS },
  ...[NEAR_CHAPTERS, 20, 12, 6, 3, 1, 0].flatMap((near) => [BLOCK_CHAPTERS, 100, 1000, 10_000].map((block): Level => ({ far: "title", near, mid: FAR_CHAPTERS, block }))),
  ...[50, 20, 10, 5, 0].map((mid): Level => ({ far: "title", near: 0, mid, block: 10_000 })),
];

function condensedNote(around: number | undefined, collapsed: boolean): string {
  const subject = around === undefined ? "chapters show less detail" : `chapters far from chapter ${around} show less detail`;
  return `condensed to fit: ${subject}${collapsed ? ", and runs of distant chapters share one line" : ""}`;
}

/** A list of chapters for a prompt, with what was left out of it said in words (empty when the whole list fits). */
export interface WindowedList {
  text: string;
  note: string;
}

/** A prompt section: its label (saying that the list is condensed, when it is), then the list. */
export function listSection(label: string, list: WindowedList): string {
  return `${label}${list.note ? ` (${list.note})` : ""}:\n${list.text}`;
}

/**
 * A list of chapters in at most `maxChars` characters. When the whole list fits it is returned as it is; otherwise the
 * chapters far from `around` give up detail, level by level (see `LEVELS`). The first and the last five chapters and
 * everything within 30 chapters of `around` stay on a line of their own, unless nothing else makes the list fit. A line
 * is never cut: the output only depends on the input, and the input is never changed.
 */
export function windowChapters<T extends { number: number }>(items: readonly T[], format: ChapterFormat<T>, options: WindowOptions = {}): string {
  return layoutChapters(items, format, options).text;
}

/** Like `windowChapters`, and says in words how the list was condensed, for the label of its section in a prompt. */
export function layoutChapters<T extends { number: number }>(items: readonly T[], format: ChapterFormat<T>, options: WindowOptions = {}): WindowedList {
  const total = items.length;
  if (!total) return { text: "", note: "" };
  const maxChars = options.maxChars ?? OUTLINE_MAX_CHARS;
  const around = Number.isFinite(options.around) ? options.around : undefined;
  const drawn: Array<Partial<Record<ChapterDetail, string>>> = items.map(() => ({}));
  const draw = (index: number, detail: ChapterDetail): string => (drawn[index][detail] ??= format.render(items[index], detail));
  const distance = (index: number): number => (around === undefined ? Number.POSITIVE_INFINITY : Math.abs(items[index].number - around));

  const lay = (level: Level) => {
    const lines: string[] = [];
    const groups: Array<{ line: number; members: number[]; nearest: number }> = [];
    let size = 0;
    let run: number[] = [];
    const add = (line: string) => {
      size += line.length + (lines.length ? 1 : 0);
      lines.push(line);
    };
    const flush = () => {
      for (let start = 0; start < run.length;) {
        const block = Math.floor((items[run[start]].number - 1) / level.block);
        let end = start + 1;
        while (end < run.length && Math.floor((items[run[end]].number - 1) / level.block) === block) end += 1;
        const members = run.slice(start, end);
        if (members.length === 1) add(draw(members[0], "title"));
        else {
          groups.push({ line: lines.length, members, nearest: members.reduce((nearest, index) => Math.min(nearest, distance(index)), Number.POSITIVE_INFINITY) });
          add(format.collapse(members.map((index) => items[index]), false));
        }
        start = end;
      }
      run = [];
    };
    for (let index = 0; index < total; index += 1) {
      const edge = index < EDGE_CHAPTERS || index >= total - EDGE_CHAPTERS;
      const away = distance(index);
      if (!edge && away > level.mid) {
        run.push(index);
        continue;
      }
      flush();
      add(draw(index, away <= level.near ? "full" : level.far));
    }
    flush();
    return { lines, groups, size };
  };

  let layout = lay(LEVELS[0]);
  let note = "";
  let cost = layout.size;
  for (let level = 1; cost > maxChars && level < LEVELS.length; level += 1) {
    layout = lay(LEVELS[level]);
    note = condensedNote(around, layout.groups.length > 0);
    cost = layout.size;
  }

  // What the budget has left lists the titles of the blocks, the nearest to the focus first, up to the first that does not fit.
  let room = maxChars - cost;
  for (const group of [...layout.groups].sort((left, right) => (left.nearest === right.nearest ? 0 : left.nearest - right.nearest) || left.line - right.line)) {
    const titles = format.collapse(group.members.map((index) => items[index]), true);
    const extra = titles.length - layout.lines[group.line].length;
    if (extra > room) break;
    layout.lines[group.line] = titles;
    room -= extra;
  }
  return { text: layout.lines.join("\n"), note };
}

function blockStatus(chapters: PlannedChapter[]): string {
  if (chapters.every((chapter) => chapter.imported)) return "already written by the author";
  const done = chapters.filter((chapter) => chapter.status === "done").length;
  if (done === chapters.length) return "all approved";
  return done === 0 ? "planned" : `${done} of ${chapters.length} approved`;
}

function collapseChapters(chapters: PlannedChapter[], titles: boolean): string {
  const range = `Chapters ${chapters[0].number}-${chapters[chapters.length - 1].number}`;
  return titles ? `${range}: ${chapters.map((chapter) => chapter.title).join("; ")}` : `${range} (${blockStatus(chapters)})`;
}

function outlineFormat(scenes: boolean): ChapterFormat<PlannedChapter> {
  return {
    render(chapter, detail) {
      const lines = [`${chapter.number}. ${chapter.title}${chapter.imported ? " (already written by the author)" : ""}${chapter.status === "done" ? " [done]" : ""}`];
      if (detail !== "title" && chapter.summary) lines.push(`   ${chapter.summary}`);
      if (detail === "full") {
        if (chapter.reveals.length) lines.push(`   Reveals: ${chapter.reveals.join("; ")}`);
        if (scenes) for (const scene of chapter.scenes) lines.push(`   - Scene ${scene.number}: ${scene.title}${scene.summary ? ` — ${scene.summary}` : scene.goal ? ` — ${scene.goal}` : ""}`);
      }
      return lines.join("\n");
    },
    collapse: collapseChapters,
  };
}

const LINE_FORMAT: ChapterFormat<PlannedChapter> = {
  render: (chapter, detail) => `${chapter.number}. ${chapter.title}${detail !== "title" && chapter.summary ? ` — ${chapter.summary}` : ""}`,
  collapse: collapseChapters,
};

/** Every chapter of the plan, in full. The outline of a small plan, see `outline` for any size. */
export function planOutline(plan: AutopilotPlan | null, options: { scenes?: boolean; upTo?: number } = {}): string {
  if (!plan?.chapters.length) return "No plan yet.";
  const format = outlineFormat(options.scenes === true);
  return plan.chapters
    .filter((chapter) => options.upTo === undefined || chapter.number <= options.upTo)
    .map((chapter) => format.render(chapter, "full"))
    .join("\n");
}

/**
 * The plan as an outline that never outgrows a prompt: identical to `planOutline` while it fits the budget, then
 * condensed around `options.around` (see `windowChapters`).
 */
export function outline(plan: AutopilotPlan | null, options: OutlineOptions = {}): string {
  return outlineList(plan, options).text;
}

/** `outline`, with the note that says how it was condensed. */
export function outlineList(plan: AutopilotPlan | null, options: OutlineOptions = {}): WindowedList {
  if (!plan?.chapters.length) return { text: "No plan yet.", note: "" };
  return layoutChapters(plan.chapters, outlineFormat(options.scenes === true), options);
}

/** One line per chapter (number, title, summary) with the same budget rules: the chapters before one, or the ones already written. */
export function chapterList(chapters: readonly PlannedChapter[], options: WindowOptions = {}): string {
  return chapterLines(chapters, options).text;
}

/** `chapterList`, with the note that says how it was condensed. */
export function chapterLines(chapters: readonly PlannedChapter[], options: WindowOptions = {}): WindowedList {
  return layoutChapters(chapters, LINE_FORMAT, options);
}
