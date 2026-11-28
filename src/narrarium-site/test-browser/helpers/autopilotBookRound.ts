import type { AutopilotState, BookCorrection, BookRound, BookRoundRecord, ReviewCampaign, ReviewRecord, RevisionCampaign } from "narrarium-engine";

/** The points of the director's judgement of the book that the corrections of the fixtures cite (numbered from 1). */
export const POINTS = ["major: The ending is not earned — Plant its setup earlier", "next step: Tighten the middle chapters"];

/** One correction of the book, waiting by default: chapter 3 asks to plant the setup of the ending, citing the first point. */
export function correction(chapter: number, patch: Partial<BookCorrection> = {}): BookCorrection {
  return { chapter, change: `Plant the setup of the ending in chapter ${chapter}.`, reason: `The ending pays off a promise that chapter ${chapter} never made.`, cites: [1], status: "waiting", ...patch };
}

/** A book-level round of a review of the book: the director judged the book 7.4 under a target of 9, and asked for two corrections that wait for the author. */
export function bookRound(patch: Partial<BookRound> = {}): BookRound {
  return { round: 2, status: "proposed", verdict: { score: 7.4, points: POINTS }, corrections: [correction(3), correction(9, { cites: [1, 2], change: "Cut the detour of the second scene.", reason: "The middle drags." })], summary: "Two chapters carry the weight of the ending.", ...patch };
}

/** The votes a review begins with, and the ones it ends a round with: every chapter at the target and the book under it. */
const VOTES = { lowest: 9, book: 7.4, below: 0 };

/** The review of the book that is in a book-level round (`campaign.review.book`): in the state it is `patch.campaign`. */
export function reviewCampaign(book: BookRound | undefined, review: Partial<ReviewCampaign> = {}, campaign: Partial<RevisionCampaign> = {}): RevisionCampaign {
  return {
    id: "campaign-1",
    reason: "review-target",
    createdAt: "2026-11-21T10:00:00.000Z",
    chapters: [],
    review: {
      targetScore: 9,
      scope: [1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12],
      round: book?.round ?? 1,
      windowStart: 1,
      phase: book ? "book" : "chapters",
      start: VOTES,
      history: [],
      stalled: 0,
      ...(book ? { book } : {}),
      ...review,
    },
    ...campaign,
  };
}

/** What the director asked of the book in a round that is over, as the record of a review keeps it. */
export function roundRecord(patch: Partial<BookRoundRecord> = {}): BookRoundRecord {
  return { score: 7.4, points: POINTS, corrections: [correction(3, { status: "applied" }), correction(9, { status: "left-out", why: "declined" })], summary: "Two chapters carry the weight of the ending.", ...patch };
}

/** A review of the book that ended, with the rounds the director asked the book for corrections in. */
export function endedReview(rounds: Array<BookRoundRecord & { round: number }>, patch: Partial<ReviewRecord> = {}): ReviewRecord {
  return { targetScore: 9, rounds: rounds.length, outcome: "plateau", from: { lowest: 9, book: 7.4, below: 0 }, to: { lowest: 9, book: 7.6, below: 0 }, startedAt: "2026-11-21T10:00:00.000Z", endedAt: "2026-11-21T12:00:00.000Z", bookRounds: rounds, ...patch };
}

/** The part of a state that a book-level round is read from. */
export function stateWith(patch: Partial<AutopilotState>): Pick<AutopilotState, "campaign" | "plan" | "reviews"> {
  return patch as Pick<AutopilotState, "campaign" | "plan" | "reviews">;
}
