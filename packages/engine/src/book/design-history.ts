import type { BookFileChange } from "./store.js";

/**
 * The versions of the Synopsis and the Bible (Phase 4 of #108): a snapshot of their files kept in the book (`history/design/<when>-<why>.json`), made when the author
 * approves a design, before the proposals of «Review and complete» are applied, before a restore, and whenever the author asks. A version is restored only as a proposal:
 * what would change, file by file, is shown first (`designRestore`), and the restore is one commit that first keeps the files as they are now in a version of their own.
 * The journal of the Synopsis (`outline/changes.yml`) is history itself: it is never in a version, and never restored. Pure.
 */

export const DESIGN_HISTORY_DIR = "history/design";

/** Why a version was made: the author approved a design, «Review and complete» was about to apply its proposals, a restore was about to replace the files, the author asked. */
export type DesignSnapshotReason = "approved" | "proposals" | "restore" | "request";
export const DESIGN_SNAPSHOT_REASONS: readonly DesignSnapshotReason[] = ["approved", "proposals", "restore", "request"];

export interface DesignSnapshot {
  at: string;
  reason: DesignSnapshotReason;
  /** The design run it belongs to (`AutopilotDesign.startedAt`), when it was made for one. */
  run?: string;
  /** The files, by path, with their content. */
  files: Record<string, string>;
}

/** The most characters a version keeps: a book whose Synopsis and Bible are larger keeps none, and says so (`designSnapshotChange` answers `null`). */
export const DESIGN_SNAPSHOT_MAX_CHARS = 4_000_000;

/** Whether a file of the book is part of the Synopsis or of the Bible, as a version keeps them: the entries, the description, the brief, and the notes of `bible/`. */
export function isDesignFile(path: string): boolean {
  return /^outline\/(?:chapters\/)?[^/]+\.md$/.test(path) || /^bible\/[^/]+\.md$/.test(path);
}

/** Where a version made at `at` for `reason` is kept. */
export function designSnapshotPath(at: string, reason: DesignSnapshotReason): string {
  return `${DESIGN_HISTORY_DIR}/${at.replace(/[:.]/g, "-")}-${reason}.json`;
}

/** The change that keeps a version of the files given (only the Synopsis and the Bible of them), or `null` when there is none of them or they are too large. */
export function designSnapshotChange(files: Iterable<{ path: string; content: string }>, input: { at: string; reason: DesignSnapshotReason; run?: string }): BookFileChange | null {
  const kept: Record<string, string> = {};
  let size = 0;
  for (const file of [...files].sort((left, right) => left.path.localeCompare(right.path))) {
    if (!isDesignFile(file.path)) continue;
    kept[file.path] = file.content;
    size += file.content.length;
  }
  if (!Object.keys(kept).length || size > DESIGN_SNAPSHOT_MAX_CHARS) return null;
  const snapshot = { type: "design-snapshot", version: 1, at: input.at, reason: input.reason, ...(input.run ? { run: input.run } : {}), files: kept };
  return { path: designSnapshotPath(input.at, input.reason), content: `${JSON.stringify(snapshot, null, 1)}\n`, expectedHash: null };
}

/** A version as its file says it, or `null` when it is not one (another file, a version of a later format). */
export function readDesignSnapshot(content: string | null | undefined): DesignSnapshot | null {
  if (!content) return null;
  let value: unknown;
  try {
    value = JSON.parse(content);
  } catch {
    return null;
  }
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const record = value as Record<string, unknown>;
  if (record.type !== "design-snapshot" || record.version !== 1 || typeof record.at !== "string" || Number.isNaN(Date.parse(record.at))) return null;
  const reason = DESIGN_SNAPSHOT_REASONS.includes(record.reason as DesignSnapshotReason) ? (record.reason as DesignSnapshotReason) : "request";
  const files: Record<string, string> = {};
  if (record.files && typeof record.files === "object" && !Array.isArray(record.files)) {
    for (const [path, text] of Object.entries(record.files as Record<string, unknown>)) if (isDesignFile(path) && typeof text === "string") files[path] = text;
  }
  return { at: record.at, reason, ...(typeof record.run === "string" && record.run ? { run: record.run } : {}), files };
}

/** What restoring a version does to one file: it comes back (`added`: the book has it no longer), it goes (`removed`: it came after the version), or it changes. */
export interface DesignRestoreItem {
  path: string;
  kind: "added" | "removed" | "changed";
  /** The file as it is now (`null`: the book does not have it). */
  before: string | null;
  /** The file as the version has it (`null`: the version does not have it). */
  after: string | null;
}

/**
 * What restoring `snapshot` would do to the Synopsis and the Bible as they are now (`current`, with the hash each file has), and the changes that do it, each expecting
 * the file as it was read. A file that is the same in both is not touched; the order is the one of the paths.
 */
export function designRestore(snapshot: DesignSnapshot, current: ReadonlyArray<{ path: string; content: string; hash?: string }>): { items: DesignRestoreItem[]; changes: BookFileChange[] } {
  const now = new Map(current.filter((file) => isDesignFile(file.path)).map((file) => [file.path, file]));
  const paths = [...new Set([...now.keys(), ...Object.keys(snapshot.files)])].sort((left, right) => left.localeCompare(right));
  const items: DesignRestoreItem[] = [];
  const changes: BookFileChange[] = [];
  const same = (left: string, right: string) => left.replace(/\r\n?/g, "\n") === right.replace(/\r\n?/g, "\n");
  for (const path of paths) {
    const file = now.get(path);
    const kept = snapshot.files[path];
    if (file && kept !== undefined) {
      if (same(file.content, kept)) continue;
      items.push({ path, kind: "changed", before: file.content, after: kept });
      changes.push({ path, content: kept, expectedHash: file.hash ?? null });
    } else if (kept !== undefined) {
      items.push({ path, kind: "added", before: null, after: kept });
      changes.push({ path, content: kept, expectedHash: null });
    } else if (file) {
      items.push({ path, kind: "removed", before: file.content, after: null });
      changes.push({ path, content: null, expectedHash: file.hash ?? null });
    }
  }
  return { items, changes };
}
