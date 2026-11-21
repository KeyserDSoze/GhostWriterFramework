import { isThinDocument, readDocument } from "../book/context.js";
import { AUTOPILOT_STATE_FILE, TOTAL_RESUME_FILE, formatOrdinal } from "../book/paths.js";
import type { BookStore } from "../book/store.js";
import { countWords, tail } from "../util/text.js";
import { parseAutopilotState } from "./state.js";
import type { PlannedChapter } from "./types.js";

/** Length the consolidation asks for, and the hard limit it enforces on the story so far. */
export const STORY_SO_FAR_TARGET_WORDS = 900;
export const STORY_SO_FAR_MAX_WORDS = 1200;
/** Chapters that keep the synopsis saved when they closed (the newest ones); older chapters fall back to their summaries. */
export const MAX_STORY_SNAPSHOTS = 4;

/** Keep `autopilot/state.json` small: only the newest closing synopses are kept. */
export function pruneStorySnapshots(chapters: PlannedChapter[], keep = MAX_STORY_SNAPSHOTS): void {
  chapters
    .filter((chapter) => chapter.storySoFarAtClose)
    .sort((left, right) => right.number - left.number)
    .slice(keep)
    .forEach((chapter) => {
      chapter.storySoFarAtClose = undefined;
    });
}

export interface TotalResumeSection {
  number: number;
  heading: string;
  text: string;
}

export interface TotalResume {
  /** Free text before the first chapter section (an older single-block resume, or the scaffold hint). */
  preamble: string;
  chapters: TotalResumeSection[];
  /** Top-level sections after the chapters, such as core's "# Story State Overview", kept as they are. */
  trailing: string;
}

const CHAPTER_HEADING = /^##\s+(?:Chapter|Capitolo)\s+0*(\d+)\b/i;

/** Split `resumes/total.md` into its per-chapter sections (`## Chapter 001 Title`, as Narrarium core writes them). */
export function parseTotalResume(body: string): TotalResume {
  const preamble: string[] = [];
  const trailing: string[] = [];
  const chapters: Array<{ number: number; heading: string; lines: string[] }> = [];
  let titleSeen = false;
  let inTrailing = false;
  for (const line of (body ?? "").split(/\r?\n/)) {
    if (inTrailing) {
      trailing.push(line);
      continue;
    }
    if (/^#\s/.test(line)) {
      if (chapters.length) {
        inTrailing = true;
        trailing.push(line);
        continue;
      }
      if (!titleSeen && !preamble.some((entry) => entry.trim())) {
        titleSeen = true;
        continue;
      }
    }
    const match = CHAPTER_HEADING.exec(line);
    if (match) chapters.push({ number: Number(match[1]), heading: line.trim(), lines: [] });
    else if (chapters.length) chapters[chapters.length - 1].lines.push(line);
    else preamble.push(line);
  }
  return {
    preamble: preamble.join("\n").trim(),
    chapters: chapters.map((section) => ({ number: section.number, heading: section.heading, text: section.lines.join("\n").trim() })),
    trailing: trailing.join("\n").trim(),
  };
}

function byNumber(left: { number: number }, right: { number: number }): number {
  return left.number - right.number;
}

/**
 * The total resume in core's per-chapter layout: closing a chapter replaces only its own section.
 * The other chapters keep their section, or get their summary when they have none yet.
 */
export function renderTotalResumeBody(existing: string, chapters: PlannedChapter[], closing: { number: number; title: string; summary: string }): string {
  const parsed = parseTotalResume(existing);
  const sections = new Map(parsed.chapters.map((section) => [section.number, section.text]));
  const lines = ["# Book So Far", ""];
  for (const chapter of [...chapters].sort(byNumber)) {
    const text = chapter.number === closing.number
      ? closing.summary
      : sections.get(chapter.number) || (chapter.status === "done" ? chapter.summary : "");
    if (!text) continue;
    lines.push(`## Chapter ${formatOrdinal(chapter.number)} ${chapter.number === closing.number ? closing.title : chapter.title}`, "", text, "");
  }
  if (parsed.trailing) lines.push(parsed.trailing, "");
  return lines.join("\n").trim();
}

/** Whether a chapter was ever closed: its text may already be part of an older single-block resume. */
function consolidated(chapter: PlannedChapter): boolean {
  return chapter.status === "done" || Boolean(chapter.storySoFarAtClose) || chapter.scenes.some((scene) => scene.status === "reviewed");
}

/**
 * The story before a chapter (the whole book without `chapterNumber`), built from per-chapter data:
 * the synopsis saved when the latest earlier chapter closed, followed by the summaries of the
 * chapters closed after it. Without saved synopses, the sections of `resumes/total.md` before the
 * chapter are used; a single-block resume only when no chapter from this one on was ever closed.
 */
export function storySoFarBefore(chapters: PlannedChapter[], chapterNumber: number | undefined, totalResume = ""): string {
  const ordered = [...chapters].sort(byNumber);
  const before = (number: number) => chapterNumber === undefined || number < chapterNumber;
  const done = ordered.filter((chapter) => chapter.status === "done" && before(chapter.number));
  let anchor = -1;
  for (let index = done.length - 1; index >= 0; index -= 1) {
    if (done[index].storySoFarAtClose) {
      anchor = index;
      break;
    }
  }
  const summaries = (list: PlannedChapter[]) => list.filter((chapter) => chapter.summary).map((chapter) => `${chapter.number}. ${chapter.title}: ${chapter.summary}`);
  if (anchor >= 0) {
    const later = summaries(done.slice(anchor + 1));
    return [done[anchor].storySoFarAtClose!, later.length ? later.join("\n") : ""].filter(Boolean).join("\n\n");
  }
  const resume = parseTotalResume(totalResume);
  if (resume.chapters.length) {
    const titles = new Map(ordered.map((chapter) => [chapter.number, chapter.title]));
    const sections = new Map(resume.chapters.filter((section) => before(section.number) && section.text).map((section) => [section.number, section.text]));
    for (const chapter of done) if (!sections.has(chapter.number) && chapter.summary) sections.set(chapter.number, chapter.summary);
    return [...sections.entries()].sort(([left], [right]) => left - right)
      .map(([number, text]) => `${number}. ${titles.get(number) ?? `Chapter ${number}`}: ${text}`)
      .join("\n\n");
  }
  const closedFromHere = chapterNumber !== undefined && ordered.some((chapter) => chapter.number >= chapterNumber && consolidated(chapter));
  if (!closedFromHere && resume.preamble && !isThinDocument(resume.preamble)) return resume.preamble;
  return summaries(done).join("\n");
}

/** Read the story so far for a prompt, keeping its most recent part when it is too long. */
export async function readStorySoFar(store: BookStore, input: { chapters?: PlannedChapter[]; beforeChapter?: number; max: number }): Promise<string> {
  const [resume, chapters] = await Promise.all([
    readDocument(store, TOTAL_RESUME_FILE).then((loaded) => loaded?.document.body ?? ""),
    input.chapters ? Promise.resolve(input.chapters) : store.read(AUTOPILOT_STATE_FILE).then((file) => parseAutopilotState(file?.content)?.plan?.chapters ?? []),
  ]);
  const text = storySoFarBefore(chapters, input.beforeChapter, resume).trim();
  return text ? tail(text, input.max) : "";
}

/** `null` when the story so far fits the hard limit, else how many words it is over. */
export function storySoFarExcess(text: string, maxWords = STORY_SO_FAR_MAX_WORDS): { words: number; over: number } | null {
  const words = countWords(text);
  return words > maxWords ? { words, over: words - maxWords } : null;
}
