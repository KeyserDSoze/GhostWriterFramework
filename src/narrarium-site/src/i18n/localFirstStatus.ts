import localFirstStatusEn from "@/i18n/locales/localFirstStatus.en";
import localFirstStatusIt from "@/i18n/locales/localFirstStatus.it";
import { registerTranslations } from "@/i18n/lazyBundles";

/**
 * The texts of the repository status of a book kept on this device, or of a GitHub book that cannot use GitHub right now (what the dialog can compare and
 * undo here, and why the rest needs GitHub): they travel with the dialog, which loads when it is opened, under the same `localFirst` keys.
 */
registerTranslations(localFirstStatusEn, localFirstStatusIt);
