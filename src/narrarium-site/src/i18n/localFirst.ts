import localFirstEn from "@/i18n/locales/localFirst.en";
import localFirstIt from "@/i18n/locales/localFirst.it";
import { registerTranslations } from "@/i18n/lazyBundles";

/**
 * The texts of a book kept on this device, or of a linked book that cannot reach GitHub right now (what is disabled and why, where a change was saved),
 * travel with the shell of the app, which every page of a book loads: the app entry does not carry them and the public pages do not download them.
 */
registerTranslations(localFirstEn, localFirstIt);
