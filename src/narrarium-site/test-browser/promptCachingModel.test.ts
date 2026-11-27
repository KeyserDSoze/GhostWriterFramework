import { describe, expect, it } from "vitest";
import { cacheHitRates, cacheLines, cacheTotals } from "@/costs/cacheModel";
import { cachedSaving, cachedShare } from "@/costs/cacheSavings";
import { COUNTER_FIELDS, decodeCounters, emptyCounters, encodeCounters, localDay, type UsageRow } from "@/costs/ledger";
import { countersOf } from "@/costs/recordUsage";
import { summarize } from "@/costs/usageViews";
import { chatDelta } from "@/costs/costsStore";

// What the providers' prompt caches did, from the rows of the ledger: the share of the input served from a cache, the money it saved against the full input rate, by model and use, and the measured rate of a
// model that the estimate counts on. The counter that keeps the saving is a new one at the end of a row, which a row from before it simply does not have.

const row = (values: Partial<UsageRow>): UsageRow => ({ ...emptyCounters(), writer: "w", period: localDay(new Date()), bookId: "b", source: "autopilot", capability: "autopilot", integrationId: "i", model: "gpt-5", currency: "EUR", calls: 1, ...values });
const daysAgo = (days: number): string => localDay(new Date(Date.now() - days * 86_400_000));

describe("the saving of a call", () => {
  it("is what the cached tokens did not cost against the full input rate, and nothing without both prices or when the cached price is not lower", () => {
    expect(cachedSaving(1_000_000, { inputPerMTok: 10, cachedPerMTok: 1 })).toBeCloseTo(9);
    expect(cachedSaving(1280, { inputPerMTok: 2, cachedPerMTok: 1 })).toBeCloseTo(0.00128);
    expect(cachedSaving(1280, { inputPerMTok: 2 })).toBe(0);
    expect(cachedSaving(1280, { cachedPerMTok: 1 })).toBe(0);
    expect(cachedSaving(1280, { inputPerMTok: 2, cachedPerMTok: 2 })).toBe(0);
    expect(cachedSaving(1280, { inputPerMTok: 2, cachedPerMTok: 5 })).toBe(0);
    expect(cachedSaving(0, { inputPerMTok: 2, cachedPerMTok: 1 })).toBe(0);
    expect(cachedSaving(Number.NaN, { inputPerMTok: 2, cachedPerMTok: 1 })).toBe(0);
    expect(cachedSaving(100, undefined)).toBe(0);
  });

  it("is a share of the input: 0 to 1, and 0 without input", () => {
    expect(cachedShare(2000, 1280)).toBeCloseTo(0.64);
    expect(cachedShare(2000, 0)).toBe(0);
    expect(cachedShare(0, 10)).toBe(0);
    expect(cachedShare(100, 500)).toBe(1);
  });

  it("is recorded in the counters of a call that was measured and priced, and in no other", () => {
    const base = { usage: { inputTokens: 2000, cachedTokens: 1280, outputTokens: 5 }, usageKnown: true, cost: 0.003, costKnown: true, priced: true } as const;
    expect(countersOf({ ...base, saved: 0.00128 }, true).cachedSavings).toBe(0.00128);
    expect(countersOf({ ...base }, true).cachedSavings, "nothing saved, nothing said").toBeUndefined();
    expect(countersOf({ ...base, saved: 0 }, true).cachedSavings).toBeUndefined();
    expect(countersOf({ ...base, costKnown: false, saved: 0.00128 }, true).cachedSavings, "an estimated cost saves nothing that was measured").toBeUndefined();
    expect(countersOf({ ...base, usageKnown: false, saved: 0.00128 }, true).cachedSavings).toBeUndefined();
    expect(countersOf({ ...base, priced: false, cost: undefined, saved: 0.00128 }, true).cachedSavings).toBeUndefined();
  });

  it("agrees with the engine's price of the tokens a provider wrote to its cache", () => {
    const pricing = { inputPerMTok: 10, cachedPerMTok: 1, cacheWritePerMTok: 12.5, outputPerMTok: 40 };
    const delta = chatDelta({ inputTokens: 10_000, cachedTokens: 6_000, outputTokens: 1_000, cacheWriteTokens: 2_000 }, pricing);
    expect(delta.chatCost).toBeCloseTo((2_000 * 10 + 6_000 * 1 + 2_000 * 12.5 + 1_000 * 40) / 1e6, 12);
    expect(chatDelta({ inputTokens: 10_000, cachedTokens: 6_000, outputTokens: 1_000 }, { inputPerMTok: 10, cachedPerMTok: 1, outputPerMTok: 40 }).chatCost, "no write, as it was").toBeCloseTo((4_000 * 10 + 6_000 + 40_000) / 1e6, 12);
  });
});

describe("the counter of the saving in a row of the ledger", () => {
  it("is the last of the counters, kept in the text of a row, and a row without it reads as none", () => {
    expect(COUNTER_FIELDS[COUNTER_FIELDS.length - 1]).toBe("cachedSavings");
    const counters = { ...emptyCounters(), calls: 2, inputTokens: 4000, cachedTokens: 2560, cost: 0.01, cachedSavings: 0.00256 };
    const text = encodeCounters(counters);
    expect(decodeCounters(text).counters).toEqual(counters);
    // A row that never had it is written exactly as it was (no trailing figure) and read as none.
    const before = { ...emptyCounters(), calls: 2, inputTokens: 4000, cost: 0.01 };
    const old = encodeCounters(before);
    expect(old.split(" ").length).toBeLessThanOrEqual(11);
    expect(decodeCounters(old).counters.cachedSavings).toBe(0);
  });

  it("is summed with the other rows, by currency, and kept apart from what was paid", () => {
    const summary = summarize([row({ cost: 1, cachedSavings: 0.5 }), row({ cost: 2, cachedSavings: 0.25 }), row({ currency: "USD", cost: 3, cachedSavings: 1 })]);
    expect(summary.saved).toEqual({ EUR: 0.75, USD: 1 });
    expect(summary.money).toEqual({ EUR: 3, USD: 3 });
  });
});

describe("what the caches did, from the rows", () => {
  const rows = [
    row({ model: "gpt-5", source: "autopilot", inputTokens: 10_000, cachedTokens: 6_000, cachedSavings: 0.05 }),
    row({ model: "gpt-5", source: "autopilot", inputTokens: 10_000, cachedTokens: 2_000, cachedSavings: 0.02, period: daysAgo(1) }),
    row({ model: "gpt-5", source: "copilot", inputTokens: 4_000, cachedTokens: 0 }),
    row({ model: "local-7b", source: "autopilot", integrationId: "j", inputTokens: 5_000, cachedTokens: 0 }),
    row({ model: "gpt-image", source: "media", capability: "image", inputTokens: 0, cachedTokens: 0 }),
    row({ model: "", source: "other", inputTokens: 100, cachedTokens: 100 }),
  ];

  it("totals the share of the input and the money saved, over the chat rows only", () => {
    const totals = cacheTotals(rows);
    expect(totals.inputTokens).toBe(29_000);
    expect(totals.cachedTokens).toBe(8_000);
    expect(totals.share).toBeCloseTo(8_000 / 29_000);
    expect(totals.saved.EUR).toBeCloseTo(0.07);
    expect(cacheTotals([])).toEqual({ inputTokens: 0, cachedTokens: 0, share: 0, saved: {} });
  });

  it("lists each model for each use, the ones a cache served first, then the others by their input", () => {
    const lines = cacheLines(rows);
    expect(lines.map((line) => [line.model, line.source, line.inputTokens, line.cachedTokens])).toEqual([
      ["gpt-5", "autopilot", 20_000, 8_000],
      ["local-7b", "autopilot", 5_000, 0],
      ["gpt-5", "copilot", 4_000, 0],
    ]);
    expect(lines[0].share).toBeCloseTo(0.4);
    expect(lines[0].saved.EUR).toBeCloseTo(0.07);
    expect(lines[1].share).toBe(0);
  });

  it("never counts more cached tokens than input tokens in a row", () => {
    expect(cacheTotals([row({ inputTokens: 100, cachedTokens: 900 })]).share).toBe(1);
  });
});

describe("the hit rate of a model that the estimate counts on", () => {
  const model = (values: Partial<UsageRow>) => row({ calls: 3, inputTokens: 9_000, cachedTokens: 3_000, ...values });

  it("is the share of its input served from its cache over the last two months, once it was asked a few times and showed a cache", () => {
    const rates = cacheHitRates([model({}), model({ period: daysAgo(10), cachedTokens: 6_000 })]);
    expect(rates["gpt-5"]).toBeCloseTo(9_000 / 18_000);
  });

  it("says nothing of a model that never reported a cached token (the prompts it was asked before may have been in another order), of too few calls or too few tokens, of old rows and of months", () => {
    expect(cacheHitRates([model({ cachedTokens: 0 })])).toEqual({});
    expect(cacheHitRates([model({ calls: 2 })])).toEqual({});
    expect(cacheHitRates([model({ inputTokens: 3_000, cachedTokens: 1_000 })])).toEqual({});
    expect(cacheHitRates([model({ period: daysAgo(90) })])).toEqual({});
    expect(cacheHitRates([model({ period: "2026-09" })]), "a month the ledger compacted is not a day").toEqual({});
    expect(cacheHitRates([model({ model: "" })])).toEqual({});
  });

  it("is kept by model, and clamped to the input", () => {
    const rates = cacheHitRates([model({ model: "a" }), model({ model: "b", cachedTokens: 99_999 })]);
    expect(Object.keys(rates).sort()).toEqual(["a", "b"]);
    expect(rates.b).toBe(1);
  });
});
