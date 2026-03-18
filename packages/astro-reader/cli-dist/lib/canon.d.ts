export type CanonLink = {
    href: string;
    label: string;
    kind: string;
};
export type ValuePart = {
    text: string;
    href?: undefined;
} | {
    text: string;
    href: string;
};
export declare function resolveValueParts(value: unknown): Promise<ValuePart[]>;
export declare function loadRelatedCanonLinks(id: string, values: unknown): Promise<CanonLink[]>;
export declare function loadStoryMentionLinks(id: string, maxChapterNumber?: number): Promise<CanonLink[]>;
export declare function resolveReference(value: string): Promise<CanonLink | null>;
//# sourceMappingURL=canon.d.ts.map