import { referencedChapterNumber } from "../book/context.js";
import { BIBLE_THEMES_FILE, BIBLE_WORLD_FILE, OUTLINE_DESIGN_FIELDS, OUTLINE_DESIGN_LABELS, isLedgerEmpty, readBibleThemes, readBibleWorld, readSecretLedger, type OutlineChapterDesign, type OutlineDesignKey, type SecretLedger } from "../book/design.js";
import type { OutlineChapterEntry, OutlineReader } from "../book/outline.js";
import type { BookSnapshot } from "../book/snapshot.js";
import type { BookStore } from "../book/store.js";
import { parseMarkdown } from "../markdown/frontmatter.js";
import { truncate } from "../util/text.js";
import type { AutopilotState } from "./types.js";

/**
 * What the writing autopilot reads of the design of the book (Phase 5 of #108, item 3 of #125): every step that plans the scenes of a chapter, writes it, reviews it or plans it
 * again is given the design of the chapter (all its fields: the planned scenes, the characters on stage, the setting and the time, the conflicts, the emotions, what stays
 * hidden, the clues, the links to the chapters before and after, the ending, the notes for the ghostwriter), the ledgers of the secrets as the spoiler guards of that chapter
 * (what the reader knows by then, who knows each secret by then, the clues and the red herrings that belong in it, the consequences after a reveal), the rules of the world
 * and the themes of `bible/` as constraints, and the entries of the Synopsis around it (the chapter before and after in full). A design the author approved
 * (`design_approved` in `outline/book.md`), or the author's own, binds; one the design run proposed and nobody approved is followed unless the story contradicts it.
 */

/** The key of `outline/book.md` that keeps the author's approval of a design: when, and which design run it approves (`AutopilotDesign.startedAt`). */
export const DESIGN_APPROVED_KEY = "design_approved";

export interface DesignApproval {
  at: string;
  /** The design run it approves; another run (the design made again) is not approved by it. */
  run: string;
}

/** The approval the frontmatter of `outline/book.md` records, or `null`. */
export function readDesignApproval(frontmatter: Record<string, unknown> | null | undefined): DesignApproval | null {
  const value = frontmatter?.[DESIGN_APPROVED_KEY];
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const record = value as Record<string, unknown>;
  return typeof record.at === "string" && typeof record.run === "string" ? { at: record.at, run: record.run } : null;
}

/** Whether the author approved the design the book has: an approval of the design run the state knows (any approval, when the state knows none). */
export function designApproved(approval: DesignApproval | null, state: Pick<AutopilotState, "design"> | null | undefined): boolean {
  if (!approval) return false;
  return !state?.design || state.design.mode === "complete" || approval.run === state.design.startedAt;
}

/** Characters of the design of a chapter, of the spoiler guards, of the constraints of the Bible and of an entry beside it, as a prompt gives them at most. */
export const WRITING_DESIGN_CHARS = 6000;
export const WRITING_GUARDS_CHARS = 3500;
export const WRITING_BIBLE_CHARS = 2500;
export const WRITING_NEIGHBOUR_CHARS = 3000;
export const WRITING_OTHERS_CHARS = 6000;

/** A design as lines, every field with its label, each list item on a line of its own: what the writer reads of the chapter. */
export function designLines(design: OutlineChapterDesign | undefined, keys: readonly OutlineDesignKey[] = OUTLINE_DESIGN_FIELDS.map((field) => field.key)): string {
  if (!design) return "";
  const wanted = new Set(keys);
  const lines: string[] = [];
  for (const { key, kind } of OUTLINE_DESIGN_FIELDS) {
    if (!wanted.has(key)) continue;
    const value = design[key];
    if (value === undefined || value === null) continue;
    if (kind === "flag") {
      lines.push(`${OUTLINE_DESIGN_LABELS[key]}: ${value === true ? "yes" : "no"}`);
      continue;
    }
    if (Array.isArray(value)) {
      if (value.length) lines.push(`${OUTLINE_DESIGN_LABELS[key]}:\n${value.map((item) => `- ${item}`).join("\n")}`);
    } else if (String(value).trim()) lines.push(`${OUTLINE_DESIGN_LABELS[key]}: ${String(value).trim()}`);
  }
  return lines.join("\n");
}

/** The design of the chapter, with whether it binds: the author's own or approved by the author, or proposed by the design run and not approved yet. */
export function chapterDesignBlock(entry: OutlineChapterEntry | null | undefined, approved: boolean, maxChars = WRITING_DESIGN_CHARS): string {
  const lines = designLines(entry?.design);
  if (!entry || !lines) return "";
  const binds = !entry.intact || approved;
  const label = binds
    ? `THE DESIGN OF CHAPTER ${entry.number} (${entry.intact ? "approved by the author" : "the author's"}: it binds the chapter; write what it plans)`
    : `THE DESIGN OF CHAPTER ${entry.number} (proposed by the design run, not approved yet: follow it unless the story so far contradicts it)`;
  return `${label}:\n${truncate(lines, maxChars)}`;
}

/**
 * The entries a step reads around a chapter: the author's, and the ones with a design. An entry the autopilot wrote from its plan and nobody touched says what the plan
 * says, which the step reads already.
 */
function telling(entries: readonly OutlineChapterEntry[]): OutlineChapterEntry[] {
  return entries.filter((entry) => !entry.unreadable && (!entry.intact || entry.design) && (entry.body.trim() || entry.design));
}

/** The entries of the Synopsis before and after a chapter, in full (their text and the design fields that link them to it). */
export function neighbourEntriesSection(entries: readonly OutlineChapterEntry[], number: number, maxChars = WRITING_NEIGHBOUR_CHARS): string {
  const kept = telling(entries);
  const before = [...kept].reverse().find((entry) => entry.number < number);
  const after = kept.find((entry) => entry.number > number);
  const block = (entry: OutlineChapterEntry, label: string, keys: OutlineDesignKey[]) => {
    const design = designLines(entry.design, keys);
    return `${label} — Chapter ${entry.number}${entry.title ? ` «${entry.title}»` : ""}:\n${truncate([entry.body.trim(), design].filter(Boolean).join("\n"), maxChars)}`;
  };
  return [
    before ? block(before, "THE CHAPTER BEFORE IN THE SYNOPSIS", ["events", "ending", "cliffhanger", "next"]) : "",
    after ? block(after, "THE CHAPTER AFTER IN THE SYNOPSIS (set it up, do not tell it)", ["goal", "previous", "setting", "time"]) : "",
  ].filter(Boolean).join("\n\n");
}

/** The other entries of the Synopsis, a line each, the nearest to the chapter first kept, within `maxChars`. */
export function otherEntriesSection(entries: readonly OutlineChapterEntry[], number: number, maxChars = WRITING_OTHERS_CHARS): string {
  const usable = telling(entries);
  const neighbours = new Set<number>();
  const before = [...usable].reverse().find((entry) => entry.number < number);
  const after = usable.find((entry) => entry.number > number);
  if (before) neighbours.add(before.number);
  if (after) neighbours.add(after.number);
  const others = usable.filter((entry) => entry.number !== number && !neighbours.has(entry.number) && entry.body.trim());
  if (!others.length) return "";
  // The nearest first, so that what a tight budget leaves out is the farthest.
  const ranked = [...others].sort((left, right) => Math.abs(left.number - number) - Math.abs(right.number - number) || left.number - right.number);
  const kept: OutlineChapterEntry[] = [];
  let size = 0;
  for (const entry of ranked) {
    const line = `${entry.number}. ${entry.title || "(no title)"} — ${truncate(entry.body.replace(/\s+/g, " ").trim(), 200)}`;
    if (size + line.length + 1 > maxChars) break;
    kept.push(entry);
    size += line.length + 1;
  }
  const lines = kept.sort((left, right) => left.number - right.number).map((entry) => `${entry.number}. ${entry.title || "(no title)"} — ${truncate(entry.body.replace(/\s+/g, " ").trim(), 200)}`);
  const left = others.length - kept.length;
  return `THE OTHER CHAPTERS OF THE SYNOPSIS (summaries${left ? `; ${left} far from this chapter left out` : ""}):\n${lines.join("\n")}`;
}

// ─── The ledgers of the secrets, as spoiler guards ───────────────────────────

export interface BookSecretLedger {
  slug: string;
  name: string;
  /** The chapter where the reader learns it (`reveal_in`, else the plan's, else `known_from`); absent: not placed. */
  reveal?: number;
  /** Who knows it from the start (`holders`). */
  holders: string[];
  ledger: SecretLedger;
}

/** The ledgers of the secrets of the book, read from their files (a file that cannot be read gives an empty ledger). `planned`: the chapter the plan reveals each in. */
export async function loadSecretLedgers(store: BookStore, snapshot: BookSnapshot, planned: ReadonlyMap<string, number | undefined> = new Map()): Promise<BookSecretLedger[]> {
  const secrets = snapshot.canon.filter((entry) => entry.kind === "secret");
  return Promise.all(secrets.map(async (entry) => {
    const file = await store.read(entry.path).catch(() => null);
    const frontmatter = file ? parseMarkdown(file.content).frontmatter : {};
    const holders = Array.isArray(frontmatter.holders) ? frontmatter.holders.filter((item): item is string => typeof item === "string" && item.trim().length > 0) : [];
    const reveal = referencedChapterNumber(entry.revealIn) ?? planned.get(entry.slug) ?? referencedChapterNumber(entry.knownFrom);
    return { slug: entry.slug, name: entry.name, ...(reveal ? { reveal } : {}), holders, ledger: readSecretLedger(frontmatter).ledger };
  }));
}

/**
 * The spoiler guards of chapter `number`, from the ledgers: for each secret, when the reader learns it (hidden here, revealed here, or revealed before), what the reader
 * knows of it by this chapter, who knows it by now and who learns it only later (nobody acts on a secret before learning it), the clues and the red herrings that belong
 * in this chapter, and the consequences once it is revealed. `name` turns a character's id into its name. Empty when no secret has a ledger that says anything for the chapter.
 */
export function chapterSpoilerGuards(ledgers: readonly BookSecretLedger[], number: number, name: (character: string) => string = (character) => character, maxChars = WRITING_GUARDS_CHARS): string {
  const blocks: Array<{ text: string; weight: number }> = [];
  for (const secret of ledgers) {
    const { ledger } = secret;
    // A secret without a ledger is told by the reveal rules alone, as it always was.
    if (isLedgerEmpty(ledger)) continue;
    const lines: string[] = [];
    const revealed = secret.reveal !== undefined && secret.reveal <= number;
    const state = secret.reveal === undefined ? "no reveal planned: keep it hidden" : secret.reveal > number ? `HIDDEN until chapter ${secret.reveal}: do not reveal it here` : secret.reveal === number ? "revealed to the reader in THIS chapter" : `revealed to the reader in chapter ${secret.reveal}`;
    const knows = ledger.readerKnows.filter((note) => note.chapter <= number);
    if (knows.length) lines.push(`  The reader knows by now: ${knows[knows.length - 1].note}${knows[knows.length - 1].chapter < number ? ` (since chapter ${knows[knows.length - 1].chapter})` : ""}`);
    const knowers = [...new Set([...secret.holders.map(name), ...ledger.learnedBy.filter((item) => item.chapter <= number).map((item) => name(item.character))])];
    if (knowers.length) lines.push(`  Who knows it by now: ${knowers.join(", ")}`);
    const later = ledger.learnedBy.filter((item) => item.chapter > number);
    if (later.length) lines.push(`  Not yet (they must not act on it here): ${later.map((item) => `${name(item.character)} (learns it in chapter ${item.chapter})`).join(", ")}`);
    const clues = ledger.clues.filter((note) => note.chapter === number);
    const herrings = ledger.redHerrings.filter((note) => note.chapter === number);
    if (clues.length) lines.push(`  Clues to plant here: ${clues.map((note) => note.note).join("; ")}`);
    if (herrings.length) lines.push(`  Red herrings to plant here: ${herrings.map((note) => note.note).join("; ")}`);
    if (revealed && ledger.consequences.length) lines.push(`  ${secret.reveal === number ? "Consequences to set in motion" : "Consequences in effect"}: ${ledger.consequences.join("; ")}`);
    // A secret with nothing for this chapter and nothing to keep hidden says nothing: the reveal rules already list it.
    if (!lines.length) continue;
    const here = clues.length + herrings.length + (secret.reveal === number ? 2 : 0);
    blocks.push({ text: [`- «${secret.name}»: ${state}.`, ...lines].join("\n"), weight: here * 100 - (secret.reveal === undefined ? 0 : Math.abs(secret.reveal - number)) });
  }
  if (!blocks.length) return "";
  // What belongs in this chapter first: a tight budget leaves out the secrets far from it.
  const ranked = [...blocks].sort((left, right) => right.weight - left.weight);
  const kept: string[] = [];
  let size = 0;
  for (const block of ranked) {
    const text = truncate(block.text, Math.max(400, Math.floor(maxChars / 2)));
    if (size + text.length + 1 > maxChars && kept.length) break;
    kept.push(text);
    size += text.length + 1;
  }
  const left = blocks.length - kept.length;
  return `SPOILER GUARDS FOR CHAPTER ${number} (from the ledgers of the secrets: they bind${left ? `; ${left} more secrets far from this chapter not listed` : ""}):\n${kept.join("\n")}`;
}

// ─── The Bible, as constraints ───────────────────────────────────────────────

/** The rules of the world and the themes, the tone and the audience of `bible/`, as the constraints of every step that writes or judges prose. Empty without them. */
export async function bibleConstraints(store: BookStore, maxChars = WRITING_BIBLE_CHARS): Promise<string> {
  const [themesFile, worldFile] = await Promise.all([store.read(BIBLE_THEMES_FILE).catch(() => null), store.read(BIBLE_WORLD_FILE).catch(() => null)]);
  const themes = readBibleThemes(themesFile?.content) as ReturnType<typeof readBibleThemes> & { audience?: string };
  const world = readBibleWorld(worldFile?.content);
  const parts = [
    world.rules.length ? `RULES OF THE WORLD (never break them):\n${world.rules.map((rule) => `- ${rule}`).join("\n")}` : "",
    themes.themes.length || themes.tone || themes.audience
      ? `THEMES, TONE AND AUDIENCE (serve them):\n${[themes.themes.length ? `Themes: ${themes.themes.join("; ")}` : "", themes.tone ? `Tone: ${themes.tone}` : "", themes.audience ? `Audience: ${themes.audience}` : ""].filter(Boolean).join("\n")}`
      : "",
  ].filter(Boolean);
  return parts.length ? truncate(parts.join("\n\n"), maxChars) : "";
}

// ─── All of it, for a step ───────────────────────────────────────────────────

/** What a step of the writing autopilot reads of the design for a chapter: which parts depends on the step (`kind`). */
export type WritingContextKind = "scenes" | "write" | "review" | "replan";

/** What a step adds about the design of a chapter: its sections, and whether the book has any design for it to follow (a design, spoiler guards, or the Bible). */
export interface ChapterWritingContext {
  sections: string[];
  designed: boolean;
}

/**
 * The sections a step adds about the design of chapter `number`: the design (with whether it binds), the spoiler guards, the constraints of the Bible, and (for the plan of
 * the scenes and of the chapter) the entries before and after it in full and the others as summaries; the writer of a scene reads the design shorter, and its scene's
 * plan for the rest. Every part is empty when the book has none of it, so that a book without a design is asked what it always was.
 */
export async function chapterWritingContext(input: { store: BookStore; snapshot: BookSnapshot; outline: OutlineReader; state: Pick<AutopilotState, "design" | "concept"> }, number: number, kind: WritingContextKind): Promise<ChapterWritingContext> {
  const { store, snapshot, outline, state } = input;
  const [entries, book, ledgers, bible] = await Promise.all([
    outline.empty ? Promise.resolve([] as OutlineChapterEntry[]) : outline.chapters(),
    outline.empty ? Promise.resolve(null) : outline.book(),
    loadSecretLedgers(store, snapshot, new Map(state.concept.secrets.map((secret) => [secret.slug, secret.revealChapter]))),
    bibleConstraints(store),
  ]);
  const entry = entries.find((item) => item.number === number);
  const approved = designApproved(readDesignApproval(book?.frontmatter), state);
  const characters = snapshot.canon.filter((item) => item.kind === "character");
  const nameOf = (character: string) => {
    const slug = /^character:(.+)$/.exec(character.trim())?.[1];
    return (slug && characters.find((item) => item.slug === slug)?.name) || character;
  };
  const sections = [
    chapterDesignBlock(entry, approved, kind === "write" ? 4000 : WRITING_DESIGN_CHARS),
    chapterSpoilerGuards(ledgers, number, nameOf, kind === "write" ? 2500 : WRITING_GUARDS_CHARS),
    bible,
  ];
  const designed = sections.some(Boolean);
  if (kind === "scenes" || kind === "replan") sections.push(neighbourEntriesSection(entries, number), otherEntriesSection(entries, number));
  return { sections: sections.filter(Boolean), designed };
}
