import { isItalian } from "../util/text.js";
import type { ReaderTargets } from "./review-policy.js";
import type { ChapterRound } from "./types.js";

/**
 * What the readers say of a chapter, compared with the targets the author set for them (`ReviewPolicy.readersTarget`, `readerTargets`, `readersExcluded`): the average of
 * the readers that count, what is under its target, and whether a vote the chapter has is still the vote of its text. Pure: the review (`planner.ts`, `tasks.ts`) and the
 * review of the book (`campaign.ts`) read the same rules from here, and a host that shows the votes reads them too.
 */

/** The vote of one reader. */
export interface ReaderVote {
  slug: string;
  score: number;
}

const tenth = (value: number): number => Math.round(value * 10) / 10;

/** The average of the votes of the readers that count, to a tenth; `null` when none does. */
export function countingAverage(votes: readonly ReaderVote[], excluded: ReadonlySet<string>): number | null {
  const counting = votes.filter((vote) => !excluded.has(vote.slug));
  return counting.length ? tenth(counting.reduce((sum, vote) => sum + vote.score, 0) / counting.length) : null;
}

/** What stands between a chapter and a target of the readers: their average, or one reader. */
export type ReaderBlocker = { subject: "average"; vote: number; target: number } | { subject: "reader"; slug: string; vote: number; target: number };

/**
 * How the votes of the readers stand against their targets: the average of those that count, what is under its target (the average first, then the readers in the order
 * they voted), and how far it all is from the targets in tenths of a vote (the sum of what each lacks): a round of corrections got closer when it is smaller.
 */
export interface ReaderStanding {
  average: number | null;
  blockers: ReaderBlocker[];
  shortfall: number;
}

/** Judge the votes of the readers by their targets. A reader that does not count has no say, whatever its vote or its target; with no vote there is nothing under a target. */
export function readerStanding(votes: readonly ReaderVote[], targets: ReaderTargets): ReaderStanding {
  const average = countingAverage(votes, targets.excluded);
  const blockers: ReaderBlocker[] = [];
  if (targets.average !== undefined && average !== null && average < targets.average) blockers.push({ subject: "average", vote: average, target: targets.average });
  for (const vote of votes) {
    const target = targets.each[vote.slug];
    const score = tenth(vote.score);
    if (target !== undefined && !targets.excluded.has(vote.slug) && score < target) blockers.push({ subject: "reader", slug: vote.slug, vote: score, target });
  }
  return { average, blockers, shortfall: blockers.reduce((sum, blocker) => sum + Math.round((blocker.target - blocker.vote) * 10), 0) };
}

/** What the readers last said of a chapter, from the rounds of its review: the entry, the votes it has, and whether they are of the text as it is now. */
export interface ChapterReading {
  /** The vote of each reader, when the round recorded them (`ChapterRound.readerVotes`); an older round has the average alone. */
  votes?: ReaderVote[];
  /** The average the round recorded: of the readers that counted when it was made; `null` when none did. */
  average: number | null;
  /** The round of the review it belongs to, when the round says it. */
  round?: number;
  reading?: ChapterRound["reading"];
  /** Nothing was corrected after they read: this is the vote of the text as it is. */
  current: boolean;
}

/**
 * The last reading of a chapter among its rounds (`null` when the readers never read it). It is the vote of the text as it is while it is the last entry and no
 * correction followed it: a reading of its own is the last thing that happened, and the round of the director that read it has no fix accepted (`accepted`); any
 * later round, or fixes after it, make it a vote of the text before.
 */
export function chapterReading(rounds: readonly ChapterRound[] | undefined): ChapterReading | null {
  if (!rounds?.length) return null;
  for (let index = rounds.length - 1; index >= 0; index -= 1) {
    const entry = rounds[index];
    if (entry?.readers === undefined && !entry?.readerVotes) continue;
    const votes = entry.readerVotes ? Object.entries(entry.readerVotes).map(([slug, score]) => ({ slug, score })) : undefined;
    return {
      ...(votes ? { votes } : {}),
      average: entry.readers ?? null,
      ...(entry.round !== undefined ? { round: entry.round } : {}),
      ...(entry.reading ? { reading: entry.reading } : {}),
      current: index === rounds.length - 1 && (entry.reading !== undefined || !((entry.accepted ?? 0) > 0)),
    };
  }
  return null;
}

/**
 * Where a chapter stands against the readers' targets: the standing, when there is a vote of the text as it is that the targets can be read from (`null` otherwise), and
 * whether the readers must read it for that (`needsReading`: they never did, what they said is of the text before the corrections, or a target is for one reader, or
 * some readers do not count, and the round only has the average of them all).
 */
export function chapterStanding(rounds: readonly ChapterRound[] | undefined, targets: ReaderTargets): { standing: ReaderStanding | null; reading: ChapterReading | null; needsReading: boolean } {
  const reading = chapterReading(rounds);
  if (!reading || !reading.current) return { standing: null, reading, needsReading: true };
  if (reading.votes) return { standing: readerStanding(reading.votes, targets), reading, needsReading: false };
  const detailed = Object.keys(targets.each).length > 0 || targets.excluded.size > 0;
  if (detailed || reading.average === null) return { standing: null, reading, needsReading: true };
  return { standing: readerStanding([{ slug: "", score: reading.average }], { ...targets, each: {}, excluded: new Set() }), reading, needsReading: false };
}

const vote = (value: number): string => `${value}/10`;

/** What stands in the way, in words: «the readers' average 6.4/10 is under 7.5/10», «Anna's 5/10 is under the 8/10 asked of her». `names` says a reader by its slug. */
export function blockerText(blocker: ReaderBlocker, language: string, names: (slug: string) => string = (slug) => slug): string {
  const italian = isItalian(language);
  if (blocker.subject === "average") {
    return italian
      ? `la media dei lettori ${vote(blocker.vote)} è sotto ${vote(blocker.target)}`
      : `the readers' average ${vote(blocker.vote)} is under ${vote(blocker.target)}`;
  }
  const name = names(blocker.slug);
  return italian
    ? `${name} dà ${vote(blocker.vote)}, sotto i ${vote(blocker.target)} chiesti a questo lettore`
    : `${name} gives ${vote(blocker.vote)}, under the ${vote(blocker.target)} asked of this reader`;
}

/** All that stands in the way in one sentence («the readers' average 6.4/10 is under 7.5/10; Anna gives 5/10, under the 8/10 asked of this reader»). */
export function blockersText(blockers: readonly ReaderBlocker[], language: string, names?: (slug: string) => string): string {
  return blockers.map((blocker) => blockerText(blocker, language, names)).join("; ");
}
