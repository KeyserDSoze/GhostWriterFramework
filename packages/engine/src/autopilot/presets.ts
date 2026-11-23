import { asNumber, asRecord } from "../util/json.js";
import { normalizeBrief, normalizeOptions } from "./state.js";
import type { AutopilotBrief, AutopilotOptions } from "./types.js";

/** The books the interface offers first. Their names and descriptions are the interface's: the engine knows only the numbers. */
export type AutopilotPresetId = "story" | "novella" | "novel-draft";

/** The values of a preset: the three of the brief and the four options that change what a run costs, and the rounds of the review the director allows. */
export interface AutopilotPreset {
  readonly id: AutopilotPresetId;
  readonly brief: Readonly<Pick<AutopilotBrief, "targetChapters" | "scenesPerChapter" | "wordsPerScene">>;
  readonly options: Readonly<Pick<AutopilotOptions, "readers" | "maxReaders" | "readersOnPlan" | "specialists">>;
  /** The most rounds of review a chapter gets (`maxReviewRounds` of the director's profile, from 1 to 3): it changes the cost, and it is not an option of the autopilot. */
  readonly maxReviewRounds: 1 | 2 | 3;
}

function freeze<T extends object>(value: T): Readonly<T> {
  for (const inner of Object.values(value)) if (inner && typeof inner === "object") freeze(inner);
  return Object.freeze(value);
}

/**
 * The three starting points, from the shortest book to the longest. Every number is one the engine takes as it is (`normalizeBrief`,
 * `normalizeOptions`), and none is a book of three hundred chapters:
 *  - `story`: four short chapters, about 7 000 words, three readers, none on the plan.
 *  - `novella`: twelve chapters of three scenes, about 50 000 words: what a new book starts with (`DEFAULT_BRIEF`, `DEFAULT_OPTIONS`).
 *  - `novel-draft`: twenty-four chapters, about 108 000 words, with one round of review so that the cost of a long book stays within reach.
 */
export const AUTOPILOT_PRESETS: readonly AutopilotPreset[] = freeze([
  { id: "story", brief: { targetChapters: 4, scenesPerChapter: 2, wordsPerScene: 900 }, options: { readers: true, maxReaders: 3, readersOnPlan: false, specialists: true }, maxReviewRounds: 2 },
  { id: "novella", brief: { targetChapters: 12, scenesPerChapter: 3, wordsPerScene: 1400 }, options: { readers: true, maxReaders: 5, readersOnPlan: true, specialists: true }, maxReviewRounds: 2 },
  { id: "novel-draft", brief: { targetChapters: 24, scenesPerChapter: 3, wordsPerScene: 1500 }, options: { readers: true, maxReaders: 3, readersOnPlan: true, specialists: true }, maxReviewRounds: 1 },
] satisfies AutopilotPreset[]);

export const AUTOPILOT_PRESET_IDS: readonly AutopilotPresetId[] = freeze(AUTOPILOT_PRESETS.map((preset) => preset.id));

/** The preset with this id; `undefined` for any other value. */
export function autopilotPreset(id: unknown): AutopilotPreset | undefined {
  return AUTOPILOT_PRESETS.find((preset) => preset.id === id);
}

/** The rounds as the director's profile takes them: a whole number from 1 to 3; `undefined` for a value that is not a number. */
function roundsOf(value: unknown): number | undefined {
  const rounds = asNumber(value, Number.NaN);
  return Number.isNaN(rounds) ? undefined : Math.min(3, Math.max(1, Math.round(rounds)));
}

/**
 * The preset a form matches, or `null` for one that matches none: what the interface calls "custom".
 *
 * The values are compared as the engine takes them (`normalizeBrief`, `normalizeOptions`): what is missing is the default, text that is a number is that
 * number, one past the limits is the limit. Only the values that change what a run costs are compared (the three of the brief, the four options and
 * the rounds): the pauses, the budgets, the outline, the idea and the genre change no preset. The rounds are compared only when they are given: they are
 * not a field of the brief or of the options but of the director's profile, which a form may not have at hand.
 */
export function matchAutopilotPreset(values?: { brief?: unknown; options?: unknown; maxReviewRounds?: unknown } | null): AutopilotPresetId | null {
  const source = asRecord(values);
  const brief = normalizeBrief(source.brief);
  const options = normalizeOptions(source.options);
  const rounds = roundsOf(source.maxReviewRounds);
  const found = AUTOPILOT_PRESETS.find((preset) => preset.brief.targetChapters === brief.targetChapters
    && preset.brief.scenesPerChapter === brief.scenesPerChapter
    && preset.brief.wordsPerScene === brief.wordsPerScene
    && preset.options.readers === options.readers
    && preset.options.maxReaders === options.maxReaders
    && preset.options.readersOnPlan === options.readersOnPlan
    && preset.options.specialists === options.specialists
    && (rounds === undefined || rounds === preset.maxReviewRounds));
  return found?.id ?? null;
}
