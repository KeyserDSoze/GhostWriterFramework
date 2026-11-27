import googleAccessEn from "@/i18n/locales/googleAccess.en";
import googleAccessIt from "@/i18n/locales/googleAccess.it";
import { registerTranslations } from "@/i18n/lazyBundles";

/** The texts of the extra Google permissions (full access to Drive, asked only when a person chooses it) and of the Google configuration check. Keys: `googleAccess.*`. */
registerTranslations(googleAccessEn, googleAccessIt);
