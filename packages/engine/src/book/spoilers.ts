import { isItalian, truncate } from "../util/text.js";
import type { DesignCheckSecret, DesignFinding } from "./design.js";

/**
 * The spoiler check on WRITTEN prose: a chapter whose text states a secret before the chapter from which the reader may know it (`reveal_in`, `known_from`, the same thresholds
 * the core enforces when it writes: `matchesChapterReference`, `resolveChapterNumberFromReference`). It reads text, not a plan, and needs no model: a secret is stated in a
 * sentence that names it by its id or its title, or that says the truth of it (the sentence of its text that carries most of the words that are particular to it).
 * Findings (`spoiler-in-prose`), never blockers: a mention is a reason to read the line again, and the author decides.
 */

/** A written chapter as the check reads it: its number and the text of its scenes. */
export interface WrittenChapter {
  number: number;
  text: string;
}

/** A secret as the check reads it: the rules of the design checks, and the truth of it (the body of its file). */
export interface SpoilerSecret extends DesignCheckSecret {
  truth: string;
}

/** Characters of a chapter's text the check reads: a text longer than this is read as far as here, so that a very long chapter costs what it should. */
export const SPOILER_TEXT_MAX_CHARS = 400_000;

const STOPWORDS = new Set([
  "about", "after", "again", "against", "because", "before", "being", "between", "could", "every", "other", "their", "there", "these", "those", "through", "under", "where", "which", "while", "would", "should", "never", "always",
  "anche", "ancora", "perche", "quando", "dopo", "prima", "sempre", "durante", "questo", "questa", "questi", "queste", "quello", "quella", "essere", "stato", "stata", "aveva", "hanno", "nella", "nello", "della", "delle", "degli", "alla", "alle", "tutti", "tutto", "molto", "senza", "ogni",
]);

function normalize(value: string): string {
  return value.normalize("NFKD").replace(/[\u0300-\u036f]/g, "").replace(/[«»"'“”‘’]/g, " ").toLowerCase();
}

function words(value: string): string[] {
  return normalize(value).split(/[^a-z0-9]+/).filter(Boolean);
}

/** The words that are particular to the truth of a secret: the longer ones, once each, without the words that say nothing. */
export function secretKeywords(truth: string): string[] {
  const seen = new Set<string>();
  const keywords: string[] = [];
  for (const word of words(truth)) {
    if (word.length < 5 || STOPWORDS.has(word) || seen.has(word)) continue;
    seen.add(word);
    keywords.push(word);
  }
  return keywords.slice(0, 14);
}

/** The sentences of a text (cut where a stop is followed by a space and a capital, or at a line). */
function sentencesOf(text: string): string[] {
  return text.replace(/\r\n?/g, "\n").split(/(?<=[.!?…])\s+(?=[\p{Lu}«"“'‘(])|\n+/u).map((sentence) => sentence.trim()).filter(Boolean);
}

/** The first sentence of the text that states the secret, or `undefined`. */
function statement(sentences: readonly string[], secret: SpoilerSecret, keywords: readonly string[]): string | undefined {
  const title = normalize(secret.title).trim();
  const needed = keywords.length <= 3 ? keywords.length : Math.max(3, Math.ceil(keywords.length * 0.6));
  for (const sentence of sentences) {
    const text = normalize(sentence);
    if (text.includes(`secret:${secret.slug}`)) return sentence;
    if (title.length > 3 && ` ${text.replace(/[^a-z0-9]+/g, " ")} `.includes(` ${title.replace(/[^a-z0-9]+/g, " ").trim()} `)) return sentence;
    if (needed >= 2) {
      const present = new Set(words(sentence));
      if (keywords.filter((keyword) => present.has(keyword)).length >= needed) return sentence;
    }
  }
  return undefined;
}

/**
 * The written chapters that state a secret before the chapter from which the reader may know it, one finding for each chapter and secret, in the order of the chapters. A secret
 * with no chapter that reveals it, or known from the start (chapter 1 or before), has no threshold and says nothing; nor does the chapter of the reveal, or any after it.
 */
export function spoilerChecks(input: { chapters: readonly WrittenChapter[]; secrets: readonly SpoilerSecret[] }): DesignFinding[] {
  const findings: DesignFinding[] = [];
  const chapters = [...input.chapters].sort((left, right) => left.number - right.number);
  const prepared = chapters.map((chapter) => ({ number: chapter.number, sentences: sentencesOf(chapter.text.slice(0, SPOILER_TEXT_MAX_CHARS)) }));
  for (const secret of input.secrets) {
    const thresholds = [secret.revealChapter, secret.knownFromChapter].filter((value): value is number => typeof value === "number" && value > 1);
    if (!thresholds.length) continue;
    const threshold = Math.min(...thresholds);
    const keywords = secretKeywords(secret.truth);
    for (const chapter of prepared) {
      if (chapter.number >= threshold) break;
      const found = statement(chapter.sentences, secret, keywords);
      if (found) findings.push({ code: "spoiler-in-prose", severity: "warning", chapter: chapter.number, secret: { slug: secret.slug, title: secret.title }, other: threshold, excerpt: truncate(found.replace(/\s+/g, " "), 160) });
    }
  }
  return findings.sort((left, right) => (left.chapter ?? 0) - (right.chapter ?? 0) || (left.secret?.slug ?? "").localeCompare(right.secret?.slug ?? ""));
}

/** A line saying that written text was read for the check: how many chapters, and how many were before a reveal (the Bible's «checked» line). */
export function spoilerCheckSummary(chapters: number, findings: number, language: string): string {
  const it = isItalian(language);
  if (!chapters) return it ? "Nessun capitolo scritto da controllare." : "No written chapter to check.";
  return it ? `Letti ${chapters} capitoli scritti: ${findings ? `${findings} possibili anticipazioni` : "nessuna anticipazione trovata"}.` : `Read ${chapters} written chapters: ${findings ? `${findings} possible early statements` : "no early statement found"}.`;
}
