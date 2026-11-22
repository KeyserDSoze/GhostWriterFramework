import endpointEn from "@/i18n/locales/endpoint.en";
import endpointIt from "@/i18n/locales/endpoint.it";
import { registerTranslations } from "@/i18n/lazyBundles";

/**
 * The texts of the check of the connection (the card of an OpenAI-compatible integration and the panel of an error of the autopilot) are bundled with the views that show them:
 * the app entry does not carry them and the public pages do not download them. Importing this module adds them to the shared i18next instance.
 */
registerTranslations(endpointEn, endpointIt);
