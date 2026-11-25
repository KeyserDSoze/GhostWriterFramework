import { describe, expect, it } from "vitest";
import { emptyCounters, type UsageRow } from "@/costs/ledger";
import { inMonth, summarize, summarizeBy, totalTokens, unpricedModels } from "@/costs/usageViews";

const row = (patch: Partial<UsageRow>): UsageRow => ({ ...emptyCounters(), period: "2026-11-25", bookId: "book-1", source: "autopilot", capability: "autopilot", integrationId: "int-1", model: "gpt-5", currency: "EUR", writer: "w", ...patch });

describe("the sums of the ledger that a person reads", () => {
  const rows = [
    row({ calls: 2, tasks: 1, inputTokens: 100, outputTokens: 10, cost: 0.5 }),
    row({ currency: "USD", calls: 1, tasks: 1, cost: 0.25, source: "copilot" }),
    row({ currency: "", model: "free", integrationId: "int-2", calls: 3, unpricedCalls: 3, inputTokens: 50 }),
    row({ period: "2026-10", calls: 1, cost: 1, unknownUsageCalls: 1, estimatedInputTokens: 900, estimatedCost: 0.02 }),
    row({ period: "earlier", writer: "earlier", cost: 7, model: "" }),
  ];

  it("keeps money by currency, and the estimates apart from it", () => {
    const summary = summarize(rows);
    expect(summary.money).toEqual({ EUR: 8.5, USD: 0.25 });
    expect(summary.estimated).toEqual({ EUR: 0.02 });
    expect(summary).toMatchObject({ calls: 7, tasks: 2, inputTokens: 150, unpricedCalls: 3, unknownUsageCalls: 1, estimatedInputTokens: 900, rows: 5 });
    expect(totalTokens(summary)).toBe(160);
  });

  it("tells a month by its days and by the month compaction made of them, and the «earlier» part by neither", () => {
    expect(rows.filter((entry) => inMonth(entry, "2026-11"))).toHaveLength(3);
    expect(rows.filter((entry) => inMonth(entry, "2026-10"))).toHaveLength(1);
    expect(summarize(rows, (entry) => inMonth(entry, "2026-11")).money).toEqual({ EUR: 0.5, USD: 0.25 });
  });

  it("groups by what is asked, leaving out what has no group", () => {
    const bySource = summarizeBy(rows, (entry) => (entry.writer === "earlier" ? null : entry.source));
    expect([...bySource.keys()].sort()).toEqual(["autopilot", "copilot"]);
    expect(bySource.get("copilot")?.money).toEqual({ USD: 0.25 });
  });

  it("names the models used without a price, with their integration and their calls, the most used first", () => {
    expect(unpricedModels([...rows, row({ currency: "", model: "other", calls: 1, unpricedCalls: 1 }), row({ currency: "", model: "free", integrationId: "int-2", unpricedCalls: 2 })])).toEqual([
      { integrationId: "int-2", model: "free", calls: 5 },
      { integrationId: "int-1", model: "other", calls: 1 },
    ]);
  });
});
