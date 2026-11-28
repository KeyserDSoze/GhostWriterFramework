import type { AiJsonSchema } from "../ai/types.js";
import { asArray, asInteger, asRecord, asString } from "../util/json.js";
import { clipText, isItalian } from "../util/text.js";
import {
  BOOK_CORRECTIONS_MAX,
  BOOK_CORRECTION_CHANGE_CHARACTERS,
  BOOK_CORRECTION_REASON_CHARACTERS,
  BOOK_POINTS_MAX,
  BOOK_POINT_CHARACTERS,
  type BookCorrection,
  type BookRound,
  type BookRoundRecord,
} from "./types.js";

/**
 * The book-level round of a review (`BookRound`): what the director is asked when every chapter has its targets and the judgement of the whole book does not (#113), and how what it
 * answers is read, checked and turned into the words of a revision. Pure: the step that asks (`runBookCorrections`, in `tasks.ts`), the campaign that carries the corrections out
 * (`campaign.ts`) and the hosts that show them all read it here.
 */

/** A point of the judgement as the corrections cite it: its words in one line, cut. */
function cleanLine(value: string): string {
  return value.replace(/\s+/g, " ").trim();
}

/**
 * What the director's judgement of the whole book says that a correction can answer: its concerns (severity, issue, suggestion) and its next steps, in that order, each in one line and
 * cut to `BOOK_POINT_CHARACTERS`, at most `BOOK_POINTS_MAX`. They are numbered from 1 when they are cited.
 */
export function verdictPoints(opinion: { concerns: ReadonlyArray<{ severity: string; issue: string; suggestion?: string }>; nextSteps: readonly string[] }): string[] {
  const points = [
    ...opinion.concerns.map((concern) => cleanLine(`${concern.severity}: ${concern.issue}${concern.suggestion ? ` — ${concern.suggestion}` : ""}`)),
    ...opinion.nextSteps.map((step) => cleanLine(`next step: ${step}`)),
  ];
  return points.filter(Boolean).slice(0, BOOK_POINTS_MAX).map((point) => clipText(point, BOOK_POINT_CHARACTERS));
}

/** The reply the director gives to the request for the corrections of the whole book (`runBookCorrections`). */
export const BOOK_CORRECTIONS_TOOL: AiJsonSchema = {
  name: "book_corrections",
  description: "The corrections of the whole book that the director asks for: which chapters to change, what to change in each and why, citing the points of the judgement of the book.",
  parameters: {
    type: "object",
    properties: {
      summary: { type: "string", description: "In a few sentences: what keeps the book under the target and how these corrections answer it." },
      corrections: {
        type: "array",
        description: "The corrections across the chapters, the fewest that matter. Empty when the chapters have nothing to give: the book then waits for the author.",
        items: {
          type: "object",
          properties: {
            chapterNumber: { type: "number", description: "The chapter to change." },
            change: { type: "string", description: "What to change in that chapter, concretely: the scenes, the beats, the lines, what to add, to cut or to move." },
            reason: { type: "string", description: "Why: what the change does for the book as a whole." },
            cites: { type: "array", items: { type: "number" }, description: "The numbers of the points of the judgement of the book that this answers, at least one." },
          },
          required: ["chapterNumber", "change", "reason", "cites"],
        },
      },
    },
    required: ["summary", "corrections"],
  },
};

/** What the book knows of its chapters when the corrections are read: the ones the director may ask a change of (`open`), and the author's (`author`). */
export type BookChapterAccess = ReadonlyMap<number, "open" | "author">;

export interface ReadBookCorrections {
  summary: string;
  corrections: BookCorrection[];
  /** What was wrong with the corrections that were left out, for the director (one line each). */
  problems: string[];
}

/**
 * The corrections as the director gave them, checked: each names a chapter of the plan, says what to change and why, and cites at least one point of the judgement that exists (a
 * judgement of an older engine has no points, and then nothing is required to be cited); a correction that does not is left out and said (`problems`), the same chapter may have
 * several, and at most `BOOK_CORRECTIONS_MAX` are kept, in the order of the book. A chapter that is the author's is kept marked `held`: it is carried out only when the author chooses it.
 */
export function readBookCorrections(output: Record<string, unknown>, chapters: BookChapterAccess, points: number): ReadBookCorrections {
  const problems: string[] = [];
  const corrections: BookCorrection[] = [];
  asArray(output.corrections).forEach((entry, index) => {
    const item = asRecord(entry);
    const label = `Correction ${index + 1}`;
    const chapter = asInteger(item.chapterNumber, 0, 0, 100_000);
    const access = chapters.get(chapter);
    const change = cleanLine(asString(item.change));
    const reason = cleanLine(asString(item.reason));
    const cites = [...new Set(asArray(item.cites).map((cite) => asInteger(cite, 0, 0, 1000)).filter((cite) => cite >= 1 && cite <= points))].sort((left, right) => left - right);
    if (!access) problems.push(`${label} is about chapter ${asString(item.chapterNumber) || "?"}, which is not a chapter of the book: use a number from the CHAPTERS list.`);
    else if (!change) problems.push(`${label} (chapter ${chapter}) does not say what to change.`);
    else if (!reason) problems.push(`${label} (chapter ${chapter}) does not say why.`);
    else if (points > 0 && !cites.length) problems.push(`${label} (chapter ${chapter}) does not cite a point of the judgement: give the number of at least one of the ${points} points.`);
    else {
      corrections.push({
        chapter,
        change: clipText(change, BOOK_CORRECTION_CHANGE_CHARACTERS),
        reason: clipText(reason, BOOK_CORRECTION_REASON_CHARACTERS),
        cites,
        ...(access === "author" ? { held: "author" as const } : {}),
        status: "waiting",
      });
    }
  });
  const kept = corrections.sort((left, right) => left.chapter - right.chapter).slice(0, BOOK_CORRECTIONS_MAX);
  return { summary: clipText(cleanLine(asString(output.summary)), 800), corrections: kept, problems };
}

/**
 * What a chapter is told when the corrections of the book are carried out in it: the instruction of its revision. The director's judgement of the whole book asks the change, so the
 * words say whose it is, what to change, why, and which points of the judgement it answers (the revision decides which scenes, as it does for the author's own instruction).
 */
export function bookCorrectionInstruction(round: Pick<BookRound, "verdict" | "corrections">, chapter: number): string {
  const mine = round.corrections.filter((correction) => correction.chapter === chapter && correction.status === "waiting");
  const lines = mine.map((correction, index) => {
    const answers = correction.cites.map((cite) => round.verdict.points[cite - 1]).filter((point): point is string => Boolean(point));
    return [
      `${index + 1}. ${correction.change}`,
      `   Why: ${correction.reason}`,
      answers.length ? `   Answers: ${answers.map((point) => `«${point}»`).join("; ")}` : "",
    ].filter(Boolean).join("\n");
  });
  const score = round.verdict.score === null ? "" : ` (${round.verdict.score}/10)`;
  return [`The director's judgement of the whole book${score} asks for changes to chapter ${chapter}, because the book as a whole needs them:`, ...lines].join("\n");
}

/** What a book-level round came to, for the history of a review: the verdict it answered, and each correction with what became of it. */
export function bookRoundRecord(round: BookRound): BookRoundRecord {
  return {
    score: round.verdict.score,
    points: round.verdict.points,
    corrections: round.corrections.map((correction) => ({ ...correction })),
    ...(round.summary ? { summary: round.summary } : {}),
  };
}

/** The words of a report that a book-level round began, ended without a correction, or was applied (the codes of `AutopilotMessageCode`). */
export function bookRoundText(language: string, kind: "asked" | "proposed" | "applied" | "none-director" | "none-author" | "declined", figures: { score?: number | null; target: number; count?: number; chapters?: number }): { title: string; detail?: string } {
  const text = (en: string, it: string) => (isItalian(language) ? it : en);
  const vote = (value: number | null | undefined) => (value === null || value === undefined ? "—" : `${value}/10`);
  const count = figures.count ?? 0;
  const corrections = (n: number) => (isItalian(language) ? (n === 1 ? "1 correzione" : `${n} correzioni`) : n === 1 ? "1 correction" : `${n} corrections`);
  const chapters = (n: number) => (isItalian(language) ? (n === 1 ? "1 capitolo" : `${n} capitoli`) : n === 1 ? "1 chapter" : `${n} chapters`);
  switch (kind) {
    case "asked":
      return {
        title: text(`Every chapter has its targets and the book got ${vote(figures.score)} (target ${figures.target}/10): the director is asked for the corrections of the whole book`, `Ogni capitolo ha i suoi obiettivi e il libro ha preso ${vote(figures.score)} (obiettivo ${figures.target}/10): al direttore si chiedono le correzioni del libro intero`),
      };
    case "proposed":
      return {
        title: text(`The director asks ${corrections(count)} across ${chapters(figures.chapters ?? 0)} to raise the book: they wait for you`, `Il direttore chiede ${corrections(count)} su ${chapters(figures.chapters ?? 0)} per alzare il libro: aspettano te`),
        detail: text("Look at them, choose which to carry out, and start the autopilot again.", "Guardale, scegli quali eseguire e riavvia l'autopilot."),
      };
    case "applied":
      return {
        title: text(`${corrections(count)} of the whole book are carried out, in ${chapters(figures.chapters ?? 0)}: each chapter is revised and reviewed again, then the book is judged again`, `${corrections(count)} del libro intero vengono eseguite, in ${chapters(figures.chapters ?? 0)}: ogni capitolo viene rivisto e riletto, poi il libro viene giudicato di nuovo`),
      };
    case "none-director":
      return {
        title: text(`The director has no correction across the chapters to ask: the book got ${vote(figures.score)}, the review ends here`, `Il direttore non ha correzioni tra i capitoli da chiedere: il libro ha preso ${vote(figures.score)}, la revisione finisce qui`),
        detail: text("What is left under the target is for you to decide: read the director's last judgement of the book.", "Ciò che resta sotto l'obiettivo spetta a te: leggi l'ultimo giudizio del direttore sul libro."),
      };
    case "none-author":
      return {
        title: text(`What the director asks of the book is in chapters that are yours: nothing is changed there, the review ends here`, `Ciò che il direttore chiede al libro sta in capitoli che sono tuoi: lì non si cambia nulla, la revisione finisce qui`),
        detail: text("Include those chapters in the review to let it change them, or change them yourself.", "Includi quei capitoli nella revisione perché possa cambiarli, o cambiali tu."),
      };
    case "declined":
      return {
        title: text(`You left out every correction of the book: the review ends here`, `Hai lasciato fuori ogni correzione del libro: la revisione finisce qui`),
      };
  }
}
