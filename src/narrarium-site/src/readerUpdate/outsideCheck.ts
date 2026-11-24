/**
 * The check from outside of a published reader: a protected reader publishes no `downloads/book.epub` (it must answer 404) and its `version.json` says
 * `protected`. The browser can make the check only when GitHub Pages lets it read the answer (CORS); otherwise the owner gets the line to run in a terminal.
 */
export interface OutsideCheckUrls { epub: string; version: string; baseUrl: string }

/** `siteUrl` is the address of the published reader (with or without the final slash). `stamp` keeps a cached answer from hiding the truth. */
export function outsideCheckUrls(siteUrl: string, stamp: number): OutsideCheckUrls {
  const baseUrl = siteUrl.endsWith("/") ? siteUrl : `${siteUrl}/`;
  return { baseUrl, epub: `${baseUrl}downloads/book.epub?check=${stamp}`, version: `${baseUrl}version.json?check=${stamp}` };
}

/** The line to copy into a terminal: prints the status of the EPUB (it must be 404) and the line of version.json that says whether the reader is protected. */
export function outsideCheckCommand(urls: OutsideCheckUrls): string {
  return `curl -s -o /dev/null -w "%{http_code}\\n" "${urls.epub}" && curl -s "${urls.version}"`;
}

export type OutsideCheckResult =
  | { kind: "protected" }
  /** The EPUB answers: it is published in clear. */
  | { kind: "epub-exposed"; status: number }
  /** The EPUB is gone but version.json does not say protected (a public reader, or not the new one yet). */
  | { kind: "not-protected"; epub: "absent" }
  /** The browser could not read the answer (CORS, a private site, offline): use the line. */
  | { kind: "unreachable" };

type Fetcher = (url: string, init?: RequestInit) => Promise<Pick<Response, "status" | "ok" | "json">>;

export async function runOutsideCheck(urls: OutsideCheckUrls, fetcher: Fetcher = (url, init) => fetch(url, init)): Promise<OutsideCheckResult> {
  const init: RequestInit = { cache: "no-store", mode: "cors", credentials: "omit" };
  let epubStatus: number;
  try { epubStatus = (await fetcher(urls.epub, init)).status; }
  catch { return { kind: "unreachable" }; }
  if (epubStatus >= 200 && epubStatus < 300) return { kind: "epub-exposed", status: epubStatus };
  if (epubStatus !== 404) return { kind: "unreachable" };
  try {
    const response = await fetcher(urls.version, init);
    const body: unknown = response.ok ? await response.json() : null;
    return body && typeof body === "object" && (body as { protected?: unknown }).protected === true ? { kind: "protected" } : { kind: "not-protected", epub: "absent" };
  } catch { return { kind: "unreachable" }; }
}
