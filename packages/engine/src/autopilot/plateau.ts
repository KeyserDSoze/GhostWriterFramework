import type { AiRequest, AiResponse } from "../ai/types.js";
import type { BookSnapshot } from "../book/snapshot.js";
import type { BookStore } from "../book/store.js";
import { BOOK_MATERIAL_CHARACTERS, type AutopilotState, type InsightTone, type ReviewRoundRecord, type ReviewVotes } from "./types.js";
import { clipText } from "../util/text.js";

/**
 * The extension point of a plateau: where a review of the book that stopped getting better can be taken on by something else instead of ending.
 *
 * A review of the book (`reason: "review-target"`) stops at a plateau: two rounds in a row raised neither the lowest vote of a chapter, nor the vote of the book, nor, with
 * targets for the readers, how close the chapters are to them. When the review has a book-level round (`ReviewPolicy.bookRound` is `apply` or `ask`), the stall calls the
 * plateau breakers that were registered, before it ends the review: a breaker is a function that looks at the plateau and answers either `stop` (the review ends, as it would
 * without it) or `continue` with `material`: the words of whatever it found (ideas, findings) that the director reads together with the request for the corrections of the
 * whole book. The round then goes on as a book-level round does: the director lists the corrections with that material in front of it (and, when the review asks for it, the
 * author decides on them), they are carried out in the chapters, the touched chapters are reviewed again, and the book is judged again. Nothing the breaker says is applied
 * by itself: it feeds the corrections, and the corrections are the director's.
 *
 * A breaker runs inside the step that asks for the corrections (`book-corrections`), so it may call the model through `context.ai` (the call counts as the step's own, with its
 * route, its cost and its record) and read the book through `context.store` and `context.snapshot`, which it must never write. It is asked at most `PLATEAU_BREAKS_MAX` times in
 * one review, whatever it answers, and the review's caps (rounds, money) stop it as they stop anything else. A breaker that throws is skipped, said as a warning, and the next one
 * is asked; one that is slow is not waited for beyond the step's own deadlines. With no breaker registered the review ends at the plateau exactly as it always did.
 *
 * Register one with `registerPlateauBreaker` where the host starts (the web app and the personal server each do it for the features they have); it returns the function that
 * takes the breaker away.
 */

/** What a plateau tells a breaker: the review, how it stands, and what the rounds did. Plain data: nothing in it changes the review. */
export interface ReviewPlateau {
  /** The review (campaign) and the round whose end made the plateau. */
  campaignId: string;
  round: number;
  /** The vote every chapter and the book must reach. */
  target: number;
  /** The votes now: the lowest chapter, the book, the chapters under a target and, with readers' targets, the lowest average of the readers. */
  votes: ReviewVotes;
  /** The rounds over, oldest first. */
  history: readonly ReviewRoundRecord[];
  /** `book` when every chapter has its targets and only the book's vote is under the target, `chapters` when chapters are still under theirs. */
  kind: "chapters" | "book";
  /** How many times a breaker already took this review on (at most `PLATEAU_BREAKS_MAX`). */
  broken: number;
  /** The language of the book. */
  language: string;
}

/** What a breaker answers: end the review, or go on with a book-level round that has its `material`. */
export type ReviewPlateauAnswer = { action: "stop" } | { action: "continue"; material: string };

/** What a breaker may use: the state as it is (read only), the book (read only), the model through the step's own client, and a way to say what it did. */
export interface ReviewPlateauContext {
  bookId: string;
  state: Readonly<AutopilotState>;
  store: BookStore;
  snapshot: BookSnapshot;
  signal: AbortSignal;
  ai: (request: Omit<AiRequest, "signal">) => Promise<AiResponse>;
  insight: (tone: InsightTone, title: string, detail?: string) => void;
}

/** A plateau breaker. It may be asynchronous. */
export type ReviewPlateauBreaker = (plateau: ReviewPlateau, context: ReviewPlateauContext) => ReviewPlateauAnswer | Promise<ReviewPlateauAnswer>;

const breakers: ReviewPlateauBreaker[] = [];

/** Register a plateau breaker (asked in the order they were registered). Answers the function that takes it away. */
export function registerPlateauBreaker(breaker: ReviewPlateauBreaker): () => void {
  breakers.push(breaker);
  return () => {
    const index = breakers.indexOf(breaker);
    if (index >= 0) breakers.splice(index, 1);
  };
}

/** The plateau breakers registered now. */
export function plateauBreakers(): readonly ReviewPlateauBreaker[] {
  return breakers;
}

/**
 * Ask the breakers, in order, about a plateau: the first that continues with some material wins (its material cut to `BOOK_MATERIAL_CHARACTERS`); with none, or when every one stops
 * or fails, the answer is `stop`. A breaker that throws is said as a warning and left out; an aborted step is not swallowed.
 */
export async function consultPlateauBreakers(plateau: ReviewPlateau, context: ReviewPlateauContext): Promise<ReviewPlateauAnswer> {
  for (const breaker of [...breakers]) {
    try {
      const answer = await breaker(plateau, context);
      if (answer && answer.action === "continue") {
        const material = clipText(String(answer.material ?? "").trim(), BOOK_MATERIAL_CHARACTERS);
        if (material) return { action: "continue", material };
      }
    } catch (error) {
      if (context.signal.aborted) throw error;
      context.insight("warning", `A plateau breaker failed and was left out: ${error instanceof Error ? error.message : String(error)}`);
    }
  }
  return { action: "stop" };
}
