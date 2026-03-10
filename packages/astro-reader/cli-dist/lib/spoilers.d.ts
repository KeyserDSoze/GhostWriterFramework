export type SpoilerAccess = {
    visibleFrom: number | null;
    revealedFrom: number | null;
    isVisible: boolean;
    isRevealed: boolean;
};
export declare function loadChapterOrder(): Promise<Map<string, number>>;
export declare function getSpoilerAccess(metadata: Record<string, unknown>, chapterOrder: Map<string, number>, chapterNumber?: number): SpoilerAccess;
export declare function resolveChapterNumber(reference: unknown, chapterOrder: Map<string, number>): number | null;
export declare function formatChapterThreshold(number: number | null): string;
//# sourceMappingURL=spoilers.d.ts.map