import type { PlannedChapter } from "narrarium-engine";

/**
 * How the director judged the chapters of a finished book, worked out from the plan: the final score of each chapter and, from engine 0.1.6, the vote of each
 * round of its review. Pure; it reads the number, the slug, the score and the rounds of a chapter and nothing else (a plan has no maximum number of chapters, and
 * the title of a chapter is read only for the ones that are shown). Nothing is made up: a chapter the director has not scored has no score, and is left out.
 */

/** The rows of the table before the author asks for more, and how many the table draws at most at a time when a book has very many chapters. */
export const RESULT_ROWS = 10;
const SHORT_BOOK = 12;
const ALL_AT_ONCE = 300;
const MORE_ROWS = 100;
/** The bars of the picture: more chapters than this are put in groups. */
export const SERIES_BARS = 96;
/** A chapter that needed this many rounds of review, or more, needed many. */
const MANY_ROUNDS = 3;
const ROUND_WEIGHT = 0.5;

export interface ChapterScore {
  number: number;
  slug: string;
  /** The vote of the director when the chapter was approved; `null` when there is none. */
  final: number | null;
  /** The director's vote of each round of the review, oldest first; `null` for a round that has none. */
  rounds: Array<number | null>;
  /** The average of the readers' votes, which they give in the first round; `null` when the plan has none. */
  readers: number | null;
  roundCount: number;
  /**
   * What each round decided, in the order of the votes: `approve` closed the chapter, `revise` sent it back. Only there when the plan says it for at least one round (an engine that
   * records the verdict wrote it); `null` for a round that has none, and for a word that is not one of the two.
   */
  verdicts?: Array<"approve" | "revise" | null>;
}

const vote = (value: unknown): number | null => (typeof value === "number" && Number.isFinite(value) ? value : null);
const verdictOf = (value: unknown): "approve" | "revise" | null => (value === "approve" || value === "revise" ? value : null);

/** The chapters the director scored, in the order of the plan. */
export function chapterScores(chapters: readonly Pick<PlannedChapter, "number" | "slug" | "score" | "rounds">[]): ChapterScore[] {
  const scores: ChapterScore[] = [];
  for (const chapter of chapters) {
    const rounds = (chapter.rounds ?? []).map((round) => vote(round?.director));
    const lastRound = [...rounds].reverse().find((value) => value !== null) ?? null;
    const final = vote(chapter.score) ?? lastRound;
    const readers = (chapter.rounds ?? []).map((round) => vote(round?.readers)).find((value) => value !== null) ?? null;
    if (final === null && rounds.every((value) => value === null) && readers === null) continue;
    const verdicts = (chapter.rounds ?? []).map((round) => verdictOf(round?.verdict));
    scores.push({ number: chapter.number, slug: chapter.slug, final, rounds, readers, roundCount: rounds.length, ...(verdicts.some((entry) => entry !== null) ? { verdicts } : {}) });
  }
  return scores;
}

export interface ScoreSummary {
  /** How many chapters have a final score. */
  count: number;
  average: number;
  lowest: { number: number; score: number };
  highest: { number: number; score: number };
  /** The first and the last chapter that have a final score. */
  first: number;
  last: number;
}

const tenth = (value: number): number => Math.round(value * 10) / 10;

export function scoreSummary(scores: readonly ChapterScore[]): ScoreSummary | null {
  const scored = scores.filter((entry): entry is ChapterScore & { final: number } => entry.final !== null);
  if (!scored.length) return null;
  let lowest = scored[0];
  let highest = scored[0];
  let total = 0;
  for (const entry of scored) {
    total += entry.final;
    if (entry.final < lowest.final) lowest = entry;
    if (entry.final > highest.final) highest = entry;
  }
  return {
    count: scored.length,
    average: tenth(total / scored.length),
    lowest: { number: lowest.number, score: lowest.final },
    highest: { number: highest.number, score: highest.final },
    first: scored[0].number,
    last: scored[scored.length - 1].number,
  };
}

export type ScoreOrder = "chapter" | "lowest";

/** The chapters in the order of the book, or with the lowest score first (the ones without a final score at the end, the earlier chapter first when two scores are equal). */
export function sortScores(scores: readonly ChapterScore[], order: ScoreOrder): ChapterScore[] {
  const list = [...scores];
  if (order === "chapter") return list.sort((a, b) => a.number - b.number);
  return list.sort((a, b) => (a.final === null ? 1 : 0) - (b.final === null ? 1 : 0) || (a.final ?? 0) - (b.final ?? 0) || a.number - b.number);
}

export type ReadFirstReason = "lowest" | "below" | "rounds" | "both" | "plain";

export interface ReadFirst {
  chapter: ChapterScore;
  reason: ReadFirstReason;
  score: number;
  rounds: number;
  /** The average of the final scores of the book, to a tenth. */
  average: number;
}

/**
 * The chapters to read first: the ones that need the most attention. A chapter needs more the lower its final score is, and a little more for each round of review
 * it needed after the first. The reason says which it is: the lowest score of the book, a score under its average, many rounds (three or more), or the two together.
 */
export function readFirst(scores: readonly ChapterScore[], limit = 3): ReadFirst[] {
  const summary = scoreSummary(scores);
  if (!summary) return [];
  const ranked = scores
    .filter((entry): entry is ChapterScore & { final: number } => entry.final !== null)
    .map((entry) => ({ entry, attention: 10 - entry.final + ROUND_WEIGHT * Math.max(0, entry.roundCount - 1) }))
    .sort((a, b) => b.attention - a.attention || a.entry.number - b.entry.number)
    .slice(0, Math.max(0, limit));
  return ranked.map(({ entry }) => {
    const many = entry.roundCount >= MANY_ROUNDS;
    const lowest = entry.final === summary.lowest.score;
    const below = entry.final < summary.average;
    const reason: ReadFirstReason = lowest ? (many ? "both" : "lowest") : below ? (many ? "both" : "below") : many ? "rounds" : "plain";
    return { chapter: entry, reason, score: entry.final, rounds: entry.roundCount, average: summary.average };
  });
}

/** How many rows of the table are drawn to begin with: all of a short book, a window of a long one. */
export function initialRows(total: number): number {
  return total <= SHORT_BOOK ? total : RESULT_ROWS;
}

/** How many rows after the author asks for more: the rest when it is not a great deal, a hundred more when it is. */
export function moreRows(shown: number, total: number): number {
  return total - shown <= ALL_AT_ONCE ? total : shown + MORE_ROWS;
}

export interface SeriesBar {
  from: number;
  to: number;
  value: number;
}

/** The final scores as bars: one for each chapter that has one, or, for a book with more chapters than bars, one for each group of chapters, at the average of their scores. */
export function scoreSeries(scores: readonly ChapterScore[], bars = SERIES_BARS): SeriesBar[] {
  const scored = scores.filter((entry): entry is ChapterScore & { final: number } => entry.final !== null);
  if (!scored.length) return [];
  const size = Math.max(1, Math.ceil(scored.length / Math.max(1, bars)));
  const series: SeriesBar[] = [];
  for (let start = 0; start < scored.length; start += size) {
    const group = scored.slice(start, start + size);
    series.push({ from: group[0].number, to: group[group.length - 1].number, value: group.reduce((sum, entry) => sum + entry.final, 0) / group.length });
  }
  return series;
}

// ─── The rounds of review, and a review of the book launched later ───────────

export interface ReviewRoundsSummary {
  /** The rounds of review the chapters had, in all (the ones the plan keeps), and the most a chapter had. */
  rounds: number;
  most: number;
  /** The chapters that had at least one round. */
  chapters: number;
}

/** How many rounds of review the chapters of a finished book had («3 rounds of review»): `null` for a book whose plan keeps none. */
export function reviewRounds(scores: readonly ChapterScore[]): ReviewRoundsSummary | null {
  const reviewed = scores.filter((entry) => entry.roundCount > 0);
  if (!reviewed.length) return null;
  return { rounds: reviewed.reduce((total, entry) => total + entry.roundCount, 0), most: reviewed.reduce((most, entry) => Math.max(most, entry.roundCount), 0), chapters: reviewed.length };
}

/** The target a new review of the book starts from: one point over the one in force, 8 at least, between 5 and 10, by halves. */
export function defaultReviewTarget(current: number): number {
  const wanted = Math.max(8, current + 1);
  return Math.min(10, Math.max(5, Math.round(wanted * 2) / 2));
}

/** A chapter a review of the book would look at: its number, its title, its vote (`null`: never voted), and why it is or is not reviewed again. */
export interface ReviewCandidate {
  number: number;
  slug: string;
  title: string;
  vote: number | null;
  /** `review`: it is reviewed again; `author`: the author's (frozen by the author, or written before the autopilot), reviewed only when included; `changed`: changed since it was frozen, it waits for the decision about that change. */
  kind: "review" | "author" | "changed";
}

/**
 * The chapters under the target that a review of the book would take, in the order of the book, as the engine takes them (`createReviewCampaign`): the autopilot's are
 * reviewed again, the author's (frozen by the author, or imported and not frozen by the autopilot) only when the author includes them, and one changed since it was
 * frozen never. `freezes` has who froze each chapter, by slug; `changed` the chapters (by number) changed since they were frozen. A chapter nobody voted is under any target.
 */
export function reviewCandidates(
  chapters: readonly Pick<PlannedChapter, "number" | "slug" | "title" | "score" | "rounds" | "imported">[],
  target: number,
  freezes: ReadonlyMap<string, "author" | "autopilot">,
  changed: ReadonlySet<number>,
): ReviewCandidate[] {
  const candidates: ReviewCandidate[] = [];
  for (const chapter of chapters) {
    const rounds = (chapter.rounds ?? []).map((round) => vote(round?.director));
    const final = vote(chapter.score) ?? [...rounds].reverse().find((value) => value !== null) ?? null;
    if (final !== null && final >= target) continue;
    const by = freezes.get(chapter.slug);
    const kind = changed.has(chapter.number) ? "changed" : by === "author" || (chapter.imported && by !== "autopilot") ? "author" : "review";
    candidates.push({ number: chapter.number, slug: chapter.slug, title: chapter.title, vote: final, kind });
  }
  return candidates.sort((left, right) => left.number - right.number);
}
