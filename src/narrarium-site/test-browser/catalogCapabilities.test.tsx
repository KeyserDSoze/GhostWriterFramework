import { cleanup, fireEvent, render, waitFor, within } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { pickAiRuntimeConfig, redactAiRuntimeConfig } from "narrarium-engine";

vi.mock("@/drive/useSettings", () => ({
  useSettings: () => ({ load: async () => undefined, save: async () => undefined, resolveOfflineConflict: async () => undefined, syncStatus: "idle", lastSynced: null }),
}));
vi.mock("@/components/ui/use-toast", () => ({ useToast: () => ({ toast: () => undefined }), toast: () => undefined }));

import i18n from "@/i18n";
import { SettingsPage } from "@/pages/SettingsPage";
import { useSettingsStore } from "@/store/settingsStore";
import { DEFAULT_SETTINGS, type AIIntegration, type ChatModel } from "@/types/settings";
import { polyfillRadix } from "./helpers/radix";

const t = (key: string, options?: Record<string, unknown>) => i18n.t(key, options) as string;

/** A model that its gateway has declared everything of: the three capabilities the engine reads besides tool calls. */
const DECLARED: ChatModel = {
  id: "m1", name: "muse-glimmer-30b", capabilities: ["default"], maxInputTokens: 131072, maxOutputTokens: 8192,
  supportsToolCalls: true, supportsStreaming: true, supportsReasoning: true, supportsVision: true, reasoningParameter: "chat_template_kwargs.reasoning_strength",
};
const GATEWAY: AIIntegration = { id: "gw", name: "LlmProxy", provider: "openai", endpoint: "https://gw.example.test/v1", apiKey: "sk-gw-0123456789abcdef", chatModels: [DECLARED] };

vi.setConfig({ testTimeout: 60_000 });
beforeAll(async () => {
  polyfillRadix();
  await i18n.changeLanguage("en");
});
afterEach(async () => {
  cleanup();
  useSettingsStore.setState({ settings: DEFAULT_SETTINGS });
  await i18n.changeLanguage("en");
});

describe("the capabilities a gateway declares, kept in the model like every other field of it", () => {
  it("are fields of the chat model, with a boolean each, and survive the copies the settings go through: the store and a trip through JSON, as the cloud and the offline cache do", () => {
    useSettingsStore.setState({ settings: { ...DEFAULT_SETTINGS, aiIntegrations: [GATEWAY] } });
    const stored = useSettingsStore.getState().settings.aiIntegrations[0].chatModels![0];
    expect(stored).toMatchObject({ supportsStreaming: true, supportsReasoning: true, supportsVision: true });
    const copy = JSON.parse(JSON.stringify(useSettingsStore.getState().settings)) as typeof DEFAULT_SETTINGS;
    expect(copy.aiIntegrations[0].chatModels![0]).toEqual(DECLARED);
  });

  it("reach the engine when the autopilot runs in the browser and when its configuration goes to the personal server, and the safe view the server gives back says them without a key", () => {
    const config = pickAiRuntimeConfig({ aiIntegrations: [GATEWAY] });
    expect(config.aiIntegrations[0].chatModels![0]).toMatchObject({ supportsToolCalls: true, supportsStreaming: true, supportsReasoning: true, supportsVision: true, maxInputTokens: 131072, maxOutputTokens: 8192 });
    const safe = redactAiRuntimeConfig(config).integrations[0];
    expect(safe.models[0]).toMatchObject({ supportsStreaming: true, supportsReasoning: true, supportsVision: true });
    expect(JSON.stringify(safe)).not.toContain(GATEWAY.apiKey);
  });

  it("are not made up for a model that says nothing: an absent capability stays absent all the way to the engine, because a capability that was never said is not a restriction", () => {
    const plain: ChatModel = { id: "m2", name: "legacy-8b", capabilities: [] };
    const model = pickAiRuntimeConfig({ aiIntegrations: [{ ...GATEWAY, chatModels: [plain] }] }).aiIntegrations[0].chatModels![0];
    for (const key of ["supportsStreaming", "supportsReasoning", "supportsVision"]) expect(model, key).not.toHaveProperty(key);
  });

  it("stay when the author changes something else in the row of the model: its tool-call switch, its roles and the name are edited by copying the model", async () => {
    await i18n.changeLanguage("en");
    useSettingsStore.setState({ settings: { ...DEFAULT_SETTINGS, aiIntegrations: [GATEWAY] } });
    render(<MemoryRouter initialEntries={["/app/settings/ai-integrations"]}><SettingsPage /></MemoryRouter>);
    const card = Array.from(document.querySelectorAll("details > summary p.font-semibold")).find((title) => title.textContent === "LlmProxy")!.closest("details") as HTMLElement;

    fireEvent.click(within(card).getByRole("switch", { name: t("settings.forcedToolCalls") }));
    fireEvent.click(within(card).getByRole("button", { name: t("settings.capability.review"), pressed: false }));
    fireEvent.change(within(card).getByLabelText(t("settings.maxOutputTokens")), { target: { value: "4096" } });

    await waitFor(() => expect(useSettingsStore.getState().settings.aiIntegrations[0].chatModels![0].supportsToolCalls).toBe(false));
    const after = useSettingsStore.getState().settings.aiIntegrations[0].chatModels![0];
    expect(after).toMatchObject({ supportsStreaming: true, supportsReasoning: true, supportsVision: true, maxOutputTokens: 4096, reasoningParameter: "chat_template_kwargs.reasoning_strength" });
    expect(after.capabilities).toEqual(["default", "review"]);
  });
});
