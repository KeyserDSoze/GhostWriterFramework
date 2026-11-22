import { stringify } from "yaml";
import { DIRECTOR_FILE } from "../book/paths.js";
import { isItalian } from "../util/text.js";
import { clampNumber, enumValue, isEmptyValue, isMapping, listEntry, numericValue, quoted, readProfileFile } from "./read.js";

/**
 * How far the director may decide on the author's behalf during the autopilot.
 * - full: decides everything and never stops to ask.
 * - ask-on-critical: decides alone, but pauses and asks the author about critical, unresolved matters.
 * - ask-always: pauses for the author after the plan and after every chapter.
 */
export type DirectorAutonomy = "full" | "ask-on-critical" | "ask-always";

export const DIRECTOR_AUTONOMIES: DirectorAutonomy[] = ["full", "ask-on-critical", "ask-always"];

/** The autonomy a value names, whatever its case, spacing or separators (`Full`, `Ask On Critical`, `ask_always`); `null` when it names none. */
export function parseDirectorAutonomy(value: unknown): DirectorAutonomy | null {
  return enumValue(value, DIRECTOR_AUTONOMIES);
}

export interface DirectorProfile {
  name: string;
  language: string;
  /** Who the director is: voice, experience, temperament. */
  persona: string;
  autonomy: DirectorAutonomy;
  /** 1 (lenient) to 10 (merciless). */
  strictness: number;
  /** Minimum score (1-10) for a chapter to be approved without repairs. */
  approvalScore: number;
  /** Review rounds per chapter before the director closes it anyway (1-3). */
  maxReviewRounds: number;
  priorities: string[];
  taste: string[];
  redLines: string[];
  /** Simulated reader slug → weight 0 (ignore) to 3 (decisive). Missing readers weigh 1. */
  readerWeights: Record<string, number>;
  /** Vision for the book and free decision rules, in Markdown. */
  body: string;
  path: string;
  /**
   * What is wrong with the file, each problem naming it: YAML that cannot be read, a value that is not understood. Empty when
   * the file is as it says. A profile with warnings is not what the author wrote: the autopilot does not run with it, and a
   * host that saves a profile must not do it over a file that has them.
   */
  warnings?: string[];
}

/** A number of the profile: with the decimals the author wrote (up to `decimals`), a decimal comma accepted, limited to `min`-`max`. */
function clampValue(value: unknown, fallback: number, min: number, max: number, decimals: number): number {
  const parsed = numericValue(value);
  return parsed === undefined ? fallback : clampNumber(parsed, min, max, decimals);
}

export function defaultDirector(language?: string): DirectorProfile {
  if (isItalian(language)) {
    return {
      name: "Il Direttore",
      language: "it",
      persona: "Un direttore editoriale esperto, esigente ma giusto, che protegge la visione dell'autore e l'esperienza del lettore. Parla in modo diretto e motiva sempre le sue scelte.",
      autonomy: "ask-on-critical",
      strictness: 7,
      approvalScore: 7,
      maxReviewRounds: 2,
      priorities: [
        "Ogni scena deve far avanzare la storia o approfondire un personaggio",
        "Causalità chiara e motivazioni credibili",
        "Voce coerente con il profilo del ghostwriter",
        "Rispetto di canone, timeline e soglie di rivelazione dei segreti",
      ],
      taste: ["Scene concrete e sensoriali invece di riassunti", "Sottotesto nei dialoghi", "Svolte emotive guadagnate"],
      redLines: [
        "Mai rivelare un segreto prima della sua soglia di rivelazione",
        "Nessuna soluzione deus ex machina",
        "Non contraddire il canone stabilito senza una decisione esplicita dell'autore",
      ],
      readerWeights: {},
      warnings: [],
      body: [
        "# Visione",
        "",
        "Descrivi che cosa deve diventare questo libro: l'emozione che deve lasciare, le promesse che fa al lettore e i confini che non deve mai superare.",
        "",
        "# Come decido",
        "",
        "- Approvo quando il capitolo serve la storia e la voce è coerente, anche se non è perfetto.",
        "- Chiedo correzioni mirate piuttosto che riscritture complete.",
        "- Peso i lettori simulati in base alla loro rilevanza per il pubblico previsto: non inseguo ogni opinione.",
      ].join("\n"),
      path: DIRECTOR_FILE,
    };
  }
  return {
    name: "The Director",
    language: "en",
    persona: "An experienced editorial director, demanding but fair, who protects the author's vision and the reader's experience. Speaks directly and always explains the reasons behind a decision.",
    autonomy: "ask-on-critical",
    strictness: 7,
    approvalScore: 7,
    maxReviewRounds: 2,
    priorities: [
      "Every scene must move the story forward or deepen a character",
      "Clear causality and believable motivations",
      "A voice consistent with the ghostwriter profile",
      "Respect canon, timeline, and secret reveal thresholds",
    ],
    taste: ["Concrete, sensory scenes rather than summary", "Subtext in dialogue", "Earned emotional payoffs"],
    redLines: [
      "Never reveal a secret before its reveal threshold",
      "No deus ex machina resolutions",
      "Do not contradict established canon without an explicit author decision",
    ],
    readerWeights: {},
    warnings: [],
    body: [
      "# Vision",
      "",
      "Describe what this book must become: the feeling it should leave, the promises it makes to the reader, and the lines it must never cross.",
      "",
      "# How I decide",
      "",
      "- I approve when the chapter serves the story and the voice is consistent, even if it is not perfect.",
      "- I ask for targeted fixes rather than full rewrites.",
      "- I weigh simulated readers by their relevance to the intended audience: I do not chase every opinion.",
    ].join("\n"),
    path: DIRECTOR_FILE,
  };
}

/**
 * The director of a book from its `director.md`. It never throws and never hides what is wrong with the file: YAML that cannot
 * be read, a value that is not understood (an autonomy nobody knows, a score that is not a number, a list that is not one) is a
 * warning that names the file, and the value then is the default of the director, as it always was. Enumerated values are read
 * whatever their case or spacing (`autonomy: Full`), and numbers keep their decimals (`reader_weights` of 0.4, `approval_score`
 * of 7.5; a decimal comma is accepted).
 */
export function parseDirector(raw: string, fallbackLanguage?: string): DirectorProfile {
  const fallback = defaultDirector(fallbackLanguage);
  const { frontmatter, body, warnings, warn } = readProfileFile(DIRECTOR_FILE, raw);
  const text = (key: string, fallbackValue: string): string => {
    const value = frontmatter[key];
    if (typeof value === "string" && value.trim()) return value.trim();
    if (typeof value === "number" || typeof value === "boolean") return String(value);
    if (!isEmptyValue(value)) warn(`${key} is not text (${quoted(value)}): the default is used`);
    return fallbackValue;
  };
  const scale = (key: string, fallbackValue: number, min: number, max: number, decimals: number): number => {
    const value = frontmatter[key];
    if (isEmptyValue(value)) return fallbackValue;
    if (numericValue(value) === undefined) {
      warn(`${key} ${quoted(value)} is not a number from ${min} to ${max}: ${fallbackValue} is used`);
      return fallbackValue;
    }
    return clampValue(value, fallbackValue, min, max, decimals);
  };
  const list = (key: string, fallbackValue: string[]): string[] => {
    if (!(key in frontmatter)) return fallbackValue;
    const value = frontmatter[key];
    if (value === null || value === undefined) return [];
    if (typeof value === "string") return value.split(/\r?\n/).map((entry) => entry.replace(/^\s*[-*]\s*/, "").trim()).filter(Boolean);
    if (!Array.isArray(value)) {
      warn(`${key} must be a list of lines (${quoted(value)} is not one): the default lines are used`);
      return fallbackValue;
    }
    const lines: string[] = [];
    let skipped = 0;
    for (const entry of value) {
      const line = listEntry(entry);
      if (line === undefined) skipped += 1;
      else if (line !== null && line.trim()) lines.push(line.trim());
    }
    if (skipped) warn(`${skipped === 1 ? "one entry" : `${skipped} entries`} of ${key} cannot be read as a line of text and ${skipped === 1 ? "was" : "were"} left out`);
    return lines;
  };

  let autonomy = fallback.autonomy;
  if (!isEmptyValue(frontmatter.autonomy)) {
    const named = parseDirectorAutonomy(frontmatter.autonomy);
    if (named) autonomy = named;
    else warn(`autonomy ${quoted(frontmatter.autonomy)} is not one of ${DIRECTOR_AUTONOMIES.join(", ")}: ${fallback.autonomy} is used`);
  }

  const readerWeights: Record<string, number> = {};
  const weightsValue = frontmatter.reader_weights;
  if (isMapping(weightsValue)) {
    for (const [slug, weight] of Object.entries(weightsValue)) {
      if (isEmptyValue(weight)) {
        readerWeights[slug] = 1;
      } else if (numericValue(weight) === undefined) {
        warn(`the weight of ${slug} (${quoted(weight)}) is not a number from 0 to 3: 1 is used`);
        readerWeights[slug] = 1;
      } else {
        readerWeights[slug] = clampValue(weight, 1, 0, 3, 2);
      }
    }
  } else if (!isEmptyValue(weightsValue)) {
    warn(`reader_weights must give a weight for each reader (slug: number); ${quoted(weightsValue)} is not that, and every reader weighs 1`);
  }

  return {
    name: text("name", fallback.name),
    language: text("language", fallback.language),
    persona: text("persona", fallback.persona),
    autonomy,
    strictness: scale("strictness", fallback.strictness, 1, 10, 1),
    approvalScore: scale("approval_score", fallback.approvalScore, 1, 10, 1),
    maxReviewRounds: scale("max_review_rounds", fallback.maxReviewRounds, 1, 3, 0),
    priorities: list("priorities", fallback.priorities),
    taste: list("taste", fallback.taste),
    redLines: list("red_lines", fallback.redLines),
    readerWeights,
    body: body || fallback.body,
    path: DIRECTOR_FILE,
    warnings,
  };
}

export function serializeDirector(profile: DirectorProfile): string {
  const frontmatter: Record<string, unknown> = {
    type: "director",
    id: "director:main",
    name: profile.name,
    language: profile.language,
    persona: profile.persona,
    autonomy: profile.autonomy,
    strictness: clampValue(profile.strictness, 7, 1, 10, 1),
    approval_score: clampValue(profile.approvalScore, 7, 1, 10, 1),
    max_review_rounds: clampValue(profile.maxReviewRounds, 2, 1, 3, 0),
    priorities: profile.priorities,
    taste: profile.taste,
    red_lines: profile.redLines,
    reader_weights: Object.keys(profile.readerWeights).length ? profile.readerWeights : undefined,
  };
  for (const key of Object.keys(frontmatter)) if (frontmatter[key] === undefined) delete frontmatter[key];
  return `---\n${stringify(frontmatter).trimEnd()}\n---\n\n${profile.body.trim()}\n`;
}

const AUTONOMY_TEXT: Record<DirectorAutonomy, string> = {
  full: "Decide everything on the author's behalf; never stop to ask.",
  "ask-on-critical": "Decide on the author's behalf, but ask the author when a critical matter cannot be settled from the vision, canon, or constraints.",
  "ask-always": "Decide on the author's behalf, but the author reviews the plan and every chapter before the work continues.",
};

/** Compact instruction block describing the director to a model. */
export function directorPrompt(profile: DirectorProfile): string {
  const weights = Object.entries(profile.readerWeights)
    .map(([slug, weight]) => `${slug} ×${weight}`)
    .join(", ");
  return [
    `Director: ${profile.name}. ${profile.persona}`,
    `Autonomy: ${AUTONOMY_TEXT[profile.autonomy]}`,
    `Strictness: ${profile.strictness}/10. A chapter is approved without repairs only when it deserves at least ${profile.approvalScore}/10.`,
    profile.priorities.length ? `Priorities, in order:\n${profile.priorities.map((entry) => `- ${entry}`).join("\n")}` : "",
    profile.taste.length ? `Taste:\n${profile.taste.map((entry) => `- ${entry}`).join("\n")}` : "",
    profile.redLines.length ? `Red lines (never allowed):\n${profile.redLines.map((entry) => `- ${entry}`).join("\n")}` : "",
    weights ? `Weight of simulated readers (0 ignore, 1 normal, 3 decisive): ${weights}.` : "",
    profile.body.trim() ? `Vision and decision rules:\n${profile.body.trim()}` : "",
  ].filter(Boolean).join("\n\n");
}
