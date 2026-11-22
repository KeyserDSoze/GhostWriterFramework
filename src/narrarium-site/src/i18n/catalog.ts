import catalogEn from "@/i18n/locales/catalog.en";
import catalogIt from "@/i18n/locales/catalog.it";
import { registerTranslations } from "@/i18n/lazyBundles";

/**
 * The texts of the dialog that reads the models of an endpoint are bundled with the dialog, which is loaded when it is opened: neither the app entry nor the settings page carries
 * them. Importing this module adds them to the shared i18next instance.
 */
registerTranslations(catalogEn, catalogIt);
