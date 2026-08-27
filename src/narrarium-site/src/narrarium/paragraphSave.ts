import { paragraphSlug } from "narrarium/slug";

export type ParagraphRenameTarget = {
  slug: string;
  path: string;
};

/** Rename only after an actual non-empty title change, preserving legacy paths on no-op saves. */
export function paragraphRenameTarget(
  currentPath: string,
  number: number,
  currentTitle: string,
  savedTitle: string,
): ParagraphRenameTarget | null {
  const normalizedTitle = currentTitle.trim();
  if (!normalizedTitle || normalizedTitle === savedTitle.trim()) return null;

  const slug = paragraphSlug(number, normalizedTitle);
  const oldSlug = (currentPath.split("/").pop() ?? "").replace(/\.md$/i, "");
  if (!slug || slug === oldSlug) return null;

  return {
    slug,
    path: `${currentPath.replace(/[^/]+$/, "")}${slug}.md`,
  };
}
