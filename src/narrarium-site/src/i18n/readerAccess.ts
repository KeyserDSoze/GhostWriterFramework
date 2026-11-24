import readerAccessEn from "@/i18n/locales/readerAccess.en";
import readerAccessIt from "@/i18n/locales/readerAccess.it";
import { registerTranslations } from "@/i18n/lazyBundles";

/** The texts of «Reader access» (the passwords and GitHub Pages of a book), bundled with the card that shows them (the app entry does not carry them). Keys: `readerAccess.*`. */
registerTranslations(readerAccessEn, readerAccessIt);
