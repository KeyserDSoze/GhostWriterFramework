import { useMemo } from "react";

export type DiffRowType = "context" | "add" | "remove" | "hunk";

export interface DiffRow {
  type: DiffRowType;
  oldNumber: number | null;
  newNumber: number | null;
  text: string;
}

const MAX_DIFF_LINES = 4000;

/**
 * Compute a line-level diff between two strings using a longest-common-subsequence
 * backtrace. Returns rows tagged as add/remove/context so they can be rendered
 * with classic +/- gutters.
 */
export function computeLineDiff(previous: string, next: string): DiffRow[] {
  const oldLines = previous.length ? previous.replace(/\r\n/g, "\n").split("\n") : [];
  const newLines = next.length ? next.replace(/\r\n/g, "\n").split("\n") : [];

  if (oldLines.length > MAX_DIFF_LINES || newLines.length > MAX_DIFF_LINES) {
    return fallbackDiff(oldLines, newLines);
  }

  const lcs = buildLcsTable(oldLines, newLines);
  const rows: DiffRow[] = [];
  let i = oldLines.length;
  let j = newLines.length;
  const reversed: DiffRow[] = [];

  while (i > 0 || j > 0) {
    if (i > 0 && j > 0 && oldLines[i - 1] === newLines[j - 1]) {
      reversed.push({ type: "context", oldNumber: i, newNumber: j, text: oldLines[i - 1] });
      i--;
      j--;
    } else if (j > 0 && (i === 0 || lcs[i][j - 1] >= lcs[i - 1][j])) {
      reversed.push({ type: "add", oldNumber: null, newNumber: j, text: newLines[j - 1] });
      j--;
    } else if (i > 0) {
      reversed.push({ type: "remove", oldNumber: i, newNumber: null, text: oldLines[i - 1] });
      i--;
    }
  }

  for (let k = reversed.length - 1; k >= 0; k--) rows.push(reversed[k]);
  return rows;
}

function buildLcsTable(oldLines: string[], newLines: string[]): number[][] {
  const rows = oldLines.length;
  const cols = newLines.length;
  const table: number[][] = Array.from({ length: rows + 1 }, () => new Array<number>(cols + 1).fill(0));
  for (let a = 1; a <= rows; a++) {
    for (let b = 1; b <= cols; b++) {
      table[a][b] = oldLines[a - 1] === newLines[b - 1] ? table[a - 1][b - 1] + 1 : Math.max(table[a - 1][b], table[a][b - 1]);
    }
  }
  return table;
}

function fallbackDiff(oldLines: string[], newLines: string[]): DiffRow[] {
  const rows: DiffRow[] = [];
  oldLines.forEach((text, index) => rows.push({ type: "remove", oldNumber: index + 1, newNumber: null, text }));
  newLines.forEach((text, index) => rows.push({ type: "add", oldNumber: null, newNumber: index + 1, text }));
  return rows;
}

/** Parse a GitHub unified patch (with @@ hunks) into diff rows. */
export function parseUnifiedPatch(patch: string): DiffRow[] {
  const rows: DiffRow[] = [];
  let oldLine = 0;
  let newLine = 0;
  for (const raw of patch.split("\n")) {
    if (raw.startsWith("@@")) {
      const match = /@@ -(\d+)(?:,\d+)? \+(\d+)(?:,\d+)? @@/.exec(raw);
      if (match) {
        oldLine = Number(match[1]);
        newLine = Number(match[2]);
      }
      rows.push({ type: "hunk", oldNumber: null, newNumber: null, text: raw });
      continue;
    }
    if (raw.startsWith("+")) {
      rows.push({ type: "add", oldNumber: null, newNumber: newLine, text: raw.slice(1) });
      newLine++;
    } else if (raw.startsWith("-")) {
      rows.push({ type: "remove", oldNumber: oldLine, newNumber: null, text: raw.slice(1) });
      oldLine++;
    } else {
      const text = raw.startsWith(" ") ? raw.slice(1) : raw;
      rows.push({ type: "context", oldNumber: oldLine, newNumber: newLine, text });
      oldLine++;
      newLine++;
    }
  }
  return rows;
}

function rowClass(type: DiffRowType): string {
  switch (type) {
    case "add":
      return "bg-emerald-500/10 text-emerald-700 dark:text-emerald-300";
    case "remove":
      return "bg-red-500/10 text-red-700 dark:text-red-300";
    case "hunk":
      return "bg-primary/10 text-primary";
    default:
      return "text-muted-foreground";
  }
}

function rowSign(type: DiffRowType): string {
  if (type === "add") return "+";
  if (type === "remove") return "-";
  if (type === "hunk") return "@";
  return " ";
}

export function DiffView({ rows, className }: { rows: DiffRow[]; className?: string }) {
  if (rows.length === 0) {
    return null;
  }
  return (
    <div className={`overflow-auto rounded-lg border bg-background font-mono text-[11px] leading-5 ${className ?? ""}`}>
      <table className="w-full border-collapse">
        <tbody>
          {rows.map((row, index) => (
            <tr key={index} className={rowClass(row.type)}>
              <td className="select-none border-r px-2 text-right align-top text-muted-foreground/70 w-10">{row.oldNumber ?? ""}</td>
              <td className="select-none border-r px-2 text-right align-top text-muted-foreground/70 w-10">{row.newNumber ?? ""}</td>
              <td className="select-none px-1 text-center align-top w-4">{rowSign(row.type)}</td>
              <td className="whitespace-pre-wrap break-words px-2 align-top">{row.text || "\u00a0"}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

export function FileDiff({ previous, next, className }: { previous: string; next: string; className?: string }) {
  const rows = useMemo(() => computeLineDiff(previous, next), [previous, next]);
  return <DiffView rows={rows} className={className} />;
}

export function PatchDiff({ patch, className }: { patch: string; className?: string }) {
  const rows = useMemo(() => parseUnifiedPatch(patch), [patch]);
  return <DiffView rows={rows} className={className} />;
}
