import path from "node:path";
import { listChapters, readChapter } from "@ghostwriter/core";
import { getBookRoot } from "./book.js";
import { loadCanonGlossary } from "./glossary.js";
let searchIndexPromise = null;
export async function loadSearchIndex() {
    searchIndexPromise ??= buildSearchIndex();
    return searchIndexPromise;
}
async function buildSearchIndex() {
    const root = getBookRoot();
    const glossary = await loadCanonGlossary();
    const chapters = await listChapters(root);
    const chapterEntries = await Promise.all(chapters.flatMap(async (chapter) => {
        const chapterData = await readChapter(root, chapter.slug);
        const chapterEntry = {
            title: chapter.metadata.title,
            href: `chapters/${chapter.slug}/`,
            kind: "Chapter",
            summary: String(chapter.metadata.summary ?? "Read this chapter."),
            keywords: compactStrings([chapter.metadata.summary, ...(chapter.metadata.tags ?? []), ...(chapter.metadata.pov ?? [])]),
        };
        const sceneEntries = chapterData.paragraphs.map((paragraph) => ({
            title: paragraph.metadata.title,
            href: `chapters/${chapter.slug}/#scene-${path.basename(paragraph.path, ".md")}`,
            kind: "Scene",
            summary: String(paragraph.metadata.summary ?? `Scene in ${chapter.metadata.title}.`),
            keywords: compactStrings([chapter.metadata.title, paragraph.metadata.viewpoint, paragraph.metadata.summary]),
        }));
        return [chapterEntry, ...sceneEntries];
    }));
    return [
        ...glossary.map((entry) => ({
            title: entry.label,
            href: entry.href,
            kind: entry.kindLabel,
            summary: entry.summary,
            keywords: [...entry.terms, ...entry.meta, ...entry.metadataEntries.map((item) => item.value)],
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