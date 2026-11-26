import { act, cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@/drive/useSettings", () => ({
  useSettings: () => ({ load: async () => undefined, save: async () => undefined, resolveOfflineConflict: async () => undefined, syncStatus: "idle", lastSynced: null }),
}));
vi.mock("@/components/ui/use-toast", () => ({ useToast: () => ({ toast: () => undefined }), toast: () => undefined }));

import i18n from "@/i18n";
import "@/i18n/costs";
import { CostRatesEditor } from "@/components/settings/CostRatesEditor";
import { EstimatedMoney, estimatePhrase } from "@/components/costs/MoneyText";
import { moneyContextOf } from "@/costs/useMoney";
import { formatAmount, formatTotals } from "@/costs/money";
import { chooseOption, polyfillRadix } from "./helpers/radix";
import { useCostsStore } from "@/costs/costsStore";
import { addToLedger, ledgerWriterId, localDay, type UsageDelta } from "@/costs/ledger";
import { addToLegacy, coveredPart } from "@/costs/legacyCosts";
import { emptyBucket, emptyCostsFile, type CostsFile } from "@/costs/model";
import { CostsPage } from "@/pages/CostsPage";
import { SettingsPage } from "@/pages/SettingsPage";
import { useSettingsStore } from "@/store/settingsStore";
import { DEFAULT_SETTINGS, type AIIntegration, type CostExchangeRate } from "@/types/settings";

const WRITER = ledgerWriterId("device-a", "2026-11-01T00:00:00.000Z");
const today = localDay(new Date());

function costs(): CostsFile {
  const deltas: UsageDelta[] = [
    { key: { period: today, bookId: "book-1", source: "autopilot", capability: "autopilot", integrationId: "int-1", model: "gpt-5", currency: "EUR" }, counters: { calls: 4, tasks: 2, inputTokens: 4000, outputTokens: 900, cost: 0.12 } },
    { key: { period: today, bookId: "book-1", source: "copilot", capability: "copilot", integrationId: "int-1", model: "gpt-5", currency: "USD" }, counters: { calls: 1, tasks: 1, inputTokens: 500, outputTokens: 80, cost: 0.16 } },
    { key: { period: today, bookId: "book-1", source: "autopilot", capability: "director", integrationId: "int-2", model: "free-model", currency: "" }, counters: { calls: 3, tasks: 0, inputTokens: 900, unpricedCalls: 3 } },
    { key: { period: "2026-01", bookId: "book-2", source: "research", capability: "deep-research", integrationId: "int-1", model: "gpt-5", currency: "EUR" }, counters: { calls: 2, tasks: 1, cost: 1 } },
  ];
  let file: CostsFile = { ...emptyCostsFile(), books: { "book-1": { ...emptyBucket(), bookId: "book-1", bookName: "The Glass Harbor", chatCost: 2 } } };
  for (const delta of deltas) {
    file = { ...file, ledger: addToLedger(file.ledger, WRITER, [delta], new Date(), "EUR") };
    file = addToLegacy(file, delta.key.bookId, undefined, coveredPart({ ...delta.key, ...delta.counters }));
  }
  return file;
}

function setSettings(costCurrency: string, costRates?: CostExchangeRate[]) {
  useSettingsStore.setState({ settings: { ...DEFAULT_SETTINGS, costCurrency, ...(costRates ? { costRates } : {}), books: [{ id: "book-1", name: "The Glass Harbor", owner: "", repo: "", storageMode: "local-only", tokenIndex: null, addedAt: "2026-01-01T00:00:00.000Z" } as never] } });
}

beforeEach(async () => {
  await i18n.changeLanguage("en");
  const file = costs();
  useCostsStore.setState({ file, persisted: file });
  setSettings("EUR");
});

afterEach(() => cleanup());

const renderCosts = () => render(<MemoryRouter><CostsPage /></MemoryRouter>);
const bookCard = (name: string) => screen.getByRole("heading", { name }).closest("[aria-labelledby]") as HTMLElement;

describe("the exchange rates in Settings", () => {
  it("adds a rate towards the currency of the settings and removes it, with every field named", () => {
    const onChange = vi.fn();
    const { rerender } = render(<CostRatesEditor currency="EUR" rates={undefined} onChange={onChange} />);
    const add = screen.getByRole("button", { name: "Add rate" });
    expect(add).toBeDisabled();
    fireEvent.change(screen.getByLabelText("Currency"), { target: { value: "usd" } });
    fireEvent.change(screen.getByLabelText("EUR for 1 USD"), { target: { value: "0,92" } });
    fireEvent.click(add);
    expect(onChange).toHaveBeenLastCalledWith([{ from: "USD", to: "EUR", rate: 0.92 }]);
    rerender(<CostRatesEditor currency="EUR" rates={[{ from: "USD", to: "EUR", rate: 0.92 }]} onChange={onChange} />);
    expect(screen.getByText("1 USD = 0.92 EUR")).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Remove the rate for USD" }));
    expect(onChange).toHaveBeenLastCalledWith(undefined);
  });

  it("refuses a rate of the currency to itself, and replaces the rate of a pair given either way round", () => {
    const onChange = vi.fn();
    render(<CostRatesEditor currency="EUR" rates={[{ from: "EUR", to: "USD", rate: 1.1 }]} onChange={onChange} />);
    fireEvent.change(screen.getByLabelText("Currency"), { target: { value: "EUR" } });
    fireEvent.change(screen.getByLabelText("EUR for 1 EUR"), { target: { value: "1" } });
    expect(screen.getByRole("button", { name: "Add rate" })).toBeDisabled();
    fireEvent.change(screen.getByLabelText("Currency"), { target: { value: "USD" } });
    fireEvent.change(screen.getByLabelText("EUR for 1 USD"), { target: { value: "0.9" } });
    fireEvent.click(screen.getByRole("button", { name: "Add rate" }));
    expect(onChange).toHaveBeenLastCalledWith([{ from: "USD", to: "EUR", rate: 0.9 }]);
  });
});

describe("the prices in Settings are in the currency of the settings", () => {
  const AZURE = { id: "az", name: "Studio Azure", provider: "azure_openai", endpoint: "https://x.openai.azure.com", apiKey: "k", apiVersion: "2024-10-21", chatModels: [{ id: "m1", name: "gpt-4o", capabilities: ["default"] }] } as unknown as AIIntegration;

  it("names the unit of every price after the setting, and changes it the moment the person changes the setting, saying what that means", () => {
    polyfillRadix();
    useSettingsStore.setState({ settings: { ...DEFAULT_SETTINGS, costCurrency: "USD", aiIntegrations: [AZURE] } });
    render(<MemoryRouter initialEntries={["/app/settings/ai-integrations"]}><SettingsPage /></MemoryRouter>);
    expect(screen.getAllByLabelText("Input (USD / 1M tokens)").length).toBeGreaterThan(0);
    expect(screen.queryByText(/€ \/ 1M/)).toBeNull();
    const notice = () => screen.queryAllByRole("status").find((status) => status.textContent?.startsWith("From now on, prices are read in"));
    // Settings that arrive late (a load) say nothing: only the person's choice does.
    act(() => useSettingsStore.getState().patchSettings({ costCurrency: "GBP" }));
    expect(screen.getAllByLabelText("Input (GBP / 1M tokens)").length).toBeGreaterThan(0);
    expect(notice()).toBeUndefined();
    chooseOption(screen.getByRole("combobox", { name: "Currency of prices and costs" }), /^EUR/);
    expect(useSettingsStore.getState().settings.costCurrency).toBe("EUR");
    expect(screen.getAllByLabelText("Input (EUR / 1M tokens)").length).toBeGreaterThan(0);
    expect(notice()?.textContent).toContain("prices are read in EUR");
    // The whole page of the settings, read by its labels: as long as the other tests of that page are given (`aiIntegrationsSettings`).
  }, 60_000);
});

describe("an estimate, in one phrase", () => {
  const moneyOf = (currency: string, rates: CostExchangeRate[] = []) => {
    const context = moneyContextOf({ costCurrency: currency, costRates: rates }, "en");
    return { ...context, amount: (value: number | undefined, recorded?: string) => formatAmount(value ?? 0, recorded, context), totals: (totals: Record<string, number>) => formatTotals(totals, context) };
  };
  const t = i18n.t.bind(i18n);

  it("says the tokens and the money of the calls without a token count together, the tokens alone, the money alone, or nothing", () => {
    const money = moneyOf("USD");
    expect(estimatePhrase(t, money, "1,320", { USD: 0.0041 })).toBe("≈ 1,320 tokens and ≈ $0.0041, estimated");
    expect(estimatePhrase(t, money, "800", {})).toBe("≈ 800 tokens, estimated");
    expect(estimatePhrase(t, money, null, { USD: 0.002 })).toBe("≈ $0.002 estimated");
    expect(estimatePhrase(t, money, null, {})).toBe("");
  });

  it("never says «≈» twice for an estimate converted at a rate, in the phrase or on its own", () => {
    setSettings("EUR", [{ from: "USD", to: "EUR", rate: 0.9 }]);
    expect(estimatePhrase(t, moneyOf("EUR", [{ from: "USD", to: "EUR", rate: 0.9 }]), "500", { USD: 0.002 })).toBe("≈ 500 tokens and ≈ €0.0018, estimated");
    render(<EstimatedMoney totals={{ USD: 0.002 }} />);
    expect(screen.getByText("≈ €0.0018 estimated")).toBeInTheDocument();
  });
});
