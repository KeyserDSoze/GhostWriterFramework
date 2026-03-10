import path from "node:path";
import { listChapters, readChapter } from "narrarium";
import { getBookRoot } from "./book.js";
import { loadCanonGlossary } from "./glossary.js";
import { isFullCanonMode } from "./reader-mode.js";
const searchIndexPromises = new Map();
export async function loadSearchIndex(chapterNumber) {
    const cacheKey = String(chapterNumber ?? "public");
    let searchIndexPromise = searchIndexPromises.get(cacheKey);
    if (!searchIndexPromise) {
        searchIndexPromise = buildSearchIndex(chapterNumber);
        searchIndexPromises.set(cacheKey, searchIndexPromise);
    }
    return searchIndexPromise;
}
async function buildSearchIndex(chapterNumber) {
    const root = getBookRoot();
    const fullMode = isFullCanonMode();
    const glossary = await loadCanonGlossary(fullMode ? Number.MAX_SAFE_INTEGER : chapterNumber);
    const chapters = await listChapters(root);
    const visibleChapters = fullMode
        ? chapters
        : typeof chapterNumber === "number"
            ? chapters.filter((chapter) => chapter.metadata.number <= chapterNumber)
            : chapters;
    const chapterEntries = await Promise.all(visibleChapters.flatMap(async (chapter) => {
        const chapterData = await readChapter(root, chapter.slug);
        const chapterEntry = {
            title: chapter.metadata.title,
            href: `chapters/${chapter.slug}/`,
            kind: "Chapter",
            kindKey: "chapter",
            summary: String(chapter.metadata.summary ?? "Read this chapter."),
            keywords: compactStrings([chapter.metadata.summary, ...(chapter.metadata.tags ?? []), ...(chapter.metadata.pov ?? [])]),
            chapterNumber: chapter.metadata.number,
            visibleFrom: chapter.metadata.number,
            revealedFrom: chapter.metadata.number,
        };
        const sceneEntries = chapterData.paragraphs.map((paragraph) => ({
            title: paragraph.metadata.title,
            href: `chapters/${chapter.slug}/#scene-${path.basename(paragraph.path, ".md")}`,
            kind: "Scene",
            kindKey: "scene",
            summary: String(paragraph.metadata.summary ?? `Scene in ${chapter.metadata.title}.`),
            keywords: compactStrings([chapter.metadata.title, paragraph.metadata.viewpoint, paragraph.metadata.summary]),
            chapterNumber: chapter.metadata.number,
            visibleFrom: chapter.metadata.number,
            revealedFrom: chapter.metadata.number,
        }));
        return [chapterEntry, ...sceneEntries];
    }));
    return [
        ...glossary.map((entry) => ({
            title: entry.label,
            href: entry.href,
            kind: entry.kindLabel,
            kindKey: entry.kind,
            summary: entry.summary,
            keywords: [...entry.terms, ...entry.meta, ...entry.metadataEntries.map((item) => item.value)],
            chapterNumber: null,
            visibleFrom: entry.visibleFrom,
            revealedFrom: entry.revealedFrom,
        })),
        ...chapterEntries.flat(),
    ];
}
function compactStrings(values) {
    return values.flatMap((value) => {
        if (Array.isArray(value)) {
            return compactStrings(value);
        }
        if (value === undefined || value === null) {
            return [];
        }
        const normalized = String(value).trim();
        return normalized ? [normalized] : [];
    });
}
//# sourceMappingURL=search.js.map