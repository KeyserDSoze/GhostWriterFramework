import { useMemo } from "react";
import { useTranslation } from "react-i18next";
import { formatAmount, formatTotals, normalizeRates, normalizeRelabels, type MoneyContext, type MoneyTotals } from "@/costs/money";
import { useSettingsStore } from "@/store/settingsStore";
import type { AppSettings } from "@/types/settings";

/** The display currency, the rates and the relabels of some settings: the currency of the setting, "USD" when there is none. */
export function moneyContextOf(settings: Pick<AppSettings, "costCurrency" | "costRates" | "costRelabels">, locale?: string): MoneyContext {
  return { display: (settings.costCurrency || "USD").trim().toUpperCase(), rates: normalizeRates(settings.costRates), relabels: normalizeRelabels(settings.costRelabels), ...(locale ? { locale } : {}) };
}

/** The money context of the settings as they are now: for code that writes money outside a component. A component uses `useMoney`, which follows them. */
export function moneyContextNow(): MoneyContext {
  return moneyContextOf(useSettingsStore.getState().settings);
}

export interface Money extends MoneyContext {
  /** One amount recorded in `currency` at `at` (absent: an earlier one), in its own currency, in the display currency when it is that one or has a rate to it, relabelled when a relabel names it. */
  amount: (value: number | undefined, currency?: string, options?: { zero?: "dash" | "amount"; at?: string }) => string;
  /** Amounts by currency, as one line (subtotals, or converted). */
  totals: (totals: MoneyTotals, options?: { empty?: string }) => string;
}

/**
 * The way a component writes money: the currency, the rates and the relabels of the settings and the language of the app, followed live, so that a change
 * of any of them shows at once, without a reload, everywhere money is shown.
 */
export function useMoney(): Money {
  const display = useSettingsStore((store) => store.settings.costCurrency);
  const rates = useSettingsStore((store) => store.settings.costRates);
  const relabels = useSettingsStore((store) => store.settings.costRelabels);
  const { i18n } = useTranslation();
  const locale = i18n.resolvedLanguage || i18n.language;
  return useMemo(() => {
    const context = moneyContextOf({ costCurrency: display, costRates: rates, costRelabels: relabels }, locale);
    return {
      ...context,
      amount: (value, currency, options) => formatAmount(value ?? 0, currency, context, options),
      totals: (totals, options) => formatTotals(totals, context, options),
    };
  }, [display, rates, relabels, locale]);
}
