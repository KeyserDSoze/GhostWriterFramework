import { cleanup, fireEvent, screen, within } from "@testing-library/react";
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";

vi.mock("@/drive/useSettings", () => ({
  useSettings: () => ({ load: async () => undefined, save: async () => undefined, resolveOfflineConflict: async () => undefined, syncStatus: "idle", lastSynced: null }),
}));
vi.mock("@/components/ui/use-toast", () => ({ useToast: () => ({ toast: () => undefined }), toast: () => undefined }));

import i18n from "@/i18n";
import { DEFAULT_SETTINGS, type AIIntegration } from "@/types/settings";
import { useSettingsStore } from "@/store/settingsStore";
import { LANGUAGES, cardOf, showIntegrations, stored, t, type Language } from "./helpers/integrationPage";

// The API version of an Azure OpenAI integration is the default of its models, and each model may have its own: its deployment may need another `api-version`. The card of a model says
// the version it inherits, lets the author write its own, and says by a badge (and in words) that it has one.

const azure = (extra: Record<string, unknown> = {}, models: Array<Record<string, unknown>> = [{ id: "m1", name: "gpt-6-luna" }, { id: "m2", name: "gpt-5-sol", apiVersion: "2024-10-21" }]) => ({
  id: "az", name: "AzureOpenAi-GW", provider: "azure_openai", endpoint: "https://x.openai.azure.com", apiKey: "k", apiVersion: "2025-01-01-preview",
  chatModels: models.map((model) => ({ capabilities: ["default"], ...model })),
  ...extra,
}) as unknown as AIIntegration;
const OPENAI = { id: "oa", name: "LlmProxy", provider: "openai", endpoint: "http://llm.test/v1", apiKey: "k", chatModels: [{ id: "m1", name: "muse-glimmer-30b", capabilities: ["default"] }] } as unknown as AIIntegration;

// The label of the integration's field and of a model's field is the same word (the version): the fields of the models are told by the box they are in, the integration's by its own address.
const fieldsOf = (card: HTMLElement) => Array.from(card.querySelectorAll<HTMLInputElement>("[data-model-api-version] input"));
const integrationField = (card: HTMLElement) => card.querySelector<HTMLInputElement>("input[id$=\"-version\"]") as HTMLInputElement;
const modelOf = (index = 0) => stored().chatModels![index];

beforeAll(async () => {
  await i18n.changeLanguage("en");
});

afterEach(async () => {
  cleanup();
  useSettingsStore.setState({ settings: DEFAULT_SETTINGS });
  await i18n.changeLanguage("en");
});

describe.each(LANGUAGES)("the API version of a model [%s]", (language: Language) => {
  it("is a field in the card of each Azure model, empty when the model has none, and it says what it inherits: the version of the integration", async () => {
    await showIntegrations([azure()], language);
    const [first, second] = fieldsOf(cardOf("AzureOpenAi-GW"));
    expect(first).toHaveValue("");
    expect(first).toHaveAttribute("placeholder", t("settings.modelApiVersionInherit", { value: "2025-01-01-preview" }));
    expect(second).toHaveValue("2024-10-21");
    expect(first.closest("[data-model-api-version]")).toHaveAttribute("data-model-api-version", "inherited");
    expect(second.closest("[data-model-api-version]")).toHaveAttribute("data-model-api-version", "own");
  });

  it("has a name of its own for a screen reader, the name of its model after the word, so that it is never taken for the integration's field", async () => {
    await showIntegrations([azure()], language);
    const card = cardOf("AzureOpenAi-GW");
    const [first, second] = fieldsOf(card);
    expect(first).toHaveAccessibleName(`${t("settings.modelApiVersion")} — gpt-6-luna`);
    expect(second).toHaveAccessibleName(`${t("settings.modelApiVersion")} — gpt-5-sol`);
    expect(integrationField(card)).toHaveAccessibleName(t("settings.apiVersion"));
    expect(within(card).getAllByLabelText(t("settings.modelApiVersion"), { exact: false }).length).toBeGreaterThanOrEqual(3);
    expect(within(card).getByLabelText(t("settings.apiVersion"), { selector: "input" }).id).toBe(integrationField(card).id);
  });

  it("says in the same words what the integration's version is for: the default of the models that have none", async () => {
    await showIntegrations([azure()], language);
    const card = cardOf("AzureOpenAi-GW");
    expect(integrationField(card)).toHaveValue("2025-01-01-preview");
    expect(integrationField(card)).toHaveAccessibleDescription(t("settings.integrationApiVersionHint"));
    const [first] = fieldsOf(card);
    expect(first).toHaveAccessibleDescription(t("settings.modelApiVersionHint"));
  });

  it("writing a version gives the model its own, trimmed, and a badge says so; emptying the field gives the inheritance back, and the badge goes", async () => {
    await showIntegrations([azure()], language);
    const card = cardOf("AzureOpenAi-GW");
    const [first] = fieldsOf(card);
    expect(card.querySelectorAll("[data-api-version-badge]")).toHaveLength(1);
    fireEvent.change(first, { target: { value: "  2025-03-01-preview " } });
    expect(modelOf(0).apiVersion).toBe("2025-03-01-preview");
    expect(modelOf(1).apiVersion, "the other model keeps its own").toBe("2024-10-21");
    expect(card.querySelectorAll("[data-api-version-badge]")).toHaveLength(2);
    expect(within(card).getAllByText(t("settings.modelApiVersionOwn"))).toHaveLength(2);
    fireEvent.change(fieldsOf(card)[0], { target: { value: "   " } });
    expect(modelOf(0).apiVersion, "an empty field is no field").toBeUndefined();
    expect("apiVersion" in modelOf(0)).toBe(true);
    expect(card.querySelectorAll("[data-api-version-badge]")).toHaveLength(1);
  });

  it("follows the version of the integration, and the default of the engine when the integration has none", async () => {
    await showIntegrations([azure({ apiVersion: "" })], language);
    const card = cardOf("AzureOpenAi-GW");
    expect(fieldsOf(card)[0]).toHaveAttribute("placeholder", t("settings.modelApiVersionInherit", { value: "2024-10-21" }));
    fireEvent.change(integrationField(card), { target: { value: "2025-04-01-preview" } });
    expect(fieldsOf(card)[0]).toHaveAttribute("placeholder", t("settings.modelApiVersionInherit", { value: "2025-04-01-preview" }));
  });

  it("says in words, and not by colour, that what was typed cannot be a version: in the model's field and in the integration's", async () => {
    await showIntegrations([azure()], language);
    const card = cardOf("AzureOpenAi-GW");
    const [first] = fieldsOf(card);
    expect(first).not.toHaveAttribute("aria-invalid");
    fireEvent.change(first, { target: { value: "2025 01 01" } });
    expect(fieldsOf(card)[0]).toHaveAttribute("aria-invalid", "true");
    expect(within(card).getAllByRole("alert").some((alert) => alert.textContent === t("settings.modelApiVersionInvalid"))).toBe(true);
    expect(fieldsOf(card)[0]).toHaveAccessibleDescription(`${t("settings.modelApiVersionHint")} ${t("settings.modelApiVersionInvalid")}`);
    fireEvent.change(fieldsOf(card)[0], { target: { value: "2025-01-01-preview" } });
    expect(fieldsOf(card)[0]).not.toHaveAttribute("aria-invalid");
    fireEvent.change(integrationField(card), { target: { value: "2024/10/21" } });
    expect(integrationField(card)).toHaveAttribute("aria-invalid", "true");
    expect(integrationField(card)).toHaveAccessibleDescription(`${t("settings.integrationApiVersionHint")} ${t("settings.modelApiVersionInvalid")}`);
  });

  it("is not in the card of a provider that has no API version", async () => {
    await showIntegrations([OPENAI], language);
    expect(fieldsOf(cardOf("LlmProxy"))).toHaveLength(0);
  });
});

describe("what is stored", () => {
  it("keeps the settings of before as they are: a model without a version has no key, and the ones with one keep it, through the JSON the settings are saved as", async () => {
    await showIntegrations([azure({}, [{ id: "m1", name: "gpt-6-luna" }, { id: "m2", name: "gpt-5-sol", apiVersion: "2024-10-21" }])], "en");
    const saved = JSON.parse(JSON.stringify(useSettingsStore.getState().settings));
    expect("apiVersion" in saved.aiIntegrations[0].chatModels[0]).toBe(false);
    expect(saved.aiIntegrations[0].chatModels[1].apiVersion).toBe("2024-10-21");
    expect(saved.aiIntegrations[0].apiVersion).toBe("2025-01-01-preview");
    // The same settings, loaded again, say the same.
    useSettingsStore.setState({ settings: { ...DEFAULT_SETTINGS, ...saved } });
    cleanup();
    await showIntegrations(saved.aiIntegrations, "en");
    expect(fieldsOf(cardOf("AzureOpenAi-GW")).map((field) => field.value)).toEqual(["", "2024-10-21"]);
    expect(screen.queryAllByRole("alert")).toHaveLength(0);
  });
});
