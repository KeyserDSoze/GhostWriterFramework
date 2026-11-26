import { act, cleanup, render, screen } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import i18n from "@/i18n";
import "@/i18n/costs";
import { CostsIndicator } from "@/components/costs/CostsIndicator";
import { useCostsStore } from "@/costs/costsStore";
import { addToLedger, ledgerWriterId, localDay, type UsageDelta } from "@/costs/ledger";
import { emptyCostsFile, type CostsFile } from "@/costs/model";
import { useSettingsStore } from "@/store/settingsStore";
import { DEFAULT_SETTINGS } from "@/types/settings";

const WRITER = ledgerWriterId("device-a", "2026-11-01T00:00:00.000Z");
const now = new Date();
const today = localDay(now);
const earlierThisMonth = now.getDate() > 1 ? localDay(new Date(now.getFullYear(), now.getMonth(), 1)) : null;
const lastMonthDay = localDay(new Date(now.getFullYear(), now.getMonth() - 1, 15));

function fileOf(...deltas: UsageDelta[]): CostsFile {
  let file = emptyCostsFile();
  for (const delta of deltas) file = { ...file, ledger: addToLedger(file.ledger, WRITER, [delta], now, "EUR") };
  return file;
}

const spend = (period: string, cost: number, currency = "EUR"): UsageDelta => ({ key: { period, bookId: "book-1", source: "copilot", capability: "copilot", integrationId: "int-1", model: "gpt-5", currency }, counters: { calls: 1, tasks: 1, cost } });
const show = () => render(<MemoryRouter><CostsIndicator /></MemoryRouter>);
const indicator = () => document.querySelector<HTMLAnchorElement>("[data-costs-indicator]");

beforeEach(async () => {
  await i18n.changeLanguage("en");
  useSettingsStore.setState({ settings: { ...DEFAULT_SETTINGS, costCurrency: "EUR" } });
});

afterEach(() => {
  cleanup();
  useCostsStore.setState({ file: emptyCostsFile(), persisted: emptyCostsFile() });
});

describe("the spend in the top bar", () => {
  it("is not there when nothing was spent this month, nor without a ledger", () => {
    useCostsStore.setState({ file: emptyCostsFile(), persisted: emptyCostsFile() });
    const { unmount } = show();
    expect(indicator()).toBeNull();
    unmount();
    const file = fileOf(spend(lastMonthDay, 2));
    useCostsStore.setState({ file, persisted: file });
    show();
    expect(indicator(), "last month's spend is on the dashboard").toBeNull();
  });

  it("says what was spent today and this month, and leads to the dashboard", () => {
    const file = fileOf(spend(today, 0.12), ...(earlierThisMonth ? [spend(earlierThisMonth, 0.38)] : [spend(today, 0.38)]), spend(lastMonthDay, 5));
    useCostsStore.setState({ file, persisted: file });
    show();
    const link = indicator()!;
    expect(link).toHaveAttribute("href", "/app/costs");
    const todayText = earlierThisMonth ? "€0.12" : "€0.50";
    expect(link).toHaveAccessibleName(`Spend today ${todayText} this month €0.50 — open the costs`);
    expect(link.querySelector("[data-costs-month]")).toHaveTextContent("€0.50");
    expect(link.querySelector("[data-costs-today]"), "a narrow bar shows the month, a screen reader hears both").toHaveClass("sr-only", "lg:not-sr-only");
  });

  it("follows each new call and the currency of the settings, live", () => {
    const file = fileOf(spend(today, 0.1));
    useCostsStore.setState({ file, persisted: file });
    show();
    expect(indicator()!.querySelector("[data-costs-month]")).toHaveTextContent("€0.10");
    act(() => { const next = fileOf(spend(today, 0.1), spend(today, 0.2, "USD")); useCostsStore.setState({ file: next, persisted: next }); });
    expect(indicator()!.querySelector("[data-costs-month]")).toHaveTextContent("€0.10 + $0.20");
    act(() => useSettingsStore.setState({ settings: { ...DEFAULT_SETTINGS, costCurrency: "EUR", costRates: [{ from: "USD", to: "EUR", rate: 0.5 }] } }));
    expect(indicator()!.querySelector("[data-costs-month]")).toHaveTextContent("≈ €0.20");
  });

  it("says it in Italian", async () => {
    await act(async () => { await i18n.changeLanguage("it"); });
    const file = fileOf(spend(today, 0.5));
    useCostsStore.setState({ file, persisted: file });
    show();
    expect(indicator()!.getAttribute("title")).toMatch(/^Spesa di oggi .* · questo mese /);
    expect(screen.getByText("— apri i costi")).toBeInTheDocument();
  });
});
