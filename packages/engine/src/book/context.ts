import { parseMarkdown, type MarkdownDocument } from "../markdown/frontmatter.js";
import { defaultDirector, parseDirector, type DirectorProfile } from "../profiles/director.js";
import { ghostwriterPrompt, parseGhostwriter, type GhostwriterProfile } from "../profiles/ghostwriter.js";
import { mergeReaderPersonas, parseReaderPersona, type ReaderPersonaProfile } from "../profiles/readers.js";
import { latinLength, tail, truncate } from "../util/text.js";
import { CANON_DIRECTORIES, DIRECTOR_FILE, chapterNumberFromSlug, isValidGhostwriterSlug, type CanonKind } from "./paths.js";
import type { BookSnapshot, CanonInfo, ChapterInfo, ParagraphInfo } from "./snapshot.js";
import type { BookFileContent, BookStore } from "./store.js";

export async function readDocument(store: BookStore, path: string): Promise<{ file: BookFileContent; document: MarkdownDocument } | null> {
  const file = await store.read(path);
  return file ? { file, document: parseMarkdown(file.content) } : null;
}

/**
 * Body of a Markdown file without frontmatter, truncated; empty string when missing. With
 * `keep: "end"` the most recent part survives the cut (for summaries that grow at the end).
 */
export async function readBody(store: BookStore, path: string, max = 6000, keep: "start" | "end" = "start"): Promise<string> {
  const loaded = await readDocument(store, path);
  if (!loaded) return "";
  return keep === "end" ? tail(loaded.document.body, max) : truncate(loaded.document.body, max);
}

/** True when a scaffolded document still has only headings, placeholders and template hints. */
export function isThinDocument(body: string): boolean {
  const meaningful = body
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line && !line.startsWith("#"))
    .filter((line) => !/^-\s*(?:record|describe|note|translate|add|keep)\b/i.test(line))
    .join(" ");
  return latinLength(meaningful) < 160;
}

export async function loadDirectorProfile(store: BookStore, language?: string): Promise<DirectorProfile> {
  const file = await store.read(DIRECTOR_FILE);
  return file ? parseDirector(file.content, language) : defaultDirector(language);
}

/**
 * The ghostwriter of a paragraph, else its chapter, else the book, else the default one. A slug that is not a file name
 * (`../x`, a path, a strange character) is never read: it is skipped for the next one and reported to `onInvalid`, so that
 * a wrong line in a book's frontmatter cannot stop the writing.
 */
export async function loadGhostwriter(store: BookStore, snapshot: BookSnapshot, chapter?: ChapterInfo, paragraph?: ParagraphInfo, options: { onInvalid?: (slug: string) => void } = {}): Promise<GhostwriterProfile | null> {
  let slug: string | undefined;
  for (const candidate of [paragraph?.ghostwriter, chapter?.ghostwriter, snapshot.book.ghostwriter]) {
    if (!candidate) continue;
    if (isValidGhostwriterSlug(candidate)) {
      slug = candidate;
      break;
    }
    options.onInvalid?.(candidate);
  }
  slug ??= snapshot.ghostwriterSlugs.includes("default") ? "default" : snapshot.ghostwriterSlugs[0];
  if (!slug || !isValidGhostwriterSlug(slug)) return null;
  const file = await store.read(`ghostwriters/${slug}.md`);
  return file ? parseGhostwriter(slug, file.content) : null;
}

export function ghostwriterBlock(profile: GhostwriterProfile | null): string {
  return profile ? ghostwriterPrompt(profile) : "No ghostwriter profile: write clear, concrete, professional narrative prose.";
}

/** Built-in simulated readers merged with the book's `personas/*.md` overrides, in panel order. */
export async function loadReaderPanel(store: BookStore, snapshot: BookSnapshot): Promise<ReaderPersonaProfile[]> {
  const overrides = await Promise.all(snapshot.personaPaths.map(async (path) => {
    const file = await store.read(path);
    return file ? parseReaderPersona(path.slice("personas/".length, -3), file.content) : null;
  }));
  return mergeReaderPersonas(snapshot.book.language, overrides.filter((profile): profile is ReaderPersonaProfile => Boolean(profile)));
}

/** Enabled readers the director does not ignore, capped. */
export function activeReaders(panel: ReaderPersonaProfile[], director: DirectorProfile, max: number): ReaderPersonaProfile[] {
  return panel
    .filter((profile) => profile.enabled && (director.readerWeights[profile.slug] ?? 1) > 0)
    .slice(0, Math.max(0, max));
}

const KIND_LABEL: Record<CanonKind, string> = {
  character: "Character",
  location: "Location",
  faction: "Faction",
  item: "Item",
  secret: "Secret",
  "timeline-event": "Timeline event",
};

/** One line per canon entry. Secrets are listed by title only unless `includeSecrets`. */
export function canonManifest(snapshot: BookSnapshot, options: { includeSecrets: boolean; max?: number } = { includeSecrets: false }): string {
  const lines = snapshot.canon
    .filter((entry) => options.includeSecrets || entry.kind !== "secret")
    .slice(0, options.max ?? 120)
    .map((entry) => `- ${KIND_LABEL[entry.kind]}: ${entry.name}${entry.aliases.length ? ` (aka ${entry.aliases.join(", ")})` : ""}${entry.summary ? ` — ${truncate(entry.summary, 220)}` : ""}`);
  return lines.join("\n");
}

export function referencedChapterNumber(reference: string | undefined): number | undefined {
  if (!reference) return undefined;
  const slug = reference.replace(/^chapter:/, "").trim();
  return chapterNumberFromSlug(slug) ?? (/^\d+$/.test(slug) ? Number(slug) : undefined);
}

/** Reveal rules for every secret relative to the chapter being written or judged. */
export async function secretRules(store: BookStore, snapshot: BookSnapshot, chapterNumber?: number, maxBody = 500): Promise<string> {
  const secrets = snapshot.canon.filter((entry) => entry.kind === "secret");
  if (!secrets.length) return "";
  const lines = await Promise.all(secrets.map(async (secret: CanonInfo) => {
    const reveal = referencedChapterNumber(secret.revealIn) ?? referencedChapterNumber(secret.knownFrom);
    const truth = await readBody(store, secret.path, maxBody);
    let rule: string;
    if (!reveal) rule = "No reveal threshold: keep it hidden unless the chapter plan explicitly reveals it.";
    else if (chapterNumber === undefined) rule = `Reveal planned in chapter ${reveal}.`;
    else if (chapterNumber < reveal) rule = `HIDDEN until chapter ${reveal}: do not reveal it here; only subtle, deniable hints are allowed.`;
    else if (chapterNumber === reveal) rule = "The reveal is planned in THIS chapter.";
    else rule = `Already revealable (since chapter ${reveal}).`;
    return `- ${secret.name}: ${rule}${truth ? `\n  Truth: ${truth.replace(/\s+/g, " ")}` : ""}`;
  }));
  return lines.join("\n");
}

export interface LoadedParagraph {
  number: number;
  title: string;
  path: string;
  hash: string;
  raw: string;
  body: string;
}

export async function loadChapterParagraphs(store: BookStore, chapter: ChapterInfo): Promise<LoadedParagraph[]> {
  const loaded = await Promise.all(chapter.paragraphs.map(async (paragraph) => {
    const file = await store.read(paragraph.path);
    if (!file) return null;
    return { number: paragraph.number, title: paragraph.title, path: paragraph.path, hash: file.hash, raw: file.content, body: parseMarkdown(file.content).body };
  }));
  return loaded.filter((entry): entry is LoadedParagraph => Boolean(entry));
}

/** Chapter text with explicit scene markers, so reviewers can reference scene numbers. */
export function markedChapterText(paragraphs: LoadedParagraph[], maxPerScene = 14000): string {
  return paragraphs.map((paragraph) => `=== SCENE ${paragraph.number}: ${paragraph.title} ===\n${truncate(paragraph.body, maxPerScene)}`).join("\n\n");
}

export function canonDirectory(kind: CanonKind): string {
  return CANON_DIRECTORIES[kind];
}

function escapeRegExp(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/** Scripts whose names run into the text around them: no spaces (Chinese, Japanese, Thai, Khmer, Lao, Burmese) or particles written right after the name (Korean). */
const RUNS_ON_SCRIPT = /[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}\p{Script=Hangul}\p{Script=Thai}\p{Script=Khmer}\p{Script=Lao}\p{Script=Myanmar}]/u;
const WORD_CHARACTER = /[\p{L}\p{N}_]/u;

/** Whether this character, next to a name, makes it part of a longer word: a letter or a number, unless of a script that runs into the text. */
function continuesWord(character: string | undefined): boolean {
  return character !== undefined && WORD_CHARACTER.test(character) && !RUNS_ON_SCRIPT.test(character);
}

function characterBefore(text: string, index: number): string | undefined {
  if (index <= 0) return undefined;
  const unit = text.charCodeAt(index - 1);
  const pair = unit >= 0xdc00 && unit <= 0xdfff && index >= 2 && text.charCodeAt(index - 2) >= 0xd800 && text.charCodeAt(index - 2) <= 0xdbff;
  return text.slice(index - (pair ? 2 : 1), index);
}

function characterAt(text: string, index: number): string | undefined {
  return index < text.length ? String.fromCodePoint(text.codePointAt(index) ?? 0) : undefined;
}

/**
 * Case-insensitive, whole-word Unicode match: "Eva" is found in "Eva smiled", never inside "aveva". A letter of a script
 * that runs into the text around the name (see `RUNS_ON_SCRIPT`) does not make the name part of a longer word: "李明" is
 * found in "李明走进了海边", "민수" in "민수는", "Mira" in "Miraは". The name is looked for first and only its candidates
 * have their boundaries checked, which is far quicker than a pattern with the boundaries in it when the canon is large.
 */
export function containsName(text: string, name: string): boolean {
  const needle = name.trim().replace(/\s+/g, " ");
  if (needle.length < 2) return false;
  const pattern = new RegExp(escapeRegExp(needle).replace(/ /g, "\\s+"), "giu");
  for (let match = pattern.exec(text); match; match = pattern.exec(text)) {
    if (!continuesWord(characterBefore(text, match.index)) && !continuesWord(characterAt(text, match.index + match[0].length))) return true;
    pattern.lastIndex = match.index + ((text.codePointAt(match.index) ?? 0) > 0xffff ? 2 : 1);
  }
  return false;
}

/** The names an entry can be mentioned by: longer than two characters, or two when written in a script whose names are that short. */
function canonNames(entry: CanonInfo): string[] {
  return [entry.name, ...entry.aliases].map((name) => name.trim()).filter((name) => (RUNS_ON_SCRIPT.test(name) ? [...name].length >= 2 : name.length > 2));
}

/**
 * Canon entries relevant to a text, for focused context. Entries named explicitly (the scene's
 * characters, location and point of view) come first, then those whose name or alias appears in
 * the text as a whole word; the list is capped after that ordering.
 */
export function mentionedCanon(snapshot: BookSnapshot, text: string, max = 12, explicit: string[] = []): CanonInfo[] {
  const candidates = snapshot.canon.filter((entry) => entry.kind !== "secret");
  const output: CanonInfo[] = [];
  const add = (entry: CanonInfo) => {
    if (!output.includes(entry)) output.push(entry);
  };
  for (const reference of explicit.map((value) => value.trim()).filter(Boolean)) {
    const named = candidates.filter((entry) => canonNames(entry).some((name) => name.toLowerCase() === reference.toLowerCase()));
    const matches = named.length ? named : candidates.filter((entry) => canonNames(entry).some((name) => containsName(name, reference) || containsName(reference, name)));
    matches.forEach(add);
  }
  for (const entry of candidates) if (canonNames(entry).some((name) => containsName(text, name))) add(entry);
  return output.slice(0, max);
}

export async function canonDetails(store: BookStore, entries: CanonInfo[], maxBody = 700): Promise<string> {
  const blocks = await Promise.all(entries.map(async (entry) => {
    const body = await readBody(store, entry.path, maxBody);
    return `### ${KIND_LABEL[entry.kind]}: ${entry.name}\n${body || entry.summary || ""}`.trim();
  }));
  return blocks.join("\n\n");
}
