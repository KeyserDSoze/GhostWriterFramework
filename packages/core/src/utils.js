import path from "node:path";
import { access } from "node:fs/promises";
export function slugify(value) {
    return value
        .normalize("NFKD")
        .replace(/[\u0300-\u036f]/g, "")
        .replace(/[^a-zA-Z0-9]+/g, "-")
        .replace(/^-+|-+$/g, "")
        .replace(/-{2,}/g, "-")
        .toLowerCase();
}
export function formatOrdinal(value, width = 3) {
    return String(value).padStart(width, "0");
}
export function chapterSlug(number, title) {
    return `${formatOrdinal(number)}-${slugify(title)}`;
}
export function paragraphFilename(number, title) {
    return `${formatOrdinal(number)}-${slugify(title)}.md`;
}
export function normalizeChapterReference(value) {
    return value.startsWith("chapter:") ? value.slice("chapter:".length) : value;
}
export function excerptAround(content, query, radius = 90) {
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
export function isMarkdownFile(filePath) {
    return filePath.toLowerCase().endsWith(".md");
}
export async function pathExists(filePath) {
    try {
        await access(filePath);
        return true;
    }
    catch {
        return false;
    }
}
export function toPosixPath(filePath) {
    return filePath.split(path.sep).join("/");
}
//# sourceMappingURL=utils.js.map