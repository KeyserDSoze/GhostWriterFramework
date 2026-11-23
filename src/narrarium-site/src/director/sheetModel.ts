import { TOKENS_PER_WORD, languageCode, languageName, type DirectorAutonomy, type DirectorOpinionRecord, type DirectorProfile, type DirectorVerdict } from "narrarium-engine";
import { chapterNumberFromSlug } from "@/lib/chapterSlug";

/**
 * What the director page says of the values of `director.md`, worked out from the engine's own rules and nothing else. Pure.
 *
 * What the engine does with them (packages/engine/src/autopilot/tasks.ts, planner.ts, director/opinion.ts):
 * - `approval_score` is a rule: an approval the director gives with a score under it is withheld, and the chapter is treated as a revision (the plan
 *   too, and an opinion asked on demand reads «revise»). A revision without any fix that can be applied is approved as it is.
 * - `max_review_rounds` is a rule: after that many rounds the chapter is closed, with the fixes accepted in the last round applied and no other review.
 * - `autonomy` is a rule for `full` (the director never asks) and `ask-always` (the autopilot waits after the plan and after every chapter); with
 *   `ask-on-critical` the director decides when a matter is critical.
 * - `strictness` is only a line of the director's instructions: how it moves the scores of a model cannot be computed, and the page says so.
 * - `language` is not read by the engine: the director writes in the language of the book.
 */

/** A value of the profile as the engine keeps it: between `min` and `max`, with one decimal. */
export function profileScore(value: number, min = 1, max = 10): number {
  if (!Number.isFinite(value)) return min;
  return Math.min(max, Math.max(min, Math.round(value * 10) / 10));
}

/** The step of the sliders: half a point, as the author is likely to set them (a value of the file with another decimal is kept as it is). */
export const SLIDER_STEP = 0.5;
/** Page Up and Page Down move by a whole point. */
export const SLIDER_PAGE = 1;

export type StrictnessCaption = "lenient" | "balanced" | "strict";
export type ApprovalCaption = "low" | "medium" | "high";

/** Lenient up to 3.5, balanced up to 6.5, strict from 7 (the default director is a 7: demanding but fair). */
export function strictnessCaption(value: number): StrictnessCaption {
  return value < 4 ? "lenient" : value < 7 ? "balanced" : "strict";
}

/** A low bar up to 5.5, a medium one up to 7.5, a high one from 8. */
export function approvalCaption(value: number): ApprovalCaption {
  return value < 6 ? "low" : value < 8 ? "medium" : "high";
}

/** The score a chapter of a book is given in the preview, when the approval score leaves room under it: 6.5, as the review of the owner's example, or half a point under a lower bar. */
const SAMPLE_SCORE = 6.5;

export interface DirectorPreview {
  threshold: number;
  /** A score under the threshold, and what it shows (an approval withheld); `null` when no score of the scale is under it. */
  below: number | null;
  rounds: number;
  autonomy: DirectorAutonomy;
  strictness: number;
}

export function directorPreview(profile: Pick<DirectorProfile, "approvalScore" | "maxReviewRounds" | "autonomy" | "strictness">): DirectorPreview {
  const threshold = profileScore(profile.approvalScore);
  const below = threshold > 1 ? Math.max(1, Math.min(SAMPLE_SCORE, profileScore(threshold - 0.5))) : null;
  return {
    threshold,
    below: below !== null && below < threshold ? below : null,
    rounds: Math.min(3, Math.max(1, Math.round(profile.maxReviewRounds))),
    autonomy: profile.autonomy,
    strictness: profileScore(profile.strictness),
  };
}

// ─── The language of the profile ─────────────────────────────────────────────

export interface LanguageOption {
  value: string;
  /** The name of the language in the language of the app. */
  name: string;
  /** That name, with its own name when that is written differently, and its code: `Russian — русский (ru)`. */
  label: string;
  /** Its own name, to be read in its own language (`lang`), when it is not the name in the language of the app. */
  native: string | null;
  /** The language of the book: the first of the list, and the one a new director gets. */
  book: boolean;
  /** A value of the file the engine does not know, kept as it is written. */
  unknown?: boolean;
}

/** Every language the engine knows (the ones it sizes books in), by code. */
export const ENGINE_LANGUAGES: readonly string[] = Object.keys(TOKENS_PER_WORD);

function displayName(code: string, inLanguage: string): string | null {
  try {
    const name = new Intl.DisplayNames([inLanguage], { type: "language" }).of(code);
    return name && name.toLowerCase() !== code ? name : null;
  } catch {
    return null;
  }
}

/** The code the engine reads a value as, when it is one it knows (`it`, `it-IT`, `Italiano`, `русский`); `null` otherwise. */
export function knownLanguage(value: string | undefined): string | null {
  const code = languageCode(value, "");
  return code && ENGINE_LANGUAGES.includes(code) ? code : null;
}

/** The name of a language in the language of the app (the engine's English name when the browser has none). */
export function languageLabel(code: string, uiLanguage: string): string {
  return displayName(code, uiLanguage) ?? languageName(code);
}

/**
 * The choices of the language of the director: the language of the book first, then every language the engine knows in the alphabetical order of
 * the app's language, and the value of the file when it is not one of them (kept as it is, never replaced by a guess).
 */
export function languageOptions(uiLanguage: string, bookLanguage: string | undefined, current: string): LanguageOption[] {
  const book = knownLanguage(bookLanguage);
  const option = (code: string): LanguageOption => {
    const name = languageLabel(code, uiLanguage);
    const own = displayName(code, code);
    const native = own && own.localeCompare(name, undefined, { sensitivity: "base" }) !== 0 ? own : null;
    return { value: code, name, label: `${name}${native ? ` — ${native}` : ""} (${code})`, native, book: code === book };
  };
  const collator = new Intl.Collator(uiLanguage);
  const others = ENGINE_LANGUAGES.filter((code) => code !== book).map(option).sort((left, right) => collator.compare(left.label, right.label));
  const options = [...(book ? [option(book)] : []), ...others];
  const trimmed = current.trim();
  if (trimmed && !knownLanguage(trimmed)) options.unshift({ value: trimmed, name: trimmed, label: trimmed, native: null, book: false, unknown: true });
  return options;
}

/** The option a value of the profile is shown as: its code when the engine knows it, else the value as it is written. */
export function languageValue(current: string): string {
  return knownLanguage(current) ?? current.trim();
}

// ─── The scores of the saved opinions ────────────────────────────────────────

export interface TrendPoint {
  path: string;
  title: string;
  score: number;
  verdict: DirectorVerdict;
  createdAt: string;
  /** The number of the chapter, for an opinion on a chapter. */
  chapter: number | null;
}

const pointOf = (record: DirectorOpinionRecord): TrendPoint => {
  const slug = record.targetType === "chapter" ? record.targetId.replace(/^chapter:/, "") : "";
  return { path: record.path, title: record.title, score: record.score, verdict: record.verdict, createdAt: record.createdAt, chapter: slug ? chapterNumberFromSlug(slug) : null };
};

/** The opinions on the chapters, in the order of the book (the book keeps one opinion for each chapter: the last one). */
export function trendByChapter(records: readonly DirectorOpinionRecord[]): TrendPoint[] {
  return records.map(pointOf).filter((point) => point.chapter !== null).sort((left, right) => left.chapter! - right.chapter! || left.createdAt.localeCompare(right.createdAt));
}

/** Every opinion, the book's and the scenes' too, oldest first. */
export function trendByDate(records: readonly DirectorOpinionRecord[]): TrendPoint[] {
  return records.map(pointOf).sort((left, right) => left.createdAt.localeCompare(right.createdAt) || left.path.localeCompare(right.path));
}
