import { useTranslation } from "react-i18next";
import { Link } from "react-router-dom";
import { CostCurrencyField } from "@/components/settings/CostCurrencyField";
import { CostRatesEditor } from "@/components/settings/CostRatesEditor";
import { CostRelabelsEditor } from "@/components/settings/CostRelabelsEditor";
import { useSettingsStore } from "@/store/settingsStore";
import "@/i18n/costs";

/** Settings › Costs: the currency of the prices and of every cost, the exchange rates for display, and the relabels of amounts recorded in the wrong currency. */
export function CostSettingsBody() {
  const { t } = useTranslation();
  const currency = useSettingsStore((state) => state.settings.costCurrency || "USD");
  const rates = useSettingsStore((state) => state.settings.costRates);
  const relabels = useSettingsStore((state) => state.settings.costRelabels);
  const patchSettings = useSettingsStore((state) => state.patchSettings);
  return (
    <div data-cost-settings className="space-y-6">
      <CostCurrencyField />
      <CostRatesEditor currency={currency} rates={rates} onChange={(costRates) => patchSettings({ costRates })} />
      <CostRelabelsEditor currency={currency} relabels={relabels} onChange={(costRelabels) => patchSettings({ costRelabels })} />
      <p className="text-xs text-muted-foreground">
        {t("settings.costSettings.prices")}{" "}
        <Link to="/app/settings/ai-integrations" className="font-medium text-primary underline underline-offset-2">{t("settingsSection.aiIntegrationsTitle")}</Link>
        {" · "}
        <Link to="/app/costs" className="font-medium text-primary underline underline-offset-2">{t("costs.title")}</Link>
      </p>
    </div>
  );
}
