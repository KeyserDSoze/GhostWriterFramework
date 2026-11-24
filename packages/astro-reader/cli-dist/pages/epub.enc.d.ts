import type { APIRoute } from "astro";
/**
 * Build-time endpoint with the EPUB of a public book, for the download button of the canon pages. A protected book publishes its EPUB only
 * inside the reader, encrypted with the rest (`content/epub-<hash>.bin`): here it is empty, and left out of the published files.
 */
export declare const GET: APIRoute;
//# sourceMappingURL=epub.enc.d.ts.map