import type { BookTemplate } from "@/narrarium/bookTemplate";

/**
 * What an update of the reader/ folder of a book repository changes, from the template the site carries (the files `create-narrarium-book` writes, at the
 * reader version the snapshot has). Only the reader's own files are touched: everything under `reader/`, never the author's book. Files that are the author's
 * configuration stay as they are when they exist, `reader/package.json` keeps the name and any dependency the author added, and nothing is deleted unless the
 * file is listed as one the reader used to have and no longer has.
 */
export const READER_DIR = "reader";
export const READER_PACKAGE_JSON = `${READER_DIR}/package.json`;

/** The reader's files that belong to the author's setup: written only when the repository does not have them yet. */
const KEPT_WHEN_PRESENT: ReadonlySet<string> = new Set([
  `${READER_DIR}/.env`,
  `${READER_DIR}/.github/workflows/deploy-pages.yml`,
  `${READER_DIR}/src/lib/book-config.ts`,
  `${READER_DIR}/scripts/book-config.mjs`,
]);

/**
 * Files an older reader had and the current one does not, and so are deleted by the update when they are still there. Every reader file of every
 * snapshot of the template and every version of the package so far is still part of the reader, so the list is empty today; a file is added here when a
 * release of the reader drops it (the check is made against the history of `packages/astro-reader` and of the snapshot).
 */
export const RETIRED_READER_FILES: readonly string[] = [];

export interface ReaderFileWrite {
  path: string;
  content: string;
  change: "added" | "replaced";
  /** The SHA-256 of the file in the working copy (`null`: it is not there), to be sure nothing changed it before the commit. */
  expectedHash: string | null;
}

export interface ReaderFileDelete { path: string; expectedHash: string }

export interface ReaderFolderPlan {
  /** The repository has reader files at all. */
  present: boolean;
  writes: ReaderFileWrite[];
  deletes: ReaderFileDelete[];
  /** The files that already are what the template has. */
  unchanged: number;
  /** The files of the author's own setup that exist and were left alone. */
  kept: string[];
  /** The version of the reader the template carries (its `narrarium` dependency), when it names one. */
  version: string | null;
}

export interface ReaderFolderInput {
  template: Pick<BookTemplate, "files" | "placeholders">;
  /** SHA-256 of every file under `reader/` in the working copy, by path. */
  existing: ReadonlyMap<string, string>;
  /** The text of `reader/package.json` in the working copy, when it has one. */
  existingPackageJson: string | null;
  /** The name of the reader's package when the repository has none to keep. */
  fallbackPackageName: string;
  hash: (text: string) => Promise<string>;
  retired?: readonly string[];
}

function ordered<T>(base: Record<string, T> | undefined, over: Record<string, T> | undefined): Record<string, T> | undefined {
  if (!base && !over) return undefined;
  return { ...(base ?? {}), ...(over ?? {}) };
}

/** The package.json of the new reader: the template's, with the name the repository already has and the dependencies and scripts the author added. */
export function mergeReaderPackageJson(existingText: string | null, templateText: string): string {
  let existing: Record<string, unknown> | null = null;
  if (existingText) {
    try {
      const parsed: unknown = JSON.parse(existingText);
      if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) existing = parsed as Record<string, unknown>;
    } catch { existing = null; }
  }
  const template = JSON.parse(templateText) as Record<string, unknown>;
  if (!existing) return `${JSON.stringify(template, null, 2)}\n`;
  const merged: Record<string, unknown> = { ...template };
  if (typeof existing.name === "string" && existing.name) merged.name = existing.name;
  for (const key of ["scripts", "dependencies", "devDependencies"] as const) {
    const value = ordered(existing[key] as Record<string, unknown> | undefined, template[key] as Record<string, unknown> | undefined);
    if (value) merged[key] = value;
  }
  for (const [key, value] of Object.entries(existing)) if (!(key in merged)) merged[key] = value;
  return `${JSON.stringify(merged, null, 2)}\n`;
}

/** The version of the reader a template carries: the one its package.json asks of `narrarium`. */
export function templateReaderVersion(template: Pick<BookTemplate, "files">): string | null {
  const text = template.files[READER_PACKAGE_JSON]?.text;
  if (!text) return null;
  try {
    const range = (JSON.parse(text) as { dependencies?: Record<string, string> }).dependencies?.narrarium;
    return range?.match(/\d+\.\d+\.\d+/)?.[0] ?? null;
  } catch { return null; }
}

export async function planReaderFolder(input: ReaderFolderInput): Promise<ReaderFolderPlan> {
  const { template, existing } = input;
  const { readerPackage } = template.placeholders;
  const writes: ReaderFileWrite[] = [];
  const kept: string[] = [];
  let unchanged = 0;
  for (const [path, file] of Object.entries(template.files).sort(([left], [right]) => (left < right ? -1 : left > right ? 1 : 0))) {
    if (!path.startsWith(`${READER_DIR}/`)) continue;
    const current = existing.get(path) ?? null;
    if (current !== null && KEPT_WHEN_PRESENT.has(path)) { kept.push(path); continue; }
    const text = file.text.split(readerPackage).join(input.fallbackPackageName);
    const content = path === READER_PACKAGE_JSON ? mergeReaderPackageJson(input.existingPackageJson, text) : text;
    if (current !== null && current === await input.hash(content)) { unchanged += 1; continue; }
    writes.push({ path, content, change: current === null ? "added" : "replaced", expectedHash: current });
  }
  const deletes = (input.retired ?? RETIRED_READER_FILES)
    .filter((path) => path.startsWith(`${READER_DIR}/`) && !(path in template.files) && existing.has(path))
    .map((path) => ({ path, expectedHash: existing.get(path)! }));
  return { present: existing.size > 0, writes, deletes, unchanged, kept, version: templateReaderVersion(template) };
}
