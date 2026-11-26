import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@/drive/useSettings", () => ({
  useSettings: () => ({ load: async () => undefined, save: async () => undefined, resolveOfflineConflict: async () => undefined, syncStatus: "idle", lastSynced: null }),
}));
vi.mock("@/components/ui/use-toast", () => ({ useToast: () => ({ toast: () => undefined }), toast: () => undefined }));

import i18n from "@/i18n";
import { SettingsPage } from "@/pages/SettingsPage";
import { useSettingsStore } from "@/store/settingsStore";
import { DEFAULT_SETTINGS, type AIIntegration, type AppSettings } from "@/types/settings";

type Language = "en" | "it";
const LANGUAGES: Language[] = ["en", "it"];
const t = (key: string, options?: Record<string, unknown>) => i18n.t(key, options) as string;

const OPENAI = { id: "oa", name: "Compat", provider: "openai", endpoint: "https://api.example.com/v1", apiKey: "k", chatModels: [{ id: "m2", name: "llama", capabilities: ["default"] }] } as unknown as AIIntegration;
const AZURE = { id: "az", name: "Studio Azure", provider: "azure_openai", endpoint: "https://x.openai.azure.com", apiKey: "k", apiVersion: "2024-10-21", chatModels: [{ id: "m1", name: "gpt-4o", capabilities: ["default"] }] } as unknown as AIIntegration;
const GITHUB = { id: "gh", name: "Hub", provider: "github_models", apiKey: "ghp", chatModels: [{ id: "m3", name: "gpt-4.1", capabilities: ["default"] }] } as unknown as AIIntegration;
const M365 = { id: "m365", name: "Office", provider: "m365_copilot", apiKey: "", chatModels: [] } as unknown as AIIntegration;

async function show(patch: Partial<AppSettings> = {}, language: Language = "en") {
  await i18n.changeLanguage(language);
  useSettingsStore.setState({ settings: { ...DEFAULT_SETTINGS, ui: { ...DEFAULT_SETTINGS.ui, language }, ...patch } });
  return render(<MemoryRouter initialEntries={["/app/settings/ai-integrations"]}><SettingsPage /></MemoryRouter>);
}

const cardOf = (name: string) => Array.from(document.querySelectorAll("details > summary p.font-semibold")).find((title) => title.textContent === name)!.closest("details") as HTMLElement;
const thinkingOf = (card: HTMLElement) => within(card).getByRole("combobox", { name: t("settings.thinkingDefault") });
const stored = (index = 0) => useSettingsStore.getState().settings.aiIntegrations[index];

/** Opens a select from the keyboard (the arrow), moves to the option by its name and takes it with Enter. */
async function choose(trigger: HTMLElement, option: string) {
  trigger.focus();
  fireEvent.keyDown(trigger, { key: "ArrowDown" });
  const item = await screen.findByRole("option", { name: option });
  fireEvent.keyDown(item, { key: "Enter" });
  await waitFor(() => expect(screen.queryByRole("option")).not.toBeInTheDocument());
}

async function optionsOf(trigger: HTMLElement): Promise<string[]> {
  trigger.focus();
  fireEvent.keyDown(trigger, { key: "ArrowDown" });
  const names = (await screen.findAllByRole("option")).map((item) => item.textContent ?? "");
  fireEvent.keyDown(screen.getAllByRole("option")[0], { key: "Escape" });
  await waitFor(() => expect(screen.queryByRole("option")).not.toBeInTheDocument());
  return names;
}

vi.setConfig({ testTimeout: 60_000 });
const scrollIntoView = Element.prototype.scrollIntoView;
beforeAll(() => i18n.changeLanguage("en"));
beforeEach(() => {
  vi.stubGlobal("ResizeObserver", class { observe() {} unobserve() {} disconnect() {} });
  Element.prototype.scrollIntoView = vi.fn();
});
afterEach(async () => {
  cleanup();
  vi.unstubAllGlobals();
  if (scrollIntoView) Element.prototype.scrollIntoView = scrollIntoView;
  else delete (Element.prototype as { scrollIntoView?: unknown }).scrollIntoView;
  useSettingsStore.setState({ settings: DEFAULT_SETTINGS });
  await i18n.changeLanguage("en");
});

describe("the default thinking of an integration", () => {
  it.each(LANGUAGES)("is a select on the card of every integration that chats, and not on Microsoft 365 Copilot, which has no such request (%s)", async (language) => {
    await show({ aiIntegrations: [OPENAI, AZURE, GITHUB, M365] }, language);
    for (const name of ["Compat", "Studio Azure", "Hub"]) expect(thinkingOf(cardOf(name))).toBeInTheDocument();
    expect(within(cardOf("Office")).queryByRole("combobox", { name: t("settings.thinkingDefault") })).not.toBeInTheDocument();
    expect(t("settings.thinkingDefault")).toBe(language === "en" ? "Default thinking" : "Thinking predefinito");
  });

  it.each(LANGUAGES)("offers none, automatic and the four levels, in the words the router uses (%s)", async (language) => {
    await show({ aiIntegrations: [OPENAI] }, language);
    const expected = [t("settings.thinkingNone"), ...["automatic", "low", "medium", "high", "xhigh"].map((level) => t(`routing.thinking.${level}`))];
    expect(await optionsOf(thinkingOf(cardOf("Compat")))).toEqual(expected);
    expect(expected[0]).toBe(language === "en" ? "None (not set)" : "Nessuno (non impostato)");
    expect(expected[1]).toBe(t("routing.thinking.automatic"));
  });

  it("shows what is stored, and «none» when nothing is", async () => {
    await show({ aiIntegrations: [{ ...OPENAI, thinking: "high" }, AZURE] });
    expect(thinkingOf(cardOf("Compat"))).toHaveTextContent(t("routing.thinking.high"));
    expect(thinkingOf(cardOf("Studio Azure"))).toHaveTextContent(t("settings.thinkingNone"));
  });

  it("stores the level that was chosen on that integration, and on no other", async () => {
    await show({ aiIntegrations: [OPENAI, AZURE] });
    await choose(thinkingOf(cardOf("Compat")), t("routing.thinking.medium"));
    expect(stored(0).thinking).toBe("medium");
    expect(stored(1).thinking).toBeUndefined();
    await choose(thinkingOf(cardOf("Compat")), t("routing.thinking.automatic"));
    expect(stored(0).thinking).toBe("automatic");
    await choose(thinkingOf(cardOf("Compat")), t("routing.thinking.xhigh"));
    expect(stored(0).thinking).toBe("xhigh");
  });

  it("stores nothing for «none»: the settings stay as an older app wrote them", async () => {
    await show({ aiIntegrations: [{ ...OPENAI, thinking: "low" }] });
    await choose(thinkingOf(cardOf("Compat")), t("settings.thinkingNone"));
    expect("thinking" in stored(0) && stored(0).thinking !== undefined).toBe(false);
  });

  it.each(LANGUAGES)("says that the level of a route wins, and that a model that does not reason may refuse it, with what to do (%s)", async (language) => {
    await show({ aiIntegrations: [OPENAI] }, language);
    const select = thinkingOf(cardOf("Compat"));
    const hint = document.getElementById(select.getAttribute("aria-describedby") ?? "") as HTMLElement;
    expect(hint).not.toBeNull();
    expect(hint).toHaveTextContent(t("settings.thinkingDefaultHint"));
    const words = t("settings.thinkingDefaultHint");
    expect(words).toContain(language === "en" ? "AI Router" : "Router AI");
    expect(words).toContain("400");
    expect(words).toContain(language === "en" ? "“Automatic”" : "«Automatico»");
    expect(words).toMatch(language === "en" ? /wins/ : /vince/);
  });
});

describe("the «Forced tool calls» switch of a model", () => {
  const SWITCH = () => screen.getAllByRole("switch", { name: t("settings.forcedToolCalls") })[0];

  it.each(LANGUAGES)("says what it means when it is off, next to the switch (%s)", async (language) => {
    await show({ aiIntegrations: [{ ...OPENAI, chatModels: [{ id: "m2", name: "llama", capabilities: ["default"], supportsToolCalls: false }] }] }, language);
    const control = SWITCH();
    const hint = document.getElementById(control.getAttribute("aria-describedby") ?? "") as HTMLElement;
    expect(hint).not.toBeNull();
    expect(hint).toHaveTextContent(t("settings.forcedToolCallsHint"));
    const words = t("settings.forcedToolCallsHint");
    expect(words).toContain(language === "en" ? "Tools only" : "Solo tool");
    expect(words).toMatch(language === "en" ? /skip/ : /salta/);
  });

  it("still changes the model it belongs to", async () => {
    await show({ aiIntegrations: [OPENAI] });
    expect(SWITCH()).toBeChecked();
    fireEvent.click(SWITCH());
    expect(stored().chatModels?.[0].supportsToolCalls).toBe(false);
    expect(SWITCH()).not.toBeChecked();
  });
});
