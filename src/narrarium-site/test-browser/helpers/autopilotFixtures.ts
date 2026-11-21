import type { AutopilotPlan, PlannedChapter } from "narrarium-engine";

export type ChapterStatus = PlannedChapter["status"];

export const pad = (number: number) => String(number).padStart(3, "0");

export const scene = (number: number, status: string, words?: number) => ({ number, title: `Scene ${number}`, goal: "Goal", beats: [], characters: [], status, words, revisions: 0, summary: number === 1 ? "What happens" : undefined });

export const chapter = (number: number, status: ChapterStatus, extra: Record<string, unknown> = {}) => ({ number, title: `Chapter title ${number}`, slug: `${pad(number)}-chapter-${number}`, summary: "", goal: "", pov: [], keyEvents: [], reveals: [], status, scenes: [], ...extra }) as unknown as PlannedChapter;

/** `count` chapters: the first `done` approved, then one being written, the others only planned (`override` changes some). */
export function longPlan(count: number, done: number, override: (number: number) => ChapterStatus | undefined = () => undefined): PlannedChapter[] {
  return Array.from({ length: count }, (_, index) => {
    const number = index + 1;
    const status = override(number) ?? (number <= done ? "done" : number === done + 1 ? "writing" : "planned");
    return chapter(number, status, {
      title: `Title ${number}`,
      summary: `Summary ${number}`,
      scenes: [1, 2].map((offset) => ({ ...scene(offset, status === "done" ? "reviewed" : "planned"), title: `Scene ${number}.${offset}` })),
    });
  });
}

export const planOf = (chapters: PlannedChapter[]): AutopilotPlan => ({ chapters, approved: true, rounds: 0, revisionNotes: [], readerReactions: [], readersDone: true, awaitingAuthor: false });

/** The same chapters, but every read of a title is counted: a chapter row reads its title each time it is drawn. */
export function countTitleReads(chapters: PlannedChapter[], reads: Map<number, number>): PlannedChapter[] {
  for (const entry of chapters) {
    const title = entry.title;
    Object.defineProperty(entry, "title", { enumerable: true, configurable: true, get: () => { reads.set(entry.number, (reads.get(entry.number) ?? 0) + 1); return title; } });
  }
  return chapters;
}
