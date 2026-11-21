import { parseMarkdown, type MarkdownDocument } from "../markdown/frontmatter.js";
import { defaultDirector, parseDirector, type DirectorProfile } from "../profiles/director.js";
import { ghostwriterPrompt, parseGhostwriter, type GhostwriterProfile } from "../profiles/ghostwriter.js";
import { mergeReaderPersonas, parseReaderPersona, type ReaderPersonaProfile } from "../profiles/readers.js";
import { truncate } from "../util/text.js";
import { CANON_DIRECTORIES, DIRECTOR_FILE, chapterNumberFromSlug, type CanonKind } from "./paths.js";
import type { BookSnapshot, CanonInfo, ChapterInfo, ParagraphInfo } from "./snapshot.js";
import type { BookFileContent, BookStore } from "./store.js";

export async function readDocument(store: BookStore, path: string): Promise<{ file: BookFileContent; document: MarkdownDocument } | null> {
  const file = await store.read(path);
  return file ? { file, document: parseMarkdown(file.content) } : null;
}

/** Body of a Markdown file without frontmatter, truncated; empty string when missing. */
export async function readBody(store: BookStore, path: string, max = 6000): Promise<string> {
  const loaded = await readDocument(store, path);
  return loaded ? truncate(loaded.document.body, max) : "";
}

/** True when a scaffolded document still has only headings, placeholders and template hints. */
export function isThinDocument(body: string): boolean {
  const meaningful = body
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line && !line.startsWith("#"))
    .filter((line) => !/^-\s*(?:record|describe|note|translate|add|keep)\b/i.test(line))
    .join(" ");
  return meaningful.length < 160;
}

export async function loadDirectorProfile(store: BookStore, language?: string): Promise<DirectorProfile> {
  const file = await store.read(DIRECTOR_FILE);
  return file ? parseDirector(file.content, language) : defaultDirector(language);
}

export async function loadGhostwriter(store: BookStore, snapshot: BookSnapshot, chapter?: ChapterInfo, paragraph?: ParagraphInfo): Promise<GhostwriterProfile | null> {
  const slug = paragraph?.ghostwriter || chapter?.ghostwriter || snapshot.book.ghostwriter || (snapshot.ghostwriterSlugs.includes("default") ? "default" : snapshot.ghostwriterSlugs[0]);
  if (!slug) return null;
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

/** Canon entries whose name or alias appears in the given text (for focused context). */
export function mentionedCanon(snapshot: BookSnapshot, text: string, max = 12): CanonInfo[] {
  const haystack = text.toLowerCase();
  return snapshot.canon
    .filter((entry) => entry.kind !== "secret")
    .filter((entry) => [entry.name, ...entry.aliases].some((name) => name.length > 2 && haystack.includes(name.toLowerCase())))
    .slice(0, max);
}

export async function canonDetails(store: BookStore, entries: CanonInfo[], maxBody = 700): Promise<string> {
  const blocks = await Promise.all(entries.map(async (entry) => {
    const body = await readBody(store, entry.path, maxBody);
    return `### ${KIND_LABEL[entry.kind]}: ${entry.name}\n${body || entry.summary || ""}`.trim();
  }));
  return blocks.join("\n\n");
}
