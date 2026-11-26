import { cleanup, render, screen } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";

vi.mock("@/drive/useSettings", () => ({
  useSettings: () => ({ load: async () => undefined, save: async () => undefined, resolveOfflineConflict: async () => undefined, syncStatus: "idle", lastSynced: null }),
}));
vi.mock("@/components/ui/use-toast", () => ({ useToast: () => ({ toast: () => undefined }), toast: () => undefined }));

import i18n from "@/i18n";
import { SettingsPage } from "@/pages/SettingsPage";
import { useSettingsStore } from "@/store/settingsStore";
import { CHAT_CAPABILITIES, DEFAULT_SETTINGS, ROUTING_TASKS, type AIIntegration } from "@/types/settings";

type Language = "en" | "it";
const LANGUAGES: Language[] = ["en", "it"];
const label = (capability: string, lng: Language) => i18n.t(`settings.capability.${capability}`, { lng }) as string;

const AZURE = {
  id: "azure-1",
  name: "Studio Azure",
  provider: "azure_openai",
  endpoint: "https://studio.openai.azure.com",
  apiKey: "azure-key",
  apiVersion: "2024-10-21",
  chatModels: [{ id: "model-1", name: "gpt-4o", capabilities: ["default", "review"] }],
} as AIIntegration;

vi.setConfig({ testTimeout: 60_000 });
beforeAll(() => i18n.changeLanguage("en"));

afterEach(async () => {
  cleanup();
  useSettingsStore.setState({ settings: DEFAULT_SETTINGS });
  await i18n.changeLanguage("en");
});

describe("model capabilities", () => {
  it.each(LANGUAGES)("every capability the editor can offer has a label in %s, never a raw key", (language) => {
    for (const capability of CHAT_CAPABILITIES) {
      const key = `settings.capability.${capability}`;
      expect(i18n.exists(key, { lng: language }), `${key} (${language})`).toBe(true);
      expect(label(capability, language).trim(), `${key} (${language})`).not.toBe("");
      expect(label(capability, language), `${key} (${language})`).not.toContain("settings.capability");
    }
  });

  it("names the three capabilities that used to show their keys", () => {
    expect(["editor-actions", "deep-research", "create-from-research"].map((capability) => label(capability, "en"))).toEqual(["Editor actions", "Deep Research", "Create from Research"]);
    expect(["editor-actions", "deep-research", "create-from-research"].map((capability) => label(capability, "it"))).toEqual(["Azioni editor", "Deep Research", "Crea da ricerca"]);
  });

  it.each(LANGUAGES)("every routing task has a label in %s too", (language) => {
    for (const task of ROUTING_TASKS) {
      const key = `routing.task.${task}`;
      expect(i18n.exists(key, { lng: language }), `${key} (${language})`).toBe(true);
      expect(i18n.t(key, { lng: language }), `${key} (${language})`).not.toContain("routing.task");
    }
  });

  it.each(LANGUAGES)("the editor shows a translated chip for every capability, and no raw key (%s)", async (language) => {
    await i18n.changeLanguage(language);
    useSettingsStore.setState({ settings: { ...DEFAULT_SETTINGS, ui: { ...DEFAULT_SETTINGS.ui, language }, aiIntegrations: [AZURE] } });
    render(<MemoryRouter initialEntries={["/app/settings/ai-integrations"]}><SettingsPage /></MemoryRouter>);

    for (const capability of CHAT_CAPABILITIES) {
      expect(screen.getAllByRole("button", { name: label(capability, language) }).length, `${capability} (${language})`).toBeGreaterThan(0);
    }
    expect(Array.from(document.querySelectorAll("button")).filter((button) => button.textContent?.includes("settings.capability"))).toEqual([]);
  });
});
