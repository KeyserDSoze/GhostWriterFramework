export function slugify(value: string): string {
  return value
    .normalize("NFKD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/[^a-zA-Z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .replace(/-{2,}/g, "-")
    .toLowerCase();
}

export function formatOrdinal(value: number, width = 3): string {
  return String(value).padStart(width, "0");
}

export function chapterSlug(number: number, title: string): string {
  return `${formatOrdinal(number)}-${slugify(title)}`;
}

export function paragraphSlug(number: number, title: string): string {
  return `${formatOrdinal(number)}-${slugify(title)}`;
}
