import type { CostExchangeRate } from "@/types/settings";

/** The exchange rates of the settings (`costRates`), on their own: the settings read them without the rest of `money.ts`. */

export const CURRENCY_CODE = /^[A-Z]{3}$/;

/** The settings' rates that can be used: three-letter codes, two different currencies, a positive finite rate; the first of each pair wins. */
export function normalizeRates(value: unknown): CostExchangeRate[] {
  if (!Array.isArray(value)) return [];
  const seen = new Set<string>();
  const rates: CostExchangeRate[] = [];
  for (const entry of value) {
    if (!entry || typeof entry !== "object") continue;
    const { from, to, rate } = entry as Partial<CostExchangeRate>;
    if (typeof from !== "string" || typeof to !== "string" || !CURRENCY_CODE.test(from) || !CURRENCY_CODE.test(to) || from === to) continue;
    if (typeof rate !== "number" || !Number.isFinite(rate) || rate <= 0) continue;
    const pair = [from, to].sort().join(">");
    if (seen.has(pair)) continue;
    seen.add(pair);
    rates.push({ from, to, rate });
  }
  return rates;
}

/** The factor that turns an amount in `from` into `to`: the rate given for the pair, or the inverse of the one given the other way; `null` without one. */
export function rateBetween(from: string, to: string, rates: readonly CostExchangeRate[]): { factor: number; rate: CostExchangeRate } | null {
  if (from === to) return null;
  const direct = rates.find((rate) => rate.from === from && rate.to === to);
  if (direct) return { factor: direct.rate, rate: direct };
  const inverse = rates.find((rate) => rate.from === to && rate.to === from);
  return inverse ? { factor: 1 / inverse.rate, rate: inverse } : null;
}

