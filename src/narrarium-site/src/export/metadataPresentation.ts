import type { BookExportSettings } from "@/types/settings";

export interface PresentedMetadata {
  key: string;
  value: string;
}

export function presentMetadata(frontmatter: Record<string, unknown>, keys: string[]): PresentedMetadata[] {
  return keys
    .map((key) => {
      const value = frontmatter[key];
      if (value === undefined || value === null || value === "") return null;
      return { key, value: formatMetadataValue(value) };
    })
    .filter((entry): entry is PresentedMetadata => Boolean(entry));
}

export function formatMetadataValue(value: unknown): string {
  if (Array.isArray(value)) return value.map(formatMetadataValue).join(", ");
  if (value && typeof value === "object") return Object.entries(value as Record<string, unknown>).map(([key, entry]) => `${key}: ${formatMetadataValue(entry)}`).join(" · ");
  return String(value);
}

export function paragraphSeparator(settings: BookExportSettings): string {
  if (settings.paragraphSeparator === "none") return "";
  if (settings.paragraphSeparator === "asterisks") return "* * *";
  if (settings.paragraphSeparator === "custom") return settings.customParagraphSeparator || "*";
  return "*";
}
