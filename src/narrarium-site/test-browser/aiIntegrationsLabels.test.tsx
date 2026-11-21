import { cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";

const catalog = vi.hoisted(() => ({ fetchOpenAICompatibleModels: vi.fn() }));

vi.mock("@/drive/useSettings", () => ({
  useSettings: () => ({ load: async () => undefined, save: async () => undefined, resolveOfflineConflict: async () => undefined, syncStatus: "idle", lastSynced: null }),
}));
vi.mock("@/components/ui/use-toast", () => ({ useToast: () => ({ toast: () => undefined }), toast: () => undefined }));
vi.mock("@/ai/openaiModelsCatalog", () => ({ fetchOpenAICompatibleModels: catalog.fetchOpenAICompatibleModels }));

import i18n from "@/i18n";
import { SettingsPage } from "@/pages/SettingsPage";
import { useSettingsStore } from "@/store/settingsStore";
import { DEFAULT_SETTINGS, type AIIntegration, type AppSettings } from "@/types/settings";

type Language = "en" | "it";
const LANGUAGES: Language[] = ["en", "it"];
const t = (key: string, options?: Record<string, unknown>) => i18n.t(key, options) as string;

const AZURE = { id: "az", name: "Studio Azure", provider: "azure_openai", endpoint: "https://x.openai.azure.com", apiKey: "k", apiVersion: "2024-10-21", chatModels: [{ id: "m1", name: "gpt-4o", underlyingModel: "gpt-4o", capabilities: ["default", "review"] }], modelSpeechToText: "whisper-1", modelTextToSpeech: "tts-1", modelImageGeneration: "gpt-image-1" } as unknown as AIIntegration;
const OPENAI = { id: "oa", name: "Compat", provider: "openai", endpoint: "https://api.example.com/v1", apiKey: "k", chatModels: [{ id: "m2", name: "llama", capabilities: ["default"] }] } as unknown as AIIntegration;
const GITHUB = { id: "gh", name: "Hub", provider: "github_models", apiKey: "ghp", chatModels: [{ id: "m3", name: "gpt-4.1", tier: "high", capabilities: ["default"] }] } as unknown as AIIntegration;
const M365 = { id: "m365", name: "Office", provider: "m365_copilot", apiKey: "", chatModels: [] } as unknown as AIIntegration;
const ALL = [AZURE, OPENAI, GITHUB, M365];
const ROUTES: AppSettings["taskRouting"] = {
  default: { primary: { integrationId: "az", model: "gpt-4o" }, fallbacks: [{ integrationId: "oa", model: "llama" }, { integrationId: "gh", model: "gpt-4.1" }] },
  tts: { primary: { integrationId: "__browser__", model: "browser" }, fallbacks: [] },
};

async function show(path: string, patch: Partial<AppSettings> = {}, language: Language = "en") {
  await i18n.changeLanguage(language);
  useSettingsStore.setState({ settings: { ...DEFAULT_SETTINGS, ui: { ...DEFAULT_SETTINGS.ui, language }, ...patch } });
  return render(<MemoryRouter initialEntries={[path]}><SettingsPage /></MemoryRouter>);
}

const integrationsPage = (patch: Partial<AppSettings> = {}, language: Language = "en") => show("/app/settings/ai-integrations", patch, language);
const routerPage = (patch: Partial<AppSettings> = {}, language: Language = "en") => show("/app/settings/ai-router", patch, language);
const editorOf = (name: string) => Array.from(document.querySelectorAll("details > summary p.font-semibold")).find((title) => title.textContent === name)!.closest("details") as HTMLElement;
const change = (control: HTMLElement, value: string) => fireEvent.change(control, { target: { value } });

vi.setConfig({ testTimeout: 30_000 });
beforeAll(() => i18n.changeLanguage("en"));

afterEach(async () => {
  cleanup();
  catalog.fetchOpenAICompatibleModels.mockReset();
  useSettingsStore.setState({ settings: DEFAULT_SETTINGS });
  await i18n.changeLanguage("en");
});

describe("AI Integrations: every field is found by its label", () => {
  it.each(LANGUAGES)("fills the whole add form through its labels (%s)", async (language) => {
    await integrationsPage({}, language);

    expect(screen.getByRole("combobox", { name: t("settings.provider") })).toHaveTextContent("Azure OpenAI");
    change(screen.getByLabelText(t("settings.integrationName")), "Studio");
    change(screen.getByLabelText(t("settings.endpoint")), "https://studio.openai.azure.com");
    change(screen.getByLabelText(t("settings.apiKey")), "secret-key");
    change(screen.getByLabelText(t("settings.requestTimeoutMs")), "45000");
    change(screen.getByLabelText(t("speech.sttModel")), "whisper-1");
    change(screen.getByLabelText(t("speech.ttsModel")), "tts-1");
    change(screen.getByLabelText(t("images.imageModel")), "gpt-image-2");
    change(screen.getByLabelText(t("settings.apiVersion")), "2025-01-01");
    change(screen.getByLabelText(t("settings.chatModelName")), "my-deployment");
    change(screen.getByLabelText(t("settings.underlyingModel")), "o3-mini");
    change(screen.getByLabelText(t("settings.maxInputTokens")), "128000");
    change(screen.getByLabelText(t("settings.maxOutputTokens")), "16000");
    change(screen.getByLabelText(t("costs.priceInput")), "2.5");
    change(screen.getByLabelText(t("costs.priceTts")), "15");
    const toolCalls = screen.getByRole("switch", { name: t("settings.forcedToolCalls") });
    expect(toolCalls).toBeChecked();
    fireEvent.click(toolCalls);

    fireEvent.click(screen.getByRole("button", { name: t("settings.addIntegration") }));
    expect(useSettingsStore.getState().settings.aiIntegrations).toHaveLength(1);
    expect(useSettingsStore.getState().settings.aiIntegrations[0]).toMatchObject({
      name: "Studio",
      endpoint: "https://studio.openai.azure.com",
      apiKey: "secret-key",
      requestTimeoutMs: 45000,
      modelSpeechToText: "whisper-1",
      modelTextToSpeech: "tts-1",
      modelImageGeneration: "gpt-image-2",
      apiVersion: "2025-01-01",
      pricing: { ttsPerMChar: 15 },
      chatModels: [{ name: "my-deployment", underlyingModel: "o3-mini", maxInputTokens: 128000, maxOutputTokens: 16000, supportsToolCalls: false, pricing: { inputPerMTok: 2.5 } }],
    });
  });

  it("labels the fields that depend on the provider, and ties the GitHub hint to its token", async () => {
    catalog.fetchOpenAICompatibleModels.mockResolvedValue([{ id: "model-a" }, { id: "model-b" }]);
    await integrationsPage({ aiIntegrations: ALL });

    const github = within(editorOf("Hub"));
    expect(github.getByLabelText(t("settings.githubPat"))).toHaveAccessibleDescription(t("settings.githubModelsHint"));
    expect(github.getByLabelText(t("settings.modelTier"))).toHaveValue("high");
    expect(github.queryByLabelText(t("settings.endpoint"))).not.toBeInTheDocument();

    const azure = within(editorOf("Studio Azure"));
    expect(azure.getByLabelText(t("settings.underlyingModel"))).toHaveValue("gpt-4o");
    expect(azure.getByLabelText(t("settings.apiVersion"))).toHaveValue("2024-10-21");
    expect(azure.getByRole("combobox", { name: t("settings.provider") })).toHaveTextContent("Azure OpenAI");

    const office = within(editorOf("Office"));
    expect(office.getByLabelText(t("settings.integrationName"))).toHaveValue("Office");
    expect(office.queryByLabelText(t("settings.apiKey"))).not.toBeInTheDocument();

    const compat = within(editorOf("Compat"));
    expect(compat.getByLabelText(t("settings.endpoint"))).toHaveValue("https://api.example.com/v1");
    fireEvent.click(compat.getByRole("button", { name: t("settings.loadApiModels") }));
    expect(await compat.findByRole("combobox", { name: t("settings.apiModelChoice") }, { timeout: 10_000 })).toBeInTheDocument();
  });

  it.each(LANGUAGES)("labels the default providers and the currency, and ties the currency hint to its select (%s)", async (language) => {
    await integrationsPage({ aiIntegrations: [AZURE, OPENAI], defaultWritingIntegrationId: "az", defaultReviewIntegrationId: "oa" }, language);
    expect(screen.getByRole("combobox", { name: t("settings.defaultWriting") })).toHaveTextContent("Studio Azure");
    expect(screen.getByRole("combobox", { name: t("settings.defaultReview") })).toHaveTextContent("Compat");
    expect(screen.getByRole("combobox", { name: t("settings.costCurrency") })).toHaveAccessibleDescription(t("settings.costCurrencyHint"));
  });

  it("exposes which capabilities a model has, and toggles them", async () => {
    await integrationsPage();
    expect(screen.getByRole("button", { name: t("settings.capability.default"), pressed: true })).toBeInTheDocument();
    const audit = screen.getByRole("button", { name: t("settings.capability.audit"), pressed: false });
    fireEvent.click(audit);
    expect(screen.getByRole("button", { name: t("settings.capability.audit"), pressed: true })).toBeInTheDocument();
  });
});

describe("AI Router: every control is found by its label", () => {
  it.each(LANGUAGES)("finds the fallback switches, with their hints, and the execution limits (%s)", async (language) => {
    await routerPage({ aiIntegrations: ALL, taskRouting: ROUTES }, language);

    const sameBoundary = screen.getByRole("switch", { name: t("routing.sameBoundaryOnly") });
    expect(sameBoundary).toHaveAccessibleDescription(t("routing.sameBoundaryOnlyHint"));
    fireEvent.click(sameBoundary);
    expect(useSettingsStore.getState().settings.fallbackDisclosure?.sameBoundaryOnly).toBe(true);
    const acknowledge = screen.getByRole("switch", { name: t("routing.requireAcknowledgement") });
    expect(acknowledge).toHaveAccessibleDescription(t("routing.requireAcknowledgementHint"));

    expect(screen.getByLabelText(t("routing.maxCandidates"))).toHaveValue(4);
    expect(screen.getByLabelText(t("routing.maxTotalDuration"))).toHaveValue(180000);
    expect(screen.getByLabelText(t("routing.maxTokenAttempts"))).toHaveValue(200000);
    expect(screen.getByLabelText(t("routing.maxEstimatedCost"))).toHaveValue(5);
    change(screen.getByLabelText(t("routing.maxCandidates")), "3");
    expect(useSettingsStore.getState().settings.routingExecution?.maxCandidates).toBe(3);
  });

  it.each(LANGUAGES)("names the integration and the model of every route, inside a group named after the task (%s)", async (language) => {
    await routerPage({ aiIntegrations: ALL, taskRouting: ROUTES }, language);
    const route = within(screen.getByRole("group", { name: t("routing.task.default") }));

    const rows: Array<[string, string, string]> = [
      [t("routing.primary"), "Studio Azure", "gpt-4o"],
      [t("routing.fallbackN", { n: 1 }), "Compat", "llama"],
      [t("routing.fallbackN", { n: 2 }), "Hub", "gpt-4.1"],
    ];
    for (const [target, integration, model] of rows) {
      expect(route.getByRole("combobox", { name: t("routing.targetIntegration", { target }) }), target).toHaveTextContent(integration);
      expect(route.getByRole("combobox", { name: t("routing.targetModel", { target }) }), target).toHaveTextContent(model);
    }
    expect(screen.getByRole("group", { name: t("routing.task.audit") })).toBeInTheDocument();
  });
});

describe("both pages: nothing is left without its label", () => {
  const PAGES = ["/app/settings/ai-integrations", "/app/settings/ai-router"];

  it.each(LANGUAGES)("every label has a control, every field a label, every id is unique and every reference resolves (%s)", async (language) => {
    for (const path of PAGES) {
      const view = await show(path, { aiIntegrations: ALL, taskRouting: ROUTES }, language);

      const orphans = Array.from(document.querySelectorAll("label")).filter((label) => !label.control).map((label) => label.textContent);
      expect(orphans, `labels without a control on ${path}`).toEqual([]);

      const ids = Array.from(document.querySelectorAll("[id]")).map((element) => element.id);
      expect(ids.filter((id, index) => ids.indexOf(id) !== index), `duplicate ids on ${path}`).toEqual([]);

      const dangling: string[] = [];
      document.querySelectorAll("[aria-labelledby],[aria-describedby]").forEach((element) => {
        for (const attribute of ["aria-labelledby", "aria-describedby"]) {
          for (const id of (element.getAttribute(attribute) ?? "").split(/\s+/).filter(Boolean)) if (!document.getElementById(id)) dangling.push(`${attribute}=${id}`);
        }
      });
      expect(dangling, `dangling references on ${path}`).toEqual([]);

      const labelled = Array.from(document.querySelectorAll<HTMLElement>("input:not([type=hidden]), textarea, select, [role=combobox], [role=switch]"))
        .filter((control) => !control.getAttribute("aria-label") && !control.getAttribute("aria-labelledby") && !(control as HTMLInputElement).labels?.length)
        .map((control) => `${control.tagName.toLowerCase()}${control.getAttribute("placeholder") ? ` (${control.getAttribute("placeholder")})` : ""}`);
      expect(labelled, `fields without a label on ${path}`).toEqual([]);
      const buttons = Array.from(document.querySelectorAll<HTMLElement>("button:not([role])"))
        .filter((button) => !button.getAttribute("aria-label") && !button.getAttribute("aria-labelledby") && !button.textContent?.trim())
        .map((button) => button.className.slice(0, 40));
      expect(buttons, `buttons without a name on ${path}`).toEqual([]);
      view.unmount();
    }
  });
});
