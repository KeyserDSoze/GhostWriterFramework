import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { suggestedReasoningParameter } from "narrarium-engine";

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
const TEMPLATE = "chat_template_kwargs.reasoning_strength";

const gateway = (models: Array<Record<string, unknown>>, extra: Record<string, unknown> = {}) => ({
  id: "llm", name: "LlmProxy", provider: "openai", endpoint: "http://llm.test/v1", apiKey: "k",
  chatModels: models.map((model, index) => ({ id: `m${index}`, capabilities: ["default"], ...model })),
  ...extra,
}) as unknown as AIIntegration;
const AZURE = (models: Array<Record<string, unknown>>) => gateway(models, { id: "az", name: "Studio Azure", provider: "azure_openai", endpoint: "https://x.openai.azure.com", apiVersion: "2024-10-21" });
const M365 = { id: "m365", name: "Office", provider: "m365_copilot", apiKey: "", chatModels: [] } as unknown as AIIntegration;
const MUSE = { name: "muse-glimmer-30b" };
const OTHER = { name: "legacy-chat-7b" };

async function show(integrations: AIIntegration[], language: Language = "en") {
  await i18n.changeLanguage(language);
  useSettingsStore.setState({ settings: { ...DEFAULT_SETTINGS, ui: { ...DEFAULT_SETTINGS.ui, language }, aiIntegrations: integrations } });
  return render(<MemoryRouter initialEntries={["/app/settings/ai-integrations"]}><SettingsPage /></MemoryRouter>);
}

const cardOf = (name: string) => Array.from(document.querySelectorAll("details > summary p.font-semibold")).find((title) => title.textContent === name)!.closest("details") as HTMLElement;
const selects = (card: HTMLElement) => within(card).queryAllByRole("combobox", { name: t("settings.thinkingParameter") });
const useButtons = (card: HTMLElement) => within(card).queryAllByRole("button", { name: new RegExp(`^${t("settings.thinkingParameterUse")}`) });
const modelOf = (integration = 0, model = 0) => useSettingsStore.getState().settings.aiIntegrations[integration].chatModels![model];
const defaultText = () => t("settings.thinkingParameterDefault", { value: "reasoning_effort" });

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

vi.setConfig({ testTimeout: 30_000 });
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

describe("the «Thinking parameter» of a model, in its row of the integration card", () => {
  it.each(LANGUAGES)("is a select on the row of every model, with the label the engine's remedy quotes, and not on Microsoft 365 Copilot, which has no models (%s)", async (language) => {
    await show([gateway([MUSE, OTHER]), M365], language);
    expect(t("settings.thinkingParameter")).toBe(language === "en" ? "Thinking parameter" : "Parametro del thinking");
    expect(selects(cardOf("LlmProxy"))).toHaveLength(2);
    expect(selects(cardOf("Office"))).toHaveLength(0);
  });

  it("comes right after the «Forced tool calls» switch of its own model, and before the next model", async () => {
    await show([gateway([MUSE, OTHER])]);
    const card = cardOf("LlmProxy");
    const switches = within(card).getAllByRole("switch", { name: t("settings.forcedToolCalls") });
    const [first, second] = selects(card);
    expect(switches[0].compareDocumentPosition(first) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    expect(first.compareDocumentPosition(switches[1]) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    expect(switches[1].compareDocumentPosition(second) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
  });

  it.each(LANGUAGES)("shows the default for a model that never said, what it says for one that did, and the default for a value it does not know (%s)", async (language) => {
    await show([gateway([{ ...OTHER }, { name: "m-template", reasoningParameter: TEMPLATE }, { name: "m-none", reasoningParameter: "none" }, { name: "m-odd", reasoningParameter: "chat_template_kwargs.enable_thinking" }])], language);
    const [plain, template, none, odd] = selects(cardOf("LlmProxy"));
    expect(plain).toHaveTextContent(defaultText());
    expect(template).toHaveTextContent(TEMPLATE);
    expect(none).toHaveTextContent(/^none$/);
    expect(odd).toHaveTextContent(defaultText());
    expect(defaultText()).toBe(language === "en" ? "reasoning_effort (default)" : "reasoning_effort (predefinito)");
  });

  it.each(LANGUAGES)("offers the three values as they are written, the default first (%s)", async (language) => {
    await show([gateway([OTHER])], language);
    expect(await optionsOf(selects(cardOf("LlmProxy"))[0])).toEqual([defaultText(), TEMPLATE, "none"]);
  });

  it("stores the value that was chosen on that model, and on no other", async () => {
    await show([gateway([MUSE, OTHER])]);
    const [first, second] = selects(cardOf("LlmProxy"));
    await choose(first, TEMPLATE);
    expect(modelOf(0, 0).reasoningParameter).toBe(TEMPLATE);
    expect("reasoningParameter" in modelOf(0, 1)).toBe(false);
    await choose(second, "none");
    expect(modelOf(0, 1).reasoningParameter).toBe("none");
    expect(modelOf(0, 0).reasoningParameter).toBe(TEMPLATE);
  });

  it("stores the default when the author chooses it after another value: it is their word, and the suggestion does not come back", async () => {
    await show([gateway([MUSE])]);
    await choose(selects(cardOf("LlmProxy"))[0], "none");
    await choose(selects(cardOf("LlmProxy"))[0], defaultText());
    expect(modelOf().reasoningParameter).toBe("reasoning_effort");
    expect(useButtons(cardOf("LlmProxy"))).toHaveLength(0);
  });

  it.each(LANGUAGES)("is described by a hint that says how the level is sent, what Muse Glimmer wants and that «none» does not turn thinking off (%s)", async (language) => {
    await show([gateway([OTHER])], language);
    const select = selects(cardOf("LlmProxy"))[0];
    const hint = document.getElementById((select.getAttribute("aria-describedby") ?? "").split(" ")[0]) as HTMLElement;
    expect(hint).toHaveTextContent(t("settings.thinkingParameterHint"));
    const words = t("settings.thinkingParameterHint");
    for (const needle of ["reasoning_effort", TEMPLATE, "llama.cpp", "Muse Glimmer", "none"]) expect(words, needle).toContain(needle);
    expect(words).toMatch(language === "en" ? /does not turn thinking off/ : /non spegne il thinking/);
    expect(hint.className).toMatch(/\btext-xs\b/);
  });
});

describe("the suggestion for a model whose name the documentation ties to the chat-template argument", () => {
  // The names the engine's README gives for Muse Glimmer, and the ones it says are not guessed.
  const POSITIVE = ["muse-glimmer", "muse-glimmer-30B", "meta-models/Muse-Glimmer-30B-GGUF:Q4_K_M", "unsloth/Muse-Glimmer-30B-GGUF", "muse-glimmer:30b-mlx", "meta-muse-glimmer"];
  const NEGATIVE = ["gpt-4o", "llama-3.3-70b", "muse-spark", "qwen3-30b", "glimmer", "o3-mini"];

  it("follows the engine's hint, which is the only thing that decides it (the examples of its README are in both lists)", () => {
    for (const name of POSITIVE) expect(suggestedReasoningParameter(name), name).toBe(TEMPLATE);
    for (const name of NEGATIVE) expect(suggestedReasoningParameter(name), name).toBeUndefined();
  });

  it.each(POSITIVE)("appears for %s, with the value and a button, and changes nothing by itself", async (name) => {
    await show([gateway([{ name }])]);
    const card = cardOf("LlmProxy");
    const [button] = useButtons(card);
    expect(button).toBeInTheDocument();
    expect(card).toHaveTextContent(t("settings.thinkingParameterSuggestion", { value: TEMPLATE }));
    // Never applied by itself: the settings still say nothing about it.
    expect("reasoningParameter" in modelOf()).toBe(false);
    expect(selects(card)[0]).toHaveTextContent(defaultText());
  });

  it.each(NEGATIVE)("does not appear for %s", async (name) => {
    await show([gateway([{ name }])]);
    expect(useButtons(cardOf("LlmProxy"))).toHaveLength(0);
    expect(cardOf("LlmProxy")).not.toHaveTextContent(t("settings.thinkingParameterSuggestion", { value: TEMPLATE }));
  });

  it("reads the model behind an Azure deployment when the deployment declares it, and not the name of the deployment", async () => {
    await show([AZURE([{ name: "prod-chat", underlyingModel: "muse-glimmer-30b" }, { name: "muse-glimmer-prod", underlyingModel: "gpt-4o" }])]);
    const card = cardOf("Studio Azure");
    expect(useButtons(card)).toHaveLength(1);
    expect(useButtons(card)[0].getAttribute("aria-label")).toContain("prod-chat");
  });

  it.each([TEMPLATE, "none", "reasoning_effort"])("does not appear for a model that already says %s: it is only for a model that has not said", async (value) => {
    await show([gateway([{ ...MUSE, reasoningParameter: value }])]);
    expect(useButtons(cardOf("LlmProxy"))).toHaveLength(0);
  });

  it("appears again for a value that the engine would not use: for the engine the model says nothing", async () => {
    await show([gateway([{ ...MUSE, reasoningParameter: "chat_template_kwargs.enable_thinking" }])]);
    expect(useButtons(cardOf("LlmProxy"))).toHaveLength(1);
  });

  it.each(LANGUAGES)("has a button that says «Use it» («Usalo»), and takes the suggestion for that model when it is pressed (%s)", async (language) => {
    await show([gateway([MUSE])], language);
    const card = cardOf("LlmProxy");
    expect(t("settings.thinkingParameterUse")).toBe(language === "en" ? "Use it" : "Usalo");
    const [button] = useButtons(card);
    expect(button).toHaveTextContent(new RegExp(`^${t("settings.thinkingParameterUse")}$`));
    fireEvent.click(button);
    expect(modelOf().reasoningParameter).toBe(TEMPLATE);
    expect(selects(card)[0]).toHaveTextContent(TEMPLATE);
    expect(useButtons(card)).toHaveLength(0);
    expect(card).not.toHaveTextContent(t("settings.thinkingParameterSuggestion", { value: TEMPLATE }));
  });

  it("gives each button a name of its own, which starts with the words on it, and takes the suggestion only for the model it belongs to", async () => {
    await show([gateway([MUSE, { name: "meta-muse-glimmer" }, OTHER])]);
    const card = cardOf("LlmProxy");
    const buttons = useButtons(card);
    expect(buttons).toHaveLength(2);
    const names = buttons.map((button) => button.getAttribute("aria-label"));
    expect(new Set(names).size).toBe(2);
    expect(names[0]).toBe(t("settings.thinkingParameterUseFor", { name: "muse-glimmer-30b" }));
    expect(names[1]).toBe(t("settings.thinkingParameterUseFor", { name: "meta-muse-glimmer" }));
    expect(t("settings.thinkingParameterUseFor", { name: "x" }).startsWith(t("settings.thinkingParameterUse"))).toBe(true);
    fireEvent.click(buttons[1]);
    expect("reasoningParameter" in modelOf(0, 0)).toBe(false);
    expect(modelOf(0, 1).reasoningParameter).toBe(TEMPLATE);
    expect("reasoningParameter" in modelOf(0, 2)).toBe(false);
    expect(useButtons(card)).toHaveLength(1);
  });

  it("follows the name as it is typed: it comes when the name becomes one of Muse Glimmer, and goes when it stops being one, without storing anything", async () => {
    await show([gateway([{ name: "gpt-4o" }])]);
    const card = cardOf("LlmProxy");
    const name = within(card).getByLabelText(t("settings.chatModelName"));
    expect(useButtons(card)).toHaveLength(0);
    fireEvent.change(name, { target: { value: "muse-glimmer-30b" } });
    expect(useButtons(card)).toHaveLength(1);
    expect("reasoningParameter" in modelOf()).toBe(false);
    fireEvent.change(name, { target: { value: "gpt-4o" } });
    expect(useButtons(card)).toHaveLength(0);
  });

  it("is quiet: a note in the row, in no live region and no alert, that the select is described by, so that a screen reader says it when the field is reached", async () => {
    await show([gateway([MUSE])]);
    const card = cardOf("LlmProxy");
    const select = selects(card)[0];
    const [button] = useButtons(card);
    const note = button.closest("[data-thinking-suggestion]") as HTMLElement;
    expect(note, "the suggestion is one element").not.toBeNull();
    expect(note.closest("[aria-live], [role=alert], [role=status]")).toBeNull();
    expect(note.className).toMatch(/\btext-xs\b/);
    expect((select.getAttribute("aria-describedby") ?? "").split(" ")).toContain(note.id);
  });
});
