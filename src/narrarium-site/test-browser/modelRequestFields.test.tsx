import { cleanup, fireEvent, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@/drive/useSettings", () => ({
  useSettings: () => ({ load: async () => undefined, save: async () => undefined, resolveOfflineConflict: async () => undefined, syncStatus: "idle", lastSynced: null }),
}));
vi.mock("@/components/ui/use-toast", () => ({ useToast: () => ({ toast: () => undefined }), toast: () => undefined }));

import { pickAiRuntimeConfig, redactAiRuntimeConfig } from "narrarium-engine";
import { migrateSettings } from "@/drive/cloudSettingsClient";
import i18n from "@/i18n";
import { DEFAULT_SETTINGS, type AIIntegration } from "@/types/settings";
import { useSettingsStore } from "@/store/settingsStore";
import { LANGUAGES, cardOf, showIntegrations, stored, t, type Language } from "./helpers/integrationPage";

// The API protocol of a model (Chat Completions, or the Responses API) and its address of its own, in its row of the integration card: what is stored is what the author chose and nothing else, the line «Requests go
// to» says what the engine will do, a problem with the address is said in words, and the page offers the Responses API for an address that ends with /responses but never switches a model by itself.

const OWN = "https://oai-gw-002.openai.azure.com/openai/responses?api-version=2025-04-01-preview";
const azure = (extra: Record<string, unknown> = {}, models: Array<Record<string, unknown>> = [{ id: "m1", name: "gpt-5.2" }]) => ({
  id: "az", name: "oai-gw-002", provider: "azure_openai", endpoint: "https://oai-gw-002.openai.azure.com", apiKey: "k", apiVersion: "2024-10-21",
  chatModels: models.map((model) => ({ capabilities: ["default"], ...model })),
  ...extra,
}) as unknown as AIIntegration;
const OPENAI = { id: "oa", name: "LlmProxy", provider: "openai", endpoint: "http://llm.test/v1", apiKey: "k", chatModels: [{ id: "m1", name: "muse-glimmer-30b", capabilities: ["default"] }] } as unknown as AIIntegration;
const GITHUB = { id: "gh", name: "Hub", provider: "github_models", apiKey: "ghp", chatModels: [{ id: "m3", name: "gpt-4.1", capabilities: ["default"] }] } as unknown as AIIntegration;
const M365 = { id: "m365", name: "Office", provider: "m365_copilot", apiKey: "", chatModels: [] } as unknown as AIIntegration;

const modelOf = (index = 0) => stored().chatModels![index];
/** What starts with this text, whatever signs it has (the parentheses of «(optional)» are not a group). */
const startsWith = (text: string) => new RegExp(`^${text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}`);
const protocolSelect = (card: HTMLElement) => within(card).getAllByRole("combobox", { name: startsWith(t("settings.apiProtocol")) });
const addressField = (card: HTMLElement) => within(card).getAllByLabelText(startsWith(t("settings.modelEndpointUrl")), { selector: "input" }) as HTMLInputElement[];
const goesTo = (card: HTMLElement) => Array.from(card.querySelectorAll("[data-model-goes-to]")).map((element) => element.textContent ?? "");

/** Opens a select from the keyboard (the arrow), moves to the option by its name and takes it with Enter. */
async function choose(trigger: HTMLElement, option: string) {
  trigger.focus();
  fireEvent.keyDown(trigger, { key: "ArrowDown" });
  const item = await screen.findByRole("option", { name: option });
  fireEvent.keyDown(item, { key: "Enter" });
  await waitFor(() => expect(screen.queryByRole("option")).not.toBeInTheDocument());
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

describe.each(LANGUAGES)("the API protocol and the address of a model [%s]", (language: Language) => {
  it("are fields of the row of every model of an integration that has models, with the name of the model after the word for a screen reader, and not on Microsoft 365 Copilot", async () => {
    await showIntegrations([azure({}, [{ id: "m1", name: "gpt-5.2" }, { id: "m2", name: "gpt-4.1" }]), OPENAI, GITHUB, M365], language);
    for (const [name, models] of [["oai-gw-002", ["gpt-5.2", "gpt-4.1"]], ["LlmProxy", ["muse-glimmer-30b"]], ["Hub", ["gpt-4.1"]]] as const) {
      const card = cardOf(name);
      expect(protocolSelect(card).map((select) => select.getAttribute("aria-describedby")?.split(" ")[0])).toHaveLength(models.length);
      expect(protocolSelect(card).map((select) => select.getAttribute("id"))).toHaveLength(models.length);
      expect(addressField(card)).toHaveLength(models.length);
      models.forEach((model, index) => {
        expect(protocolSelect(card)[index]).toHaveAccessibleName(`${t("settings.apiProtocol")} — ${model}`);
        expect(addressField(card)[index]).toHaveAccessibleName(`${t("settings.modelEndpointUrl")} — ${model}`);
      });
    }
    expect(cardOf("Office").querySelectorAll("[data-model-request]")).toHaveLength(0);
  });

  it("start as they always were: Chat Completions, no address, and nothing in the settings that says either", async () => {
    await showIntegrations([azure()], language);
    const card = cardOf("oai-gw-002");
    expect(protocolSelect(card)[0]).toHaveTextContent(t("settings.apiProtocolChat"));
    expect(addressField(card)[0]).toHaveValue("");
    expect(addressField(card)[0]).toHaveAttribute("placeholder", t("settings.modelEndpointUrlPlaceholder"));
    expect("apiProtocol" in modelOf()).toBe(false);
    expect("endpointUrl" in modelOf()).toBe(false);
    expect(card.querySelector("[data-model-request]")).toHaveAttribute("data-model-request", "chat-completions");
  });

  it("describe themselves by the paragraph of the card that explains them once, and the field of the address by what is said of it", async () => {
    await showIntegrations([azure()], language);
    const card = cardOf("oai-gw-002");
    expect(protocolSelect(card)[0]).toHaveAccessibleDescription(`${t("settings.modelRequestHint")} ${goesTo(card)[0]}`);
    fireEvent.change(addressField(card)[0], { target: { value: OWN } });
    expect(addressField(card)[0]).toHaveAccessibleDescription(expect.stringContaining(t("settings.modelRequestHint")));
    expect(addressField(card)[0]).toHaveAccessibleDescription(expect.stringContaining(t("settings.modelEndpointUrlVersionsIgnored")));
  });

  it("choosing the Responses API stores it as the one word, and choosing Chat Completions again takes the word out: a key that has no value is not kept", async () => {
    await showIntegrations([azure()], language);
    const card = cardOf("oai-gw-002");
    await choose(protocolSelect(card)[0], t("settings.apiProtocolResponses"));
    expect(modelOf().apiProtocol).toBe("responses");
    expect(protocolSelect(card)[0]).toHaveTextContent(t("settings.apiProtocolResponses"));
    expect(card.querySelector("[data-model-request]")).toHaveAttribute("data-model-request", "responses");
    await choose(protocolSelect(card)[0], t("settings.apiProtocolChat"));
    expect("apiProtocol" in modelOf()).toBe(false);
    expect(modelOf().name).toBe("gpt-5.2");
  });

  it("writing an address stores it with its spaces taken off, as it was written, query included; emptying the field takes it out; the protocol of the model is not touched", async () => {
    await showIntegrations([azure({}, [{ id: "m1", name: "gpt-5.2", apiProtocol: "responses" }])], language);
    const card = cardOf("oai-gw-002");
    fireEvent.change(addressField(card)[0], { target: { value: `  ${OWN} ` } });
    expect(modelOf().endpointUrl).toBe(OWN);
    expect(modelOf().apiProtocol).toBe("responses");
    expect(card.querySelector("[data-model-request]")).toHaveAttribute("data-model-own-address");
    fireEvent.change(addressField(card)[0], { target: { value: "   " } });
    expect("endpointUrl" in modelOf()).toBe(false);
    expect(modelOf().apiProtocol).toBe("responses");
    expect(card.querySelector("[data-model-request]")).not.toHaveAttribute("data-model-own-address");
  });

  it("say where the requests go, by the engine's own rule: the address built from the integration, the version the Responses API is asked with and why, the v1 API, and an address of its own without its query", async () => {
    await showIntegrations([azure({}, [{ id: "m1", name: "gpt-5.2" }, { id: "m2", name: "gpt-6", apiProtocol: "responses" }, { id: "m3", name: "gpt-6-luna", apiProtocol: "responses", apiVersion: "preview" }, { id: "m4", name: "own", apiProtocol: "responses", endpointUrl: `${OWN}&key=SECRET-VALUE-123` }])], language);
    const card = cardOf("oai-gw-002");
    const lines = goesTo(card);
    expect(lines[0]).toBe(`${t("settings.modelRequestsGoTo")} https://oai-gw-002.openai.azure.com/openai/deployments/gpt-5.2/chat/completions?api-version=2024-10-21`);
    expect(lines[1]).toBe(`${t("settings.modelRequestsGoTo")} https://oai-gw-002.openai.azure.com/openai/responses?api-version=2025-04-01-preview${t("settings.modelResponsesVersionNote", { integration: "2024-10-21", version: "2025-04-01-preview" })}`);
    expect(lines[2]).toBe(`${t("settings.modelRequestsGoTo")} https://oai-gw-002.openai.azure.com/openai/responses?api-version=preview`);
    expect(lines[3]).toBe(`${t("settings.modelRequestsGoTo")} oai-gw-002.openai.azure.com/openai/responses`);
    expect(card.textContent, "the line shows the host and the path of the address, never its query").not.toContain("SECRET-VALUE");
  });

  it("follow the integration while the author types: the endpoint of the v1 API has no version, an integration whose version has the Responses API keeps it, and a provider without a Responses API says so", async () => {
    await showIntegrations([azure({ endpoint: "https://oai-gw-002.openai.azure.com/openai/v1/" }, [{ id: "m1", name: "gpt-5.2", apiProtocol: "responses" }]), azure({ id: "az2", name: "newer", apiVersion: "2025-05-01-preview" }, [{ id: "m2", name: "gpt-5.2", apiProtocol: "responses" }]), OPENAI, GITHUB], language);
    expect(goesTo(cardOf("oai-gw-002"))[0]).toBe(`${t("settings.modelRequestsGoTo")} https://oai-gw-002.openai.azure.com/openai/v1/responses`);
    expect(goesTo(cardOf("newer"))[0]).toBe(`${t("settings.modelRequestsGoTo")} https://oai-gw-002.openai.azure.com/openai/responses?api-version=2025-05-01-preview`);
    const proxy = cardOf("LlmProxy");
    expect(goesTo(proxy)[0]).toBe(`${t("settings.modelRequestsGoTo")} http://llm.test/v1/chat/completions`);
    await choose(protocolSelect(proxy)[0], t("settings.apiProtocolResponses"));
    expect(goesTo(proxy)[0]).toBe(`${t("settings.modelRequestsGoTo")} http://llm.test/v1/responses`);
    const hub = cardOf("Hub");
    await choose(protocolSelect(hub)[0], t("settings.apiProtocolResponses"));
    expect(goesTo(hub)[0]).toBe(t("settings.modelNoResponsesApi"));
    fireEvent.change(addressField(hub)[0], { target: { value: "https://proxy.test/inference/responses" } });
    expect(goesTo(hub)[0]).toBe(`${t("settings.modelRequestsGoTo")} proxy.test/inference/responses`);
  });

  it("say in words, and in the field, what is wrong with an address: it is not one, it is not http or https, it carries a user name or a password", async () => {
    await showIntegrations([azure()], language);
    const card = cardOf("oai-gw-002");
    for (const [value, problem] of [["oai-gw-002 openai", "invalid"], ["ftp://x.test/responses", "scheme"], ["https://user:pass@x.test/responses", "credentials"]] as const) {
      fireEvent.change(addressField(card)[0], { target: { value } });
      expect(addressField(card)[0]).toHaveAttribute("aria-invalid", "true");
      const alert = within(card).getAllByRole("alert").find((entry) => entry.getAttribute("data-model-url-problem") === problem);
      expect(alert, problem).toHaveTextContent(t(`settings.modelEndpointUrlProblem.${problem}`));
      expect(addressField(card)[0]).toHaveAccessibleDescription(expect.stringContaining(t(`settings.modelEndpointUrlProblem.${problem}`)));
    }
    fireEvent.change(addressField(card)[0], { target: { value: OWN } });
    expect(addressField(card)[0]).not.toHaveAttribute("aria-invalid");
    expect(card.querySelector("[data-model-url-problem]")).toBeNull();
  });

  it("warn, without refusing, of a key in the query of an address, naming the parameters; no key, no warning", async () => {
    await showIntegrations([azure()], language);
    const card = cardOf("oai-gw-002");
    fireEvent.change(addressField(card)[0], { target: { value: "https://gw.test/openai/responses?api-version=preview&key=abc&code=def&key=ghi" } });
    const warning = card.querySelector("[data-model-url-secret]") as HTMLElement;
    expect(warning).toHaveAttribute("role", "status");
    expect(warning).toHaveTextContent(t("settings.modelEndpointUrlSecret", { names: "key, code" }));
    expect(addressField(card)[0]).not.toHaveAttribute("aria-invalid");
    expect(modelOf().endpointUrl).toBe("https://gw.test/openai/responses?api-version=preview&key=abc&code=def&key=ghi");
    fireEvent.change(addressField(card)[0], { target: { value: OWN } });
    expect(card.querySelector("[data-model-url-secret]")).toBeNull();
  });

  it("say that the API versions are not used while the model has an address of its own: under the address, and under the version of the model", async () => {
    await showIntegrations([azure({}, [{ id: "m1", name: "gpt-5.2", apiVersion: "2025-01-01-preview" }]), OPENAI], language);
    const card = cardOf("oai-gw-002");
    expect(card.querySelector("[data-model-url-versions]")).toBeNull();
    expect(card.querySelector("[data-api-version-ignored]")).toBeNull();
    fireEvent.change(addressField(card)[0], { target: { value: OWN } });
    expect(card.querySelector("[data-model-url-versions]")).toHaveTextContent(t("settings.modelEndpointUrlVersionsIgnored"));
    expect(card.querySelector("[data-api-version-ignored]")).toHaveTextContent(t("settings.modelApiVersionIgnored"));
    const field = card.querySelector<HTMLInputElement>("[data-model-api-version] input")!;
    expect(field).toHaveAccessibleDescription(expect.stringContaining(t("settings.modelApiVersionIgnored")));
    expect(modelOf().apiVersion, "what the author wrote is kept, for when the address is taken out").toBe("2025-01-01-preview");
    // An address that the engine would not use (it is not http) leaves the versions in use, and the fields do not say they are not.
    fireEvent.change(addressField(card)[0], { target: { value: "ftp://gw.test/responses" } });
    expect(card.querySelector("[data-model-url-versions]")).toBeNull();
    expect(card.querySelector("[data-api-version-ignored]")).toBeNull();
    // A provider with no API version has nothing to say about it.
    const proxy = cardOf("LlmProxy");
    fireEvent.change(addressField(proxy)[0], { target: { value: "http://llm.test/v1/responses" } });
    expect(proxy.querySelector("[data-model-url-versions]")).toBeNull();
  });

  it("offers the Responses API for an address that ends with /responses, with a button that names the model, and never switches the model by itself", async () => {
    await showIntegrations([azure({}, [{ id: "m1", name: "gpt-5.2" }, { id: "m2", name: "gpt-4.1", apiProtocol: "responses" }])], language);
    const card = cardOf("oai-gw-002");
    expect(card.querySelector("[data-responses-suggestion]")).toBeNull();
    fireEvent.change(addressField(card)[0], { target: { value: "https://gw.test/v1/chat/completions" } });
    expect(card.querySelector("[data-responses-suggestion]"), "an address of Chat Completions").toBeNull();
    fireEvent.change(addressField(card)[0], { target: { value: OWN } });
    const suggestion = card.querySelector("[data-responses-suggestion]") as HTMLElement;
    expect(suggestion).toHaveTextContent(t("settings.modelResponsesSuggestion"));
    expect(modelOf().apiProtocol, "typing the address did not switch the protocol").toBeUndefined();
    expect(addressField(card)[0]).toHaveAccessibleDescription(expect.stringContaining(t("settings.modelResponsesSuggestion")));
    fireEvent.change(addressField(card)[1], { target: { value: OWN } });
    expect(card.querySelectorAll("[data-responses-suggestion]"), "a model that is on the Responses API is not offered it").toHaveLength(1);
    fireEvent.click(within(suggestion).getByRole("button", { name: t("settings.modelResponsesUseFor", { name: "gpt-5.2" }) }));
    expect(modelOf().apiProtocol).toBe("responses");
    expect(modelOf().endpointUrl, "the address is kept").toBe(OWN);
    expect(card.querySelector("[data-responses-suggestion]")).toBeNull();
    expect(modelOf(1).apiProtocol).toBe("responses");
  });

  it("says on the checkbox of thinking with tools that it is not used while the model is asked through the Responses API, and keeps what was set", async () => {
    await showIntegrations([azure({}, [{ id: "m1", name: "gpt-5.2", noThinkingWithTools: "none" }])], language);
    const card = cardOf("oai-gw-002");
    const box = within(card).getByRole("checkbox", { name: startsWith(t("settings.noThinkingWithTools")) });
    expect(box).toBeChecked();
    expect(card.querySelector("[data-no-thinking-unused]")).toBeNull();
    await choose(protocolSelect(card)[0], t("settings.apiProtocolResponses"));
    expect(card.querySelector("[data-no-thinking-unused]")).not.toBeNull();
    expect(box).toHaveAccessibleDescription(expect.stringContaining(t("settings.noThinkingWithToolsUnused")));
    expect(box).toBeChecked();
    expect(modelOf().noThinkingWithTools, "the setting is kept, for Chat Completions").toBe("none");
    await choose(protocolSelect(card)[0], t("settings.apiProtocolChat"));
    expect(card.querySelector("[data-no-thinking-unused]")).toBeNull();
    // A box that is off has nothing to say, whichever protocol the model has.
    fireEvent.click(box);
    expect(box).not.toBeChecked();
    await choose(protocolSelect(card)[0], t("settings.apiProtocolResponses"));
    expect(card.querySelector("[data-no-thinking-unused]")).toBeNull();
    expect(box).not.toHaveAccessibleDescription(expect.stringContaining(t("settings.noThinkingWithToolsUnused")));
  });
});

describe("what is stored", () => {
  it("keeps the settings of before as they are, and the settings of now through the JSON they are saved as: the protocol and the address of a model come back as they were set", async () => {
    await showIntegrations([azure({}, [{ id: "m1", name: "gpt-5.2" }, { id: "m2", name: "gpt-4.1", apiProtocol: "responses", endpointUrl: OWN }])], "en");
    const saved = JSON.parse(JSON.stringify(useSettingsStore.getState().settings));
    expect("apiProtocol" in saved.aiIntegrations[0].chatModels[0]).toBe(false);
    expect("endpointUrl" in saved.aiIntegrations[0].chatModels[0]).toBe(false);
    expect(saved.aiIntegrations[0].chatModels[1]).toMatchObject({ apiProtocol: "responses", endpointUrl: OWN });
    cleanup();
    await showIntegrations(saved.aiIntegrations, "en");
    const card = cardOf("oai-gw-002");
    expect(protocolSelect(card).map((select) => select.textContent)).toEqual([t("settings.apiProtocolChat"), t("settings.apiProtocolResponses")]);
    expect(addressField(card).map((field) => field.value)).toEqual(["", OWN]);
    expect(screen.queryAllByRole("alert")).toHaveLength(0);
  });

  it("travels to a personal server and back: the settings read again say both, the configuration that is sent carries them, and the safe view of the server says the protocol and the host and path of the address, never its query", async () => {
    const secret = "SUPER-SECRET-QUERY-KEY-987654";
    const own = `https://oai-gw-002.openai.azure.com/openai/responses?api-version=2025-04-01-preview&key=${secret}`;
    await showIntegrations([azure({}, [{ id: "m1", name: "gpt-5.2", apiProtocol: "responses", endpointUrl: own }, { id: "m2", name: "gpt-4.1" }])], "en");
    const wire = JSON.parse(JSON.stringify(useSettingsStore.getState().settings));
    const loaded = migrateSettings(wire);
    expect(loaded.aiIntegrations[0].chatModels?.[0]).toMatchObject({ apiProtocol: "responses", endpointUrl: own });
    const sent = JSON.parse(JSON.stringify(pickAiRuntimeConfig(loaded)));
    expect(sent.aiIntegrations[0].chatModels.map((model: { apiProtocol?: string; endpointUrl?: string }) => [model.apiProtocol, model.endpointUrl])).toEqual([["responses", own], [undefined, undefined]]);
    const safe = redactAiRuntimeConfig(pickAiRuntimeConfig(sent)).integrations[0].models;
    expect(safe.map((model) => [model.apiProtocol, model.endpointUrl])).toEqual([["responses", "oai-gw-002.openai.azure.com/openai/responses"], [undefined, undefined]]);
    expect(JSON.stringify(safe)).not.toContain(secret);
  });
});
