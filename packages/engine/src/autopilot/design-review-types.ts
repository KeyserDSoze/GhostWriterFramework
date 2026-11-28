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

/** The most pitches a design is asked to propose besides the idea of the author, and the fewest (one alone is not an alternative). */
export const DESIGN_ALTERNATIVES_MIN = 2;
export const DESIGN_ALTERNATIVES_MAX = 6;

/** The limits of the texts of a pitch: a reply over them is rejected, never cut. */
export const DESIGN_PITCH_LOGLINE_CHARACTERS = 300;
export const DESIGN_PITCH_PREMISE_CHARACTERS = 900;
export const DESIGN_PITCH_FIELD_CHARACTERS = 400;

/** One of the alternative pitches the Brainstormer proposes from the idea of the author. */
export interface DesignPitch {
  /** `p1`, `p2`…, in the order proposed. */
  id: string;
  title: string;
  /** The book in one sentence. */
  logline: string;
  premise: string;
  protagonist: string;
  stakes: string;
  /** The turn of the story that the reader does not see coming. */
  twist: string;
  tone: string;
  /** What makes it a different book from the other pitches. */
  difference: string;
}

/** What one judge (a reader by its slug, or the director) said of a pitch: its mean, its twelve scores (`null`: the criterion did not apply) and a line. */
export interface DesignPitchEvaluation {
  by: string;
  name: string;
  overall: number | null;
  scores: Array<number | null>;
  note: string;
}

/**
 * The alternatives a design run proposed before it designed the book: the pitches, what the readers and the director judged of each, the pitch the director
 * recommended with its reason, and the one the design is made of and who chose it (the director, or the author when the design asks for the author's choice).
 */
export interface DesignAlternatives {
  pitches: DesignPitch[];
  /** By pitch id. */
  evaluations: Record<string, DesignPitchEvaluation[]>;
  recommended?: { id: string; reason: string };
  selected?: { id: string; by: "director" | "author"; reason: string; at: string };
}

/** What kind of trouble a finding of the coherence analysis is. */
export const COHERENCE_KINDS = ["contradiction", "plot-hole", "timeline", "character", "repetition", "subplot", "early-reveal", "knowledge", "secret", "structure", "other"] as const;
export type CoherenceKind = (typeof COHERENCE_KINDS)[number];

/** How much a finding matters: `critical` stops the design from being approved until it is fixed, `major` is what a reader will notice, `minor` a polish. */
export const COHERENCE_SEVERITIES = ["critical", "major", "minor"] as const;
export type CoherenceSeverity = (typeof COHERENCE_SEVERITIES)[number];

/** What became of a finding: `open`; `fixing` (the author asked the autopilot to fix it); `fixed` (a later analysis no longer finds it); `dismissed` (it is not a problem: the director or the author said so); `mine` (the author will handle it). */
export const COHERENCE_STATUSES = ["open", "fixing", "fixed", "dismissed", "mine"] as const;
export type CoherenceStatus = (typeof COHERENCE_STATUSES)[number];

/**
 * One thing the analysis of the whole structure of the design found wrong: by a check that needs no model (`check`: a secret revealed before its clues, an entry with no
 * goal) or by the model that read all the chapters together (`ai`). It says where it is, which chapters must be revised to fix it, and what to do.
 */
export interface CoherenceFinding {
  /** The same for the same finding, whichever analysis finds it: what a decision about it is kept by. */
  id: string;
  source: "check" | "ai";
  kind: CoherenceKind;
  severity: CoherenceSeverity;
  /** The chapters it is about: where it is. None for what concerns the whole book. */
  chapters: number[];
  /** The chapters whose design must be revised to fix it. */
  requires: number[];
  text: string;
  proposal?: string;
  /** Whose entries the fix changes: the autopilot's, the author's (which the autopilot never rewrites: it proposes), or both. */
  owner: "autopilot" | "author" | "both";
  status: CoherenceStatus;
  /** Who dismissed it, or took it, and why. */
  decision?: { by: "author" | "director"; reason?: string; at: string };
  /** The review that found it, and the last that still did. */
  round: number;
  seen: number;
}

/** What the analysis of the structure of the design found, and what it was made of (`coherenceSignature`): the analysis is made again when the design changed. */
export interface DesignCoherence {
  sig: string;
  round: number;
  at: string;
  findings: CoherenceFinding[];
  /** What the analysis thinks of the structure as a whole, a few sentences. */
  summary: string;
}

/** The limits of the texts of a finding, and of the findings: a reply over them is rejected, never cut. */
export const COHERENCE_TEXT_CHARACTERS = 500;
export const COHERENCE_PROPOSAL_CHARACTERS = 350;
export const COHERENCE_FINDINGS_PER_CALL = 25;
/** The findings a design keeps, and the chapters one call of the analysis reads (the next window begins `COHERENCE_OVERLAP` chapters before the end of this one). */
export const COHERENCE_FINDINGS_KEPT = 80;
export const COHERENCE_WINDOW = 40;
export const COHERENCE_OVERLAP = 6;

/** The score under which a criterion is a weak point of what is judged: it is told, and a rewrite starts from it. */
export const DESIGN_WEAK_SCORE = 7;

/** The most subjects a design keeps a rubric for (the design, its readers and its pitches, and a design of the most chapters a run takes), and the reviews it keeps of each. */
export const DESIGN_RUBRIC_SUBJECTS_MAX = 600;
export const DESIGN_RUBRIC_HISTORY_MAX = 12;

/** The limits of the text of a criterion: a reply over them is rejected, never cut. */
export const DESIGN_REASON_CHARACTERS = 500;
export const DESIGN_ITEM_CHARACTERS = 350;
export const DESIGN_ITEMS_MAX = 5;
