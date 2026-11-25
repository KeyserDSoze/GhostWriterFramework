import i18next from "i18next";
import { localDay } from "@/costs/period";
import { CURRENCY_CODE, rateBetween } from "@/costs/rates";
import type { CostExchangeRate, CostRelabel } from "@/types/settings";

export { CURRENCY_CODE, normalizeRates, normalizeRelabels, rateBetween } from "@/costs/rates";

/**
 * The one way the app writes money, and the rule for currencies (spec point 2):
 * - Every amount keeps the currency it was priced in. Prices are entered in the currency of the setting (`costCurrency`), so a call is priced in the
 *   currency the setting had when it was made, and a change of the setting changes the unit of the prices from then on, never of what was recorded.
 * - The setting is also the display currency, read live: every amount in it is written in it; an amount in another currency is written in its own
 *   currency, or, when the person gave an exchange rate for it (`costRates`, used for display only), converted, marked «≈» and said «converted at …».
 * - Different currencies are never added silently: totals are kept by currency (`MoneyTotals`); what has a rate to the display currency is converted
 *   into it, and the rest is written beside it as subtotals in its own currency.
 * - A relabel (`costRelabels`: «the amounts recorded as USD up to that day were really EUR») shows the amounts it names in the right currency, marked
 *   «relabelled» wherever they are, and changes nothing that is stored: removing it shows them as recorded again. It is applied where an amount meets its
 *   date (`moneyKey`), so a total keeps apart what was relabelled (`USD>EUR`) from what was recorded in the currency itself.
 */

/**
 * Amounts by the currency they are in: a code (`EUR`), or `FROM>TO` for amounts recorded as FROM that a relabel shows as TO. The empty currency (a call
 * without a price) is never an amount.
 */
export type MoneyTotals = Record<string, number>;

/** «1 `from` is `rate` `to`», given by the person in Settings (`costRates`); used only to show amounts in the display currency. */
export type ExchangeRate = CostExchangeRate;

/** What writing money needs: the display currency, the rates and the relabels, as the settings say now, and the language of the app. */
export interface MoneyContext {
  display: string;
  rates: readonly ExchangeRate[];
  relabels?: readonly CostRelabel[];
  locale?: string;
}

/**
 * The relabel that applies to an amount recorded in `currency` at `at`: an ISO moment, a day (`2026-11-25`), a month (`2026-11`), or nothing for an
 * amount that has no date (a total kept from before: an earlier one). It applies to the amounts recorded up to the day it was set, that day included.
 */
export function relabelFor(currency: string, at: string | undefined, relabels: readonly CostRelabel[] | undefined): CostRelabel | null {
  const relabel = relabels?.find((entry) => entry.from === currency);
  if (!relabel) return null;
  if (!at || !/^\d{4}-\d{2}/.test(at)) return relabel;
  const until = localDay(new Date(relabel.until));
  const day = /^\d{4}-\d{2}-\d{2}$/.test(at) ? at : /^\d{4}-\d{2}$/.test(at) ? at : localDay(new Date(at));
  return day.length === 7 ? (day <= until.slice(0, 7) ? relabel : null) : day <= until ? relabel : null;
}

/** The key of totals under which an amount recorded in `currency` at `at` is kept: its currency, or `FROM>TO` when a relabel names it. */
export function moneyKey(currency: string, at: string | undefined, relabels: readonly CostRelabel[] | undefined): string {
  const relabel = relabelFor(currency, at, relabels);
  return relabel ? `${relabel.from}>${relabel.to}` : currency;
}

/** The currency a key of totals is shown in, and what it was recorded as when a relabel names it. */
export function keyCurrency(key: string): { currency: string; recorded?: string } {
  const [recorded, shown] = key.split(">");
  return shown ? { currency: shown, recorded } : { currency: key };
}

function appLocale(context?: Pick<MoneyContext, "locale">): string | undefined {
  return context?.locale || i18next.resolvedLanguage || i18next.language || undefined;
}

export interface FormatMoneyOptions {
  locale?: string;
  /** `dash`: zero is written «—» (nothing spent); `amount` (the default): «€0.00». */
  zero?: "dash" | "amount";
  /** Significant figures instead of decimals: for an estimate, which is not precise to the cent. */
  significant?: number;
}

/**
 * An amount in a currency: two decimals from one unit up, up to four below it (a call costs fractions of a cent). A code the platform does not know is
 * written after the number, as the person wrote it.
 */
export function formatMoney(value: number, currency: string, options: FormatMoneyOptions = {}): string {
  const amount = Number.isFinite(value) ? value : 0;
  if (amount === 0 && options.zero === "dash") return "—";
  const locale = appLocale(options);
  const fraction: Intl.NumberFormatOptions = options.significant
    ? { maximumSignificantDigits: options.significant }
    : Math.abs(amount) < 1 && amount !== 0 ? { minimumFractionDigits: 2, maximumFractionDigits: 4 } : { minimumFractionDigits: 2, maximumFractionDigits: 2 };
  const code = currency.trim().toUpperCase();
  if (CURRENCY_CODE.test(code)) {
    try {
      return new Intl.NumberFormat(locale, { style: "currency", currency: code, ...fraction }).format(amount);
    } catch {
      // A code Intl refuses is written as text below.
    }
  }
  const number = new Intl.NumberFormat(locale, fraction).format(amount);
  return code ? `${number} ${code}` : number;
}

/** A part of a line of money: an amount in a currency, converted («≈») or not, holding relabelled amounts or not. */
export interface MoneyPart {
  amount: number;
  currency: string;
  converted: boolean;
  relabelled: boolean;
}

export interface MoneyView {
  /** The part that is in the display currency, converted or not; `null` when nothing is. */
  shown: MoneyPart | null;
  /** Whether `shown` holds converted amounts. */
  converted: boolean;
  /** The rates the conversion used. */
  rates: ExchangeRate[];
  /** What could not be converted, in its own currency: subtotals beside `shown`. */
  others: MoneyPart[];
  /** The relabels the amounts went through («recorded as USD, shown as EUR»). */
  relabelled: Array<{ from: string; to: string }>;
}

/** Amounts by currency as they are shown: in the display currency what is in it or can be converted to it, the rest beside it in its own. */
export function viewMoney(totals: MoneyTotals, context: MoneyContext): MoneyView {
  const shown: MoneyPart = { amount: 0, currency: context.display, converted: false, relabelled: false };
  let any = false;
  const used = new Map<string, ExchangeRate>();
  const relabelled = new Map<string, { from: string; to: string }>();
  const others = new Map<string, MoneyPart>();
  for (const [key, amount] of Object.entries(totals).sort(([left], [right]) => left.localeCompare(right))) {
    if (!key || !Number.isFinite(amount) || amount === 0) continue;
    const { currency, recorded } = keyCurrency(key);
    if (recorded) relabelled.set(key, { from: recorded, to: currency });
    if (currency === context.display) {
      shown.amount += amount;
      shown.relabelled ||= Boolean(recorded);
      any = true;
      continue;
    }
    const conversion = rateBetween(currency, context.display, context.rates);
    if (conversion) {
      shown.amount += amount * conversion.factor;
      shown.converted = true;
      shown.relabelled ||= Boolean(recorded);
      any = true;
      used.set(`${conversion.rate.from}>${conversion.rate.to}`, conversion.rate);
      continue;
    }
    const other = others.get(currency) ?? { amount: 0, currency, converted: false, relabelled: false };
    other.amount += amount;
    other.relabelled ||= Boolean(recorded);
    others.set(currency, other);
  }
  return { shown: any ? shown : null, converted: shown.converted, rates: [...used.values()], others: [...others.values()], relabelled: [...relabelled.values()] };
}

/** «converted at 1 USD = 0.92 EUR» (and the same in the other language), for the rates a conversion used. */
export function conversionNote(rates: readonly ExchangeRate[], locale?: string): string {
  if (!rates.length) return "";
  const number = new Intl.NumberFormat(appLocale({ locale }), { maximumSignificantDigits: 6 });
  const parts = rates.map((rate) => `1 ${rate.from} = ${number.format(rate.rate)} ${rate.to}`);
  return i18next.t("costs.money.convertedAt", { rates: parts.join(", "), defaultValue: `converted at ${parts.join(", ")}` });
}

/** «recorded as USD, shown as EUR» (and the same in the other language), for the relabels the amounts of a line went through. */
export function relabelNote(relabelled: ReadonlyArray<{ from: string; to: string }>): string {
  if (!relabelled.length) return "";
  const parts = relabelled.map((entry) => i18next.t("costs.money.relabelledAs", { from: entry.from, to: entry.to, defaultValue: `recorded as ${entry.from}, shown as ${entry.to}` }));
  return parts.join(", ");
}

/** The mark of a part that holds relabelled amounts, after its figure: always in words, never a colour or a sign alone. */
export function relabelledMark(): string {
  return i18next.t("costs.money.relabelledMark", { defaultValue: "(relabelled)" });
}

function partText(part: MoneyPart, locale: string | undefined): string {
  return `${part.converted ? "≈ " : ""}${formatMoney(part.amount, part.currency, { locale })}${part.relabelled ? ` ${relabelledMark()}` : ""}`;
}

/**
 * Amounts by currency in one line: «€0.12», «€0.12 + $0.16» (subtotals: never added), «≈ €0.27» (converted), «€0.16 (relabelled)». `empty` is what
 * nothing spent reads as. The notes of a conversion and of a relabel are not in the line: `conversionNote` and `relabelNote` say them where there is
 * room (the `MoneyText` component).
 */
export function formatTotals(totals: MoneyTotals, context: MoneyContext, options: { empty?: string } = {}): string {
  const view = viewMoney(totals, context);
  const parts: string[] = [];
  if (view.shown) parts.push(partText(view.shown, context.locale));
  for (const other of view.others) parts.push(partText(other, context.locale));
  return parts.length ? parts.join(" + ") : options.empty ?? formatMoney(0, context.display, { locale: context.locale });
}

/**
 * One amount recorded in `currency` (absent: the setting's) at `at` (absent: an earlier amount), in its own currency, or in the display currency when it is
 * that one or has a rate to it (then marked «≈»), and in the currency a relabel says it really was (then marked «relabelled»).
 */
export function formatAmount(value: number, currency: string | undefined, context: MoneyContext, options: { zero?: "dash" | "amount"; at?: string } = {}): string {
  if (!value && options.zero === "dash") return "—";
  const recorded = currency || context.display;
  return formatTotals({ [moneyKey(recorded, options.at, context.relabels)]: value || 0 }, context, { empty: formatMoney(0, recorded, { locale: context.locale }) });
}

/** Adds an amount to totals by currency (`currency` is a key: a code, or `FROM>TO`). */
export function addMoney(totals: MoneyTotals, currency: string, amount: number): MoneyTotals {
  if (!currency || !Number.isFinite(amount) || amount === 0) return totals;
  return { ...totals, [currency]: (totals[currency] ?? 0) + amount };
}

/** Adds an amount recorded in `currency` at `at`, under the key its relabel gives it (see `moneyKey`). */
export function addRecordedMoney(totals: MoneyTotals, currency: string, amount: number, at: string | undefined, relabels: readonly CostRelabel[] | undefined): MoneyTotals {
  return currency ? addMoney(totals, moneyKey(currency, at, relabels), amount) : totals;
}
