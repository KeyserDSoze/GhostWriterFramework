import { listChapters } from "narrarium";
import { getBookRoot } from "./book.js";
let chapterOrderPromise = null;
export async function loadChapterOrder() {
    chapterOrderPromise ??= buildChapterOrder();
    return chapterOrderPromise;
}
export function getSpoilerAccess(metadata, chapterOrder, chapterNumber) {
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
export function resolveChapterNumber(reference, chapterOrder) {
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
export function formatChapterThreshold(number) {
    return number === null ? "later in the book" : `Chapter ${String(number).padStart(3, "0")}`;
}
function matchesChapterReference(reference, chapterSlug) {
    return [
        reference,
        reference.replace(/^chapter:/, ""),
        reference.replace(/^chapters\//, "").replace(/\/chapter\.md$/, ""),
    ].includes(chapterSlug);
}
async function buildChapterOrder() {
    const chapters = await listChapters(getBookRoot());
    return new Map(chapters.map((chapter) => [chapter.slug, chapter.metadata.number]));
}
//# sourceMappingURL=spoilers.js.map