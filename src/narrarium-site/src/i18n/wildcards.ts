import wildcardsEn from "@/i18n/locales/wildcards.en";
import wildcardsIt from "@/i18n/locales/wildcards.it";
import { registerTranslations } from "@/i18n/lazyBundles";

/**
 * The texts of the wildcards («Fuori dal coro»): their page, the consultation of the room and the table of its ideas import them, so neither the app entry
 * nor the shell carries them.
 */
registerTranslations(wildcardsEn, wildcardsIt);
