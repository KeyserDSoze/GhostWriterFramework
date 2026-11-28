import { stringify } from "yaml";
import { BRAINSTORMER_FILE } from "../book/paths.js";
import { isItalian } from "../util/text.js";
import { clampNumber, isEmptyValue, listEntry, numericValue, quoted, readProfileFile } from "./read.js";

/**
 * The Brainstormer of the writers' room (`brainstormer.md`): the agent that generates the ideas of a design run, develops the structure of the book and revises the design
 * of its chapters, as a co-author. Like the director, the readers and the ghostwriters it has a personality the author configures, and the design run keeps it: the pitches
 * it proposes, the foundation and the chapters it designs, and the weak parts it rewrites are written in its voice.
 */
export interface BrainstormerProfile {
  name: string;
  language: string;
  /** Who the brainstormer is: voice, temperament, how it argues. */
  persona: string;
  /** 1 (it keeps to what the genre expects) to 10 (it questions the premise and proposes what nobody expects). */
  boldness: number;
  /** What it cares about when it designs a book, in order. */
  priorities: string[];
  /** Clichés and devices it refuses. */
  avoid: string[];
  /** Notes of method and free rules, in Markdown. */
  body: string;
  path: string;
  /**
   * What is wrong with the file, each problem naming it: YAML that cannot be read, a value that is not understood. Empty when the file is as it says. A profile with
   * warnings is not what the author wrote: the autopilot does not run a design with it, and a host that saves a profile must not do it over a file that has them.
   */
  warnings?: string[];
}

/** The boldness a profile has when it says none. */
export const BRAINSTORMER_DEFAULT_BOLDNESS = 6;

export function defaultBrainstormer(language?: string): BrainstormerProfile {
  if (isItalian(language)) {
    return {
      name: "Il Brainstormer",
      language: "it",
      persona: "Un co-autore curioso e coraggioso, che prende sul serio l'idea dell'autore e per questo la mette alla prova: propone alternative, cerca il punto debole della trama e non si accontenta della prima soluzione.",
      boldness: BRAINSTORMER_DEFAULT_BOLDNESS,
      priorities: [
        "Una premessa che si possa dire in una frase e che nessun altro libro ha",
        "Causalità chiara: ogni capitolo nasce da quello prima e cambia qualcosa",
        "Segreti con indizi prima della rivelazione e conseguenze dopo",
        "Personaggi guidati da un desiderio e da una paura",
      ],
      avoid: ["Coincidenze che risolvono i problemi", "Il mentore che muore al momento giusto", "Capitoli che ripetono la forma di quello prima"],
      warnings: [],
      body: [
        "# Metodo",
        "",
        "- Prima di scegliere una strada, ne propongo almeno un'altra e dico perché preferisco la prima.",
        "- Quando l'autore ha già deciso qualcosa, lo arricchisco: non lo contraddico.",
        "- Dico apertamente cosa mi sembra prevedibile.",
      ].join("\n"),
      path: BRAINSTORMER_FILE,
    };
  }
  return {
    name: "The Brainstormer",
    language: "en",
    persona: "A curious and daring co-author who takes the author's idea seriously and so puts it to the test: proposes alternatives, looks for the weak point of the plot and is never satisfied with the first solution.",
    boldness: BRAINSTORMER_DEFAULT_BOLDNESS,
    priorities: [
      "A premise that can be said in one sentence and that no other book has",
      "Clear causality: every chapter comes from the one before and changes something",
      "Secrets with clues before the reveal and consequences after",
      "Characters driven by a desire and a fear",
    ],
    avoid: ["Coincidences that solve problems", "The mentor who dies at the right moment", "Chapters that repeat the shape of the one before"],
    warnings: [],
    body: [
      "# Method",
      "",
      "- Before I choose a road I propose at least one other, and say why I prefer the first.",
      "- When the author has decided something I enrich it: I do not contradict it.",
      "- I say openly what looks predictable to me.",
    ].join("\n"),
    path: BRAINSTORMER_FILE,
  };
}

/**
 * The brainstormer of a book from its `brainstormer.md`. It never throws and never hides what is wrong with the file: YAML that cannot be read, a value that is not
 * understood (a boldness that is not a number, a list that is not one) is a warning that names the file, and the value then is the default, as the director's is.
 */
export function parseBrainstormer(raw: string, fallbackLanguage?: string): BrainstormerProfile {
  const fallback = defaultBrainstormer(fallbackLanguage);
  const { frontmatter, body, warnings, warn } = readProfileFile(BRAINSTORMER_FILE, raw);
  const text = (key: string, fallbackValue: string): string => {
    const value = frontmatter[key];
    if (typeof value === "string" && value.trim()) return value.trim();
    if (typeof value === "number" || typeof value === "boolean") return String(value);
    if (!isEmptyValue(value)) warn(`${key} is not text (${quoted(value)}): the default is used`);
    return fallbackValue;
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
  let boldness = fallback.boldness;
  const value = frontmatter.boldness;
  if (!isEmptyValue(value)) {
    const parsed = numericValue(value);
    if (parsed === undefined) warn(`boldness ${quoted(value)} is not a number from 1 to 10: ${fallback.boldness} is used`);
    else boldness = clampNumber(parsed, 1, 10, 0);
  }
  return {
    name: text("name", fallback.name),
    language: text("language", fallback.language),
    persona: text("persona", fallback.persona),
    boldness,
    priorities: list("priorities", fallback.priorities),
    avoid: list("avoid", fallback.avoid),
    body: body || fallback.body,
    path: BRAINSTORMER_FILE,
    warnings,
  };
}

export function serializeBrainstormer(profile: BrainstormerProfile): string {
  const frontmatter: Record<string, unknown> = {
    type: "brainstormer",
    id: "brainstormer:main",
    name: profile.name,
    language: profile.language,
    persona: profile.persona,
    boldness: clampNumber(profile.boldness, 1, 10, 0),
    priorities: profile.priorities,
    avoid: profile.avoid,
  };
  for (const key of Object.keys(frontmatter)) if (frontmatter[key] === undefined) delete frontmatter[key];
  return `---\n${stringify(frontmatter).trimEnd()}\n---\n\n${profile.body.trim()}\n`;
}

/** The four ways a boldness reads: what a host says of the value, and what the prompt asks. */
export type BrainstormerBoldnessBand = "prudent" | "balanced" | "daring" | "breaking";

const BOLDNESS_TEXT: ReadonlyArray<{ upTo: number; band: BrainstormerBoldnessBand; text: string }> = [
  { upTo: 3, band: "prudent", text: "keep to what the genre and the author's idea expect: refine, never risk the premise." },
  { upTo: 6, band: "balanced", text: "balance: keep what the idea needs and take a risk where it makes the book better." },
  { upTo: 8, band: "daring", text: "dare: question the premise, propose what the reader does not expect, accept a risk the author did not ask for." },
  { upTo: 10, band: "breaking", text: "break the expected: propose the version nobody would write, and defend it." },
];

const boldnessBand = (boldness: number) => BOLDNESS_TEXT.find((band) => boldness <= band.upTo) ?? BOLDNESS_TEXT[BOLDNESS_TEXT.length - 1];

/** Which of the four ways a boldness reads: 1 to 3 prudent, 4 to 6 balanced, 7 and 8 daring, 9 and 10 breaking. */
export function brainstormerBoldnessBand(boldness: number): BrainstormerBoldnessBand {
  return boldnessBand(boldness).band;
}

/** What a boldness asks of the brainstormer, in a sentence for a prompt. */
export function brainstormerBoldnessText(boldness: number): string {
  return boldnessBand(boldness).text;
}

/** Compact instruction block describing the brainstormer to a model. */
export function brainstormerPrompt(profile: BrainstormerProfile): string {
  return [
    `Brainstormer: ${profile.name}. ${profile.persona}`,
    `Boldness: ${profile.boldness}/10 — ${brainstormerBoldnessText(profile.boldness)}`,
    profile.priorities.length ? `Priorities, in order:\n${profile.priorities.map((entry) => `- ${entry}`).join("\n")}` : "",
    profile.avoid.length ? `Never (clichés and devices you refuse):\n${profile.avoid.map((entry) => `- ${entry}`).join("\n")}` : "",
    profile.body.trim() ? `Method:\n${profile.body.trim()}` : "",
  ].filter(Boolean).join("\n\n");
}
