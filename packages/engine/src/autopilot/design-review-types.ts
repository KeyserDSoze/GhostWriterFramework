/**
 * What the reviews of a design keep in the state of the autopilot (`AutopilotDesign`): the rubric of the twelve criteria of every subject that was judged, with how
 * its scores changed round after round. The types and the limits only: `design-rubric.ts` decides, `design-state.ts` reads them back from a file.
 */

/** The twelve criteria a design is judged by, in the order they are told. */
export const DESIGN_CRITERIA = [
  "originality",
  "engagement",
  "coherence",
  "pace",
  "tension",
  "characters",
  "emotion",
  "dialogue",
  "twists",
  "credibility",
  "subplots",
  "ending",
] as const;

export type DesignCriterion = (typeof DESIGN_CRITERIA)[number];

/** One criterion as one judge scored it. */
export interface DesignCriterionScore {
  criterion: DesignCriterion;
  /** From 1 to 10, one decimal; `null` when the criterion does not apply to what is judged (a chapter with no twist cannot be judged on its twists). */
  score: number | null;
  /** Why this score, in a sentence or two. */
  reason: string;
  /** What is wrong, one thing each. */
  issues: string[];
  /** What the judge would do instead, one thing each. */
  proposals: string[];
}

/** The scores of a subject in one review, the twelve in the order of `DESIGN_CRITERIA` (`null`: the criterion did not apply), and their mean. */
export interface DesignRubricRound {
  round: number;
  overall: number | null;
  scores: Array<number | null>;
  at: string;
}

/**
 * What the design keeps of a subject (the design as a whole, a reader, a chapter, a pitch): its latest scoring and the scores of every review before it. A chapter keeps
 * the whole text of the criteria that fell short only (`weakScoreBelow`): the others are in its row of scores.
 */
export interface DesignRubricSubject {
  latest: DesignCriterionScore[];
  history: DesignRubricRound[];
}

/** The subjects that were judged, by key: `design` (the director's), `reader:<slug>`, `chapter:<number>`, `pitch:<id>`. */
export type DesignRubrics = Record<string, DesignRubricSubject>;

/** What the design keeps of the review of a chapter: what it was made of (so that only the chapters that changed are reviewed again) and what it said. */
export interface DesignChapterReview {
  /** The fingerprint of the entry of the chapter and of the entries beside it when it was reviewed (`chapterReviewSignature`). */
  sig: string;
  round: number;
  at: string;
  /** The mean of its criteria that apply; `null` when there was nothing to judge (an entry with no text). */
  overall: number | null;
  verdict: "ok" | "revise";
  summary: string;
}

/** The chapters one call of the review of the chapters judges, each with the chapters beside it. */
export const DESIGN_REVIEW_BATCH_CHAPTERS = 4;
/** The most characters of what a review says of a chapter, as of the rest of its texts: more is rejected, never cut. */
export const DESIGN_SUMMARY_CHARACTERS = 400;

/** The score under which a criterion is a weak point of what is judged: it is told, and a rewrite starts from it. */
export const DESIGN_WEAK_SCORE = 7;

/** The most subjects a design keeps a rubric for (the design, its readers and its pitches, and a design of the most chapters a run takes), and the reviews it keeps of each. */
export const DESIGN_RUBRIC_SUBJECTS_MAX = 600;
export const DESIGN_RUBRIC_HISTORY_MAX = 12;

/** The limits of the text of a criterion: a reply over them is rejected, never cut. */
export const DESIGN_REASON_CHARACTERS = 500;
export const DESIGN_ITEM_CHARACTERS = 350;
export const DESIGN_ITEMS_MAX = 5;
