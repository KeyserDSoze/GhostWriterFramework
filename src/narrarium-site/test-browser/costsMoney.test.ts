import { afterEach, describe, expect, it } from "vitest";
import i18next from "@/i18n";
import "@/i18n/costs";
import { addMoney, conversionNote, formatAmount, formatMoney, formatTotals, normalizeRates, rateBetween, viewMoney, type MoneyContext } from "@/costs/money";
import { moneyContextOf } from "@/costs/useMoney";

const EUR: MoneyContext = { display: "EUR", rates: [], locale: "en" };
const withRate = (rate = 0.92): MoneyContext => ({ ...EUR, rates: [{ from: "USD", to: "EUR", rate }] });

afterEach(async () => { await i18next.changeLanguage("en"); });

describe("the one formatter of money", () => {
  it("writes an amount in its currency, in the language of the app: fractions of a cent below one unit, two decimals above", () => {
    expect(formatMoney(0.1586, "USD", { locale: "en" })).toBe("$0.1586");
    expect(formatMoney(0.1586, "USD", { locale: "it" }).replace(/\u00a0/g, " ")).toBe("0,1586 USD");
    expect(formatMoney(12.345, "EUR", { locale: "en" })).toBe("€12.35");
    expect(formatMoney(0.5, "EUR", { locale: "en" })).toBe("€0.50");
  });

  it("writes nothing spent as «—» where asked, and a code the platform does not know after the number", () => {
    expect(formatMoney(0, "EUR", { zero: "dash" })).toBe("—");
    expect(formatMoney(0, "EUR", { locale: "en" })).toBe("€0.00");
    expect(formatMoney(2, "XYZ1", { locale: "en" })).toBe("2.00 XYZ1");
  });
});

describe("currencies are never added silently", () => {
  it("keeps subtotals by currency when there is no rate", () => {
    const totals = addMoney(addMoney({}, "EUR", 0.12), "USD", 0.16);
    expect(formatTotals(totals, EUR)).toBe("€0.12 + $0.16");
    expect(viewMoney(totals, EUR)).toMatchObject({ shown: { amount: 0.12, currency: "EUR" }, converted: false, others: [{ amount: 0.16, currency: "USD" }] });
  });

  it("converts with the rate the person gave, marks it «≈», and says which rate", () => {
    const totals = { EUR: 0.12, USD: 0.16 };
    expect(formatTotals(totals, withRate())).toBe("≈ €0.2672");
    expect(viewMoney(totals, withRate()).rates).toEqual([{ from: "USD", to: "EUR", rate: 0.92 }]);
    expect(conversionNote([{ from: "USD", to: "EUR", rate: 0.92 }], "en")).toBe("converted at 1 USD = 0.92 EUR");
  });

  it("uses a rate given the other way round, as its inverse", () => {
    const context: MoneyContext = { display: "USD", rates: [{ from: "USD", to: "EUR", rate: 0.8 }], locale: "en" };
    expect(rateBetween("EUR", "USD", context.rates)?.factor).toBeCloseTo(1.25, 12);
    expect(formatTotals({ EUR: 2 }, context)).toBe("≈ $2.50");
  });

  it("shows an amount in the display currency as it is, never relabelled, and one in another currency in its own without a rate", () => {
    expect(formatAmount(0.1586, "EUR", EUR)).toBe("€0.1586");
    expect(formatAmount(0.1586, "USD", EUR)).toBe("$0.1586");
    expect(formatAmount(0.1586, undefined, EUR), "an amount without a recorded currency is the setting's").toBe("€0.1586");
    expect(formatAmount(0, "USD", EUR, { zero: "dash" })).toBe("—");
  });

  it("follows a change of the setting at once: the same amount reads in the new display currency only through a rate", () => {
    const amount = { USD: 1 };
    expect(formatTotals(amount, { display: "USD", rates: [], locale: "en" })).toBe("$1.00");
    expect(formatTotals(amount, { display: "EUR", rates: [], locale: "en" })).toBe("$1.00");
    expect(formatTotals(amount, withRate(0.9))).toBe("≈ €0.90");
  });

  it("ignores the empty currency (a call without a price) and amounts of nothing", () => {
    expect(formatTotals({ "": 5, EUR: 0 }, EUR)).toBe("€0.00");
    expect(formatTotals({}, EUR, { empty: "—" })).toBe("—");
  });
});

describe("the exchange rates of the settings", () => {
  it("keep only what can be used: two different three-letter codes and a positive rate, the first of each pair", () => {
    expect(normalizeRates([
      { from: "USD", to: "EUR", rate: 0.92 },
      { from: "EUR", to: "USD", rate: 1.1 },
      { from: "usd", to: "EUR", rate: 1 },
      { from: "GBP", to: "GBP", rate: 1 },
      { from: "GBP", to: "EUR", rate: 0 },
      { from: "CHF", to: "EUR", rate: Number.NaN },
      "nonsense",
      { from: "JPY", to: "EUR", rate: 0.0062 },
    ])).toEqual([{ from: "USD", to: "EUR", rate: 0.92 }, { from: "JPY", to: "EUR", rate: 0.0062 }]);
    expect(normalizeRates(undefined)).toEqual([]);
  });

  it("make the money context of the settings: their currency, «USD» when they have none", () => {
    expect(moneyContextOf({ costCurrency: "eur", costRates: [{ from: "USD", to: "EUR", rate: 0.9 }] })).toEqual({ display: "EUR", rates: [{ from: "USD", to: "EUR", rate: 0.9 }] });
    expect(moneyContextOf({ costCurrency: "" }).display).toBe("USD");
  });
});

describe("the note of a conversion in the other language", () => {
  it("is said in Italian too", async () => {
    await i18next.changeLanguage("it");
    expect(conversionNote([{ from: "USD", to: "EUR", rate: 0.92 }], "it")).toBe("convertito a 1 USD = 0,92 EUR");
  });
});
