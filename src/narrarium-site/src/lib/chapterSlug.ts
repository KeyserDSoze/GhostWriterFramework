/**
 * Chapter folders are named `<number>-<title>`: the number has three digits up to 999 and as many as it needs after
 * (`999-x`, `1000-the-end`, `12345-x`), the same rule as the engine. A book has no maximum number of chapters;
 * scene numbers stay at three digits.
 */

const NUMBERED = /^(\d{3,})(?:-|$)/;

/** The chapter number a folder name starts with, or null when it is not numbered. */
export function chapterNumberFromSlug(slug: string): number | null {
  const digits = NUMBERED.exec(slug)?.[1];
  if (!digits) return null;
  const number = Number(digits);
  return Number.isSafeInteger(number) ? number : null;
}

/** The folder name without its number: `1000-the-end` is `the-end`. A folder that is not numbered is returned as it is. */
export function chapterSlugWithoutNumber(slug: string): string {
  return slug.replace(NUMBERED, "");
}

/** A readable title for a chapter that has none: `1000-the-end` is "The End". */
export function chapterTitleFromSlug(slug: string): string {
  return chapterSlugWithoutNumber(slug)
    .replace(/[-_]+/g, " ")
    .replace(/\b\w/g, (char) => char.toUpperCase()) || slug;
}

function significantDigits(slug: string): string | null {
  const digits = NUMBERED.exec(slug)?.[1];
  return digits === undefined ? null : digits.replace(/^0+(?=\d)/, "");
}

/**
 * Reading order of two chapter folder names: by number (`999-x` before `1000-the-end`, which plain text order gets wrong),
 * then by the rest of the name. Folders that are not numbered come last. For books that fit in three digits it is the
 * same order as the plain text order.
 */
export function compareChapterSlugs(left: string, right: string): number {
  const a = significantDigits(left);
  const b = significantDigits(right);
  if (a !== null && b !== null) {
    const byNumber = a.length - b.length || (a < b ? -1 : a > b ? 1 : 0);
    if (byNumber) return byNumber;
  } else if (a !== null) {
    return -1;
  } else if (b !== null) {
    return 1;
  }
  return left < right ? -1 : left > right ? 1 : 0;
}

/** The same order for `chapters/<slug>` folder paths. */
export function compareChapterFolders(left: string, right: string): number {
  return compareChapterSlugs(left.replace(/^chapters\//, ""), right.replace(/^chapters\//, ""));
}

/** The number for the next chapter of a book: one more than the highest. */
export function nextChapterNumber(slugs: Iterable<string>): number {
  let highest = 0;
  for (const slug of slugs) {
    const number = chapterNumberFromSlug(slug);
    if (number !== null && number > highest) highest = number;
  }
  return highest + 1;
}
