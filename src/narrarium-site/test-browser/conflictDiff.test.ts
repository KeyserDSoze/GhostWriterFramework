import { expect, test, vi } from "vitest";
import { computeConflictDiff, type ConflictDiffRow } from "@/components/diff/conflictDiff";
import { createConflictDiffer } from "@/components/diff/conflictDiffClient";

/** The two versions rebuilt from the rows (with nothing folded): every line of each, in order. */
function sides(rows: ConflictDiffRow[]): { previous: string[]; next: string[] } {
  return {
    previous: rows.filter((row) => row.type === "context" || row.type === "remove").map((row) => row.text),
    next: rows.filter((row) => row.type === "context" || row.type === "add").map((row) => row.text),
  };
}

const all = { context: Number.MAX_SAFE_INTEGER, maxRows: Number.MAX_SAFE_INTEGER };

test("two equal versions have no differences", () => {
  expect(computeConflictDiff("a\nb\n", "a\nb\n")).toMatchObject({ rows: [], added: 0, removed: 0, hidden: 0 });
});

test("the rows are an exact edit of one version into the other, with their line numbers", () => {
  let seed = 7;
  const random = () => { seed = (seed * 1103515245 + 12345) % 2147483648; return seed / 2147483648; };
  for (let round = 0; round < 200; round += 1) {
    const make = () => Array.from({ length: Math.floor(random() * 12) }, () => "abcde"[Math.floor(random() * 5)]).join("\n");
    const previous = make();
    const next = make();
    const diff = computeConflictDiff(previous, next, all);
    const rebuilt = sides(diff.rows);
    expect(rebuilt.previous).toEqual(previous ? previous.split("\n") : []);
    expect(rebuilt.next).toEqual(next ? next.split("\n") : []);
    expect(diff.rows.filter((row) => row.type === "remove").map((row) => row.oldNumber)).toEqual(diff.rows.filter((row) => row.type === "remove").map((row) => row.oldNumber).sort((a, b) => a! - b!));
    for (const row of diff.rows) {
      if (row.type !== "add") expect(previous.split("\n")[row.oldNumber! - 1]).toBe(row.text);
      if (row.type !== "remove") expect(next.split("\n")[row.newNumber! - 1]).toBe(row.text);
    }
  }
});

test("a long log that changed at its end shows the change and three lines around it, the rest folded into one row", () => {
  const shared = Array.from({ length: 5000 }, (_, index) => `  "line ${index}": "same",`);
  const diff = computeConflictDiff([...shared, '  "by": "this device"'].join("\n"), [...shared, '  "by": "the server"', '  "at": "now"'].join("\n"));
  expect(diff).toMatchObject({ added: 2, removed: 1, hidden: 0, oldLines: 5001, newLines: 5002 });
  expect(diff.rows[0]).toMatchObject({ type: "gap", skipped: 4997 });
  expect(diff.rows.slice(1).map((row) => row.type)).toEqual(["context", "context", "context", "remove", "add", "add"]);
  expect(diff.rows[4]).toMatchObject({ oldNumber: 5001, newNumber: null, text: '  "by": "this device"' });
  expect(diff.rows[6]).toMatchObject({ oldNumber: null, newNumber: 5002, text: '  "at": "now"' });
});

test("changes far apart are separate hunks with the unchanged lines between them folded", () => {
  const base = Array.from({ length: 100 }, (_, index) => `line ${index}`);
  const next = [...base];
  next[10] = "changed 10";
  next[80] = "changed 80";
  const diff = computeConflictDiff(base.join("\n"), next.join("\n"));
  expect(diff.rows.filter((row) => row.type === "gap").map((row) => row.skipped)).toEqual([7, 63, 16]);
  expect(diff.rows.filter((row) => row.type === "add").map((row) => row.text)).toEqual(["changed 10", "changed 80"]);
});

test("two versions too different to compare line by line are shown replaced whole, and never more rows than asked", () => {
  const previous = Array.from({ length: 3000 }, (_, index) => `old ${index}`).join("\n");
  const next = Array.from({ length: 3000 }, (_, index) => `new ${index}`).join("\n");
  const diff = computeConflictDiff(previous, next, { maxEdits: 100, maxRows: 500 });
  expect(diff).toMatchObject({ added: 3000, removed: 3000 });
  expect(diff.rows).toHaveLength(500);
  expect(diff.hidden).toBe(5500);
  expect(diff.rows.every((row) => row.type === "remove")).toBe(true);
});

test("a very long line is cut with the count of what is left out", () => {
  const diff = computeConflictDiff("short", `${"x".repeat(5000)}`, { maxLineLength: 100 });
  expect(diff.rows.find((row) => row.type === "add")).toMatchObject({ text: "x".repeat(100), clipped: 4900 });
});

test("the comparison runs in a worker, one file after the other, and ends with the window", async () => {
  const listeners: Record<string, (event: unknown) => void> = {};
  const posted: Array<{ id: number; previous: string; next: string }> = [];
  const worker = {
    postMessage: vi.fn((message: { id: number; previous: string; next: string }) => { posted.push(message); }),
    terminate: vi.fn(),
    addEventListener: vi.fn((type: string, listener: (event: unknown) => void) => { listeners[type] = listener; }),
  };
  const create = vi.fn(() => worker);
  const differ = createConflictDiffer(create);
  const first = differ.compare("a", "b");
  const second = differ.compare("c", "c");
  expect(create).toHaveBeenCalledTimes(1);
  expect(posted.map((message) => message.id)).toEqual([1, 2]);
  listeners.message({ data: { id: 2, diff: computeConflictDiff("c", "c") } });
  listeners.message({ data: { id: 1, error: "out of memory" } });
  await expect(second).resolves.toMatchObject({ added: 0, removed: 0 });
  await expect(first).rejects.toThrow("out of memory");

  const pending = differ.compare("x", "y");
  differ.close();
  await expect(pending).rejects.toThrow("closed");
  expect(worker.terminate).toHaveBeenCalled();
  // A comparison asked after the window closed and opened again starts another worker.
  void differ.compare("x", "y").catch(() => undefined);
  expect(create).toHaveBeenCalledTimes(2);
});

test("without workers the comparison runs on the page after it has drawn", async () => {
  const differ = createConflictDiffer(() => null);
  await expect(differ.compare("a\nb", "a\nc")).resolves.toMatchObject({ added: 1, removed: 1 });
});
