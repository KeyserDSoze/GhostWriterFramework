/**
 * Where a pane of the task view stands: which blocks of its text it draws (near where the reader is), how tall what it leaves out is, and how tall a
 * block it has not drawn yet should be. Pure: the pane gives the numbers it measures.
 */

/** How a pane lays its text out: the height of a line, and how many characters fit on one (`Infinity` when the lines do not wrap, in Raw). */
export interface PaneMetrics {
  lineHeight: number;
  perLine: number;
}

/** What a pane assumes before it can measure (and where nothing is measured): a line of 20 px, and 80 characters to a line. */
export const DEFAULT_METRICS: PaneMetrics = { lineHeight: 20, perLine: 80 };

/** The height of a pane that has not been laid out yet (a test, a pane that opens). */
export const DEFAULT_VIEWPORT = 480;

/** The metrics of a pane `width` pixels wide whose font is `fontSize` pixels: a character is about 0.6 of it in a fixed-width font, 0.5 otherwise. */
export function metricsOf(width: number, fontSize: number, lineHeight: number, wrap: boolean, mono: boolean): PaneMetrics {
  const line = lineHeight > 0 ? lineHeight : DEFAULT_METRICS.lineHeight;
  if (!wrap) return { lineHeight: line, perLine: Number.POSITIVE_INFINITY };
  if (!(width > 0) || !(fontSize > 0)) return { lineHeight: line, perLine: DEFAULT_METRICS.perLine };
  return { lineHeight: line, perLine: Math.max(8, Math.floor(width / (fontSize * (mono ? 0.6 : 0.5)))) };
}

/** How tall a block should be before it is measured: its lines, each as many rows as it wraps to. A line break at its very end adds no row. */
export function estimateHeight(block: string, metrics: PaneMetrics): number {
  if (!block) return 0;
  let rows = 0;
  let start = 0;
  for (;;) {
    const end = block.indexOf("\n", start);
    const length = (end < 0 ? block.length : end) - start;
    if (end < 0 && length === 0 && start > 0) break;
    rows += Number.isFinite(metrics.perLine) ? Math.max(1, Math.ceil(length / metrics.perLine)) : 1;
    if (end < 0) break;
    start = end + 1;
  }
  return rows * metrics.lineHeight;
}

/** The tops of the blocks and the end of the last one: `offsets[i]` is where block `i` starts, `offsets[n]` the height of them all. */
export function offsetsOf(heights: readonly number[]): Float64Array {
  const offsets = new Float64Array(heights.length + 1);
  for (let index = 0; index < heights.length; index += 1) offsets[index + 1] = offsets[index] + heights[index];
  return offsets;
}

/** The first block whose bottom is below `y`. */
function firstBelow(offsets: Float64Array, y: number): number {
  let low = 0;
  let high = offsets.length - 1;
  while (low < high) {
    const middle = (low + high) >> 1;
    if (offsets[middle + 1] > y) high = middle;
    else low = middle + 1;
  }
  return low;
}

/**
 * The blocks to draw for a pane scrolled to `top` that shows `viewport` pixels: the ones in sight and `overscan` pixels of them above and below
 * (`start` to `end`, the end not included), and the room the others take before and after them.
 */
export function windowOf(offsets: Float64Array, top: number, viewport: number, overscan: number): { start: number; end: number; before: number; after: number } {
  const count = offsets.length - 1;
  if (count <= 0) return { start: 0, end: 0, before: 0, after: 0 };
  const total = offsets[count];
  const from = Math.max(0, Math.min(top, total) - overscan);
  const to = Math.min(total, Math.max(0, top) + viewport + overscan);
  const start = Math.min(count - 1, firstBelow(offsets, from));
  // The blocks up to the one that starts at or after the bottom edge, which is out of sight.
  const last = firstBelow(offsets, to);
  const end = Math.min(count, Math.max(start + 1, last < count && offsets[last] < to ? last + 1 : last));
  return { start, end, before: offsets[start], after: total - offsets[end] };
}
