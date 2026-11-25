import type { AppSettings } from "@/types/settings";

/**
 * What this tab last knew the saved routing to be. Every tab keeps its own copy of the settings, loaded when it opened and changed while its author edits them; what is saved lives on the device. A run
 * asks its models with the routing of the tab it runs in, and has to notice a routing that another tab saved: it compares the tab's routing with this baseline, which is the routing as it was when the
 * tab last loaded the settings from the device or saved them to it (see `settingsForRun`). Small and free of the rest of the app: the settings load and save read it.
 */

/** The fields of the settings that `pickAiRuntimeConfig` reads: the integrations, how the tasks are routed, the limits and the privacy of the fallbacks, «Tools only». */
export const AI_FIELDS = ["aiIntegrations", "taskRouting", "routingExecution", "fallbackDisclosure", "aiToolsOnly", "defaultWritingIntegrationId", "defaultReviewIntegrationId", "costCurrency"] as const;
export type AiFields = Pick<AppSettings, (typeof AI_FIELDS)[number]>;

export function aiFieldsOf(settings: AppSettings): AiFields {
  const fields: Record<string, unknown> = {};
  for (const field of AI_FIELDS) fields[field] = settings[field];
  return fields as unknown as AiFields;
}

let baseline: string | null = null;

/** The settings of this tab are what the device has saved: they were just loaded from it, or just saved to it. */
export function noteAiSettingsSaved(settings: AppSettings): void {
  baseline = JSON.stringify(aiFieldsOf(settings));
}

/** The routing as the device had it when this tab last loaded or saved the settings, as text; `null` while the tab has done neither. */
export function aiSettingsBaseline(): string | null {
  return baseline;
}

/** Forgets the baseline: for the tests. */
export function resetAiSettingsBaseline(): void {
  baseline = null;
}
