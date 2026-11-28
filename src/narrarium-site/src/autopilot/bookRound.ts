import type { AutopilotState, AutopilotStateSummary, BookCorrection, BookCorrectionWhy, BookCorrectionsDecision, BookRound, BookRoundRecord, BookRoundStatus, ReviewCampaign } from "narrarium-engine";

/**
 * The corrections of the whole book that the director asks for in the book-level round of a review (#113), as the page shows them: read from the state the engine saved (the round
 * in progress in `campaign.review.book`, the rounds over in the history of the review and in the record of the reviews that ended) and nothing it did not say. Pure.
 */

/** One correction: its number in the list (the one a decision names, from 1), the chapter with its title and folder, the words, the points of the judgement it answers, and where it stands. */
export interface CorrectionRow {
  number: number;
  chapter: number;
  title?: string;
  slug?: string;
  change: string;
  reason: string;
  /** The points of the director's judgement of the book that the correction cites, in its words. */
  answers: string[];
  /** The chapter is the author's: the correction is carried out only if the author chooses it. */
  held: boolean;
  status: BookCorrection["status"];
  why?: BookCorrectionWhy;
}

/** A round of the book: the vote the director gave the book that the round answers, its words, and the corrections with where each stands. */
export interface BookRoundView {
  round: number;
  score: number | null;
  summary?: string;
  rows: CorrectionRow[];
}

/** A round in progress: where it is, and what the author is asked. */
export interface BookRoundProgress extends BookRoundView {
  status: BookRoundStatus;
  /** The vote the book must reach. */
  target: number;
  /** The director's judgement of the book that the corrections answer, in points. */
  points: string[];
  /** A plateau made this round: the director reads what the plateau breakers found. */
  taken: boolean;
  chapters: number;
  applied: number;
}

type PlanOf = Pick<AutopilotState, "plan">;

/** The chapters of the plan by number: what a row says of its chapter. */
function chaptersOf(state: PlanOf): Map<number, { title?: string; slug?: string }> {
  return new Map((state.plan?.chapters ?? []).map((chapter) => [chapter.number, { title: chapter.title || undefined, slug: chapter.slug || undefined }] as const));
}

function rowsOf(corrections: readonly BookCorrection[], points: readonly string[], chapters: ReadonlyMap<number, { title?: string; slug?: string }>): CorrectionRow[] {
  return corrections.map((correction, index) => ({
    number: index + 1,
    chapter: correction.chapter,
    ...(chapters.get(correction.chapter)?.title ? { title: chapters.get(correction.chapter)?.title } : {}),
    ...(chapters.get(correction.chapter)?.slug ? { slug: chapters.get(correction.chapter)?.slug } : {}),
    change: correction.change,
    reason: correction.reason,
    answers: correction.cites.map((cite) => points[cite - 1]).filter((point): point is string => Boolean(point)),
    held: correction.held === "author",
    status: correction.status,
    ...(correction.why ? { why: correction.why } : {}),
  }));
}

/** The review of the book in progress, when it is in a book-level round (or has one in the corrections being carried out). */
function reviewOf(state: Pick<AutopilotState, "campaign">): (ReviewCampaign & { book: BookRound }) | null {
  const campaign = state.campaign;
  const review = campaign?.reason === "review-target" ? campaign.review : undefined;
  return review?.book ? (review as ReviewCampaign & { book: BookRound }) : null;
}

/** The book-level round in progress, with its corrections: `null` when no review is in one. */
export function bookRoundOf(state: Pick<AutopilotState, "campaign" | "plan">): BookRoundProgress | null {
  const review = reviewOf(state);
  if (!review) return null;
  const round = review.book;
  const rows = rowsOf(round.corrections, round.verdict.points, chaptersOf(state));
  return {
    round: round.round,
    score: round.verdict.score,
    ...(round.summary ? { summary: round.summary } : {}),
    rows,
    status: round.status,
    target: review.targetScore,
    points: round.verdict.points,
    taken: Boolean(round.plateau),
    chapters: new Set(rows.map((row) => row.chapter)).size,
    applied: rows.filter((row) => row.status === "applied").length,
  };
}

/** The corrections that wait for the author's decision: the round in progress, when it stopped for them. */
export function proposalOf(state: Pick<AutopilotState, "campaign" | "plan">): BookRoundProgress | null {
  const round = bookRoundOf(state);
  return round?.status === "proposed" && round.rows.length > 0 ? round : null;
}

function viewOf(round: number, record: BookRoundRecord, chapters: ReadonlyMap<number, { title?: string; slug?: string }>): BookRoundView {
  return { round, score: record.score, ...(record.summary ? { summary: record.summary } : {}), rows: rowsOf(record.corrections, record.points, chapters) };
}

/**
 * What the director asked of the book in the last review of the book that ended (`reviews`): its book-level rounds, oldest first, each with the corrections and what became of
 * them. Nothing for a review that had none, or a book that was never reviewed again.
 */
export function lastBookRounds(state: Pick<AutopilotState, "reviews" | "plan">): BookRoundView[] {
  const last = state.reviews?.[state.reviews.length - 1];
  const chapters = chaptersOf(state);
  return (last?.bookRounds ?? []).map((record) => viewOf(record.round, record, chapters));
}

/**
 * The rounds of the review in progress that asked the book for corrections and are over (the history of the review): what the corrections were and what became of them, oldest first.
 * The round in progress is `bookRoundOf`.
 */
export function overBookRounds(state: Pick<AutopilotState, "campaign" | "plan">): BookRoundView[] {
  const campaign = state.campaign;
  const review = campaign?.reason === "review-target" ? campaign.review : undefined;
  const chapters = chaptersOf(state);
  return (review?.history ?? []).flatMap((entry) => (entry.bookRound ? [viewOf(entry.round, entry.bookRound, chapters)] : []));
}

/** The decision the author's choice makes: the corrections ticked are carried out, with nothing ticked the round is declined. */
export function decisionOf(round: Pick<BookRoundProgress, "round">, chosen: ReadonlySet<number>): BookCorrectionsDecision {
  return chosen.size > 0
    ? { round: round.round, action: "apply", chosen: [...chosen].sort((left, right) => left - right) }
    : { round: round.round, action: "decline" };
}

/** The corrections that are carried out when the author does not choose one by one: every one that does not ask a change of a chapter of the author's (the engine's rule). */
export function defaultChosen(rows: readonly CorrectionRow[]): Set<number> {
  return new Set(rows.filter((row) => row.status === "waiting" && !row.held).map((row) => row.number));
}

/** The vote the book got and the target it is under: `null` when the book was not judged or is at the target. */
export function bookUnderTarget(score: number | null | undefined, target: number): { score: number; target: number } | null {
  return typeof score === "number" && Number.isFinite(score) && score < target ? { score, target } : null;
}

/** Where a book-level round stands in a summary of the state (the band reads it): `null` when the review is not in one. */
export function bookRoundSummary(campaign: AutopilotStateSummary["campaign"]): { status: BookRoundStatus; corrections: number; applied: number } | null {
  return campaign?.review?.bookRound ?? null;
}
