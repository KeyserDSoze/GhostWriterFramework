import { BIBLE_THEMES_FILE, BIBLE_WORLD_FILE } from "../book/design.js";
import { outlineChapterPath } from "../book/paths.js";
import type { BookSnapshot } from "../book/snapshot.js";
import { DESIGN_REVIEW_BATCH_CHAPTERS } from "./design-review-types.js";
import { designFlow } from "./design-state.js";
import type { AutopilotState } from "./types.js";

/**
 * What the planner decides about the reviews of a design (`design-chapter-review`…): which chapters were not reviewed as they are now, and in which batches. Pure: it reads
 * only the hashes of the files of the snapshot, never a file, so that the planner can say it without waiting for a store.
 */

/** What the signature of an analysis is set to when a review on request asks for it again: it is no real signature, so that the design is analysed once more. */
export const STALE_SIGNATURE = "00000000";

/** A short fingerprint of a text (FNV-1a over its code units), eight hex digits: it tells that something changed, and is not a defence against anybody. */
export function shortHash(text: string): string {
  let hash = 0x811c9dc5;
  for (let index = 0; index < text.length; index += 1) {
    hash ^= text.charCodeAt(index);
    hash = Math.imul(hash, 0x01000193) >>> 0;
  }
  return hash.toString(16).padStart(8, "0");
}

/** The chapters of the Synopsis that no prose is written for: the designs a review looks at. In order of number. */
export function reviewableChapters(snapshot: BookSnapshot): number[] {
  const written = new Set(snapshot.chapters.filter((chapter) => chapter.paragraphs.length > 0).map((chapter) => chapter.number));
  const numbers = snapshot.outline ? snapshot.outline.chapters.map((entry) => entry.number) : [...snapshot.files.keys()].flatMap((path) => /^outline\/chapters\/(\d+)[^/]*\.md$/.exec(path)?.[1] ?? []).map(Number);
  return [...new Set(numbers)].sort((left, right) => left - right).filter((number) => !written.has(number));
}

function entryHash(snapshot: BookSnapshot, number: number): string {
  const indexed = snapshot.outline?.chapters.find((entry) => entry.number === number);
  return (indexed ? snapshot.files.get(indexed.path) : snapshot.files.get(outlineChapterPath(number))) ?? "-";
}

/**
 * What a review of a chapter is made of: the entry of the chapter and the entries beside it (a chapter is judged in its place, so a change of its neighbour is a reason
 * to judge it again). The same files give the same signature, whoever asks.
 */
export function chapterReviewSignature(snapshot: BookSnapshot, number: number): string {
  return shortHash([number - 1, number, number + 1].map((entry) => entryHash(snapshot, entry)).join("|"));
}

/**
 * What an analysis of the whole structure is made of: the entries of the Synopsis, the secrets with their ledgers, the world and the themes. The same files give the same
 * signature, so that the analysis is made again only when the design changed.
 */
export function coherenceSignature(snapshot: BookSnapshot): string {
  const chapters = reviewableChapters(snapshot).map((number) => `${number}:${entryHash(snapshot, number)}`);
  const secrets = snapshot.canon.filter((entry) => entry.kind === "secret").map((entry) => `${entry.path}:${entry.hash}`);
  const bible = [BIBLE_WORLD_FILE, BIBLE_THEMES_FILE].map((path) => `${path}:${snapshot.files.get(path) ?? "-"}`);
  return shortHash([...chapters, ...secrets, ...bible].join("|"));
}

/**
 * The next chapters to review: the first that was not reviewed as it is now, and the stale ones that follow it, at most `DESIGN_REVIEW_BATCH_CHAPTERS` and in a row. When a
 * review of chosen chapters goes on (`AutopilotDesign.reviewing`), only those. `from` starts the search at a chapter. `null` when none is left to review.
 */
export function nextChapterReview(state: Pick<AutopilotState, "design">, snapshot: BookSnapshot, from = 1): { from: number; to: number } | null {
  const design = state.design;
  if (!design) return null;
  const chosen = design.reviewing?.chapters ? new Set(design.reviewing.chapters) : null;
  const stale = reviewableChapters(snapshot).filter((number) => number >= from && (!chosen || chosen.has(number)) && design.reviewed?.[String(number)]?.sig !== chapterReviewSignature(snapshot, number));
  if (!stale.length) return null;
  let to = stale[0];
  while (to - stale[0] + 1 < DESIGN_REVIEW_BATCH_CHAPTERS && stale.includes(to + 1)) to += 1;
  return { from: stale[0], to };
}

/**
 * What the planner does about the alternatives of a design before the concept: `pitches` (the Brainstormer proposes them), `review` (the readers and the director judge
 * them), `choose` (the director recommended one and the design asks for the author's choice: the run waits), or `null` (none were asked for, or one is chosen).
 */
export function nextPitchStep(state: Pick<AutopilotState, "design">): "pitches" | "review" | "choose" | null {
  const design = state.design;
  const flow = designFlow(design);
  if (!design || !flow.alternatives || design.alternatives?.selected) return null;
  if (!design.alternatives?.pitches.length) return "pitches";
  if (!design.alternatives.recommended) return "review";
  return flow.pitchChoice === "author" ? "choose" : "review";
}

/** The review the planner asks next in a design run, before the director's: `null` when the workflow asks for none or every part is up to date. */
export function nextDesignReview(state: Pick<AutopilotState, "design">, snapshot: BookSnapshot): { kind: "design-chapter-review"; from: number; to: number } | { kind: "design-coherence" } | null {
  const flow = designFlow(state.design);
  if (flow.chapterReview) {
    const batch = nextChapterReview(state, snapshot);
    if (batch) return { kind: "design-chapter-review", ...batch };
  }
  // The analysis of the whole structure, once the chapters are judged: again whenever the design changed.
  if (flow.coherence && reviewableChapters(snapshot).length && state.design?.coherence?.sig !== coherenceSignature(snapshot)) return { kind: "design-coherence" };
  return null;
}
