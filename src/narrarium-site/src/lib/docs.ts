import { docEntries, mcpTools, type DocEntry, type DocGroup } from "./generated-docs";

export type { DocEntry, DocGroup };

const GROUPS: DocGroup[] = ["guides", "overview", "reference", "packages"];

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
