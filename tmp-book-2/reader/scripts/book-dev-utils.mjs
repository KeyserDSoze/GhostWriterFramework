import { mkdir } from "node:fs/promises";
import path from "node:path";
import { exportEpub } from "narrarium";

const watchPatterns = [
  "book.md",
  "guidelines/**/*",
  "chapters/**/*",
  "characters/**/*",
  "locations/**/*",
  "factions/**/*",
  "items/**/*",
  "secrets/**/*",
  "timeline/**/*",
  "resumes/**/*",
  "evaluations/**/*",
  "research/**/*",
  "assets/**/*",
  "AGENTS.md",
  "opencode.jsonc",
  ".opencode/**/*",
  ".claude/**/*",
];

export function resolveBookRoot(defaultBookRoot, cwd = process.cwd()) {
  const configured = process.env.NARRARIUM_BOOK_ROOT ?? process.env.GHOSTWRITER_BOOK_ROOT;
  return path.resolve(cwd, configured ?? defaultBookRoot);
}

export function resolveBookWatchTargets(bookRoot) {
  return watchPatterns.map((pattern) => path.join(bookRoot, pattern));
}

export function formatWatchedPath(filePath, basePath) {
  const relative = path.relative(basePath, filePath);
  const target = relative && !relative.startsWith("..") ? relative : filePath;
  return toPosix(target);
}

export async function exportReaderEpub(defaultBookRoot, cwd = process.cwd()) {
  const bookRoot = resolveBookRoot(defaultBookRoot, cwd);
  const outputPath = path.resolve(cwd, "public", "downloads", "book.epub");

  await mkdir(path.dirname(outputPath), { recursive: true });
  const result = await exportEpub(bookRoot, { outputPath });

  return {
    bookRoot,
    outputPath,
    result,
  };
}

function toPosix(value) {
  return value.split(path.sep).join("/");
}
