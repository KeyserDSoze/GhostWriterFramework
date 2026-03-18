import path from "node:path";
import { readdir } from "node:fs/promises";
import { listChapters, listEntities, pathExists, readBook, readChapter, readEntity, readTimelineMain, } from "narrarium";
import { defaultBookRoot } from "./book-config.js";
import { readReaderBookRootEnv, resolveReaderBookRootCandidate } from "./env.js";
export function getBookRoot() {
    const configured = readReaderBookRootEnv();
    const resolvedConfigured = resolveReaderBookRootCandidate(configured);
    if (resolvedConfigured)
        return resolvedConfigured;
    return path.resolve(process.cwd(), defaultBookRoot);
}
export async function loadHomePageData() {
    const root = getBookRoot();
    const hasBook = await pathExists(path.join(root, "book.md"));
    if (!hasBook) {
        return {
            ready: false,
            root,
            book: null,
            chapters: [],
            draftChapterCount: 0,
            characters: [],
            locations: [],
            factions: [],
            items: [],
            secrets: [],
            timelineEvents: [],
        };
    }
    const [book, chapters, draftChapterCount, characters, locations, factions, items, secrets, timelineEvents] = await Promise.all([
        readBook(root),
        listChapters(root),
        countDraftChapters(root),
        listEntities(root, "character"),
        listEntities(root, "location"),
        listEntities(root, "faction"),
        listEntities(root, "item"),
        listEntities(root, "secret"),
        listEntities(root, "timeline-event"),
    ]);
    return {
        ready: true,
        root,
        book,
        chapters,
        draftChapterCount,
        characters,
        locations,
        factions,
        items,
        secrets,
        timelineEvents,
    };
}
async function countDraftChapters(root) {
    const draftsRoot = path.join(root, "drafts");
    const entries = await readdir(draftsRoot, { withFileTypes: true }).catch(() => []);
    return entries.filter((entry) => entry.isDirectory()).length;
}
export async function loadChapterPageData(chapterSlug) {
    const root = getBookRoot();
    return readChapter(root, chapterSlug);
}
export async function loadEntityIndexData(kind) {
    const root = getBookRoot();
    const ready = await pathExists(path.join(root, "book.md"));
    if (!ready) {
        return { ready: false, root, entities: [] };
    }
    return {
        ready: true,
        root,
        entities: await listEntities(root, kind),
    };
}
export async function loadEntityPageData(kind, slug) {
    const root = getBookRoot();
    return readEntity(root, kind, slug);
}
export async function loadTimelinePageData() {
    const root = getBookRoot();
    const ready = await pathExists(path.join(root, "book.md"));
    if (!ready) {
        return {
            ready: false,
            root,
            main: null,
            events: [],
        };
    }
    const [main, events] = await Promise.all([readTimelineMain(root), listEntities(root, "timeline-event")]);
    return {
        ready: true,
        root,
        main,
        events,
    };
}
//# sourceMappingURL=book.js.map