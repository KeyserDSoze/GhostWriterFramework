/**
 * Numbers of the estimate of a run, for a person to read. The estimate is an interval made of rough assumptions, so its figures are
 * rounded to two significant figures and outward (the minimum down, the maximum up): what is shown always holds what the engine
 * computed, and no digit says more than the estimate knows. Everything here is a pure function of its arguments, in the language it is
 * given: the app's, which is not always the browser's.
 */

export interface Range {
  min: number;
  max: number;
}

/** The figures a count, a cost or a duration keeps. */
const FIGURES = 2;
/** Floating point is not exact: a value that is on a step by a hair is on it. */
const EPSILON = 1e-9;

type Direction = "down" | "up" | "nearest";

function positive(value: number): number {
  return Number.isFinite(value) && value > 0 ? value : 0;
}

/** `value` to two significant figures: 1234 → 1200, 9.02 → 9.1, 0.0071 → 0.0071, 99 → 99. */
function significant(value: number, direction: Direction): number {
  if (!(value > 0)) return 0;
  const places = FIGURES - 1 - Math.floor(Math.log10(value));
  const scale = 10 ** Math.abs(places);
  const scaled = places >= 0 ? value * scale : value / scale;
  const snapped = direction === "down" ? Math.floor(scaled * (1 + EPSILON)) : direction === "up" ? Math.ceil(scaled * (1 - EPSILON)) : Math.round(scaled);
  return places >= 0 ? snapped / scale : snapped * scale;
}

function roundOutward(range: Range): Range {
  const min = positive(range.min);
  const max = positive(range.max);
  if (min === max) {
    const only = significant(min, "nearest");
    return { min: only, max: only };
  }
  return { min: significant(min, "down"), max: significant(max, "up") };
}

/** A range of counts (calls, tokens, words) at two significant figures, widened and never narrowed. One number is rounded to the nearest. */
export function roundRange(range: Range): Range {
  return roundOutward(range);
}

/** A range of money, the same way. */
export function roundMoneyRange(range: Range): Range {
  return roundOutward(range);
}

/** The step a duration is rounded to, by its size: to the minute, five minutes, a quarter of an hour, half an hour, an hour, half a day. */
function minutesStep(minutes: number): number {
  if (minutes < 10) return 1;
  if (minutes < 60) return 5;
  if (minutes < 90) return 15;
  if (minutes < 600) return 30;
  if (minutes < 2880) return 60;
  return 720;
}

function roundMinutes(minutes: number, direction: "down" | "up" | "nearest"): number {
  const value = positive(minutes);
  if (value === 0) return 0;
  const step = minutesStep(value);
  const steps = value / step;
  const snapped = direction === "down" ? Math.floor(steps * (1 + EPSILON)) : direction === "up" ? Math.ceil(steps * (1 - EPSILON)) : Math.round(steps);
  return snapped * step;
}

/** A range of minutes in steps a person thinks in, widened and never narrowed. */
export function roundMinutesRange(range: Range): Range {
  const min = positive(range.min);
  const max = positive(range.max);
  if (min === max) {
    const only = roundMinutes(min, "nearest");
    return { min: only, max: only };
  }
  return { min: roundMinutes(min, "down"), max: roundMinutes(max, "up") };
}

const formatters = new Map<string, Intl.NumberFormat>();

function formatter(locale: string, options: Intl.NumberFormatOptions): Intl.NumberFormat {
  const key = `${locale}|${JSON.stringify(options)}`;
  let found = formatters.get(key);
  if (!found) {
    found = new Intl.NumberFormat(locale, options);
    formatters.set(key, found);
  }
  return found;
}

/** A whole number with the grouping of the language: 50,400 or 50.400. */
export function formatWhole(value: number, locale: string): string {
  return formatter(locale, {}).format(Math.round(positive(value)));
}

/** Tokens in words, as the language says them: «1.2 million», «1,2 milioni», «850 mila». */
export function formatTokens(value: number, locale: string): string {
  return formatter(locale, { notation: "compact", compactDisplay: "long", maximumSignificantDigits: FIGURES }).format(positive(value));
}

/** Money with its currency at two significant figures; a currency the platform does not know is written as the author wrote it. */
export function formatMoney(value: number, currency: string, locale: string): string {
  const amount = positive(value);
  try {
    return formatter(locale, { style: "currency", currency, maximumSignificantDigits: FIGURES }).format(amount);
  } catch {
    return `${formatter(locale, { maximumSignificantDigits: FIGURES }).format(amount)} ${currency}`;
  }
}

/** A duration with the unit that fits: minutes under an hour and a half, hours under two days, days after: «45 min», «1.5 hr», «2 days». */
export function formatMinutes(minutes: number, locale: string): string {
  const value = positive(minutes);
  const unit = value < 90 ? "minute" : value < 2880 ? "hour" : "day";
  const amount = unit === "minute" ? value : unit === "hour" ? value / 60 : value / 1440;
  return formatter(locale, { style: "unit", unit, unitDisplay: "short", maximumFractionDigits: unit === "minute" ? 0 : 1 }).format(amount);
}
