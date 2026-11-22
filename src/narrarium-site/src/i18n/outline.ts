import outlineEn from "@/i18n/locales/outline.en";
import outlineIt from "@/i18n/locales/outline.it";
import { registerTranslations } from "@/i18n/lazyBundles";

/**
 * The texts of the Outline page are bundled with it: the app entry does not carry them and the public pages do not download them. Importing
 * this module adds them to the shared i18next instance; the menu label (`nav.outline`) is the only one the entry has.
 */
registerTranslations(outlineEn, outlineIt);
