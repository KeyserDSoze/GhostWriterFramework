import { type BookFrontmatter, type ChapterFrontmatter, type EntityType, type ParagraphFrontmatter } from "./schemas.js";
type MarkdownDocument<T = Record<string, unknown>> = {
    frontmatter: T;
    body: string;
    path: string;
};
type SearchHit = {
    path: string;
    score: number;
    title: string;
    type: string;
    excerpt: string;
};
type CreateEntityInput = {
    slug?: string;
    body?: string;
    overwrite?: boolean;
    frontmatter?: Record<string, unknown>;
};
export declare function initializeBookRepo(rootPath: string, options: {
    title: string;
    author?: string;
    language?: string;
    createSkills?: boolean;
}): Promise<{
    rootPath: string;
    created: string[];
}>;
export declare function createEntity(rootPath: string, kind: EntityType, input: CreateEntityInput): Promise<{
    filePath: string;
    frontmatter: Record<string, unknown>;
}>;
export declare function createChapter(rootPath: string, options: {
    number: number;
    title: string;
    body?: string;
    frontmatter?: Record<string, unknown>;
    overwrite?: boolean;
}): Promise<{
    folderPath: string;
    chapterFilePath: string;
    chapterId: string;
}>;
export declare function createParagraph(rootPath: string, options: {
    chapter: string;
    number: number;
    title: string;
    body?: string;
    frontmatter?: Record<string, unknown>;
    overwrite?: boolean;
}): Promise<{
    filePath: string;
    paragraphId: string;
}>;
export declare function readBook(rootPath: string): Promise<MarkdownDocument<BookFrontmatter> | null>;
export declare function listChapters(rootPath: string): Promise<Array<{
    slug: string;
    path: string;
    metadata: ChapterFrontmatter;
}>>;
export declare function readChapter(rootPath: string, chapter: string): Promise<{
    metadata: ChapterFrontmatter;
    body: string;
    paragraphs: Array<{
        path: string;
        metadata: ParagraphFrontmatter;
        body: string;
    }>;
}>;
export declare function searchBook(rootPath: string, query: string, options?: {
    scopes?: string[];
    limit?: number;
}): Promise<SearchHit[]>;
export declare function validateBook(rootPath: string): Promise<{
    valid: boolean;
    checked: number;
    errors: Array<{
        path: string;
        message: string;
    }>;
}>;
export declare function exportEpub(rootPath: string, options?: {
    outputPath?: string;
    title?: string;
    author?: string;
    language?: string;
}): Promise<{
    outputPath: string;
    chapterCount: number;
}>;
export declare function writeWikipediaResearchSnapshot(rootPath: string, options: {
    lang: "en" | "it";
    title: string;
    pageUrl: string;
    slug?: string;
    summary: string;
    body?: string;
}): Promise<string>;
export {};
//# sourceMappingURL=repo.d.ts.map