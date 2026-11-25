import i18next from "i18next";
import { create } from "zustand";
import { suggestsResponsesApi, type AiErrorBody, type AiModelLearning } from "narrarium-engine";
import { toast } from "@/components/ui/use-toast";
import { saveSettingsNow } from "@/drive/useSettings";
import { loadAutopilotTranslations } from "@/i18n/autopilot";
import { useSettingsStore } from "@/store/settingsStore";
import type { AppSettings } from "@/types/settings";

/**
 * What a call learned about a model from the way its provider refused it, as the page keeps it: the model's flag in the settings of this browser (`noThinkingWithTools`: it is the author's data, and
 * the author may change it in the model's row), and a notice that says it, with the two ways out. The engine says it once, when it learns it (`model-learned`, or `onLearned` of the client of a call
 * that the autopilot did not make); a model that already has the flag is not announced again.
 */

/** The notice of a model that was learned to refuse thinking when the request carries tools. */
export interface LearnedModelNotice {
  /** The integration and the model: the same model is one notice. */
  key: string;
  integrationId: string;
  integrationName: string;
  model: string;
  /** What the provider said, in its own words. */
  body: AiErrorBody;
  /** The provider's words tell to use the Responses API (`/v1/responses`): the way out that comes first. */
  responses: boolean;
  /** How the model is asked with tools now: `omit` (the level is left out) or `none` (`reasoning_effort: "none"` is sent, the one value the model takes with them). */
  off: "omit" | "none";
  at: number;
}

interface LearnedModelsState {
  notices: LearnedModelNotice[];
  add: (notice: LearnedModelNotice) => void;
  dismiss: (key: string) => void;
}

/** The notices of this page, not saved: the flag is what stays, in the model's row. */
export const useLearnedModelsStore = create<LearnedModelsState>()((set) => ({
  notices: [],
  add: (notice) => set((state) => (state.notices.some((entry) => entry.key === notice.key) ? { notices: state.notices.map((entry) => (entry.key === notice.key ? notice : entry)) } : { notices: [...state.notices, notice] })),
  dismiss: (key) => set((state) => ({ notices: state.notices.filter((entry) => entry.key !== key) })),
}));

export const learnedKey = (integrationId: string, model: string): string => `${integrationId}\n${model}`;

/** The settings with `noThinkingWithTools` set on the model that the integration lists under that name (`false`: taken off); `null` when there is no such model or it has the value already. */
export function withNoThinkingWithTools(settings: AppSettings, integrationId: string, model: string, value: true | "none" | false): AppSettings | null {
  let changed = false;
  const aiIntegrations = settings.aiIntegrations.map((integration) => {
    if (integration.id !== integrationId) return integration;
    let touched = false;
    const chatModels = (integration.chatModels ?? []).map((entry) => {
      if (entry.name !== model || (entry.noThinkingWithTools ?? false) === value) return entry;
      touched = true;
      const { noThinkingWithTools: _previous, ...rest } = entry;
      return value ? { ...rest, noThinkingWithTools: value } : rest;
    });
    if (touched) changed = true;
    return touched ? { ...integration, chatModels } : integration;
  });
  return changed ? { ...settings, aiIntegrations } : null;
}

/** What the engine tells of a model it learned about: the learning of a call, or the `model-learned` event of the autopilot (which says `responses` itself). */
export interface LearnedModelInput {
  integrationId: string;
  integrationName: string;
  model: string;
  body: AiErrorBody;
  /** How the model answered: absent from an older host, which only left the level out. */
  off?: "omit" | "none";
  responses?: boolean;
}

/** The input of the engine's `AiModelLearning` (the client's `onLearned`). */
export function inputOfLearning(learning: AiModelLearning): LearnedModelInput {
  return { integrationId: learning.integrationId, integrationName: learning.integrationName, model: learning.model, body: learning.body, off: learning.off, responses: suggestsResponsesApi(learning.body) };
}

/**
 * Keeps what was learned: the flag goes into the settings of this browser, and a notice is added, once for each model. A model that already has the flag (set by the author, or learned before)
 * is no news, and says nothing. `announce` says it out of the autopilot too, in a message that stays a while (a call of the Copilot has no page for the notice).
 */
export function rememberLearnedModel(input: LearnedModelInput, options: { announce?: boolean } = {}): void {
  const settings = useSettingsStore.getState().settings;
  const off = input.off ?? "omit";
  const how: true | "none" = off === "none" ? "none" : true;
  // A model that has the setting already (set by the author, or learned before) is no news, and `none` is not made `true` again: what takes none is not asked without a level.
  const current = settings.aiIntegrations.find((integration) => integration.id === input.integrationId)?.chatModels?.find((entry) => entry.name === input.model)?.noThinkingWithTools;
  if (current === how || current === "none") return;
  const next = withNoThinkingWithTools(settings, input.integrationId, input.model, how);
  if (next) {
    try {
      useSettingsStore.getState().patchSettings({ aiIntegrations: next.aiIntegrations });
      // Kept on this device like any change of the settings.
      void saveSettingsNow().catch(() => undefined);
    } catch {
      // The settings of the AI integrations cannot be changed while the browser is offline, and a call must never fail for that: the engine remembers the model for as long as the page lives, and learns
      // it again the next time the provider refuses.
    }
  }
  const notice: LearnedModelNotice = { key: learnedKey(input.integrationId, input.model), integrationId: input.integrationId, integrationName: input.integrationName, model: input.model, body: input.body, responses: input.responses ?? suggestsResponsesApi(input.body), off, at: Date.now() };
  useLearnedModelsStore.getState().add(notice);
  if (options.announce) void announce(notice);
}

/** The message of a call made outside the autopilot: the two ways out in plain words, for long enough to read them. */
async function announce(notice: LearnedModelNotice): Promise<void> {
  try {
    await loadAutopilotTranslations();
  } catch {
    return;
  }
  const t = i18next.t.bind(i18next);
  toast({
    title: t("autopilot.learned.title", { model: notice.model }),
    description: t(notice.responses ? "autopilot.learned.toastResponses" : "autopilot.learned.toast", { name: notice.integrationName }),
    duration: 30_000,
  });
}
