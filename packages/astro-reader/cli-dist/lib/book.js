import path from "node:path";
import { listChapters, listEntities, pathExists, readBook, readChapter, readEntity, readTimelineMain, } from "narrarium";
import { defaultBookRoot } from "./book-config.js";
export function getBookRoot() {
    const configured = process.env.NARRARIUM_BOOK_ROOT ?? process.env.GHOSTWRITER_BOOK_ROOT;
    if (configured)
        return path.resolve(configured);
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
            characters: [],
            locations: [],
            factions: [],
            items: [],
            secrets: [],
            timelineEvents: [],
        };
    }
    const [book, chapters, characters, locations, factions, items, secrets, timelineEvents] = await Promise.all([
        readBook(root),
        listChapters(root),
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
        characters,
        locations,
        factions,
        items,
        secrets,
        timelineEvents,
    };
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