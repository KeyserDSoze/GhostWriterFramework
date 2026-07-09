import type { LoadedWriterContext } from "@/assistant/context";
import type { AssistantAction } from "@/assistant/store";
import type { Chapter, Paragraph } from "@/types/book";

export type NavigateAction = Extract<AssistantAction, { kind: "navigate" }>;
export type ReadAloudAction = Extract<AssistantAction, { kind: "read-aloud" }>;

const READ_KEYWORDS = /\b(leggi|leggimi|leggile|leggilo|riproduci|ascolta|recita|read|read aloud|read out|play)\b/i;
const NAV_KEYWORDS = /\b(apri|apre|aprimi|vai|va'|vammi|portami|mostra|mostrami|naviga|open|go to|goto|show me|show|navigate|take me|jump to)\b/i;
const FRONTMATTER_KEYWORDS = /\b(frontmatter|metadat|metadata|intestazion|header|campi|fields)\b/i;

/** Resolve a chapter by an explicit number like "capitolo 3" -> slug "003-...". */
function findChapterByNumber(context: LoadedWriterContext, rawNumber: string): Chapter | null {
  const structure = context.structure;
  if (!structure) return null;
  const padded = rawNumber.padStart(3, "0");
  return structure.chapters.find((entry) => entry.slug.startsWith(`${padded}-`)) ?? null;
}

function findParagraphByNumber(chapter: Chapter, rawNumber: string): Paragraph | null {
  const padded = rawNumber.padStart(3, "0");
  return chapter.paragraphs.find((entry) => entry.number === padded) ?? null;
}

/** Build the ordered repo paths that make up a read target (chapter intro + paragraphs, or a single paragraph). */
function chapterReadPaths(chapter: Chapter): string[] {
  return [`${chapter.path}/chapter.md`, ...chapter.paragraphs.map((paragraph) => paragraph.path)];
}

/**
 * No-LLM resolver: turns a "read/leggi ..." prompt into a read-aloud action carrying the
 * repo paths to speak. The UI executes the actual TTS (navigation/audio stay in the UI layer).
 */
export function resolveReadAloudAction(
  prompt: string,
  context: LoadedWriterContext,
  bookId: string,
): ReadAloudAction | null {
  const lower = prompt.toLowerCase();
  if (!READ_KEYWORDS.test(lower)) return null;
  const structure = context.structure;
  if (!structure) return null;
  const includeFrontmatter = FRONTMATTER_KEYWORDS.test(lower);

  const paragraphThenChapter = lower.match(/(?:paragrafo|paragraph|scena|scene)\s+(\d+).*?(?:capitolo|chapter)\s+(\d+)/);
  const chapterThenParagraph = lower.match(/(?:capitolo|chapter)\s+(\d+).*?(?:paragrafo|paragraph|scena|scene)\s+(\d+)/);
  if (paragraphThenChapter || chapterThenParagraph) {
    const paragraphNumber = paragraphThenChapter?.[1] ?? chapterThenParagraph?.[2] ?? "";
    const chapterNumber = paragraphThenChapter?.[2] ?? chapterThenParagraph?.[1] ?? "";
    const chapter = findChapterByNumber(context, chapterNumber);
    const paragraph = chapter ? findParagraphByNumber(chapter, paragraphNumber) : null;
    if (chapter && paragraph) {
      return { kind: "read-aloud", bookId, title: paragraph.title, paths: [paragraph.path], includeFrontmatter };
    }
  }

  const paragraphMatch = lower.match(/(?:questo\s+)?(?:paragrafo|paragraph|scena|scene)\s*(\d+)?/);
  if (paragraphMatch && context.chapter) {
    const paragraph = paragraphMatch[1]
      ? findParagraphByNumber(context.chapter, paragraphMatch[1])
      : context.paragraph;
    if (paragraph) {
      return { kind: "read-aloud", bookId, title: paragraph.title, paths: [paragraph.path], includeFrontmatter };
    }
  }

  const chapterMatch = lower.match(/(?:questo\s+)?(?:capitolo|chapter)\s*(\d+)?/);
  if (chapterMatch) {
    const chapter = chapterMatch[1] ? findChapterByNumber(context, chapterMatch[1]) : context.chapter;
    if (chapter) {
      return { kind: "read-aloud", bookId, title: chapter.title, paths: chapterReadPaths(chapter), includeFrontmatter };
    }
  }

  // "read this / leggi questa pagina" with no explicit target: read whatever is loaded here.
  if (context.paragraph && context.chapter) {
    return { kind: "read-aloud", bookId, title: context.paragraph.title, paths: [context.paragraph.path], includeFrontmatter };
  }
  if (context.chapter) {
    return { kind: "read-aloud", bookId, title: context.chapter.title, paths: chapterReadPaths(context.chapter), includeFrontmatter };
  }
  return null;
}

/**
 * No-LLM resolver: turns an "open/apri/vai ..." prompt into a navigate action carrying an app route.
 * The UI performs the actual navigation.
 */
export function resolveNavigateAction(
  prompt: string,
  context: LoadedWriterContext,
  bookId: string,
): NavigateAction | null {
  const lower = prompt.toLowerCase();
  if (!NAV_KEYWORDS.test(lower)) return null;
  const base = `/app/books/${bookId}`;

  // Explicit chapter / paragraph navigation.
  const paragraphThenChapter = lower.match(/(?:paragrafo|paragraph|scena|scene)\s+(\d+).*?(?:capitolo|chapter)\s+(\d+)/);
  const chapterThenParagraph = lower.match(/(?:capitolo|chapter)\s+(\d+).*?(?:paragrafo|paragraph|scena|scene)\s+(\d+)/);
  if (paragraphThenChapter || chapterThenParagraph) {
    const paragraphNumber = paragraphThenChapter?.[1] ?? chapterThenParagraph?.[2] ?? "";
    const chapterNumber = paragraphThenChapter?.[2] ?? chapterThenParagraph?.[1] ?? "";
    const chapter = findChapterByNumber(context, chapterNumber);
    const paragraph = chapter ? findParagraphByNumber(chapter, paragraphNumber) : null;
    if (chapter && paragraph) {
      return { kind: "navigate", to: `${base}/chapters/${chapter.slug}/paragraphs/${paragraph.number}`, label: `${chapter.title} · ${paragraph.title}` };
    }
  }

  if (/\b(reader|lettore|lettura)\b/.test(lower)) {
    return { kind: "navigate", to: `${base}/reader`, label: "Reader" };
  }
  if (/\b(research|ricerca|ricerche)\b/.test(lower)) {
    return { kind: "navigate", to: `${base}/research`, label: "Research" };
  }
  if (/\b(export|esporta|esportazione|epub|pdf)\b/.test(lower)) {
    return { kind: "navigate", to: `${base}/export`, label: "Export" };
  }
  if (/\b(dashboard|cruscotto|panoramica)\b/.test(lower)) {
    return { kind: "navigate", to: `${base}/dashboard`, label: "Dashboard" };
  }
  if (/\b(assets|risorse|immagini|media)\b/.test(lower)) {
    return { kind: "navigate", to: `${base}/assets`, label: "Assets" };
  }
  if (/\b(ghostwriter|ghostwriters|autor)\b/.test(lower)) {
    return { kind: "navigate", to: `${base}/ghostwriters`, label: "Ghostwriters" };
  }
  if (/\b(impostazion|settings|preferenz)\b/.test(lower)) {
    if (/\b(libro|book)\b/.test(lower)) return { kind: "navigate", to: `${base}/settings`, label: "Book settings" };
    return { kind: "navigate", to: `/app/settings`, label: "Settings" };
  }

  const chapterMatch = lower.match(/(?:questo\s+)?(?:capitolo|chapter)\s*(\d+)?/);
  if (chapterMatch) {
    const chapter = chapterMatch[1] ? findChapterByNumber(context, chapterMatch[1]) : context.chapter;
    if (chapter) {
      return { kind: "navigate", to: `${base}/chapters/${chapter.slug}`, label: chapter.title };
    }
  }

  return null;
}
