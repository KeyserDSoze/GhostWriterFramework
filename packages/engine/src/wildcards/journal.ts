import { Document, parseDocument } from "yaml";
import { WILDCARD_SEVERITIES, WILDCARD_TARGET_KINDS, WILDCARD_VERDICTS, type WildcardDecider, type WildcardDecision, type WildcardIdea, type WildcardTarget } from "./ideas.js";
import type { WildcardGroup } from "../profiles/wildcards.js";

/**
 * The journal of the room (`bible/ideas.yml`, in the Story Bible): every consultation of the wildcards, with what each voice gave and what was decided of
 * it (adopted, adapted or rejected, why, and by whom: the Director in the autopilot, the author in the table of the ideas). It is the readable history and
 * a memory: the room is told the ideas already rejected, so that it does not give them again; nothing decides from it, and a book without it loses only
 * its history.
 *
 * - One entry a consultation: `id`, `at`, `by` (who asked: the author, the Copilot, Brainstorming, the autopilot), the target, the voices, the ideas.
 * - Mergeable: two copies are one by putting their consultations together (by `id`), and an idea that two copies decided keeps the latest decision.
 * - Versioned and kind to what comes later: the file says `version`; a key this version does not know, in a consultation or in an idea, is kept and
 *   written back as it was.
 * - Small: the consultations of the last `IDEAS_JOURNAL_KEEP_DAYS` days, at most the newest `IDEAS_JOURNAL_MAX_ENTRIES`, each with at most
 *   `IDEAS_JOURNAL_MAX_IDEAS` ideas.
 */

export const IDEAS_JOURNAL_FILE = "bible/ideas.yml";
export const IDEAS_JOURNAL_VERSION = 1;
export const IDEAS_JOURNAL_KEEP_DAYS = 365;
export const IDEAS_JOURNAL_MAX_ENTRIES = 300;
export const IDEAS_JOURNAL_MAX_IDEAS = 40;

export type IdeasJournalAuthor = "author" | "copilot" | "brainstorming" | "autopilot";
export const IDEAS_JOURNAL_AUTHORS: readonly IdeasJournalAuthor[] = ["author", "copilot", "brainstorming", "autopilot"];

export interface IdeasJournalEntry {
  id: string;
  at: string;
  by: IdeasJournalAuthor;
  target: WildcardTarget;
  /** The preset the voices came from, when they did. */
  preset?: string;
  /** The slugs of the voices asked. */
  voices: string[];
  ideas: WildcardIdea[];
  /** Keys this version does not know, kept. */
  extra?: Record<string, unknown>;
}

export interface IdeasJournal {
  entries: IdeasJournalEntry[];
}

const DAY_MS = 86_400_000;
const ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,99}$/;
const ENTRY_KEYS = new Set(["id", "at", "by", "target", "preset", "voices", "ideas"]);
const IDEA_KEYS = new Set(["id", "kind", "persona", "title", "idea", "why", "changes", "risk", "audacity", "evidence", "severity", "advisory", "decision"]);

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function text(value: unknown, max = 2000): string {
  if (typeof value !== "string") return typeof value === "number" ? String(value) : "";
  const clean = value.trim();
  return clean.length > max ? `${clean.slice(0, max - 1).trimEnd()}…` : clean;
}

function moment(value: unknown): string | undefined {
  const raw = value instanceof Date ? value.toISOString() : typeof value === "string" ? value.trim() : "";
  const time = raw ? Date.parse(raw) : Number.NaN;
  return Number.isFinite(time) ? new Date(time).toISOString() : undefined;
}

function oneOf<T extends string>(value: unknown, allowed: readonly T[]): T | undefined {
  return typeof value === "string" ? allowed.find((entry) => entry === value) : undefined;
}

function extraOf(source: Record<string, unknown>, known: ReadonlySet<string>): Record<string, unknown> | undefined {
  const extra = Object.fromEntries(Object.entries(source).filter(([key]) => !known.has(key)));
  return Object.keys(extra).length ? extra : undefined;
}

function readDecision(value: unknown): WildcardDecision | undefined {
  if (!isRecord(value)) return undefined;
  const verdict = oneOf(value.verdict, WILDCARD_VERDICTS);
  const by = oneOf<WildcardDecider>(value.by, ["director", "author"]);
  const at = moment(value.at);
  if (!verdict || !by || !at) return undefined;
  const adaptation = text(value.adaptation);
  return { verdict, reason: text(value.reason), by, at, ...(adaptation ? { adaptation } : {}) };
}

function readTarget(value: unknown): WildcardTarget | undefined {
  if (!isRecord(value)) return undefined;
  const kind = oneOf(value.kind, WILDCARD_TARGET_KINDS);
  if (!kind) return undefined;
  const chapter = typeof value.chapter === "number" && Number.isSafeInteger(value.chapter) && value.chapter > 0 ? value.chapter : undefined;
  const paragraph = typeof value.paragraph === "number" && Number.isSafeInteger(value.paragraph) && value.paragraph > 0 ? value.paragraph : undefined;
  return { kind, label: text(value.label, 200), ...(chapter ? { chapter } : {}), ...(paragraph ? { paragraph } : {}) };
}

function readIdea(value: unknown): (WildcardIdea & { extra?: Record<string, unknown> }) | null {
  if (!isRecord(value)) return null;
  const id = typeof value.id === "string" && ID.test(value.id) ? value.id : undefined;
  const idea = text(value.idea);
  const persona = isRecord(value.persona) ? value.persona : {};
  const group = oneOf<WildcardGroup>(persona.group, ["provocateur", "sentinel"]);
  if (!id || !idea || !group) return null;
  const changes = isRecord(value.changes) ? value.changes : {};
  const severity = oneOf(value.severity, WILDCARD_SEVERITIES);
  const decision = readDecision(value.decision);
  const evidence = text(value.evidence);
  const audacity = typeof value.audacity === "number" && Number.isFinite(value.audacity) ? Math.min(10, Math.max(1, Math.round(value.audacity))) : 5;
  const extra = extraOf(value, IDEA_KEYS);
  return {
    id,
    kind: value.kind === "finding" ? "finding" : "idea",
    persona: { id: text(persona.id, 200), slug: text(persona.slug, 120), name: text(persona.name, 200), group },
    title: text(value.title, 200),
    idea,
    why: text(value.why),
    changes: {
      chapters: Array.isArray(changes.chapters) ? changes.chapters.filter((entry): entry is number => typeof entry === "number" && Number.isSafeInteger(entry) && entry > 0).slice(0, 40) : [],
      secrets: Array.isArray(changes.secrets) ? changes.secrets.map((entry) => text(entry, 120)).filter(Boolean).slice(0, 20) : [],
      summary: text(changes.summary),
    },
    risk: text(value.risk),
    audacity,
    ...(evidence ? { evidence } : {}),
    ...(severity ? { severity } : {}),
    advisory: true,
    ...(decision ? { decision } : {}),
    ...(extra ? { extra } : {}),
  };
}

function readEntry(value: unknown): IdeasJournalEntry | null {
  if (!isRecord(value)) return null;
  const id = typeof value.id === "string" && ID.test(value.id) ? value.id : undefined;
  const at = moment(value.at);
  const by = oneOf(value.by, IDEAS_JOURNAL_AUTHORS);
  const target = readTarget(value.target);
  if (!id || !at || !by || !target) return null;
  const ideas = Array.isArray(value.ideas) ? value.ideas.map(readIdea).filter((entry): entry is WildcardIdea => entry !== null).slice(0, IDEAS_JOURNAL_MAX_IDEAS) : [];
  const voices = Array.isArray(value.voices) ? value.voices.map((entry) => text(entry, 120)).filter(Boolean).slice(0, 20) : [];
  const preset = text(value.preset, 60);
  const extra = extraOf(value, ENTRY_KEYS);
  return { id, at, by, target, ...(preset ? { preset } : {}), voices, ideas, ...(extra ? { extra } : {}) };
}

/** The journal as the file says it, read tolerantly: a file that is not YAML is an empty journal, an entry or an idea that is not one is left out. Never throws. */
export function parseIdeasJournal(raw: string | null | undefined): IdeasJournal {
  if (!raw?.trim()) return { entries: [] };
  let data: unknown;
  try {
    const document = parseDocument(raw, { uniqueKeys: false, prettyErrors: false });
    if (document.errors.length) return { entries: [] };
    data = document.toJS({ maxAliasCount: 0 });
  } catch {
    return { entries: [] };
  }
  const entries = isRecord(data) && Array.isArray(data.entries) ? data.entries.map(readEntry).filter((entry): entry is IdeasJournalEntry => entry !== null) : [];
  return { entries: ordered(entries) };
}

function later(left: WildcardDecision | undefined, right: WildcardDecision | undefined): WildcardDecision | undefined {
  if (!left) return right;
  if (!right) return left;
  return right.at > left.at ? right : left;
}

/** The entries by `id` in order of time; two copies of one entry are one, their ideas put together, each keeping its latest decision. */
function ordered(entries: IdeasJournalEntry[]): IdeasJournalEntry[] {
  const byId = new Map<string, IdeasJournalEntry>();
  for (const entry of entries) {
    const known = byId.get(entry.id);
    if (!known) {
      byId.set(entry.id, { ...entry, ideas: [...entry.ideas] });
      continue;
    }
    const ideas = new Map(known.ideas.map((idea) => [idea.id, idea]));
    for (const idea of entry.ideas) {
      const before = ideas.get(idea.id);
      const decision = later(before?.decision, idea.decision);
      ideas.set(idea.id, { ...(before ?? idea), ...(decision ? { decision } : {}) });
    }
    byId.set(entry.id, { ...known, ideas: [...ideas.values()].slice(0, IDEAS_JOURNAL_MAX_IDEAS) });
  }
  return [...byId.values()].sort((left, right) => (left.at < right.at ? -1 : left.at > right.at ? 1 : left.id.localeCompare(right.id)));
}

/** Two copies of the journal (or more) as one: every consultation once, every idea with its latest decision. */
export function mergeIdeasJournals(...journals: ReadonlyArray<IdeasJournal | string | null | undefined>): IdeasJournal {
  const read = journals.map((journal) => (typeof journal === "object" && journal !== null ? journal : parseIdeasJournal(journal)));
  return { entries: ordered(read.flatMap((journal) => journal.entries)) };
}

/** The consultations the journal keeps at `now`: those of the last `IDEAS_JOURNAL_KEEP_DAYS` days, at most the newest `IDEAS_JOURNAL_MAX_ENTRIES`. */
export function pruneIdeasJournal(journal: IdeasJournal, now: Date = new Date()): IdeasJournal {
  const oldest = now.getTime() - IDEAS_JOURNAL_KEEP_DAYS * DAY_MS;
  return { entries: ordered(journal.entries).filter((entry) => Date.parse(entry.at) >= oldest).slice(-IDEAS_JOURNAL_MAX_ENTRIES) };
}

const HEADER = [
  " The journal of the room: every consultation of the wildcards (Fuori dal coro), what each voice proposed and what was decided of it.",
  ` Narrarium writes it with every consultation and keeps the last ${IDEAS_JOURNAL_KEEP_DAYS} days (at most ${IDEAS_JOURNAL_MAX_ENTRIES} consultations).`,
  " Nothing here is applied by itself, and nothing decides from it: deleting it loses only the history.",
].join("\n");

function writeIdea(idea: WildcardIdea & { extra?: Record<string, unknown> }): Record<string, unknown> {
  return {
    id: idea.id,
    kind: idea.kind,
    persona: idea.persona,
    title: idea.title,
    idea: idea.idea,
    why: idea.why,
    changes: idea.changes,
    risk: idea.risk,
    audacity: idea.audacity,
    ...(idea.evidence ? { evidence: idea.evidence } : {}),
    ...(idea.severity ? { severity: idea.severity } : {}),
    advisory: true,
    ...(idea.decision ? { decision: { ...idea.decision } } : {}),
    ...(idea.extra ?? {}),
  };
}

export function serializeIdeasJournal(journal: IdeasJournal): string {
  const data = {
    version: IDEAS_JOURNAL_VERSION,
    entries: journal.entries.map((entry) => ({
      id: entry.id,
      at: entry.at,
      by: entry.by,
      target: entry.target,
      ...(entry.preset ? { preset: entry.preset } : {}),
      voices: entry.voices,
      ideas: entry.ideas.map(writeIdea),
      ...(entry.extra ?? {}),
    })),
  };
  const document = new Document(data);
  document.commentBefore = HEADER;
  return document.toString({ lineWidth: 0 });
}

/** The journal text with `entry` in it (a new consultation, or decisions on one already there), pruned at `now`. */
export function appendIdeasJournal(raw: string | null | undefined, entry: IdeasJournalEntry, now: Date = new Date()): string {
  return serializeIdeasJournal(pruneIdeasJournal(mergeIdeasJournals(raw, { entries: [entry] }), now));
}

/** The ideas the room gave and somebody rejected, newest first, for the room to be told not to give them again. */
export function rejectedIdeas(journal: IdeasJournal, max = 20): string[] {
  const rejected = journal.entries.flatMap((entry) => entry.ideas.filter((idea) => idea.decision?.verdict === "rejected").map((idea) => ({ at: idea.decision!.at, title: idea.title || idea.idea })));
  return rejected.sort((left, right) => (left.at < right.at ? 1 : -1)).slice(0, max).map((entry) => entry.title);
}
