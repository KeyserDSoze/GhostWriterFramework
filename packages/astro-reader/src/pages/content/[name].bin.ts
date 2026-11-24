import type { APIRoute } from "astro";
import { getBookRoot } from "../../lib/book.js";
import { readerArtifactPaths, readerArtifactResponse } from "../../lib/reader-build.js";

/**
 * The artifacts of the reader build named `content/<kind>-<hash>.bin`: the bundle of a protected book, the EPUB and the images, encrypted when the book has passwords. The extension
 * is in the name of the route so that `astro dev` serves them without a trailing slash.
 */
export function getStaticPaths() {
  return readerArtifactPaths(getBookRoot(), "bin");
}

export const GET: APIRoute = ({ params }) => readerArtifactResponse(getBookRoot(), String(params.name ?? ""), "bin");
