import copilotApplyEn from "@/i18n/locales/copilotApply.en";
import copilotApplyIt from "@/i18n/locales/copilotApply.it";
import { registerTranslations } from "@/i18n/lazyBundles";

/** What the Copilot says once it applied, or undid, a change (sent to GitHub or kept on this device, a conflict) travels with its panel. */
registerTranslations(copilotApplyEn, copilotApplyIt);
