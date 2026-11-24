/**
 * Always the latest published book, without a service worker. GitHub Pages lets browsers keep every file for 10 minutes and that cannot be
 * changed, so the shell (which holds no content) asks `version.json` with `cache: "no-store"` and a query that no cache has seen. When the
 * version it was built with is not the current one, it reloads ONCE under a new URL (the old HTML may still be in the cache under the old
 * one); if even then the HTML is old, it goes on with the current `version.json`, whose artifacts have names that change with their bytes.
 */
/** The query that makes the reload a URL no cache holds: `?nrv=<version>`, removed from the address bar once the page is up. */
export const READER_RELOAD_PARAM = "nrv";
/** `version.json?t=<now>`: the address of the check, never the same twice. */
export function versionCheckUrl(baseHref, now = Date.now()) {
    const url = new URL("version.json", baseHref);
    url.searchParams.set("t", String(now));
    return url.toString();
}
/**
 * What the shell does with the current version: nothing when it is its own; a reload when it has not reloaded for that version yet
 * (`reloadedFor`, kept for the tab in sessionStorage); otherwise it reads with the current files from the old shell, which is what makes
 * a loop impossible.
 */
export function decideFreshness(input) {
    if (!input.latestVersion || input.latestVersion === input.shellVersion)
        return { action: "current" };
    if (input.reloadedFor === input.latestVersion)
        return { action: "stale-shell" };
    const url = new URL(input.href);
    url.searchParams.set(READER_RELOAD_PARAM, input.latestVersion);
    return { action: "reload", url: url.toString() };
}
/** The address without the reload query, or null when it has none. */
export function withoutReloadParam(href) {
    const url = new URL(href);
    if (!url.searchParams.has(READER_RELOAD_PARAM))
        return null;
    url.searchParams.delete(READER_RELOAD_PARAM);
    return url.toString();
}
//# sourceMappingURL=reader-freshness.js.map