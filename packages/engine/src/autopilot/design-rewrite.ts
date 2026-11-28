import { isItalian } from "../util/text.js";
import { findingNote } from "./design-coherence.js";
import type { CoherenceFinding, DesignChapterReview, DesignRubrics } from "./design-review-types.js";
import { rubricProposals } from "./design-rubric.js";
import { MAX_REVISION_NOTES } from "./state.js";

/**
 * What a round of a design rewrites besides what the director asked: the weak points the reviews found (a chapter the panel judged under par, a coherence finding that is major)
 * become instructions of the revision, and the chapters they name are the ones designed again, so that a round rewrites only what is weak. The entries of the author are never
 * rewritten: what concerns only them is a proposal for the author, told and kept. Pure.
 */

/** The notes a round adds to the director's own, at most, and the chapters of the author's it makes a proposal for, at most. */
export const DESIGN_REWRITE_NOTES_MAX = 20;
export const DESIGN_PROPOSALS_MAX = 40;

export interface DesignProposal {
  chapter: number;
  text: string;
  /** The finding it comes from, or `null` for what the review of the chapter said. */
  finding: string | null;
}

export interface RewriteSources {
  language: string;
  /** What the director's reply already put in the revision: its notes are counted against the limit of the revision. */
  existingNotes: number;
  /** The chapters the director already named: what the review of a chapter said of them is the director's to say. */
  named: ReadonlySet<number>;
  reviewed?: Record<string, DesignChapterReview>;
  rubric?: DesignRubrics;
  findings: readonly CoherenceFinding[];
  /** Whether a chapter is the autopilot's own entry (it may rewrite it); the author's is never rewritten. */
  rewritable: (chapter: number) => boolean;
}

export interface RewriteExtras {
  /** Instructions to add to the revision, the most important first. */
  notes: string[];
  /** The chapters those instructions concern: the batches that hold them are designed again. */
  chapters: number[];
  /** What concerns the author's entries only: proposals, never a rewrite. */
  proposals: DesignProposal[];
}

/** The instructions a round takes from what the reviews found weak; see the module. */
export function rewriteExtras(input: RewriteSources): RewriteExtras {
  const italian = isItalian(input.language);
  const room = Math.max(0, Math.min(DESIGN_REWRITE_NOTES_MAX, MAX_REVISION_NOTES - input.existingNotes));
  const notes: string[] = [];
  const chapters = new Set<number>();
  const proposals: DesignProposal[] = [];
  const propose = (chapter: number, text: string, finding: string | null) => {
    if (proposals.length < DESIGN_PROPOSALS_MAX && !proposals.some((entry) => entry.chapter === chapter && entry.text === text)) proposals.push({ chapter, text, finding });
  };
  // What the analysis of the structure found that matters and nobody dismissed (the critical ones are already the director's): the chapters it revises.
  for (const finding of input.findings) {
    if (finding.status !== "open" || finding.severity !== "major") continue;
    const targets = finding.requires.length ? finding.requires : finding.chapters;
    const mine = targets.filter((chapter) => input.rewritable(chapter));
    for (const chapter of targets.filter((entry) => !input.rewritable(entry))) propose(chapter, findingNote(finding), finding.id);
    if (!mine.length || notes.length >= room) continue;
    notes.push(`${italian ? "Coerenza" : "Coherence"} — ${mine.length === 1 ? `${italian ? "Capitolo" : "Chapter"} ${mine[0]}` : `${italian ? "Capitoli" : "Chapters"} ${mine.join(", ")}`}: ${findingNote(finding)}`);
    for (const chapter of mine) chapters.add(chapter);
  }
  // What the panel said of the chapters it judged under par, the weakest first: the weak criteria with what it would do.
  const weak = Object.entries(input.reviewed ?? {})
    .map(([key, review]) => ({ chapter: Number(key), review }))
    .filter(({ chapter, review }) => review.verdict === "revise" && !input.named.has(chapter))
    .sort((left, right) => (left.review.overall ?? 10) - (right.review.overall ?? 10) || left.chapter - right.chapter);
  for (const { chapter, review } of weak) {
    const points = rubricProposals(input.rubric?.[`chapter:${chapter}`]?.latest ?? [], 2);
    const text = points.length ? points.join("; ") : review.summary;
    if (!text) continue;
    if (!input.rewritable(chapter)) {
      propose(chapter, text, null);
      continue;
    }
    if (notes.length >= room) continue;
    notes.push(`${italian ? "Capitolo" : "Chapter"} ${chapter}: ${text}`);
    chapters.add(chapter);
  }
  return { notes, chapters: [...chapters].sort((left, right) => left - right), proposals };
}
