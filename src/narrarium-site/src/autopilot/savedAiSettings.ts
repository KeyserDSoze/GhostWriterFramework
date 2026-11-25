import { loadSavedSettings } from "@/account/accountLocalStore";
import { aiFieldsOf, aiSettingsBaseline, type AiFields } from "@/store/aiSettingsBaseline";
import { useSettingsStore } from "@/store/settingsStore";
import type { AppSettings } from "@/types/settings";

/**
 * The settings a run of this tab asks its models with. A change of the router applies to the very next call of the run of the tab where it is made (the run reads the settings of the tab, as the author
 * sees them). A change that was SAVED in another tab of the same browser has to reach the run of this one too: every tab keeps its own copy of the settings, and a tab that nobody touched would go on
 * asking the primary that the author replaced. So, before each call, the routing that the device has saved is compared with the baseline (the routing as it was when this tab last loaded or saved the
 * settings, `aiSettingsBaseline`):
 * - the tab's own routing differs from the baseline: the author is editing it here, saved or not, and what the tab says wins;
 * - the tab's is the baseline and the saved one is another: a tab saved a change that this one did not touch, and the run asks with the saved one;
 * - otherwise the settings of the tab.
 * Only the fields that decide which model a call goes to and how are taken (`AI_FIELDS`); the rest of the settings is always the tab's, and a key that the tab has and the saved copy has not is kept.
 * A tab that has loaded no settings from the device has no baseline, and a call is made with its own.
 */

/** The saved fields the last read found, so that a store that has not changed is not read again. */
let cached: { snapshot: string; text: string; fields: AiFields } | null = null;

/** Forgets what was read: for the tests. */
export function resetSettingsForRun(): void {
  cached = null;
}

function withFields(memory: AppSettings, fields: AiFields): AppSettings {
  const keys = new Map(memory.aiIntegrations.map((entry) => [entry.id, entry.apiKey]));
  return { ...memory, ...fields, aiIntegrations: fields.aiIntegrations.map((entry) => ({ ...entry, apiKey: entry.apiKey || keys.get(entry.id) || "" })) };
}

export async function settingsForRun(): Promise<AppSettings> {
  const memory = useSettingsStore.getState().settings;
  const baseline = aiSettingsBaseline();
  if (baseline === null || JSON.stringify(aiFieldsOf(memory)) !== baseline) return memory;
  const read = await loadSavedSettings(cached?.snapshot);
  if (!read) return memory;
  if (read.settings) {
    const fields = aiFieldsOf(read.settings);
    cached = { snapshot: read.snapshotId, text: JSON.stringify(fields), fields };
  }
  if (!cached || cached.snapshot !== read.snapshotId || cached.text === baseline) return memory;
  return withFields(memory, cached.fields);
}
