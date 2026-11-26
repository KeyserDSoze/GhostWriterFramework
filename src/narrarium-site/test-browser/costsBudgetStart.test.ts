import { beforeEach, describe, expect, it } from "vitest";
import "@/i18n/costs";
import type { AutopilotOptions, AutopilotStats, StartOptions } from "narrarium-engine";
import { AutopilotBudgetUsedUpError, budgetsApply, isBudgetUsedUp, startWithBudgets } from "@/autopilot/startBudgets";
import { useAutopilotStore } from "@/autopilot/store";
import { appliedCapOf, decideCap, isAppliedCap, rememberAppliedCap, type AppliedCap } from "@/costs/budgetCaps";
import type { CapPlan } from "@/costs/budgets";
import { useCostsStore } from "@/costs/costsStore";
import { addToLedger, ledgerWriterId, localDay, type UsageDelta } from "@/costs/ledger";
import { emptyCostsFile } from "@/costs/model";
import { useSettingsStore } from "@/store/settingsStore";
import { DEFAULT_SETTINGS, type BookEntry, type CostBudgets } from "@/types/settings";

const WRITER = ledgerWriterId("device-a", "2026-11-01T00:00:00.000Z");
const NOW = new Date(2026, 10, 26, 12, 0, 0);
const today = localDay(NOW);
const BOOK: BookEntry = { id: "book-1", name: "The Glass Harbor", owner: "", repo: "", storageMode: "local-only", tokenIndex: null, addedAt: "2026-01-01T00:00:00.000Z" } as BookEntry;
const SERVED: BookEntry = { id: "book-3", name: "The Lighthouse", owner: "", repo: "", storageMode: "local-only", tokenIndex: null, addedAt: "2026-01-01T00:00:00.000Z", autopilotHost: "server" } as BookEntry;

function ledger(rows: Array<{ bookId?: string; source?: string; currency?: string; cost: number; period?: string }>) {
  const deltas: UsageDelta[] = rows.map((entry) => ({
    key: { period: entry.period ?? today, bookId: entry.bookId ?? "book-1", source: entry.source ?? "autopilot", capability: "autopilot", integrationId: "int-1", model: "gpt-5", currency: entry.currency ?? "USD" },
    counters: { calls: 1, tasks: 1, cost: entry.cost },
  }));
  const file = { ...emptyCostsFile(), ledger: addToLedger(undefined, WRITER, deltas, NOW, "USD") };
  useCostsStore.setState({ file, persisted: file });
}

function settings(costBudgets: CostBudgets | undefined, costCurrency = "USD") {
  useSettingsStore.setState({ settings: { ...DEFAULT_SETTINGS, costCurrency, ...(costBudgets ? { costBudgets } : {}), books: [BOOK, SERVED] } });
}

function autopilot(bookId: string, options: Partial<AutopilotOptions>, stats: Partial<AutopilotStats>) {
  const fullStats = { tasks: 0, aiCalls: 0, inputTokens: 0, outputTokens: 0, cost: 0, failures: 0, ...stats } as AutopilotStats;
  const state = { status: "paused", updatedAt: "2026-11-26T10:00:00.000Z", options: { budgetLimit: 0, ...options }, stats: fullStats };
  useAutopilotStore.setState((store) => ({ views: { ...store.views, [bookId]: { snapshot: { bookId, state, summary: { status: "paused", stats: fullStats, updatedAt: state.updatedAt }, activities: [], live: null } } as never } }));
}

const plan = (cap: number | null): CapPlan => ({ cap, binding: cap === null ? null : { scope: "global", bookId: "", period: "month", currency: "USD", limit: 20, spent: 12, ratio: 0.6, state: "ok", converted: false, uncounted: {}, left: 8, leftInRun: 8 }, unlimited: [], usedUp: false });
const NONE: StartOptions = {};
const marker = (applied: number, own: number): AppliedCap => ({ applied, own, binding: { scope: "global", bookId: "", period: "month", currency: "USD", limit: 20 } });

describe("the cap the budgets give the autopilot", () => {
  it("is the cap the budgets leave when the book has none of its own, and the smaller when it has one", () => {
    expect(decideCap({ marker: null, current: 0, plan: plan(11), ignore: false })).toEqual({ budgetLimit: 11, applied: marker(11, 0) });
    expect(decideCap({ marker: null, current: 30, plan: plan(11), ignore: false })).toEqual({ budgetLimit: 11, applied: marker(11, 30) });
    expect(decideCap({ marker: null, current: 5, plan: plan(11), ignore: false }), "the cap of its own is smaller: it stays, and nothing is remembered").toEqual({ budgetLimit: undefined, applied: null });
  });

  it("takes the cap the budgets gave for what it is, and finds the person's own cap again behind it", () => {
    const earlier = marker(11, 30);
    expect(decideCap({ marker: earlier, current: 11, plan: plan(14), ignore: false }), "a start of the form that shows the cap: the cap of its own is still 30").toEqual({ budgetLimit: 14, applied: marker(14, 30) });
    expect(decideCap({ marker: earlier, current: 11, explicit: 11, plan: plan(14), ignore: false }).applied?.own).toBe(30);
    expect(decideCap({ marker: earlier, current: 11, plan: plan(40), ignore: false }), "the budgets leave more than the cap of its own: its own cap is given back").toEqual({ budgetLimit: 30, applied: null });
    expect(decideCap({ marker: earlier, current: 11, plan: plan(null), ignore: false }), "no budget limits it any more: its own cap comes back").toEqual({ budgetLimit: 30, applied: null });
    expect(decideCap({ marker: marker(11, 0), current: 11, plan: plan(null), ignore: false }), "it had none: none again").toEqual({ budgetLimit: 0, applied: null });
  });

  it("takes a cap the person typed after the budgets gave theirs as the person's own", () => {
    expect(decideCap({ marker: marker(11, 0), current: 8, plan: plan(14), ignore: false })).toEqual({ budgetLimit: undefined, applied: null });
    expect(decideCap({ marker: marker(11, 0), current: 25, plan: plan(14), ignore: false })).toEqual({ budgetLimit: 14, applied: marker(14, 25) });
    expect(decideCap({ marker: marker(11, 0), current: 11, explicit: 50, plan: plan(14), ignore: false }), "a cap the start itself carries is the person's choice").toEqual({ budgetLimit: 14, applied: marker(14, 50) });
  });

  it("goes on past the budgets for one start when the person says so, with the cap the person chose and none from the budgets", () => {
    expect(decideCap({ marker: marker(11, 30), current: 11, plan: plan(11), ignore: true })).toEqual({ budgetLimit: 30, applied: null });
    expect(decideCap({ marker: marker(11, 0), current: 11, explicit: 60, plan: plan(11), ignore: true }), "the cap given with the start is the one the run goes on with").toEqual({ budgetLimit: undefined, applied: null });
    expect(decideCap({ marker: null, current: 0, plan: plan(11), ignore: true })).toEqual({ budgetLimit: undefined, applied: null });
  });

  it("is remembered on this device, and a stop at it is known for the budget's", () => {
    localStorage.clear();
    expect(appliedCapOf("book-1")).toBeNull();
    rememberAppliedCap("book-1", marker(11, 30));
    expect(appliedCapOf("book-1")).toEqual(marker(11, 30));
    expect(isAppliedCap("book-1", 11.0000001)?.own).toBe(30);
    expect(isAppliedCap("book-1", 12), "a stop at a cap of the person's own").toBeNull();
    rememberAppliedCap("book-1", null);
    expect(appliedCapOf("book-1")).toBeNull();
    expect(localStorage.getItem("narrarium-budget-caps-v1")).toBeNull();
  });
});

describe("the start of an autopilot with the budgets", () => {
  beforeEach(() => {
    localStorage.clear();
    useAutopilotStore.setState({ views: {}, summaries: {} });
    ledger([]);
    settings(undefined);
  });

  it("changes nothing for a book without budgets, and reads nothing", () => {
    expect(budgetsApply("book-1")).toBe(false);
    const start: StartOptions = { options: { budgetLimit: 9 } };
    expect(startWithBudgets(BOOK, start, false, NOW)).toBe(start);
  });

  it("sends the cap a monthly budget leaves, from the ledger, added to what the autopilot counts of the book", () => {
    settings({ global: { USD: { month: 20 } } });
    ledger([{ cost: 12 }, { cost: 3, source: "copilot", bookId: "book-2" }, { cost: 9, period: "2026-10-30" }]);
    autopilot("book-1", { budgetLimit: 0 }, { cost: 6 });
    expect(budgetsApply("book-1")).toBe(true);
    const sent = startWithBudgets(BOOK, NONE, false, NOW);
    expect(sent.options?.budgetLimit, "15 spent this month of 20 by every use, so 5 more than the 6 the book has cost").toBe(11);
    expect(appliedCapOf("book-1")).toMatchObject({ applied: 11, own: 0, binding: { period: "month", currency: "USD", limit: 20 } });
  });

  it("keeps the other start options, and a cap of its own that is smaller", () => {
    settings({ global: { USD: { total: 100 } } });
    ledger([{ cost: 10 }]);
    autopilot("book-1", { budgetLimit: 4 }, { cost: 2 });
    const start: StartOptions = { limits: { steps: 1 }, options: { readers: false } };
    const sent = startWithBudgets(BOOK, start, false, NOW);
    expect(sent).toBe(start);
    expect(appliedCapOf("book-1")).toBeNull();
  });

  it("stops the run at what it has already spent when the budget is used up, before the next step", () => {
    settings({ books: { "book-1": { USD: { total: 10 } } } });
    ledger([{ cost: 10.5 }]);
    autopilot("book-1", { budgetLimit: 0 }, { cost: 10.5 });
    expect(startWithBudgets(BOOK, NONE, false, NOW).options?.budgetLimit).toBe(10.5);
  });

  it("refuses to start a book that has spent nothing when the budget is used up, and goes on when the person chose to", () => {
    settings({ global: { USD: { month: 5 } } });
    ledger([{ cost: 5, bookId: "book-2", source: "copilot" }]);
    let thrown: unknown;
    try {
      startWithBudgets(BOOK, NONE, false, NOW);
    } catch (error) {
      thrown = error;
    }
    expect(thrown).toBeInstanceOf(AutopilotBudgetUsedUpError);
    expect(isBudgetUsedUp(thrown)).toBe(true);
    expect((thrown as AutopilotBudgetUsedUpError).message).toMatch(/budget/i);
    expect(startWithBudgets(BOOK, { options: { budgetLimit: 3 } } as StartOptions, true, NOW).options?.budgetLimit, "the start that goes on past the budgets sends the cap it carries").toBe(3);
  });

  it("gives the cap of its own back once the budgets are taken away", () => {
    settings(undefined);
    rememberAppliedCap("book-1", marker(11, 30));
    autopilot("book-1", { budgetLimit: 11 }, { cost: 6 });
    expect(budgetsApply("book-1"), "a cap the budgets gave is still to be given back").toBe(true);
    expect(startWithBudgets(BOOK, NONE, false, NOW).options?.budgetLimit).toBe(30);
    expect(appliedCapOf("book-1")).toBeNull();
  });

  it("counts the personal server's own cost of a book that runs there, in the total budgets, and sends the cap through the options of the start", () => {
    settings({ global: { USD: { total: 20 } } });
    ledger([{ cost: 4, bookId: "book-3" }]);
    autopilot("book-3", { budgetLimit: 0 }, { cost: 9 });
    const sent = startWithBudgets(SERVED, { force: true } as StartOptions & { force?: boolean }, false, NOW);
    expect(sent.force).toBe(true);
    expect(sent.options?.budgetLimit, "the server counted 9 of that book, the ledger 4: 9 spent in all, 11 left, 9 + 11").toBe(20);
  });

  it("converts a budget in another currency into the currency of the run at a rate of the settings, and a budget with no rate does not limit it", () => {
    useSettingsStore.setState({ settings: { ...DEFAULT_SETTINGS, costCurrency: "USD", costRates: [{ from: "EUR", to: "USD", rate: 2 }], costBudgets: { global: { EUR: { total: 10 }, JPY: { total: 100 } } }, books: [BOOK] } });
    ledger([{ cost: 4, currency: "EUR" }]);
    autopilot("book-1", { budgetLimit: 0 }, { cost: 8 });
    expect(startWithBudgets(BOOK, NONE, false, NOW).options?.budgetLimit, "6 EUR are left: 12 USD more than the 8 counted").toBe(20);
  });
});
