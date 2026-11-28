import { describe, expect, it } from "vitest";
import { budgetOutlook, outlookOf } from "@/costs/budgetOutlook";
import { budgetPlan } from "@/costs/budgetPlan";
import { addToLedger, ledgerWriterId, localDay, type UsageDelta } from "@/costs/ledger";
import { emptyCostsFile } from "@/costs/model";
import { usageRows } from "@/costs/legacyCosts";
import type { CostBudgets } from "@/types/settings";

const NOW = new Date(2026, 10, 26, 12, 0, 0);
const today = localDay(NOW);
const WRITER = ledgerWriterId("device-a", "2026-11-01T00:00:00.000Z");

function rowsOf(spent: Array<{ bookId?: string; cost: number; currency?: string }>) {
  const deltas: UsageDelta[] = spent.map((entry) => ({ key: { period: today, bookId: entry.bookId ?? "b1", source: "autopilot", capability: "autopilot", integrationId: "i", model: "m", currency: entry.currency ?? "USD" }, counters: { calls: 1, tasks: 1, cost: entry.cost } }));
  return usageRows({ ...emptyCostsFile(), ledger: addToLedger(undefined, WRITER, deltas, NOW, "USD") }, "USD");
}

const CONTEXT = { rates: [], relabels: [] };
const plan = (budgets: CostBudgets, rows = rowsOf([]), served: Parameters<typeof budgetPlan>[0]["served"] = [], bookId = "b1") => budgetPlan({ budgets, rows, context: CONTEXT, today, served, bookId, runCurrency: "USD", statsCost: 0 }).plan;

describe("the estimate of a run against what the budget has left", () => {
  const monthly: CostBudgets = { global: { USD: { month: 20 } } };

  it("is nothing without a budget that limits the run", () => {
    expect(budgetOutlook({ plan: plan({ global: { EUR: { month: 5 } } }), cost: { min: 1, max: 2 }, currency: "USD", rates: [] }), "a budget in a currency with no rate cannot limit it").toBeNull();
    expect(budgetOutlook({ plan: { cap: null, binding: null, unlimited: [], usedUp: false }, cost: { min: 1, max: 2 }, currency: "USD", rates: [] })).toBeNull();
  });

  it("fits when even the highest figure is within what is left", () => {
    const outlook = budgetOutlook({ plan: plan(monthly, rowsOf([{ cost: 12 }])), cost: { min: 3, max: 8 }, currency: "USD", rates: [] })!;
    expect(outlook.kind).toBe("fits");
    expect(outlook.left).toBe(8);
    expect(outlook.line).toMatchObject({ scope: "global", period: "month", currency: "USD", limit: 20, spent: 12 });
    expect(outlook.stopsAt).toBeUndefined();
    expect(outlook.raiseTo).toBeUndefined();
  });

  it("stops at the chapter the money runs out in, from the highest and the lowest figure", () => {
    const outlook = budgetOutlook({ plan: plan(monthly, rowsOf([{ cost: 14 }])), cost: { min: 8, max: 12 }, currency: "USD", chapters: { first: 4, count: 10, kind: "written" }, rates: [] })!;
    expect(outlook.kind).toBe("stops");
    expect(outlook.left).toBe(6);
    // 6 left of 12: half of the ten chapters (the fifth after the fourth is the ninth); of 8: three quarters (the eleventh).
    expect(outlook.stopsAt).toEqual({ from: 9, to: 11, kind: "written" });
  });

  it("may stop when only the highest figure is over what is left", () => {
    const outlook = budgetOutlook({ plan: plan(monthly, rowsOf([{ cost: 14 }])), cost: { min: 4, max: 12 }, currency: "USD", chapters: { first: 1, count: 6, kind: "designed" }, rates: [] })!;
    expect(outlook.kind).toBe("may-stop");
    expect(outlook.stopsAt).toEqual({ from: 4, to: null, kind: "designed" });
  });

  it("never says a chapter beyond the last one, nor before the first", () => {
    const nearly = budgetOutlook({ plan: plan(monthly, rowsOf([{ cost: 10 }])), cost: { min: 5, max: 10.5 }, currency: "USD", chapters: { first: 3, count: 4, kind: "written" }, rates: [] })!;
    expect(nearly.stopsAt!.from).toBe(6);
    const none = budgetOutlook({ plan: plan({ global: { USD: { total: 10 } } }, rowsOf([{ cost: 10 }])), cost: { min: 5, max: 10 }, currency: "USD", chapters: { first: 3, count: 4, kind: "written" }, rates: [] })!;
    expect(none.left).toBe(0);
    expect(none.stopsAt).toEqual({ from: 3, to: 3, kind: "written" });
  });

  it("says only what is left when the run has no price, and says nothing of chapters for a run that has none", () => {
    expect(budgetOutlook({ plan: plan(monthly, rowsOf([{ cost: 12 }])), cost: null, currency: "USD", rates: [] })).toMatchObject({ kind: "unknown", left: 8 });
    const review = budgetOutlook({ plan: plan(monthly, rowsOf([{ cost: 12 }])), cost: { min: 9, max: 10 }, currency: "USD", chapters: null, rates: [] })!;
    expect(review.kind).toBe("stops");
    expect(review.stopsAt).toBeUndefined();
  });

  it("offers a limit that covers the run, in the currency of the budget, converted at the rate of the settings", () => {
    const rates = [{ from: "EUR", to: "USD", rate: 2 }];
    const eur: CostBudgets = { global: { EUR: { month: 10 } } };
    const eurPlan = budgetPlan({ budgets: eur, rows: rowsOf([{ cost: 8, currency: "EUR" }]), context: { rates, relabels: [] }, today, served: [], bookId: "b1", runCurrency: "USD", statsCost: 0 }).plan;
    const outlook = budgetOutlook({ plan: eurPlan, cost: { min: 6, max: 10 }, currency: "USD", rates })!;
    expect(outlook.kind).toBe("stops");
    expect(outlook.left, "two euros left, four dollars").toBe(4);
    expect(outlook.line.currency).toBe("EUR");
    // The run costs up to $10 = €5: the budget must cover what was spent and that, with the room `suggestedBudget` leaves.
    expect(outlook.raiseTo).toBeGreaterThanOrEqual(8 + 5);
    expect(outlook.raiseTo).toBeLessThanOrEqual(30);
  });

  it("takes the budget that leaves least, and counts what the personal server spent in the total budgets", () => {
    const budgets: CostBudgets = { global: { USD: { total: 50 } }, books: { b1: { USD: { total: 30 } } } };
    const outlook = budgetOutlook({ plan: plan(budgets, rowsOf([{ cost: 5 }]), [{ bookId: "b1", currency: "USD", cost: 20, calls: 3, unpricedCalls: 0 }]), cost: { min: 1, max: 2 }, currency: "USD", rates: [] })!;
    // The server counted 20 for the book, the ledger holds 5 of it: 20 spent in all against 30, and against 50 for all the books.
    expect(outlook.line).toMatchObject({ scope: "book", bookId: "b1", spent: 20 });
    expect(outlook.left).toBe(10);
  });

  it("counts the budgets that cannot limit the run, to say so", () => {
    const outlook = budgetOutlook({ plan: plan({ global: { USD: { month: 20 }, EUR: { month: 5 } } }), cost: { min: 1, max: 2 }, currency: "USD", rates: [] })!;
    expect(outlook.unlimited).toBe(1);
  });
});

describe("what an estimate gives the outlook", () => {
  it("is its cost and its currency, and the chapters it writes after the ones that are done", () => {
    expect(outlookOf({ cost: { min: 1, max: 2, currency: "EUR" }, chapters: 12, chaptersToWrite: 5 }, "USD")).toEqual({ cost: { min: 1, max: 2 }, currency: "EUR", chapters: { first: 8, count: 5, kind: "written" } });
    expect(outlookOf({ cost: null, chapters: 12, chaptersToWrite: 0 }, "USD")).toEqual({ cost: null, currency: "USD", chapters: null });
    expect(outlookOf({ cost: { min: 1, max: 2 }, chapters: 9, chaptersToWrite: 0 }, "USD", "designed").chapters).toEqual({ first: 1, count: 9, kind: "designed" });
    expect(outlookOf({ cost: { min: 1, max: 2 }, chapters: 12, chaptersToWrite: 5 }, "USD", null).chapters, "a review is not told by the number of a chapter").toBeNull();
  });
});
