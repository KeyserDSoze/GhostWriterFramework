import type { AutopilotOptions } from "./types.js";

/** The books the interface offers first. Their names and descriptions are the interface's: the engine knows only the numbers. */
export type AutopilotPresetId = "story" | "novella" | "novel-draft";

/**
 * The starting point of a NEW book: how many chapter entries the outline starts with, the words of a scene, and the review the
 * book starts with. It is not an autopilot setting: once the book exists, its outline and its brief say the rest.
 */
export interface AutopilotPresetSkeleton {
  readonly id: AutopilotPresetId;
  /** The chapter entries to create in the outline (`outline/chapters/<NNN>.md`, with no text yet). */
  readonly chapters: number;
  readonly wordsPerScene: number;
  readonly options: Readonly<Pick<AutopilotOptions, "readers" | "maxReaders" | "readersOnPlan" | "specialists">>;
  /** The most rounds of review a chapter gets (`maxReviewRounds` of the director's profile, from 1 to 3). */
  readonly maxReviewRounds: 1 | 2 | 3;
}

function freeze<T extends object>(value: T): Readonly<T> {
  for (const inner of Object.values(value)) if (inner && typeof inner === "object") freeze(inner);
  return Object.freeze(value);
}

/**
 * The three starting points, from the shortest book to the longest. The chapters are the entries a new book's outline is created with;
 * the scenes of each chapter are the planner's (`scenesForChapter`), and `wordsPerScene` is the target of every one of them.
 *  - `story`: four chapters, about 7 000 words, three readers, none on the plan.
 *  - `novella`: twelve chapters, about 50 000 words: what a new book starts with.
 *  - `novel-draft`: twenty-four chapters, about 108 000 words, with one round of review so that the cost of a long book stays within reach.
 */
export const AUTOPILOT_PRESETS: readonly AutopilotPresetSkeleton[] = freeze([
  { id: "story", chapters: 4, wordsPerScene: 900, options: { readers: true, maxReaders: 3, readersOnPlan: false, specialists: true }, maxReviewRounds: 2 },
  { id: "novella", chapters: 12, wordsPerScene: 1400, options: { readers: true, maxReaders: 5, readersOnPlan: true, specialists: true }, maxReviewRounds: 2 },
  { id: "novel-draft", chapters: 24, wordsPerScene: 1500, options: { readers: true, maxReaders: 3, readersOnPlan: true, specialists: true }, maxReviewRounds: 1 },
] satisfies AutopilotPresetSkeleton[]);

export const AUTOPILOT_PRESET_IDS: readonly AutopilotPresetId[] = freeze(AUTOPILOT_PRESETS.map((preset) => preset.id));

/** The skeleton of a starting point, by its id; `undefined` for any other value. The site uses it only when it creates a new book. */
export function autopilotPresetSkeleton(id: unknown): AutopilotPresetSkeleton | undefined {
  return AUTOPILOT_PRESETS.find((preset) => preset.id === id);
}
