import { render, screen } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import i18n from "@/i18n";
import { SettingsPage } from "@/pages/SettingsPage";
import { useSettingsStore } from "@/store/settingsStore";
import { DEFAULT_SETTINGS, type AIIntegration, type AppSettings } from "@/types/settings";

export type Language = "en" | "it";
export const LANGUAGES: Language[] = ["en", "it"];
export const t = (key: string, options?: Record<string, unknown>) => i18n.t(key, options) as string;

export const AZURE = { id: "az", name: "Studio Azure", provider: "azure_openai", endpoint: "https://x.openai.azure.com", apiKey: "k", apiVersion: "2024-10-21", chatModels: [{ id: "m1", name: "gpt-4o", capabilities: ["default"] }] } as unknown as AIIntegration;
export const GITHUB = { id: "gh", name: "Hub", provider: "github_models", apiKey: "ghp", chatModels: [{ id: "m3", name: "gpt-4.1", capabilities: ["default"] }] } as unknown as AIIntegration;
export const M365 = { id: "m365", name: "Office", provider: "m365_copilot", apiKey: "", chatModels: [] } as unknown as AIIntegration;

/**
 * The page of the integrations with these integrations in the settings (the language of the page, and the address, which may carry the `#hash` of a link).
 * The test file mocks `@/drive/useSettings` and the toast: the page needs neither a drive nor a toaster.
 */
export async function showIntegrations(integrations: AIIntegration[], language: Language = "en", path = "/app/settings/ai-integrations", patch: Partial<AppSettings> = {}) {
  await i18n.changeLanguage(language);
  useSettingsStore.setState({ settings: { ...DEFAULT_SETTINGS, ui: { ...DEFAULT_SETTINGS.ui, language }, aiIntegrations: integrations, ...patch } });
  return render(<MemoryRouter initialEntries={[path]}><SettingsPage /></MemoryRouter>);
}

/** The card of an integration, by the name its title gives it. */
export const cardOf = (name: string) => Array.from(document.querySelectorAll("details > summary p.font-semibold")).find((title) => title.textContent === name)!.closest("details") as HTMLElement;

/** The box of the integration that is being added: the one under the cards. */
export const draftBox = () => screen.getByText(t("settings.addIntegration"), { selector: "p" }).parentElement as HTMLElement;

export const stored = (index = 0) => useSettingsStore.getState().settings.aiIntegrations[index];
