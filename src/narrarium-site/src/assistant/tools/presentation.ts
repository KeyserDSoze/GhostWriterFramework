import i18n from "@/i18n";
import type { CopilotToolArea, CopilotToolDescriptor } from "./types";

function normalizeLanguage(language?: string): "it" | "en" {
  return language?.toLowerCase().startsWith("it") ? "it" : "en";
}

export function localizeCopilotToolText(
  tool: Pick<CopilotToolDescriptor, "id" | "name" | "description" | "output">,
  field: "name" | "description" | "output",
  language?: string,
): string {
  const t = i18n.getFixedT(normalizeLanguage(language));
  const fallback = tool[field];
  return t(`copilotTools.tools.${tool.id}.${field}`, { defaultValue: fallback });
}

export function localizeCopilotToolArea(area: CopilotToolArea, language?: string): string {
  const t = i18n.getFixedT(normalizeLanguage(language));
  return t(`copilotTools.areas.${area}`, { defaultValue: area });
}

export function localizeCopilotToolPrerequisite(value: string, language?: string): string {
  const t = i18n.getFixedT(normalizeLanguage(language));
  const key = value.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "");
  return t(`copilotTools.prerequisiteValues.${key}`, { defaultValue: value });
}

export function localizeCopilotToolsLabel(
  key: string,
  language?: string,
  defaultValue?: string,
): string {
  const t = i18n.getFixedT(normalizeLanguage(language));
  return t(`copilotTools.${key}`, { defaultValue });
}
