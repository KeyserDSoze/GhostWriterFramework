import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { DEFAULT_IDLE_TIMEOUT_MS, DEFAULT_REQUEST_TIMEOUT_MS, MAX_IDLE_TIMEOUT_MS, MIN_IDLE_TIMEOUT_MS, MIN_REQUEST_TIMEOUT_MS } from "narrarium-engine";

vi.mock("@/drive/useSettings", () => ({
  useSettings: () => ({ load: async () => undefined, save: async () => undefined, resolveOfflineConflict: async () => undefined, syncStatus: "idle", lastSynced: null }),
}));
vi.mock("@/components/ui/use-toast", () => ({ useToast: () => ({ toast: () => undefined }), toast: () => undefined }));

import i18n from "@/i18n";
import { localWorkspaceScope } from "@/account/deviceIdentity";
import { DEFAULT_PROVIDER_TIMEOUT_MS } from "@/assistant/executionLimits";
import { setFallbackAcknowledgementAccountScope } from "@/assistant/fallbackDisclosure";
import { createBrowserAi } from "@/autopilot/browserAi";
import { SettingsPage } from "@/pages/SettingsPage";
import { useLlmDebugStore } from "@/debug/llmDebugStore";
import { useSettingsStore } from "@/store/settingsStore";
import { DEFAULT_SETTINGS, type AIIntegration, type AppSettings } from "@/types/settings";
import { assertProvidersClean, createFakeProvider, failReply, textReply, type ProviderReply } from "./helpers/fakeProvider";
import { compatible, endpointsOf, settingsOf } from "./helpers/aiFixtures";

type Language = "en" | "it";
const LANGUAGES: Language[] = ["en", "it"];
const t = (key: string, options?: Record<string, unknown>) => i18n.t(key, options) as string;
const inLanguage = (language: Language, key: string, options?: Record<string, unknown>) => i18n.t(key, { lng: language, ...options }) as string;
const number = (language: Language, value: number) => new Intl.NumberFormat(language).format(value);

const OPENAI = { id: "oa", name: "Compat", provider: "openai", endpoint: "https://api.example.com/v1", apiKey: "k", chatModels: [{ id: "m2", name: "llama", capabilities: ["default"] }] } as unknown as AIIntegration;
const AZURE = { id: "az", name: "Studio Azure", provider: "azure_openai", endpoint: "https://x.openai.azure.com", apiKey: "k", apiVersion: "2024-10-21", chatModels: [{ id: "m1", name: "gpt-4o", capabilities: ["default"] }] } as unknown as AIIntegration;
const GITHUB = { id: "gh", name: "Hub", provider: "github_models", apiKey: "ghp", chatModels: [{ id: "m3", name: "gpt-4.1", capabilities: ["default"] }] } as unknown as AIIntegration;
const M365 = { id: "m365", name: "Office", provider: "m365_copilot", apiKey: "", chatModels: [] } as unknown as AIIntegration;
const SLOW = { ...OPENAI, id: "slow", name: "Slow lab", requestTimeoutMs: 6000, idleTimeoutMs: 45_000, streamMode: "off" } as AIIntegration;

async function show(patch: Partial<AppSettings> = {}, language: Language = "en") {
  await i18n.changeLanguage(language);
  useSettingsStore.setState({ settings: { ...DEFAULT_SETTINGS, ui: { ...DEFAULT_SETTINGS.ui, language }, ...patch } });
  return render(<MemoryRouter initialEntries={["/app/settings/ai-integrations"]}><SettingsPage /></MemoryRouter>);
}

const cardOf = (name: string) => Array.from(document.querySelectorAll("details > summary p.font-semibold")).find((title) => title.textContent === name)!.closest("details") as HTMLElement;
const controlsOf = (scope: HTMLElement) => {
  const inside = within(scope);
  return {
    timeout: inside.getByLabelText(t("settings.requestTimeoutMs")) as HTMLInputElement,
    idle: inside.getByLabelText(t("settings.idleTimeoutMs")) as HTMLInputElement,
    streaming: inside.getByRole("combobox", { name: t("settings.streamMode") }),
  };
};
const stored = (index = 0) => useSettingsStore.getState().settings.aiIntegrations[index];
const change = (control: HTMLElement, value: string) => fireEvent.change(control, { target: { value } });

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
  // What Radix Select needs to open in jsdom.
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

describe("the texts of the request settings", () => {
  it("calls the select exactly «Streaming» in both languages: the engine's error quotes that name", () => {
    expect(inLanguage("en", "settings.streamMode")).toBe("Streaming");
    expect(inLanguage("it", "settings.streamMode")).toBe("Streaming");
  });

  it("names the options and the idle timeout as the author asked", () => {
    expect(inLanguage("en", "settings.idleTimeoutMs")).toBe("Idle timeout (ms)");
    expect(inLanguage("it", "settings.idleTimeoutMs")).toBe("Inattività massima (ms)");
    expect(inLanguage("en", "settings.streamModeAuto")).toBe("Automatic (recommended)");
    expect(inLanguage("it", "settings.streamModeAuto")).toBe("Automatico (consigliato)");
    expect(inLanguage("en", "settings.streamModeOff")).toBe("Off");
    expect(inLanguage("it", "settings.streamModeOff")).toBe("Spento");
  });
});

describe("the request settings of an AI integration", () => {
  it.each(LANGUAGES)("offers the provider timeout, the idle timeout and Streaming, each with the hint that explains it (%s)", async (language) => {
    await show({ aiIntegrations: [OPENAI] }, language);
    const { timeout, idle, streaming } = controlsOf(cardOf("Compat"));

    const timeoutHint = timeout.getAttribute("aria-describedby");
    expect(timeoutHint, "the provider timeout points at its hint").toBeTruthy();
    const timeoutText = document.getElementById(timeoutHint!)!.textContent!;
    expect(timeoutText).toContain(number(language, MIN_REQUEST_TIMEOUT_MS));
    expect(timeoutText).toContain(number(language, DEFAULT_REQUEST_TIMEOUT_MS));
    expect(timeoutText).toContain(String(DEFAULT_REQUEST_TIMEOUT_MS / 60_000));
    expect(timeoutText).toMatch(language === "en" ? /start answering/i : /cominciare a rispondere/i);
    expect(timeoutText).toMatch(language === "en" ? /raised/i : /portato/i);
    expect(timeoutText).toMatch(language === "en" ? /empty/i : /vuoto/i);

    const idleText = document.getElementById(idle.getAttribute("aria-describedby")!)!.textContent!;
    expect(idleText).toContain(number(language, MIN_IDLE_TIMEOUT_MS));
    expect(idleText).toContain(number(language, MAX_IDLE_TIMEOUT_MS));
    expect(idleText).toContain(number(language, DEFAULT_IDLE_TIMEOUT_MS));
    expect(idleText).toMatch(language === "en" ? /silence between two pieces of a streamed reply/i : /silenzio più lungo.*due (pezzi|parti) di una risposta in streaming/i);

    const streamingText = document.getElementById(streaming.getAttribute("aria-describedby")!)!.textContent!;
    expect(streamingText).toMatch(language === "en" ? /pieces/i : /pezzi/i);
    expect(streamingText).toMatch(language === "en" ? /structured/i : /strutturate/i);
    expect(streamingText).toContain("400");
    expect(streaming).toHaveAccessibleDescription(streamingText);
  });

  it("gives the English hint the figures the engine uses: 30,000 and 600,000 for the provider, 30,000 to 3,600,000 for the silence", async () => {
    await show({ aiIntegrations: [OPENAI] });
    const { timeout, idle } = controlsOf(cardOf("Compat"));
    expect(timeout).toHaveAccessibleDescription(expect.stringContaining("30,000"));
    expect(timeout).toHaveAccessibleDescription(expect.stringContaining("600,000"));
    expect(idle).toHaveAccessibleDescription(expect.stringContaining("30,000"));
    expect(idle).toHaveAccessibleDescription(expect.stringContaining("3,600,000"));
    expect(idle).toHaveAccessibleDescription(expect.stringContaining("600,000"));
  });

  it.each(LANGUAGES)("reads what an integration has: 6000 ms, 45 000 ms and Streaming off (%s)", async (language) => {
    await show({ aiIntegrations: [SLOW, OPENAI] }, language);
    const slow = controlsOf(cardOf("Slow lab"));
    expect(slow.timeout).toHaveValue(6000);
    expect(slow.idle).toHaveValue(45_000);
    expect(slow.streaming).toHaveTextContent(t("settings.streamModeOff"));

    const plain = controlsOf(cardOf("Compat"));
    expect(plain.timeout).toHaveValue(null);
    expect(plain.idle).toHaveValue(null);
    expect(plain.idle).toHaveAttribute("placeholder", String(DEFAULT_IDLE_TIMEOUT_MS));
    expect(plain.streaming).toHaveTextContent(t("settings.streamModeAuto"));
  });

  it("shows Automatic for a saved value that is not off, as the engine reads it", async () => {
    await show({ aiIntegrations: [{ ...OPENAI, streamMode: "auto" } as AIIntegration, { ...OPENAI, id: "odd", name: "Odd", streamMode: "turbo" } as unknown as AIIntegration] });
    expect(controlsOf(cardOf("Compat")).streaming).toHaveTextContent(t("settings.streamModeAuto"));
    expect(controlsOf(cardOf("Odd")).streaming).toHaveTextContent(t("settings.streamModeAuto"));
  });

  it.each(LANGUAGES)("stores Off, and takes the choice back with Automatic, all from the keyboard (%s)", async (language) => {
    await show({ aiIntegrations: [OPENAI] }, language);
    const { streaming } = controlsOf(cardOf("Compat"));

    await choose(streaming, t("settings.streamModeOff"));
    expect(stored().streamMode).toBe("off");
    expect(streaming).toHaveTextContent(t("settings.streamModeOff"));
    expect(document.activeElement, "the focus comes back to the select").toBe(streaming);

    await choose(streaming, t("settings.streamModeAuto"));
    expect(stored().streamMode, "Automatic is the absence of a choice, so settings.json stays as it was").toBeUndefined();
    expect(streaming).toHaveTextContent(t("settings.streamModeAuto"));
  });

  it.each(LANGUAGES)("says in the hint of the idle timeout that it is not used while Streaming is Off, and stops saying it when Streaming is Automatic again (%s)", async (language) => {
    await show({ aiIntegrations: [SLOW, OPENAI] }, language);
    const note = t("settings.idleTimeoutOffNote");
    expect(note, "the note is a text of its own, in this language").not.toBe("settings.idleTimeoutOffNote");
    expect(controlsOf(cardOf("Slow lab")).idle, "an integration that is saved with Streaming off says it from the start").toHaveAccessibleDescription(expect.stringContaining(note));

    const { idle, streaming } = controlsOf(cardOf("Compat"));
    expect(idle).not.toHaveAccessibleDescription(expect.stringContaining(note));
    await choose(streaming, t("settings.streamModeOff"));
    expect(idle).toHaveAccessibleDescription(expect.stringContaining(note));
    expect(idle).toHaveAccessibleDescription(expect.stringContaining(number(language, MAX_IDLE_TIMEOUT_MS)));
    await choose(streaming, t("settings.streamModeAuto"));
    expect(idle).not.toHaveAccessibleDescription(expect.stringContaining(note));
  });

  it("keeps the idle timeout between 30 000 and 3 600 000 as it is typed, and shows the kept value when the field is left", async () => {
    await show({ aiIntegrations: [OPENAI] });
    const { idle } = controlsOf(cardOf("Compat"));
    const cases: Array<[string, number]> = [
      ["5", MIN_IDLE_TIMEOUT_MS],
      ["29999", MIN_IDLE_TIMEOUT_MS],
      ["0", MIN_IDLE_TIMEOUT_MS],
      ["-5", MIN_IDLE_TIMEOUT_MS],
      ["30000", 30_000],
      ["45000", 45_000],
      ["45000.6", 45_001],
      ["3600000", 3_600_000],
      ["3600001", MAX_IDLE_TIMEOUT_MS],
      ["99999999", MAX_IDLE_TIMEOUT_MS],
    ];
    for (const [typed, kept] of cases) {
      idle.focus();
      change(idle, typed);
      expect(stored().idleTimeoutMs, `typing ${typed}`).toBe(kept);
      expect(idle, `typing ${typed}: what the author typed stays under the cursor until the field is left`).toHaveValue(Number(typed));
      fireEvent.blur(idle);
      expect(idle, `leaving the field after ${typed}`).toHaveValue(kept);
    }
  });

  it("lets the author type a long value digit by digit: 4, 45, 450, 4500, 45000 end as 45 000, not as the minimum", async () => {
    await show({ aiIntegrations: [OPENAI] });
    const { idle } = controlsOf(cardOf("Compat"));
    idle.focus();
    for (const typed of ["4", "45", "450", "4500", "45000"]) {
      change(idle, typed);
      expect(idle).toHaveValue(Number(typed));
    }
    expect(stored().idleTimeoutMs).toBe(45_000);
  });

  it("stores nothing for an empty idle timeout: the default applies", async () => {
    await show({ aiIntegrations: [SLOW] });
    const { idle } = controlsOf(cardOf("Slow lab"));
    change(idle, "");
    expect(stored().idleTimeoutMs).toBeUndefined();
    fireEvent.blur(idle);
    expect(idle).toHaveValue(null);
  });

  it("tells the range to a screen reader and a keyboard: the idle field is a number between 30 000 and 3 600 000", async () => {
    await show({ aiIntegrations: [OPENAI] });
    const { idle, timeout } = controlsOf(cardOf("Compat"));
    expect(idle).toHaveAttribute("type", "number");
    expect(idle).toHaveAttribute("min", String(MIN_IDLE_TIMEOUT_MS));
    expect(idle).toHaveAttribute("max", String(MAX_IDLE_TIMEOUT_MS));
    expect(timeout).toHaveAttribute("type", "number");
  });

  it("stores the provider timeout as the author wrote it, a low value included: the engine raises it when it calls, the settings keep it", async () => {
    await show({ aiIntegrations: [OPENAI] });
    const { timeout } = controlsOf(cardOf("Compat"));
    change(timeout, "6000");
    expect(stored().requestTimeoutMs).toBe(6000);
    expect(timeout).toHaveValue(6000);
    change(timeout, "");
    expect(stored().requestTimeoutMs).toBeUndefined();
    change(timeout, "90000.9");
    expect(stored().requestTimeoutMs).toBe(90_000);
  });

  it("keeps the settings of one integration apart from another's", async () => {
    await show({ aiIntegrations: [SLOW, OPENAI] });
    const compat = controlsOf(cardOf("Compat"));
    change(compat.idle, "120000");
    await choose(compat.streaming, t("settings.streamModeOff"));
    expect(stored(1)).toMatchObject({ id: "oa", idleTimeoutMs: 120_000, streamMode: "off" });
    expect(stored(0)).toMatchObject({ id: "slow", requestTimeoutMs: 6000, idleTimeoutMs: 45_000, streamMode: "off" });
    change(controlsOf(cardOf("Slow lab")).idle, "");
    expect(stored(0).idleTimeoutMs).toBeUndefined();
    expect(stored(1).idleTimeoutMs).toBe(120_000);
  });

  it("is offered for Azure OpenAI, OpenAI-compatible and GitHub Models, and not for Microsoft 365 Copilot", async () => {
    await show({ aiIntegrations: [AZURE, OPENAI, GITHUB, M365] });
    for (const name of ["Studio Azure", "Compat", "Hub"]) expect(() => controlsOf(cardOf(name)), name).not.toThrow();
    const office = within(cardOf("Office"));
    expect(office.queryByLabelText(t("settings.requestTimeoutMs"))).not.toBeInTheDocument();
    expect(office.queryByLabelText(t("settings.idleTimeoutMs"))).not.toBeInTheDocument();
    expect(office.queryByRole("combobox", { name: t("settings.streamMode") })).not.toBeInTheDocument();
    expect(office.queryByText(t("settings.streamModeOff"))).not.toBeInTheDocument();
  });

  it("goes away when the provider becomes Microsoft 365 Copilot in the add form, and comes back with the other providers", async () => {
    await show();
    expect(controlsOf(document.body).streaming).toBeInTheDocument();
    await choose(screen.getByRole("combobox", { name: t("settings.provider") }), t("settings.providers.m365_copilot"));
    expect(screen.queryByLabelText(t("settings.idleTimeoutMs"))).not.toBeInTheDocument();
    expect(screen.queryByLabelText(t("settings.requestTimeoutMs"))).not.toBeInTheDocument();
    expect(screen.queryByRole("combobox", { name: t("settings.streamMode") })).not.toBeInTheDocument();
    await choose(screen.getByRole("combobox", { name: t("settings.provider") }), t("settings.providers.openai"));
    expect(controlsOf(document.body).idle).toBeInTheDocument();
  });

  it.each(LANGUAGES)("keeps what the add form was given when the integration is added, and starts the next form clean (%s)", async (language) => {
    await show({}, language);
    change(screen.getByLabelText(t("settings.integrationName")), "Local lab");
    const form = controlsOf(document.body);
    change(form.timeout, "90000");
    change(form.idle, "120000");
    await choose(form.streaming, t("settings.streamModeOff"));
    fireEvent.click(screen.getByRole("button", { name: t("settings.addIntegration") }));

    expect(useSettingsStore.getState().settings.aiIntegrations).toHaveLength(1);
    expect(stored()).toMatchObject({ name: "Local lab", requestTimeoutMs: 90_000, idleTimeoutMs: 120_000, streamMode: "off" });

    const fresh = within(document.querySelector("div.border-dashed") as HTMLElement);
    expect(fresh.getByLabelText(t("settings.idleTimeoutMs"))).toHaveValue(null);
    expect(fresh.getByLabelText(t("settings.requestTimeoutMs"))).toHaveValue(null);
    expect(fresh.getByRole("combobox", { name: t("settings.streamMode") })).toHaveTextContent(t("settings.streamModeAuto"));
  });

  it.each(LANGUAGES)("labels every control once, ties every hint to it, and repeats no id across the cards (%s)", async (language) => {
    await show({ aiIntegrations: [AZURE, OPENAI, GITHUB, M365] }, language);
    const cards = [cardOf("Studio Azure"), cardOf("Compat"), cardOf("Hub"), document.querySelector("div.border-dashed") as HTMLElement];
    for (const card of cards) {
      card.querySelectorAll("details").forEach((details) => { details.open = true; });
      const { timeout, idle, streaming } = controlsOf(card);
      for (const control of [timeout, idle, streaming]) {
        expect((control as HTMLInputElement).labels, "exactly one label").toHaveLength(1);
        const hint = document.getElementById(control.getAttribute("aria-describedby") ?? "");
        expect(hint, "a hint that exists").not.toBeNull();
        expect(hint!.textContent!.trim().length).toBeGreaterThan(20);
        expect(hint!.className).toMatch(/\btext-xs\b/);
        expect(hint!.className).toMatch(/\btext-muted-foreground\b/);
      }
    }
    const ids = Array.from(document.querySelectorAll("[id]")).map((element) => element.id);
    expect(ids.filter((id, index) => ids.indexOf(id) !== index), "duplicate ids").toEqual([]);
    expect(new Set(cards.flatMap((card) => Object.values(controlsOf(card)).map((control) => control.id))).size, "three controls in each of four cards").toBe(12);
  });

  it.each(LANGUAGES)("says what the other AI features do with the provider timeout: they count it as the whole request, 60 000 ms when it is empty (%s)", async (language) => {
    await show({ aiIntegrations: [OPENAI] }, language);
    const { timeout } = controlsOf(cardOf("Compat"));
    expect(DEFAULT_PROVIDER_TIMEOUT_MS).toBe(60_000);
    expect(timeout).toHaveAccessibleDescription(expect.stringContaining(number(language, DEFAULT_PROVIDER_TIMEOUT_MS)));
    expect(timeout).toHaveAccessibleDescription(language === "en" ? /Copilot, voice, images/ : /Copilot, voce, immagini/);
  });
});

describe("a provider that refuses streamed replies: the safety valve", () => {
  const ASK = { capability: "autopilot", label: "autopilot:scene", system: "SYS", user: "USR" };

  beforeEach(() => {
    localStorage.clear();
    useLlmDebugStore.setState({ entries: [], pending: 0, storageError: null, accountIdentity: null });
    setFallbackAcknowledgementAccountScope(localWorkspaceScope());
  });
  afterEach(() => {
    setFallbackAcknowledgementAccountScope(null);
    assertProvidersClean();
  });

  it.each(LANGUAGES)("the error names the setting, the setting is in the card under that name, and with it off the next call goes through (%s)", async (language) => {
    const fixture = compatible("lab", undefined, {});
    const refuse: ProviderReply = (call) => (call.body.stream ? failReply(400, "stream_options is not supported by this proxy") : textReply("A scene, whole."));
    const fake = createFakeProvider(endpointsOf([fixture]), refuse);
    vi.stubGlobal("fetch", fake.fetch);
    await show({ ...settingsOf([fixture]), aiIntegrations: [fixture.integration] }, language);

    const refused = await createBrowserAi().complete(ASK).then(() => undefined, (error: Error) => error);
    expect(refused?.message).toMatch(/If this provider cannot stream its replies, set "Streaming" of the integration "LAB" to "off"/);
    const [, setting, integrationName] = /set "([^"]+)" of the integration "([^"]+)" to "off"/.exec(refused!.message)!;

    const card = within(cardOf(integrationName));
    const select = card.getByRole("combobox", { name: setting });
    expect(select, "the page calls the control by the name the error quotes").toHaveTextContent(t("settings.streamModeAuto"));
    await choose(select, t("settings.streamModeOff"));
    expect(stored().streamMode).toBe("off");

    const answer = await createBrowserAi().complete(ASK);
    expect(answer.text).toBe("A scene, whole.");
    expect(fake.calls).toHaveLength(2);
    const [first, second] = fake.calls;
    expect(first.body.stream).toBe(true);
    expect(second.body).not.toHaveProperty("stream");
    expect(second.body).not.toHaveProperty("stream_options");
    expect(second.headers.accept).toBe("application/json");
  });
});
