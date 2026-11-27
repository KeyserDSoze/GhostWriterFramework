import pageCopilotEn from "@/i18n/locales/pageCopilot.en";
import pageCopilotIt from "@/i18n/locales/pageCopilot.it";
import { registerTranslations } from "@/i18n/lazyBundles";

/** The texts of the page-aware Copilot travel with its panel: importing this module adds them to the shared i18next instance. */
registerTranslations(pageCopilotEn, pageCopilotIt);
