import { parseMarkdown, renderMarkdown } from "../markdown/frontmatter.js";
import { sha256Hex } from "../util/hash.js";
import { clipText, isItalian, truncate } from "../util/text.js";
import { chapterNumberFromSlug } from "./paths.js";

/**
 * The design of a book, as its files keep it: the design of every chapter of the Synopsis (`design:` of an entry), the ledger of every secret, the files of
 * `bible/`, and the checks that need no model. One module, for the outline loads it: an app that shows the Synopsis has all of it at once.
 */

// ─── The design of a chapter of the Synopsis ────────────────────────────────

/**
 * The design of a chapter of the outline (`design:` in the frontmatter of `outline/chapters/<NNN>.md`): what a writer needs to write the chapter
 * later, never its prose. Every field is optional, and an entry without `design` is an entry as it always was. The design run of the autopilot
 * (`StartOptions.design`) writes it for the entries it owns; the author edits it in the Synopsis; the Brainstorming proposes it.
 *
 * Read softly: a field of the wrong kind is said (`design-invalid`) and left out of what the engine reads, a list may be one line, and a key the
 * engine does not know (a newer version's, or the author's own) is kept as it is in the file, and counts in the fingerprint of the entry.
 */
export interface OutlineChapterDesign {
  /** The narrative goal: why the chapter exists. */
  goal?: string;
  /** The point-of-view characters. */
  pov?: string[];
  /** The characters on stage. */
  characters?: string[];
  /** Where it happens. */
  setting?: string;
  /** When it happens: its place in the time of the story. */
  time?: string;
  /** The main events, in order. */
  events?: string[];
  /** The scenes it is expected to have, a line each. */
  scenes?: string[];
  conflicts?: string[];
  /** How the characters change inside, through the chapter. */
  emotions?: string;
  /** What the reader learns (a secret may be named by its id, `secret:<slug>`, or its title). */
  reveals?: string[];
  /** What is kept from the reader. */
  withholds?: string[];
  /** The clues and the foreshadowing it plants. */
  clues?: string[];
  /** What it picks up from the chapters before. */
  previous?: string;
  /** What it sets up for the chapters after. */
  next?: string;
  /** How it closes. */
  ending?: string;
  /** Whether it closes on a cliffhanger. */
  cliffhanger?: boolean;
  /** Notes for the ghostwriter who will write it. */
  notes?: string;
}

export type OutlineDesignKey = keyof OutlineChapterDesign;
type FieldKind = "text" | "list" | "flag";

/** The fields of a design, in the order the files, the prompts and the interfaces show them. */
export const OUTLINE_DESIGN_FIELDS: ReadonlyArray<{ key: OutlineDesignKey; kind: FieldKind }> = Object.freeze([
  { key: "goal", kind: "text" },
  { key: "pov", kind: "list" },
  { key: "characters", kind: "list" },
  { key: "setting", kind: "text" },
  { key: "time", kind: "text" },
  { key: "events", kind: "list" },
  { key: "scenes", kind: "list" },
  { key: "conflicts", kind: "list" },
  { key: "emotions", kind: "text" },
  { key: "reveals", kind: "list" },
  { key: "withholds", kind: "list" },
  { key: "clues", kind: "list" },
  { key: "previous", kind: "text" },
  { key: "next", kind: "text" },
  { key: "ending", kind: "text" },
  { key: "cliffhanger", kind: "flag" },
  { key: "notes", kind: "text" },
]);

export const OUTLINE_DESIGN_KEYS: readonly OutlineDesignKey[] = Object.freeze(OUTLINE_DESIGN_FIELDS.map((field) => field.key));

/** The fields without which a design is incomplete: a chapter with a design but none of these is said (`outlineDesignGaps`). */
export const OUTLINE_DESIGN_KEY_FIELDS: readonly OutlineDesignKey[] = Object.freeze(["goal", "pov", "events", "ending"]);

/** Characters of one text of a design, and of one item of a list, that an edit may write: a longer one is cut, with a warning. */
export const OUTLINE_DESIGN_TEXT_MAX_CHARS = 4000;
/** Items of one list of a design that an edit may write. */
export const OUTLINE_DESIGN_LIST_MAX_ITEMS = 40;

const KIND_OF = new Map(OUTLINE_DESIGN_FIELDS.map((field) => [field.key, field.kind]));

function isMapping(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function lineText(value: string): string {
  return value.replace(/\r\n?/g, "\n").trim();
}

function quoted(value: unknown): string {
  if (Array.isArray(value)) return "a list";
  if (isMapping(value)) return "a mapping";
  const text = String(value);
  return `«${text.length > 40 ? `${text.slice(0, 40)}…` : text}»`;
}

function readFlag(value: unknown): boolean | undefined {
  if (typeof value === "boolean") return value;
  if (typeof value === "string") {
    const word = value.trim().toLowerCase();
    if (word === "true" || word === "yes") return true;
    if (word === "false" || word === "no") return false;
  }
  return undefined;
}

/**
 * The design of an entry as the engine reads it from the value of `design:`. `problems` says, in English, every field that could not be read (it is left out of
 * `design`, and stays in the file); a value that is not a mapping is one problem and no design. Absent `design`: the entry has none, or nothing in it is usable.
 */
export function readOutlineDesign(value: unknown): { design?: OutlineChapterDesign; problems: string[] } {
  const problems: string[] = [];
  if (value === undefined || value === null) return { problems };
  if (!isMapping(value)) return { problems: [`design must be a mapping of fields (${quoted(value)} is not): it is not read`] };
  const design: Record<string, unknown> = {};
  for (const { key, kind } of OUTLINE_DESIGN_FIELDS) {
    const raw = value[key];
    if (raw === undefined || raw === null) continue;
    if (kind === "text") {
      if (typeof raw === "string" || typeof raw === "number" || typeof raw === "boolean") {
        const text = lineText(String(raw));
        if (text) design[key] = text;
      } else problems.push(`design.${key} must be text (${quoted(raw)} is not): it is not read`);
    } else if (kind === "flag") {
      const flag = readFlag(raw);
      if (flag === undefined) problems.push(`design.${key} must be true or false (${quoted(raw)} is not): it is not read`);
      else design[key] = flag;
    } else {
      const items = typeof raw === "string" || typeof raw === "number" ? [raw] : Array.isArray(raw) ? raw : null;
      if (!items) {
        problems.push(`design.${key} must be a list of lines (${quoted(raw)} is not): it is not read`);
        continue;
      }
      const lines: string[] = [];
      let skipped = 0;
      for (const item of items) {
        if (typeof item === "string" || typeof item === "number" || typeof item === "boolean") {
          const text = lineText(String(item));
          if (text) lines.push(text);
        } else if (item !== null && item !== undefined) skipped += 1;
      }
      if (skipped) problems.push(`design.${key}: ${skipped === 1 ? "an item is" : `${skipped} items are`} not a line of text and ${skipped === 1 ? "is" : "are"} not read`);
      if (lines.length) design[key] = lines;
    }
  }
  return Object.keys(design).length ? { design: design as OutlineChapterDesign, problems } : { problems };
}

/** A change of a design: a value sets the field, `null` (or an empty text or list) takes it away, a field that is not given stays as it is. */
export type OutlineDesignPatch = { [Key in OutlineDesignKey]?: OutlineChapterDesign[Key] | null };

/**
 * A design that an edit or a model gives, made what the files keep: texts trimmed, lists of non-empty lines, cut to the limits (each cut is said in
 * `problems`, in English). Fields that are not the design's are left out. `null`/empty values say "take it away" (`cleared`).
 */
export function normalizeDesignPatch(value: unknown): { patch: OutlineDesignPatch; problems: string[] } {
  const problems: string[] = [];
  const patch: Record<string, unknown> = {};
  if (!isMapping(value)) return { patch, problems };
  for (const { key, kind } of OUTLINE_DESIGN_FIELDS) {
    if (!(key in value)) continue;
    const raw = value[key];
    if (raw === undefined) continue;
    if (raw === null) {
      patch[key] = null;
      continue;
    }
    if (kind === "flag") {
      const flag = readFlag(raw);
      patch[key] = flag === undefined ? null : flag;
      continue;
    }
    if (kind === "text") {
      const text = typeof raw === "string" || typeof raw === "number" ? lineText(String(raw)) : Array.isArray(raw) ? raw.filter((item) => typeof item === "string").map(lineText).filter(Boolean).join("\n") : "";
      if (text.length > OUTLINE_DESIGN_TEXT_MAX_CHARS) problems.push(`design.${key} was ${text.length} characters long and is cut at ${OUTLINE_DESIGN_TEXT_MAX_CHARS}`);
      patch[key] = text ? clipText(text, OUTLINE_DESIGN_TEXT_MAX_CHARS).trim() : null;
      continue;
    }
    // A text of several lines is a list of them (a bullet that opens a line is not part of it); a list is taken as it is.
    const items = typeof raw === "string" ? raw.split("\n").map((line) => line.trim().replace(/^[-*•]\s+/, "")) : Array.isArray(raw) ? raw : [];
    let lines = items.filter((item): item is string | number => typeof item === "string" || typeof item === "number").map((item) => lineText(String(item))).filter(Boolean);
    if (lines.length > OUTLINE_DESIGN_LIST_MAX_ITEMS) {
      problems.push(`design.${key} had ${lines.length} items and keeps the first ${OUTLINE_DESIGN_LIST_MAX_ITEMS}`);
      lines = lines.slice(0, OUTLINE_DESIGN_LIST_MAX_ITEMS);
    }
    if (lines.some((line) => line.length > OUTLINE_DESIGN_TEXT_MAX_CHARS)) {
      problems.push(`design.${key}: an item longer than ${OUTLINE_DESIGN_TEXT_MAX_CHARS} characters is cut`);
      lines = lines.map((line) => clipText(line, OUTLINE_DESIGN_TEXT_MAX_CHARS).trim());
    }
    patch[key] = lines.length ? lines : null;
  }
  return { patch, problems };
}

/**
 * The value of `design:` once `patch` is applied to the one the file has (`base`, as it was read: a key the engine does not know is kept, in its place).
 * `null` takes the whole design away. `undefined` when nothing is left: the file then has no `design:`.
 */
export function applyDesignPatch(base: unknown, patch: OutlineDesignPatch | null | undefined): Record<string, unknown> | undefined {
  if (patch === null) return undefined;
  const next: Record<string, unknown> = isMapping(base) ? { ...base } : {};
  if (patch) {
    for (const key of OUTLINE_DESIGN_KEYS) {
      if (!(key in patch)) continue;
      const value = patch[key];
      if (value === undefined) continue;
      if (value === null || (Array.isArray(value) && !value.length) || (typeof value === "string" && !value.trim())) delete next[key];
      else next[key] = value;
    }
  }
  // The engine's fields in their order, then the others as they were.
  const ordered: Record<string, unknown> = {};
  for (const key of OUTLINE_DESIGN_KEYS) if (next[key] !== undefined && next[key] !== null) ordered[key] = next[key];
  for (const [key, value] of Object.entries(next)) if (!KIND_OF.has(key as OutlineDesignKey) && value !== undefined) ordered[key] = value;
  return Object.keys(ordered).length ? ordered : undefined;
}

/** A design as the engine writes it whole: the same as patching nothing with every field of `design` (and no other key). */
export function designMapping(design: OutlineChapterDesign | null | undefined): Record<string, unknown> | undefined {
  if (!design) return undefined;
  return applyDesignPatch(undefined, normalizeDesignPatch(design).patch);
}

/** Whether a design says nothing. */
export function isDesignEmpty(design: OutlineChapterDesign | null | undefined): boolean {
  return !design || OUTLINE_DESIGN_KEYS.every((key) => {
    const value = design[key];
    return value === undefined || value === null || (Array.isArray(value) && !value.length) || (typeof value === "string" && !value.trim());
  });
}

/** The key fields (`OUTLINE_DESIGN_KEY_FIELDS`) a design lacks. */
export function missingDesignFields(design: OutlineChapterDesign | null | undefined): OutlineDesignKey[] {
  return OUTLINE_DESIGN_KEY_FIELDS.filter((key) => {
    const value = design?.[key];
    return value === undefined || (Array.isArray(value) && !value.length) || (typeof value === "string" && !value.trim());
  });
}

/** A value of the frontmatter as the fingerprint of an entry sees it: texts trimmed with their line endings made one, empty values gone, keys in order. */
function canonicalValue(value: unknown): unknown {
  if (typeof value === "string") {
    const text = lineText(value);
    return text ? text : undefined;
  }
  if (typeof value === "number" || typeof value === "boolean") return value;
  if (Array.isArray(value)) {
    const items = value.map(canonicalValue).filter((item) => item !== undefined);
    return items.length ? items : undefined;
  }
  if (isMapping(value)) {
    const entries = Object.keys(value).sort().map((key) => [key, canonicalValue(value[key])] as const).filter(([, item]) => item !== undefined);
    return entries.length ? Object.fromEntries(entries) : undefined;
  }
  return undefined;
}

/**
 * What the design of an entry adds to its fingerprint (`outlineEntryDigest`): the whole value of `design:` (the keys the engine does not know too), in a form
 * that does not depend on how the YAML is written. `""` for an entry with no design, or an empty one: its fingerprint is the one it always had.
 */
export function designFingerprint(value: unknown): string {
  const canonical = canonicalValue(value);
  return canonical === undefined ? "" : JSON.stringify(canonical);
}

/** The labels of the fields, as the prompts and the plain-text views say them. */
export const OUTLINE_DESIGN_LABELS: Readonly<Record<OutlineDesignKey, string>> = Object.freeze({
  goal: "Narrative goal",
  pov: "Point of view",
  characters: "Characters",
  setting: "Setting",
  time: "Time",
  events: "Main events",
  scenes: "Planned scenes",
  conflicts: "Conflicts",
  emotions: "Emotional evolution",
  reveals: "Revealed to the reader",
  withholds: "Kept from the reader",
  clues: "Clues and foreshadowing",
  previous: "Picks up from earlier chapters",
  next: "Sets up for later chapters",
  ending: "Ending",
  cliffhanger: "Cliffhanger",
  notes: "Notes for the ghostwriter",
});

/** A design as lines of text, for a prompt or a plain view: a line a field, the lists joined; `maxChars` keeps it within a share of a prompt. */
export function designText(design: OutlineChapterDesign | null | undefined, maxChars = 2400): string {
  if (!design) return "";
  const lines: string[] = [];
  for (const { key, kind } of OUTLINE_DESIGN_FIELDS) {
    const value = design[key];
    if (value === undefined) continue;
    if (kind === "flag") {
      if (value === true) lines.push(`${OUTLINE_DESIGN_LABELS[key]}: yes`);
      continue;
    }
    const text = Array.isArray(value) ? value.join("; ") : String(value);
    if (text) lines.push(`${OUTLINE_DESIGN_LABELS[key]}: ${text.replace(/\s+/g, " ")}`);
  }
  return truncate(lines.join("\n"), maxChars);
}


// ─── The ledger of a secret ─────────────────────────────────────────────────

/**
 * The ledger of a secret: who knows it and from when, what the reader knows chapter by chapter, the clues and the red herrings planted, and what the reveal
 * changes. Keys of the frontmatter of `secrets/<slug>.md`, beside the ones the format always had (`holders`: who knows it from the start; `known_from` and
 * `reveal_in`: from which chapter the reader may know it, and where it surfaces). The chapters are numbers: the ledger is written while the book is designed,
 * when the chapters have no folder yet.
 *
 * ```yaml
 * learned_by:
 *   - { character: character:elio, chapter: 7 }
 * reader_knows:
 *   - { chapter: 1, note: Something happened the night of the wreck. }
 * clues:
 *   - { chapter: 3, note: The keeper's boots are wet on a dry day. }
 * red_herrings:
 *   - { chapter: 4, note: Elio's debts make him the obvious suspect. }
 * consequences:
 *   - Mara leaves the island.
 * ```
 *
 * Read softly, like the design of a chapter: an item that cannot be read is said and left out, a key the engine does not know is kept.
 */
export interface SecretLedgerNote {
  chapter: number;
  note: string;
}

export interface SecretLedgerLearner {
  /** A character: its id (`character:<slug>`) or its name. */
  character: string;
  /** The chapter where the character learns the secret. */
  chapter: number;
}

export interface SecretLedger {
  learnedBy: SecretLedgerLearner[];
  readerKnows: SecretLedgerNote[];
  clues: SecretLedgerNote[];
  redHerrings: SecretLedgerNote[];
  consequences: string[];
}

/** The keys of the frontmatter the ledger is made of. */
export const SECRET_LEDGER_KEYS = Object.freeze(["learned_by", "reader_knows", "clues", "red_herrings", "consequences"] as const);

/** Items of a list of the ledger, and characters of one note, that the engine writes. */
export const SECRET_LEDGER_MAX_ITEMS = 60;
export const SECRET_LEDGER_NOTE_MAX_CHARS = 1000;

export function emptySecretLedger(): SecretLedger {
  return { learnedBy: [], readerKnows: [], clues: [], redHerrings: [], consequences: [] };
}

/** A chapter as the ledger says it: a whole number from 0 (0: before the book begins), or a chapter reference (`chapter:007-the-wreck`). */
export function ledgerChapter(value: unknown): number | undefined {
  if (typeof value === "number") return Number.isSafeInteger(value) && value >= 0 ? value : undefined;
  if (typeof value === "string") {
    const text = value.trim();
    if (/^\d+$/.test(text)) return Number(text);
    const slug = text.replace(/^chapter:/, "").trim();
    return chapterNumberFromSlug(slug) ?? (/^\d+$/.test(slug) ? Number(slug) : undefined);
  }
  return undefined;
}

function noteText(value: unknown): string {
  return typeof value === "string" || typeof value === "number" ? String(value).replace(/\r\n?/g, "\n").trim() : "";
}

function readNotes(value: unknown, key: string, problems: string[]): SecretLedgerNote[] {
  if (value === undefined || value === null) return [];
  if (!Array.isArray(value)) {
    problems.push(`${key} must be a list of { chapter, note } (it is not): it is not read`);
    return [];
  }
  const notes: SecretLedgerNote[] = [];
  let skipped = 0;
  for (const item of value) {
    const record = isMapping(item) ? item : null;
    const chapter = record ? ledgerChapter(record.chapter) : undefined;
    const note = record ? noteText(record.note) : "";
    if (chapter === undefined || !note) skipped += 1;
    else notes.push({ chapter, note });
  }
  if (skipped) problems.push(`${key}: ${skipped === 1 ? "an item has" : `${skipped} items have`} no chapter or no note and ${skipped === 1 ? "is" : "are"} not read`);
  return notes.sort((left, right) => left.chapter - right.chapter);
}

/** The ledger of a secret from its frontmatter, and what could not be read of it (in English). */
export function readSecretLedger(frontmatter: Record<string, unknown>): { ledger: SecretLedger; problems: string[] } {
  const problems: string[] = [];
  const learnedBy: SecretLedgerLearner[] = [];
  const raw = frontmatter.learned_by;
  if (raw !== undefined && raw !== null) {
    if (!Array.isArray(raw)) problems.push("learned_by must be a list of { character, chapter } (it is not): it is not read");
    else {
      let skipped = 0;
      for (const item of raw) {
        const record = isMapping(item) ? item : null;
        const character = record ? noteText(record.character) : "";
        const chapter = record ? ledgerChapter(record.chapter) : undefined;
        if (!character || chapter === undefined) skipped += 1;
        else learnedBy.push({ character, chapter });
      }
      if (skipped) problems.push(`learned_by: ${skipped === 1 ? "an item has" : `${skipped} items have`} no character or no chapter and ${skipped === 1 ? "is" : "are"} not read`);
    }
  }
  const consequences: string[] = [];
  const rawConsequences = frontmatter.consequences;
  if (typeof rawConsequences === "string") {
    if (rawConsequences.trim()) consequences.push(rawConsequences.trim());
  } else if (Array.isArray(rawConsequences)) {
    for (const item of rawConsequences) if (noteText(item)) consequences.push(noteText(item));
  } else if (rawConsequences !== undefined && rawConsequences !== null) {
    problems.push("consequences must be a list of lines (it is not): it is not read");
  }
  return {
    ledger: {
      learnedBy: learnedBy.sort((left, right) => left.chapter - right.chapter),
      readerKnows: readNotes(frontmatter.reader_knows, "reader_knows", problems),
      clues: readNotes(frontmatter.clues, "clues", problems),
      redHerrings: readNotes(frontmatter.red_herrings, "red_herrings", problems),
      consequences,
    },
    problems,
  };
}

/** Whether a ledger says nothing. */
export function isLedgerEmpty(ledger: SecretLedger): boolean {
  return !ledger.learnedBy.length && !ledger.readerKnows.length && !ledger.clues.length && !ledger.redHerrings.length && !ledger.consequences.length;
}

const clipNote = (text: string) => clipText(text.trim(), SECRET_LEDGER_NOTE_MAX_CHARS).trim();

/** The keys of the frontmatter a ledger is written as: a list that is empty is no key (`undefined`, so that rendering leaves it out). */
export function secretLedgerFrontmatter(ledger: SecretLedger): Record<(typeof SECRET_LEDGER_KEYS)[number], unknown> {
  const notes = (items: SecretLedgerNote[]) => {
    const list = [...items].filter((item) => item.note.trim()).sort((left, right) => left.chapter - right.chapter).slice(0, SECRET_LEDGER_MAX_ITEMS).map((item) => ({ chapter: item.chapter, note: clipNote(item.note) }));
    return list.length ? list : undefined;
  };
  const learned = [...ledger.learnedBy].filter((item) => item.character.trim()).sort((left, right) => left.chapter - right.chapter).slice(0, SECRET_LEDGER_MAX_ITEMS).map((item) => ({ character: item.character.trim(), chapter: item.chapter }));
  const consequences = ledger.consequences.map(clipNote).filter(Boolean).slice(0, SECRET_LEDGER_MAX_ITEMS);
  return {
    learned_by: learned.length ? learned : undefined,
    reader_knows: notes(ledger.readerKnows),
    clues: notes(ledger.clues),
    red_herrings: notes(ledger.redHerrings),
    consequences: consequences.length ? consequences : undefined,
  };
}

/**
 * The ledger the design of chapters `from` to `to` gives a secret, merged into the one it had: what falls in those chapters is the batch's, what falls elsewhere stays
 * (a book designed in batches gets its ledger batch by batch). The consequences are the batch's when it gives them.
 */
export function mergeSecretLedger(base: SecretLedger, batch: Partial<SecretLedger>, from: number, to: number): SecretLedger {
  const inRange = (chapter: number) => chapter >= from && chapter <= to;
  const byChapter = <T extends { chapter: number }>(left: T, right: T) => left.chapter - right.chapter;
  const merge = <T extends { chapter: number }>(kept: readonly T[], added: readonly T[] | undefined) => [...kept.filter((item) => !inRange(item.chapter)), ...(added ?? []).filter((item) => inRange(item.chapter))].sort(byChapter);
  return {
    learnedBy: merge(base.learnedBy, batch.learnedBy),
    readerKnows: merge(base.readerKnows, batch.readerKnows),
    clues: merge(base.clues, batch.clues),
    redHerrings: merge(base.redHerrings, batch.redHerrings),
    consequences: batch.consequences?.length ? [...batch.consequences] : [...base.consequences],
  };
}

/**
 * The fingerprint of the ledger a file holds now (the keys of the ledger as they are written, whatever is in them): the design run keeps the one of every ledger
 * it wrote, and rewrites a ledger only while the file still has that one (a change of the author makes the ledger the author's).
 */
export async function secretLedgerDigest(frontmatter: Record<string, unknown>): Promise<string> {
  const keys = SECRET_LEDGER_KEYS.map((key) => [key, frontmatter[key] ?? null]);
  return (await sha256Hex(JSON.stringify(["secret-ledger", keys]))).slice(0, 16);
}

// ─── The files of `bible/` ──────────────────────────────────────────────────

/**
 * The `bible/` folder: the parts of the Story Bible that have no other home in a book. Everything else the Bible shows is in the book's own files (the description
 * and the Synopsis in `outline/`, the story design, the world context, the characters, places, factions, items and secrets): the Bible composes them, and never
 * copies them here.
 *
 * - `bible/themes.md` (`type: bible`, `id: bible:themes`): the themes of the book (`themes`, a list) and its tone (`tone`).
 * - `bible/world.md` (`type: bible`, `id: bible:world`): the rules of the world the story must never break (`rules`, a list).
 *
 * The body of each file is free notes. A design run writes them when they are missing, and never rewrites them: they are the author's from then on.
 */
export const BIBLE_DIRECTORY = "bible";
export const BIBLE_THEMES_FILE = "bible/themes.md";
export const BIBLE_WORLD_FILE = "bible/world.md";

export interface BibleThemes {
  themes: string[];
  tone: string;
  notes: string;
}

export interface BibleWorld {
  rules: string[];
  notes: string;
}

function lines(value: unknown): string[] {
  if (typeof value === "string") return value.split("\n").map((line) => line.replace(/^[-*•]\s+/, "").trim()).filter(Boolean);
  if (!Array.isArray(value)) return [];
  return value.filter((item): item is string | number => typeof item === "string" || typeof item === "number").map((item) => String(item).trim()).filter(Boolean);
}

function text(value: unknown): string {
  return typeof value === "string" || typeof value === "number" ? String(value).trim() : "";
}

/** The themes and the tone of the book from `bible/themes.md` (empty when the file has none). */
export function readBibleThemes(content: string | null | undefined): BibleThemes {
  const document = parseMarkdown(content ?? "");
  return { themes: lines(document.frontmatter.themes), tone: text(document.frontmatter.tone), notes: document.body };
}

/** The rules of the world from `bible/world.md` (empty when the file has none). */
export function readBibleWorld(content: string | null | undefined): BibleWorld {
  const document = parseMarkdown(content ?? "");
  return { rules: lines(document.frontmatter.rules), notes: document.body };
}

/** `bible/themes.md` with these themes and this tone; the keys of `existing` that the format does not manage are kept. */
export function serializeBibleThemes(value: Partial<BibleThemes>, existing?: string | null): string {
  const document = parseMarkdown(existing ?? "");
  const themes = lines(value.themes ?? []);
  const tone = (value.tone ?? "").trim();
  return renderMarkdown({
    ...document.frontmatter,
    type: "bible",
    id: "bible:themes",
    title: typeof document.frontmatter.title === "string" && document.frontmatter.title.trim() ? document.frontmatter.title : "Themes and tone",
    themes: themes.length ? themes : undefined,
    tone: tone || undefined,
  }, (value.notes ?? document.body ?? "").trim());
}

/** `bible/world.md` with these rules; the keys of `existing` that the format does not manage are kept. */
export function serializeBibleWorld(value: Partial<BibleWorld>, existing?: string | null): string {
  const document = parseMarkdown(existing ?? "");
  const rules = lines(value.rules ?? []);
  return renderMarkdown({
    ...document.frontmatter,
    type: "bible",
    id: "bible:world",
    title: typeof document.frontmatter.title === "string" && document.frontmatter.title.trim() ? document.frontmatter.title : "World rules",
    rules: rules.length ? rules : undefined,
  }, (value.notes ?? document.body ?? "").trim());
}

// ─── The checks of a design ─────────────────────────────────────────────────

/**
 * The checks of a design that need no model: they read the chapter entries of the Synopsis (their `design`) and the ledgers of the secrets, and say what does
 * not hold together. They are findings, never blockers: the design run tells them (an insight after every plan, and to the director, who fixes them or asks the
 * author), the Bible shows them, the Brainstorming's coherence check lists them. Pure: nothing is read here, and the same input says the same findings.
 *
 * - `reveal-missing`: a secret with no chapter that reveals it, a mystery without a resolution.
 * - `reveal-out-of-range`: the reveal is after the last chapter of the book.
 * - `reveal-before-known`: `reveal_in` comes before `known_from` (the core says it too).
 * - `clue-after-reveal`: a clue planted in or after the chapter from which the reader knows the truth: it reveals nothing any more.
 * - `secret-without-clue`: a secret revealed after the first chapter with no clue before its reveal: a payoff without a setup.
 * - `chapter-out-of-range`: a chapter of the ledger after the last chapter of the book.
 * - `knowledge-before-learning`: the point of view of a chapter reveals a secret that character only learns in a later chapter.
 * - `unknown-character`, `unknown-location`: an entry names a character, or a setting, the canon does not have (a new minor character may be fine).
 * - `design-incomplete`: an entry has a design without some of its key fields (`outlineDesignGaps`, in `autopilot/outline-check.ts`).
 */
export type DesignFindingCode =
  | "reveal-missing"
  | "reveal-out-of-range"
  | "reveal-before-known"
  | "clue-after-reveal"
  | "secret-without-clue"
  | "chapter-out-of-range"
  | "knowledge-before-learning"
  | "unknown-character"
  | "unknown-location"
  | "design-incomplete";

export interface DesignFinding {
  code: DesignFindingCode;
  severity: "info" | "warning";
  /** The chapter it is about. */
  chapter?: number;
  /** The secret it is about. */
  secret?: { slug: string; title: string };
  /** The character or the place it is about, as the entry names it. */
  name?: string;
  /** A second chapter: where the reader knows the truth, where the character learns it, the last chapter of the book. */
  other?: number;
  /** The key fields a design lacks (`design-incomplete`). */
  fields?: OutlineDesignKey[];
}

export interface DesignCheckSecret {
  slug: string;
  title: string;
  /** Who knows it from the start (`holders`), by id (`character:<slug>`) or by name. */
  holders: readonly string[];
  ledger: SecretLedger;
  /** The chapter that reveals it: `reveal_in`, else the plan's, else `known_from`. */
  revealChapter?: number;
  /** `known_from`, when the file says it. */
  knownFromChapter?: number;
}

export interface DesignCheckCanon {
  slug: string;
  name: string;
  aliases?: readonly string[];
}

export interface DesignCheckInput {
  chapters: ReadonlyArray<{ number: number; title?: string; design?: OutlineChapterDesign }>;
  secrets: readonly DesignCheckSecret[];
  characters: readonly DesignCheckCanon[];
  locations: readonly DesignCheckCanon[];
  /** The last chapter of the book (default: the highest of the entries). */
  lastChapter?: number;
}

/** Findings told at most, so that a book of five thousand chapters does not drown the author: the rest is counted. */
export const DESIGN_FINDINGS_MAX = 200;

function normalizeName(value: string): string {
  return value.normalize("NFKD").replace(/[\u0300-\u036f]/g, "").replace(/[«»"'“”‘’()[\]]/g, " ").replace(/\s+/g, " ").trim().toLowerCase();
}

/** The canon entry a name or an id points to: the id, the name, an alias, or (for a character) a lone first name or the first name of a fuller one. */
function matchCanon(value: string, canon: readonly DesignCheckCanon[], kind: "character" | "location"): DesignCheckCanon | undefined {
  const text = value.trim();
  const ref = new RegExp(`^${kind}:(.+)$`).exec(text);
  if (ref) return canon.find((entry) => entry.slug === ref[1].trim());
  const candidate = normalizeName(text);
  if (!candidate) return undefined;
  const names = (entry: DesignCheckCanon) => [entry.name, ...(entry.aliases ?? [])].map(normalizeName).filter(Boolean);
  const exact = canon.find((entry) => names(entry).includes(candidate) || entry.slug === candidate);
  if (exact || kind !== "character") return exact;
  const first = (name: string) => name.split(" ")[0];
  return canon.find((entry) => names(entry).some((name) => (!candidate.includes(" ") && first(name) === candidate) || (!name.includes(" ") && first(candidate) === name)));
}

/** A place an entry's setting names: an id, a name or an alias of the canon, also inside a longer description («the lamp room of the Lighthouse»). */
function settingKnown(setting: string, locations: readonly DesignCheckCanon[]): boolean {
  if (matchCanon(setting, locations, "location")) return true;
  const text = ` ${normalizeName(setting)} `;
  return locations.some((entry) => [entry.name, ...(entry.aliases ?? [])].map(normalizeName).some((name) => name.length >= 3 && text.includes(` ${name} `)));
}

/** Whether a line of a design names the secret: its id, or its title. */
function mentionsSecret(line: string, secret: Pick<DesignCheckSecret, "slug" | "title">): boolean {
  const text = normalizeName(line);
  return text.includes(`secret:${secret.slug}`) || (normalizeName(secret.title).length >= 3 && text.includes(normalizeName(secret.title)));
}

/** Names that stand for no one in particular, which a design may put among the characters. */
const GENERIC = new Set(["everyone", "all", "nobody", "the crowd", "crowd", "tutti", "nessuno", "la folla", "folla", "narrator", "narratore"]);

/** The deterministic checks of a design (`DesignFindingCode`), in a stable order: the secrets, then the chapters. */
export function designChecks(input: DesignCheckInput): DesignFinding[] {
  const findings: DesignFinding[] = [];
  const last = input.lastChapter ?? input.chapters.reduce((highest, chapter) => Math.max(highest, chapter.number), 0);
  const chapters = [...input.chapters].sort((left, right) => left.number - right.number);
  for (const secret of input.secrets) {
    const subject = { slug: secret.slug, title: secret.title };
    const reveal = secret.revealChapter;
    const known = secret.knownFromChapter;
    if (!reveal) findings.push({ code: "reveal-missing", severity: "warning", secret: subject });
    else if (last && reveal > last) findings.push({ code: "reveal-out-of-range", severity: "warning", secret: subject, chapter: reveal, other: last });
    if (reveal && known && reveal < known) findings.push({ code: "reveal-before-known", severity: "warning", secret: subject, chapter: reveal, other: known });
    // From this chapter on the reader knows the truth: what is planted there or later is no clue.
    const threshold = [reveal, known].filter((value): value is number => typeof value === "number" && value > 0).reduce((lowest, value) => Math.min(lowest, value), Number.POSITIVE_INFINITY);
    for (const clue of secret.ledger.clues) {
      if (Number.isFinite(threshold) && clue.chapter >= threshold) findings.push({ code: "clue-after-reveal", severity: "warning", secret: subject, chapter: clue.chapter, other: threshold });
    }
    if (reveal && reveal > 1 && !secret.ledger.clues.some((clue) => clue.chapter < reveal)) findings.push({ code: "secret-without-clue", severity: "info", secret: subject, chapter: reveal });
    if (last) {
      const beyond = [...secret.ledger.clues, ...secret.ledger.redHerrings, ...secret.ledger.readerKnows].map((item) => item.chapter)
        .concat(secret.ledger.learnedBy.map((item) => item.chapter))
        .filter((chapter) => chapter > last);
      for (const chapter of [...new Set(beyond)].sort((left, right) => left - right)) findings.push({ code: "chapter-out-of-range", severity: "warning", secret: subject, chapter, other: last });
    }
    // A point of view that reveals what that character learns only later.
    for (const learner of secret.ledger.learnedBy) {
      const learnerEntry = matchCanon(learner.character, input.characters, "character");
      const sameCharacter = (name: string) => {
        if (normalizeName(name) === normalizeName(learner.character)) return true;
        const entry = matchCanon(name, input.characters, "character");
        return Boolean(entry && learnerEntry && entry.slug === learnerEntry.slug);
      };
      if (secret.holders.some(sameCharacter)) continue;
      for (const chapter of chapters) {
        if (chapter.number >= learner.chapter) break;
        const design = chapter.design;
        if (!design?.reveals?.some((line) => mentionsSecret(line, secret))) continue;
        if (design.pov?.some(sameCharacter)) findings.push({ code: "knowledge-before-learning", severity: "warning", secret: subject, chapter: chapter.number, name: learnerEntry?.name ?? learner.character, other: learner.chapter });
      }
    }
  }
  for (const chapter of chapters) {
    const design = chapter.design;
    if (!design) continue;
    if (input.characters.length) {
      const named = [...new Set([...(design.pov ?? []), ...(design.characters ?? [])].map((name) => name.trim()).filter(Boolean))];
      for (const name of named) {
        if (GENERIC.has(normalizeName(name)) || matchCanon(name, input.characters, "character")) continue;
        findings.push({ code: "unknown-character", severity: "info", chapter: chapter.number, name });
      }
    }
    if (input.locations.length && design.setting && !settingKnown(design.setting, input.locations)) {
      findings.push({ code: "unknown-location", severity: "info", chapter: chapter.number, name: design.setting });
    }
  }
  return findings;
}

const FIELD_WORDS: Record<OutlineDesignKey, [string, string]> = {
  goal: ["narrative goal", "obiettivo narrativo"],
  pov: ["point of view", "punto di vista"],
  characters: ["characters", "personaggi"],
  setting: ["setting", "ambientazione"],
  time: ["time", "tempo"],
  events: ["main events", "eventi principali"],
  scenes: ["planned scenes", "scene previste"],
  conflicts: ["conflicts", "conflitti"],
  emotions: ["emotional evolution", "evoluzione emotiva"],
  reveals: ["what the reader learns", "cosa scopre il lettore"],
  withholds: ["what stays hidden", "cosa resta nascosto"],
  clues: ["clues", "indizi"],
  previous: ["link to the chapters before", "legame con i capitoli precedenti"],
  next: ["link to the chapters after", "legame con i capitoli successivi"],
  ending: ["ending", "chiusura"],
  cliffhanger: ["cliffhanger", "cliffhanger"],
  notes: ["notes for the ghostwriter", "note per il ghostwriter"],
};

/** A finding in words, in English or in Italian (the language of the book, or of the interface). */
export function designFindingText(finding: DesignFinding, language: string): string {
  const it = isItalian(language);
  const secret = finding.secret ? `«${finding.secret.title}»` : "";
  const chapter = finding.chapter ?? 0;
  const other = finding.other ?? 0;
  switch (finding.code) {
    case "reveal-missing":
      return it ? `Il segreto ${secret} non ha un capitolo che lo riveli: un mistero senza soluzione.` : `The secret ${secret} has no chapter that reveals it: a mystery without a resolution.`;
    case "reveal-out-of-range":
      return it ? `Il segreto ${secret} si rivela nel capitolo ${chapter}, dopo l'ultimo capitolo del libro (${other}).` : `The secret ${secret} is revealed in chapter ${chapter}, after the last chapter of the book (${other}).`;
    case "reveal-before-known":
      return it ? `Il segreto ${secret} si rivela nel capitolo ${chapter}, prima del capitolo da cui il lettore può conoscerlo (${other}).` : `The secret ${secret} is revealed in chapter ${chapter}, before the chapter from which the reader may know it (${other}).`;
    case "clue-after-reveal":
      return it ? `Un indizio del segreto ${secret} è nel capitolo ${chapter}, quando il lettore conosce già la verità (dal capitolo ${other}): non rivela più nulla.` : `A clue of the secret ${secret} is in chapter ${chapter}, when the reader already knows the truth (from chapter ${other}): it reveals nothing any more.`;
    case "secret-without-clue":
      return it ? `Il segreto ${secret} si rivela nel capitolo ${chapter} senza alcun indizio prima: la rivelazione arriva senza preparazione.` : `The secret ${secret} is revealed in chapter ${chapter} with no clue before it: the reveal comes without a setup.`;
    case "chapter-out-of-range":
      return it ? `Il registro del segreto ${secret} parla del capitolo ${chapter}, dopo l'ultimo capitolo del libro (${other}).` : `The ledger of the secret ${secret} names chapter ${chapter}, after the last chapter of the book (${other}).`;
    case "knowledge-before-learning":
      return it ? `Nel capitolo ${chapter} il punto di vista di ${finding.name} rivela il segreto ${secret}, che ${finding.name} scopre solo nel capitolo ${other}.` : `In chapter ${chapter} the point of view of ${finding.name} reveals the secret ${secret}, which ${finding.name} only learns in chapter ${other}.`;
    case "unknown-character":
      return it ? `Il capitolo ${chapter} nomina «${finding.name}», che non è tra i personaggi del canone.` : `Chapter ${chapter} names «${finding.name}», who is not among the characters of the canon.`;
    case "unknown-location":
      return it ? `L'ambientazione del capitolo ${chapter} («${finding.name}») non nomina un luogo del canone.` : `The setting of chapter ${chapter} («${finding.name}») names no place of the canon.`;
    case "design-incomplete": {
      const fields = (finding.fields ?? []).map((field) => FIELD_WORDS[field][it ? 1 : 0]).join(", ");
      return it ? `Il progetto del capitolo ${chapter} non dice: ${fields}.` : `The design of chapter ${chapter} does not say: ${fields}.`;
    }
  }
}
