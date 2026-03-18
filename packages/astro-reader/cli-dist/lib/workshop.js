import path from "node:path";
import { readFile, readdir } from "node:fs/promises";
import { marked } from "marked";
import { parseNarrariumMarkdownDocument, pathExists, readChapterDraft } from "narrarium";
import { getBookRoot } from "./book.js";
export async function loadWorkshopPageData() {
    const root = getBookRoot();
    const ready = await pathExists(path.join(root, "book.md"));
    if (!ready) {
        return {
            ready: false,
            root,
            global: null,
            draftChapters: [],
        };
    }
    const [context, ideas, notes, storyDesign, promoted, draftChapters] = await Promise.all([
        readWorkshopDocument(root, "context.md"),
        readWorkshopDocument(root, "ideas.md"),
        readWorkshopDocument(root, "notes.md"),
        readWorkshopDocument(root, "story-design.md"),
        readWorkshopDocument(root, "promoted.md"),
        listDraftChapters(root),
    ]);
    return {
        ready: true,
        root,
        global: {
            context,
            ideas,
            notes,
            storyDesign,
            promoted,
        },
        draftChapters,
    };
}
export async function countDraftChapters(root) {
    return (await listDraftChapters(root)).length;
}
async function listDraftChapters(root) {
    const draftsRoot = path.join(root, "drafts");
    const entries = await readdir(draftsRoot, { withFileTypes: true }).catch(() => []);
    const slugs = entries.filter((entry) => entry.isDirectory()).map((entry) => entry.name).sort();
    const chapters = await Promise.all(slugs.map(async (slug) => {
        const chapterFile = path.join(draftsRoot, slug, "chapter.md");
        if (!(await pathExists(chapterFile))) {
            return null;
        }
        const chapter = await readChapterDraft(root, slug);
        const [ideas, notes, promoted] = await Promise.all([
            readWorkshopDocument(root, path.posix.join("drafts", slug, "ideas.md")),
            readWorkshopDocument(root, path.posix.join("drafts", slug, "notes.md")),
            readWorkshopDocument(root, path.posix.join("drafts", slug, "promoted.md")),
        ]);
        return {
            slug,
            title: chapter.metadata.title,
            summary: chapter.metadata.summary ?? "Draft chapter in progress.",
            bodyHtml: await toHtml(chapter.body || "No chapter draft body yet."),
            paragraphs: chapter.paragraphs.map((paragraph) => ({
                slug: path.basename(paragraph.path, ".md"),
                title: paragraph.metadata.title,
                summary: paragraph.metadata.summary ?? "Draft scene.",
            })),
            ideas,
            notes,
            promoted,
        };
    }));
    return chapters.filter((chapter) => Boolean(chapter));
}
async function readWorkshopDocument(root, relativePath) {
    const absolutePath = path.join(root, relativePath);
    const raw = await readFile(absolutePath, "utf8").catch(() => null);
    if (!raw) {
        return null;
    }
    const document = parseNarrariumMarkdownDocument(relativePath, raw);
    const frontmatter = document.frontmatter;
    const title = typeof frontmatter.title === "string" && frontmatter.title.trim() ? frontmatter.title : relativePath;
    const bucket = typeof frontmatter.bucket === "string" ? frontmatter.bucket : document.kind;
    return {
        path: relativePath,
        title,
        bucket,
        bodyHtml: await toHtml(document.body || "No content yet."),
        entries: readWorkshopEntries(frontmatter),
    };
}
function readWorkshopEntries(frontmatter) {
    if (!Array.isArray(frontmatter.entries)) {
        return [];
    }
    return frontmatter.entries
        .filter((entry) => Boolean(entry && typeof entry === "object"))
        .map((entry) => ({
        id: typeof entry.id === "string" ? entry.id : "",
        title: typeof entry.title === "string" ? entry.title : "Untitled",
        body: typeof entry.body === "string" ? entry.body : "",
        status: typeof entry.status === "string" ? entry.status : "active",
        tags: Array.isArray(entry.tags) ? entry.tags.filter((tag) => typeof tag === "string") : [],
        sourceKind: typeof entry.source_kind === "string" ? entry.source_kind : undefined,
        promotedTo: typeof entry.promoted_to === "string" ? entry.promoted_to : undefined,
    }))
        .filter((entry) => entry.id.length > 0)
        .sort((left, right) => left.title.localeCompare(right.title));
}
async function toHtml(markdown) {
    const rendered = await marked.parse(markdown);
    return typeof rendered === "string" ? rendered : String(rendered);
}
//# sourceMappingURL=workshop.js.map