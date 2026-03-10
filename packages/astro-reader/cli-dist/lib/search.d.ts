export type SearchEntry = {
    title: string;
    href: string;
    kind: string;
    kindKey: string;
    summary: string;
    keywords: string[];
    chapterNumber: number | null;
    visibleFrom: number | null;
    revealedFrom: number | null;
};
export declare function loadSearchIndex(chapterNumber?: number): Promise<SearchEntry[]>;
//# sourceMappingURL=search.d.ts.map