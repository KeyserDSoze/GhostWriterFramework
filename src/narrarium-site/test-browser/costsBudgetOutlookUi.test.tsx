import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { AutopilotStats } from "narrarium-engine";

const mocks = vi.hoisted(() => ({ save: vi.fn(async () => true) }));
vi.mock("@/drive/useSettings", async (importOriginal) => ({ ...(await importOriginal<typeof import("@/drive/useSettings")>()), saveSettingsNow: () => mocks.save() }));

import i18n from "@/i18n";
import "@/i18n/costs";
import { BudgetOutlook } from "@/components/costs/budget/BudgetOutlook";
import { useAutopilotStore } from "@/autopilot/store";
import { useCostsStore } from "@/costs/costsStore";
import { addToLedger, ledgerWriterId, localDay, type UsageDelta } from "@/costs/ledger";
import { emptyCostsFile } from "@/costs/model";
import { useSettingsStore } from "@/store/settingsStore";
import { DEFAULT_SETTINGS, type BookEntry, type CostBudgets } from "@/types/settings";

const WRITER = ledgerWriterId("device-a", "2026-11-01T00:00:00.000Z");
const today = localDay(new Date());
const GLASS = { id: "book-1", name: "The Glass Harbor", owner: "", repo: "", storageMode: "local-only", tokenIndex: null, addedAt: "2026-01-01T00:00:00.000Z" } as BookEntry;
const SERVED = { ...GLASS, id: "book-3", name: "The Lighthouse", autopilotHost: "server" } as BookEntry;

function spend(rows: Array<{ bookId?: string; cost: number; currency?: string }>) {
  const deltas: UsageDelta[] = rows.map((row) => ({ key: { period: today, bookId: row.bookId ?? "book-1", source: "autopilot", capability: "autopilot", integrationId: "int-1", model: "gpt-5", currency: row.currency ?? "USD" }, counters: { calls: 1, tasks: 1, cost: row.cost } }));
  const file = { ...emptyCostsFile(), ledger: addToLedger(undefined, WRITER, deltas, new Date(), "USD") };
  useCostsStore.setState({ file, persisted: file });
}

function settings(costBudgets?: CostBudgets, books: BookEntry[] = [GLASS]) {
  useSettingsStore.setState({ settings: { ...DEFAULT_SETTINGS, costCurrency: "USD", ...(costBudgets ? { costBudgets } : {}), books } });
}

function served(bookId: string, stats: Partial<AutopilotStats>) {
  const full = { tasks: 0, aiCalls: 0, inputTokens: 0, outputTokens: 0, cost: 0, failures: 0, ...stats } as AutopilotStats;
  const summary = { status: "running", stats: full, updatedAt: "2026-11-26T10:00:00.000Z" } as never;
  act(() => useAutopilotStore.setState((store) => ({ summaries: { ...store.summaries, [bookId]: summary } })));
}

const outlook = () => document.querySelector<HTMLElement>("[data-budget-outlook]");
const sentence = () => outlook()?.querySelector("[data-outlook-text]")?.textContent ?? "";

beforeEach(async () => {
  mocks.save.mockClear();
  await i18n.changeLanguage("en");
  settings();
  spend([]);
});

afterEach(() => {
  cleanup();
  useAutopilotStore.setState({ views: {}, summaries: {} });
});

describe("the estimate of a run against the budget, in words", () => {
  const monthly: CostBudgets = { global: { USD: { month: 20 } } };
  const show = (props: Partial<Parameters<typeof BudgetOutlook>[0]> = {}) => render(<MemoryRouter><BudgetOutlook bookId="book-1" cost={{ min: 8, max: 12 }} currency="USD" chapters={{ first: 1, count: 10, kind: "written" }} {...props} /></MemoryRouter>);

  it("shows nothing without a budget, and nothing while there is no estimate to say", () => {
    show();
    expect(outlook()).toBeNull();
    cleanup();
    settings(monthly);
    show({ cost: undefined });
    expect(outlook(), "no estimate yet").toBeNull();
  });

  it("says that the run fits, with the figures", () => {
    settings(monthly);
    spend([{ cost: 4 }]);
    show({ cost: { min: 3, max: 6 } });
    expect(outlook()).toHaveAttribute("data-budget-outlook", "fits");
    expect(sentence()).toBe("This run is estimated at $3 to $6; you have $16.00 left in the budget (All books, per month): it fits.");
    expect(screen.queryByRole("button", { name: /Raise the budget/ })).toBeNull();
  });

  it("says where the run would stop, and offers to raise the budget, and to start anyway when the dialog can start", () => {
    settings(monthly);
    spend([{ cost: 14 }]);
    const anyway = vi.fn();
    show({ onStartAnyway: anyway });
    expect(outlook()).toHaveAttribute("data-budget-outlook", "stops");
    expect(sentence()).toBe("This run is estimated at $8 to $12, you have $6.00 left in the budget (All books, per month): it would stop somewhere between chapter 6 and chapter 8.");
    expect(screen.getByRole("button", { name: /Raise the budget to/ })).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Start anyway" }));
    expect(anyway).toHaveBeenCalledTimes(1);
    expect(screen.getByRole("link", { name: "Open the budgets" })).toHaveAttribute("href", "/app/costs");
  });

  it("is a statement and a way to raise the budget where the dialog has nothing to start", () => {
    settings(monthly);
    spend([{ cost: 14 }]);
    show();
    expect(screen.queryByRole("button", { name: "Start anyway" })).toBeNull();
    expect(outlook()).toHaveTextContent("or raise the budget.");
  });

  it("says the chapter of a design, and a run with no chapters that it would stop before it finishes", () => {
    settings(monthly);
    spend([{ cost: 17 }]);
    show({ cost: { min: 6, max: 6 }, chapters: { first: 1, count: 6, kind: "designed" } });
    expect(sentence()).toBe("This run is estimated at $6, you have $3.00 left in the budget (All books, per month): it would stop at about chapter 4 of the design.");
    cleanup();
    show({ cost: { min: 4, max: 6 }, chapters: null });
    expect(sentence()).toContain("it would stop before it finishes.");
  });

  it("says that it cannot compare a run that has no price, with what is left", () => {
    settings(monthly);
    spend([{ cost: 12 }]);
    show({ cost: null });
    expect(outlook()).toHaveAttribute("data-budget-outlook", "unknown");
    expect(sentence()).toBe("The cost of this run is not estimated, so it cannot be compared with the $8.00 left in the budget (All books, per month).");
  });

  it("raises the budget that leaves least to a limit that covers the run, saves it, and then says that it fits", async () => {
    settings(monthly);
    spend([{ cost: 14 }]);
    show();
    fireEvent.click(screen.getByRole("button", { name: /Raise the budget to/ }));
    await waitFor(() => expect(useSettingsStore.getState().settings.costBudgets?.global?.USD?.month).toBeGreaterThanOrEqual(14 + 12));
    expect(mocks.save).toHaveBeenCalled();
    expect(await screen.findByText(/Raised: the per month budget of All books is now/)).toBeInTheDocument();
    expect(outlook()).toHaveAttribute("data-budget-outlook", "fits");
  });

  it("counts what the personal server spent in a total budget, and says so in the figures", () => {
    settings({ global: { USD: { total: 30 } } }, [GLASS, SERVED]);
    spend([{ cost: 5 }]);
    served("book-3", { cost: 20, currency: "USD" });
    show({ cost: { min: 1, max: 2 } });
    // 5 in the ledger and 20 counted by the server for another book: 25 of 30.
    expect(sentence()).toContain("you have $5.00 left in the budget (All books, in total)");
  });

  it("is in Italian when the app is", async () => {
    await i18n.changeLanguage("it");
    settings(monthly);
    spend([{ cost: 14 }]);
    show({ onStartAnyway: () => undefined });
    expect(sentence()).toContain("si fermerebbe da qualche parte tra il capitolo 6 e il capitolo 8.");
    expect(screen.getByRole("button", { name: "Avvia comunque" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /Alza il budget a/ })).toBeInTheDocument();
  });
});
