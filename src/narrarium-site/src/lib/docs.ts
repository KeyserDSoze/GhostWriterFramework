import { docEntries, mcpTools, type DocEntry, type DocGroup, type DocLang, type DocTranslation } from "./generated-docs";

export type { DocEntry, DocGroup, DocLang, DocTranslation };

const GROUPS: DocGroup[] = ["guides", "overview", "reference", "packages"];

export function normalizeDocLang(lang: string | undefined): DocLang {
  return lang?.split("-")[0] === "it" ? "it" : "en";
}

/** Localized title/summary/markdown for a doc entry, with fallback to the other language. */
export function localizedDoc(entry: DocEntry, lang: DocLang): DocTranslation {
  return entry.translations[lang] ?? entry.translations[lang === "it" ? "en" : "it"] ?? {
    title: entry.title,
    summary: entry.summary,
    markdown: entry.markdown,
    sourcePath: entry.sourcePath,
  };
}

export function getDocGroups(): Array<{ key: DocGroup; label: string; docs: DocEntry[] }> {
  return GROUPS.map((key) => ({
    key,
    label: groupLabel(key),
    docs: docEntries.filter((entry) => entry.group === key),
  })).filter((group) => group.docs.length > 0);
}

export function getDocBySlug(slug: string | undefined): DocEntry | undefined {
  return docEntries.find((entry) => entry.slug === slug);
}

export function getMcpTools() {
  return mcpTools;
}

function groupLabel(group: DocGroup): string {
  switch (group) {
    case "guides":
      return "Guides";
    case "overview":
      return "Overview";
    case "reference":
      return "Reference";
    case "packages":
      return "Packages";
  }
}
