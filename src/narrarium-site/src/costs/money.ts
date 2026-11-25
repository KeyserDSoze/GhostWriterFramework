import i18next from "i18next";
import { CURRENCY_CODE, rateBetween } from "@/costs/rates";
import type { CostExchangeRate } from "@/types/settings";

export { CURRENCY_CODE, normalizeRates, rateBetween } from "@/costs/rates";

/**
 * The one way the app writes money, and the rule for currencies (spec point 2):
 * - Every amount keeps the currency it was priced in. Prices are entered in the currency of the setting (`costCurrency`), so a call is priced in the
 *   currency the setting had when it was made, and a change of the setting changes the unit of the prices from then on, never of what was recorded.
 * - The setting is also the display currency, read live: every amount in it is written in it; an amount in another currency is written in its own
 *   currency, or, when the person gave an exchange rate for it (`costRates`, used for display only), converted, marked «≈» and said «converted at …».
 * - Different currencies are never added silently: totals are kept by currency (`MoneyTotals`); what has a rate to the display currency is converted
 *   into it, and the rest is written beside it as subtotals in its own currency.
 */

/** Amounts by the currency they are in. The empty currency (a call without a price) is never an amount. */
export type MoneyTotals = Record<string, number>;

/** «1 `from` is `rate` `to`», given by the person in Settings (`costRates`); used only to show amounts in the display currency. */
export type ExchangeRate = CostExchangeRate;

/** What writing money needs: the display currency and the rates, as the settings say now, and the language of the app. */
export interface MoneyContext {
  display: string;
  rates: readonly ExchangeRate[];
  locale?: string;
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

export interface MoneyView {
  /** The part that is in the display currency, converted or not; `null` when nothing is. */
  shown: { amount: number; currency: string } | null;
  /** Whether `shown` holds converted amounts. */
  converted: boolean;
  /** The rates the conversion used. */
  rates: ExchangeRate[];
  /** What could not be converted, in its own currency: subtotals beside `shown`. */
  others: Array<{ amount: number; currency: string }>;
}

/** Amounts by currency as they are shown: in the display currency what is in it or can be converted to it, the rest beside it in its own. */
export function viewMoney(totals: MoneyTotals, context: MoneyContext): MoneyView {
  let shown = 0;
  let any = false;
  let converted = false;
  const used = new Map<string, ExchangeRate>();
  const others: MoneyView["others"] = [];
  for (const [currency, amount] of Object.entries(totals).sort(([left], [right]) => left.localeCompare(right))) {
    if (!currency || !Number.isFinite(amount) || amount === 0) continue;
    if (currency === context.display) {
      shown += amount;
      any = true;
      continue;
    }
    const conversion = rateBetween(currency, context.display, context.rates);
    if (conversion) {
      shown += amount * conversion.factor;
      any = true;
      converted = true;
      used.set(`${conversion.rate.from}>${conversion.rate.to}`, conversion.rate);
      continue;
    }
    others.push({ amount, currency });
  }
  return { shown: any ? { amount: shown, currency: context.display } : null, converted, rates: [...used.values()], others };
}

/** «converted at 1 USD = 0.92 EUR» (and the same in the other language), for the rates a conversion used. */
export function conversionNote(rates: readonly ExchangeRate[], locale?: string): string {
  if (!rates.length) return "";
  const number = new Intl.NumberFormat(appLocale({ locale }), { maximumSignificantDigits: 6 });
  const parts = rates.map((rate) => `1 ${rate.from} = ${number.format(rate.rate)} ${rate.to}`);
  return i18next.t("costs.money.convertedAt", { rates: parts.join(", "), defaultValue: `converted at ${parts.join(", ")}` });
}

/**
 * Amounts by currency in one line: «€0.12», «€0.12 + $0.16» (subtotals: never added), «≈ €0.27» (converted). `empty` is what nothing spent reads as.
 * The note of a conversion is not in the line: `viewMoney(...).rates` and `conversionNote` say it where there is room (see the `Money` component).
 */
export function formatTotals(totals: MoneyTotals, context: MoneyContext, options: { empty?: string } = {}): string {
  const view = viewMoney(totals, context);
  const parts: string[] = [];
  if (view.shown) parts.push(`${view.converted ? "≈ " : ""}${formatMoney(view.shown.amount, view.shown.currency, { locale: context.locale })}`);
  for (const other of view.others) parts.push(formatMoney(other.amount, other.currency, { locale: context.locale }));
  return parts.length ? parts.join(" + ") : options.empty ?? formatMoney(0, context.display, { locale: context.locale });
}

/** One amount in its own currency, in the display currency when it is that one or can be converted to it (then marked «≈»). */
export function formatAmount(value: number, currency: string | undefined, context: MoneyContext, options: { zero?: "dash" | "amount" } = {}): string {
  if (!value && options.zero === "dash") return "—";
  return formatTotals({ [currency || context.display]: value || 0 }, context, { empty: formatMoney(0, currency || context.display, { locale: context.locale }) });
}

/** Adds an amount to totals by currency. */
export function addMoney(totals: MoneyTotals, currency: string, amount: number): MoneyTotals {
  if (!currency || !Number.isFinite(amount) || amount === 0) return totals;
  return { ...totals, [currency]: (totals[currency] ?? 0) + amount };
}
