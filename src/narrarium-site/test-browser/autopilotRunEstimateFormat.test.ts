import { describe, expect, it } from "vitest";
import { formatMinutes, formatMoney, formatTokens, formatWhole, roundMinutesRange, roundMoneyRange, roundRange } from "@/autopilot/runEstimateFormat";

describe("rounding a range of counts, outward, to two significant figures", () => {
  it("keeps what is small as it is and rounds what is big: no fake precision", () => {
    expect(roundRange({ min: 1234, max: 2097 })).toEqual({ min: 1200, max: 2100 });
    expect(roundRange({ min: 105_000, max: 395_000 })).toEqual({ min: 100_000, max: 400_000 });
    expect(roundRange({ min: 7, max: 12 })).toEqual({ min: 7, max: 12 });
    expect(roundRange({ min: 99, max: 100 })).toEqual({ min: 99, max: 100 });
    expect(roundRange({ min: 0, max: 0 })).toEqual({ min: 0, max: 0 });
  });

  it("never shrinks the range: what is shown holds what the engine said, ends included, and stays within a tenth of it", () => {
    const pairs: Array<[number, number]> = [[101, 109], [199, 1999], [1099, 1101], [34_567, 98_765], [1_049_038, 1_778_292], [151_168, 321_536], [999_999, 1_000_001], [12, 99]];
    for (const [min, max] of pairs) {
      const rounded = roundRange({ min, max });
      expect(rounded.min, `${min}`).toBeLessThanOrEqual(min);
      expect(rounded.max, `${max}`).toBeGreaterThanOrEqual(max);
      expect(min - rounded.min).toBeLessThanOrEqual(min * 0.1);
      expect(rounded.max - max).toBeLessThanOrEqual(max * 0.1);
    }
  });

  it("rounds one number to the nearest, and does not make a range of it", () => {
    expect(roundRange({ min: 2101, max: 2101 })).toEqual({ min: 2100, max: 2100 });
    expect(roundRange({ min: 2160, max: 2160 })).toEqual({ min: 2200, max: 2200 });
  });

  it("takes anything that is not a count as nothing", () => {
    expect(roundRange({ min: Number.NaN, max: Number.POSITIVE_INFINITY })).toEqual({ min: 0, max: 0 });
    expect(roundRange({ min: -5, max: 3 })).toEqual({ min: 0, max: 3 });
  });
});

describe("numbers, in the language of the page", () => {
  it("writes a whole number with the grouping of the language", () => {
    expect(formatWhole(50_400, "en")).toBe("50,400");
    expect(formatWhole(50_400, "it")).toBe("50.400");
    expect(formatWhole(480, "it")).toBe("480");
  });

  it("writes tokens in words, the way the language says a million: no digits that mean nothing", () => {
    expect(formatTokens(1_200_000, "en")).toBe("1.2 million");
    expect(formatTokens(1_200_000, "it")).toBe("1,2 milioni");
    expect(formatTokens(850_000, "en")).toBe("850 thousand");
    expect(formatTokens(850_000, "it")).toBe("850 mila");
    expect(formatTokens(480, "en")).toBe("480");
  });

  it("writes money with its currency, at two significant figures", () => {
    expect(formatMoney(4.3, "EUR", "en")).toBe("€4.3");
    expect(formatMoney(4.3, "EUR", "it")).toBe("4,3\u00a0€");
    expect(formatMoney(1200, "USD", "en")).toBe("$1,200");
    expect(formatMoney(0.0034, "USD", "en")).toBe("$0.0034");
  });

  it("writes a currency that is not one as the text the author put there, and a price of zero as zero", () => {
    expect(formatMoney(4.3, "XY", "en")).toBe("4.3 XY");
    expect(formatMoney(0, "USD", "en")).toBe("$0");
  });
});

describe("money, outward", () => {
  it("rounds the ends of a range of cost the same way", () => {
    expect(roundMoneyRange({ min: 3.41, max: 9.02 })).toEqual({ min: 3.4, max: 9.1 });
    expect(roundMoneyRange({ min: 0.0034, max: 0.0071 })).toEqual({ min: 0.0034, max: 0.0071 });
    expect(roundMoneyRange({ min: 0, max: 0 })).toEqual({ min: 0, max: 0 });
    expect(roundMoneyRange({ min: 12.34, max: 12.34 })).toEqual({ min: 12, max: 12 });
  });
});

describe("minutes, outward, in steps a person can think in", () => {
  it("rounds to five minutes, to the half hour, to the hour and to the half day as the figure grows", () => {
    expect(roundMinutesRange({ min: 37, max: 52 })).toEqual({ min: 35, max: 55 });
    expect(roundMinutesRange({ min: 4.2, max: 8.9 })).toEqual({ min: 4, max: 9 });
    expect(roundMinutesRange({ min: 95, max: 310 })).toEqual({ min: 90, max: 330 });
    expect(roundMinutesRange({ min: 700, max: 1500 })).toEqual({ min: 660, max: 1500 });
    expect(roundMinutesRange({ min: 3000, max: 9000 })).toEqual({ min: 2880, max: 9360 });
  });

  it("never shrinks the range", () => {
    for (const [min, max] of [[1, 3], [11, 14], [59, 61], [119, 121], [599, 601], [2879, 2881], [10_000, 30_001]] as Array<[number, number]>) {
      const rounded = roundMinutesRange({ min, max });
      expect(rounded.min).toBeLessThanOrEqual(min);
      expect(rounded.max).toBeGreaterThanOrEqual(max);
    }
  });

  it("writes a duration with the unit that fits, in the language of the page", () => {
    expect(formatMinutes(45, "en")).toBe("45 min");
    expect(formatMinutes(90, "en")).toBe("1.5 hr");
    expect(formatMinutes(90, "it")).toBe("1,5 h");
    expect(formatMinutes(840, "en")).toBe("14 hr");
    expect(formatMinutes(2880, "en")).toBe("2 days");
    expect(formatMinutes(2880, "it")).toBe("2 giorni");
  });
});
