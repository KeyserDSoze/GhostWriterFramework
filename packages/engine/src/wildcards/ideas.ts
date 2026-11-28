import type { AiJsonSchema } from "../ai/types.js";
import type { WildcardGroup, WildcardProfile } from "../profiles/wildcards.js";

/**
 * What the room gives: ideas (from the provocateurs) and findings (from the sentinels). Every record is advisory: it never carries a score, nothing reads
 * it to gate a step, and it is applied only when somebody decides so (the Director triages in the autopilot, the author accepts or skips in the table).
 */

export const WILDCARD_RECORD_VERSION = 1;

/** A short id that is always the same for the same text (two FNV-1a hashes of 32 bits): an idea keeps its id when its consultation is read again. */
export function wildcardStableId(text: string): string {
  const hash = (seed: number) => {
    let value = seed >>> 0;
    for (let index = 0; index < text.length; index += 1) {
      value ^= text.charCodeAt(index);
      value = Math.imul(value, 0x01000193) >>> 0;
    }
    return value.toString(16).padStart(8, "0");
  };
  return `${hash(0x811c9dc5)}${hash(0x9747b28c)}`;
}

export type WildcardRecordKind = "idea" | "finding";

/** What a consultation was about: a passage, a scene, a chapter, the book, the plan of a design run, or a conversation (Brainstorming). */
export type WildcardTargetKind = "selection" | "paragraph" | "chapter" | "book" | "plan" | "conversation";
export const WILDCARD_TARGET_KINDS: readonly WildcardTargetKind[] = ["selection", "paragraph", "chapter", "book", "plan", "conversation"];

export interface WildcardTarget {
  kind: WildcardTargetKind;
  /** How a person names it: «Chapter 3: The harbour», «the selection in scene 2». */
  label: string;
  /** The chapter it is in, or the one it is about (a selection, a scene, a chapter). */
  chapter?: number;
  paragraph?: number;
}

export type WildcardSeverity = "minor" | "major" | "critical";
export const WILDCARD_SEVERITIES: readonly WildcardSeverity[] = ["minor", "major", "critical"];

export type WildcardVerdict = "adopted" | "adapted" | "rejected";
export const WILDCARD_VERDICTS: readonly WildcardVerdict[] = ["adopted", "adapted", "rejected"];

/** Who decided: the Director in the autopilot, or the author in the table of the ideas. */
export type WildcardDecider = "director" | "author";

export interface WildcardDecision {
  verdict: WildcardVerdict;
  /** Why, in one or two sentences: always said, also for an adoption. */
  reason: string;
  by: WildcardDecider;
  /** ISO time. */
  at: string;
  /** For `adapted`: the version of the idea that was kept. */
  adaptation?: string;
}

export interface WildcardIdea {
  id: string;
  kind: WildcardRecordKind;
  persona: { id: string; slug: string; name: string; group: WildcardGroup };
  /** A headline of a few words. */
  title: string;
  /** The idea itself, or the problem the finding is about. */
  idea: string;
  /** Why it works (an idea), or why it matters (a finding). */
  why: string;
  /** What adopting it changes: the chapters and secrets it touches, in words. */
  changes: { chapters: number[]; secrets: string[]; summary: string };
  /** What could go wrong, or what it costs. */
  risk: string;
  /** How far it goes, 1–10. */
  audacity: number;
  /** A finding: the passage it is about, quoted or located. */
  evidence?: string;
  severity?: WildcardSeverity;
  /** Always true: what the room says advises, and never gates anything. */
  advisory: true;
  decision?: WildcardDecision;
}

/** Ideas a voice may give in one consultation, and the longest text of one of their fields. */
export const WILDCARD_MAX_IDEAS_PER_VOICE = 6;
const FIELD_CHARS = 1200;
const TITLE_CHARS = 140;

/** The reply of one voice: its ideas (or findings) and an optional note. */
export const WILDCARD_IDEAS_TOOL: AiJsonSchema = {
  name: "wildcard_ideas",
  description: "Return the ideas (or findings) of this wildcard about the text, each one advisory: never a score.",
  parameters: {
    type: "object",
    properties: {
      items: {
        type: "array",
        description: `At most ${WILDCARD_MAX_IDEAS_PER_VOICE} items, the best first.`,
        items: {
          type: "object",
          properties: {
            title: { type: "string", description: "A headline of a few words." },
            idea: { type: "string", description: "The idea itself, or the problem found." },
            why: { type: "string", description: "Why it works, or why it matters." },
            changes: { type: "string", description: "What adopting it changes in the book, in one sentence." },
            chapters: { type: "array", items: { type: "number" }, description: "The chapters it touches, by number." },
            secrets: { type: "array", items: { type: "string" }, description: "The secrets it touches, by name (only secrets you were told)." },
            risk: { type: "string", description: "What could go wrong, or what it costs." },
            audacity: { type: "number", minimum: 1, maximum: 10 },
            evidence: { type: "string", description: "For a finding: the passage it is about, quoted or located." },
            severity: { type: "string", enum: ["minor", "major", "critical"], description: "For a finding." },
          },
          required: ["title", "idea", "why", "changes", "risk", "audacity"],
        },
      },
      note: { type: "string", description: "Anything the room should know about this reply (optional)." },
    },
    required: ["items"],
  },
};

function record(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};
}

function field(value: unknown, max = FIELD_CHARS): string {
  const text = typeof value === "string" ? value : typeof value === "number" ? String(value) : "";
  const clean = text.replace(/\s+/g, " ").trim();
  return clean.length > max ? `${clean.slice(0, max - 1).trimEnd()}…` : clean;
}

function chapterNumbers(value: unknown): number[] {
  const list = Array.isArray(value) ? value : typeof value === "number" || typeof value === "string" ? [value] : [];
  const numbers = list.map((entry) => (typeof entry === "number" ? entry : Number.parseInt(String(entry).replace(/^\D+/, ""), 10))).filter((entry) => Number.isSafeInteger(entry) && entry > 0 && entry < 100_000);
  return [...new Set(numbers)].sort((left, right) => left - right).slice(0, 40);
}

function names(value: unknown): string[] {
  const list = Array.isArray(value) ? value : typeof value === "string" ? value.split(",") : [];
  return [...new Set(list.map((entry) => field(entry, 120)).filter(Boolean))].slice(0, 20);
}

/** What reading the reply of a voice found: its records, the ones left out (and why), and whether more were given than are kept. */
export interface WildcardReplyReading {
  ideas: WildcardIdea[];
  /** Items that were not records (no idea, no title): left out, and counted. */
  invalid: number;
  /** Records beyond `WILDCARD_MAX_IDEAS_PER_VOICE`: never dropped in silence. */
  omitted: number;
  note?: string;
}

/**
 * The reply of one voice as records: each item with an idea is kept (a missing title is made from the idea, a missing «why» or «risk» stays empty, an
 * audacity out of range is brought into it, chapters are read from numbers or from «chapter 3»), each item without an idea is counted as invalid, and
 * what is beyond the cap is counted as omitted. A sentinel's records are findings. Never throws.
 */
export function readWildcardReply(value: unknown, persona: WildcardProfile, input: { target: WildcardTarget; consultation: string; max?: number }): WildcardReplyReading {
  const source = record(value);
  const items = Array.isArray(source.items) ? source.items : Array.isArray(value) ? value as unknown[] : [];
  const max = Math.max(1, Math.min(WILDCARD_MAX_IDEAS_PER_VOICE, input.max ?? WILDCARD_MAX_IDEAS_PER_VOICE));
  const ideas: WildcardIdea[] = [];
  let invalid = 0;
  let omitted = 0;
  const kind: WildcardRecordKind = persona.group === "sentinel" ? "finding" : "idea";
  for (const item of items) {
    const entry = record(item);
    const idea = field(entry.idea ?? entry.text ?? entry.finding ?? entry.description);
    if (!idea) {
      invalid += 1;
      continue;
    }
    if (ideas.length >= max) {
      omitted += 1;
      continue;
    }
    const title = field(entry.title, TITLE_CHARS) || field(idea, 60);
    const audacityRead = typeof entry.audacity === "number" ? entry.audacity : Number.parseFloat(String(entry.audacity ?? ""));
    const audacity = Number.isFinite(audacityRead) ? Math.min(10, Math.max(1, Math.round(audacityRead))) : persona.audacity;
    const severityText = field(entry.severity, 20).toLowerCase();
    const severity = kind === "finding" ? (["minor", "major", "critical"] as const).find((level) => level === severityText) : undefined;
    const evidence = field(entry.evidence);
    const changes = typeof entry.changes === "object" && entry.changes ? record(entry.changes) : {};
    ideas.push({
      id: `idea-${wildcardStableId(`${input.consultation}\n${persona.id}\n${ideas.length}\n${title}`)}`,
      kind,
      persona: { id: persona.id, slug: persona.slug, name: persona.name, group: persona.group },
      title,
      idea,
      why: field(entry.why),
      changes: {
        chapters: chapterNumbers(entry.chapters ?? changes.chapters),
        secrets: names(entry.secrets ?? changes.secrets),
        summary: field(typeof entry.changes === "string" ? entry.changes : changes.summary),
      },
      risk: field(entry.risk),
      audacity,
      ...(evidence ? { evidence } : {}),
      ...(severity ? { severity } : {}),
      advisory: true,
    });
  }
  const note = field(source.note);
  return { ideas, invalid, omitted, ...(note ? { note } : {}) };
}

/** Whether a decision says to use the idea (adopted as it is, or adapted). */
export function isAcceptedDecision(decision: WildcardDecision | undefined): boolean {
  return decision?.verdict === "adopted" || decision?.verdict === "adapted";
}
