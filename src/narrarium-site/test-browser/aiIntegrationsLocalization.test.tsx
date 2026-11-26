import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { cleanup, render, screen } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";

vi.mock("@/drive/useSettings", () => ({
  useSettings: () => ({ load: async () => undefined, save: async () => undefined, resolveOfflineConflict: async () => undefined, syncStatus: "idle", lastSynced: null }),
}));
vi.mock("@/components/ui/use-toast", () => ({ useToast: () => ({ toast: () => undefined }), toast: () => undefined }));

import i18n from "@/i18n";
import { MobileSidebar } from "@/components/layout/Sidebar";
import { SettingsPage } from "@/pages/SettingsPage";
import { useSettingsStore } from "@/store/settingsStore";
import { DEFAULT_SETTINGS, type AIIntegration } from "@/types/settings";

type Language = "en" | "it";
const LANGUAGES: Language[] = ["en", "it"];
const t = (key: string, options?: Record<string, unknown>) => i18n.t(key, options) as string;

const INTEGRATIONS = [
  { id: "az", name: "Studio Azure", provider: "azure_openai", endpoint: "https://x.openai.azure.com", apiKey: "k", apiVersion: "2024-10-21", chatModels: [{ id: "m1", name: "gpt-4o", capabilities: ["default"] }], modelSpeechToText: "whisper-1", modelTextToSpeech: "tts-1", modelImageGeneration: "gpt-image-1" },
  { id: "oa", name: "Compat", provider: "openai", endpoint: "https://api.example.com/v1", apiKey: "k", chatModels: [{ id: "m2", name: "llama", capabilities: ["default"] }] },
] as unknown as AIIntegration[];

async function show(path: string, language: Language) {
  await i18n.changeLanguage(language);
  useSettingsStore.setState({
    settings: {
      ...DEFAULT_SETTINGS,
      ui: { ...DEFAULT_SETTINGS.ui, language },
      aiIntegrations: INTEGRATIONS,
      taskRouting: { tts: { primary: { integrationId: "__browser__", model: "browser" }, fallbacks: [] } },
    },
  });
  return render(<MemoryRouter initialEntries={[path]}><SettingsPage /></MemoryRouter>);
}

/** Every text and every text attribute (placeholder, aria-label, title) a page puts in front of the author. */
function visibleStrings(root: HTMLElement): string[] {
  const strings: string[] = [];
  const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
  for (let node = walker.nextNode(); node; node = walker.nextNode()) if (node.textContent?.trim()) strings.push(node.textContent.trim());
  root.querySelectorAll("*").forEach((element) => {
    for (const name of ["placeholder", "aria-label", "title"]) { const value = element.getAttribute(name); if (value) strings.push(value); }
  });
  return strings;
}

const ENGLISH_ONLY = ["Maximum candidates", "Total routing time", "Maximum token attempts", "Maximum estimated route cost", "Forced tool calls", " or deployment", "Max output tokens", "Browser / local device", "Account & Sync"];

vi.setConfig({ testTimeout: 60_000 });
beforeAll(() => i18n.changeLanguage("en"));

afterEach(async () => {
  cleanup();
  useSettingsStore.setState({ settings: DEFAULT_SETTINGS });
  await i18n.changeLanguage("en");
});

describe("the labels that used to be hard-coded English", () => {
  it.each(LANGUAGES)("AI Router: the four execution limits and the browser boundary are translated (%s)", async (language) => {
    await show("/app/settings/ai-router", language);
    for (const key of ["routing.maxCandidates", "routing.maxTotalDuration", "routing.maxTokenAttempts", "routing.maxEstimatedCost"]) {
      expect(i18n.exists(key, { lng: language }), `${key} (${language})`).toBe(true);
      expect(screen.getByText(t(key)), `${key} (${language})`).toBeInTheDocument();
    }
    const chain = t("routing.boundaryChain", { chain: `${t("routing.browserBoundary")} (browser)` });
    expect(screen.getByText(chain, { exact: false })).toBeInTheDocument();
  });

  it.each(LANGUAGES)("AI Integrations: the tool-call switch, the model placeholders and the header link are translated (%s)", async (language) => {
    await show("/app/settings/ai-integrations", language);
    expect(screen.getAllByText(t("settings.forcedToolCalls")).length).toBeGreaterThan(0);
    for (const model of ["whisper-1", "tts-1", "gpt-image-1"]) {
      expect(screen.getAllByPlaceholderText(t("settings.modelOrDeployment", { model })).length, `${model} (${language})`).toBeGreaterThan(0);
    }
    expect(screen.getByRole("link", { name: t("nav.accountSync") }).getAttribute("href")).toBe("/app/account-sync");
  });

  it("the Italian pages hold none of the English-only texts", async () => {
    for (const path of ["/app/settings", "/app/settings/ai-integrations", "/app/settings/ai-router"]) {
      const view = await show(path, "it");
      const strings = visibleStrings(view.container);
      for (const english of ENGLISH_ONLY) expect(strings.filter((text) => text.includes(english)), `${english} on ${path}`).toEqual([]);
      view.unmount();
    }
  });

  it("the Italian hint of the GitHub Models token calls it a PAT, as everywhere else", () => {
    expect(t("settings.githubModelsHint")).toContain("GitHub PAT");
    expect(i18n.t("settings.githubModelsHint", { lng: "it" })).toContain("PAT GitHub");
    expect(i18n.t("settings.githubModelsHint", { lng: "it" })).not.toMatch(/\bPAG\b/);
  });

  it("the Italian texts are translated, not copied from English", () => {
    for (const key of ["routing.maxCandidates", "routing.maxTotalDuration", "routing.maxTokenAttempts", "routing.maxEstimatedCost", "routing.browserBoundary", "routing.cell.endpoint", "routing.cell.model", "settings.forcedToolCalls", "settings.modelOrDeployment", "settings.maxOutputTokens", "nav.accountSync"]) {
      expect(i18n.t(key, { lng: "it" }), key).not.toBe(i18n.t(key, { lng: "en" }));
      expect(i18n.t(key, { lng: "it" }), key).not.toBe(key);
    }
  });

  it.each(LANGUAGES)("the settings sidebar names the Account & Sync page in %s too", async (language) => {
    await i18n.changeLanguage(language);
    useSettingsStore.setState({ settings: { ...DEFAULT_SETTINGS, ui: { ...DEFAULT_SETTINGS.ui, language } } });
    render(<MemoryRouter initialEntries={["/app/settings"]}><MobileSidebar /></MemoryRouter>);
    const entry = screen.getAllByRole("link").find((link) => link.getAttribute("href") === "/app/account-sync")!;
    expect(entry).toHaveTextContent(t("nav.accountSync"));
    if (language === "it") expect(entry).not.toHaveTextContent("Account & Sync");
  });
});

describe("hard-coded texts in the Settings page source", () => {
  const source = readFileSync(resolve(process.cwd(), "src/pages/SettingsPage.tsx"), "utf8");
  const TECHNICAL_EXAMPLES = new Set(["github_pat_...", "Azure OpenAI", "https://resource.openai.azure.com", "https://api.openai.com/v1", "ghp_… (GitHub PAT)", "2024-10-21", "gpt-4o", "o3-mini / gpt-4o", "low / standard / high", "0"]);

  it("has no literal labels, titles or aria-labels: they all come from the translations", () => {
    expect(Array.from(source.matchAll(/\b(?:label|aria-label|title|alt)="([^"]*)"/g)).map((match) => match[1])).toEqual([]);
  });

  it("has no literal text between tags", () => {
    const literals = Array.from(source.matchAll(/<\/?[A-Za-z][^<>]*>([^<>{}\[\]:=]*[A-Za-z]{3,}[^<>{}\[\]:=]*)</g)).map((match) => match[1].trim()).filter(Boolean);
    expect(literals).toEqual([]);
  });

  it("uses literal placeholders only for technical examples (names, URLs, versions, model ids)", () => {
    const placeholders = Array.from(source.matchAll(/placeholder="([^"]*)"/g)).map((match) => match[1]);
    expect(placeholders.filter((placeholder) => !TECHNICAL_EXAMPLES.has(placeholder))).toEqual([]);
  });

  it("does not pick its texts with a language ternary: they come from the translations, in the language of the app", () => {
    expect(source.match(/ui\.language === "(?:it|en)" \?/g) ?? []).toEqual([]);
  });
});

describe("the offline explanation", () => {
  it.each(LANGUAGES)("is translated, and follows the language of the app (%s)", async (language) => {
    vi.spyOn(window.navigator, "onLine", "get").mockReturnValue(false);
    await show("/app/settings/ai-router", language);
    expect(i18n.exists("settings.offlineExplanation", { lng: language })).toBe(true);
    expect(document.getElementById("offline-settings-explanation")).toHaveTextContent(t("settings.offlineExplanation"));
    expect(screen.getByRole("button", { name: t("settings.syncFromDrive") })).toBeInTheDocument();
  });

  it("follows the language of the app even when the saved language says otherwise", async () => {
    vi.spyOn(window.navigator, "onLine", "get").mockReturnValue(false);
    await show("/app/settings/ai-router", "it");
    useSettingsStore.setState({ settings: { ...useSettingsStore.getState().settings, ui: { ...DEFAULT_SETTINGS.ui, language: "en" } } });
    expect(await screen.findByText(t("settings.offlineExplanation"))).toBeInTheDocument();
    expect(screen.getByRole("button", { name: t("settings.syncFromDrive") })).toBeInTheDocument();
    expect(t("settings.offlineExplanation")).toContain("Offline: le modifiche");
  });
});
