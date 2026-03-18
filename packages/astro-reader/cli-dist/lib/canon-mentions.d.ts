export type CanonMentionEntry = {
    id: string;
    href: string;
};
export declare function buildCanonHrefIndex(entries: CanonMentionEntry[]): Map<string, string>;
export declare function resolveCanonEntryIdFromHref(href: string, entries: CanonMentionEntry[]): string | null;
export declare function normalizeCanonEntityHref(href: string): string | null;
//# sourceMappingURL=canon-mentions.d.ts.map