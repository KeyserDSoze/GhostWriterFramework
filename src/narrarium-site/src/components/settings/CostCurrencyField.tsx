import { useId, useState } from "react";
import { useTranslation } from "react-i18next";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Label } from "@/components/ui/label";
import { ServerCurrencyNote } from "@/components/autopilot/costs/ServerCurrencyNote";
import { useSettingsStore } from "@/store/settingsStore";
import "@/i18n/costs";

export const COST_CURRENCIES = [
  { value: "USD", labelKey: "settings.currencies.USD", fallback: "USD — US Dollar" },
  { value: "EUR", labelKey: "settings.currencies.EUR", fallback: "EUR — Euro" },
  { value: "GBP", labelKey: "settings.currencies.GBP", fallback: "GBP — British Pound" },
  { value: "JPY", labelKey: "settings.currencies.JPY", fallback: "JPY — Japanese Yen" },
  { value: "CHF", labelKey: "settings.currencies.CHF", fallback: "CHF — Swiss Franc" },
  { value: "CAD", labelKey: "settings.currencies.CAD", fallback: "CAD — Canadian Dollar" },
  { value: "AUD", labelKey: "settings.currencies.AUD", fallback: "AUD — Australian Dollar" },
] as const;

/**
 * The currency of the prices and of every cost shown (`costCurrency`), where the prices are entered and in Settings › Costs. A change made here says at once what
 * it changes (the unit of the prices from now on, never what was recorded), and, when a book runs on the personal server, offers to send the server the
 * configuration with the new currency: the server prices in the one it was last sent. Settings that arrive later (a load) say nothing.
 */
export function CostCurrencyField({ className }: { className?: string }) {
  const { t } = useTranslation();
  const id = useId();
  const currency = useSettingsStore((state) => state.settings.costCurrency || "USD");
  const onServer = useSettingsStore((state) => state.settings.books.some((book) => book.autopilotHost === "server"));
  const patchSettings = useSettingsStore((state) => state.patchSettings);
  const [chosen, setChosen] = useState<string | null>(null);
  const changed = chosen !== null && chosen === currency;
  return (
    <div className={className ?? "grid gap-2 sm:max-w-md"}>
      <Label htmlFor={id}>{t("settings.costCurrency")}</Label>
      <Select value={currency} onValueChange={(value) => { setChosen(value); patchSettings({ costCurrency: value }); }}>
        <SelectTrigger id={id} aria-describedby={`${id}-hint`} className="sm:max-w-xs"><SelectValue /></SelectTrigger>
        <SelectContent>
          {COST_CURRENCIES.map((entry) => <SelectItem key={entry.value} value={entry.value}>{t(entry.labelKey, { defaultValue: entry.fallback })}</SelectItem>)}
        </SelectContent>
      </Select>
      <p id={`${id}-hint`} className="text-xs text-muted-foreground">{t("settings.costCurrencyHint")}</p>
      {changed && <p role="status" className="rounded-md border border-amber-500/40 bg-amber-500/10 px-3 py-2 text-xs text-amber-900 dark:text-amber-200">{t("settings.costCurrencyChanged", { currency })}</p>}
      {changed && onServer && <ServerCurrencyNote currency={currency} />}
    </div>
  );
}
