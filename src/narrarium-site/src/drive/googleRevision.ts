/**
 * Revision of a Google Drive file.
 *
 * Drive numbers every change of a file in its `version`, a string of digits in the JSON metadata, and a browser can read
 * it. The ETag response header cannot be read from a cross-origin response unless the server lists it in
 * Access-Control-Expose-Headers, and googleapis.com does not, so the header is only a fallback.
 */
export function googleRevision(metadata: { version?: unknown } | null | undefined, response: Response): string | undefined {
  const version = typeof metadata?.version === "number" ? String(metadata.version) : typeof metadata?.version === "string" ? metadata.version.trim() : "";
  return version || response.headers.get("etag")?.trim() || undefined;
}

/** A revision is either a Drive version, which is a bare integer, or an ETag taken from the response header. */
export function isDriveVersion(revision: string): boolean {
  return /^\d+$/.test(revision);
}

/** `If-Match` takes an entity tag. A version number never matches one, so it is checked before the write instead. */
export function ifMatchHeader(revision: string | undefined): Record<string, string> {
  return revision && !isDriveVersion(revision) ? { "If-Match": revision } : {};
}
