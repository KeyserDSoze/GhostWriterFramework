import { createHash } from "node:crypto";
import { readdir, readFile, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { exportEpub, listChapters, pathExists, readAsset, readBook, readChapter } from "narrarium";
import { createContentKey, createKeySlots, encryptArtifact, encryptBundle } from "./content-crypto.js";
import { renderReaderMarkdown } from "./markdown.js";
import { READER_AAD, READER_FORMAT, READER_KDF_ITERATIONS, } from "./reader-protocol.js";
import { readReaderEnvSnapshot } from "./env.js";
import { READER_LEGACY_PASSWORD_ENV, READER_PASSWORD_LIST_ENV, READER_SECRETS_JSON_ENV, describeReaderPasswords, pickReaderPasswords, } from "./reader-passwords.js";
import { readerPasswordSlotNames } from "./reader-secret-names.js";
const imageTypes = {
    ".png": "image/png",
    ".jpg": "image/jpeg",
    ".jpeg": "image/jpeg",
    ".webp": "image/webp",
    ".gif": "image/gif",
    ".avif": "image/avif",
    ".svg": "image/svg+xml",
};
function sha256(bytes) {
    return createHash("sha256").update(bytes).digest("hex");
}
/** The id of the book in the browser's storage: the repository's numeric id in GitHub Actions (stable when the repository is renamed). */
export function resolveReaderBookId(env, title) {
    const explicit = env.NARRARIUM_READER_BOOK_ID?.trim();
    if (explicit)
        return explicit.replace(/[^A-Za-z0-9._-]+/g, "-").slice(0, 80) || "book";
    const repositoryId = env.GITHUB_REPOSITORY_ID?.trim();
    if (repositoryId && /^\d+$/.test(repositoryId))
        return `github-${repositoryId}`;
    const slug = title
        .normalize("NFKD")
        .replace(/[\u0300-\u036f]/g, "")
        .toLowerCase()
        .replace(/[^a-z0-9]+/g, "-")
        .replace(/^-+|-+$/g, "")
        .slice(0, 60);
    return `local-${slug || "book"}`;
}
/** A hash of the reader's own sources (`src/` of the reader app), or "" when they are not there. */
export async function readerCodeFingerprint(readerRoot) {
    const sourceRoot = path.join(readerRoot, "src");
    const files = [];
    const walk = async (directory) => {
        const entries = await readdir(directory, { withFileTypes: true }).catch(() => []);
        for (const entry of entries) {
            const full = path.join(directory, entry.name);
            if (entry.isDirectory())
                await walk(full);
            else
                files.push(full);
        }
    };
    await walk(sourceRoot);
    if (files.length === 0)
        return "";
    const hash = createHash("sha256");
    for (const file of files.sort()) {
        hash.update(path.relative(sourceRoot, file).split(path.sep).join("/"));
        hash.update("\0");
        hash.update(await readFile(file));
        hash.update("\0");
    }
    return hash.digest("hex").slice(0, 16);
}
class ArtifactWriter {
    contentKey;
    files = new Map();
    constructor(contentKey) {
        this.contentKey = contentKey;
    }
    /**
     * An artifact the reader fetches and hands to the page as a Blob of its own type (an image, the EPUB): always `.bin`, encrypted or not,
     * so that one route with a fixed extension serves them all (`content/[name].bin.ts`).
     */
    add(kind, bytes, aad) {
        const stored = this.contentKey ? encryptArtifact(this.contentKey, bytes, aad) : bytes;
        return this.store(kind, stored, "bin", this.contentKey ? "aes-256-gcm" : "raw");
    }
    store(kind, stored, extension, encoding) {
        const digest = sha256(stored);
        const artifactPath = `content/${kind}-${digest.slice(0, 16)}.${extension}`;
        this.files.set(artifactPath, stored);
        return { path: artifactPath, bytes: stored.byteLength, sha256: digest, encoding };
    }
}
async function loadFigure(writer, root, subject, kind, alt) {
    const asset = await readAsset(root, subject, kind).catch(() => null);
    if (!asset?.imageExists)
        return undefined;
    const extension = path.extname(asset.imagePath).toLowerCase();
    const type = imageTypes[extension];
    if (!type)
        return undefined;
    const bytes = await readFile(asset.imagePath);
    const artifact = writer.add("image", bytes, READER_AAD.asset);
    const altText = typeof asset.metadata.alt_text === "string" && asset.metadata.alt_text.trim() ? asset.metadata.alt_text.trim() : alt;
    const caption = typeof asset.metadata.caption === "string" && asset.metadata.caption.trim() ? asset.metadata.caption.trim() : undefined;
    const aspectRatio = typeof asset.metadata.aspect_ratio === "string" ? asset.metadata.aspect_ratio : undefined;
    return { path: artifact.path, type, alt: altText, ...(caption ? { caption } : {}), ...(aspectRatio ? { aspectRatio } : {}) };
}
async function exportEpubBytes(root) {
    const target = path.join(tmpdir(), `narrarium-reader-${process.pid}-${Date.now()}-${Math.random().toString(36).slice(2)}.epub`);
    try {
        await exportEpub(root, { outputPath: target });
        return await readFile(target);
    }
    catch (error) {
        if (error instanceof Error && /no chapters found/i.test(error.message))
            return null;
        throw error;
    }
    finally {
        await rm(target, { force: true }).catch(() => undefined);
    }
}
/** Builds everything the reader publishes for the book at `bookRoot` (no file is written: Astro's endpoints serve `files`). */
export async function buildReaderOutput(options, secrets) {
    const root = path.resolve(options.bookRoot);
    const book = (await pathExists(path.join(root, "book.md"))) ? await readBook(root) : null;
    const title = String(book?.frontmatter.title ?? "Narrarium Reader");
    const language = String(book?.frontmatter.language ?? "en");
    const author = typeof book?.frontmatter.author === "string" && book.frontmatter.author.trim() ? book.frontmatter.author.trim() : undefined;
    const isProtected = options.passwords.length > 0;
    const contentKey = isProtected ? createContentKey() : undefined;
    if (secrets)
        secrets.contentKey = contentKey;
    const writer = new ArtifactWriter(contentKey);
    const chapters = [];
    let sceneCount = 0;
    if (book) {
        for (const entry of await listChapters(root)) {
            const chapter = await readChapter(root, entry.slug);
            const scenes = [];
            for (const paragraph of chapter.paragraphs) {
                const slug = path.basename(paragraph.path, ".md");
                const sceneTitle = String(paragraph.metadata.title ?? slug);
                const figure = await loadFigure(writer, root, String(paragraph.metadata.id), "primary", sceneTitle);
                scenes.push({
                    id: String(paragraph.metadata.id ?? slug),
                    slug,
                    number: Number(paragraph.metadata.number ?? scenes.length + 1),
                    title: sceneTitle,
                    html: renderReaderMarkdown(paragraph.body),
                    ...(figure ? { figure } : {}),
                });
            }
            scenes.sort((left, right) => left.number - right.number);
            sceneCount += scenes.length;
            const chapterTitle = String(chapter.metadata.title ?? entry.slug);
            const figure = await loadFigure(writer, root, String(chapter.metadata.id), "primary", chapterTitle);
            // The body of chapter.md is the chapter's plan (the template's Purpose/Beats/Notes, the autopilot's goal), not its prose: the reader
            // publishes the scenes only, so that no plan of the author reaches the readers.
            chapters.push({
                id: String(chapter.metadata.id ?? `chapter:${entry.slug}`),
                slug: entry.slug,
                number: Number(chapter.metadata.number),
                title: chapterTitle,
                ...(figure ? { figure } : {}),
                scenes,
            });
        }
    }
    const cover = book ? await loadFigure(writer, root, "book", "cover", `${title} cover`) : undefined;
    const bundle = {
        format: READER_FORMAT,
        book: { id: options.bookId, title, ...(author ? { author } : {}), language, ...(cover ? { cover } : {}) },
        chapters,
        assetEncoding: isProtected ? "aes-256-gcm" : "raw",
    };
    const bundleJson = JSON.stringify(bundle);
    const bundleArtifact = contentKey
        ? writer.store("book", encryptBundle(contentKey, bundleJson), "bin", "gzip+aes-256-gcm")
        : writer.store("book", Buffer.from(bundleJson, "utf8"), "json", "json");
    let epubArtifact;
    if (options.includeEpub !== false && chapters.length > 0) {
        const epub = await exportEpubBytes(root);
        if (epub)
            epubArtifact = writer.add("epub", epub, READER_AAD.asset);
    }
    let protection;
    if (contentKey)
        protection = await createKeySlots(contentKey, options.passwords.map((entry) => entry.password), options.iterations ?? READER_KDF_ITERATIONS);
    const version = sha256(JSON.stringify({
        format: READER_FORMAT,
        code: options.codeFingerprint ?? "",
        bookId: options.bookId,
        artifacts: [...writer.files.keys()].sort(),
        protection: protection ?? null,
    })).slice(0, 16);
    const versionFile = {
        format: READER_FORMAT,
        version,
        publishedAt: (options.now ?? new Date()).toISOString(),
        book: { id: options.bookId, title, language },
        protected: isProtected,
        bundle: bundleArtifact,
        ...(epubArtifact ? { epub: epubArtifact } : {}),
        ...(protection ? { protection } : {}),
    };
    return {
        version,
        bookId: options.bookId,
        title,
        language,
        protected: isProtected,
        versionFile,
        files: writer.files,
        stats: { chapters: chapters.length, scenes: sceneCount },
    };
}
// ── The build of this Astro process ─────────────────────────────────────────
const MEMO_KEY = Symbol.for("narrarium.readerBuild");
function isDevServer() {
    return Boolean(import.meta.env?.DEV);
}
/**
 * In `astro dev` the book changes under the server. The book watcher of astro.config.mjs counts the changes (and clears the route cache in
 * the same moment); without it, a cheap fingerprint of the files the bundle reads says when to build again.
 */
const BOOK_GENERATION = Symbol.for("narrarium.bookGeneration");
async function bookFingerprint(root) {
    const hash = createHash("sha256");
    const visit = async (relative) => {
        const full = path.join(root, relative);
        const info = await stat(full).catch(() => null);
        if (!info)
            return;
        if (info.isDirectory()) {
            for (const entry of (await readdir(full)).sort())
                await visit(path.join(relative, entry));
            return;
        }
        hash.update(`${relative}:${info.size}:${info.mtimeMs};`);
    };
    for (const entry of ["book.md", "chapters", "assets"])
        await visit(entry);
    return hash.digest("hex");
}
/** The variables a build reads, from the process or from `.env`. */
export function readerBuildEnv() {
    // Only these names are ever read from the environment of the build: the list, the JSON of version 2, the single older password and the slots of version 3.
    return readReaderEnvSnapshot([READER_PASSWORD_LIST_ENV, READER_SECRETS_JSON_ENV, READER_LEGACY_PASSWORD_ENV, ...readerPasswordSlotNames(), "NARRARIUM_READER_BOOK_ID", "GITHUB_REPOSITORY_ID"]);
}
/**
 * The reader build of this process, shared by the shell, `version.json` and the artifacts so that they agree (one content key per build).
 * In `astro dev` it is built again when the book changes; the previous one stays reachable for the artifacts a page already asked for.
 */
export async function getReaderBuild(bookRoot, env = readerBuildEnv()) {
    const store = globalThis;
    const generation = globalThis[BOOK_GENERATION];
    const key = !isDevServer() ? `build:${bookRoot}` : generation !== undefined ? `generation:${generation}` : await bookFingerprint(bookRoot);
    const memo = store[MEMO_KEY];
    if (memo && memo.key === key)
        return memo.promise;
    const promise = (async () => {
        const picked = pickReaderPasswords(env);
        console.info(describeReaderPasswords(picked));
        const book = (await pathExists(path.join(bookRoot, "book.md"))) ? await readBook(bookRoot) : null;
        return buildReaderOutput({
            bookRoot,
            passwords: picked.passwords,
            bookId: resolveReaderBookId(env, String(book?.frontmatter.title ?? "")),
            codeFingerprint: await readerCodeFingerprint(process.cwd()),
        });
    })();
    store[MEMO_KEY] = { key, promise, previous: memo?.promise };
    promise.catch(() => {
        if (store[MEMO_KEY]?.promise === promise)
            delete store[MEMO_KEY];
    });
    return promise;
}
/** An artifact of the current build, or of the one before it in `astro dev`. */
export async function readReaderArtifact(bookRoot, artifactPath) {
    const current = await getReaderBuild(bookRoot);
    const found = current.files.get(artifactPath);
    if (found)
        return found;
    const previous = globalThis[MEMO_KEY]?.previous;
    return previous ? (await previous.catch(() => undefined))?.files.get(artifactPath) : undefined;
}
/** The static paths of the artifacts with this extension, for `content/[name].<extension>.ts`. */
export async function readerArtifactPaths(bookRoot, extension) {
    const build = await getReaderBuild(bookRoot);
    const suffix = `.${extension}`;
    return [...build.files.keys()]
        .filter((artifactPath) => artifactPath.startsWith("content/") && artifactPath.endsWith(suffix))
        .map((artifactPath) => ({ params: { name: artifactPath.slice("content/".length, -suffix.length) } }));
}
/** The response of `content/<name>.<extension>`: the artifact of this build (or of the previous one in `astro dev`), or a 404. */
export async function readerArtifactResponse(bookRoot, name, extension) {
    const bytes = await readReaderArtifact(bookRoot, `content/${name}.${extension}`);
    if (!bytes)
        return new Response("Not found", { status: 404 });
    return new Response(bytes.slice(), { headers: { "Content-Type": extension === "json" ? "application/json; charset=utf-8" : "application/octet-stream" } });
}
/** True when this build is protected: read from the passwords alone, so that a page can ask it before the bundle exists. */
export function isProtectedReaderBuild(env = readerBuildEnv()) {
    return pickReaderPasswords(env).passwords.length > 0;
}
function isAstroProductionBuild() {
    return Boolean(import.meta.env?.PROD);
}
/**
 * Whether the pages of the canon (the book's home, chapters, characters, places...) are published: always in `astro dev` and for a public
 * book; never for a protected one, whose text is published only inside the encrypted bundle of the reader.
 */
export function publishesCanonPages(env = readerBuildEnv()) {
    return !isAstroProductionBuild() || !isProtectedReaderBuild(env);
}
//# sourceMappingURL=reader-build.js.map