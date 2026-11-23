import { buildInitialBookFiles, type InitialBookInput } from "@/narrarium/bookScaffold";
import type { BookRepositoryFile } from "@/github/bookRepository";

/**
 * The template of a complete book repository: the files the real scaffolder (`create-narrarium-book`) writes, as a bundle made at build time by
 * `scripts/generate-book-template.mjs` (`npm run template:generate -w narrarium-site`). It is a chunk of its own (about 400 KB, 88 KB gzipped) that
 * only the creation of a repository on GitHub loads: never import the JSON statically.
 */

export interface BookTemplate {
  format: 1;
  placeholders: { package: string; readerPackage: string };
  files: Record<string, { text: string }>;
}

export async function loadBookTemplate(): Promise<BookTemplate> {
  return (await import("@/narrarium/bookTemplate.generated.json")).default as unknown as BookTemplate;
}

/** The package name the CLI gives a book: its title in lower case with every run of other characters as one dash. */
export function packageNameForTitle(title: string): string {
  return title.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "") || "narrarium-book";
}

/**
 * Files the site writes itself, whatever the scaffolder writes at the same path: they carry the title, the author and the language of the book (`book.md`),
 * are the site's own (`README.md`, the evaluation guidelines, the script ledger) or are the site's catalogue in the language of the book (the default
 * ghostwriter and the simulated readers, which the reader panel and the autopilot read: the scaffolder's five English readers are not the ones the app
 * uses). Every other file the site writes only fills a path the template does not have.
 */
const SITE_OWNED = [/^book\.md$/, /^README\.md$/, /^evaluation-guidelines\.md$/, /^state\/script-ledger\.md$/, /^ghostwriters\//, /^personas\//];

export function isSiteOwnedPath(path: string): boolean {
  return SITE_OWNED.some((pattern) => pattern.test(path));
}

/** The files of the template with the names of the packages of this book. */
export function templateFiles(template: BookTemplate, title: string): Array<{ path: string; content: string }> {
  const packageName = JSON.stringify(packageNameForTitle(title)).slice(1, -1);
  const readerPackageName = JSON.stringify(`${packageNameForTitle(title)}-reader`).slice(1, -1);
  return Object.entries(template.files).map(([path, file]) => ({
    path,
    content: file.text.split(template.placeholders.package).join(packageName).split(template.placeholders.readerPackage).join(readerPackageName),
  }));
}

export interface CompleteBookInput extends InitialBookInput {
  /** The outline of the size the book starts from, written over anything else at the same path. */
  files?: Array<{ path: string; content: string }>;
}

/**
 * Every file of a new book repository: the template (the reader, the Pages workflow, the instructions of the writing agents, the scripts and the
 * canon files the scaffolder writes), the files the site owns (see `SITE_OWNED`) and the outline of the chosen size. Sorted by path.
 */
export function composeCompleteBookFiles(template: BookTemplate, input: CompleteBookInput): BookRepositoryFile[] {
  const title = input.title.trim() || "Untitled Book";
  const files = new Map<string, string>();
  for (const file of templateFiles(template, title)) if (!isSiteOwnedPath(file.path)) files.set(file.path, file.content);
  for (const file of buildInitialBookFiles({ ...input, title })) if (isSiteOwnedPath(file.path) || !files.has(file.path)) files.set(file.path, file.content);
  for (const file of input.files ?? []) files.set(file.path, file.content);
  return [...files].sort(([left], [right]) => (left < right ? -1 : left > right ? 1 : 0)).map(([path, content]) => ({ path, content }));
}

/** The files the template adds to the ones a book already has on this device: nothing that the book already has is replaced. */
export function templateFilesMissingFrom(template: BookTemplate, existingPaths: Iterable<string>, title: string): BookRepositoryFile[] {
  const present = new Set(existingPaths);
  return templateFiles(template, title).filter((file) => !present.has(file.path) && !isSiteOwnedPath(file.path));
}
