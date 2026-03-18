export type WorkshopEntry = {
    id: string;
    title: string;
    body: string;
    status: string;
    tags: string[];
    sourceKind?: string;
    promotedTo?: string;
};
export type WorkshopDocument = {
    path: string;
    title: string;
    bucket: string;
    bodyHtml: string;
    entries: WorkshopEntry[];
};
export type WorkshopDraftChapter = {
    slug: string;
    title: string;
    summary: string;
    bodyHtml: string;
    paragraphs: Array<{
        slug: string;
        title: string;
        summary: string;
    }>;
    ideas: WorkshopDocument | null;
    notes: WorkshopDocument | null;
    promoted: WorkshopDocument | null;
};
export declare function loadWorkshopPageData(): Promise<{
    ready: boolean;
    root: string;
    global: null;
    draftChapters: never[];
} | {
    ready: boolean;
    root: string;
    global: {
        context: WorkshopDocument | null;
        ideas: WorkshopDocument | null;
        notes: WorkshopDocument | null;
        storyDesign: WorkshopDocument | null;
        promoted: WorkshopDocument | null;
    };
    draftChapters: WorkshopDraftChapter[];
}>;
export declare function countDraftChapters(root: string): Promise<number>;
//# sourceMappingURL=workshop.d.ts.map