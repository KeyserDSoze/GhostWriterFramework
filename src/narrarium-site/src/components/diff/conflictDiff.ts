/**
 * The differences between the two versions of a file in conflict, as the resolver shows them: only the lines that changed, with a few lines around them,
 * the unchanged runs between them folded into one row, and never more rows than a page can draw at once. Pure, so that it runs in a worker
 * (`conflictDiff.worker.ts`) and the page stays responsive however big the files are (the autopilot's activity log runs to thousands of lines).
 *
 * The common head and tail of the two versions are set aside first (two copies of a log or of a state differ at their end, or in a few places), and Myers'
 * O((N+M)D) algorithm compares what is left; when that would cost too much (more than `maxEdits` differences), what is left is shown as replaced whole.
 */

export type ConflictDiffRowType = "context" | "remove" | "add" | "gap";

export interface ConflictDiffRow {
  type: ConflictDiffRowType;
  /** The line in this device's version (`remove`, `context`), from 1. */
  oldNumber: number | null;
  /** The line in GitHub's version (`add`, `context`), from 1. */
  newNumber: number | null;
  text: string;
  /** For `gap`: how many unchanged lines it stands for. */
  skipped?: number;
  /** The characters of a very long line left out of `text`. */
  clipped?: number;
}

export interface ConflictDiff {
  rows: ConflictDiffRow[];
  /** Lines only in GitHub's version, and lines only in this device's, over the whole files. */
  added: number;
  removed: number;
  /** The rows of the differences left out because there were more than `maxRows`. */
  hidden: number;
  oldLines: number;
  newLines: number;
}

export interface ConflictDiffOptions {
  /** Unchanged lines shown around each change. */
  context?: number;
  maxRows?: number;
  maxEdits?: number;
  /** Characters of a line shown before the rest is left out. */
  maxLineLength?: number;
}

type Edit = { type: "context" | "remove" | "add"; oldIndex: number; newIndex: number };

function lines(text: string): string[] {
  return text.length ? text.replace(/\r\n/g, "\n").split("\n") : [];
}

/** The shortest edit script from `a` to `b` (Myers), or `null` when it has more than `maxEdits` steps. Memory grows with the square of the steps, not of the lines. */
function shortestEdits(a: readonly string[], b: readonly string[], maxEdits: number): Edit[] | null {
  const n = a.length;
  const m = b.length;
  const max = n + m;
  const offset = max + 1;
  const v = new Int32Array(2 * max + 3);
  // The values of `v` each round started from, kept only for the diagonals that round can read (-d-1 … d+1).
  const trace: Int32Array[] = [];
  let found = -1;
  for (let d = 0; d <= max; d += 1) {
    if (d > maxEdits) return null;
    trace.push(v.slice(offset - d - 1, offset + d + 2));
    for (let k = -d; k <= d; k += 2) {
      let x = k === -d || (k !== d && v[offset + k - 1] < v[offset + k + 1]) ? v[offset + k + 1] : v[offset + k - 1] + 1;
      let y = x - k;
      while (x < n && y < m && a[x] === b[y]) { x += 1; y += 1; }
      v[offset + k] = x;
      if (x >= n && y >= m) { found = d; break; }
    }
    if (found >= 0) break;
  }
  const edits: Edit[] = [];
  let x = n;
  let y = m;
  for (let d = found; d >= 0; d -= 1) {
    const round = trace[d];
    const at = (k: number) => round[k + d + 1];
    const k = x - y;
    const previousK = k === -d || (k !== d && at(k - 1) < at(k + 1)) ? k + 1 : k - 1;
    const previousX = d === 0 ? 0 : at(previousK);
    const previousY = previousX - previousK;
    while (x > previousX && y > previousY) {
      x -= 1;
      y -= 1;
      edits.push({ type: "context", oldIndex: x, newIndex: y });
    }
    if (d > 0) {
      if (x === previousX) edits.push({ type: "add", oldIndex: x, newIndex: y - 1 });
      else edits.push({ type: "remove", oldIndex: x - 1, newIndex: y });
    }
    x = previousX;
    y = previousY;
  }
  return edits.reverse();
}

export function computeConflictDiff(previous: string, next: string, options: ConflictDiffOptions = {}): ConflictDiff {
  const context = options.context ?? 3;
  const maxRows = options.maxRows ?? 1500;
  const maxEdits = options.maxEdits ?? 2000;
  const maxLineLength = options.maxLineLength ?? 2000;
  const a = lines(previous);
  const b = lines(next);
  let head = 0;
  while (head < a.length && head < b.length && a[head] === b[head]) head += 1;
  let tail = 0;
  while (tail < a.length - head && tail < b.length - head && a[a.length - 1 - tail] === b[b.length - 1 - tail]) tail += 1;
  const middleA = a.slice(head, a.length - tail);
  const middleB = b.slice(head, b.length - tail);
  const middle = shortestEdits(middleA, middleB, maxEdits) ?? [
    ...middleA.map((_, index): Edit => ({ type: "remove", oldIndex: index, newIndex: 0 })),
    ...middleB.map((_, index): Edit => ({ type: "add", oldIndex: middleA.length, newIndex: index })),
  ];
  const edits: Edit[] = [];
  for (let index = 0; index < head; index += 1) edits.push({ type: "context", oldIndex: index, newIndex: index });
  for (const edit of middle) edits.push({ type: edit.type, oldIndex: edit.oldIndex + head, newIndex: edit.newIndex + head });
  for (let index = 0; index < tail; index += 1) edits.push({ type: "context", oldIndex: a.length - tail + index, newIndex: b.length - tail + index });

  let added = 0;
  let removed = 0;
  const changed: number[] = [];
  edits.forEach((edit, index) => {
    if (edit.type === "add") added += 1;
    else if (edit.type === "remove") removed += 1;
    else return;
    changed.push(index);
  });

  // The rows near a change are shown; each run of other unchanged lines becomes one `gap` row.
  const shown = new Uint8Array(edits.length);
  for (const index of changed) for (let near = Math.max(0, index - context); near <= Math.min(edits.length - 1, index + context); near += 1) shown[near] = 1;
  const rows: ConflictDiffRow[] = [];
  let hidden = 0;
  let skipped = 0;
  const push = (row: ConflictDiffRow) => {
    if (rows.length < maxRows) rows.push(row);
    else hidden += 1;
  };
  edits.forEach((edit, index) => {
    if (!shown[index]) { skipped += 1; return; }
    if (skipped) { push({ type: "gap", oldNumber: null, newNumber: null, text: "", skipped }); skipped = 0; }
    const raw = edit.type === "add" ? b[edit.newIndex] : a[edit.oldIndex];
    const clipped = raw.length > maxLineLength ? raw.length - maxLineLength : 0;
    push({
      type: edit.type,
      oldNumber: edit.type === "add" ? null : edit.oldIndex + 1,
      newNumber: edit.type === "remove" ? null : edit.newIndex + 1,
      text: clipped ? raw.slice(0, maxLineLength) : raw,
      ...(clipped ? { clipped } : {}),
    });
  });
  if (skipped && rows.length) push({ type: "gap", oldNumber: null, newNumber: null, text: "", skipped });
  return { rows, added, removed, hidden, oldLines: a.length, newLines: b.length };
}
