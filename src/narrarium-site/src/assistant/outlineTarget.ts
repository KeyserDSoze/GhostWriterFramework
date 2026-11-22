/**
 * «Chapter» means two things in Narrarium: the chapter of the book (its folder, its text) and the entry of the outline (the Scaletta,
 * `outline/chapters/<NNN>.md`, the plan of the chapter). Which one the author means depends on where they are, and this module says it once,
 * for the Copilot's instructions and for its routing: on the Outline page and on the autopilot's pages (live and settings) «chapter N» and
 * «that chapter» are the entry N of the outline; on every other page of a book they are the chapter of the book; the words «scaletta» and
 * «outline» always mean the outline; and when a request on an outline page speaks of the written text, the Copilot asks which one.
 */

export type ChapterTargetMode = "outline" | "chapter" | "none";

export type ChapterReference =
  | { target: "outline"; reason: "named" | "page" }
  | { target: "chapter"; reason: "named" | "page" }
  | { target: "ask"; reason: "both" };

/** The pages where a chapter is an entry of the outline: the Outline, and every page of the autopilot (`book-autopilot`, and the ones under it). */
export function chapterTargetMode(route: { kind: string }): ChapterTargetMode {
  if (route.kind === "book-outline" || route.kind === "book-autopilot" || route.kind.startsWith("book-autopilot-")) return "outline";
  return "bookId" in route ? "chapter" : "none";
}

/** The outline named in a request, in either language. */
const OUTLINE_WORDS = /(?<![\p{L}\p{N}])(?:scalett[ae]|outlines?)(?![\p{L}\p{N}])/iu;
/** A chapter named in a request: «capitolo 3», «chapter 3», «quel capitolo», «this chapter». */
const CHAPTER_WORDS = /(?<![\p{L}\p{N}])(?:capitol[oi]|chapters?)(?![\p{L}\p{N}])/iu;
/** The written chapter named as such: the way out of a doubt, on any page. */
const WRITTEN_CHAPTER = /(?<![\p{L}\p{N}])(?:capitolo scritto|testo del capitolo|nel testo|capitolo vero|written chapter|chapter's text|text of the chapter|chapter text|actual chapter|real chapter)(?![\p{L}\p{N}])/iu;
/** What only the written chapter has: its prose, its scenes or paragraphs. */
const PROSE_WORDS = /(?<![\p{L}\p{N}])(?:prosa|scen[ae]|paragraf[oi]|prose|scenes?|paragraphs?)(?![\p{L}\p{N}])/iu;

/**
 * Which chapter a request is about, or `null` when it names none. The outline when it is named, the written chapter when it is named as such;
 * else the page decides, and on an outline page a request that speaks of scenes or prose is a doubt (`ask`).
 */
export function resolveChapterReference(prompt: string, route: { kind: string }): ChapterReference | null {
  const mode = chapterTargetMode(route);
  if (mode === "none") return null;
  if (OUTLINE_WORDS.test(prompt)) return { target: "outline", reason: "named" };
  if (WRITTEN_CHAPTER.test(prompt)) return { target: "chapter", reason: "named" };
  if (!CHAPTER_WORDS.test(prompt)) return null;
  if (mode === "outline") return PROSE_WORDS.test(prompt) ? { target: "ask", reason: "both" } : { target: "outline", reason: "page" };
  return { target: "chapter", reason: "page" };
}

/** The rule as the Copilot's instructions say it, for the page the author is on ("" off the pages of a book). */
export function chapterTargetInstruction(route: { kind: string }): string {
  const mode = chapterTargetMode(route);
  if (mode === "none") return "";
  const shared = "The outline (the Scaletta) is the author's chapter-by-chapter plan of the book: outline/book.md holds the rough description, and outline/chapters/<NNN>.md one entry per chapter with a hypothetical title, what happens and its ghostwriter. The words «outline» and «scaletta» always mean it, on any page.";
  return mode === "outline"
    ? `WHICH CHAPTER: ${shared} On this page «chapter N», «this chapter» and «that chapter» mean entry N of the outline (outline/chapters/<NNN>.md), not the chapter's written text: change only the outline, unless the author says «the written chapter» or «the chapter's text». If it is unclear whether the author means the entry of the outline or the written chapter, ask which one before changing anything.`
    : `WHICH CHAPTER: ${shared} On this page «chapter N» means the chapter of the book (its folder under chapters/, its text and files), not its entry of the outline. If it is unclear whether the author means the written chapter or its entry of the outline, ask which one before changing anything.`;
}
