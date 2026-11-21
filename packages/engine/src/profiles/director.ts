import { parseDocument, stringify } from "yaml";
import { DIRECTOR_FILE } from "../book/paths.js";
import { isItalian } from "../util/text.js";

/**
 * How far the director may decide on the author's behalf during the autopilot.
 * - full: decides everything and never stops to ask.
 * - ask-on-critical: decides alone, but pauses and asks the author about critical, unresolved matters.
 * - ask-always: pauses for the author after the plan and after every chapter.
 */
export type DirectorAutonomy = "full" | "ask-on-critical" | "ask-always";

export const DIRECTOR_AUTONOMIES: DirectorAutonomy[] = ["full", "ask-on-critical", "ask-always"];

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
}

function clampInteger(value: unknown, fallback: number, min: number, max: number): number {
  const parsed = typeof value === "number" ? value : typeof value === "string" ? Number(value) : Number.NaN;
  return Number.isFinite(parsed) ? Math.min(max, Math.max(min, Math.round(parsed))) : fallback;
}

function stringList(value: unknown): string[] {
  if (Array.isArray(value)) return value.map((entry) => String(entry).trim()).filter(Boolean);
  if (typeof value === "string" && value.trim()) return value.split(/\r?\n/).map((entry) => entry.replace(/^\s*[-*]\s*/, "").trim()).filter(Boolean);
  return [];
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

export function parseDirector(raw: string, fallbackLanguage?: string): DirectorProfile {
  const fallback = defaultDirector(fallbackLanguage);
  const match = /^---\r?\n([\s\S]*?)\r?\n---\r?\n?([\s\S]*)$/.exec(raw ?? "");
  let frontmatter: Record<string, unknown> = {};
  if (match) {
    try {
      const parsed = parseDocument(match[1]).toJSON() as unknown;
      if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) frontmatter = parsed as Record<string, unknown>;
    } catch {
      frontmatter = {};
    }
  }
  const text = (key: string, fallbackValue: string) => typeof frontmatter[key] === "string" && String(frontmatter[key]).trim() ? String(frontmatter[key]).trim() : fallbackValue;
  const autonomy = text("autonomy", fallback.autonomy) as DirectorAutonomy;
  const weightsSource = frontmatter.reader_weights && typeof frontmatter.reader_weights === "object" && !Array.isArray(frontmatter.reader_weights)
    ? frontmatter.reader_weights as Record<string, unknown>
    : {};
  const readerWeights: Record<string, number> = {};
  for (const [slug, weight] of Object.entries(weightsSource)) readerWeights[slug] = clampInteger(weight, 1, 0, 3);
  const body = match ? match[2].trim() : (raw ?? "").trim();
  return {
    name: text("name", fallback.name),
    language: text("language", fallback.language),
    persona: text("persona", fallback.persona),
    autonomy: DIRECTOR_AUTONOMIES.includes(autonomy) ? autonomy : fallback.autonomy,
    strictness: clampInteger(frontmatter.strictness, fallback.strictness, 1, 10),
    approvalScore: clampInteger(frontmatter.approval_score, fallback.approvalScore, 1, 10),
    maxReviewRounds: clampInteger(frontmatter.max_review_rounds, fallback.maxReviewRounds, 1, 3),
    priorities: "priorities" in frontmatter ? stringList(frontmatter.priorities) : fallback.priorities,
    taste: "taste" in frontmatter ? stringList(frontmatter.taste) : fallback.taste,
    redLines: "red_lines" in frontmatter ? stringList(frontmatter.red_lines) : fallback.redLines,
    readerWeights,
    body: body || fallback.body,
    path: DIRECTOR_FILE,
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
    strictness: clampInteger(profile.strictness, 7, 1, 10),
    approval_score: clampInteger(profile.approvalScore, 7, 1, 10),
    max_review_rounds: clampInteger(profile.maxReviewRounds, 2, 1, 3),
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
