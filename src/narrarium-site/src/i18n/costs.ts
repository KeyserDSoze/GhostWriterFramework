import costsEn from "@/i18n/locales/costs.en";
import costsIt from "@/i18n/locales/costs.it";
import { registerTranslations } from "@/i18n/lazyBundles";

/** The texts of the costs (the Costs page, the prices and the exchange rates in Settings, the money of the autopilot), bundled with the views that show them. Keys: `costs.*`, `settings.costRates.*`. */
registerTranslations(costsEn, costsIt);
