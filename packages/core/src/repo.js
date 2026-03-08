import { mkdir, readFile, readdir, stat, writeFile } from "node:fs/promises";
import path from "node:path";
import fg from "fast-glob";
import matter from "gray-matter";
import { marked } from "marked";
import { BOOK_DIRECTORIES, BOOK_FILE, CONTENT_GLOB, DEFAULT_CANON, ENTITY_TYPE_TO_DIRECTORY, GUIDELINE_FILES, SKILL_NAME, TIMELINE_MAIN_FILE, TOTAL_EVALUATION_FILE, TOTAL_RESUME_FILE, } from "./constants.js";
import { bookSchema, chapterSchema, entitySchemaMap, guidelineSchema, paragraphSchema, researchNoteSchema, } from "./schemas.js";
import { skillTemplate } from "./skill-template.js";
import { defaultBodyForType, renderMarkdown } from "./templates.js";
import { chapterSlug, excerptAround, normalizeChapterReference, paragraphFilename, pathExists, slugify, toPosixPath, } from "./utils.js";
export async function initializeBookRepo(rootPath, options) {
    const root = path.resolve(rootPath);
    const created = [];
    await mkdir(root, { recursive: true });
    for (const directory of BOOK_DIRECTORIES) {
        await mkdir(path.join(root, directory), { recursive: true });
    }
    await ensureFile(root, BOOK_FILE, renderMarkdown(bookSchema.parse({
        type: "book",
        id: "book",
        title: options.title,
        author: options.author,
        language: options.language ?? "en",
        canon: DEFAULT_CANON,
    }), defaultBodyForType("book")), created);
    await ensureFile(root, GUIDELINE_FILES.style, renderMarkdown(guidelineSchema.parse({
        type: "guideline",
        id: "guideline:style",
        title: "Style Guide",
        scope: "global",
    }), "# Rules\n\n- Define sentence rhythm, tone, and taboo patterns.\n\n# Examples\n"), created);
    await ensureFile(root, GUIDELINE_FILES.chapterRules, renderMarkdown(guidelineSchema.parse({
        type: "guideline",
        id: "guideline:chapter-rules",
        title: "Chapter Rules",
        scope: "chapters",
    }), "# Rules\n\n- Define how chapters open, escalate, and close.\n"), created);
    await ensureFile(root, GUIDELINE_FILES.voices, renderMarkdown(guidelineSchema.parse({
        type: "guideline",
        id: "guideline:voices",
        title: "Voices",
        scope: "voice",
    }), "# Narration\n\nDefine default narrator rules and any alternate voices.\n"), created);
    await ensureFile(root, GUIDELINE_FILES.structure, renderMarkdown(guidelineSchema.parse({
        type: "guideline",
        id: "guideline:structure",
        title: "Structure",
        scope: "structure",
    }), "# Blueprint\n\nDescribe act structure, pacing, and recurring motifs.\n"), created);
    await ensureFile(root, TIMELINE_MAIN_FILE, renderMarkdown({
        type: "timeline",
        id: "timeline:main",
        title: "Main Timeline",
        canon: DEFAULT_CANON,
    }, "# Timeline\n\nList major chronological anchors here.\n"), created);
    await ensureFile(root, TOTAL_RESUME_FILE, renderMarkdown({
        type: "resume",
        id: "resume:total",
        title: "Total Resume",
    }, "# Book So Far\n\nKeep an up-to-date summary of the entire book here.\n"), created);
    await ensureFile(root, TOTAL_EVALUATION_FILE, renderMarkdown({
        type: "evaluation",
        id: "evaluation:total",
        title: "Total Evaluation",
    }, "# Global Evaluation\n\nTrack continuity, pacing, style, and unresolved issues here.\n"), created);
    if (options.createSkills ?? true) {
        await ensureFile(root, `.opencode/skills/${SKILL_NAME}/SKILL.md`, skillTemplate, created);
        await ensureFile(root, `.claude/skills/${SKILL_NAME}/SKILL.md`, skillTemplate, created);
    }
    return { rootPath: root, created };
}
export async function createEntity(rootPath, kind, input) {
    const root = path.resolve(rootPath);
    const schema = entitySchemaMap[kind];
    const providedFrontmatter = input.frontmatter ?? {};
    const label = typeof providedFrontmatter.name === "string"
        ? providedFrontmatter.name
        : typeof providedFrontmatter.title === "string"
            ? providedFrontmatter.title
            : undefined;
    if (!label && !input.slug) {
        throw new Error(`A name or title is required for ${kind}.`);
    }
    const slug = input.slug ?? slugify(label ?? "entry");
    const directory = ENTITY_TYPE_TO_DIRECTORY[kind];
    const filePath = path.join(root, directory, `${slug}.md`);
    if (!input.overwrite && (await pathExists(filePath))) {
        throw new Error(`File already exists: ${filePath}`);
    }
    const rawFrontmatter = {
        type: kind,
        id: `${kind}:${slug}`,
        canon: DEFAULT_CANON,
        ...providedFrontmatter,
    };
    const frontmatter = schema.parse(rawFrontmatter);
    const body = input.body ?? defaultBodyForType(kind);
    await mkdir(path.dirname(filePath), { recursive: true });
    await writeFile(filePath, renderMarkdown(frontmatter, body), "utf8");
    return { filePath, frontmatter };
}
export async function createChapter(rootPath, options) {
    const root = path.resolve(rootPath);
    const slug = chapterSlug(options.number, options.title);
    const folderPath = path.join(root, "chapters", slug);
    const chapterFilePath = path.join(folderPath, "chapter.md");
    const resumeFilePath = path.join(root, "resumes/chapters", `${slug}.md`);
    const evaluationFilePath = path.join(root, "evaluations/chapters", `${slug}.md`);
    if (!options.overwrite && (await pathExists(chapterFilePath))) {
        throw new Error(`Chapter already exists: ${chapterFilePath}`);
    }
    await mkdir(folderPath, { recursive: true });
    const frontmatter = chapterSchema.parse({
        type: "chapter",
        id: `chapter:${slug}`,
        number: options.number,
        title: options.title,
        canon: DEFAULT_CANON,
        ...options.frontmatter,
    });
    await writeFile(chapterFilePath, renderMarkdown(frontmatter, options.body ?? defaultBodyForType("chapter")), "utf8");
    await ensureFile(root, toPosixPath(path.relative(root, resumeFilePath)), renderMarkdown({
        type: "resume",
        id: `resume:chapter:${slug}`,
        title: `Resume ${slug}`,
    }, "# Summary\n\nSummarize the chapter here.\n"), []);
    await ensureFile(root, toPosixPath(path.relative(root, evaluationFilePath)), renderMarkdown({
        type: "evaluation",
        id: `evaluation:chapter:${slug}`,
        title: `Evaluation ${slug}`,
    }, "# Evaluation\n\nTrack chapter quality, continuity, and revision notes here.\n"), []);
    return {
        folderPath,
        chapterFilePath,
        chapterId: `chapter:${slug}`,
    };
}
export async function createParagraph(rootPath, options) {
    const root = path.resolve(rootPath);
    const chapter = normalizeChapterReference(options.chapter);
    const folderPath = path.join(root, "chapters", chapter);
    if (!(await pathExists(folderPath))) {
        throw new Error(`Chapter folder does not exist: ${folderPath}`);
    }
    const fileName = paragraphFilename(options.number, options.title);
    const filePath = path.join(folderPath, fileName);
    if (!options.overwrite && (await pathExists(filePath))) {
        throw new Error(`Paragraph already exists: ${filePath}`);
    }
    const slug = fileName.replace(/\.md$/i, "");
    const frontmatter = paragraphSchema.parse({
        type: "paragraph",
        id: `paragraph:${chapter}:${slug}`,
        chapter: `chapter:${chapter}`,
        number: options.number,
        title: options.title,
        canon: DEFAULT_CANON,
        ...options.frontmatter,
    });
    await writeFile(filePath, renderMarkdown(frontmatter, options.body ?? defaultBodyForType("paragraph")), "utf8");
    return { filePath, paragraphId: `paragraph:${chapter}:${slug}` };
}
export async function readBook(rootPath) {
    const bookPath = path.join(path.resolve(rootPath), BOOK_FILE);
    if (!(await pathExists(bookPath)))
        return null;
    return readMarkdownFile(bookPath, bookSchema);
}
export async function listChapters(rootPath) {
    const root = path.resolve(rootPath);
    const chaptersRoot = path.join(root, "chapters");
    if (!(await pathExists(chaptersRoot)))
        return [];
    const entries = await readdir(chaptersRoot, { withFileTypes: true });
    const chapterDirectories = entries.filter((entry) => entry.isDirectory());
    const results = [];
    for (const entry of chapterDirectories) {
        const chapterPath = path.join(chaptersRoot, entry.name, "chapter.md");
        if (!(await pathExists(chapterPath)))
            continue;
        const document = await readMarkdownFile(chapterPath, chapterSchema);
        results.push({ slug: entry.name, path: chapterPath, metadata: document.frontmatter });
    }
    return results.sort((left, right) => left.metadata.number - right.metadata.number);
}
export async function readChapter(rootPath, chapter) {
    const root = path.resolve(rootPath);
    const chapterSlug = normalizeChapterReference(chapter);
    const folder = path.join(root, "chapters", chapterSlug);
    const chapterFile = path.join(folder, "chapter.md");
    if (!(await pathExists(chapterFile))) {
        throw new Error(`Missing chapter metadata file: ${chapterFile}`);
    }
    const chapterDocument = await readMarkdownFile(chapterFile, chapterSchema);
    const files = await fg("*.md", { cwd: folder, absolute: true, onlyFiles: true });
    const paragraphFiles = files.filter((filePath) => path.basename(filePath) !== "chapter.md");
    const paragraphs = [];
    for (const filePath of paragraphFiles) {
        const paragraphDocument = await readMarkdownFile(filePath, paragraphSchema);
        paragraphs.push({
            path: filePath,
            metadata: paragraphDocument.frontmatter,
            body: paragraphDocument.body,
        });
    }
    paragraphs.sort((left, right) => left.metadata.number - right.metadata.number);
    return {
        metadata: chapterDocument.frontmatter,
        body: chapterDocument.body,
        paragraphs,
    };
}
export async function searchBook(rootPath, query, options) {
    const root = path.resolve(rootPath);
    const limit = options?.limit ?? 10;
    const requestedScopes = options?.scopes?.map((scope) => `${scope.replace(/\/$/, "")}/**/*.md`) ?? [];
    const patterns = requestedScopes.length > 0 ? requestedScopes : CONTENT_GLOB;
    const files = await fg(patterns, {
        cwd: root,
        absolute: true,
        onlyFiles: true,
        ignore: ["**/node_modules/**", "**/dist/**", "**/.astro/**"],
    });
    const lowerQuery = query.toLowerCase();
    const hits = [];
    for (const filePath of files) {
        const raw = await readFile(filePath, "utf8");
        const parsed = matter(raw);
        const relativePath = toPosixPath(path.relative(root, filePath));
        const body = String(parsed.content ?? "");
        const frontmatter = parsed.data;
        const title = typeof frontmatter.name === "string"
            ? frontmatter.name
            : typeof frontmatter.title === "string"
                ? frontmatter.title
                : relativePath;
        const haystack = `${relativePath}\n${title}\n${body}`.toLowerCase();
        if (!haystack.includes(lowerQuery))
            continue;
        let score = 0;
        if (relativePath.toLowerCase().includes(lowerQuery))
            score += 60;
        if (title.toLowerCase().includes(lowerQuery))
            score += 50;
        if (String(frontmatter.id ?? "").toLowerCase().includes(lowerQuery))
            score += 30;
        if (body.toLowerCase().includes(lowerQuery))
            score += 20;
        hits.push({
            path: relativePath,
            score,
            title,
            type: typeof frontmatter.type === "string" ? frontmatter.type : "unknown",
            excerpt: excerptAround(body, query),
        });
    }
    return hits.sort((left, right) => right.score - left.score).slice(0, limit);
}
export async function validateBook(rootPath) {
    const root = path.resolve(rootPath);
    const files = await fg(CONTENT_GLOB, {
        cwd: root,
        absolute: true,
        onlyFiles: true,
        ignore: ["**/node_modules/**", "**/dist/**", "**/.astro/**"],
    });
    const errors = [];
    for (const filePath of files) {
        try {
            await validateFile(root, filePath);
        }
        catch (error) {
            errors.push({
                path: toPosixPath(path.relative(root, filePath)),
                message: error instanceof Error ? error.message : String(error),
            });
        }
    }
    return {
        valid: errors.length === 0,
        checked: files.length,
        errors,
    };
}
export async function exportEpub(rootPath, options) {
    const root = path.resolve(rootPath);
    const book = await readBook(root);
    const chapters = await listChapters(root);
    if (chapters.length === 0) {
        throw new Error("Cannot export EPUB: no chapters found.");
    }
    const epubModule = (await import("epub-gen-memory"));
    const title = options?.title ?? book?.frontmatter.title ?? path.basename(root);
    const author = options?.author ?? book?.frontmatter.author ?? "Unknown Author";
    const language = options?.language ?? book?.frontmatter.language ?? "en";
    const outputPath = path.resolve(options?.outputPath ?? path.join(root, "dist", `${slugify(title)}.epub`));
    const content = [];
    for (const chapter of chapters) {
        const chapterData = await readChapter(root, chapter.slug);
        const paragraphsHtml = chapterData.paragraphs
            .map((paragraph) => `<section><h2>${paragraph.metadata.title}</h2>${marked.parse(paragraph.body)}</section>`)
            .join("\n");
        const chapterHtml = `<article><h1>${chapterData.metadata.title}</h1>${marked.parse(chapterData.body)}${paragraphsHtml}</article>`;
        content.push({ title: chapterData.metadata.title, data: chapterHtml });
    }
    const bytes = await epubModule.default({
        title,
        author,
        lang: language,
        css: "body { font-family: serif; line-height: 1.55; } h1, h2 { font-family: serif; }",
    }, content);
    await mkdir(path.dirname(outputPath), { recursive: true });
    await writeFile(outputPath, Buffer.from(bytes));
    return { outputPath, chapterCount: chapters.length };
}
export async function writeWikipediaResearchSnapshot(rootPath, options) {
    const root = path.resolve(rootPath);
    const slug = options.slug ?? slugify(options.title);
    const filePath = path.join(root, "research", "wikipedia", options.lang, `${slug}.md`);
    await mkdir(path.dirname(filePath), { recursive: true });
    await writeFile(filePath, renderMarkdown(researchNoteSchema.parse({
        type: "research-note",
        id: `research:wikipedia:${options.lang}:${slug}`,
        title: options.title,
        language: options.lang,
        source_url: options.pageUrl,
        retrieved_at: new Date().toISOString(),
    }), `# Summary\n\n${options.summary}\n\n# Notes\n\n${options.body ?? "Add extracted facts and relevance here."}`), "utf8");
    return filePath;
}
async function ensureFile(root, relativePath, content, created) {
    const filePath = path.join(root, relativePath);
    if (await pathExists(filePath))
        return;
    await mkdir(path.dirname(filePath), { recursive: true });
    await writeFile(filePath, content, "utf8");
    created.push(toPosixPath(relativePath));
}
async function readMarkdownFile(filePath, schema) {
    const raw = await readFile(filePath, "utf8");
    const parsed = matter(raw);
    return {
        frontmatter: schema.parse(parsed.data),
        body: String(parsed.content ?? "").trim(),
        path: filePath,
    };
}
async function validateFile(root, filePath) {
    const raw = await readFile(filePath, "utf8");
    const parsed = matter(raw);
    const data = parsed.data;
    const relativePath = toPosixPath(path.relative(root, filePath));
    if (relativePath === BOOK_FILE) {
        bookSchema.parse(data);
        return;
    }
    if (relativePath.startsWith("guidelines/")) {
        guidelineSchema.parse(data);
        return;
    }
    if (relativePath.startsWith("research/wikipedia/")) {
        researchNoteSchema.parse(data);
        return;
    }
    if (relativePath.startsWith("chapters/") && path.basename(filePath) === "chapter.md") {
        chapterSchema.parse(data);
        return;
    }
    if (relativePath.startsWith("chapters/")) {
        paragraphSchema.parse(data);
        return;
    }
    const entityEntry = Object.entries(ENTITY_TYPE_TO_DIRECTORY).find(([, directory]) => relativePath.startsWith(`${directory}/`));
    if (entityEntry) {
        const [type] = entityEntry;
        entitySchemaMap[type].parse(data);
        return;
    }
    if (relativePath.startsWith("resumes/") || relativePath.startsWith("evaluations/") || relativePath.startsWith("timelines/")) {
        if (typeof data.type !== "string") {
            throw new Error(`Missing type in frontmatter for ${relativePath}`);
        }
        return;
    }
    const stats = await stat(filePath);
    if (!stats.isFile()) {
        throw new Error(`Not a regular file: ${relativePath}`);
    }
}
//# sourceMappingURL=repo.js.map