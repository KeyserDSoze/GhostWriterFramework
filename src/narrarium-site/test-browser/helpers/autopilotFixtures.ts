import type { AutopilotPlan, ChapterRound, PlannedChapter } from "narrarium-engine";

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

const round = (director: number, readers?: number, accepted = 0, rejected = 0): ChapterRound => ({ director, ...(readers !== undefined ? { readers } : {}), accepted, rejected });

/** The final score the director gave to each of the first twelve chapters, and the rounds of review that led to it (the readers read the first round only). */
export const FINAL_SCORES = [8, 7.5, 9, 6, 8.5, 7, 8, 5.5, 8.5, 7.5, 9, 7.5];
export const ROUND_RECORDS: ChapterRound[][] = [
  [round(8, 7)], [round(6, 7.2, 3, 1), round(7.5)], [round(9, 8.5)], [round(4.5, 6.5, 3, 0), round(5.5, undefined, 2, 1), round(6)], [round(8.5, 8)], [round(5.5, 7, 2, 0), round(7)],
  [round(8, 7.6)], [round(4, 5.5, 2, 1), round(5, undefined, 2, 0), round(5.5)], [round(8.5, 8)], [round(6.5, 7, 2, 1), round(7.5)], [round(9, 9)], [round(6.5, 7, 2, 1), round(7.5)],
];

/**
 * A book of `count` chapters, every one approved and every one with the words of its scenes, that the director judged: the first twelve have the scores and the
 * rounds above, the others a score of 7, 7.5 or 8 after one round. `withRounds` is false for what an engine from before the rounds were recorded wrote.
 */
export function judgedPlan(count = 12, withRounds = true): PlannedChapter[] {
  return longPlan(count, count)
    .map((entry) => ({ ...entry, scenes: entry.scenes.map((scene) => ({ ...scene, words: 700 })) }))
    .map((entry, index) => {
      const score = index < FINAL_SCORES.length ? FINAL_SCORES[index] : 7 + (index % 3) * 0.5;
      const rounds = index < ROUND_RECORDS.length ? ROUND_RECORDS[index] : [round(score, 7)];
      return { ...entry, score, ...(withRounds ? { rounds } : {}) };
    });
}
