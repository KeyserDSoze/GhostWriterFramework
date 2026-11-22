import { cleanup, fireEvent, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { AiCatalogError, type AiCatalogErrorReason } from "narrarium-engine";

vi.mock("@/drive/useSettings", () => ({
  useSettings: () => ({ load: async () => undefined, save: async () => undefined, resolveOfflineConflict: async () => undefined, syncStatus: "idle", lastSynced: null }),
}));
const toast = vi.hoisted(() => vi.fn());
vi.mock("@/components/ui/use-toast", () => ({ useToast: () => ({ toast }), toast }));
const hooks = vi.hoisted(() => ({ readCatalog: null as null | ((...args: unknown[]) => Promise<unknown>) }));
vi.mock("@/ai/endpointTools", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/ai/endpointTools")>();
  return { ...actual, readCatalog: (...args: Parameters<typeof actual.readCatalog>) => (hooks.readCatalog ? hooks.readCatalog(...args) : actual.readCatalog(...args)) };
});

import i18n from "@/i18n";
import { useSettingsStore } from "@/store/settingsStore";
import { DEFAULT_SETTINGS, type ChatModel } from "@/types/settings";
import { chatModel, compatible } from "./helpers/aiFixtures";
import { assertProvidersClean } from "./helpers/fakeProvider";
import { OWNER_IDS, detail, gateway, pathsAsked, type GatewayBehavior } from "./helpers/llmProxyFakes";
import { LANGUAGES, cardOf, draftBox, showIntegrations, stored, t, type Language } from "./helpers/integrationPage";
import { chooseOption, polyfillRadix } from "./helpers/radix";

const TEMPLATE = "chat_template_kwargs.reasoning_strength";
const fixture = compatible("gw", [chatModel("existing")], { name: "LlmProxy" });
const KEY = fixture.integration.apiKey;
const BASE = fixture.endpoint.base;
const bare = compatible("bare", [], { name: "Fresh" });

function serve(behavior: GatewayBehavior = {}, which = fixture) {
  const provider = gateway(which, behavior);
  vi.stubGlobal("fetch", provider.fetch);
  return provider;
}

const readButton = (name = "LlmProxy") => within(cardOf(name)).getByRole("button", { name: t("endpoint.readNamed", { name }) });

/** Opens the dialog from the keyboard's point of view: the button has the focus when it is pressed. */
async function open(name = "LlmProxy"): Promise<HTMLElement> {
  const button = readButton(name);
  button.focus();
  fireEvent.click(button);
  return screen.findByRole("dialog");
}

const stateOf = (dialog: HTMLElement) => dialog.getAttribute("data-catalog-state");
async function ready(dialog: HTMLElement) {
  await waitFor(() => expect(stateOf(dialog)).toBe("ready"));
  return dialog;
}
const rowOf = (dialog: HTMLElement, id: string) => dialog.querySelector<HTMLElement>(`[data-model="${id}"]`)!;
const boxOf = (dialog: HTMLElement, id: string) => within(rowOf(dialog, id)).getByRole("checkbox", { name: new RegExp(`^${id}`) }) as HTMLInputElement;
const groupsOf = (dialog: HTMLElement) => within(dialog).getAllByRole("group").filter((group) => group.tagName === "FIELDSET");
const idsIn = (group: HTMLElement) => Array.from(group.querySelectorAll("[data-model]")).map((row) => row.getAttribute("data-model"));
const apply = (dialog: HTMLElement, count: number) => within(dialog).getByRole("button", { name: t("catalog.apply", { count }) });
const closed = () => waitFor(() => expect(screen.queryByRole("dialog")).not.toBeInTheDocument());
const list = (words: string[]) => (words.length < 2 ? words.join("") : t("catalog.list.and", { list: words.slice(0, -1).join(", "), last: words[words.length - 1] }));
const number = (language: Language, value: number) => new Intl.NumberFormat(language).format(value);

vi.setConfig({ testTimeout: 60_000 });
beforeAll(async () => {
  polyfillRadix();
  await i18n.changeLanguage("en");
});
afterEach(async () => {
  cleanup();
  hooks.readCatalog = null;
  vi.unstubAllGlobals();
  toast.mockReset();
  useSettingsStore.setState({ settings: DEFAULT_SETTINGS });
  await i18n.changeLanguage("en");
  assertProvidersClean();
});

describe("opening the dialog", () => {
  it("reads nothing until the author asks, and then reads the list first and what the gateway declares and offers after it, with the key in the header", async () => {
    const gw = serve();
    await showIntegrations([fixture.integration]);
    await new Promise((resolve) => setTimeout(resolve, 30));
    expect(gw.calls, "the page does not ask by itself").toEqual([]);
    const dialog = await ready(await open());
    expect(pathsAsked(gw, fixture)[0]).toBe("/models");
    expect(pathsAsked(gw, fixture).sort()).toEqual(["/modalities", "/models", "/models/details"]);
    for (const call of gw.calls) expect(call.headers.authorization).toBe(`Bearer ${KEY}`);
    expect(dialog).toHaveAccessibleName(t("catalog.title", { name: "LlmProxy" }));
    expect(dialog).toHaveAccessibleDescription(t("catalog.description"));
  });

  it.each(LANGUAGES)("says that it is reading while it waits, and Cancel stops the reading, closes the dialog, changes nothing and gives the focus back to the button (%s)", async (language) => {
    const gw = serve({ hang: true });
    await showIntegrations([fixture.integration], language);
    const button = readButton();
    const dialog = await open();
    await waitFor(() => expect(stateOf(dialog)).toBe("loading"));
    expect(within(dialog).getByRole("status")).toHaveTextContent(t("catalog.loading"));
    await waitFor(() => expect(gw.calls).toHaveLength(1));
    expect(within(dialog).queryByRole("button", { name: t("catalog.apply", { count: 0 }) })).not.toBeInTheDocument();
    fireEvent.click(within(dialog).getByRole("button", { name: t("catalog.cancel") }));
    await closed();
    expect(gw.calls[0].signal?.aborted).toBe(true);
    await waitFor(() => expect(button, "the focus goes back to the button that opened the dialog").toHaveFocus());
    expect(stored().chatModels!.map((model) => model.name)).toEqual(["existing"]);
    expect(toast).not.toHaveBeenCalled();
  });

  it("is stopped by Escape in the same way, and a dialog that is closed does not go on reading", async () => {
    const gw = serve({ hang: true });
    await showIntegrations([fixture.integration]);
    const dialog = await open();
    await waitFor(() => expect(gw.calls).toHaveLength(1));
    fireEvent.keyDown(dialog, { key: "Escape" });
    await closed();
    expect(gw.calls[0].signal?.aborted).toBe(true);
    await new Promise((resolve) => setTimeout(resolve, 30));
    expect(gw.calls, "nothing was asked after it was closed").toHaveLength(1);
  });

  it("reads again, and from nothing, every time it is opened: what was chosen the last time is not kept", async () => {
    const gw = serve();
    await showIntegrations([fixture.integration]);
    let dialog = await ready(await open());
    fireEvent.click(boxOf(dialog, "legacy-8b"));
    fireEvent.click(within(dialog).getByRole("button", { name: t("catalog.cancel") }));
    await closed();
    dialog = await ready(await open());
    expect(boxOf(dialog, "legacy-8b").checked).toBe(true);
    expect(pathsAsked(gw, fixture).filter((path) => path === "/models")).toHaveLength(2);
  });
});

describe("the models of the endpoint", () => {
  it.each(LANGUAGES)("are listed by kind, in a fixed order, each kind with the number of its models, and a kind with none is left out (%s)", async (language) => {
    serve();
    await showIntegrations([fixture.integration], language);
    const dialog = await ready(await open());
    const groups = groupsOf(dialog);
    const names = ["text", "image", "speech", "transcription", "embedding"].map((kind) => t(`catalog.group.${kind}`));
    expect(groups.map((group) => group.querySelector("legend")!.textContent)).toEqual([2, 1, 1, 1, 1].map((count, index) => `${names[index]} (${count})`));
    expect(groups.map(idsIn)).toEqual([["legacy-8b", "muse-glimmer-30b"], ["flux-schnell"], ["kokoro"], ["whisper-large"], ["bge-m3"]]);
    if (language === "en") expect(names).toEqual(["Text", "Images", "Text-to-speech", "Transcription", "Embedding"]);
    else expect(names).toEqual(["Testo", "Immagini", "Sintesi vocale", "Trascrizione", "Embedding"]);
    expect(within(dialog).queryByText(t("catalog.group.other"), { exact: false, selector: "legend" })).not.toBeInTheDocument();
    for (const group of groups) expect(group, "each group has a name").toHaveAccessibleName();
  });

  it.each(LANGUAGES)("say where they were read from, in the status line of the dialog (%s)", async (language) => {
    serve();
    await showIntegrations([fixture.integration], language);
    const dialog = await ready(await open());
    expect(within(dialog).getByRole("status")).toHaveTextContent(t("catalog.source.read", { paths: list(["/models", "/models/details", "/modalities"]) }));
    expect(within(dialog).getByRole("status")).not.toHaveTextContent(t("catalog.loading"));
  });

  it("say only /models when the gateway has nothing else, and that the limits and the capabilities are not declared, and tick none: nothing says which of them chat", async () => {
    serve({ details: null, modalities: null });
    await showIntegrations([fixture.integration]);
    const dialog = await ready(await open());
    expect(within(dialog).getByRole("status")).toHaveTextContent(t("catalog.source.only"));
    expect(t("catalog.source.only")).toBe("Only /models: limits and capabilities are not declared.");
    expect(groupsOf(dialog)).toHaveLength(1);
    expect(idsIn(groupsOf(dialog)[0])).toEqual([...OWNER_IDS].sort());
    for (const id of OWNER_IDS) expect(boxOf(dialog, id).checked, id).toBe(false);
    expect(within(dialog).getByText(t("catalog.noKinds"))).toBeInTheDocument();
    expect(within(rowOf(dialog, "muse-glimmer-30b")).getByText(t("catalog.notDeclared"))).toBeInTheDocument();
    expect(within(dialog).getByRole("button", { name: t("catalog.apply", { count: 0 }) })).toBeDisabled();
    fireEvent.click(boxOf(dialog, "bge-m3"));
    expect(apply(dialog, 1)).toBeEnabled();
  });

  it("say that the limits are not declared when the gateway tells what it offers and not what each model can do", async () => {
    serve({ details: null });
    await showIntegrations([fixture.integration]);
    const dialog = await ready(await open());
    expect(within(dialog).getByRole("status")).toHaveTextContent(t("catalog.source.noLimits", { paths: list(["/models", "/modalities"]) }));
  });

  it.each(LANGUAGES)("show for each one its window, its largest answer and what it can do, in words with an icon that a screen reader does not read, and what is not declared as not declared (%s)", async (language) => {
    serve();
    await showIntegrations([fixture.integration], language);
    const dialog = await ready(await open());
    const muse = rowOf(dialog, "muse-glimmer-30b");
    expect(muse).toHaveTextContent(t("catalog.limits.window", { value: number(language, 131072) }));
    expect(muse).toHaveTextContent(t("catalog.limits.output", { value: number(language, 8192) }));
    const capabilities = within(muse).getByRole("list", { name: t("catalog.capabilities") });
    expect(Array.from(capabilities.querySelectorAll("li")).map((item) => item.textContent?.trim())).toEqual(["tools", "streaming", "reasoning", "vision"].map((key) => t(`catalog.capability.${key}`)));
    expect(capabilities.querySelectorAll("svg[aria-hidden='true']")).toHaveLength(4);
    const legacy = rowOf(dialog, "legacy-8b");
    expect(legacy).toHaveTextContent(t("catalog.notDeclared"));
    expect(within(legacy).queryByRole("list", { name: t("catalog.capabilities") })).not.toBeInTheDocument();
    expect(rowOf(dialog, "bge-m3")).toHaveTextContent(t("catalog.limits.window", { value: number(language, 8192) }));
    expect(t("catalog.capability.reasoning")).toBe(language === "en" ? "Reasoning" : "Ragionamento");
  });

  it.each(LANGUAGES)("say which of them the integration already has, and which are new (%s)", async (language) => {
    const have = compatible("gw", [chatModel("muse-glimmer-30b")], { name: "LlmProxy" });
    serve({}, have);
    await showIntegrations([have.integration], language);
    const dialog = await ready(await open());
    expect(rowOf(dialog, "muse-glimmer-30b")).toHaveTextContent(t("catalog.badge.existing"));
    expect(rowOf(dialog, "legacy-8b")).toHaveTextContent(t("catalog.badge.new"));
    expect(rowOf(dialog, "muse-glimmer-30b")).not.toHaveTextContent(t("catalog.badge.new"));
  });

  it("have a checkbox each that is named after the model, and a description with what the dialog knows of it", async () => {
    serve();
    await showIntegrations([fixture.integration]);
    const dialog = await ready(await open());
    const box = boxOf(dialog, "muse-glimmer-30b");
    expect(box).toHaveAccessibleName("muse-glimmer-30b");
    expect(box).toHaveAccessibleDescription(expect.stringContaining("131,072"));
    const ids = Array.from(dialog.querySelectorAll("[id]")).map((element) => element.id);
    expect(ids.filter((id, index) => ids.indexOf(id) !== index), "duplicate ids").toEqual([]);
    const unnamed = Array.from(dialog.querySelectorAll<HTMLInputElement>("input")).filter((input) => !input.labels?.length && !input.getAttribute("aria-labelledby") && !input.getAttribute("aria-label"));
    expect(unnamed).toEqual([]);
  });
});

describe("what is ticked, and what happens when the author confirms", () => {
  it("ticks the text models the integration does not have, and no other: the existing ones, the models of another kind and the ones that are only listed stay as they are", async () => {
    const have = compatible("gw", [chatModel("muse-glimmer-30b")], { name: "LlmProxy" });
    serve({}, have);
    await showIntegrations([have.integration]);
    const dialog = await ready(await open());
    expect(boxOf(dialog, "legacy-8b").checked).toBe(true);
    expect(boxOf(dialog, "muse-glimmer-30b").checked).toBe(false);
    for (const id of ["flux-schnell", "kokoro", "whisper-large"]) expect(boxOf(dialog, id).checked, id).toBe(false);
    expect(within(rowOf(dialog, "bge-m3")).queryByRole("checkbox")).not.toBeInTheDocument();
    expect(rowOf(dialog, "bge-m3")).toHaveTextContent(t("catalog.informational"));
  });

  it.each(LANGUAGES)("adds the ticked models with what the gateway declares of them and nothing it does not, closes the dialog and says what it did (%s)", async (language) => {
    serve();
    await showIntegrations([fixture.integration], language);
    const dialog = await ready(await open());
    const button = apply(dialog, 2);
    expect(button).toHaveTextContent(language === "en" ? "Add/update 2 models" : "Aggiungi/aggiorna 2 modelli");
    fireEvent.click(button);
    await closed();
    const models = stored().chatModels!;
    expect(models.map((model) => model.name)).toEqual(["existing", "legacy-8b", "muse-glimmer-30b"]);
    expect(models[0]).toEqual(chatModel("existing"));
    expect(models[1]).toEqual({ id: expect.any(String), name: "legacy-8b", capabilities: [] });
    expect(models[2]).toEqual({
      id: expect.any(String), name: "muse-glimmer-30b", capabilities: [], maxInputTokens: 131072, maxOutputTokens: 8192,
      supportsToolCalls: true, supportsStreaming: true, supportsReasoning: true, supportsVision: true, reasoningParameter: TEMPLATE,
    });
    expect(new Set(models.map((model) => model.id)).size).toBe(3);
    expect(toast).toHaveBeenCalledTimes(1);
    expect(JSON.stringify(toast.mock.calls)).toContain(t("catalog.done.added", { count: 2 }));
    expect(JSON.stringify(toast.mock.calls)).not.toContain(KEY);
    expect(within(cardOf("LlmProxy")).getByDisplayValue("muse-glimmer-30b")).toBeInTheDocument();
    const { chatModels: _kept, ...rest } = stored();
    const { chatModels: _before, ...before } = fixture.integration;
    expect(rest, "nothing else of the integration was touched (the page itself empties the API version of an OpenAI-compatible one when it saves)").toEqual({ ...before, apiVersion: "" });
  });

  it("gives the default roles to the model of an integration that has none, the one that declares tool calls first, and says so before the author confirms", async () => {
    const empty = bare;
    serve({}, empty);
    await showIntegrations([empty.integration]);
    const dialog = await ready(await open("Fresh"));
    expect(within(dialog).getByText(t("catalog.defaulted", { name: "muse-glimmer-30b" }))).toBeInTheDocument();
    fireEvent.click(apply(dialog, 2));
    await closed();
    const [first, second] = stored().chatModels!;
    expect([first.name, first.capabilities]).toEqual(["legacy-8b", []]);
    expect([second.name, second.capabilities]).toEqual(["muse-glimmer-30b", ["default", "copilot", "simple-tasks", "review"]]);
  });

  it("does not say it for an integration that has models: the roles the author gave are not touched", async () => {
    serve();
    await showIntegrations([fixture.integration]);
    const dialog = await ready(await open());
    expect(within(dialog).queryByText(/default roles|ruoli predefiniti/)).not.toBeInTheDocument();
    expect(dialog.querySelector("[data-catalog-defaulted]")).toBeNull();
  });

  it("does nothing, and keeps the button off, when nothing is ticked", async () => {
    serve();
    await showIntegrations([fixture.integration]);
    const dialog = await ready(await open());
    fireEvent.click(boxOf(dialog, "legacy-8b"));
    fireEvent.click(boxOf(dialog, "muse-glimmer-30b"));
    const button = apply(dialog, 0);
    expect(button).toBeDisabled();
    fireEvent.click(button);
    expect(screen.getByRole("dialog")).toBeInTheDocument();
    expect(stored().chatModels).toHaveLength(1);
  });

  it("counts the models and not the ticks of other kinds, and says «apply» when only those are ticked", async () => {
    serve();
    await showIntegrations([fixture.integration]);
    const dialog = await ready(await open());
    fireEvent.click(boxOf(dialog, "legacy-8b"));
    fireEvent.click(boxOf(dialog, "muse-glimmer-30b"));
    fireEvent.click(boxOf(dialog, "flux-schnell"));
    const only = within(dialog).getByRole("button", { name: t("catalog.applyChoices") });
    expect(only).toBeEnabled();
    fireEvent.click(boxOf(dialog, "kokoro"));
    fireEvent.click(boxOf(dialog, "legacy-8b"));
    expect(apply(dialog, 1)).toBeEnabled();
  });
});

describe("the thinking parameter that is suggested", () => {
  it.each(LANGUAGES)("is ticked for the new model whose name the engine knows, with the explanation the card gives, and only for that one (%s)", async (language) => {
    serve();
    await showIntegrations([fixture.integration], language);
    const dialog = await ready(await open());
    const suggestion = within(rowOf(dialog, "muse-glimmer-30b")).getByRole("checkbox", { name: t("catalog.thinking.use", { name: "muse-glimmer-30b", value: TEMPLATE }) }) as HTMLInputElement;
    expect(suggestion.checked).toBe(true);
    expect(suggestion).toHaveAccessibleDescription(expect.stringContaining(t("settings.thinkingParameterSuggestion", { value: TEMPLATE })));
    expect(within(rowOf(dialog, "legacy-8b")).queryByRole("checkbox", { name: /chat_template_kwargs/ })).not.toBeInTheDocument();
  });

  it("is left out of the model when the author unticks it before confirming, and the model is added all the same", async () => {
    serve();
    await showIntegrations([fixture.integration]);
    const dialog = await ready(await open());
    fireEvent.click(within(rowOf(dialog, "muse-glimmer-30b")).getByRole("checkbox", { name: t("catalog.thinking.use", { name: "muse-glimmer-30b", value: TEMPLATE }) }));
    fireEvent.click(apply(dialog, 2));
    await closed();
    const added = stored().chatModels!.find((model) => model.name === "muse-glimmer-30b")!;
    expect(added).toMatchObject({ supportsReasoning: true, maxInputTokens: 131072 });
    expect(added).not.toHaveProperty("reasoningParameter");
  });

  it("is not offered for a model the integration has, and does not change its parameter: it is the author's word", async () => {
    const mine = compatible("gw", [chatModel("muse-glimmer-30b", { reasoningParameter: "none" })], { name: "LlmProxy" });
    serve({}, mine);
    await showIntegrations([mine.integration]);
    const dialog = await ready(await open());
    expect(within(rowOf(dialog, "muse-glimmer-30b")).queryByRole("checkbox", { name: /chat_template_kwargs/ })).not.toBeInTheDocument();
    fireEvent.click(boxOf(dialog, "muse-glimmer-30b"));
    fireEvent.click(apply(dialog, 2));
    await closed();
    expect(stored().chatModels![0].reasoningParameter).toBe("none");
  });
});

describe("updating a model the integration already has", () => {
  const written = (extra: Partial<ChatModel> = {}) => chatModel("muse-glimmer-30b", { capabilities: ["review"], maxInputTokens: 32768, supportsToolCalls: false, underlyingModel: "mine", tier: "high", ...extra });

  it.each(LANGUAGES)("says what it would fill in and that what the author wrote is kept, and is not ticked by itself (%s)", async (language) => {
    const mine = compatible("gw", [written()], { name: "LlmProxy" });
    serve({}, mine);
    await showIntegrations([mine.integration], language);
    const dialog = await ready(await open());
    const row = rowOf(dialog, "muse-glimmer-30b");
    expect(boxOf(dialog, "muse-glimmer-30b").checked).toBe(false);
    const fields = ["maxOutputTokens", "supportsStreaming", "supportsReasoning", "supportsVision"].map((key) => t(`catalog.field.${key}`));
    expect(row).toHaveTextContent(t("catalog.fills", { fields: list(fields) }));
    expect(row).toHaveTextContent(t("catalog.kept"));
    for (const word of [t("catalog.field.maxInputTokens"), t("catalog.field.supportsToolCalls")]) expect(row.querySelector("[data-catalog-fills]")!.textContent, "a number or a switch the author set is not in the list").not.toContain(word);
  });

  it("fills only the empty fields and the capabilities that are declared, and keeps every other word of the author: the numbers, the switch turned off, the roles, the names, the price and the thinking parameter", async () => {
    const mine = compatible("gw", [written({ reasoningParameter: "none" })], { name: "LlmProxy" });
    serve({}, mine);
    await showIntegrations([mine.integration]);
    const dialog = await ready(await open());
    fireEvent.click(boxOf(dialog, "muse-glimmer-30b"));
    fireEvent.click(boxOf(dialog, "legacy-8b"));
    fireEvent.click(apply(dialog, 1));
    await closed();
    expect(stored().chatModels).toEqual([{ ...written({ reasoningParameter: "none" }), maxOutputTokens: 8192, supportsStreaming: true, supportsReasoning: true, supportsVision: true }]);
    expect(JSON.stringify(toast.mock.calls)).toContain(t("catalog.done.updated", { count: 1 }));
  });

  it("is told, and cannot be ticked, when the endpoint has nothing to add to a model", async () => {
    const mine = compatible("gw", [chatModel("legacy-8b")], { name: "LlmProxy" });
    serve({}, mine);
    await showIntegrations([mine.integration]);
    const dialog = await ready(await open());
    expect(boxOf(dialog, "legacy-8b")).toBeDisabled();
    expect(rowOf(dialog, "legacy-8b")).toHaveTextContent(t("catalog.nothingToAdd"));
    expect(boxOf(dialog, "legacy-8b").checked).toBe(false);
  });

  it("takes a name that differs by a letter for another model, and adds it beside the author's", async () => {
    const mine = compatible("gw", [chatModel("Muse-Glimmer-30B")], { name: "LlmProxy" });
    serve({}, mine);
    await showIntegrations([mine.integration]);
    const dialog = await ready(await open());
    expect(rowOf(dialog, "muse-glimmer-30b")).toHaveTextContent(t("catalog.badge.new"));
    fireEvent.click(apply(dialog, 2));
    await closed();
    expect(stored().chatModels!.map((model) => model.name)).toEqual(["Muse-Glimmer-30B", "legacy-8b", "muse-glimmer-30b"]);
  });
});

describe("the models that are not for chat", () => {
  it.each(LANGUAGES)("can be set as the image, speech or transcription model of the integration when that field is empty, one for each, and are not ticked by themselves (%s)", async (language) => {
    serve();
    await showIntegrations([fixture.integration], language);
    const dialog = await ready(await open());
    for (const [id, kind] of [["flux-schnell", "image"], ["kokoro", "speech"], ["whisper-large", "transcription"]] as const) {
      const box = within(rowOf(dialog, id)).getByRole("checkbox", { name: `${id} ${t(`catalog.media.${kind}`)}` }) as HTMLInputElement;
      expect(box.checked, id).toBe(false);
      fireEvent.click(box);
      expect(box.checked).toBe(true);
    }
    fireEvent.click(boxOf(dialog, "legacy-8b"));
    fireEvent.click(boxOf(dialog, "muse-glimmer-30b"));
    fireEvent.click(within(dialog).getByRole("button", { name: t("catalog.applyChoices") }));
    await closed();
    expect(stored()).toMatchObject({ modelImageGeneration: "flux-schnell", modelTextToSpeech: "kokoro", modelSpeechToText: "whisper-large" });
    expect(stored().chatModels).toHaveLength(1);
    expect(JSON.stringify(toast.mock.calls)).toContain(t("catalog.done.media", { count: 3 }));
  });

  it("never replace what the author wrote: a field that has a model says so, and offers nothing", async () => {
    const mine = compatible("gw", [chatModel("existing")], { name: "LlmProxy", modelImageGeneration: "gpt-image-1", modelTextToSpeech: "   " });
    serve({}, mine);
    await showIntegrations([mine.integration]);
    const dialog = await ready(await open());
    expect(within(rowOf(dialog, "flux-schnell")).queryByRole("checkbox")).not.toBeInTheDocument();
    expect(rowOf(dialog, "flux-schnell")).toHaveTextContent(t("catalog.media.taken.image", { model: "gpt-image-1" }));
    expect(within(rowOf(dialog, "kokoro")).getByRole("checkbox")).toBeInTheDocument();
  });

  it("choose one model for a kind, not two: ticking a second one for the same field unticks the first", async () => {
    const two = [detail("flux-schnell", "image"), detail("flux-dev", "image")];
    serve({ models: { object: "list", data: two.map(({ id }) => ({ id })) }, details: { object: "list", data: two }, modalities: null });
    await showIntegrations([fixture.integration]);
    const dialog = await ready(await open());
    const first = within(rowOf(dialog, "flux-schnell")).getByRole("checkbox") as HTMLInputElement;
    const second = within(rowOf(dialog, "flux-dev")).getByRole("checkbox") as HTMLInputElement;
    fireEvent.click(first);
    fireEvent.click(second);
    expect([first.checked, second.checked]).toEqual([false, true]);
    fireEvent.click(second);
    expect([first.checked, second.checked], "ticking again clears it").toEqual([false, false]);
  });
});

describe("when the models cannot be read", () => {
  const WHY: Array<[GatewayBehavior, AiCatalogErrorReason]> = [
    [{ status: 401 }, "unauthorized"], [{ status: 404 }, "not-found"], [{ status: 429 }, "rate-limited"], [{ status: 503 }, "server-error"], [{ unreachable: true }, "unreachable"],
    [{ models: { data: "no" } }, "invalid"], [{ models: { data: [] } }, "empty"],
  ];
  const reasonText = (reason: string) => t(`catalog.error.${reason}`, { why: t("endpoint.why") });

  it.each(LANGUAGES)("says why in words of the page, and keeps the words of the engine for the details, in English whatever the language (%s)", async (language) => {
    await showIntegrations([fixture.integration], language);
    for (const [behavior, reason] of WHY) {
      const gw = serve(behavior);
      const dialog = await open();
      await waitFor(() => expect(stateOf(dialog), reason).toBe("error"));
      const alert = within(dialog).getByRole("alert");
      expect(alert, reason).toHaveTextContent(t("catalog.error.title"));
      expect(alert, reason).toHaveTextContent(reasonText(reason));
      const details = dialog.querySelector<HTMLElement>("[data-catalog-details]")!;
      expect(within(details).getByText(t("endpoint.details"))).toBeInTheDocument();
      expect(details.querySelector("p")).toHaveAttribute("lang", "en");
      expect(details.textContent).toMatch(/LlmProxy/);
      expect(dialog.textContent).not.toContain(KEY);
      expect(dialog.textContent).not.toContain("gw.example.test");
      expect(gw.calls, "the companions are not asked when the list fails").toHaveLength(1);
      fireEvent.click(within(dialog).getByRole("button", { name: t("catalog.close") }));
      await closed();
    }
  });

  it.each(LANGUAGES)("has a translated reason for every reason the engine gives, and the same words for «unreachable» that the check gives: the browser cannot tell the server off from CORS (%s)", async (language) => {
    await showIntegrations([fixture.integration], language);
    const reasons: AiCatalogErrorReason[] = ["unreachable", "timeout", "unauthorized", "not-found", "rate-limited", "server-error", "http-error", "invalid", "empty", "too-large", "unsupported"];
    for (const reason of reasons) {
      hooks.readCatalog = async () => { throw new AiCatalogError(`The engine says: ${reason}.`, reason, reason === "unauthorized" ? 403 : undefined); };
      const dialog = await open();
      await waitFor(() => expect(stateOf(dialog), reason).toBe("error"));
      expect(within(dialog).getByRole("alert"), reason).toHaveTextContent(reasonText(reason));
      expect(i18n.exists(`catalog.error.${reason}`, { lng: language }), reason).toBe(true);
      expect(dialog.querySelector("[data-catalog-details] p")!.textContent).toBe(`The engine says: ${reason}.`);
      fireEvent.click(within(dialog).getByRole("button", { name: t("catalog.close") }));
      await closed();
    }
    expect(t("catalog.error.unreachable", { why: t("endpoint.why") })).toMatch(language === "en" ? /browser could not reach.*CORS/ : /browser non ha potuto raggiungere.*CORS/);
  });

  it("is told in general terms, with the engine's words in the details, when the failure is not one the engine knows", async () => {
    await showIntegrations([fixture.integration]);
    hooks.readCatalog = async () => { throw new Error("Something odd happened."); };
    const dialog = await open();
    await waitFor(() => expect(stateOf(dialog)).toBe("error"));
    expect(within(dialog).getByRole("alert")).toHaveTextContent(t("catalog.error.unknown"));
    expect(dialog.querySelector("[data-catalog-details] p")!.textContent).toBe("Something odd happened.");
  });

  it("reads again when the author asks, and shows the list once it works", async () => {
    const behavior: GatewayBehavior = { status: 503 };
    const gw = serve(behavior);
    await showIntegrations([fixture.integration]);
    const dialog = await open();
    await waitFor(() => expect(stateOf(dialog)).toBe("error"));
    behavior.status = undefined;
    fireEvent.click(within(dialog).getByRole("button", { name: t("catalog.retry") }));
    await waitFor(() => expect(stateOf(dialog)).toBe("ready"));
    expect(idsIn(groupsOf(dialog)[0])).toEqual(["legacy-8b", "muse-glimmer-30b"]);
    expect(pathsAsked(gw, fixture).filter((path) => path === "/models")).toHaveLength(2);
    expect(within(dialog).queryByRole("alert")).not.toBeInTheDocument();
  });

  it("can be closed by Escape, and changes nothing", async () => {
    serve({ status: 401 });
    await showIntegrations([fixture.integration]);
    const dialog = await open();
    await waitFor(() => expect(stateOf(dialog)).toBe("error"));
    fireEvent.keyDown(dialog, { key: "Escape" });
    await closed();
    expect(stored().chatModels).toHaveLength(1);
  });
});

describe("the box of the integration that is being added", () => {
  it("reads the models for what the author has typed and adds them to the models of the box, which is not saved until the author adds the integration", async () => {
    const gw = serve();
    await showIntegrations([]);
    const box = draftBox();
    chooseOption(within(box).getByRole("combobox", { name: t("settings.provider") }), t("settings.providers.openai"));
    fireEvent.change(within(box).getByLabelText(t("settings.integrationName")), { target: { value: "Draft" } });
    fireEvent.change(within(box).getByLabelText(t("settings.endpoint")), { target: { value: BASE } });
    fireEvent.change(within(box).getByLabelText(t("settings.apiKey")), { target: { value: KEY } });
    const button = within(box).getByRole("button", { name: t("endpoint.readNamed", { name: "Draft" }) });
    button.focus();
    fireEvent.click(button);
    const dialog = await ready(await screen.findByRole("dialog"));
    expect(gw.calls[0].headers.authorization).toBe(`Bearer ${KEY}`);
    fireEvent.click(apply(dialog, 2));
    await closed();
    expect(within(box).getByDisplayValue("legacy-8b")).toBeInTheDocument();
    expect(within(box).getByDisplayValue("muse-glimmer-30b")).toBeInTheDocument();
    expect(useSettingsStore.getState().settings.aiIntegrations).toEqual([]);
  });
});
