import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

const runtime = vi.hoisted(() => ({ refresh: vi.fn(async () => null) }));
vi.mock("@/autopilot/loader", () => ({ loadAutopilotRuntime: async () => runtime }));
vi.mock("@/drive/useSettings", () => ({
  useSettings: () => ({ load: async () => undefined, save: async () => undefined, resolveOfflineConflict: async () => undefined, syncStatus: "idle", lastSynced: null }),
}));
vi.mock("@/components/ui/use-toast", () => ({ useToast: () => ({ toast: () => undefined }), toast: () => undefined }));

import i18n from "@/i18n";
import "@/i18n/costs";
import { CachePanel } from "@/components/costs/dashboard/CachePanel";
import { useCostsStore } from "@/costs/costsStore";
import { addToLedger, ledgerWriterId, localDay, type UsageDelta } from "@/costs/ledger";
import { emptyCostsFile } from "@/costs/model";
import { usageRows } from "@/costs/legacyCosts";
import { CostsPage } from "@/pages/CostsPage";
import { useSettingsStore } from "@/store/settingsStore";
import { DEFAULT_SETTINGS, type AIIntegration } from "@/types/settings";
import { LANGUAGES, cardOf, showIntegrations, stored, t, type Language } from "./helpers/integrationPage";

// The cache of the prompts, in what a person sees: the model's row in the settings (whether it supports prompt caching, with its cached price and its write price beside it, and what was learned), the
// dashboard of the costs (the share of the input served from a cache, and the money that saved) and the details of a call.

const gateway = (models: Array<Record<string, unknown>>): AIIntegration => ({
  id: "llm", name: "LlmProxy", provider: "openai", endpoint: "https://llm.example.test/v1", apiKey: "k",
  chatModels: models.map((model, index) => ({ id: `m${index}`, capabilities: ["default"], ...model })),
}) as unknown as AIIntegration;

const trigger = (card: HTMLElement, index = 0) => within(card).getAllByRole("combobox", { name: new RegExp(`^${t("settings.promptCaching")}`) })[index];

async function choose(box: HTMLElement, option: string) {
  box.focus();
  fireEvent.keyDown(box, { key: "ArrowDown" });
  const item = await screen.findByRole("option", { name: option });
  fireEvent.keyDown(item, { key: "Enter" });
  await waitFor(() => expect(screen.queryByRole("option")).not.toBeInTheDocument());
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
  Element.prototype.scrollIntoView = scrollIntoView;
  useSettingsStore.setState({ settings: DEFAULT_SETTINGS });
  useCostsStore.setState({ file: emptyCostsFile(), persisted: emptyCostsFile(), dirty: false });
  await i18n.changeLanguage("en");
});

describe.each(LANGUAGES)("the row of a model, in the settings (%s)", (language: Language) => {
  it("says whether the model supports prompt caching, starting from «not known», with the cached price and the write price next to it", async () => {
    await showIntegrations([gateway([{ name: "gpt-5", pricing: { inputPerMTok: 2, cachedPerMTok: 0.2, outputPerMTok: 8 } }, { name: "local-7b" }])], language);
    const card = cardOf("LlmProxy");
    const boxes = within(card).getAllByRole("combobox", { name: new RegExp(`^${t("settings.promptCaching")}`) });
    expect(boxes).toHaveLength(2);
    expect(boxes[0]).toHaveTextContent(t("settings.promptCachingUnknown"));
    expect(card.querySelectorAll("[data-prompt-caching='unknown']")).toHaveLength(2);
    // The prices are in the row of the model, beside the control: the cached one has the value the model was given, and the write one is empty.
    const row = card.querySelector("[data-prompt-caching-row]") as HTMLElement;
    expect(within(row).getByLabelText(t("costs.priceCached", { unit: "USD" }))).toHaveValue(0.2);
    expect(within(row).getByLabelText(t("costs.priceCacheWrite", { unit: "USD" }))).toHaveValue(null);
    expect(within(row).getByRole("combobox")).toBeInTheDocument();
    // And the one-line explanation is the description of the control.
    const hint = document.getElementById(trigger(card).getAttribute("aria-describedby")!)!;
    expect(hint).toHaveTextContent(t("settings.promptCachingHint"));
  });

  it("keeps the author's word: yes, no, and back to «not known», which leaves the setting out of what is saved", async () => {
    await showIntegrations([gateway([{ name: "gpt-5" }])], language);
    await choose(trigger(cardOf("LlmProxy")), t("settings.promptCachingSupported"));
    expect(stored().chatModels![0].promptCaching).toBe("supported");
    expect(cardOf("LlmProxy").querySelector("[data-prompt-caching]")).toHaveAttribute("data-prompt-caching", "supported");
    await choose(trigger(cardOf("LlmProxy")), t("settings.promptCachingUnsupported"));
    expect(stored().chatModels![0].promptCaching).toBe("unsupported");
    await choose(trigger(cardOf("LlmProxy")), t("settings.promptCachingUnknown"));
    expect(stored().chatModels![0].promptCaching).toBeUndefined();
    expect(JSON.parse(JSON.stringify(stored().chatModels![0]))).not.toHaveProperty("promptCaching");
  });

  it("shows what was learned as such, and the author can replace it", async () => {
    await showIntegrations([gateway([{ name: "gpt-5", promptCaching: "learned" }])], language);
    const box = trigger(cardOf("LlmProxy"));
    expect(box).toHaveTextContent(t("settings.promptCachingLearned"));
    expect(cardOf("LlmProxy").querySelector("[data-prompt-caching]")).toHaveAttribute("data-prompt-caching", "learned");
    await choose(box, t("settings.promptCachingUnsupported"));
    expect(stored().chatModels![0].promptCaching).toBe("unsupported");
    // «Learned» is not an option to choose by hand once it is gone.
    const again = trigger(cardOf("LlmProxy"));
    again.focus();
    fireEvent.keyDown(again, { key: "ArrowDown" });
    const names = (await screen.findAllByRole("option")).map((item) => item.textContent);
    expect(names).toEqual([t("settings.promptCachingUnknown"), t("settings.promptCachingSupported"), t("settings.promptCachingUnsupported")]);
  });

  it("shows a model whose provider served tokens from its cache in the ledger as learned, without a setting; what the author said wins over it", async () => {
    const delta = (model: string, cachedTokens: number): UsageDelta => ({ key: { period: localDay(new Date()), bookId: "", source: "autopilot", capability: "autopilot", integrationId: "llm", model, currency: "EUR" }, counters: { calls: 3, tasks: 3, inputTokens: 9000, cachedTokens, outputTokens: 100, cost: 0.01 } });
    const file = { ...emptyCostsFile(), ledger: addToLedger(undefined, ledgerWriterId("device-a", "2026-11-01T00:00:00.000Z"), [delta("gpt-5", 3000), delta("gpt-4o", 0), delta("o3", 3000), delta("another-integration-model", 3000)], new Date(), "EUR") };
    useCostsStore.setState({ file, persisted: file });
    await showIntegrations([gateway([{ name: "gpt-5" }, { name: "gpt-4o" }, { name: "o3", promptCaching: "unsupported" }, { name: "never-used" }])], language);
    const card = cardOf("LlmProxy");
    expect(Array.from(card.querySelectorAll("[data-prompt-caching]")).map((box) => box.getAttribute("data-prompt-caching"))).toEqual(["learned", "unknown", "unsupported", "unknown"]);
    expect(trigger(card, 0)).toHaveTextContent(t("settings.promptCachingLearned"));
    expect(stored().chatModels![0].promptCaching, "nothing is stored for it").toBeUndefined();
  });

  it("sets the cached price and the write price of the model, without losing its other prices; the card of prices keeps the input and the output", async () => {
    await showIntegrations([gateway([{ name: "gpt-5", pricing: { inputPerMTok: 2, outputPerMTok: 8 } }])], language);
    const row = cardOf("LlmProxy").querySelector("[data-prompt-caching-row]") as HTMLElement;
    fireEvent.change(within(row).getByLabelText(t("costs.priceCached", { unit: "USD" })), { target: { value: "0.2" } });
    fireEvent.change(within(row).getByLabelText(t("costs.priceCacheWrite", { unit: "USD" })), { target: { value: "2.5" } });
    expect(stored().chatModels![0].pricing).toEqual({ inputPerMTok: 2, cachedPerMTok: 0.2, cacheWritePerMTok: 2.5, outputPerMTok: 8 });
    fireEvent.change(within(row).getByLabelText(t("costs.priceCached", { unit: "USD" })), { target: { value: "" } });
    expect(stored().chatModels![0].pricing).toMatchObject({ inputPerMTok: 2, cacheWritePerMTok: 2.5, outputPerMTok: 8 });
    expect(stored().chatModels![0].pricing!.cachedPerMTok).toBeUndefined();
    const prices = cardOf("LlmProxy").querySelector("details details") ?? cardOf("LlmProxy");
    expect(within(prices as HTMLElement).getAllByLabelText(new RegExp(`^${t("costs.priceInput", { unit: "USD" }).slice(0, 5)}`)).length).toBeGreaterThan(0);
  });
});

// ─── The dashboard ──────────────────────────────────────────────────────────

const WRITER = ledgerWriterId("device-a", "2026-11-01T00:00:00.000Z");
const today = localDay(new Date());
const ledgerOf = (deltas: UsageDelta[]) => ({ ...emptyCostsFile(), ledger: addToLedger(undefined, WRITER, deltas, new Date(), "EUR") });
const delta = (model: string, source: string, counters: UsageDelta["counters"], currency = "EUR"): UsageDelta => ({ key: { period: today, bookId: "", source, capability: source === "copilot" ? "copilot" : "autopilot", integrationId: "llm", model, currency }, counters });
const words = (node: Element | null) => (node?.textContent ?? "").replace(/\u00a0/g, " ").replace(/\s+/g, " ").trim();

describe.each(LANGUAGES)("the dashboard of the costs (%s)", (language: Language) => {
  beforeEach(async () => {
    await i18n.changeLanguage(language);
    useSettingsStore.setState({ settings: { ...DEFAULT_SETTINGS, costCurrency: "EUR", ui: { ...DEFAULT_SETTINGS.ui, language }, aiIntegrations: [gateway([{ name: "gpt-5" }])] } });
    vi.stubGlobal("matchMedia", (query: string) => ({ matches: query.includes("min-width"), media: query, addEventListener: () => undefined, removeEventListener: () => undefined }));
  });

  it("says the share of the input that was served from a cache and what that saved, in all and for each model and use", () => {
    const file = ledgerOf([
      delta("gpt-5", "autopilot", { calls: 4, tasks: 4, inputTokens: 20_000, cachedTokens: 12_000, outputTokens: 1000, cost: 0.1, cachedSavings: 0.012 }),
      delta("gpt-5", "copilot", { calls: 2, tasks: 2, inputTokens: 4_000, cachedTokens: 0, outputTokens: 300, cost: 0.03 }),
    ]);
    useCostsStore.setState({ file, persisted: file });
    render(<MemoryRouter><CostsPage /></MemoryRouter>);
    const panel = document.querySelector("[data-costs-cache]") as HTMLElement;
    expect(panel).not.toBeNull();
    expect(within(panel).getByRole("heading", { name: t("costs.cache.title") })).toBeInTheDocument();
    const summary = words(panel.querySelector("[data-cache-summary]"));
    expect(summary).toContain(language === "en" ? "50%" : "50%");
    expect(summary).toContain("12K");
    expect(summary).toContain("24K");
    expect(summary).toMatch(/0[.,]01/);
    const lines = Array.from(panel.querySelectorAll("[data-cache-line]"));
    expect(lines).toHaveLength(1);
    expect(words(lines[0])).toContain("gpt-5");
    expect(words(lines[0])).toContain("60%");
    expect(words(lines[0])).toContain(t("costs.source.autopilot"));
    expect(words(lines[0])).toMatch(/0[.,]012/);
  });

  it("says that no call reported tokens from a cache, and where to set the prices, instead of a share of nothing", () => {
    const file = ledgerOf([delta("gpt-5", "autopilot", { calls: 3, tasks: 3, inputTokens: 9_000, cachedTokens: 0, outputTokens: 500, cost: 0.05 })]);
    useCostsStore.setState({ file, persisted: file });
    render(<MemoryRouter><CostsPage /></MemoryRouter>);
    const panel = document.querySelector("[data-costs-cache]") as HTMLElement;
    expect(panel.querySelector("[data-cache-summary]")).toBeNull();
    expect(panel.querySelector("[data-cache-none]")).toHaveTextContent(t("costs.cache.none"));
    expect(within(panel).getByRole("link", { name: t("costs.cache.setPrices") })).toHaveAttribute("href", "/app/settings/ai-integrations");
  });

  it("says that the model has no cached price when the cache served tokens and nothing was priced, and shows nothing at all without input", () => {
    const file = ledgerOf([delta("gpt-5", "autopilot", { calls: 3, tasks: 3, inputTokens: 9_000, cachedTokens: 3_000, outputTokens: 500, cost: 0.05 })]);
    useCostsStore.setState({ file, persisted: file });
    const { unmount } = render(<MemoryRouter><CostsPage /></MemoryRouter>);
    expect(words(document.querySelector("[data-cache-summary]"))).toContain(t("costs.cache.noSaving"));
    unmount();
    const empty = ledgerOf([delta("gpt-image", "media", { calls: 1, tasks: 1, inputTokens: 0, cachedTokens: 0, outputTokens: 0, cost: 0.04 })]);
    useCostsStore.setState({ file: empty, persisted: empty });
    render(<MemoryRouter><CostsPage /></MemoryRouter>);
    expect(document.querySelector("[data-costs-cache]")).toBeNull();
  });

  it("follows the filters: only the rows they keep are counted", () => {
    const file = ledgerOf([
      delta("gpt-5", "autopilot", { calls: 4, tasks: 4, inputTokens: 20_000, cachedTokens: 12_000, outputTokens: 1000, cost: 0.1, cachedSavings: 0.012 }),
      delta("gpt-5", "copilot", { calls: 2, tasks: 2, inputTokens: 4_000, cachedTokens: 0, outputTokens: 300, cost: 0.03 }),
    ]);
    const rows = usageRows(file, "EUR").filter((row) => row.source === "copilot");
    render(<MemoryRouter><CachePanel rows={rows} integrationName={(id) => id} /></MemoryRouter>);
    expect(document.querySelector("[data-cache-summary]")).toBeNull();
    expect(document.querySelector("[data-cache-none]")).not.toBeNull();
  });
});
