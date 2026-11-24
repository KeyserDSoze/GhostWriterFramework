import type { APIRoute } from "astro";
import { getBookRoot } from "../../lib/book.js";
import { readerArtifactPaths, readerArtifactResponse } from "../../lib/reader-build.js";

/**
 * The artifacts of the reader build named `content/<kind>-<hash>.json`: the bundle of a public book. The extension
 * is in the name of the route so that `astro dev` serves them without a trailing slash.
 */
export function getStaticPaths() {
  return readerArtifactPaths(getBookRoot(), "json");
}

export const GET: APIRoute = ({ params }) => readerArtifactResponse(getBookRoot(), String(params.name ?? ""), "json");
