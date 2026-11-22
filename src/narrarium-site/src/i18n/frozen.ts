import frozenEn from "@/i18n/locales/frozen.en";
import frozenIt from "@/i18n/locales/frozen.it";
import { registerTranslations } from "@/i18n/lazyBundles";

/**
 * The texts of the frozen chapters travel with the views that show them (the pages of a chapter and of its scenes, the question of the autopilot
 * about a change): importing this module adds them to the shared i18next instance; the app entry does not carry them.
 */
registerTranslations(frozenEn, frozenIt);
