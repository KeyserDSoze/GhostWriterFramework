import { afterEach, describe, expect, it } from "vitest";
import i18next from "@/i18n";
import "@/i18n/costs";
import { emptyCounters, type UsageRow } from "@/costs/ledger";
import { EARLIER } from "@/costs/legacyCosts";
import { addRecordedMoney, formatAmount, formatTotals, keyCurrency, moneyKey, relabelFor, relabelNote, viewMoney, type MoneyContext } from "@/costs/money";
import { normalizeRelabels } from "@/costs/rates";
import { summarize } from "@/costs/usageViews";

/** «The amounts recorded as USD until the 10th of November were really EUR»: set at noon, so that the day is the same in every time zone of the tests. */
const RELABEL = { from: "USD", to: "EUR", until: "2026-11-10T12:00:00.000Z" };
const EUR: MoneyContext = { display: "EUR", rates: [], relabels: [RELABEL], locale: "en" };

const row = (patch: Partial<UsageRow>): UsageRow => ({ ...emptyCounters(), period: "2026-11-09", bookId: "book-1", source: "autopilot", capability: "autopilot", integrationId: "int-1", model: "gpt-5", currency: "USD", writer: "device@1", ...patch });

afterEach(async () => { await i18next.changeLanguage("en"); });

describe("a relabel names the amounts recorded in a currency up to the day it was set", () => {
  it("names a day up to the one it was set, and none after it", () => {
    expect(relabelFor("USD", "2026-11-09", [RELABEL])).toEqual(RELABEL);
    expect(relabelFor("USD", "2026-11-10", [RELABEL]), "the day it was set").toEqual(RELABEL);
    expect(relabelFor("USD", "2026-11-11", [RELABEL])).toBeNull();
  });

  it("names a month (the rows compaction made of old days) up to its own, a moment by its day, and the «earlier» amounts", () => {
    expect(relabelFor("USD", "2026-10", [RELABEL])).toEqual(RELABEL);
    expect(relabelFor("USD", "2026-11", [RELABEL])).toEqual(RELABEL);
    expect(relabelFor("USD", "2026-12", [RELABEL])).toBeNull();
    expect(relabelFor("USD", "2026-11-09T08:00:00.000Z", [RELABEL])).toEqual(RELABEL);
    expect(relabelFor("USD", "2026-11-20T08:00:00.000Z", [RELABEL])).toBeNull();
    expect(relabelFor("USD", undefined, [RELABEL]), "an amount of no moment is an earlier one").toEqual(RELABEL);
    expect(relabelFor("USD", EARLIER, [RELABEL])).toEqual(RELABEL);
  });

  it("never names another currency, and nothing without a relabel", () => {
    expect(relabelFor("GBP", "2026-11-09", [RELABEL])).toBeNull();
    expect(relabelFor("EUR", "2026-11-09", [RELABEL])).toBeNull();
    expect(relabelFor("USD", "2026-11-09", [])).toBeNull();
    expect(relabelFor("USD", "2026-11-09", undefined)).toBeNull();
  });

  it("keeps a relabelled amount under a key of its own, that says what it was recorded as", () => {
    expect(moneyKey("USD", "2026-11-09", [RELABEL])).toBe("USD>EUR");
    expect(moneyKey("USD", "2026-11-11", [RELABEL])).toBe("USD");
    expect(keyCurrency("USD>EUR")).toEqual({ currency: "EUR", recorded: "USD" });
    expect(keyCurrency("USD")).toEqual({ currency: "USD" });
    expect(addRecordedMoney(addRecordedMoney({}, "USD", 0.1, "2026-11-09", [RELABEL]), "USD", 0.2, "2026-11-12", [RELABEL])).toEqual({ "USD>EUR": 0.1, USD: 0.2 });
    expect(addRecordedMoney({}, "", 0.1, "2026-11-09", [RELABEL]), "an amount of no currency is not money").toEqual({});
  });
});

describe("relabelled amounts are shown in the right currency, always marked", () => {
  it("shows an amount it names in the currency it names, with the mark", () => {
    expect(formatAmount(0.16, "USD", EUR, { at: "2026-11-09" })).toBe("€0.16 (relabelled)");
    expect(formatAmount(0.16, "USD", EUR, { at: "2026-11-11" }), "after the day it was set: as recorded").toBe("$0.16");
    expect(formatAmount(0.16, "USD", { ...EUR, relabels: [] }, { at: "2026-11-09" }), "without the relabel: as recorded").toBe("$0.16");
  });

  it("adds relabelled amounts to the amounts of the currency they are shown in, and says so", () => {
    const totals = { "USD>EUR": 0.16, EUR: 0.12 };
    expect(formatTotals(totals, EUR)).toBe("€0.28 (relabelled)");
    expect(viewMoney(totals, EUR).relabelled).toEqual([{ from: "USD", to: "EUR" }]);
    expect(formatTotals({ EUR: 0.12 }, EUR), "no mark where nothing was relabelled").toBe("€0.12");
  });

  it("converts a relabel to another display currency with a rate, and keeps the mark", () => {
    const context: MoneyContext = { display: "GBP", rates: [{ from: "EUR", to: "GBP", rate: 0.5 }], relabels: [RELABEL], locale: "en" };
    expect(formatTotals({ "USD>EUR": 0.2 }, context)).toBe("≈ £0.10 (relabelled)");
  });

  it("says what a relabel did, in both languages", async () => {
    expect(relabelNote([{ from: "USD", to: "EUR" }])).toBe("recorded as USD, shown as EUR");
    expect(relabelNote([])).toBe("");
    await i18next.changeLanguage("it");
    expect(relabelNote([{ from: "USD", to: "EUR" }])).toBe("registrato come USD, mostrato come EUR");
    expect(formatTotals({ "USD>EUR": 0.16 }, { ...EUR, locale: "it" }).replace(/\u00a0/g, " ")).toBe("0,16 € (rietichettato)");
  });
});

describe("the relabels of the settings", () => {
  it("keep only what can be used: two different codes and a moment, the last one given for each recorded currency", () => {
    expect(normalizeRelabels([
      RELABEL,
      { from: "usd", to: "EUR", until: RELABEL.until },
      { from: "GBP", to: "GBP", until: RELABEL.until },
      { from: "JPY", to: "EUR", until: "not a date" },
      { from: "CHF", to: "EUR" },
      null,
      "USD>EUR",
      { from: "USD", to: "GBP", until: "2026-11-12T12:00:00.000Z" },
    ])).toEqual([{ from: "USD", to: "GBP", until: "2026-11-12T12:00:00.000Z" }]);
    expect(normalizeRelabels(undefined)).toEqual([]);
    expect(normalizeRelabels({})).toEqual([]);
  });
});

describe("a relabel never rewrites what was recorded", () => {
  it("sums the rows it names under its key, by the day of each row, and leaves the rows as they were", () => {
    const rows = [row({ period: "2026-11-09", cost: 0.1 }), row({ period: "2026-11-12", cost: 0.2 }), row({ period: EARLIER, writer: EARLIER, cost: 0.05 }), row({ period: "2026-11-09", currency: "EUR", cost: 0.3 })];
    const before = JSON.stringify(rows);
    const summary = summarize(rows, undefined, [RELABEL]);
    expect(summary.money["USD>EUR"]).toBeCloseTo(0.15, 12);
    expect(summary.money.USD).toBeCloseTo(0.2, 12);
    expect(summary.money.EUR).toBeCloseTo(0.3, 12);
    expect(JSON.stringify(rows), "the rows are the same").toBe(before);
  });

  it("shows the amounts as recorded again once it is removed", () => {
    const rows = [row({ period: "2026-11-09", cost: 0.1 }), row({ period: "2026-11-12", cost: 0.2 })];
    expect(summarize(rows, undefined, [RELABEL]).money).toEqual({ "USD>EUR": 0.1, USD: 0.2 });
    expect(summarize(rows, undefined, []).money.USD).toBeCloseTo(0.3, 12);
    expect(summarize(rows).money.USD).toBeCloseTo(0.3, 12);
  });

  it("names the estimates as it names the measured amounts, and keeps them apart", () => {
    const summary = summarize([row({ period: "2026-11-09", cost: 0.1, estimatedCost: 0.02, unknownUsageCalls: 1 })], undefined, [RELABEL]);
    expect(summary.money).toEqual({ "USD>EUR": 0.1 });
    expect(summary.estimated).toEqual({ "USD>EUR": 0.02 });
  });
});
