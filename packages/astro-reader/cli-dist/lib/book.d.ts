type ReaderEntityKind = "character" | "location" | "faction" | "item" | "secret" | "timeline-event";
export declare function getBookRoot(): string;
export declare function loadHomePageData(): Promise<{
    ready: boolean;
    root: string;
    book: {
        frontmatter: {
            [x: string]: unknown;
            type: "book";
            id: "book";
            title: string;
            language: string;
            canon: "canon" | "draft" | "deprecated";
            author?: string | undefined;
            genre?: string | undefined;
            audience?: string | undefined;
        };
        body: string;
        path: string;
    } | null;
    chapters: {
        slug: string;
        path: string;
        metadata: import("narrarium").ChapterFrontmatter;
    }[];
    characters: {
        slug: string;
        path: string;
        metadata: Record<string, unknown>;
        body: string;
    }[];
    locations: {
        slug: string;
        path: string;
        metadata: Record<string, unknown>;
        body: string;
    }[];
    factions: {
        slug: string;
        path: string;
        metadata: Record<string, unknown>;
        body: string;
    }[];
    items: {
        slug: string;
        path: string;
        metadata: Record<string, unknown>;
        body: string;
    }[];
    secrets: {
        slug: string;
        path: string;
        metadata: Record<string, unknown>;
        body: string;
    }[];
    timelineEvents: {
        slug: string;
        path: string;
        metadata: Record<string, unknown>;
        body: string;
    }[];
}>;
export declare function loadChapterPageData(chapterSlug: string): Promise<{
    metadata: import("narrarium").ChapterFrontmatter;
    body: string;
    paragraphs: Array<{
        path: string;
        metadata: import("narrarium").ParagraphFrontmatter;
        body: string;
    }>;
}>;
export declare function loadEntityIndexData(kind: ReaderEntityKind): Promise<{
    ready: boolean;
    root: string;
    entities: {
        slug: string;
        path: string;
        metadata: Record<string, unknown>;
        body: string;
    }[];
}>;
export declare function loadEntityPageData(kind: ReaderEntityKind, slug: string): Promise<{
    slug: string;
    path: string;
    metadata: Record<string, unknown>;
    body: string;
}>;
export declare function loadTimelinePageData(): Promise<{
    ready: boolean;
    root: string;
    main: {
        metadata: Record<string, unknown>;
        body: string;
    } | null;
    events: {
        slug: string;
        path: string;
        metadata: Record<string, unknown>;
        body: string;
    }[];
}>;
export {};
//# sourceMappingURL=book.d.ts.map