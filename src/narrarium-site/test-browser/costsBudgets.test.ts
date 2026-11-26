import { describe, expect, it } from "vitest";
import { alertLines, budgetLines, DEFAULT_WARN_AT, MAX_BUDGET, normalizeBudgets, planCap, stateOf, suggestedBudget, unrecordedCosts, warnAtOf, withLimits, worstLine } from "@/costs/budgets";
import { emptyCounters, type UsageRow } from "@/costs/ledger";
import { EARLIER } from "@/costs/legacyCosts";
import type { CostBudgets, CostExchangeRate } from "@/types/settings";

const TODAY = "2026-11-26";
const row = (patch: Partial<UsageRow>): UsageRow => ({ ...emptyCounters(), period: TODAY, bookId: "book-1", source: "autopilot", capability: "autopilot", integrationId: "int-1", model: "gpt-5", currency: "USD", writer: "device@1", ...patch });
const context = (patch: { rates?: CostExchangeRate[]; unrecorded?: Array<{ bookId: string; currency: string; cost: number }> } = {}) => ({ today: TODAY, rates: patch.rates ?? [], ...(patch.unrecorded ? { unrecorded: patch.unrecorded } : {}) });

describe("the budgets of the settings", () => {
  it("keeps the limits that can be used and says nothing for settings that never had any", () => {
    expect(normalizeBudgets(undefined)).toBeUndefined();
    expect(normalizeBudgets("USD")).toBeUndefined();
    expect(normalizeBudgets({ global: { USD: {} }, books: {} })).toBeUndefined();
    expect(normalizeBudgets({
      global: { USD: { month: 20, total: -1 }, euro: { month: 5 }, EUR: { total: 2_000_000 }, GBP: { total: "9" } },
      books: { "book-1": { EUR: { total: 12.5 } }, "": { USD: { month: 1 } }, "book-2": {} },
      counts: "autopilot",
      warnAt: 90,
    })).toEqual({ warnAt: 90, counts: "autopilot", global: { USD: { month: 20 } }, books: { "book-1": { EUR: { total: 12.5 } } } });
  });

  it("warns at 80% unless another whole share of 1 to 99 is given, and never stores the default", () => {
    expect(warnAtOf(undefined)).toBe(DEFAULT_WARN_AT);
    expect(warnAtOf({ warnAt: 65 })).toBe(65);
    expect(normalizeBudgets({ global: { USD: { total: 5 } }, warnAt: 80 })).toEqual({ global: { USD: { total: 5 } } });
    expect(normalizeBudgets({ global: { USD: { total: 5 } }, warnAt: 100 })).toEqual({ global: { USD: { total: 5 } } });
    expect(normalizeBudgets({ global: { USD: { total: 5 } }, warnAt: 12.5 })).toEqual({ global: { USD: { total: 5 } } });
  });

  it("replaces the limits of one scope and removes the scope that has none left", () => {
    const first = withLimits(undefined, "", { USD: { month: 20 } });
    expect(first).toEqual({ global: { USD: { month: 20 } } });
    const second = withLimits(first, "book-1", { EUR: { total: 8 } });
    expect(second).toEqual({ global: { USD: { month: 20 } }, books: { "book-1": { EUR: { total: 8 } } } });
    expect(withLimits(second, "book-1", {})).toEqual({ global: { USD: { month: 20 } } });
    expect(withLimits(first, "", {})).toBeUndefined();
  });
});

describe("what a budget has used", () => {
  const budgets: CostBudgets = { global: { USD: { month: 20, total: 100 } }, books: { "book-1": { USD: { month: 5 } } } };
  const rows = [
    row({ cost: 2 }),
    row({ cost: 4, source: "copilot", bookId: "book-2" }),
    row({ cost: 10, period: "2026-10-15" }),
    row({ cost: 30, period: "2026-04" }),
    row({ cost: 50, period: EARLIER, source: "other" }),
    row({ cost: 1, bookId: "" }),
  ];

  it("counts the month by its days and by the compacted month, the total by every row, and a book by its own rows only", () => {
    const lines = budgetLines(budgets, rows, context());
    const find = (scope: string, period: string) => lines.find((line) => line.scope === scope && line.period === period)!;
    expect(find("global", "month").spent, "this month, every book, every use: 2 + 4 + 1").toBe(7);
    expect(find("global", "total").spent).toBe(2 + 4 + 10 + 30 + 50 + 1);
    expect(find("book", "month").spent, "book-1 this month only").toBe(2);
    expect(find("global", "month")).toMatchObject({ limit: 20, ratio: 0.35, state: "ok", currency: "USD" });
  });

  it("counts only the autopilot when asked to", () => {
    const lines = budgetLines({ ...budgets, counts: "autopilot" }, rows, context());
    expect(lines.find((line) => line.scope === "global" && line.period === "month")!.spent, "the Copilot's 4 and the other uses are not counted").toBe(2 + 1);
  });

  it("warns at the share and says «over» at the limit, with words for the state and not a colour", () => {
    expect(stateOf(0.79, 80)).toBe("ok");
    expect(stateOf(0.8, 80)).toBe("warn");
    expect(stateOf(0.999, 80)).toBe("warn");
    expect(stateOf(1, 80)).toBe("over");
    expect(stateOf(0.5, 50)).toBe("warn");
    const lines = budgetLines({ global: { USD: { month: 10 } } }, [row({ cost: 8 })], context());
    expect(lines[0]).toMatchObject({ state: "warn", ratio: 0.8 });
    expect(alertLines(budgetLines({ global: { USD: { month: 10, total: 9 } } }, [row({ cost: 9.5 })], context())).map((line) => [line.period, line.state])).toEqual([["total", "over"], ["month", "warn"]]);
    expect(worstLine(budgetLines({ global: { USD: { month: 10, total: 90 } } }, [row({ cost: 9 })], context()))!.period).toBe("month");
    expect(worstLine([])).toBeNull();
  });

  it("never adds currencies silently: another currency counts at a rate of the settings, and without one it is not counted and is said", () => {
    const mixed = [row({ cost: 4, currency: "USD" }), row({ cost: 10, currency: "EUR" }), row({ cost: 100, currency: "JPY" })];
    const none = budgetLines({ global: { USD: { total: 20 } } }, mixed, context());
    expect(none[0]).toMatchObject({ spent: 4, converted: false, uncounted: { EUR: 10, JPY: 100 } });
    const rated = budgetLines({ global: { USD: { total: 20 } } }, mixed, context({ rates: [{ from: "EUR", to: "USD", rate: 1.1 }] }));
    expect(rated[0].spent).toBeCloseTo(4 + 11, 10);
    expect(rated[0]).toMatchObject({ converted: true, uncounted: { JPY: 100 } });
    const inverse = budgetLines({ global: { EUR: { total: 20 } } }, mixed, context({ rates: [{ from: "EUR", to: "USD", rate: 1.25 }] }));
    expect(inverse[0].spent, "10 EUR and 4 USD at 1 EUR = 1.25 USD").toBeCloseTo(10 + 4 / 1.25, 10);
  });

  it("keeps a budget per currency apart: one limit in each, each against what was spent in it", () => {
    const lines = budgetLines({ global: { USD: { total: 10 }, EUR: { total: 10 } } }, [row({ cost: 9, currency: "USD" }), row({ cost: 2, currency: "EUR" })], context());
    expect(lines.map((line) => [line.currency, line.spent, line.state])).toEqual([["EUR", 2, "ok"], ["USD", 9, "warn"]]);
  });

  it("counts the cost of a book on the personal server that this browser's ledger does not hold, in the total budgets only", () => {
    const served = [{ bookId: "book-1", currency: "USD", cost: 12 }];
    const extra = unrecordedCosts([row({ cost: 5 }), row({ cost: 3, source: "copilot" })], served);
    expect(extra, "the server counted 12, the ledger has 5 of the autopilot of that book: 7 are unrecorded").toEqual([{ bookId: "book-1", currency: "USD", cost: 7 }]);
    expect(unrecordedCosts([row({ cost: 12 })], served), "nothing is unrecorded when the ledger has all of it").toEqual([]);
    expect(unrecordedCosts([], [{ bookId: "book-1", currency: "", cost: 3 }])).toEqual([]);
    const lines = budgetLines({ global: { USD: { month: 50, total: 50 } }, books: { "book-1": { USD: { total: 10 } } } }, [row({ cost: 5 })], context({ unrecorded: extra }));
    const of = (scope: string, period: string) => lines.find((line) => line.scope === scope && line.period === period)!;
    expect(of("global", "total").spent).toBe(12);
    expect(of("global", "month").spent, "the month of a server run is not known: not counted").toBe(5);
    expect(of("book", "total").spent).toBe(12);
  });
});

describe("the cap the engine is given", () => {
  const rates: CostExchangeRate[] = [{ from: "EUR", to: "USD", rate: 2 }];
  const line = (patch: Partial<Parameters<typeof planCap>[0][number]>) => ({ scope: "global" as const, bookId: "", period: "month" as const, currency: "USD", limit: 20, spent: 12, ratio: 0.6, state: "ok" as const, converted: false, uncounted: {}, ...patch });

  it("is what the book has spent for the engine plus what the budget leaves", () => {
    const plan = planCap([line({})], { bookId: "book-1", runCurrency: "USD", statsCost: 3, rates });
    expect(plan.cap, "the engine counts the book's own cost over all its runs: 3, then 8 more").toBe(11);
    expect(plan.binding).toMatchObject({ period: "month", left: 8, leftInRun: 8 });
  });

  it("follows the budget that leaves least, whichever scope it is of, and ignores the budget of another book", () => {
    const lines = [line({ limit: 20, spent: 12 }), line({ scope: "book", bookId: "book-1", period: "total", limit: 6, spent: 5 }), line({ scope: "book", bookId: "book-2", period: "total", limit: 6, spent: 0.5 })];
    const plan = planCap(lines, { bookId: "book-1", runCurrency: "USD", statsCost: 0.4, rates });
    expect(plan.cap).toBe(1.4);
    expect(plan.binding).toMatchObject({ scope: "book", bookId: "book-1", period: "total" });
    expect(planCap(lines, { bookId: "book-2", runCurrency: "USD", statsCost: 0, rates }).binding, "its own budget leaves 5.5, the global one 8").toMatchObject({ scope: "book", bookId: "book-2" });
    expect(planCap(lines, { bookId: "book-3", runCurrency: "USD", statsCost: 0, rates }).binding, "a book with no budget of its own has the global one").toMatchObject({ scope: "global" });
  });

  it("turns a budget in another currency into the currency of the run at a rate of the settings, and a budget with no rate cannot limit it", () => {
    const euro = line({ currency: "EUR", limit: 10, spent: 6 });
    expect(planCap([euro], { bookId: "b", runCurrency: "USD", statsCost: 1, rates })).toMatchObject({ cap: 9, binding: { left: 4, leftInRun: 8 } });
    const yen = line({ currency: "JPY", limit: 1000, spent: 10 });
    const plan = planCap([yen, euro], { bookId: "b", runCurrency: "USD", statsCost: 0, rates });
    expect(plan.unlimited.map((entry) => entry.currency)).toEqual(["JPY"]);
    expect(plan.cap).toBe(8);
    const none = planCap([yen], { bookId: "b", runCurrency: "USD", statsCost: 2, rates });
    expect(none).toMatchObject({ cap: null, binding: null, usedUp: false });
  });

  it("stops the run at what it has already spent when nothing is left, before the next step", () => {
    const used = line({ limit: 20, spent: 25, ratio: 1.25, state: "over" });
    const plan = planCap([used], { bookId: "b", runCurrency: "USD", statsCost: 7.25, rates });
    expect(plan.cap, "the engine pauses when what it counted reaches the cap").toBe(7.25);
    expect(plan.usedUp).toBe(false);
  });

  it("refuses to start a book that has spent nothing when nothing is left: a cap of 0 would mean no cap to the engine", () => {
    const used = line({ limit: 20, spent: 20, ratio: 1, state: "over" });
    expect(planCap([used], { bookId: "b", runCurrency: "USD", statsCost: 0, rates })).toMatchObject({ cap: null, usedUp: true });
  });

  it("gives no cap when what is left is more than the engine takes, and rounds away the noise of the sums", () => {
    expect(planCap([line({ limit: MAX_BUDGET, spent: 0 })], { bookId: "b", runCurrency: "USD", statsCost: 10, rates }).cap).toBeNull();
    expect(planCap([line({ limit: 0.3, spent: 0.1 })], { bookId: "b", runCurrency: "USD", statsCost: 0.2, rates }).cap).toBe(0.4);
  });

  it("suggests a new limit that is more than what was spent and reads well", () => {
    expect(suggestedBudget(20, 20)).toBe(30);
    expect(suggestedBudget(2, 2.1)).toBe(3);
    expect(suggestedBudget(0.5, 0.5)).toBe(0.75);
    expect(suggestedBudget(MAX_BUDGET, MAX_BUDGET)).toBe(MAX_BUDGET);
  });
});
