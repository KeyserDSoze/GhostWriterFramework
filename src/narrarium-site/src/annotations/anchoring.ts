import type { TextAnchor } from "./model";

/**
 * Anchoring: from a selection to a `TextAnchor`, and from a `TextAnchor` back to a place in a text that may have changed since. Pure: it works on the plain
 * text of a scene (`textModel.ts` makes it from what the reader shows), so it is tested without a browser and can move to the engine.
 *
 * A passage is found again, in this order:
 *   exact     the quote is at the place it was marked (`offset`);
 *   moved     the quote is in the text verbatim, elsewhere (text was added or removed before it, or it went to another scene of the chapter); when it is
 *             there more than once, the copy whose surroundings (`prefix`, `suffix`) are most like the marked one's wins, then the nearest;
 *   edited    the quote is no longer in the text, but a passage like it is (an approximate search that allows a share of edits), or the text between
 *             its unchanged surroundings was rewritten;
 *   orphaned  nothing like it: the annotation keeps its quote and is still listed, never dropped.
 */

/** How many characters of the text before and after the quote an anchor keeps (the W3C Web Annotation model suggests about 32). */
export const CONTEXT_LENGTH = 32;
/** The share of the quote that may have changed for a passage to be found again as `edited`. */
export const MAX_EDIT_RATIO = 0.35;
/** How like the quote a passage has to be to count as the same passage, edited. */
export const MIN_SIMILARITY = 0.65;
/** A quote shorter than this is found approximately only where its surroundings agree too: three letters are like too many others. */
export const SHORT_QUOTE = 8;
/** At most this many verbatim copies of a quote are weighed (a one-letter quote can be everywhere). */
const MAX_OCCURRENCES = 500;
/** Above this many character comparisons an approximate search looks for the head and the tail of the quote instead of all of it. */
const MAX_SEARCH_CELLS = 4_000_000;

export type AnchorState = "exact" | "moved" | "edited" | "orphaned";

export interface AnchorMatch {
  state: AnchorState;
  /** Where the passage is now (UTF-16 code units of the text); -1 for an orphaned annotation. */
  start: number;
  end: number;
  /** How like the quote the passage found is, from 0 to 1 (1: verbatim). */
  similarity: number;
}

export const ORPHANED: AnchorMatch = Object.freeze({ state: "orphaned", start: -1, end: -1, similarity: 0 });

/** Where an annotation stands in its scene in a list: where its passage is now, or, when it is no longer in the text, where it was. */
export function listPosition(anchor: Pick<TextAnchor, "offset">, match: Pick<AnchorMatch, "state" | "start"> | null | undefined): number {
  return !match || match.state === "orphaned" ? anchor.offset : match.start;
}

const isHighSurrogate = (code: number) => code >= 0xd800 && code <= 0xdbff;
const isLowSurrogate = (code: number) => code >= 0xdc00 && code <= 0xdfff;
/** Whether `index` falls between the two halves of a character outside the Basic Multilingual Plane (an emoji): no cut is made there. */
const splitsPair = (text: string, index: number) => index > 0 && index < text.length && isLowSurrogate(text.charCodeAt(index)) && isHighSurrogate(text.charCodeAt(index - 1));
const isSpace = (character: string | undefined) => character !== undefined && /\s/.test(character);

/**
 * The anchor of the selection `[start, end)` of `text`: white space at its edges is left out, no character is cut in two, and up to `CONTEXT_LENGTH`
 * characters around it are kept. `null` when the selection holds no text.
 */
export function anchorFromRange(text: string, start: number, end: number): (TextAnchor & { start: number; end: number }) | null {
  let from = Math.max(0, Math.min(text.length, Math.min(start, end)));
  let to = Math.max(0, Math.min(text.length, Math.max(start, end)));
  while (from < to && isSpace(text[from])) from += 1;
  while (to > from && isSpace(text[to - 1])) to -= 1;
  if (splitsPair(text, from)) from -= 1;
  if (splitsPair(text, to)) to += 1;
  if (to <= from) return null;
  let before = Math.max(0, from - CONTEXT_LENGTH);
  if (splitsPair(text, before)) before += 1;
  let after = Math.min(text.length, to + CONTEXT_LENGTH);
  if (splitsPair(text, after)) after -= 1;
  return { quote: text.slice(from, to), prefix: text.slice(before, from), suffix: text.slice(to, after), offset: from, start: from, end: to };
}

/** The edit distance between two strings (insertions, deletions and substitutions of UTF-16 units each cost one). */
export function editDistance(left: string, right: string): number {
  if (left === right) return 0;
  if (!left.length) return right.length;
  if (!right.length) return left.length;
  let previous = new Int32Array(right.length + 1);
  let current = new Int32Array(right.length + 1);
  for (let j = 0; j <= right.length; j += 1) previous[j] = j;
  for (let i = 1; i <= left.length; i += 1) {
    current[0] = i;
    const code = left.charCodeAt(i - 1);
    for (let j = 1; j <= right.length; j += 1) {
      current[j] = Math.min(previous[j - 1] + (code === right.charCodeAt(j - 1) ? 0 : 1), previous[j] + 1, current[j - 1] + 1);
    }
    [previous, current] = [current, previous];
  }
  return previous[right.length];
}

/** How alike two strings are, from 0 (nothing in common) to 1 (the same). */
export function similarity(left: string, right: string): number {
  const longest = Math.max(left.length, right.length);
  return longest === 0 ? 1 : 1 - editDistance(left, right) / longest;
}

/**
 * How much the text around `[start, end)` is like the anchor's surroundings, from 0 to 1. The prefix is compared with the text that ends at the
 * passage, the suffix with the text that starts after it; an anchor with no prefix was at the start of its text (and with no suffix at its end).
 */
export function contextScore(anchor: TextAnchor, text: string, start: number, end: number): number {
  const prefix = anchor.prefix.length === 0
    ? (start === 0 ? 1 : 0.5)
    : similarity(anchor.prefix, text.slice(Math.max(0, start - anchor.prefix.length), start));
  const suffix = anchor.suffix.length === 0
    ? (end === text.length ? 1 : 0.5)
    : similarity(anchor.suffix, text.slice(end, end + anchor.suffix.length));
  return (prefix + suffix) / 2;
}

function exactOccurrences(quote: string, text: string): number[] {
  const found: number[] = [];
  let at = text.indexOf(quote);
  while (at >= 0 && found.length < MAX_OCCURRENCES) {
    found.push(at);
    at = text.indexOf(quote, at + 1);
  }
  return found;
}

export interface ApproximateMatch {
  start: number;
  end: number;
  errors: number;
}

/**
 * Where `pattern` is in `text` with at most `maxErrors` edits (Sellers' algorithm: the edit distance of the pattern against every substring of the
 * text, with the start of each alignment carried along). Overlapping results are reduced to the one with the fewest edits; best first.
 */
export function approximateMatches(pattern: string, text: string, maxErrors: number): ApproximateMatch[] {
  const m = pattern.length;
  const n = text.length;
  if (!m || !n) return [];
  let previousCost = new Int32Array(m + 1);
  let previousStart = new Int32Array(m + 1);
  let currentCost = new Int32Array(m + 1);
  let currentStart = new Int32Array(m + 1);
  for (let i = 0; i <= m; i += 1) previousCost[i] = i;
  const ends: ApproximateMatch[] = [];
  for (let j = 1; j <= n; j += 1) {
    currentCost[0] = 0;
    currentStart[0] = j;
    const code = text.charCodeAt(j - 1);
    for (let i = 1; i <= m; i += 1) {
      let cost = previousCost[i - 1] + (pattern.charCodeAt(i - 1) === code ? 0 : 1);
      let start = previousStart[i - 1];
      if (previousCost[i] + 1 < cost) {
        cost = previousCost[i] + 1;
        start = previousStart[i];
      }
      if (currentCost[i - 1] + 1 < cost) {
        cost = currentCost[i - 1] + 1;
        start = currentStart[i - 1];
      }
      currentCost[i] = cost;
      currentStart[i] = start;
    }
    if (currentCost[m] <= maxErrors) ends.push({ start: currentStart[m], end: j, errors: currentCost[m] });
    [previousCost, currentCost] = [currentCost, previousCost];
    [previousStart, currentStart] = [currentStart, previousStart];
  }
  ends.sort((left, right) => left.errors - right.errors || left.start - right.start || left.end - right.end);
  const kept: ApproximateMatch[] = [];
  for (const candidate of ends) {
    if (kept.some((other) => candidate.start < other.end && other.start < candidate.end)) continue;
    kept.push(candidate);
    if (kept.length >= 20) break;
  }
  return kept;
}

function trimSpan(text: string, start: number, end: number): { start: number; end: number } {
  let from = start;
  let to = end;
  while (from < to && isSpace(text[from])) from += 1;
  while (to > from && isSpace(text[to - 1])) to -= 1;
  return { start: from, end: to };
}

const isWordCharacter = (character: string | undefined) => character !== undefined && /[\p{L}\p{N}]/u.test(character);
/** A found passage is not grown or shrunk by more than this to reach the edge of a word. */
const SNAP_LIMIT = 24;

/**
 * An approximate match can stop inside a word ("old stee" for "old steel": one edit fewer). When the marked passage began and ended at the edges of
 * words, so does the passage found: its ends are moved out to the edges of the words they cut.
 */
function snapToWords(anchor: TextAnchor, text: string, start: number, end: number): { start: number; end: number } {
  let from = start;
  let to = end;
  const startedAtEdge = !(isWordCharacter(anchor.prefix[anchor.prefix.length - 1]) && isWordCharacter(anchor.quote[0]));
  const endedAtEdge = !(isWordCharacter(anchor.quote[anchor.quote.length - 1]) && isWordCharacter(anchor.suffix[0]));
  if (startedAtEdge) {
    let moved = 0;
    while (from > 0 && moved < SNAP_LIMIT && isWordCharacter(text[from - 1]) && isWordCharacter(text[from])) { from -= 1; moved += 1; }
  }
  if (endedAtEdge) {
    let moved = 0;
    while (to < text.length && moved < SNAP_LIMIT && isWordCharacter(text[to - 1]) && isWordCharacter(text[to])) { to += 1; moved += 1; }
  }
  return { start: from, end: to };
}

interface Candidate {
  start: number;
  end: number;
  similarity: number;
  context: number;
  /** Found between the anchor's unchanged surroundings. */
  bounded?: boolean;
}

const candidateScore = (candidate: Candidate) => candidate.similarity * 0.6 + candidate.context * 0.4;

/** Places where a long quote may be, from its head and its tail found approximately in order: a search of the whole quote would cost too much. */
function headAndTailCandidates(quote: string, text: string): ApproximateMatch[] {
  const size = 128;
  const head = quote.slice(0, size);
  const tail = quote.slice(-size);
  const heads = approximateMatches(head, text, Math.floor(head.length * MAX_EDIT_RATIO));
  const tails = approximateMatches(tail, text, Math.floor(tail.length * MAX_EDIT_RATIO));
  const found: ApproximateMatch[] = [];
  for (const first of heads) {
    for (const last of tails) {
      const length = last.end - first.start;
      if (last.end <= first.start || length < quote.length * 0.5 || length > quote.length * 1.5) continue;
      found.push({ start: first.start, end: last.end, errors: Math.round(((first.errors / head.length + last.errors / tail.length) / 2) * quote.length) });
    }
  }
  return found;
}

/** A passage like the quote, when the quote itself is no longer in the text; `null` when there is none (see the thresholds above). */
export function fuzzyLocate(anchor: TextAnchor, text: string): AnchorMatch | null {
  const quote = anchor.quote;
  if (!quote || !text) return null;
  const candidates: Candidate[] = [];
  const consider = (rawStart: number, rawEnd: number, estimate?: number, bounded = false) => {
    const snapped = bounded ? { start: rawStart, end: rawEnd } : snapToWords(anchor, text, rawStart, rawEnd);
    const { start, end } = trimSpan(text, snapped.start, snapped.end);
    if (end <= start) return;
    const found = text.slice(start, end);
    // The exact likeness of two long passages costs as much as the search they avoided: the estimate of the search stands for it.
    const affordable = quote.length * found.length <= MAX_SEARCH_CELLS;
    candidates.push({ start, end, similarity: affordable ? similarity(quote, found) : estimate ?? 0, context: contextScore(anchor, text, start, end), bounded });
  };

  const maxErrors = Math.floor(quote.length * MAX_EDIT_RATIO);
  if (maxErrors > 0) {
    const tooLong = quote.length * text.length > MAX_SEARCH_CELLS;
    const matches = tooLong ? headAndTailCandidates(quote, text) : approximateMatches(quote, text, maxErrors);
    for (const match of matches) consider(match.start, match.end, tooLong ? 1 - match.errors / quote.length : undefined);
  }

  // The surroundings are unchanged and what is between them was rewritten: that is the passage, however different it reads now.
  const bounded = boundedBySurroundings(anchor, text);
  if (bounded) consider(bounded.start, bounded.end, undefined, true);

  let best: Candidate | null = null;
  for (const candidate of candidates) {
    const accepted = quote.length < SHORT_QUOTE
      ? candidate.similarity >= MIN_SIMILARITY && candidate.context >= 0.6
      : candidate.similarity >= MIN_SIMILARITY || (candidate.bounded === true && candidate.context >= 0.75);
    if (!accepted) continue;
    if (!best || candidateScore(candidate) > candidateScore(best)) best = candidate;
  }
  return best ? { state: "edited", start: best.start, end: best.end, similarity: Math.max(0, Math.min(1, best.similarity)) } : null;
}

/** The text between the anchor's prefix and suffix, when both are still in the text, in order and close enough to have held the quote. */
function boundedBySurroundings(anchor: TextAnchor, text: string): { start: number; end: number } | null {
  if (anchor.prefix.trim().length < 8 || anchor.suffix.trim().length < 8) return null;
  const longest = Math.max(anchor.quote.length * 3, anchor.quote.length + 200);
  let best: { start: number; end: number; distance: number } | null = null;
  for (let at = text.indexOf(anchor.prefix); at >= 0; at = text.indexOf(anchor.prefix, at + 1)) {
    const start = at + anchor.prefix.length;
    const end = text.indexOf(anchor.suffix, start);
    if (end < 0 || end - start > longest || !text.slice(start, end).trim()) continue;
    const distance = Math.abs(start - anchor.offset);
    if (!best || distance < best.distance) best = { start, end, distance };
  }
  return best;
}

/** Where the anchor's passage is in `text` now (see the states at the top). */
export function locateAnchor(anchor: TextAnchor, text: string): AnchorMatch {
  const quote = anchor.quote;
  if (!quote) return ORPHANED;
  const occurrences = exactOccurrences(quote, text);
  if (occurrences.length) {
    let best = occurrences[0];
    let bestContext = -1;
    for (const at of occurrences) {
      const context = contextScore(anchor, text, at, at + quote.length);
      const nearer = Math.abs(at - anchor.offset) < Math.abs(best - anchor.offset);
      if (context > bestContext + 1e-9 || (Math.abs(context - bestContext) <= 1e-9 && nearer)) {
        best = at;
        bestContext = context;
      }
    }
    return { state: best === anchor.offset ? "exact" : "moved", start: best, end: best + quote.length, similarity: 1 };
  }
  return fuzzyLocate(anchor, text) ?? ORPHANED;
}

export interface ParagraphText {
  /** The slug of the scene. */
  paragraph: string;
  /** Its plain text, as `textModel.ts` makes it. */
  text: string;
}

export interface ChapterAnchorMatch extends AnchorMatch {
  /** The scene the passage is in now (the marked one when it is orphaned). */
  paragraph: string;
}

/** A quote at least this long is looked for, edited, in the other scenes of the chapter: shorter ones would be found where they never were. */
const MOVED_AND_EDITED_MINIMUM = 20;
/** The approximate search in another scene is stricter than in the marked one. */
const OTHER_SCENE_SIMILARITY = 0.8;

/**
 * Where the passage of an annotation is in its chapter now: in the scene it was marked in, else (moved to another scene) verbatim in another one, or
 * edited there. The marked scene is preferred when two places are as good.
 */
export function locateInChapter(anchor: TextAnchor & { paragraph: string }, paragraphs: readonly ParagraphText[]): ChapterAnchorMatch {
  const own = paragraphs.find((entry) => entry.paragraph === anchor.paragraph);
  let ownMatch: AnchorMatch | null = null;
  if (own) {
    ownMatch = locateAnchor(anchor, own.text);
    if (ownMatch.state === "exact" || ownMatch.state === "moved") return { ...ownMatch, paragraph: own.paragraph };
  }

  const found: { best: ChapterAnchorMatch | null; score: number } = { best: null, score: -1 };
  const offer = (paragraph: string, match: AnchorMatch, text: string, bonus: number) => {
    if (!anchor.quote) return;
    const score = match.similarity * 0.6 + contextScore(anchor, text, match.start, match.end) * 0.4 + bonus;
    if (score > found.score) {
      found.best = { ...match, paragraph };
      found.score = score;
    }
  };
  if (own && ownMatch && ownMatch.state === "edited") offer(own.paragraph, ownMatch, own.text, 0.1);

  for (const entry of paragraphs) {
    if (entry === own || !anchor.quote) continue;
    for (const at of exactOccurrences(anchor.quote, entry.text)) offer(entry.paragraph, { state: "moved", start: at, end: at + anchor.quote.length, similarity: 1 }, entry.text, 0);
  }
  if (!found.best && anchor.quote.length >= MOVED_AND_EDITED_MINIMUM) {
    const seeds = seedsOf(anchor.quote);
    for (const entry of paragraphs) {
      if (entry === own || !seeds.some((seed) => entry.text.includes(seed))) continue;
      const match = fuzzyLocate(anchor, entry.text);
      if (match && match.similarity >= OTHER_SCENE_SIMILARITY) offer(entry.paragraph, match, entry.text, 0);
    }
  }
  return found.best ?? { ...ORPHANED, paragraph: anchor.paragraph };
}

/** Pieces of a quote that an edited copy of it is likely to keep: a scene without any of them is not searched. */
function seedsOf(quote: string): string[] {
  const size = 12;
  const seeds: string[] = [];
  for (let at = 0; at + size <= quote.length; at += size) seeds.push(quote.slice(at, at + size));
  return seeds.length ? seeds : [quote];
}
