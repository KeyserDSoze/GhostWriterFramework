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

/** The blocks of a scene are joined with a line break: the same text the quote of a range spanning blocks is made of. */
const SEPARATOR = "\n";

function globalIndex(blocks: string[], point: BlockPoint): number {
  let index = 0;
  for (let block = 0; block < point.block; block += 1) index += (blocks[block]?.length ?? 0) + SEPARATOR.length;
  return index + point.offset;
}

function pointAt(blocks: string[], index: number): BlockPoint {
  let remaining = index;
  for (let block = 0; block < blocks.length; block += 1) {
    const length = blocks[block].length;
    if (remaining <= length) return { block, offset: remaining };
    remaining -= length + SEPARATOR.length;
  }
  const last = Math.max(0, blocks.length - 1);
  return { block: last, offset: blocks[last]?.length ?? 0 };
}

function isValidPoint(blocks: string[], point: BlockPoint): boolean {
  return point.block >= 0 && point.block < blocks.length && point.offset >= 0 && point.offset <= blocks[point.block].length;
}

/** The text between two points (the start before the end), blocks joined with a line break. */
export function textBetween(blocks: string[], range: BlockRange): string {
  const start = globalIndex(blocks, { block: range.startBlock, offset: range.startOffset });
  const end = globalIndex(blocks, { block: range.endBlock, offset: range.endOffset });
  return blocks.join(SEPARATOR).slice(start, end);
}

/**
 * A range from a selection, ordered, without the spaces at its ends; null when it holds no text. The quote is what the range covers.
 */
export function rangeFromPoints(blocks: string[], from: BlockPoint, to: BlockPoint): (BlockRange & { quote: string }) | null {
  if (!isValidPoint(blocks, from) || !isValidPoint(blocks, to)) return null;
  let start = globalIndex(blocks, from);
  let end = globalIndex(blocks, to);
  if (end < start) [start, end] = [end, start];
  const text = blocks.join(SEPARATOR);
  while (start < end && /\s/.test(text[start])) start += 1;
  while (end > start && /\s/.test(text[end - 1])) end -= 1;
  if (end <= start) return null;
  const startPoint = pointAt(blocks, start);
  const endPoint = pointAt(blocks, end);
  return { startBlock: startPoint.block, startOffset: startPoint.offset, endBlock: endPoint.block, endOffset: endPoint.offset, quote: text.slice(start, end) };
}

/**
 * Where a stored range is in the scene as it is now: the same offsets when they still cover the quote, otherwise the occurrence of the
 * quote nearest to where it was, otherwise null (the text it marked is gone).
 */
export function resolveRange(blocks: string[], range: BlockRange & { quote: string }): BlockRange | null {
  if (!range.quote) return null;
  const start = { block: range.startBlock, offset: range.startOffset };
  const end = { block: range.endBlock, offset: range.endOffset };
  if (isValidPoint(blocks, start) && isValidPoint(blocks, end) && textBetween(blocks, range) === range.quote) {
    return { startBlock: range.startBlock, startOffset: range.startOffset, endBlock: range.endBlock, endOffset: range.endOffset };
  }
  const text = blocks.join(SEPARATOR);
  const wanted = Math.min(globalIndex(blocks, { block: Math.min(range.startBlock, Math.max(0, blocks.length - 1)), offset: 0 }) + range.startOffset, text.length);
  let best = -1;
  for (let index = text.indexOf(range.quote); index >= 0; index = text.indexOf(range.quote, index + 1)) {
    if (best < 0 || Math.abs(index - wanted) < Math.abs(best - wanted)) best = index;
  }
  if (best < 0) return null;
  const startPoint = pointAt(blocks, best);
  const endPoint = pointAt(blocks, best + range.quote.length);
  return { startBlock: startPoint.block, startOffset: startPoint.offset, endBlock: endPoint.block, endOffset: endPoint.offset };
}

/** The part of a range inside one block, as offsets in that block's text, or null when the range does not touch it. */
export function rangeInBlock(blocks: string[], range: BlockRange, block: number): { start: number; end: number } | null {
  if (block < range.startBlock || block > range.endBlock) return null;
  const start = block === range.startBlock ? range.startOffset : 0;
  const end = block === range.endBlock ? range.endOffset : blocks[block].length;
  return end > start ? { start, end } : null;
}
