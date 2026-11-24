/**
 * Always the latest published book, without a service worker. GitHub Pages lets browsers keep every file for 10 minutes and that cannot be
 * changed, so the shell (which holds no content) asks `version.json` with `cache: "no-store"` and a query that no cache has seen. When the
 * version it was built with is not the current one, it reloads ONCE under a new URL (the old HTML may still be in the cache under the old
 * one); if even then the HTML is old, it goes on with the current `version.json`, whose artifacts have names that change with their bytes.
 */
/** The query that makes the reload a URL no cache holds: `?nrv=<version>`, removed from the address bar once the page is up. */
export declare const READER_RELOAD_PARAM = "nrv";
export type FreshnessDecision = {
    action: "current";
} | {
    action: "reload";
    url: string;
} | {
    action: "stale-shell";
};
/** `version.json?t=<now>`: the address of the check, never the same twice. */
export declare function versionCheckUrl(baseHref: string, now?: number): string;
/**
 * What the shell does with the current version: nothing when it is its own; a reload when it has not reloaded for that version yet
 * (`reloadedFor`, kept for the tab in sessionStorage); otherwise it reads with the current files from the old shell, which is what makes
 * a loop impossible.
 */
export declare function decideFreshness(input: {
    shellVersion: string;
    latestVersion: string;
    reloadedFor: string | null;
    href: string;
}): FreshnessDecision;
/** The address without the reload query, or null when it has none. */
export declare function withoutReloadParam(href: string): string | null;
//# sourceMappingURL=reader-freshness.d.ts.map