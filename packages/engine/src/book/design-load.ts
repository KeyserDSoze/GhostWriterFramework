import { parseMarkdown } from "../markdown/frontmatter.js";
import { BIBLE_DECISIONS_FILE, BIBLE_THREADS_FILE, emptyBibleDecisions, readBibleDecisions, readBibleThreads, type BibleDecisions, type BibleThread } from "./bible.js";
import { ledgerChapter, readSecretLedger, type DesignCheckSecret, type DesignCheckTimelineEvent } from "./design.js";
import { referencedChapterNumber } from "./context.js";
import { spoilerChecks, type SpoilerSecret, type WrittenChapter } from "./spoilers.js";
import type { DesignFinding } from "./design.js";
import type { BookSnapshot } from "./snapshot.js";
import type { BookStore } from "./store.js";

/**
 * What the checks that came after the first ones read from a book, besides the Synopsis and the secrets (`loadDesignCheckInput`): the events of its timeline with the chapter
 * each is anchored to, the threads of `bible/threads.md`, and the text of the chapters already written. Read from the store, a few files at a time.
 */

const text = (value: unknown): string => (typeof value === "string" || typeof value === "number" ? String(value).trim() : value instanceof Date && !Number.isNaN(value.getTime()) ? value.toISOString().slice(0, 10) : "");

async function readAll(store: BookStore, paths: readonly string[]): Promise<Array<{ path: string; content: string }>> {
  const found: Array<{ path: string; content: string }> = [];
  const CHUNK = 24;
  for (let index = 0; index < paths.length; index += CHUNK) {
    const chunk = paths.slice(index, index + CHUNK);
    if (store.readMany) {
      for (const file of await store.readMany([...chunk])) found.push({ path: file.path, content: file.content });
    } else {
      for (const file of await Promise.all(chunk.map((path) => store.read(path)))) if (file) found.push({ path: file.path, content: file.content });
    }
  }
  return found;
}

/** The events of the timeline (`timelines/events/`), as the checks read them: the chapter an event is anchored to is `reveal_in`, else `known_from`. */
export async function loadTimelineEvents(store: BookStore, snapshot: BookSnapshot): Promise<DesignCheckTimelineEvent[]> {
  const entries = snapshot.canon.filter((entry) => entry.kind === "timeline-event");
  const files = new Map((await readAll(store, entries.map((entry) => entry.path))).map((file) => [file.path, file.content]));
  return entries.map((entry) => {
    const frontmatter = parseMarkdown(files.get(entry.path) ?? "").frontmatter;
    const date = text(frontmatter.date);
    const participants = Array.isArray(frontmatter.participants) ? frontmatter.participants.filter((item): item is string => typeof item === "string") : [];
    const chapter = referencedChapterNumber(entry.revealIn) ?? referencedChapterNumber(entry.knownFrom) ?? ledgerChapter(entry.revealIn) ?? ledgerChapter(entry.knownFrom);
    return { slug: entry.slug, title: entry.name, ...(date ? { date } : {}), participants, ...(chapter ? { chapter } : {}) };
  });
}

/** The threads of `bible/threads.md` (none when the file is not there). */
export async function loadThreads(store: BookStore): Promise<BibleThread[]> {
  const file = await store.read(BIBLE_THREADS_FILE);
  return file ? readBibleThreads(file.content).value.threads : [];
}

/** The text of the written chapters: the body of each of their scenes in order, without the frontmatter, for the chapters named (all of them when none is). */
export async function loadWrittenChapters(store: BookStore, snapshot: BookSnapshot, only?: readonly number[]): Promise<WrittenChapter[]> {
  const wanted = only ? new Set(only) : null;
  const chapters = snapshot.chapters.filter((chapter) => chapter.paragraphs.length && (!wanted || wanted.has(chapter.number)));
  const written: WrittenChapter[] = [];
  for (const chapter of chapters) {
    const files = await readAll(store, chapter.paragraphs.map((paragraph) => paragraph.path));
    const byPath = new Map(files.map((file) => [file.path, file.content]));
    const body = chapter.paragraphs.map((paragraph) => parseMarkdown(byPath.get(paragraph.path) ?? "").body).filter(Boolean).join("\n\n");
    if (body) written.push({ number: chapter.number, text: body });
  }
  return written;
}

/** The secrets as the spoiler check reads them: the design check's, with the truth of each (the body of its file). */
export async function loadSpoilerSecrets(store: BookStore, snapshot: BookSnapshot, secrets: readonly DesignCheckSecret[]): Promise<SpoilerSecret[]> {
  const entries = snapshot.canon.filter((entry) => entry.kind === "secret");
  const files = new Map((await readAll(store, entries.map((entry) => entry.path))).map((file) => [file.path, file.content]));
  const bySlug = new Map(entries.map((entry) => [entry.slug, entry.path]));
  return secrets.map((secret) => {
    const content = files.get(bySlug.get(secret.slug) ?? "") ?? "";
    const document = parseMarkdown(content);
    return { ...secret, truth: document.body, ledger: secret.ledger ?? readSecretLedger(document.frontmatter).ledger };
  });
}

/** The decisions and the open questions of `bible/decisions.md` (none when the file is not there): what every agent that works on the book is told. */
export async function loadDecisions(store: BookStore): Promise<BibleDecisions> {
  const file = await store.read(BIBLE_DECISIONS_FILE);
  return file ? readBibleDecisions(file.content).value : emptyBibleDecisions();
}

/**
 * The secrets of a book as the spoiler check reads them, with the chapter that reveals each (`reveal_in`, else the one the plan of the design gives it, else
 * `known_from`): what the review of a written chapter needs, without the Synopsis.
 */
export async function loadSpoilerSecretsOfBook(store: BookStore, snapshot: BookSnapshot, planned: ReadonlyMap<string, number | undefined> = new Map()): Promise<SpoilerSecret[]> {
  const entries = snapshot.canon.filter((entry) => entry.kind === "secret");
  const files = new Map((await readAll(store, entries.map((entry) => entry.path))).map((file) => [file.path, file.content]));
  return entries.map((entry) => {
    const document = parseMarkdown(files.get(entry.path) ?? "");
    const holders = Array.isArray(document.frontmatter.holders) ? document.frontmatter.holders.filter((item): item is string => typeof item === "string") : [];
    const reveal = referencedChapterNumber(entry.revealIn) ?? planned.get(entry.slug) ?? referencedChapterNumber(entry.knownFrom);
    const knownFrom = referencedChapterNumber(entry.knownFrom);
    return { slug: entry.slug, title: entry.name, holders, ledger: readSecretLedger(document.frontmatter).ledger, truth: document.body, ...(reveal ? { revealChapter: reveal } : {}), ...(knownFrom ? { knownFromChapter: knownFrom } : {}) };
  });
}

/** The spoiler check of one written chapter, from its text as the readers read it: what the director's review is given as evidence. */
export async function spoilerFindingsOfChapter(store: BookStore, snapshot: BookSnapshot, chapter: WrittenChapter, planned?: ReadonlyMap<string, number | undefined>): Promise<DesignFinding[]> {
  const secrets = await loadSpoilerSecretsOfBook(store, snapshot, planned);
  return spoilerChecks({ chapters: [chapter], secrets: secrets.filter((secret) => [secret.revealChapter, secret.knownFromChapter].some((value) => typeof value === "number" && value > chapter.number)) });
}
