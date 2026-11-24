/**
 * Highlights and notes are anchored to a scene and to offsets in the text of its blocks, with the quoted text: when a new publication
 * changes the scene, the quote finds the place again (the occurrence nearest to where it was); when the quote is gone, the note is kept
 * and shown as detached. Pure functions over the texts of the blocks, so that they are tested without a DOM.
 */
export interface BlockPoint {
    block: number;
    offset: number;
}
export interface BlockRange {
    startBlock: number;
    startOffset: number;
    endBlock: number;
    endOffset: number;
}
/** The text between two points (the start before the end), blocks joined with a line break. */
export declare function textBetween(blocks: string[], range: BlockRange): string;
/**
 * A range from a selection, ordered, without the spaces at its ends; null when it holds no text. The quote is what the range covers.
 */
export declare function rangeFromPoints(blocks: string[], from: BlockPoint, to: BlockPoint): (BlockRange & {
    quote: string;
}) | null;
/**
 * Where a stored range is in the scene as it is now: the same offsets when they still cover the quote, otherwise the occurrence of the
 * quote nearest to where it was, otherwise null (the text it marked is gone).
 */
export declare function resolveRange(blocks: string[], range: BlockRange & {
    quote: string;
}): BlockRange | null;
/** The part of a range inside one block, as offsets in that block's text, or null when the range does not touch it. */
export declare function rangeInBlock(blocks: string[], range: BlockRange, block: number): {
    start: number;
    end: number;
} | null;
//# sourceMappingURL=anchors.d.ts.map