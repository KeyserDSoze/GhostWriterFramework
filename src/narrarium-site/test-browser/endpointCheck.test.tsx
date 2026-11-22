import { cleanup, fireEvent, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";

vi.mock("@/drive/useSettings", () => ({
  useSettings: () => ({ load: async () => undefined, save: async () => undefined, resolveOfflineConflict: async () => undefined, syncStatus: "idle", lastSynced: null }),
}));
const toast = vi.hoisted(() => vi.fn());
vi.mock("@/components/ui/use-toast", () => ({ useToast: () => ({ toast }), toast }));

import i18n from "@/i18n";
import { useSettingsStore } from "@/store/settingsStore";
import { DEFAULT_SETTINGS } from "@/types/settings";
import { chatModel, compatible } from "./helpers/aiFixtures";
import { assertProvidersClean } from "./helpers/fakeProvider";
import { gateway, type GatewayBehavior } from "./helpers/llmProxyFakes";
import { AZURE, GITHUB, LANGUAGES, M365, cardOf, draftBox, showIntegrations, t, type Language } from "./helpers/integrationPage";
import { chooseOption, polyfillRadix } from "./helpers/radix";

const fixture = compatible("gw", [chatModel("existing")], { name: "LlmProxy" });
const KEY = fixture.integration.apiKey;
const BASE = fixture.endpoint.base;

/** The remedy the page gives to a status, by the key of its text: the same ones, in the same words, that the dialog and the panel of the autopilot use. */
const REMEDY: Array<[number, string]> = [[401, "key"], [403, "forbidden"], [404, "address"], [429, "wait"], [500, "busy"], [503, "busy"], [418, "other"]];

const checkButton = (card: HTMLElement, name = "LlmProxy") => within(card).getByRole("button", { name: t("endpoint.checkNamed", { name }) });
const statusOf = (card: HTMLElement) => within(card).getByRole("status");
const detailsOf = (card: HTMLElement) => card.querySelector<HTMLDetailsElement>("[data-endpoint-details]");

/** A fake gateway for the fixture that every `fetch` of the page goes to. */
function serve(behavior: GatewayBehavior = {}) {
  const provider = gateway(fixture, behavior);
  vi.stubGlobal("fetch", provider.fetch);
  return provider;
}

async function check(card: HTMLElement, name = "LlmProxy") {
  const button = checkButton(card, name);
  button.focus();
  fireEvent.click(button);
  return button;
}

vi.setConfig({ testTimeout: 30_000 });
beforeAll(async () => {
  polyfillRadix();
  await i18n.changeLanguage("en");
});
afterEach(async () => {
  cleanup();
  vi.useRealTimers();
  vi.unstubAllGlobals();
  toast.mockReset();
  useSettingsStore.setState({ settings: DEFAULT_SETTINGS });
  await i18n.changeLanguage("en");
  assertProvidersClean();
});

describe("the buttons of the card", () => {
  it.each(LANGUAGES)("are on the card of an OpenAI-compatible integration and on no other: Azure OpenAI, GitHub Models and Microsoft 365 have no list to ask (%s)", async (language) => {
    await showIntegrations([fixture.integration, AZURE, GITHUB, M365], language);
    for (const key of ["checkNamed", "readNamed"]) {
      expect(within(cardOf("LlmProxy")).getByRole("button", { name: t(`endpoint.${key}`, { name: "LlmProxy" }) })).toBeInTheDocument();
      for (const name of ["Studio Azure", "Hub", "Office"]) expect(within(cardOf(name)).queryByRole("button", { name: t(`endpoint.${key}`, { name }) }), `${key} on ${name}`).not.toBeInTheDocument();
    }
    expect(document.querySelectorAll("[data-endpoint-status]")).toHaveLength(1);
  });

  it.each(LANGUAGES)("say what they do in the words of the design, and name the integration they act on, starting with the words on them (%s)", async (language) => {
    await showIntegrations([fixture.integration, compatible("other", [], { name: "Local server" }).integration], language);
    const words = { check: language === "en" ? "Check the connection" : "Verifica la connessione", read: language === "en" ? "Read the models from the endpoint" : "Leggi i modelli dall'endpoint" };
    for (const name of ["LlmProxy", "Local server"]) {
      const card = cardOf(name);
      const buttons = [[checkButton(card, name), words.check], [within(card).getByRole("button", { name: t("endpoint.readNamed", { name }) }), words.read]] as const;
      for (const [button, visible] of buttons) {
        expect(button.textContent?.trim()).toBe(visible);
        expect(button.getAttribute("aria-label")!.startsWith(visible), "the name begins with the words on the button").toBe(true);
        expect(button.getAttribute("aria-label")).toContain(name);
      }
    }
    const names = Array.from(document.querySelectorAll("[data-endpoint-tools] button")).map((button) => button.getAttribute("aria-label"));
    expect(new Set(names).size, "no two buttons have the same name").toBe(names.length);
  });

  it("may wrap their words: a button is not allowed to widen the card, and «Read the models from the endpoint» is longer than the width of a phone's card (the old button of the models wraps for the same reason)", async () => {
    await showIntegrations([fixture.integration]);
    const card = cardOf("LlmProxy");
    for (const button of [checkButton(card), within(card).getByRole("button", { name: t("endpoint.readNamed", { name: "LlmProxy" }) })]) {
      expect(button.className, button.textContent ?? "").toMatch(/\bwhitespace-normal\b/);
      expect(button.className).not.toMatch(/whitespace-nowrap/);
      expect(button.className).toMatch(/\bh-auto\b/);
    }
  });

  it("are on the box of the integration that is being added once its provider is OpenAI-compatible, and not before", async () => {
    await showIntegrations([]);
    const box = draftBox();
    expect(within(box).queryByRole("button", { name: /^Check the connection/ })).not.toBeInTheDocument();
    chooseOption(within(box).getByRole("combobox", { name: t("settings.provider") }), t("settings.providers.openai"));
    expect(within(box).getByRole("button", { name: /^Check the connection/ })).toBeInTheDocument();
    expect(within(box).getByRole("button", { name: /^Read the models from the endpoint/ })).toBeInTheDocument();
  });

  it("leave a card alone in every other way: the models and the old way of listing them are where they were", async () => {
    await showIntegrations([fixture.integration]);
    const card = cardOf("LlmProxy");
    expect(within(card).getByRole("button", { name: t("settings.loadApiModels") })).toBeInTheDocument();
    expect(within(card).getByDisplayValue("existing")).toBeInTheDocument();
  });
});

describe("checking the connection", () => {
  it("has its status line from the start, empty, and only one: a line that appears with the result is not always read out", async () => {
    await showIntegrations([fixture.integration]);
    const status = statusOf(cardOf("LlmProxy"));
    expect(status).toBeEmptyDOMElement();
    expect(status).toHaveAttribute("data-state", "idle");
    expect(within(cardOf("LlmProxy")).getAllByRole("status")).toHaveLength(1);
  });

  it.each([["en", "Responds in 120 ms · 6 models"], ["it", "Risponde in 120 ms · 6 modelli"]] as const)("says how fast the endpoint answered and how many models it lists, once, in a status line (%s)", async (language, expected) => {
    vi.useFakeTimers({ toFake: ["Date"] });
    const gw = serve({ elapse: 120 });
    await showIntegrations([fixture.integration], language);
    const card = cardOf("LlmProxy");
    const button = await check(card);
    await waitFor(() => expect(statusOf(card)).toHaveTextContent(expected));
    expect(statusOf(card)).toHaveAttribute("data-state", "ok");
    expect(statusOf(card).textContent?.trim()).toBe(expected);
    expect(detailsOf(card), "nothing to explain when it works").toBeNull();
    expect(gw.calls.map((call) => call.url)).toEqual([`${BASE}/models`]);
    expect(gw.calls[0].headers.authorization).toBe(`Bearer ${KEY}`);
    expect(button, "the focus stays on the button").toHaveFocus();
    expect(toast, "nothing is said outside the line").not.toHaveBeenCalled();
  });

  it("says «1 model» for one, and what it can of an endpoint that lists none or that is not an API at all: it did answer", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    await showIntegrations([fixture.integration]);
    const card = cardOf("LlmProxy");
    const cases: Array<[GatewayBehavior, string]> = [
      [{ models: { data: [{ id: "only" }] }, elapse: 7 }, t("endpoint.result.ok", { ms: 7, count: 1 })],
      [{ models: { data: [] }, elapse: 7 }, t("endpoint.result.okEmpty", { ms: 7 })],
      [{ models: { html: "<p>a page</p>" }, elapse: 7 }, t("endpoint.result.okNoList", { ms: 7 })],
    ];
    for (const [behavior, expected] of cases) {
      serve(behavior);
      await check(card);
      await waitFor(() => expect(statusOf(card).textContent?.trim()).toBe(expected));
    }
    expect(t("endpoint.result.ok", { ms: 7, count: 1 })).toBe("Responds in 7 ms · 1 model");
  });

  it.each(LANGUAGES)("says the status the endpoint answered with and what to do about it, and keeps the words of the engine for the details (%s)", async (language) => {
    await showIntegrations([fixture.integration], language);
    const card = cardOf("LlmProxy");
    for (const [status, remedy] of REMEDY) {
      const gw = serve({ status });
      await check(card);
      const expected = t("endpoint.result.error", { status, remedy: t(`endpoint.remedy.${remedy}`) });
      await waitFor(() => expect(statusOf(card).textContent?.trim(), String(status)).toBe(expected));
      expect(statusOf(card)).toHaveAttribute("data-state", "error");
      const details = detailsOf(card)!;
      expect(within(details).getByText(t("endpoint.checkDetails"))).toBeInTheDocument();
      expect(details.querySelector("p")).toHaveAttribute("lang", "en");
      expect(details.textContent).toContain(`HTTP ${status}`);
      expect(gw.calls).toHaveLength(1);
    }
    serve({ status: 401 });
    await check(card);
    await waitFor(() => expect(statusOf(card)).toHaveTextContent(language === "en" ? "Responds with error 401: check the key" : "Risponde con errore 401: controlla la chiave"));
  });

  it.each(LANGUAGES)("says that it could not be reached, and that a browser cannot tell why: the server is off, the address is wrong, or CORS does not allow this site (%s)", async (language) => {
    serve({ unreachable: true });
    await showIntegrations([fixture.integration], language);
    const card = cardOf("LlmProxy");
    await check(card);
    await waitFor(() => expect(statusOf(card)).toHaveAttribute("data-state", "error"));
    expect(statusOf(card).textContent?.trim()).toBe(t("endpoint.result.unreachable", { why: t("endpoint.why") }));
    expect(statusOf(card)).toHaveTextContent(language === "en" ? /Not reachable: .*CORS/ : /Non raggiungibile: .*CORS/);
    expect(detailsOf(card)!.querySelector("p")).toHaveAttribute("lang", "en");
    expect(detailsOf(card)!.textContent).toMatch(/Could not reach "LlmProxy"/);
  });

  it("says that it is checking while it waits, keeps the button where the keyboard left it, and does not ask twice", async () => {
    const gw = serve({ hang: true });
    await showIntegrations([fixture.integration]);
    const card = cardOf("LlmProxy");
    const button = await check(card);
    await waitFor(() => expect(statusOf(card)).toHaveAttribute("data-state", "checking"));
    expect(statusOf(card).textContent?.trim()).toBe(t("endpoint.checking"));
    expect(button, "it is not disabled, which would send the focus away").not.toBeDisabled();
    expect(button).toHaveAttribute("aria-disabled", "true");
    expect(button).toHaveFocus();
    fireEvent.click(button);
    fireEvent.click(button);
    await new Promise((resolve) => setTimeout(resolve, 30));
    expect(gw.calls).toHaveLength(1);
  });

  it("stops asking when the card goes away: the request is cancelled and nothing is left waiting", async () => {
    const gw = serve({ hang: true });
    const view = await showIntegrations([fixture.integration]);
    await check(cardOf("LlmProxy"));
    await waitFor(() => expect(gw.calls).toHaveLength(1));
    view.unmount();
    expect(gw.calls[0].signal?.aborted).toBe(true);
  });

  it("forgets what it found when the address, the key or the kind of integration change: the result was about something else, and a check on its way is cancelled", async () => {
    const gw = serve();
    await showIntegrations([fixture.integration]);
    const card = cardOf("LlmProxy");
    await check(card);
    await waitFor(() => expect(statusOf(card)).toHaveAttribute("data-state", "ok"));

    fireEvent.change(within(card).getByLabelText(t("settings.endpoint")), { target: { value: `${BASE}/` } });
    await waitFor(() => expect(statusOf(card)).toHaveAttribute("data-state", "idle"));
    expect(statusOf(card)).toBeEmptyDOMElement();

    await check(card);
    await waitFor(() => expect(statusOf(card)).toHaveAttribute("data-state", "ok"));
    fireEvent.change(within(card).getByLabelText(t("settings.apiKey")), { target: { value: `${KEY}x` } });
    await waitFor(() => expect(statusOf(card)).toHaveAttribute("data-state", "idle"));
    expect(gw.calls.length).toBeGreaterThanOrEqual(2);
  });

  it("is cancelled when what it asks about changes while it waits, and says nothing about the old address afterwards", async () => {
    const hanging = serve({ hang: true });
    await showIntegrations([fixture.integration]);
    const card = cardOf("LlmProxy");
    await check(card);
    await waitFor(() => expect(hanging.calls).toHaveLength(1));
    fireEvent.change(within(card).getByLabelText(t("settings.endpoint")), { target: { value: "https://elsewhere.example.test/v1" } });
    await waitFor(() => expect(statusOf(card)).toHaveAttribute("data-state", "idle"));
    expect(hanging.calls[0].signal?.aborted).toBe(true);
  });

  it("asks again when it is pressed again, and the new answer replaces the old one", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    await showIntegrations([fixture.integration]);
    const card = cardOf("LlmProxy");
    serve({ elapse: 10 });
    await check(card);
    await waitFor(() => expect(statusOf(card)).toHaveTextContent("Responds in 10 ms"));
    serve({ status: 503 });
    await check(card);
    await waitFor(() => expect(statusOf(card)).toHaveTextContent("Responds with error 503"));
    expect(statusOf(card)).not.toHaveTextContent("Responds in 10 ms");
  });

  it("asks what the author has typed, and not what was saved: the box of the integration that is being added checks its own address and key", async () => {
    const gw = serve();
    await showIntegrations([]);
    const box = draftBox();
    chooseOption(within(box).getByRole("combobox", { name: t("settings.provider") }), t("settings.providers.openai"));
    fireEvent.change(within(box).getByLabelText(t("settings.integrationName")), { target: { value: "Draft" } });
    fireEvent.change(within(box).getByLabelText(t("settings.endpoint")), { target: { value: BASE } });
    fireEvent.change(within(box).getByLabelText(t("settings.apiKey")), { target: { value: KEY } });
    fireEvent.click(within(box).getByRole("button", { name: t("endpoint.checkNamed", { name: "Draft" }) }));
    await waitFor(() => expect(within(box).getByRole("status")).toHaveAttribute("data-state", "ok"));
    expect(gw.calls[0].url).toBe(`${BASE}/models`);
    expect(gw.calls[0].headers.authorization).toBe(`Bearer ${KEY}`);
    expect(useSettingsStore.getState().settings.aiIntegrations, "checking does not add the integration").toEqual([]);
  });

  it.each(LANGUAGES)("never shows the key, and the key goes only in the header of the request to the integration it belongs to, whatever the answer (%s)", async (language) => {
    await showIntegrations([fixture.integration], language);
    const card = cardOf("LlmProxy");
    for (const behavior of [{}, { status: 401 }, { status: 404 }, { unreachable: true }] as GatewayBehavior[]) {
      serve(behavior);
      await check(card);
      await waitFor(() => expect(statusOf(card)).not.toBeEmptyDOMElement());
      await waitFor(() => expect(statusOf(card)).not.toHaveAttribute("data-state", "checking"));
      for (const text of [card.querySelector("[data-endpoint-tools]")!.textContent!, ...(toast.mock.calls.map((call) => JSON.stringify(call)))]) {
        expect(text).not.toContain(KEY);
        expect(text).not.toContain("gw.example.test");
      }
    }
  });
});
