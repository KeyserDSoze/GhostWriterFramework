import autopilotCallsEn from "@/i18n/locales/autopilotCalls.en";
import autopilotCallsIt from "@/i18n/locales/autopilotCalls.it";
import { registerTranslations } from "@/i18n/lazyBundles";

/**
 * The texts of the task view of the Autopilot page (`autopilot.calls.*`) travel with the history that shows it: importing this module adds them to the
 * shared i18next instance; the app entry does not carry them.
 */
registerTranslations(autopilotCallsEn, autopilotCallsIt);
