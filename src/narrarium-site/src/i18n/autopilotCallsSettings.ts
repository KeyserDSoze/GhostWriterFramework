import autopilotCallsSettingsEn from "@/i18n/locales/autopilotCallsSettings.en";
import autopilotCallsSettingsIt from "@/i18n/locales/autopilotCallsSettings.it";
import { registerTranslations } from "@/i18n/lazyBundles";

/**
 * The texts of the «AI calls» tab travel with the views of the autopilot settings: importing this module adds them to the shared i18next instance;
 * the app entry does not carry them.
 */
registerTranslations(autopilotCallsSettingsEn, autopilotCallsSettingsIt);
