import { exportEpub, listChapters, pathExists } from "narrarium";
import path from "node:path";
import { readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { randomBytes } from "node:crypto";
import { getBookRoot } from "../lib/book.js";
import { publishesCanonPages } from "../lib/reader-build.js";
/**
 * Build-time endpoint with the EPUB of a public book, for the download button of the canon pages. A protected book publishes its EPUB only
 * inside the reader, encrypted with the rest (`content/epub-<hash>.bin`): here it is empty, and left out of the published files.
 */
export const GET = async () => {
    const root = getBookRoot();
    const ready = await pathExists(path.join(root, "book.md"));
    if (!ready) {
        return new Response("Book not found", { status: 404 });
    }
    if (!publishesCanonPages() || (await listChapters(root)).length === 0) {
        return new Response(new Uint8Array(), {
            headers: { "Content-Type": "application/octet-stream" },
        });
    }
    const tempId = randomBytes(8).toString("hex");
    const tempPath = path.join(tmpdir(), `narrarium-epub-${tempId}.epub`);
    try {
        await exportEpub(root, { outputPath: tempPath });
        const epubBytes = await readFile(tempPath);
        return new Response(epubBytes, {
            headers: { "Content-Type": "application/octet-stream" },
        });
    }
    finally {
        await rm(tempPath, { force: true }).catch(() => { });
    }
};
//# sourceMappingURL=epub.enc.js.map