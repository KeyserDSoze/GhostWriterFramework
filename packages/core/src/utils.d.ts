export declare function slugify(value: string): string;
export declare function formatOrdinal(value: number, width?: number): string;
export declare function chapterSlug(number: number, title: string): string;
export declare function paragraphFilename(number: number, title: string): string;
export declare function normalizeChapterReference(value: string): string;
export declare function excerptAround(content: string, query: string, radius?: number): string;
export declare function isMarkdownFile(filePath: string): boolean;
export declare function pathExists(filePath: string): Promise<boolean>;
export declare function toPosixPath(filePath: string): string;
//# sourceMappingURL=utils.d.ts.map