import { getBookRoot } from "../lib/book.js";
import { getReaderBuild } from "../lib/reader-build.js";
/**
 * `version.json`: which build is current, where its bundle is and, for a protected book, the key slots. The shell asks it on every open with
 * `cache: "no-store"` (GitHub Pages' own `max-age=600` cannot be changed); it never holds a word of the book.
 */
export const GET = async () => {
    const build = await getReaderBuild(getBookRoot());
    return new Response(JSON.stringify(build.versionFile), {
        headers: { "Content-Type": "application/json; charset=utf-8", "Cache-Control": "no-store" },
    });
};
//# sourceMappingURL=version.json.js.map