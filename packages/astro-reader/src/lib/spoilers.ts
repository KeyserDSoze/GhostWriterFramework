import { listChapters } from "narrarium";
import { getBookRoot } from "./book.js";

export type SpoilerAccess = {
  visibleFrom: number | null;
  revealedFrom: number | null;
  isVisible: boolean;
  isRevealed: boolean;
};

let chapterOrderPromise: Promise<Map<string, number>> | null = null;

export async function loadChapterOrder(): Promise<Map<string, number>> {
  chapterOrderPromise ??= buildChapterOrder();
  return chapterOrderPromise;
}

export function getSpoilerAccess(
  metadata: Record<string, unknown>,
  chapterOrder: Map<string, number>,
  chapterNumber?: number,
): SpoilerAccess {
  const visibleFrom = resolveChapterNumber(metadata.known_from, chapterOrder);
  const revealedFrom = resolveChapterNumber(metadata.reveal_in, chapterOrder);
  const isVisible = visibleFrom === null || (typeof chapterNumber === "number" && chapterNumber >= visibleFrom);
  const isRevealed = revealedFrom === null || (typeof chapterNumber === "number" && chapterNumber >= revealedFrom);

  return {
    visibleFrom,
    revealedFrom,
    isVisible,
    isRevealed,
  };
}

export function resolveChapterNumber(reference: unknown, chapterOrder: Map<string, number>): number | null {
  if (typeof reference !== "string") {
    return null;
  }

  const normalized = reference.trim();
  if (!normalized) {
    return null;
  }

  for (const [slug, number] of chapterOrder.entries()) {
    if (matchesChapterReference(normalized, slug)) {
      return number;
    }
  }

  return null;
}

export function formatChapterThreshold(number: number | null): string {
  return number === null ? "later in the book" : `Chapter ${String(number).padStart(3, "0")}`;
}

function matchesChapterReference(reference: string, chapterSlug: string): boolean {
  return [
    reference,
    reference.replace(/^chapter:/, ""),
    reference.replace(/^chapters\//, "").replace(/\/chapter\.md$/, ""),
  ].includes(chapterSlug);
}

async function buildChapterOrder(): Promise<Map<string, number>> {
  const chapters = await listChapters(getBookRoot());
  return new Map(chapters.map((chapter) => [chapter.slug, chapter.metadata.number]));
}
