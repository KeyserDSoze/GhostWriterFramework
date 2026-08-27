import path from "node:path";
import { access, lstat, realpath } from "node:fs/promises";
import { chapterSlug, formatOrdinal, paragraphSlug, slugify } from "./slug.js";

export { chapterSlug, formatOrdinal, paragraphSlug, slugify } from "./slug.js";

export function paragraphFilename(number: number, title: string): string {
  return `${paragraphSlug(number, title)}.md`;
}

export function normalizeChapterReference(value: string): string {
  return assertSafePathSegment(value.startsWith("chapter:") ? value.slice("chapter:".length) : value, "Chapter reference");
}

/**
 * Validate a value that will become one directory or file-name segment.
 * Canonical slugs are generated elsewhere; this guard also protects callers
 * that provide an explicit legacy slug or locator.
 */
export function assertSafePathSegment(value: string, label = "Path segment"): string {
  const segment = value.trim();
  if (
    !segment ||
    segment === "." ||
    segment === ".." ||
    segment.includes("/") ||
    segment.includes("\\") ||
    segment.includes(":") ||
    segment.includes("\0") ||
    /[\u0001-\u001f\u007f]/.test(segment) ||
    /^(?:[a-zA-Z]:[\\/]|[\\/]{2})/.test(segment)
  ) {
    throw new Error(`${label} must be a single repository-safe path segment.`);
  }

  return segment;
}

/** Resolve a repository-relative path without allowing traversal or absolutes. */
export function resolveContainedPath(rootPath: string, relativePath: string, label = "Path"): string {
  const root = path.resolve(rootPath);
  const candidate = relativePath.trim().replace(/\\/g, "/");
  const parts = candidate.split("/");
  if (
    !candidate ||
    candidate.startsWith("/") ||
    candidate.includes("\0") ||
    /[\u0001-\u001f\u007f]/.test(candidate) ||
    /^(?:[a-zA-Z]:\/|\/\/)/.test(candidate) ||
    parts.some((part) => part === ".." || part.includes(":"))
  ) {
    throw new Error(`${label} must be a repository-relative path without traversal.`);
  }

  const resolved = path.resolve(root, candidate);
  const relative = path.relative(root, resolved);
  if (relative === ".." || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) {
    throw new Error(`${label} must remain inside the repository root.`);
  }

  return resolved;
}

/**
 * Check the lexical path and any existing parent/symlink target against the
 * real repository root before a caller reads or writes it.
 */
export async function assertContainedPath(rootPath: string, relativePath: string, label = "Path"): Promise<string> {
  const resolved = resolveContainedPath(rootPath, relativePath, label);
  const realRoot = await resolveRealPathWithMissingSuffix(path.resolve(rootPath), label);
  const realCandidate = await resolveRealPathWithMissingSuffix(resolved, label);
  const relative = path.relative(realRoot, realCandidate);
  if (relative === ".." || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) {
    throw new Error(`${label} must remain inside the repository root.`);
  }

  return resolved;
}

/** Resolve an existing path and preserve any missing suffix without following dangling links. */
async function resolveRealPathWithMissingSuffix(inputPath: string, label: string): Promise<string> {
  let probe = inputPath;
  const missingSegments: string[] = [];

  while (true) {
    try {
      await lstat(probe);
      let realProbe: string;
      try {
        realProbe = await realpath(probe);
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === "ENOENT") {
          throw new Error(`${label} must remain inside the repository root.`);
        }
        throw error;
      }
      return path.join(realProbe, ...missingSegments.reverse());
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      if (code !== "ENOENT") throw error;

      const parent = path.dirname(probe);
      if (parent === probe) {
        throw new Error(`Cannot resolve path for containment check: ${inputPath}`);
      }
      missingSegments.push(path.basename(probe));
      probe = parent;
    }
  }
}

export function excerptAround(content: string, query: string, radius = 90): string {
  const lowerContent = content.toLowerCase();
  const lowerQuery = query.toLowerCase();
  const index = lowerContent.indexOf(lowerQuery);

  if (index === -1) {
    return content.replace(/\s+/g, " ").trim().slice(0, radius * 2);
  }

  const start = Math.max(0, index - radius);
  const end = Math.min(content.length, index + query.length + radius);
  return content.slice(start, end).replace(/\s+/g, " ").trim();
}

export function isMarkdownFile(filePath: string): boolean {
  return filePath.toLowerCase().endsWith(".md");
}

export async function pathExists(filePath: string): Promise<boolean> {
  try {
    await access(filePath);
    return true;
  } catch {
    return false;
  }
}

export function toPosixPath(filePath: string): string {
  return filePath.split(path.sep).join("/");
}
