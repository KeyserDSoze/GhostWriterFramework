import designEn from "@/i18n/locales/design.en";
import designIt from "@/i18n/locales/design.it";
import { registerTranslations } from "@/i18n/lazyBundles";

/**
 * The texts of the Bible are bundled with it: the Synopsis page loads them only when its tab is opened.
 * Importing this module adds them to the shared i18next instance.
 */
registerTranslations(designEn, designIt);
