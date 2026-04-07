export interface EvaluationData {
    id: string;
    title: string;
    htmlContent: string;
}
/**
 * Load the chapter-level evaluation from
 * `evaluations/chapters/<chapterSlug>.md`, or return null if the file does
 * not exist (evaluation has not been run yet).
 */
export declare function loadChapterEvaluation(chapterSlug: string): Promise<EvaluationData | null>;
/**
 * Load the paragraph-level evaluation from
 * `evaluations/paragraphs/<chapterSlug>/<paragraphSlug>.md`, or return null.
 */
export declare function loadParagraphEvaluation(chapterSlug: string, paragraphSlug: string): Promise<EvaluationData | null>;
//# sourceMappingURL=evaluations.d.ts.map