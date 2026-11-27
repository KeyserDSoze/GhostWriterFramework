import { chapterReading, chapterStanding, chapterVote, countingAverage, type ChapterRound, type PlannedChapter, type ReaderTargets } from "narrarium-engine";

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
  /** The average of the readers' votes the last time they read the chapter (the first draft, or after its corrections: `readersReading` says which); `null` when the plan has none. */
  readers: number | null;
  /** When they read it last: the round of its review (an engine before 0.1.25 did not say), whether it was after the last corrections, and how (`end`: at the end of the review; `check`: only for their vote). */
  readersReading?: { round?: number; current: boolean; reading?: ChapterRound["reading"]; votes?: Readonly<Record<string, number>> };
  roundCount: number;
  /**
   * What each round decided, in the order of the votes: `approve` closed the chapter, `revise` sent it back. Only there when the plan says it for at least one round (an engine that
   * records the verdict wrote it); `null` for a round that has none, and for a word that is not one of the two.
   */
  verdicts?: Array<"approve" | "revise" | null>;
}

const vote = (value: unknown): number | null => (typeof value === "number" && Number.isFinite(value) ? value : null);
const verdictOf = (value: unknown): "approve" | "revise" | null => (value === "approve" || value === "revise" ? value : null);

/** A round with only the votes that are numbers (a plan is read as it was saved: a vote that is not one is not shown). */
function cleanRound(round: ChapterRound | undefined): ChapterRound {
  const source = round ?? {};
  const readers = vote(source.readers);
  const votes = source.readerVotes ? Object.fromEntries(Object.entries(source.readerVotes).filter(([, entry]) => vote(entry) !== null)) : undefined;
  const { readers: _readers, readerVotes: _votes, ...rest } = source;
  return { ...rest, ...(readers !== null ? { readers } : {}), ...(votes && Object.keys(votes).length ? { readerVotes: votes } : {}) };
}

/**
 * The chapters the director scored, in the order of the plan. A round that is a reading of the readers on their own (`ChapterRound.reading`) is not a round of review: it has no
 * vote of the director, and it is not one of the rounds counted or listed. `excluded` are the readers that do not count (`ReviewPolicy.readersExcluded`): the average of a reading
 * whose votes are known is made of the others.
 */
export function chapterScores(chapters: readonly Pick<PlannedChapter, "number" | "slug" | "score" | "rounds">[], excluded: ReadonlySet<string> = new Set()): ChapterScore[] {
  const scores: ChapterScore[] = [];
  for (const chapter of chapters) {
    const all = (chapter.rounds ?? []).map(cleanRound);
    const reviewRounds = all.filter((round) => !round.reading);
    const rounds = reviewRounds.map((round) => vote(round?.director));
    const lastRound = [...rounds].reverse().find((value) => value !== null) ?? null;
    const final = vote(chapter.score) ?? lastRound;
    const last = chapterReading(all);
    const votes = last?.votes ? Object.fromEntries(last.votes.map((entry) => [entry.slug, entry.score])) : undefined;
    const readers = last ? (last.votes ? countingAverage(last.votes, excluded) : last.average) : null;
    if (final === null && rounds.every((value) => value === null) && readers === null) continue;
    const verdicts = reviewRounds.map((round) => verdictOf(round?.verdict));
    scores.push({
      number: chapter.number,
      slug: chapter.slug,
      final,
      rounds,
      readers,
      ...(last ? { readersReading: { ...(last.round !== undefined ? { round: last.round } : {}), current: last.current, ...(last.reading ? { reading: last.reading } : {}), ...(votes ? { votes } : {}) } } : {}),
      roundCount: rounds.length,
      ...(verdicts.some((entry) => entry !== null) ? { verdicts } : {}),
    });
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
  /** Why it is taken up: its vote is under the target (`director`: it is reviewed), or only the readers' vote asks for it (`readers`: they read it, and it is reviewed whole if a target is missed). */
  why: "director" | "readers";
  /** The average the readers gave it the last time they read it, when a review has targets for them. */
  readers?: number | null;
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
  /** The review's targets for the readers (`gateFor`), when it has them: a chapter is also taken up when their vote of its text is under one, or has to be asked of them. */
  gate?: ReaderTargets,
): ReviewCandidate[] {
  const candidates: ReviewCandidate[] = [];
  for (const chapter of chapters) {
    const rounds = (chapter.rounds ?? []).map((round) => vote(round?.director));
    const final = vote(chapter.score) ?? [...rounds].reverse().find((value) => value !== null) ?? null;
    const under = final === null || final < target;
    const standing = gate ? chapterStanding(chapter.rounds, gate) : null;
    const askedByReaders = Boolean(standing && (standing.needsReading || (standing.standing?.blockers.length ?? 0) > 0));
    if (!under && !askedByReaders) continue;
    const by = freezes.get(chapter.slug);
    const kind = changed.has(chapter.number) ? "changed" : by === "author" || (chapter.imported && by !== "autopilot") ? "author" : "review";
    candidates.push({
      number: chapter.number,
      slug: chapter.slug,
      title: chapter.title,
      vote: final,
      kind,
      why: under ? "director" : "readers",
      ...(gate ? { readers: standing?.standing?.average ?? standing?.reading?.average ?? null } : {}),
    });
  }
  return candidates.sort((left, right) => left.number - right.number);
}

// ─── The targets and where the book stands against them ──────────────────────

/** One subject of the author's targets, and where the book stands against its target. */
export interface TargetRow {
  kind: "director" | "average" | "reader";
  /** The reader, for a row of one reader. */
  slug?: string;
  /** The vote now: the director's vote of the whole book, or the average of what the readers gave the chapters. `null`: nobody gave one. */
  vote: number | null;
  /** The vote asked of it: `null` when the author asked none (the readers' average is shown all the same, and a reader that does not count has none). */
  target: number | null;
  /** How many chapters are under the target, of how many have a vote of this subject. */
  under: number;
  of: number;
  /** The reader counts in the average and in the targets (always so for the director and for the average). */
  counts: boolean;
}

export interface BookTargets {
  rows: TargetRow[];
  /** The chapters the readers gave a vote, and, of them, those whose vote is of the text before its last corrections (the first draft's, or an earlier round's): not today's. */
  read: number;
  before: number;
}

const mean = (values: readonly number[]): number | null => (values.length ? tenth(values.reduce((sum, value) => sum + value, 0) / values.length) : null);

/**
 * What the book comes to against the targets: the director's (the vote of the whole book, and the chapters under its target), the readers' average (of the last vote the readers
 * gave each chapter, with the target when there is one) and each reader that has a target or does not count (from the votes of each reader, which a policy with targets for the
 * readers records). Pure: a chapter nobody voted has no say.
 */
export function bookTargets(input: { chapters: readonly Pick<PlannedChapter, "score" | "rounds">[]; book: number | null; directorTarget: number; readers?: ReaderTargets }): BookTargets {
  const rows: TargetRow[] = [];
  const votes = input.chapters.map((chapter) => chapterVote(chapter));
  rows.push({ kind: "director", vote: input.book, target: input.directorTarget, under: votes.filter((entry) => entry === null || entry < input.directorTarget).length, of: input.chapters.length, counts: true });

  const excluded = input.readers?.excluded ?? new Set<string>();
  const readings = input.chapters.map((chapter) => chapterReading(chapter.rounds)).filter((reading): reading is NonNullable<ReturnType<typeof chapterReading>> => reading !== null);
  const averages = readings.map((reading) => (reading.votes ? countingAverage(reading.votes, excluded) : reading.average)).filter((entry): entry is number => entry !== null);
  if (readings.length) {
    const target = input.readers?.average ?? null;
    rows.push({ kind: "average", vote: mean(averages), target, under: target === null ? 0 : averages.filter((entry) => entry < target).length, of: averages.length, counts: true });
  }
  // The readers that have a target, or that do not count: their votes by chapter, from the readings that say them.
  const slugs = [...new Set([...Object.keys(input.readers?.each ?? {}), ...excluded])];
  for (const slug of slugs) {
    const own = readings.flatMap((reading) => reading.votes?.filter((entry) => entry.slug === slug).map((entry) => entry.score) ?? []);
    if (!own.length && !(input.readers?.each[slug] !== undefined && !excluded.has(slug))) continue;
    const counts = !excluded.has(slug);
    const target = counts ? input.readers?.each[slug] ?? null : null;
    rows.push({ kind: "reader", slug, vote: mean(own), target, under: target === null ? 0 : own.filter((entry) => entry < target).length, of: own.length, counts });
  }
  return { rows, read: readings.length, before: readings.filter((reading) => !reading.current).length };
}
