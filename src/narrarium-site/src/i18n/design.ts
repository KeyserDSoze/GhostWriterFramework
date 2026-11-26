import designEn from "@/i18n/locales/design.en";
import designIt from "@/i18n/locales/design.it";
import { registerTranslations } from "@/i18n/lazyBundles";

/**
 * The texts of the Bible, the Studio and the dialog «Design the book» are bundled with them: the Synopsis page loads them only when one of its tabs is opened.
 * Importing this module adds them to the shared i18next instance.
 */
registerTranslations(designEn, designIt);
